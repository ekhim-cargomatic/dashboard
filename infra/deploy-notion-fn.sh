#!/usr/bin/env bash
#
# Provision the Lambda behind the dashboard's "Send to agent-dev" button.
#
# The SPA is static and cannot call api.notion.com itself (no CORS, and the token
# would be public in the bundle), so this function is the only thing holding the
# Notion integration secret.
#
# Idempotent — safe to re-run. First run creates the role, function and Function
# URL and prints the URL; later runs just push new code and refresh config.
#
#   NOTION_TOKEN=secret_xxx ./infra/deploy-notion-fn.sh
#   ./infra/deploy-notion-fn.sh --code-only     # skip config, just push index.mjs
#
# Requires: aws CLI v2 (authenticated), zip, jq.
#
# After the first run, put the printed URL in infra/deploy.env as
# NOTION_FN_URL=... so ./infra/deploy.sh writes it into the SPA's config.json.
#
# SECURITY: the Function URL is public (AuthType NONE) because a static page has
# no credentials to sign with. CORS restricts *browsers* to the dashboard origin,
# but anyone who learns the URL can still POST to it with curl and create Notion
# tasks. DASHBOARD_TOKEN raises that bar slightly — it is shipped in the SPA's
# config.json, so treat it as a speed bump, not authentication. The function can
# only create pages in one database with one template, which is the real limit on
# the blast radius.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

if [[ -f "$HERE/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$HERE/deploy.env"
fi

REGION="${REGION:-us-west-2}"
FN_NAME="${NOTION_FN_NAME:-qa-dashboard-notion-task}"
ROLE_NAME="${NOTION_FN_ROLE:-${FN_NAME}-role}"
RUNTIME="nodejs20.x"
SRC="$HERE/notion-agent-task"

# The Tasks database that receives the tickets. Not a secret (it is visible in any
# Notion URL), so it is defaulted here rather than required in deploy.env.
NOTION_TASKS_DB_ID="${NOTION_TASKS_DB_ID:-278aa858-283a-803a-8a91-e682f86b1f8a}"

# Who new tickets are assigned to. A Notion user id, not an email — look one up
# with the /v1/users API if this ever needs to change hands.
NOTION_ASSIGNEE_ID="${NOTION_ASSIGNEE_ID:-277d872b-594c-8119-ac3c-0002bb5fa349}" # Everett Khim

CODE_ONLY=false
[[ "${1:-}" == "--code-only" ]] && CODE_ONLY=true

for tool in aws zip jq; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required but not installed" >&2; exit 1; }
done

aws sts get-caller-identity >/dev/null || {
  echo "error: AWS credentials are not valid. Run 'aws sso login' (or set keys) first." >&2
  exit 1
}

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# The origin allowed to call the function. Derived from the live distribution so
# it cannot drift from where the dashboard is actually served.
if [[ -z "${ALLOWED_ORIGIN:-}" ]]; then
  if [[ -n "${BUCKET:-}" ]]; then
    DIST_DOMAIN="$(aws cloudfront list-distributions \
      --query "DistributionList.Items[?Comment=='qa-dashboard-${BUCKET}'].DomainName | [0]" \
      --output text 2>/dev/null || echo 'None')"
    [[ "$DIST_DOMAIN" != "None" && -n "$DIST_DOMAIN" ]] && ALLOWED_ORIGIN="https://${DIST_DOMAIN}"
  fi
fi

if [[ "$CODE_ONLY" == false && -z "${ALLOWED_ORIGIN:-}" ]]; then
  echo "error: ALLOWED_ORIGIN is not set and no distribution was found." >&2
  echo "       Set BUCKET in infra/deploy.env, or pass ALLOWED_ORIGIN=https://... " >&2
  exit 1
fi

if [[ "$CODE_ONLY" == false && -z "${NOTION_TOKEN:-}" ]]; then
  cat >&2 <<'ERR'
error: NOTION_TOKEN is not set.

  Create an internal integration at https://www.notion.so/profile/integrations,
  then share the Tasks database with it (Tasks → ••• → Connections → your
  integration). Without that share, Notion returns 404 for the database even
  though the token is valid.

  Then:  NOTION_TOKEN=ntn_xxx ./infra/deploy-notion-fn.sh

Deliberately not persisted to deploy.env — keep the secret out of the repo.
ERR
  exit 1
fi

# --------------------------------------------------------------------------- #
# Execution role
# --------------------------------------------------------------------------- #

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  log "Creating IAM role $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null

  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

  # IAM is eventually consistent; Lambda rejects a role it cannot yet assume.
  log "Waiting for the role to propagate"
  sleep 10
else
  log "IAM role $ROLE_NAME already exists"
fi

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# --------------------------------------------------------------------------- #
# Package
# --------------------------------------------------------------------------- #

log "Packaging $SRC"
ZIP="$(mktemp -d)/function.zip"
(cd "$SRC" && zip -qr "$ZIP" index.mjs)

# --------------------------------------------------------------------------- #
# Function
# --------------------------------------------------------------------------- #

ENV_JSON="$(jq -n \
  --arg token "${NOTION_TOKEN:-}" \
  --arg db "$NOTION_TASKS_DB_ID" \
  --arg assignee "$NOTION_ASSIGNEE_ID" \
  --arg origin "${ALLOWED_ORIGIN:-}" \
  --arg dash "${DASHBOARD_TOKEN:-}" \
  '{Variables: ({NOTION_TOKEN: $token, NOTION_TASKS_DB_ID: $db,
                 NOTION_ASSIGNEE_ID: $assignee, ALLOWED_ORIGIN: $origin}
                + (if $dash == "" then {} else {DASHBOARD_TOKEN: $dash} end))}')"

