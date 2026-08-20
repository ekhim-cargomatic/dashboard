# QA Automation Dashboard

Visualises Playwright/Behave automation results from S3: outcome trends over
time, and which areas of the product the failures actually landed in.

Static React SPA on S3 + CloudFront. No server, no database, no index file to
keep in sync — the dashboard **discovers runs by listing the bucket**, so a run
appears the moment CI finishes uploading it.

**Live:** https://d34o4mvhjdaxkf.cloudfront.net/

```
GitHub Actions (playwright-automation)
  behave → allure-results → allure generate → aws s3 sync --delete
                                       │
                                       ▼
        s3://bucket/runs/<suite>/<run_id>/     full Allure report
                        runs/<suite>/latest/   mirror of the newest run
                                       ▲
                                       │  ListObjectsV2 + GET  (same origin)
                                       │
                              CloudFront ──→ / (the SPA)
```

The dashboard reads the **raw Allure report** — CI publishes clean Allure mirrors
and nothing dashboard-specific. Two small files per run carry everything the
aggregates need:

| File | What it gives |
|---|---|
| `widgets/summary.json` | pass/fail/broken/skipped totals, wall-clock start/stop |
| `data/suites.json` | every test with status, duration, flaky flag, **and its behave tags** |

That second file carrying `tags` is what makes risk-domain attribution possible
client-side. Without it the only source would be one `data/test-cases/<uid>.json`
per test — thousands of requests per run.

---

## Published layout

```
runs/<suite>/<run_id>/     full Allure report (index.html, data/, widgets/, …)
runs/<suite>/latest/       mirror of the newest run for that suite
```

- **`<suite>`** — the suite slug: `smoke`, `regression`, and more as they're added.
  Always lowercase, no spaces. This is what the dashboard groups trend lines by, so
  keep it stable: renaming a suite starts a fresh trend line.
- **`<run_id>`** — the GitHub `github.run_id`. A big integer where larger means
  newer, **not** a timestamp. The dashboard sorts these **numerically** — sorted as
  strings, `"9999999"` lands after `"10000000"` and the newest run is wrong. Actual
  times come from `widgets/summary.json` (`time.start` / `time.stop`, epoch ms).
- **`latest/`** — a duplicate of a run already listed under its own id. The
  dashboard **skips it when enumerating**, or the newest run of every suite would
  be counted twice and all its failures doubled in the area charts. It's still
  useful as a stable bookmark: `…/runs/smoke/latest/index.html`.

Each folder is a clean mirror (`sync --delete`).

### Optional: `qa-summary.json`

If a `qa-summary.json` sits at a run root, the dashboard reads that instead — one
request instead of many, and it carries branch/commit/environment that Allure
doesn't. `ci/qa-summary.mjs` produces it and `ci/publish-to-s3.sh` will include it
automatically. Entirely optional; raw Allure works fine.

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
  (invoices, order_billing, unified_view, …), matched from each scenario's tags in
  `data/suites.json`. The default, and the most useful for "who needs to look".
- **Feature** — the behave Feature, from `data/behaviors.json`. (Not the file path:
  allure-behave reliably sets the `feature` label but rarely the
  parentSuite/suite labels that would give a directory, so `data/suites.json` is
  usually flat.)
- **Layer** — `@api` / `@ui` / `@e2e`.

A scenario tagged `@pagination @invoices` matches both the generic `tables` bucket
and `invoices`. Counting it in both would double-count the totals, so each
scenario is attributed to one **primary** domain: the least generic match,
tie-broken by declaration order in `tag_map.yaml`. Generic buckets (`tables`,
`admin`, `documents`, `exceptions`, `routing`) only win when nothing specific
matched. Scenarios matching no domain land in `unmapped` — a large `unmapped`
bucket means tags need attention.

### Reading "Tests executed"

A tag-filtered behave run emits **every** scenario in the suite and marks the ones
that didn't match as `skipped`. A real smoke run here shows 2,111 scenarios of
which 14 executed. So the KPI leads with **executed** (`total − skipped`), and pass
rate is `passed / executed`. Leading with the total would overstate coverage by two
orders of magnitude.

### Environment and branch filters

These come from Allure's `widgets/environment.json`, populated only if CI writes an
`environment.properties` into `allure-results`. It currently doesn't, so those
filters are **hidden** rather than shown empty. To light them up, add to the
`allure-results` directory before `allure generate`:

```
env=staging
branch=main
commit=abc1234
```

---

## Deploying

```bash
npm install
./infra/deploy.sh --app-only     # rebuild + push the SPA (typical)
./infra/deploy.sh                # full pass; also reconciles bucket/CDN config
```

Both reuse the existing distribution, so **the URL never changes**. `BUCKET`
defaults to the deployed bucket — overriding it creates a *second* stack on a new
URL, so leave it alone unless you're moving accounts.

Provisioning (first run, already done) creates the bucket with a public read +
`s3:ListBucket` policy scoped to `runs/`, a CORS rule, a 90-day lifecycle rule, the
CloudFront function, and a custom cache policy.

> **Access:** the bucket is public. Anyone with the URL can read every result,
> failure message and screenshot. To lock it down, put CloudFront in front of a
> private bucket with OAC and add an auth check — the SPA needs no changes, since
> it only ever does same-origin GETs.

### Keeping the domain map in sync

`tag_map.yaml` is the source of truth for risk domains. After changing it:

```bash
npm run gen:domains -- --tag-map ../playwright-automation/tag_map.yaml
./infra/deploy.sh --app-only
```

