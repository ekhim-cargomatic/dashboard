#!/usr/bin/env bash
#
# Provision the runner behind the flow map's play button.
#
# Three pieces: an ECR image that can run the suite, a CodeBuild project that
# runs it, and a Lambda that is the only thing allowed to start that project.
#
# Idempotent — safe to re-run. First run creates everything and prints the API
# path; later runs push new code and refresh config.
#
#   ./infra/deploy-flow-fn.sh                 # everything
#   ./infra/deploy-flow-fn.sh --push-tests    # upload the suite, nothing else
#   ./infra/deploy-flow-fn.sh --code-only     # just the Lambda's index.mjs
#   ./infra/deploy-flow-fn.sh --image-only    # just rebuild and push the image
#
# The suite is UPLOADED, not cloned: --push-tests zips the working tree into a
# private bucket and CodeBuild reads it from there. No git credential exists
# anywhere in this system, and updating tests costs an upload rather than an
# image rebuild.
#
# Requires: aws CLI v2 (authenticated), docker, zip, jq, node.
#
# The function is fronted by the dashboard's own CloudFront distribution at
# /api/run-flow, so the browser call is same-origin. That behavior already
# exists for the Notion function (see cloudfront-api-behavior.py), covers all
# methods and disables caching — so there is NO CloudFront change here. This
# script only adds two routes to the HTTP API that behavior already points at.
#
# NOT a Lambda Function URL: this AWS Organization denies lambda:InvokeFunctionUrl,
# so a Function URL 403s every caller — including requests signed with admin
# credentials. Same reason the Notion function uses an HTTP API.
#
# SECURITY: the route is unauthenticated, because a static page has no
# credentials to sign with. DASHBOARD_TOKEN ships in config.json, so treat it as
# a speed bump. The blast radius is held down by the function itself: one
# hardcoded project, a baked-in tag allowlist, staging/dev only, one build at a
# time. See the header of infra/flow-run-fn/index.mjs.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

if [[ -f "$HERE/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$HERE/deploy.env"
fi

REGION="${REGION:-us-west-2}"
FN_NAME="${FLOW_FN_NAME:-qa-dashboard-run-flow}"
FN_ROLE="${FLOW_FN_ROLE:-${FN_NAME}-role}"
PROJECT="${FLOW_PROJECT_NAME:-qa-flow-runner}"
PROJECT_ROLE="${FLOW_PROJECT_ROLE:-${PROJECT}-role}"
ECR_REPO="${FLOW_ECR_REPO:-qa-flow-runner}"
API_NAME="${NOTION_API_NAME:-qa-dashboard-notion-api}"
RUNTIME="nodejs20.x"

# Where the test payload lives. Deliberately NOT the dashboard bucket: that one
# is world-readable by policy, and the payload carries the suite's .env.
SRC_BUCKET="${FLOW_SRC_BUCKET:-}"
SRC_KEY="${FLOW_SRC_KEY:-suite.zip}"

# The checkout whose tests get uploaded.
AUTOMATION_DIR="${AUTOMATION_DIR:-$(cd "$ROOT/../playwright-automation" 2>/dev/null && pwd || echo '')}"

MODE=all
case "${1:-}" in
  --code-only)  MODE=code ;;
  --image-only) MODE=image ;;
  --push-tests) MODE=tests ;;
  '')           ;;
  *) echo "error: unknown flag ${1}" >&2; exit 2 ;;
esac

for tool in aws jq zip node; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required but not installed" >&2; exit 1; }
done
[[ "$MODE" == code || "$MODE" == tests ]] || command -v docker >/dev/null || {
  echo "error: docker is required to build the runner image" >&2; exit 1; }

aws sts get-caller-identity >/dev/null || {
  echo "error: AWS credentials are not valid. Run 'aws sso login' (or set keys) first." >&2
  exit 1
}

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

[[ -n "${BUCKET:-}" ]] || {
  echo "error: BUCKET is not set. It lives in infra/deploy.env (untracked)." >&2
  echo "       Never substitute a different name — a wrong bucket silently" >&2
  echo "       provisions a second CloudFront stack while the original bills." >&2
  exit 1
}

# Derived from the live distribution so they cannot drift from where the
# dashboard is actually served.
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='qa-dashboard-${BUCKET}'].Id | [0]" \
  --output text 2>/dev/null || echo '')"
[[ "$DIST_ID" == "None" ]] && DIST_ID=''

