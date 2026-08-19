# QA Automation Dashboard

Visualises Playwright/Behave automation results from S3: outcome trends over
time, and which areas of the product the failures actually landed in.

Static React SPA on S3 + CloudFront. No server, no database, no index file to
keep in sync — the dashboard **discovers runs by listing the bucket**, so a run
appears the moment CI finishes uploading it.

```
GitHub Actions (playwright-automation)
  behave → allure-results → allure generate
       │
       ├─ ci/qa-summary.mjs      parses allure-results + tag_map.yaml
       │                         → qa-summary.json  (compact, ~30 KB)
       └─ ci/publish-to-s3.sh    aws s3 sync
                                       │
                                       ▼
              s3://bucket/runs/<workflow>/<timestamp>-<run#>/
                    ├── qa-summary.json
                    └── allure-report/…          (full Allure HTML)
                                       ▲
                                       │  ListObjectsV2 + GET  (same origin)
                                       │
                              CloudFront ──→ / (the SPA)
```

---

## What it shows

| Section | Question it answers |
|---|---|
| KPI row | How did the latest run go, and which way is it moving? |
| Pass rate trend | Is the suite getting better or worse? |
| Outcome mix per run | Did the pass rate rise because tests passed, or because they were skipped? |
| **Most affected areas** | Where did the failures land — by volume and by fail rate? |
| **Regression or flake?** | Has an area been red *every* run, or just occasionally? |
| Top failure reasons | Which root causes account for the most failures? |
| Flakiest tests | Which tests keep changing their verdict? |
| Runs table | Per-run detail, with deep links into the full Allure report |

### How "area" is determined

Three groupings, switchable in the filter row:

- **Risk domain** — the 26 business areas in `playwright-automation/tag_map.yaml`
  (invoices, order_billing, unified_view, …), matched from each scenario's behave
  tags. This is the default and the most useful for "who needs to look at this".
- **Feature path** — the directory the `.feature` file lives in. Useful when tags
  are missing or wrong.
- **Layer** — `@api` / `@ui` / `@e2e`.

A scenario tagged `@pagination @invoices` matches both the generic `tables` bucket
and `invoices`. Counting it in both would double-count the totals, so each
scenario is attributed to one **primary** domain: the least generic match, tie-broken
by declaration order in `tag_map.yaml`. Generic buckets (`tables`, `admin`,
`documents`, `exceptions`, `routing`) are ranked as generic in
`scripts/gen-domains.mjs` and only win when nothing specific matched. Scenarios
matching no domain land in `unmapped` — a large `unmapped` bucket means tags need
attention.

---

## Setup

### 1. Provision AWS and deploy the SPA

```bash
npm install
BUCKET=cargomatic-qa-dashboard REGION=us-west-2 ./infra/deploy.sh
```

Idempotent. It creates the bucket, applies the public read + list policy, a CORS
rule, a 90-day lifecycle rule, publishes the CloudFront function, creates the
distribution, then builds and uploads the SPA. It prints the CloudFront URL.

Re-deploy the SPA alone (no provisioning):

```bash
./infra/deploy.sh --app-only
```

> **Access:** the bucket is public, as specified. Anyone with the URL can read
> every result, failure message and screenshot. If that stops being acceptable,
> the change is to put CloudFront in front of a private bucket with OAC and add
> an auth check — the SPA needs no changes, since it only ever does same-origin GETs.

### 2. Wire up CI

Copy the steps from [`ci/github-workflow-snippet.yml`](ci/github-workflow-snippet.yml)
into the `merge-report` job of each workflow that should feed the dashboard,
right after "Generate Allure Report".

Create an IAM role for CI to assume via OIDC using
[`ci/iam-policy.json`](ci/iam-policy.json) (write-only under `runs/` — CI cannot
delete history or overwrite the deployed SPA), then set:

| Kind | Name | Example |
|---|---|---|
| variable | `QA_DASHBOARD_BUCKET` | `cargomatic-qa-dashboard` |
| variable | `AWS_REGION` | `us-west-2` |
| secret | `AWS_ROLE_ARN` | `arn:aws:iam::…:role/qa-dashboard-publisher` |

Publishing manually, from the automation repo:

```bash
QA_DASHBOARD_BUCKET=cargomatic-qa-dashboard \
  bash ../qa-dashboard/ci/publish-to-s3.sh \
    --results reports/allure-results \
    --report  reports/allure-report
```

`WORKFLOW_NAME` decides which workflow bucket a run lands in and therefore which
trend line it joins — keep it stable; renaming a workflow starts a fresh line.

### 3. Keep the domain map in sync

`tag_map.yaml` is the source of truth for risk domains. After changing it:

```bash
npm run gen:domains -- --tag-map ../playwright-automation/tag_map.yaml
```

That regenerates `src/lib/domains.generated.ts` (the SPA) and
`ci/domains.generated.json` (the summariser). Both are committed so CI needs no
YAML parser. Redeploy the SPA to pick up the change.

---

## Local development

```bash
npm install
npm run fixtures   # 120 realistic runs across 3 workflows into public/runs/
npm run dev        # http://localhost:5173
```

