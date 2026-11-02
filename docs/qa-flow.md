# App flow map

The Cargomatic app as a graph: every screen, section, modal and field, the
selector that reaches it, and — for anything that writes — the API call it fires
plus the GET that proves the write landed.

It exists to be read by a generator. Prose test plans rot because nothing checks
them; this file is checked, by `scripts/validate-flow.py`, against the page
objects the Playwright suite actually runs.

```
public/qa-flow/index.json        the list of flow files, plus what is not mapped yet
public/qa-flow/cargomatic.json   every portal — 30 chunks, 812 steps
scripts/validate-flow.py         re-checks selectors and endpoints against the source repos
```

The map covers all four portals. Admin: orders list and both booking paths
(drayage and the shorthaul `/booking` wizard), leg management and bulk actions,
accessorial requests, billing status, invoicing, payouts, EDI, documents, audit
trails, quotes, exceptions, the pricing engine and Unified View. Carrier:
pending tasks, shipment actions, complete stop and POD, offers, payments,
drivers, documents. Shipper: booking, invoices, accessorial approval. Plus the
driver record. `index.json` lists what is still unmapped.

The three-actor accessorial path is the one worth running end to end: a carrier
raises a request (`cjd.acc.submit`), an admin approves it
(`acc.confirm.ok`), and the shipper accepts the charge (`sp.acc.submit`). Each
step is a separate chunk and each has its own read-back.

## Seeing it

It is behind a flag, off for everyone by default:

```
https://<dashboard>/?qa=1     on
https://<dashboard>/?qa=0     off
```

The choice is remembered per browser, so a link with `?qa=1` shares it. `?ff=qa-on`
/ `?ff=-qa` work too — `qa` is an ordinary entry in `src/lib/flags.ts` that happens
to also answer to its own shorthand. Turning it on adds an **App flow** tab beside
**Runs**; the map takes the full window rather than the dashboard's reading column.

The tree is the page — it takes whatever height the window has left, and **full
screen** in its toolbar hands it the whole display. Drag the background to pan,
⌘/ctrl-scroll (or pinch) to zoom about the cursor, or use the `−  100%  +  fit`
control; `+`, `−`, `0` and `f` do the same from the keyboard. **fit** shows all 49
chunks at once, which is too small to read and the right way to see the shape.

Clicking a chunk opens its detail as a drawer off the right edge rather than a
panel below it, so the map stays on screen beside what you are reading: what
gates the chunk, what it needs, what needs it, and every step with its selector
and API calls. Following a dependency link from inside swaps the drawer to that chunk and moves
the map behind it, so closing leaves you where that chain ended. Escape or the
backdrop closes it, and the pan and zoom are untouched. **about** carries the
flow variables and the not-yet-mapped list.

The flag hides UI, not data. `public/qa-flow/` is served to anyone who asks for it.
Nothing in there is sensitive — selectors and endpoint shapes, no credentials — but
do not put a fixture password in it on the assumption the flag protects it.

## Running a chunk's tests

The drawer's **▶ run** button starts the automation for that chunk and watches
it. What it runs deserves to be stated plainly, because the button could easily
imply something it does not do:

> It runs the **existing tests tagged for that area**. It does not execute the
> chunk's steps. A chunk's `tags` and a feature file's tags are the same
> vocabulary, and that is the only bridge between this map and the suite.

So the button names the tag — `▶ run @markets`, not `▶ run` — and the dialog
says how many scenarios that is before anything starts. Measured against the
current suite, the 49 chunks fall into three groups:

| | chunks | what the button does |
|---|---|---|
| a narrow area tag exists | 36 | runs it, and says how many scenarios |
| only a broad one exists | 4 | runs it, warning that `@drayage` is 195 scenarios, not one chunk |
| no area tag the suite carries | 9 | greyed, and names the tag nobody has written a test for |

That last group is the useful one: `@carrierPortal`, `@shipperPortal`,
`@pendingTasks`, `@pricing` and `@auth` are in the map and in no feature file.
The button is left visible and disabled rather than hidden, because the absence
is the finding.

Scope and layer tags are deliberately not selectors. `@smoke` says *when* a test
runs and `@ui` says *how it is written*; neither names a chunk, so a chunk left
with only those counts as "no area tag" however few scenarios they would match.

### What happens when you press it

```
                                     s3://…-qa-flow-src/suite.zip  (private)
                                            │  uploaded by --push-tests
                                            ▼
drawer ──POST /api/run-flow──> Lambda ──StartBuild──> CodeBuild
                                                        behave · allure
                                                        aws s3 sync -> runs/flow-run/
drawer <──GET /api/run-flow?build=…── phase, then the run appears in the runs list
```

The suite is uploaded from a workstation rather than cloned, so no git
credential exists anywhere in this system. `./infra/deploy-flow-fn.sh
--push-tests` re-uploads it in a few seconds after you edit a test. The suite's
`.env` travels inside that private payload, which is what `before_all` already
reads — so no credential is stored anywhere else, and none is ever sent from the
browser.

The run publishes into the same `runs/` prefix as every CI run, with the same
`qa-summary.json`, so it shows up in the dashboard like any other — no special
case on the reading side. All flow runs share one `flow-run` suite folder rather
than one per chunk, which would bury the real suites; the chunk id is recorded
in the summary's `trigger`.