That regenerates `src/lib/domains.generated.ts` (the SPA) and
`ci/domains.generated.json` (the optional CI summariser). Both are committed.

---

## Local development

```bash
npm install
npm run fixtures   # 120 Allure-shaped runs across 3 suites into public/runs/
npm run dev        # http://localhost:5173
```

The fixtures are *real Allure file shapes*, so `npm run dev` exercises the same
parsing path production uses. They deliberately contain the cases that break naive
implementations: a sustained regression, one bad night that recovers, a flaky test,
a suite covering only some domains, run ids that straddle a digit-count boundary
(so numeric sorting is actually proven), and a `latest/` mirror that must be
skipped.

| Command | |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build |
| `npm run fixtures` | regenerate local fixture runs |
| `npm run gen:domains` | recompile the tag → domain map |

Against the real bucket instead:

```bash
VITE_S3_ORIGIN=https://cargomatic-qa-dashboard-164621342586.s3.us-west-2.amazonaws.com npm run dev
```

---

## How discovery works

The SPA calls S3's ListObjectsV2 REST API directly — the same call the AWS CLI
makes — through the same CloudFront distribution, so it's same-origin and CORS
never enters the picture.

`delimiter=/` makes S3 return *folders*, not objects: listing `runs/` returns the
suites, and `runs/smoke/` returns one entry per run rather than the ~5,000 files
inside each report. Runs are capped per suite (`maxRunsPerWorkflow`, default 60) so
a noisy hourly job can't push a weekly regression off the dashboard.

Loading is two-phase, because failure *messages* live in one file per test:

1. **Aggregates** — `widgets/summary.json` + `data/suites.json` per run. Two
   requests each; this is what the trend, area and heatmap charts need.
2. **Failure messages** — `data/test-cases/<uid>.json`, fetched only for the most
   recent `clusterRuns` runs (default 5). The clustering card fills in when they
   land; the rest of the page is already interactive.

Run data is immutable once written, so it's cached in `sessionStorage`.

**The one CloudFront gotcha:** do *not* set a Default Root Object. It makes
CloudFront answer `/?list-type=2&…` with `index.html` before the origin sees the
query string, and discovery silently returns the SPA's own HTML.
[`infra/cloudfront-function.js`](infra/cloudfront-function.js) appends `index.html`
for navigations only and passes `list-type` requests straight through. The cache
policy must also key on the full query string, or every listing collapses onto one
cache entry and returns the wrong runs. The SPA detects this specific
misconfiguration and says so rather than showing an empty dashboard.

If listing is unavailable, the SPA falls back to an optional `runs/index.json`
(a plain array of run prefixes). That's also how the local fixtures load.

### Runtime config

`/config.json` is read at startup so these can change without rebuilding:

```json
{
  "dataBaseUrl": "",
  "reportBaseUrl": "",
  "runsPrefix": "runs/",
  "maxRunsPerWorkflow": 60,
  "clusterRuns": 5,
  "ciRunUrlTemplate": ""
}
```

Empty origins mean "same origin". Set `ciRunUrlTemplate` to
`https://github.com/<org>/playwright-automation/actions/runs/{runId}` to make each
run link back to its CI job.

---

## Colour

One rule: **hue never carries meaning by itself.**

- **Magnitude** (area bars, heatmap cells) uses a single-hue sequential blue ramp,
  `--ramp-0` … `--ramp-8`. One hue is immune to colour-vision deficiency, and these
  are quantities to rank rather than identities to tell apart. Dark mode gets its
  own *selected* steps with the direction reversed, so "further from the surface
  means more" holds in both themes. Every bar is directly labelled, which is also
  the required relief for ramp steps below 3:1 against the surface.
- **Status** (passed/failed/broken/skipped) uses the reserved status palette.
  Green↔red measures ΔE ~4 under deuteranopia, so it is *always* paired with a
  glyph (`✓ ✕ ! –`) and a word. The stacked bars additionally seat neutral grey
  between green and orange — the worst adjacent pair — and keep a 2px surface gap
  between segments.
- **No categorical palette anywhere.** 26 domains would need 26 hues; they get a
  ramp and a sorted table instead.

Every chart has a hover layer, and every chart's numbers also exist in a table.

---

## Repo layout

```
src/
  App.tsx                  page composition and state
  types.ts                 the RunSummary contract
  lib/
    s3.ts                  bucket listing, run discovery, caching
    allure.ts              raw Allure report → RunSummary
    domains.ts             tag → risk-domain resolution
    aggregate.ts           cross-run analysis: trends, impact, heatmap, flakiness
    status.ts              status palette + the magnitude ramp
    domains.generated.ts   AUTO-GENERATED from tag_map.yaml
  components/              charts and tables
ci/
  publish-to-s3.sh         manual publish / backfill, same layout as CI
  qa-summary.mjs           optional precomputed summary (zero dependencies)
  domains.generated.json   AUTO-GENERATED from tag_map.yaml
  iam-policy.json          least-privilege policy for the CI role
infra/
  deploy.sh                provision + deploy
  cloudfront-function.js   routing, with the listing carve-out
scripts/
  gen-domains.mjs          tag_map.yaml → the two generated files
  make-fixtures.mjs        deterministic Allure-shaped fixture runs
```

---

## Cost

Storage dominates and it's all Allure HTML — a full report with attachments runs
50–200 MB. The 90-day lifecycle rule in `deploy.sh` bounds it. To cut further,
lower that window, or expire the heavy `data/attachments/` sooner than the small
`widgets/` and `data/suites.json` the trends actually need.