if [[ -z "${ALLOWED_ORIGIN:-}" ]]; then
  DIST_DOMAIN="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='qa-dashboard-${BUCKET}'].DomainName | [0]" \
    --output text 2>/dev/null || echo 'None')"
  [[ "$DIST_DOMAIN" != "None" && -n "$DIST_DOMAIN" ]] && ALLOWED_ORIGIN="https://${DIST_DOMAIN}"
fi

if [[ "$MODE" == all && -z "${ALLOWED_ORIGIN:-}" ]]; then
  echo "error: ALLOWED_ORIGIN is not set and no distribution was found." >&2
  exit 1
fi

# --------------------------------------------------------------------------- #
# The tag allowlist
# --------------------------------------------------------------------------- #
# Baked into the function so the endpoint cannot run an arbitrary behave
# expression. Exactly the area tags the flow map names that real feature files
# carry — the same rule resolve() applies in src/lib/flowRun.ts.

build_allowlist() {
  node -e '
    const fs = require("fs");
    const tags = JSON.parse(fs.readFileSync("ci/flow-tags.generated.json", "utf8")).tags;
    const domains = JSON.parse(fs.readFileSync("ci/domains.generated.json", "utf8"));
    const flow = JSON.parse(fs.readFileSync("public/qa-flow/cargomatic.json", "utf8"));
    const generic = new Set([...(domains.scopes ?? []), ...(domains.layers ?? [])]);
    const out = new Set();
    for (const chunk of flow.chunks ?? []) {
      for (const raw of chunk.tags ?? []) {
        const bare = raw.replace(/^@/, "");
        if (generic.has(bare.toLowerCase()) || bare.startsWith("auth.")) continue;
        if (tags[bare.toLowerCase()]) out.add(bare);
      }
    }
    process.stdout.write([...out].sort().join(","));
  ' 2>/dev/null
}

cd "$ROOT"
[[ -f ci/flow-tags.generated.json ]] || {
  echo "error: ci/flow-tags.generated.json is missing. Run: npm run gen:flow-tags" >&2
  exit 1
}
ALLOWED_TAGS="$(build_allowlist)"
[[ -n "$ALLOWED_TAGS" ]] || { echo "error: tag allowlist came out empty" >&2; exit 1; }

# --------------------------------------------------------------------------- #
# Test payload
# --------------------------------------------------------------------------- #
# The suite travels as a zip in a private bucket. That bucket is created here
# with public access blocked at the bucket level, because the payload carries
# the suite's .env — the dashboard bucket grants s3:GetObject to "*" and would
# publish it.

SRC_BUCKET="${SRC_BUCKET:-cargomatic-qa-flow-src-${ACCOUNT_ID}}"

if [[ "$SRC_BUCKET" == "$BUCKET" ]]; then
  echo "error: the payload bucket must not be the dashboard bucket." >&2
  echo "       $BUCKET grants s3:GetObject to everyone; the payload has credentials in it." >&2
  exit 1
fi

ensure_src_bucket() {
  if aws s3api head-bucket --bucket "$SRC_BUCKET" >/dev/null 2>&1; then
    return
  fi
  log "Creating private bucket $SRC_BUCKET"
  aws s3api create-bucket --bucket "$SRC_BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$SRC_BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$SRC_BUCKET" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  # The payload is replaced wholesale on every push; old versions are only a
  # liability because of what is in them.
  aws s3api put-bucket-lifecycle-configuration --bucket "$SRC_BUCKET" \
    --lifecycle-configuration '{"Rules":[{"ID":"expire-old","Status":"Enabled",
      "Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":7}}]}' >/dev/null 2>&1 || true
}

push_tests() {
  [[ -n "$AUTOMATION_DIR" && -d "$AUTOMATION_DIR" ]] || {
    echo "error: no playwright-automation checkout found." >&2
    echo "       Pass AUTOMATION_DIR=/path/to/playwright-automation" >&2
    exit 1
  }

  ensure_src_bucket

  log "Packing the suite from $AUTOMATION_DIR"
  STAGE="$(mktemp -d)"

  # Tracked files only: 840 of them, ~2.7MB zipped. The working tree also holds
  # 388MB of artifacts/ and a reports/ directory, none of which a fresh run
  # needs, and playwright/.auth holds stale session state that would be worse
  # than useless on a different machine.
  ( cd "$AUTOMATION_DIR" && git archive --format=tar HEAD ) | tar -x -C "$STAGE"

  # .env is untracked-by-intent in most checkouts, so copy it in explicitly.
  # It is what the suite reads for the roles whose passwords are placeholders
  # in configs/<env>.yaml (shipper, carrier, driver).
  if [[ -f "$AUTOMATION_DIR/.env" ]]; then
    cp "$AUTOMATION_DIR/.env" "$STAGE/.env"
    echo "  including .env ($(grep -cE '^[A-Za-z_]+=' "$AUTOMATION_DIR/.env") entries)"
  else
    echo "  WARNING: no .env found — roles with placeholder passwords will fail"
  fi

  # Belt and braces: never ship these even if a future git-archive includes them.
  rm -rf "$STAGE/playwright/.auth" "$STAGE/artifacts" "$STAGE/reports" "$STAGE/.git"

  ZIP_SRC="$(mktemp -d)/suite.zip"
  ( cd "$STAGE" && zip -qr "$ZIP_SRC" . )

  aws s3 cp "$ZIP_SRC" "s3://${SRC_BUCKET}/${SRC_KEY}" --only-show-errors
  echo "  uploaded $(du -h "$ZIP_SRC" | cut -f1) to s3://${SRC_BUCKET}/${SRC_KEY}"

  rm -rf "$STAGE" "$(dirname "$ZIP_SRC")"
}

