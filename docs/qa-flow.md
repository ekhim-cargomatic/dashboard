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

The flag hides UI, not data. `public/qa-flow/` is served to anyone who asks for it.
Nothing in there is sensitive — selectors and endpoint shapes, no credentials — but
do not put a fixture password in it on the assumption the flag protects it.

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