The fixtures contain the shapes the dashboard exists to surface: a sustained
regression in `order_billing` starting partway through the window, one bad night
that recovers, a genuinely flaky test, and a targeted workflow that only covers a
few domains (so the heatmap's "not run" hatching is exercised). They are
deterministic, so screenshots stay stable.

Against a real bucket instead:

```bash
VITE_S3_ORIGIN=https://cargomatic-qa-dashboard.s3.us-west-2.amazonaws.com npm run dev
```

| Command | |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build |
| `npm run typecheck` | types only |
| `npm run fixtures` | regenerate local fixture runs |
| `npm run gen:domains` | recompile the tag → domain map |
| `npm run summary` | run the summariser directly |

---

## How discovery works

The SPA calls S3's ListObjectsV2 REST API directly — the same call the AWS CLI
makes — served through the same CloudFront distribution, so it is same-origin and
CORS never enters the picture.

Two things keep it cheap enough to do from a browser:

1. `delimiter=/` makes S3 return *folders*, not objects. Listing `runs/` returns
   ~10 workflows; listing `runs/smoke-tests/` returns one entry per run, not the
   thousands of files inside each Allure report.
2. Run keys begin with a UTC timestamp, so lexical-descending order is
   newest-first. The newest 60 per workflow (`maxRunsPerWorkflow`) are fetched
   without reading any of the others.

Summaries are immutable once written, so they are cached in `sessionStorage`;
only the newest run costs a request on a repeat visit.

**The one CloudFront gotcha:** do *not* set a Default Root Object. It makes
CloudFront answer `/?list-type=2&…` with `index.html` before the origin sees the
query string, and discovery silently returns the SPA's own HTML. That is why
[`infra/cloudfront-function.js`](infra/cloudfront-function.js) exists — it appends
`index.html` for navigations only and passes `list-type` requests straight
through. The SPA detects this specific misconfiguration and says so rather than
showing an empty dashboard.

If listing is unavailable, the SPA falls back to an optional `runs/index.json`
(a plain array of run prefixes). That is also how the local fixtures load.

### Runtime config

`/config.json` is read at startup so the bucket, prefix and run cap can change
without rebuilding:

```json
{
  "dataBaseUrl": "",
  "reportBaseUrl": "",
  "runsPrefix": "runs/",
  "maxRunsPerWorkflow": 60
}
```

Empty origins mean "same origin". Set `dataBaseUrl` only if the data lives
somewhere other than where the SPA is served from.

---

## Colour

The charts follow one rule: **hue never carries meaning by itself.**

- **Magnitude** (area bars, heatmap cells) uses a single-hue sequential blue ramp,
  `--ramp-0` … `--ramp-8`. One hue is immune to colour-vision deficiency, and
  these are quantities to rank rather than identities to tell apart. Dark mode
  gets its own *selected* steps with the direction reversed, so "further from the
  surface means more" holds in both themes. Every bar is directly labelled, which
  is also the required relief for ramp steps below 3:1 against the surface.
- **Status** (passed/failed/broken/skipped) uses the reserved status palette.
  Green↔red measures ΔE ~4 under deuteranopia, so it is *always* paired with a
  glyph (`✓ ✕ ! –`) and a word, in the legend and in every chip. The stacked bars
  additionally seat neutral grey between green and orange — the worst adjacent
  pair in the set — and keep a 2px surface gap between segments.
- **No categorical palette is used anywhere.** 26 domains would need 26 hues; they
  get a ramp and a sorted table instead.

Every chart has a hover layer, and every chart's numbers also exist in a table.

---

## Repo layout

```
src/
  App.tsx                  page composition and state
  types.ts                 the qa-summary.json contract, shared with CI
  lib/
    s3.ts                  bucket listing, run fetching, caching
    aggregate.ts           cross-run analysis: trends, impact, heatmap, flakiness
    status.ts              status palette + the magnitude ramp
    domains.generated.ts   AUTO-GENERATED from tag_map.yaml
  components/              charts and tables
ci/
  qa-summary.mjs           allure-results → qa-summary.json (zero dependencies)
  publish-to-s3.sh         summarise + upload one run
  domains.generated.json   AUTO-GENERATED from tag_map.yaml
  github-workflow-snippet.yml
  iam-policy.json
infra/
  deploy.sh                provision + deploy
  cloudfront-function.js   routing (with the listing carve-out)
scripts/
  gen-domains.mjs          tag_map.yaml → the two generated files
  make-fixtures.mjs        deterministic local fixture runs
```

---

## Cost

Storage dominates, and it is all Allure HTML. A 381-scenario regression report
with screenshots runs roughly 50–200 MB; the `qa-summary.json` beside it is ~30 KB.
At ~3 runs/day the 90-day lifecycle rule in `deploy.sh` holds a few hundred GB —
tens of dollars a month in S3, and very little in CloudFront at internal traffic
levels. To cut it, lower the lifecycle window; the trend charts only need the
summaries, so an alternative is a second rule expiring `allure-report/` sooner
than the summaries beside it.