if [[ "$MODE" == tests ]]; then
  push_tests
  echo
  echo "Done. The next build picks it up — no redeploy needed."
  exit 0
fi

# --------------------------------------------------------------------------- #
# Runner image
# --------------------------------------------------------------------------- #

ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

if [[ "$MODE" == all || "$MODE" == image ]]; then
  aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 || {
    log "Creating ECR repository $ECR_REPO"
    aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
      --image-scanning-configuration scanOnPush=true >/dev/null
  }

  log "Building the runner image"
  CTX="$(mktemp -d)"
  cp "$HERE/flow-runner/Dockerfile" "$CTX/"
  # Baked in so a build does not depend on this repo being reachable, and so a
  # flow run's summary is byte-compatible with a CI run's.
  cp "$ROOT/ci/qa-summary.mjs" "$ROOT/ci/domains.generated.json" "$CTX/"

  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  # --platform matters on Apple Silicon: CodeBuild's Linux fleet is x86_64, and
  # an arm64 image fails at run time with a confusing exec-format error.
  docker build --platform linux/amd64 -t "${ECR_URI}:latest" "$CTX"
  docker push "${ECR_URI}:latest"
  rm -rf "$CTX"
fi

[[ "$MODE" == image ]] && { echo; echo "Image pushed: ${ECR_URI}:latest"; exit 0; }

# --------------------------------------------------------------------------- #
# CodeBuild project
# --------------------------------------------------------------------------- #

if [[ "$MODE" == all ]]; then
  # The project's source is an object that has to exist before it can build.
  push_tests

  if ! aws iam get-role --role-name "$PROJECT_ROLE" >/dev/null 2>&1; then
    log "Creating IAM role $PROJECT_ROLE"
    aws iam create-role --role-name "$PROJECT_ROLE" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "codebuild.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' >/dev/null
    sleep 10  # IAM is eventually consistent
  fi

  # Scoped deliberately: logs, pull the one image, read the four parameters,
  # and write only under runs/ in the dashboard bucket. It cannot touch the SPA
  # itself (index.html, config.json, assets/), which is the same containment the
  # CI publisher role has.
  log "Updating $PROJECT_ROLE policy"
  aws iam put-role-policy --role-name "$PROJECT_ROLE" --policy-name flow-runner \
    --policy-document "$(jq -n \
      --arg bucket "$BUCKET" --arg region "$REGION" --arg account "$ACCOUNT_ID" \
      --arg repo "$ECR_REPO" --arg src "$SRC_BUCKET" \
      '{
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow",
            Action: ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
            Resource: "arn:aws:logs:\($region):\($account):log-group:/aws/codebuild/*" },
          { Effect: "Allow",
            Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
          { Effect: "Allow",
            Action: ["ecr:BatchCheckLayerAvailability","ecr:GetDownloadUrlForLayer","ecr:BatchGetImage"],
            Resource: "arn:aws:ecr:\($region):\($account):repository/\($repo)" },
          { Effect: "Allow",
            Action: ["s3:GetObject","s3:GetObjectVersion"],
            Resource: "arn:aws:s3:::\($src)/*" },
          { Effect: "Allow",
            Action: ["s3:ListBucket"], Resource: "arn:aws:s3:::\($src)" },
          { Effect: "Allow",
            Action: ["s3:PutObject","s3:DeleteObject"],
            Resource: "arn:aws:s3:::\($bucket)/runs/*" },
          { Effect: "Allow",
            Action: ["s3:ListBucket"], Resource: "arn:aws:s3:::\($bucket)" }
        ]
      }')" >/dev/null

  PROJECT_ROLE_ARN="$(aws iam get-role --role-name "$PROJECT_ROLE" --query 'Role.Arn' --output text)"

  # CodeBuild validates the buildspec only when a build downloads source, so a
  # YAML slip costs a full provision + run before it surfaces. Catch it here:
  # a ": " inside a plain scalar silently becomes a mapping, and the command
  # turns from a string into subkeys.
  python3 - "$HERE/flow-runner/buildspec.yml" <<'PYEOF' || exit 1
