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
| `data/suites.json` | every test with status, duration, **and its behave tags** |

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
| **Persistent or one-off?** | Has an area failed in *every* run, or just occasionally? |
| Top failure reasons | Which root causes account for the most failures? |
| Runs table | Per-run detail, with deep links into the full Allure report |

### Picking a suite

The **Suite** dropdown lists every prefix under `runs/` with its run count, so
`smoke`, `regression` and anything added later appear automatically — no config.
Selecting one scopes the whole page: the trend then walks every report published
under that suite, in `run_id` order.

It defaults to the busiest suite rather than "all". A trend line across mixed
suites is misleading — a 44-test targeted run and a 2,111-scenario regression have
unrelated pass rates, and interleaving them by time produces a sawtooth that looks
like instability but is just two populations. **All suites** stays one click away
for cross-suite comparison.

### How "area" is determined

Areas are the **raw behave tags**, read from `data/suites.json`. That's the
behave-native answer and it doesn't depend on `tag_map.yaml` being current.

One consequence to keep in mind: a scenario appears under **every** tag it
carries, so these rows *overlap and do not sum to the run total*. The chart says
so on the card. That's the honest shape when a scenario genuinely spans two areas
— `@pagination @invoices` belongs to both.

Three other groupings are implemented in `lib/aggregate.ts` and are one constant
away (`GROUP_BY` in `src/App.tsx`) if you ever want them back:

- **`domain`** — the 26 business areas in `playwright-automation/tag_map.yaml`,
  folded from tags, with each scenario attributed to exactly **one** domain so the
  rows partition the run and totals add up.
- **`suite`** — the behave Feature, from `data/behaviors.json`.
- **`layer`** — `@api` / `@ui` / `@e2e`.

#### What the Tag grouping leaves out

Behave tags do several jobs, and leaving the non-area ones in makes the chart
useless: every test in a smoke run carries `@smoke`, and each case id appears
exactly once, so you get one row per test. Excluded:

| Kind | Examples | Source of the exclusion |
|---|---|---|
| Scope selectors | `@smoke`, `@regression`, `@happy_path` | tag_map `scopes` |
| Layer | `@ui`, `@api`, `@e2e`, `@portal` | tag_map `layers` (its own grouping) |
| Execution gates | `@wip`, `@bug`, `@skip`, `@deprecated` | tag_map `exclude_always` |
| Traceability ids | `@C22747`, `@C_AMZ_EDI_210`, `@CAR-1482`, `@TC-01`, `@tee7` | tag_map `non_routing` patterns |

Those come from `tag_map.yaml` itself — including the `non_routing` regexes — so
they stay correct as conventions change rather than being guessed in the dashboard.

### How the numbers are derived

| Figure | Formula |
|---|---|
| executed | `total − skipped` |
| pass rate | `passed / executed` |
| needs attention | `failed + broken` |
| fail rate | `(failed + broken) / executed` |
| wall clock | `time.stop − time.start` from `widgets/summary.json` |

Totals come from the same `data/suites.json` leaves every breakdown is built
from, **not** from `widgets/summary.json`. The two normally agree exactly
(verified against production: 2,111 either way), but taking headline numbers from
one source and per-area rows from another would let the page contradict itself.
`summary.json` remains the source for wall-clock time, which the leaves can't give.

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
implementations: a sustained regression, one bad night that recovers,
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