**One build at a time.** That caps spend, but mostly it stops two runs fighting
over the same staging records — a failure mode that looks exactly like a product
bug and wastes an afternoon.

**The endpoint is public and unauthenticated**, like the rest of the dashboard.
It is kept harmless by being unable to do much: a hardcoded CodeBuild project, a
tag allowlist baked in from this map, `staging`/`dev` only, and the one-at-a-time
rule. It cannot run an arbitrary behave expression. See the header of
`infra/flow-run-fn/index.mjs`.

### Working on it without spending anything

`infra/flow-run-fn/local-server.mjs` runs the real handler against a simulated
CodeBuild, so the dialog's polling, phase labels and failure states can be
developed without starting a build:

```
npm i --no-save @aws-sdk/client-codebuild
node infra/flow-run-fn/local-server.mjs          # --fail to see a red run
```

then point `public/config.json` (gitignored) at
`"runFlowUrl": "http://localhost:8788/api/run-flow"`.

The tag counts come from `npm run gen:flow-tags`, which reads the feature files
and writes `src/lib/flow-tags.generated.ts`. **Re-run it when features are added
or retagged** — otherwise the dialog promises a scenario count the suite no
longer has.

## Why each piece is shaped the way it is

**Chunks, not one long script.** Each chunk declares an `entry`, an `exit`, and
the earlier nodes it depends on in `requires`. A generator can emit one chunk as
a standalone test; a person can run one without driving the whole order-to-cash
path. Chunks are joined by `edges`, which is what the rail draws.

**Nesting by section and modal.** `parent` puts a field inside the modal that
owns it, so a generator knows the modal has to be open first, and a reader can
see at a glance which controls disappear when a dialog closes.

**Selectors are copied, never written.** `source` names a page-object constant
(`OrderBookingPage.SHIPPER_INPUT`) and `selector` is its value, byte for byte.
When the two differ, the validator fails. Where a selector is deliberately
scoped or derived from a constant, it is `sourceComposed` instead and only the
constant's existence is checked. Fix selectors in **playwright-automation** and
re-run the validator — editing them here changes nothing that runs.

**Every write names its read-back.** This is the part worth the effort. These
pages close a modal and show a success toast whether or not anything persisted —
CAR-3287's Record Payment closes cleanly and changes nothing. So a mutating node
carries:

```jsonc
"api": {
  "await":  { "method": "POST", "path": "/api/orders", "status": [200,201], "timeoutMs": 60000 },
  "capture": { "orderId": "/id" },
  "verify": { "method": "GET", "path": "/api/orders/{orderId}", "scope": "record",
              "assert": [{ "pointer": "/equipments", "minLength": 1 }] },
  "settleMs": 30000
}
```

`await` is the write and the step is not finished until it settles. `verify` is
the honest pass condition. `scope` says how much to re-read — `record` for the
whole entity, `field` with `field` named for one value, `collection` for the list.
`settleMs` is extra quiet time before reading back, because staging routinely
spends 25–60s on a skeleton after a save and a verify fired too early reads the
old value and passes for the wrong reason.

A write with nothing to read back says so in `verifyNotApplicable` — an email
send changes no record. That keeps the "unverified writes" count meaningful
instead of permanently non-zero.

`capture` lifts JSON Pointers out of a response into flow variables, referenced
elsewhere as `{orderId}`, `{jobId}`, `{invoiceId}`, `{payoutId}`.

`reads: true` marks a POST that queries rather than writes — Unified View's
grid, the invoice and payout change logs, the distance and price quotes. Method
alone is not a good test for "is this a mutation" in this codebase, and counting
those as writes made the unverified-write number noise.

A node whose control lives in another chunk's UI — Send EDI sits in the invoice
Actions menu — uses `attachesTo` rather than `parent`, so it reads in the chunk
it belongs to without pretending to be nested somewhere it is not.

**Paths are the monolith's own.** `/api/...` and `/admin/api/...`, taken from
`apps/monolith/app/routes/api/*.js`. The edge gateway serves them under `/mono`,
which is why `env.apiPrefix` exists and why a matcher should key off the suffix
rather than the whole URL.

## Keeping it honest

```bash
python3 scripts/validate-flow.py ~/Documents/Automation/playwright-automation \
                                 ~/Documents/Automation/monopoly
```

Checks, worst-first: every `source` constant exists and its value equals the
`selector`; every `method` + `path` names a real Express route in the monolith;
every `sourceComposed` / `pathSource` constant exists; node ids are unique;
`parent`, `opens`, `entry`, `exit` and `requires` all resolve; edges name real
chunks and no chunk is stranded off the graph. Non-zero exit on any failure, so
it can gate a deploy. Run it after anyone touches page objects or routes.

The monopoly path is optional and the endpoint check is skipped without it —
but do pass it. A plausible-looking endpoint that does not exist is the easiest
thing to write into this file and the hardest to notice afterwards; three got in
on the first pass (`/api/1/users/login`, `/api/1/users/me`, and a GET against
`/api/1/shippers/:id/locations` that only exists as a POST) and only this check
caught them.

## Adding a flow

Drop a JSON file in `public/qa-flow/` and add it to `index.json`. The `planned`
list there is the backlog — carrier portal, shipper portal, quotes, pricing
engine, exceptions — and the fastest way to build one is the same way this one
was built: pull the constants out of the matching page objects, group them by the
modal or section that owns them, then attach the write and the read-back from the
monolith's route table.
