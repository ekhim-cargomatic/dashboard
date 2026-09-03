#!/usr/bin/env bash
#
# Provision and deploy the QA dashboard: one public S3 bucket behind one
# CloudFront distribution, serving both the SPA and the Allure reports.
#
# Idempotent — safe to re-run. The first run creates everything and prints the
# CloudFront URL; later runs just rebuild and sync the SPA.
#
#   ./infra/deploy.sh                       # full provision + deploy
#   BUCKET=my-qa-reports ./infra/deploy.sh  # override the bucket name
#   ./infra/deploy.sh --app-only            # skip provisioning, just push the SPA
#
# Requires: aws CLI v2 (authenticated), node, npm, jq.
#
# NOTE ON ACCESS: this creates a *public* bucket, as requested. Anyone with the
# URL can read every test result, failure message and screenshot in it. Do not
# publish reports containing credentials, customer data or internal hostnames.

set -euo pipefail

# The bucket name embeds the AWS account id, and this repo is public, so it lives
# in an untracked infra/deploy.env rather than here:
#
#     BUCKET=cargomatic-qa-dashboard-<account-id>
#
# It must match the deployed bucket exactly. The distribution is found by its
# Comment, which is derived from BUCKET below — so a different name finds no
# distribution and creates a *second* one, on a new CloudFront URL, while the
# original keeps running and billing. That is why an absent value is a hard error
# rather than a plausible-looking default.
if [[ -f "$(dirname "${BASH_SOURCE[0]}")/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "${BASH_SOURCE[0]}")/deploy.env"
fi
BUCKET="${BUCKET:-}"
REGION="${REGION:-us-west-2}"
RUNS_PREFIX="${RUNS_PREFIX:-runs/}"
MAX_RUNS_PER_WORKFLOW="${MAX_RUNS_PER_WORKFLOW:-60}"
FUNCTION_NAME="${FUNCTION_NAME:-qa-dashboard-router}"
CALLER_REF="qa-dashboard-${BUCKET}"

APP_ONLY=false
[[ "${1:-}" == "--app-only" ]] && APP_ONLY=true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

if [[ -z "$BUCKET" ]]; then
  cat >&2 <<'ERR'
error: BUCKET is not set.

  Create infra/deploy.env (untracked) containing:

      BUCKET=cargomatic-qa-dashboard-<account-id>

  Find the account id with: aws sts get-caller-identity --query Account --output text
  Or pass it for one run:   BUCKET=... ./infra/deploy.sh --app-only

Deliberately not defaulted: a wrong name silently provisions a SECOND stack on a
new CloudFront URL and leaves the original running and billing.
ERR
  exit 1
fi

for tool in aws node npm jq; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required but not installed" >&2; exit 1; }
done

aws sts get-caller-identity >/dev/null || {
  echo "error: AWS credentials are not valid. Run 'aws sso login' (or set keys) first." >&2
  exit 1
}

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --------------------------------------------------------------------------- #
# Bucket
# --------------------------------------------------------------------------- #

if [[ "$APP_ONLY" == false ]]; then
  log "Bucket: $BUCKET ($REGION)"

  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "already exists"
  else
    if [[ "$REGION" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
    else
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION"
    fi
    echo "created"
  fi

  # A public bucket needs the account-level block lifted for *this* bucket.
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

  log "Bucket policy — public read plus list"
  # s3:ListBucket is the unusual part and is deliberate: it is what lets the SPA
  # discover runs by listing the bucket instead of reading a maintained index.
  # It is scoped to the runs/ prefix so the rest of the bucket is not enumerable.
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadObjects",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "PublicListRunsPrefix",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["", "${RUNS_PREFIX}*"]
        }
      }
    }
  ]
}
JSON
  )"

  log "CORS — only needed if the dashboard is ever served from another origin"
  aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "$(cat <<'JSON'
{
  "CORSRules": [
    {
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["*"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON
  )"

  log "Lifecycle — expire raw reports after 90 days"
  # Allure reports are the bulk of the storage; the qa-summary.json files that
  # power the trends are tiny, but they live under the same prefix, so this
  # trades long history for cost. Raise or drop the rule to keep more.
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration "$(cat <<JSON
{
  "Rules": [
    {
      "ID": "expire-old-reports",
      "Status": "Enabled",
      "Filter": { "Prefix": "${RUNS_PREFIX}" },
      "Expiration": { "Days": 90 }
    }
  ]
}
JSON
    )"
fi

# --------------------------------------------------------------------------- #
# CloudFront function
# --------------------------------------------------------------------------- #

if [[ "$APP_ONLY" == false ]]; then
  log "CloudFront function: $FUNCTION_NAME"

  FUNCTION_ARN="$(aws cloudfront describe-function --name "$FUNCTION_NAME" \
    --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text 2>/dev/null || true)"

  if [[ -z "$FUNCTION_ARN" || "$FUNCTION_ARN" == "None" ]]; then
    FUNCTION_ARN="$(aws cloudfront create-function \
      --name "$FUNCTION_NAME" \
      --function-config "Comment=QA dashboard routing,Runtime=cloudfront-js-2.0" \
      --function-code "fileb://${HERE}/cloudfront-function.js" \
      --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)"
    echo "created"
  else
    ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
    aws cloudfront update-function \
      --name "$FUNCTION_NAME" --if-match "$ETAG" \
      --function-config "Comment=QA dashboard routing,Runtime=cloudfront-js-2.0" \
      --function-code "fileb://${HERE}/cloudfront-function.js" >/dev/null
    echo "updated"
  fi

  ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
  aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$ETAG" >/dev/null
  echo "published: $FUNCTION_ARN"
fi

# --------------------------------------------------------------------------- #
# Cache policy
# --------------------------------------------------------------------------- #

# Neither managed policy fits this distribution:
#
#   CachingDisabled  — correct behaviour, but nothing is ever cached at the edge.
#                      Allure reports are thousands of static files; every request
#                      would go to S3, which is slow and needlessly expensive.
#   CachingOptimized — caches well, but *ignores query strings in the cache key*.
#                      Every ListObjectsV2 call would then collapse onto one cache
#                      entry, so `prefix=runs/smoke/` would serve the response for
#                      `prefix=runs/`. Discovery would return the wrong runs.
#
# So: cache aggressively, but keep the query string in the cache key. Objects we
# upload carry their own Cache-Control and govern themselves; only the listing XML
# (which S3 sends without Cache-Control) falls back to DefaultTTL, hence the short
# 60s — a finished run shows up within a minute.
CACHE_POLICY_NAME="${CACHE_POLICY_NAME:-qa-dashboard-cache}"

if [[ "$APP_ONLY" == false ]]; then
  log "Cache policy: $CACHE_POLICY_NAME"

  CACHE_POLICY_ID="$(aws cloudfront list-cache-policies --type custom \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='${CACHE_POLICY_NAME}'].CachePolicy.Id | [0]" \
    --output text 2>/dev/null || true)"

  if [[ -z "$CACHE_POLICY_ID" || "$CACHE_POLICY_ID" == "None" ]]; then
    CACHE_POLICY_ID="$(aws cloudfront create-cache-policy --cache-policy-config "$(cat <<JSON
{
  "Name": "${CACHE_POLICY_NAME}",
  "Comment": "QA dashboard: cache by full query string so S3 listings stay correct",
  "DefaultTTL": 60,
  "MaxTTL": 31536000,
  "MinTTL": 0,
  "ParametersInCacheKeyAndForwardedToOrigin": {
    "EnableAcceptEncodingGzip": true,
    "EnableAcceptEncodingBrotli": true,
    "HeadersConfig": { "HeaderBehavior": "none" },
    "CookiesConfig": { "CookieBehavior": "none" },
    "QueryStringsConfig": { "QueryStringBehavior": "all" }
  }
}
JSON
    )" --query 'CachePolicy.Id' --output text)"
    echo "created: $CACHE_POLICY_ID"
  else
    echo "already exists: $CACHE_POLICY_ID"
  fi
