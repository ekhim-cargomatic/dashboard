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

## Running a point on the map

Every step in the drawer carries a **▶**, and the chunk header carries **▶ run
to exit**. Pressing one walks the map to that point in a real browser and stops
there.

> **The map is the script.** No feature file is read and behave is not run. The
> `selector`, `action`, `control` and `api.await` already in `cargomatic.json`
> are what executes. That is the whole point: the map stops being a description
> of the app and becomes a way to drive it.

### How a point becomes a plan

Four relationships in the map carry the traversal, and all four were already
there:

| | what it supplies |
|---|---|
| `dependsOn` | the chunks that must have happened first — a sign-in, and any chunk that captures a variable this one needs |
| `parent` | containment: a field is inside a section is inside a page |
| `opens` | the 66 buttons that open a modal — the way into its contents |
| `attachesTo` | the items inside a menu, which do not exist in the DOM until it is open |
| `edges` | how to reach the 13 chunks that have no page node of their own |

A plan for `us.admin.modal.submit` comes out as: sign in as admin, go to
`/users`, click **Register New User**, fill the five fields the form requires,
click **Register**. Thirteen steps across two chunks, and nothing else on that
screen is touched — the shipper and carrier forms are sibling branches, so they
are not on the way.

A dependency is run only as far as it needs to be. A *session* dependency runs
to the chunk's exit, because that is the map's statement that it finished. A
*data* dependency runs to the step that captures the variable, which is often
past the exit: the exit of **Leg management** is the table being rendered, but
`{jobId}` only exists once a row has been opened.

### What it can reach

`npm run flow:targets` answers this from the real resolver rather than an
estimate:

```
1246 of 1999 points on the map can be run
35 of 49 chunks have at least one
15.2 steps in an average plan
```

The rest, in order of how many they account for: mobile screens (Appium
locators, which Playwright cannot drive), nodes with no selector authored, a
typeahead with no `then` naming the list its suggestions appear in, chunks that
need a `{shipperId}` or `{carrierId}` the fixture is expected to supply, file
uploads, and selectors with a `{label}`-style parameter the map does not fill.

Each of those is a specific, fixable gap in a specific node, and the dialog
names it rather than greying the button out — a step that cannot be run is more
useful when it says why.

### Values

The map carries a selector for all 441 of its fields and a value for none of
them, so the runner makes one up from the field's control type and name:
`QA`/`Test` for names, a unique `qa+NNNN@cargomatic.com` for emails, today for
dates, the first real option for a select.

Two cases are not guesswork. **Credentials** — every field on a sign-in screen,
and any field marked `secret` — resolve on the runner from the suite's own
`configs/<env>.yaml`, so no credential is ever in a plan, in the dialog or in
the log. **Typeaheads** search for the suite's fixture records, because a search
box shows nothing until what you type matches something that exists, and "QA"
matches no shipper on staging.

Every other value is shown in the dialog, editable, before anything runs.

### What happens when you press it

```
                                     s3://…-qa-flow-src/suite.zip  (private)
                                            │  uploaded by --push-tests
                                            ▼
dialog ──GET  ?plan=<node>──> Lambda  resolves the plan from its copy of the map
dialog ──POST /api/run-flow─> Lambda ──plan to S3──> CodeBuild
                                                       run_plan.py · allure
                                                       aws s3 sync -> runs/flow-run/
dialog <──GET ?build=…&since=── phase + new log lines, step by step
```

The preview and the run are the same resolver call, so the dialog cannot promise
something different from what happens. The plan travels through S3 rather than a
build environment variable, because a long one is tens of kilobytes.

The suite is uploaded from a workstation rather than cloned, so no git credential
exists anywhere in this system. `./infra/deploy-flow-fn.sh --push-tests`
re-uploads it in a few seconds after you edit a test; `--code-only` republishes
the function, which is also what ships a changed map.

The run publishes into the same `runs/` prefix as every CI run, with the same
`qa-summary.json`, so it shows up in the dashboard like any other — no special
case on the reading side. `run_plan.py` writes Allure results directly, one test
case per run with a step per plan step. All flow runs share one `flow-run` suite
folder rather than one per target, which would bury the real suites; the target
is recorded in the summary's `trigger`.

**One build at a time.** That caps spend, but mostly it stops two runs fighting
over the same staging records — a failure mode that looks exactly like a product
bug and wastes an afternoon.

**The endpoint is public and unauthenticated**, like the rest of the dashboard.
It is kept harmless by what it is able to accept: a caller names a *node on the
map* and nothing else. Every selector, gesture and page is resolved inside the
function from its own copy of the map, so no selector ever crosses the wire and
the endpoint cannot be asked to drive a signed-in staging browser somewhere the
map does not already describe. Field values are the one caller-supplied thing,
and they are length-capped, stripped of control characters, and never applied to
a credential. Add a hardcoded project, `staging`/`dev` only, and the
one-at-a-time rule. See the header of `infra/flow-run-fn/index.mjs`.

### Working on it without spending anything

`infra/flow-run-fn/local-server.mjs` runs the real handler against a simulated
CodeBuild, so the dialog's polling, phase labels and failure states can be
developed without starting a build:

```
npm i --no-save @aws-sdk/client-codebuild @aws-sdk/client-s3 @aws-sdk/client-cloudwatch-logs
node infra/flow-run-fn/local-server.mjs          # --fail to see a red run
```

then point `public/config.json` (gitignored) at
`"runFlowUrl": "http://localhost:8788/api/run-flow"`.

Plans there are resolved by the real resolver against the real map, so what the
dialog shows is what a deployed run would do — only the build is simulated. The
fake build narrates the plan back one step at a time, which is the only way to
see the log panel's tail-following and colouring without spending minutes.

`npm run flow:targets` prints which points on the map can be walked to and why
the rest cannot; `npm run flow:targets <node id>` prints one plan in full.

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
