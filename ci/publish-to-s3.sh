#!/usr/bin/env bash
#
# Publish one run's Allure report + dashboard summary to the QA dashboard bucket.
#
# Runs from the playwright-automation repo, after `allure generate`. Needs only
# node (for the summariser) and the aws CLI.
#
#   QA_DASHBOARD_BUCKET=cargomatic-qa-dashboard \
#     ./publish-to-s3.sh --suite smoke --run-id 32417781765 \
#       --results reports/allure-results --report reports/allure-report
#
# Publishes in the same layout CI uses, so the dashboard treats both identically:
#
#   runs/<suite>/<run_id>/   the full Allure report (index.html at this level)
#   runs/<suite>/latest/     mirror of the newest run
#
# Metadata is read from the standard GitHub Actions environment variables, so in
# CI there is normally nothing else to pass.

set -euo pipefail

BUCKET="${QA_DASHBOARD_BUCKET:-}"
RESULTS="reports/allure-results"
REPORT="reports/allure-report"
RUNS_PREFIX="${QA_DASHBOARD_RUNS_PREFIX:-runs/}"
SUITE="${QA_SUITE:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
SKIP_LATEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --results) RESULTS="$2"; shift 2 ;;
    --report)  REPORT="$2";  shift 2 ;;
    --bucket)  BUCKET="$2";  shift 2 ;;
    --suite)   SUITE="$2";   shift 2 ;;
    --run-id)  RUN_ID="$2";  shift 2 ;;
    --no-latest) SKIP_LATEST=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "error: set QA_DASHBOARD_BUCKET (or pass --bucket)" >&2
  exit 1
fi

if [[ -z "$SUITE" ]]; then
  echo "error: set QA_SUITE (or pass --suite), e.g. smoke or regression" >&2
  exit 1
fi

# Suite slugs are the folder names the dashboard groups by, so they must stay
# stable and URL-clean: lowercase, no spaces. Renaming one starts a new trend line.
SUITE="$(echo "$SUITE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '-' | sed 's/^-//;s/-$//')"

if [[ -z "$RUN_ID" ]]; then
  echo "error: set GITHUB_RUN_ID (or pass --run-id)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$RESULTS" ]]; then
  echo "error: no Allure results at $RESULTS" >&2
  exit 1
fi

PREFIX="${RUNS_PREFIX%/}/${SUITE}/${RUN_ID}"
DEST="s3://${BUCKET}/${PREFIX}"

if [[ ! -d "$REPORT" ]]; then
  echo "error: no generated report at $REPORT - run 'allure generate' first" >&2
  exit 1
fi

# Optional enrichment. The dashboard reads a raw Allure report perfectly well, but
# a qa-summary.json alongside it saves the browser one request per failing test and
# carries run metadata (branch, commit, environment) that Allure does not.
if [[ -f "$HERE/domains.generated.json" ]] && command -v node >/dev/null; then
  echo "==> Summarising $RESULTS"
  node "$HERE/qa-summary.mjs" --results "$RESULTS" --out "${REPORT}/qa-summary.json" || \
    echo "warning: summariser failed; the report alone is still usable" >&2
fi

# A clean mirror: --delete so a re-published run cannot leave stale files behind.
echo "==> Uploading report to ${DEST}/"
aws s3 sync "$REPORT" "${DEST}/" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --only-show-errors

# `latest/` is a convenience mirror for bookmarking. The dashboard skips it when
# enumerating runs, so it never double-counts.
if [[ "$SKIP_LATEST" == false ]]; then
  echo "==> Mirroring to ${RUNS_PREFIX%/}/${SUITE}/latest/"
  aws s3 sync "$REPORT" "s3://${BUCKET}/${RUNS_PREFIX%/}/${SUITE}/latest/" \
    --delete \
    --cache-control "public,max-age=60" \
    --only-show-errors
fi

echo
echo "Published: ${DEST}"
echo "It appears on the dashboard on the next page load - no index to update."