fi

# --------------------------------------------------------------------------- #
# Distribution
# --------------------------------------------------------------------------- #

find_distribution() {
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='${CALLER_REF}'].Id | [0]" \
    --output text 2>/dev/null || true
}

DIST_ID="$(find_distribution)"

if [[ "$APP_ONLY" == false && ( -z "$DIST_ID" || "$DIST_ID" == "None" ) ]]; then
  log "Creating CloudFront distribution"

  # The origin is the S3 *REST* endpoint, not the website endpoint: only the REST
  # endpoint implements ListObjectsV2. Query strings must reach it, so the managed
  # AllViewerExceptHostHeader origin request policy is attached
  # (id b689b0a8-53d0-40ab-baf2-68738e2966ac — global and stable).
  #
  # Deliberately no CustomErrorResponses: the usual SPA trick of rewriting 404 to
  # index.html with a 200 would mask genuine missing objects — a run whose upload
  # was interrupted would answer its qa-summary.json request with HTML instead of
  # a clean 404, and the dashboard could not tell "not there yet" from "broken".
  # There is no client-side router here, so nothing needs the rewrite.
  CONFIG="$(cat <<JSON
{
  "CallerReference": "${CALLER_REF}-$(date +%s)",
  "Comment": "${CALLER_REF}",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "s3-rest-origin",
        "DomainName": "${BUCKET}.s3.${REGION}.amazonaws.com",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-rest-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": true,
    "CachePolicyId": "${CACHE_POLICY_ID}",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "FunctionAssociations": {
      "Quantity": 1,
      "Items": [
        { "EventType": "viewer-request", "FunctionARN": "${FUNCTION_ARN}" }
      ]
    }
  },
  "PriceClass": "PriceClass_100"
}
JSON
  )"

  DIST_ID="$(aws cloudfront create-distribution \
    --distribution-config "$CONFIG" \
    --query 'Distribution.Id' --output text)"
  echo "created: $DIST_ID"
  echo "note: a new distribution takes ~5-15 minutes to finish deploying."