import sys, yaml
spec = yaml.safe_load(open(sys.argv[1]))
bad = [f"{p}.commands[{i}]" for p, b in spec["phases"].items()
       for i, c in enumerate(b.get("commands", [])) if not isinstance(c, str)]
if bad:
    print(f"error: buildspec commands must be strings, these are not: {', '.join(bad)}",
          file=sys.stderr)
    sys.exit(1)
PYEOF

  PROJECT_ARGS=(
    --name "$PROJECT"
    --region "$REGION"
    --service-role "$PROJECT_ROLE_ARN"
    --artifacts type=NO_ARTIFACTS
    --source "$(jq -n --arg loc "${SRC_BUCKET}/${SRC_KEY}" \
        --arg spec "$(cat "$HERE/flow-runner/buildspec.yml")" \
        '{type:"S3", location:$loc, buildspec:$spec}')"
    --environment "$(jq -n --arg image "${ECR_URI}:latest" --arg bucket "$BUCKET" \
        '{type:"LINUX_CONTAINER", image:$image, computeType:"BUILD_GENERAL1_SMALL",
          imagePullCredentialsType:"SERVICE_ROLE",
          environmentVariables:[{name:"DASHBOARD_BUCKET", value:$bucket, type:"PLAINTEXT"}]}')"
    --timeout-in-minutes 60
    --queued-timeout-in-minutes 15
  )

  if aws codebuild batch-get-projects --names "$PROJECT" --region "$REGION" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "^${PROJECT}$"; then
    log "Updating CodeBuild project $PROJECT"
    aws codebuild update-project "${PROJECT_ARGS[@]}" --query 'project.name' --output text >/dev/null
  else
    log "Creating CodeBuild project $PROJECT"
    aws codebuild create-project "${PROJECT_ARGS[@]}" --query 'project.name' --output text >/dev/null
  fi
fi

# --------------------------------------------------------------------------- #
# Lambda
# --------------------------------------------------------------------------- #

if [[ "$MODE" == all ]]; then
  if ! aws iam get-role --role-name "$FN_ROLE" >/dev/null 2>&1; then
    log "Creating IAM role $FN_ROLE"
    aws iam create-role --role-name "$FN_ROLE" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "lambda.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' >/dev/null
    aws iam attach-role-policy --role-name "$FN_ROLE" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    sleep 10
  fi

  # Start and read ONE project. The function cannot name another.
  log "Updating $FN_ROLE policy"
  aws iam put-role-policy --role-name "$FN_ROLE" --policy-name start-flow-run \
    --policy-document "$(jq -n --arg arn "arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT}" \
      '{Version:"2012-10-17", Statement:[
         {Effect:"Allow",
          Action:["codebuild:StartBuild","codebuild:BatchGetBuilds","codebuild:ListBuildsForProject"],
          Resource:$arn}]}')" >/dev/null
fi

FN_ROLE_ARN="$(aws iam get-role --role-name "$FN_ROLE" --query 'Role.Arn' --output text)"

log "Packaging $HERE/flow-run-fn"
PKG="$(mktemp -d)"
cp "$HERE/flow-run-fn/index.mjs" "$PKG/"
# Bundled rather than relied upon: which @aws-sdk clients the Node runtime
# pre-installs has changed between Lambda Node versions, and discovering that
# at run time costs a deploy cycle. 2MB is cheaper than the surprise.
( cd "$PKG" && npm install --silent --no-save --no-package-lock @aws-sdk/client-codebuild >/dev/null 2>&1 )
ZIP="$(mktemp -d)/function.zip"
( cd "$PKG" && zip -qr "$ZIP" . )

ENV_JSON="$(jq -n \
  --arg project "$PROJECT" \
  --arg tags "$ALLOWED_TAGS" \
  --arg bucket "$BUCKET" \
  --arg origin "${ALLOWED_ORIGIN:-}" \
  --arg dash "${DASHBOARD_TOKEN:-}" \
  '{Variables: ({PROJECT_NAME: $project, ALLOWED_TAGS: $tags, DASHBOARD_BUCKET: $bucket,
                 ALLOWED_ORIGIN: $origin}
                + (if $dash == "" then {} else {DASHBOARD_TOKEN: $dash} end))}')"