if aws lambda get-function --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  log "Updating function code"
  aws lambda update-function-code --function-name "$FN_NAME" --region "$REGION" \
    --zip-file "fileb://$ZIP" --query 'LastModified' --output text >/dev/null

  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"

  if [[ "$CODE_ONLY" == false ]]; then
    log "Updating function configuration"
    aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
      --timeout 15 --memory-size 256 --environment "$ENV_JSON" \
      --query 'LastModified' --output text >/dev/null
    aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"
  fi
else
  log "Creating function $FN_NAME"
  aws lambda create-function --function-name "$FN_NAME" --region "$REGION" \
    --runtime "$RUNTIME" --handler index.handler --role "$ROLE_ARN" \
    --timeout 15 --memory-size 256 \
    --zip-file "fileb://$ZIP" --environment "$ENV_JSON" \
    --query 'FunctionArn' --output text >/dev/null

  aws lambda wait function-active --function-name "$FN_NAME" --region "$REGION"
fi

# --------------------------------------------------------------------------- #
# Function URL
# --------------------------------------------------------------------------- #

# CORS is enforced by Lambda here *and* echoed by the handler; the handler's copy
# is what a non-browser client sees, and what returns 403 on a wrong Origin.
CORS_JSON="$(jq -n --arg origin "${ALLOWED_ORIGIN:-*}" \
  '{AllowOrigins: [$origin],
    AllowMethods: ["POST"],
    AllowHeaders: ["content-type", "x-dashboard-token"],
    MaxAge: 86400}')"

if aws lambda get-function-url-config --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  [[ "$CODE_ONLY" == false ]] && aws lambda update-function-url-config \
    --function-name "$FN_NAME" --region "$REGION" \
    --auth-type NONE --cors "$CORS_JSON" --query 'FunctionUrl' --output text >/dev/null
else
  log "Creating the Function URL"
  aws lambda create-function-url-config --function-name "$FN_NAME" --region "$REGION" \
    --auth-type NONE --cors "$CORS_JSON" --query 'FunctionUrl' --output text >/dev/null

  # A public Function URL still needs an explicit resource policy.
  aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
fi

FN_URL="$(aws lambda get-function-url-config --function-name "$FN_NAME" --region "$REGION" \
  --query 'FunctionUrl' --output text)"

rm -rf "$(dirname "$ZIP")"

cat <<EOF

Done.

  Function     $FN_NAME  ($REGION)
  URL          $FN_URL
  Allowed from ${ALLOWED_ORIGIN:-<unset>}
  Tasks DB     $NOTION_TASKS_DB_ID

Add this to infra/deploy.env so the SPA picks it up, then redeploy:

  NOTION_FN_URL=$FN_URL

  ./infra/deploy.sh --app-only

EOF
