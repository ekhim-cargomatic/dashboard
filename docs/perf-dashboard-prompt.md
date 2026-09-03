# Prompt: build a performance dashboard on AWS

Paste everything below the line into a fresh Claude Code session opened in the
directory where the perf dashboard should live (suggested:
`/Users/ekhim/Documents/Automation/perf-dashboard`).

It is written to be self-contained: AWS environment, what to provision, the data
contract, the pitfalls that cost real time on the QA dashboard, and what
"verified" has to mean before it claims success.

---

## Mission

Build a **performance dashboard**: a static site on S3 + CloudFront that reads
k6 / Apache-Benchmark results published to an S3 bucket by CI, and shows latency
trends, throughput, error rates, and which endpoints regressed against baseline.

There is a working reference implementation of this exact architecture at
`/Users/ekhim/Documents/Automation/dashboard` (the QA automation dashboard, live
at https://d34o4mvhjdaxkf.cloudfront.net/). **Read it before designing anything.**
Reuse rather than reinvent:

| File | Why it is worth copying |
|---|---|
| `src/lib/s3.ts` | Bucket-listing discovery, numeric run-id sort, `latest/` skipping, versioned client cache |
| `infra/deploy.sh` | Idempotent provision + deploy; bucket policy, cache policy, distribution |
| `infra/cloudfront-function.js` | The routing carve-out that keeps S3 listing working |
| `src/styles.css` | Validated light/dark palette tokens, sequential ramp, status colours |
| `src/components/*.tsx` | Hand-rolled SVG charts with tooltips, no chart library |

Stack: Vite + React + TypeScript, zero chart dependencies. Node 20+.

---

## AWS environment

> This repo is public. The concrete account id and SSO URL are deliberately not
> written down here — read them from the machine you are working on, or ask the
> team. Everything below works from those two values.

| | |
|---|---|
| Account | `<ACCOUNT_ID>` — the "Dev" account; `aws sts get-caller-identity` after login |
| Region | **us-west-2** |
| SSO start URL | in `~/.aws/config` under `[sso-session …] sso_start_url` |
| Role | `AdministratorAccess` |
| Local profile | `default` (already configured in `~/.aws/config`) |

### Credentials

Authentication is **AWS IAM Identity Center (SSO)**. There are no long-lived
access keys, and you must not create any.

```bash
aws sso login          # opens a browser; the human has to complete it
aws sts get-caller-identity   # verify before doing anything else
```

**The SSO token expires often — typically within a day.** Every AWS command will
fail with `Token has expired and refresh failed`. That is not a bug in your code:
stop, ask the human to run `aws sso login`, and continue once they confirm. Check
`aws sts get-caller-identity` at the start of any AWS work rather than discovering
it halfway through a deploy.

Never write credentials, tokens, or session material into files, commit messages,
or the dashboard itself.

### What to provision (all new — do not touch the QA stack)

| Resource | Value |
|---|---|
| S3 bucket | `cargomatic-perf-dashboard-<ACCOUNT_ID>` |
| CloudFront distribution | new; comment `perf-dashboard-cargomatic-perf-dashboard-<ACCOUNT_ID>` |
| CloudFront Function | `perf-dashboard-router` |
| Cache policy | `perf-dashboard-cache` |

S3 bucket names are globally unique across all of AWS, hence the account-ID
suffix. The CloudFront domain is what people visit, so the bucket name is never
user-visible.

**Access: public**, matching the QA dashboard. Anyone with the URL can read every
result. Perf results are less sensitive than test failure output, but they do
expose internal endpoint paths and staging hostnames — say so plainly to the human
once, then proceed. If they want it private later, the change is CloudFront + OAC
in front of a private bucket plus an auth check; the SPA needs no changes because
it only ever issues same-origin GETs.

### IAM for CI

Create a role CI assumes via GitHub OIDC, write-only under `runs/`, so CI can
never delete history or overwrite the deployed SPA. Model it on
`dashboard/ci/iam-policy.json`.

---

## The data

The producer is **`perfmatic`** (`git@github.com:cargomatic/perfmatic.git`, local
at `/Users/ekhim/Documents/Automation/perfmatic`) — Newman + Apache Benchmark,
with k6 scripts alongside. **Read that repo before designing the schema**, in
particular `run.js` and `compare.js`.

One result object per test, already compact — this is a real sample:

```json
{
  "test_id": "Performance_Testing--UV_-_Shipment_-_Default_Drayage--Default_Request",
  "timestamp": "2026-05-19T19:35:36.361Z",
  "params": {
    "duration": "10s", "c": "5",
    "collection": "Performance Testing",
    "folder": "UV - Shipment - Default Drayage",
    "request": "Default Request"
  },
  "metrics": {
    "requests_per_sec": 1.3878979634765976,
    "time_per_request_ms": 3410.943687500001,
    "complete_requests": 16,
    "p50": 3076.666, "p75": 3944.5364999999997,
    "p90": 4846.773, "p99": 5917.26755,
    "non_2xx_3xx_responses": 16,
    "socket_errors_connect": 0, "socket_errors_read": 0,
    "socket_errors_write": 0, "socket_errors_timeout": 0,
    "errors_total": 16,
    "error_rate_pct": 100
  },
  "error_samples": []
}
```

**Direction of "worse" is not uniform, and `compare.js` already encodes it:**

- higher is worse: `time_per_request_ms`, `p50`, `p75`, `p90`, `p99`
- lower is worse: `requests_per_sec`

Every delta, arrow and colour in the UI must respect that per metric. A green
"▲ +12%" on p99 would be actively misleading. Take the lists from `compare.js`
rather than re-deriving them.

`compare.js` also does threshold-based baseline comparison — reuse its notion of
regression rather than inventing a second one.

### Suggested S3 layout

Mirror the QA dashboard, which is proven and whose discovery code you are reusing:

```
runs/<suite>/<run_id>/summary.json           run-level rollup + metadata
runs/<suite>/<run_id>/results/<test_id>.json  per-test results
runs/<suite>/latest/                          mirror of the newest run
```

- `<suite>` — lowercase slug, no spaces (`api`, `uv`, `booking`). This is what the
  suite dropdown lists and what trends are grouped by. Keep it stable: renaming
  starts a fresh trend line.
- `<run_id>` — GitHub `github.run_id`. A big integer, largest = newest.
- Each folder a clean mirror (`aws s3 sync --delete`).

Confirm this against how CI actually publishes before building — ask rather than
assume. Unlike the QA dashboard (which parses raw Allure in the browser), perf
output is already small, so a per-run `summary.json` written by CI is cheap and
worth doing: it avoids a request per test.

---

## Pitfalls — every one of these cost real debugging time on the QA dashboard

**CloudFront**

1. **Do NOT set a Default Root Object.** It makes CloudFront answer
   `/?list-type=2&prefix=runs/` with `index.html` before the origin sees the query
   string, so bucket-listing discovery silently returns the SPA's own HTML.
   Attach a CloudFront Function that appends `index.html` only for navigations and
   passes `list-type` requests straight through. Copy
   `infra/cloudfront-function.js`.
2. **The cache policy must include the full query string in the cache key.**
   Managed `CachingOptimized` ignores query strings, which collapses every
   ListObjectsV2 call onto one cache entry — `prefix=runs/api/` then serves the
   response for `prefix=runs/`. Managed `CachingDisabled` is correct but caches
   nothing. Create a custom policy: query strings `all`, DefaultTTL ~60s.
3. **Origin must be the S3 REST endpoint** (`bucket.s3.us-west-2.amazonaws.com`)
   via `CustomOriginConfig`, not the S3 website endpoint. Only the REST endpoint
   implements ListObjectsV2.
4. **Do NOT add a 404 → `index.html` CustomErrorResponse.** The usual SPA trick
   masks genuinely missing objects: a half-uploaded run answers with HTML and a
   200, and the dashboard cannot tell "not there yet" from "broken". There is no
   client-side router here, so nothing needs it.
5. **A distribution's domain never changes.** Redeploying reuses it. The URL only
   changes if a *new* distribution is created — which happens if the bucket name
   varies, because the deploy script finds the distribution by matching its
   `Comment`. Pin the bucket-name default in the script so a bare invocation
   cannot fork the stack and leave an orphan billing quietly.

**S3**

6. Bucket policy needs `s3:GetObject` **and** `s3:ListBucket` — the latter scoped
   to the `runs/` prefix so the rest of the bucket is not enumerable. Listing is
   what makes index-file-free discovery work.
7. Lift the bucket's public access block, or the policy is ignored.
8. Add a lifecycle rule. Perf JSON is small, so retention can be far longer than
   the QA dashboard's 90 days — but set one rather than none.

**Application**

9. **Version the client-side cache key.** Store runs in `sessionStorage` under a
   key containing a `CACHE_VERSION` constant, bump it whenever the run schema
   gains a field, and shape-check entries on read. Skipping this caused a live
   bug: entries written by an older build parsed fine but lacked a new field, and
   the dashboard rendered that as *absent data* — an empty chart sitting beside a
   table listing 402 failures, from the same object. Evict old-version keys so
   they do not fill the quota unread.
10. **Sort run ids numerically.** They are GitHub run ids, not timestamps. As
    strings, `"9999999"` sorts after `"10000000"` and the newest run is wrong. Get
    real times from the payload, never the folder name.
11. **Skip `latest/` when enumerating.** It duplicates a run already listed under
    its own id; counting it doubles the newest run in every aggregate.
12. Make discovery degrade gracefully: if listing is unavailable, fall back to an
    optional `runs/index.json` (a plain array of prefixes). This is also what makes
    local development work against fixtures.

---

## Charts

Load the `dataviz` skill before writing any chart code, and follow it. The QA
dashboard's `src/styles.css` already carries a validated palette — reuse the
tokens rather than picking colours.

Constraints that bite hardest for perf data:

- **Never a dual-axis chart.** Latency and throughput on one plot with two y-scales
  is the single most common perf-dashboard mistake. Use two charts, or index both
  to a common baseline.
- **Percentiles**: p50 / p90 / p99 as three lines is within the safe categorical
  range. Four or more series requires direct labels. A p50–p99 band with p90 as a
  line also reads well and uses one hue.
- **Magnitude comparisons** (slowest endpoints) use a single-hue sequential ramp,
  sorted worst-first, with direct value labels — not a categorical palette.
- **Error rate** is a status value: use the reserved status palette, always paired
  with a glyph and a label, never colour alone.
- Log scale is often right for latency across endpoints spanning orders of
  magnitude. If you use one, say so on the axis — an unlabelled log scale
  misleads worse than a clipped linear one.

Suggested sections: KPI row (p95 latency, throughput, error rate, run duration,
each with delta vs previous *and* vs baseline) → latency trend over runs →
throughput trend → slowest endpoints ranked → regressions vs baseline (using
`compare.js` thresholds) → per-test table with links.

---

## Definition of done

Do not report success on reasoning alone. Every one of these must be observed:

1. `npm run build` clean, `tsc --noEmit` clean.
2. Deterministic fixtures committed, so the app runs offline and screenshots are
   stable. Build them to contain the cases that break naive implementations: a
   sustained regression, a one-off spike, run ids straddling a digit-count
   boundary, a `latest/` mirror, and a suite covering only some endpoints.
3. **Render it and look at it** — screenshot the running app in light *and* dark,
   and actually inspect the images for label collisions, overflow and unreadable
   marks.
4. **Verify the arithmetic independently.** Write a separate script that recomputes
   the headline numbers straight from the fixture files, and diff it against what
   the page renders. Percentile aggregation across runs is easy to get wrong —
   note that percentiles cannot be averaged; decide and document how you combine
   them (worst-of, or per-run only).
5. After deploying, verify **live**: that `GET /?list-type=2&prefix=runs/` returns
   S3 XML rather than HTML, that a missing object returns a clean 404, that the
   suite dropdown lists what is in the bucket, and that rendered numbers match the
   raw JSON.
6. Report honestly. If something is unverified, say which part and why.

Commit in focused commits explaining *why*, not what. Do not commit
`.claude/settings.json` churn. Do not commit or push unless asked.