fi

if [[ -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  echo "error: no distribution found for comment '${CALLER_REF}'. Run without --app-only first." >&2
  exit 1
fi

DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
  --query 'Distribution.DomainName' --output text)"

# --------------------------------------------------------------------------- #
# Build and upload the SPA
# --------------------------------------------------------------------------- #

log "Building the dashboard"
cd "$ROOT"
npm ci --silent || npm install --silent
npm run build

# Runtime config, so the bucket/prefix can change without rebuilding the bundle.
# Empty origins mean "same origin", which is what the CloudFront setup gives us.
jq -n \
  --arg prefix "$RUNS_PREFIX" \
  --argjson maxRuns "$MAX_RUNS_PER_WORKFLOW" \
  '{dataBaseUrl: "", reportBaseUrl: "", runsPrefix: $prefix, maxRunsPerWorkflow: $maxRuns}' \
  > "$ROOT/dist/config.json"

log "Uploading to s3://$BUCKET"
# Hashed assets are immutable and cached hard; everything else must revalidate so
# a deploy is visible immediately.
aws s3 sync "$ROOT/dist/assets/" "s3://$BUCKET/assets/" \
  --cache-control "public,max-age=31536000,immutable" --delete

aws s3 cp "$ROOT/dist/index.html" "s3://$BUCKET/index.html" \
  --cache-control "no-cache" --content-type "text/html"

aws s3 cp "$ROOT/dist/config.json" "s3://$BUCKET/config.json" \
  --cache-control "no-cache" --content-type "application/json"

log "Invalidating cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/index.html" "/config.json" --query 'Invalidation.Id' --output text

cat <<EOF

Done.

  Dashboard   https://${DOMAIN}/
  Bucket      s3://${BUCKET}
  Runs prefix ${RUNS_PREFIX}
  Distribution ${DIST_ID}

The dashboard is empty until a CI job publishes a run. Wire that up with
ci/publish-to-s3.sh — see README § Publishing from CI.
EOF
