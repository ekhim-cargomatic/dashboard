# Endpoint audit — the flow map against monopoly

The validator proves every `api.path` is a registered Express route in the
monolith. That is a weaker claim than it looks: it says the endpoint exists,
not that it is the one the button fires. This pass went further and looked for
the call site.

## How

`scripts/` has the validator; the audit itself was a throwaway script that read
every API util under `apps/admin-client-legacy/src` and `apps/lorax/src`,
pulled out each `client({ method, path })` and `request.<verb>(...)` call, and
normalised the paths. 411 call sites came out. Each endpoint in the map was
then looked up in that table.

## Result

| | count |
|---|---|
| endpoint uses in the map | 487 |
| matched to a literal call site in an API util | 262 |
| registered route, no literal call site found | 225 |

Every one of the 225 is a real route. They fall into three groups:

1. **URLs built at runtime.** `CustomersAPIUtils.method(verb, url, data)` is a
   generic passthrough, and several screens build the path from parts. Nothing
   static can follow those.
2. **Front ends outside this monorepo.** The exceptions workbench, Unified
   View, quotes and the pricing v2 screens have endpoints registered in the
   monolith with no caller in `admin-client-legacy` — they are served from
   somewhere else.
3. **The driver app**, which is not in this monorepo at all. Its five chunks
   carry a `confidenceNote` saying so.

So `confidence: "route-table"` means *absence of proof*, not evidence of a
wrong endpoint. `confidence: "client"` means the method and path appear
verbatim in an API util.

## What the audit actually found wrong

Six endpoints were attached to the wrong route. Each was a real route, which is
why the route-table check passed.

| node | was | is | source |
|---|---|---|---|
| `us.shipper.submit` | `POST /api/users` | `POST /api/1/shippers` | `UserWebAPIUtils.js:225` `addCargomaticUser()` |
| `us.carrier.submit` | `POST /api/users` | `POST /api/1/carriers` | `UserWebAPIUtils.js:233` `addCarrier()` |
| `us.driver.submit` | `…/{userId}/driver` | `…/{carrierId}/driver` | `UserWebAPIUtils.js:264` `addDriver()` |
| `us.admin.modal.submit` | `POST /admin/api/v3/users` | `POST /admin/v2/users` | `UserWebAPIUtils.js:194` `addAdminUser()` |
| `sh.routing.save` | `PUT /api/1/users/{shipperId}` | `PATCH /api/v2/shippers/{shipperId}/routing` | `UserWebAPIUtils.js:221` |
| `sh.master.associate` | `PUT /api/1/users/{shipperId}` | `PUT /admin/api/v2/shippers/{shipperId}/master_account` | `CustomersAPIUtils.js:1413` |

## And one the audit got wrong

The first version of the extractor only understood literal and template paths,
not `'/admin/api/v2/equipment/' + equipment._id`. It read that as the bare
collection path and "corrected" two equipment endpoints that had been right.
The validator caught one of them immediately — `PATCH /admin/api/v2/equipment`
is not a registered route — and the other was found by reading
`EquipmentWebAPIUtils.js`. Both are back to what they were, now with the line
that proves it. The extractor handles concatenation since.

Worth remembering: a tool that reports a correction is making a claim too, and
it needs checking the same way.
