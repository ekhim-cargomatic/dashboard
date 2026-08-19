#!/usr/bin/env bash
#
# Publish one run's Allure report + dashboard summary to the QA dashboard bucket.
#
# Runs from the playwright-automation repo, after `allure generate`. Needs only
# node (for the summariser) and the aws CLI.
#
#   QA_DASHBOARD_BUCKET=cargomatic-qa-dashboard \
#     ./publish-to-s3.sh --results reports/allure-results --report reports/allure-report
#
# Metadata is read from the standard GitHub Actions environment variables, so in
# CI there is normally nothing else to pass.

set -euo pipefail

BUCKET="${QA_DASHBOARD_BUCKET:-}"
RESULTS="reports/allure-results"
REPORT="reports/allure-report"
RUNS_PREFIX="${QA_DASHBOARD_RUNS_PREFIX:-runs/}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --results) RESULTS="$2"; shift 2 ;;
    --report)  REPORT="$2";  shift 2 ;;
    --bucket)  BUCKET="$2";  shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "error: set QA_DASHBOARD_BUCKET (or pass --bucket)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$RESULTS" ]]; then
  echo "error: no Allure results at $RESULTS" >&2
  exit 1
fi

# Derive the destination once and reuse it. Deriving it twice would embed two
# different timestamps and split the run across two prefixes.
PREFIX="$(node "$HERE/qa-summary.mjs" --print-key)"
DEST="s3://${BUCKET}/${PREFIX}"

# Record this before summarising: writing the summary into $REPORT creates that
# directory, so checking afterwards would always report a report that isn't there.
HAVE_REPORT=false
[[ -d "$REPORT" ]] && HAVE_REPORT=true

echo "==> Summarising $RESULTS"
node "$HERE/qa-summary.mjs" \
  --results "$RESULTS" \
  --out "${REPORT}/qa-summary.json"

if [[ "$HAVE_REPORT" == true ]]; then
  echo "==> Uploading report to ${DEST}/allure-report/"
  # Immutable: a run's report never changes once written, so it caches forever.
  aws s3 sync "$REPORT" "${DEST}/allure-report/" \
    --cache-control "public,max-age=31536000,immutable" \
    --only-show-errors
else
  echo "warning: no generated report at $REPORT — publishing the summary only." >&2
  echo "         The run's 'Allure ↗' link will not resolve. Run 'allure generate' first." >&2
fi

# The summary also lives at the run root, which is where the dashboard looks for
# it. Written last so a run only becomes visible once its report is fully there.
echo "==> Publishing summary to ${DEST}/qa-summary.json"
aws s3 cp "${REPORT}/qa-summary.json" "${DEST}/qa-summary.json" \
  --cache-control "public,max-age=300" \
  --content-type "application/json" \
  --only-show-errors

echo
echo "Published: ${DEST}"
echo "It appears on the dashboard on the next page load — no index to update."