if aws lambda get-function --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  log "Updating function code"
  aws lambda update-function-code --function-name "$FN_NAME" --region "$REGION" \
    --zip-file "fileb://$ZIP" --query 'LastModified' --output text >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"

  if [[ "$MODE" == all ]]; then
    log "Updating function configuration"
    aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
      --timeout 20 --memory-size 256 --environment "$ENV_JSON" \
      --query 'LastModified' --output text >/dev/null
    aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"
  fi
else
  log "Creating function $FN_NAME"
  aws lambda create-function --function-name "$FN_NAME" --region "$REGION" \
    --runtime "$RUNTIME" --handler index.handler --role "$FN_ROLE_ARN" \
    --timeout 20 --memory-size 256 \
    --zip-file "fileb://$ZIP" --environment "$ENV_JSON" \
    --query 'FunctionArn' --output text >/dev/null
  aws lambda wait function-active --function-name "$FN_NAME" --region "$REGION"
fi

rm -rf "$PKG" "$(dirname "$ZIP")"

[[ "$MODE" == code ]] && { echo; echo "Code pushed to $FN_NAME."; exit 0; }

# --------------------------------------------------------------------------- #
# Routes on the existing HTTP API
# --------------------------------------------------------------------------- #
# The Notion function owns $default, which is a catch-all — so /api/run-flow
# would reach it today. Two explicit routes take precedence over $default and
# send only this path to this function, leaving Notion's behaviour untouched.

API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || echo 'None')"

if [[ "$API_ID" == "None" || -z "$API_ID" ]]; then
  echo "error: HTTP API '${API_NAME}' not found. Run ./infra/deploy-notion-fn.sh first —" >&2
  echo "       it creates the API and the CloudFront /api/* behavior this shares." >&2
  exit 1
fi

FN_ARN="$(aws lambda get-function --function-name "$FN_NAME" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)"

INTEGRATION_ID="$(aws apigatewayv2 get-integrations --api-id "$API_ID" --region "$REGION" \
  --query "Items[?IntegrationUri=='${FN_ARN}'].IntegrationId | [0]" --output text 2>/dev/null || echo 'None')"

if [[ "$INTEGRATION_ID" == "None" || -z "$INTEGRATION_ID" ]]; then
  log "Creating integration for $FN_NAME"
  INTEGRATION_ID="$(aws apigatewayv2 create-integration --api-id "$API_ID" --region "$REGION" \
    --integration-type AWS_PROXY --integration-uri "$FN_ARN" \
    --payload-format-version 2.0 --query 'IntegrationId' --output text)"
fi

for key in 'POST /api/run-flow' 'GET /api/run-flow' 'OPTIONS /api/run-flow'; do
  if aws apigatewayv2 get-routes --api-id "$API_ID" --region "$REGION" \
       --query "Items[?RouteKey=='${key}'].RouteId | [0]" --output text 2>/dev/null | grep -qv '^None$'; then
    echo "route ${key}: already present"
  else
    aws apigatewayv2 create-route --api-id "$API_ID" --region "$REGION" \
      --route-key "$key" --target "integrations/${INTEGRATION_ID}" \
      --query 'RouteId' --output text >/dev/null
    echo "route ${key}: added"
  fi
done

aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
  --statement-id apigw-invoke-run-flow --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" >/dev/null 2>&1 || true

cat <<EOF

Done.

  Function      $FN_NAME  ($REGION)
  Project       $PROJECT
  Image         ${ECR_URI}:latest
  Tests         s3://${SRC_BUCKET}/${SRC_KEY}  (private)
  Reached at    ${ALLOWED_ORIGIN:-<origin>}/api/run-flow
  Allowed tags  $(echo "$ALLOWED_TAGS" | tr ',' ' ' | wc -w | tr -d ' ') tags from the flow map

After editing tests, re-upload them — no redeploy, a few seconds:

  ./infra/deploy-flow-fn.sh --push-tests

infra/deploy.env should contain the same-origin path:

  RUN_FLOW_URL=/api/run-flow

  ./infra/deploy.sh --app-only

Smoke-test the runner on its own before wiring the UI — @markets is the
smallest real tag in the suite:

  aws codebuild start-build --region $REGION --project-name $PROJECT \\
    --environment-variables-override \\
      name=FLOW_TAGS,value=@markets name=FLOW_CHUNK,value=markets
  aws s3 ls s3://${BUCKET}/runs/flow-run/

EOF
