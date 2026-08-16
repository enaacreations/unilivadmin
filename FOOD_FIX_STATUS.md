# Food module fix — final verification status

**Branch:** `dev-food-module-fix`. The fix work is **committed as `2b4c40f`** ("fix(food): close 48
defects from the end-to-end module analysis", 85 files). On top of it sits an uncommitted follow-up
round (this document's latest revision) plus **unrelated AUDIT work that is deliberately
uncommitted** — 17 files (`audit-*.ts`, `audits/*.tsx`, `schema/audit.ts`, `layout.tsx`, `nav.ts`,
`apps.tsx`, `AUDIT_PRD_GAP_ANALYSIS.md`). Keep those two apart when committing.
**Baseline:** `FOOD_MODULE_ANALYSIS.md`, 52 numbered defects (C1–C6, H1–H12, M1–M22, L1–L12).
**Method:** four rounds of fixes, each followed by independent re-verification, then a **fifth
follow-up round** that closed the open list below. Every check in this document was executed rather
than read.

---

## Verdict

**Merge.** The follow-up list is now down to a single item, and that item belongs to the audit
commit rather than this one.

The four merge blockers named in earlier rounds are closed and were re-proved end to end this
round, not merely re-read:

- **B0** (`payments.property_id` had no deploy path) — proved by *reproducing the failure*: dropped
  the column on the dev DB, ran `backfill:payment-property` (it re-added the column and filled all
  50 rows from `residents.property_id`), then `push` applied `SET NOT NULL` with **no data-loss
  banner**, and a second `push` reported `No changes detected`. All 50 values compared identical to
  a pre-drop snapshot.
- **B4** (fail-closed scoping with no backfill) — `backfill:user-scopes` exists, is dry-run by
  default, and passes on *resolution* rather than grant existence. Proved fail-closed by revoking a
  live grant: it exited **1** and named the account. Restoring the grant returned it to exit 0.
- **H3c / bundling** — the api image carries no `node_modules`, and the last unbundled dependency
  (`sns-validator`) is fixed this round. Proved by copying `dist/` to a directory with **no
  `node_modules` anywhere above it**, confirming `import("sns-validator")` is
  `ERR_MODULE_NOT_FOUND` from disk there, and then booting the bundle successfully from that
  directory. `API_BUNDLE_VERIFY=strict` now fails the build on any regression and is wired into
  `docker/Dockerfile`.
- **B1/B2/B3, H4, M22** — all verified in code this round (details in the table).

Runtime state is genuinely healthy: `pnpm run typecheck` is clean across all 5 projects, **340 API
tests** and **28 web tests** pass, the API boots from its built bundle and serves every required
food endpoint with **zero 500s and zero error-level log lines**, the variance CSV export returns the
variance dataset, `push` is convergent, all four deploy scripts are idempotent, the two-step seed
produces an orderable menu, and the frontend builds.

The follow-up round closed **ten of the eleven** items previously listed as open, including the two
called out last round as easiest-to-fix-now (the `verifySns` bare catch and the absent zones/clusters
UI). The eleventh (`scopeCrumbs` dead code) lives in `nav.ts`, which belongs to the audit commit.

It also found and fixed **one new defect that the previous round's checks could not see**: creating a
brand or kitchen with an existing `code` returned `500 Internal server error`. `POST /brands` did
have duplicate handling, but it tested `err.message` for the word "unique" — text drizzle throws away
when it rewrites the message to `Failed query: …`, leaving `code`/`constraint` only on `err.cause`.
The guard had never fired. `POST /kitchens` had none at all. This is the same lesson as the
`sns-validator` episode: **the detector, not the guard, was broken**, and only a live duplicate
request exposed it. Both now answer 409, `PUT /kitchens/:id` (where `code` is editable) with them,
and `food-config-duplicates.test.ts` reproduces the 500 against the old code before asserting the
409 — verified by reverting the fix and watching the test fail.

---

## Verification run — every check, with its actual result

| # | Check | Result |
|---|-------|--------|
| 1 | `pnpm run typecheck` (5 projects) | ✅ **clean.** Zero `@ts-ignore` / `@ts-nocheck` anywhere. See the suppression note below — the only `@ts-expect-error` are negative type assertions. |
| 2 | `pnpm --filter @workspace/api-server run test` | ✅ **340 passed / 15 files** (baseline 279 / 12; +61 across 3 new files). No test deleted or skipped. |
| 3 | `pnpm --filter @workspace/uniliv-admin run test` | ✅ **28 passed / 2 files** (baseline 14 / 1; `wallet-direction.test.ts` added). |
| 4 | Build + boot from `dist/`, log in, hit every food endpoint + all export formats | ✅ **zero 500s, zero error-level log lines.** Details below. |
| 5 | Dynamic imports left in `dist/index.mjs` | ✅ **5, all allowlisted**; `Bundle verification passed — the image needs no node_modules`. |
| 6 | `pnpm --filter @workspace/db run push` ×2 | ✅ **both `No changes detected`** — and again ×2 after the seeds ran. |
| 7 | Four deploy scripts ×2 | ✅ **all exit 0, second run mutates nothing.** Perturbation tests below. |
| 8 | `seed:food` ×2 → `seed:food-extra` ×2 → resolve a menu | ✅ **both idempotent**; 3080 per-kitchen rows; **ORDERABLE 5/5 properties**; menu resolves 6 / 9 / 3 / 8 dishes. |
| 9 | Frontend production build | ✅ **exit 0**, 4217 modules, `dist/public` emitted. Warnings only (chunk >500 kB, sourcemap noise) — pre-existing. |
| 10 | The 17 audit files untouched | ✅ **all 17 mtimes predate the round.** Only 10 files were written, none of them audit files. |

**On TS suppressions, stated precisely.** There are zero `@ts-ignore` and zero `@ts-nocheck`. There
are six `@ts-expect-error` directives, all in `wallet-service.test.ts`, and they are the *inverse* of
a suppression: they assert the compiler **rejects** `const x: CreditTxnType = "REFUND_WITHDRAWAL"`.
Widen `CreditTxnType` and the directive becomes unused, which **fails** `pnpm run typecheck`. On
`as any`: 20 remain in the food-owned server files, **net zero added or removed by any uncommitted
work** (verified against `2b4c40f`); 18 are the `[] as any[]` drizzle condition-array idiom and one
is a dynamic-import shape cast in `verifySns`.

### 4 — API smoke test (built bundle, `RUN_SCHEDULERS=false`, free port)

Login is two-step: `POST /api/auth/login` returns a **random per-challenge `devOtp`** (observed
`840339`, then `379907` — it is not `000000`), redeemed at `POST /api/auth/verify-otp` with the
field name **`code`**, which returns an **`accessToken` in the body** (the `Set-Cookie` is only the
refresh token — the cookie jar alone gets you a 401). Authenticate with `Authorization: Bearer`.

| Endpoint | Status |
|---|---|
| `/api/healthz` | 200 |
| `/api/food/dashboard` | 200 |
| `/api/food/orders` | 200 |
| `/api/food/kitchen-summary` | 200 |
| `/api/food/analytics` | 200 |
| `/api/food/hierarchy` | 200 |
| `/api/food/zones` · `/clusters` · `/cities` | 200 |
| `/api/food/reports/variance` | 200 |
| `/api/food/waste-analytics` · `/home-analytics` | 200 |
| `/api/food/my-properties` · `/next-orders` · `/dispatches` | 200 |

Export formats, every one of them:

| URL | Status |
|---|---|
| `/reports/export.csv` · `.pdf` · `.xls` · extensionless — `report=variance` | 200 (`text/csv`, `application/pdf`, `application/vnd.ms-excel`, `text/csv`) |
| `/reports/export.json` · `.exe` · `.tar` | **400** `fmt must be csv, pdf or xls` |
| `/reports/export.csv?report=consumption` | **400** `report must be one of orders, variance, waste, ontime` |
| `/waste-analytics/export.csv` | 200 |
| `/waste-analytics/export.zip` | **400** `fmt must be csv, xlsx or pdf` |

Zero `level:50`/`level:60` lines in the server log across the whole run — including the two
duplicate-code requests, which now return 409 without logging a server fault.

**Response field names match the web types exactly**, checked key-by-key against the shapes declared
in `food-api.ts`: `/analytics` and `/home-analytics` carry `wastePctOfOrdered`, `/waste-analytics`
carries `wastePctOfReceived` + `receivedQty`, `/home-analytics` carries `totalOrderedDelivered`, and
**no surface still emits a bare `wastePct`** (the deprecated aliases were removed once the web app
read the explicit fields).

**The variance CSV is genuinely the variance dataset** (H2's shadowing is gone). Line 1 is a title
banner, so the column header is line 4:

```
Ordered vs Delivered Variance
Exported: 07/08/2026 04:22

Meal,Unit,Ordered,Received,Variance,Wasted,Unconfirmed
LUNCH,LITRE,50.4,46.368,4.032,4.032,0
LUNCH,PCS,540,496.8,43.2,43.2,0
LUNCH,KG,106.2,97.704,8.496,8.496,0
```

All four report types return distinct datasets — `variance` → *Ordered vs Delivered Variance*,
`orders` → *Food Orders Report*, `waste` → *Top Waste Items*, and an invalid `report=consumption`
returns **400** with the valid list (not a 500 — L6's fix working).

Two previously-open findings closed themselves visibly here: the per-unit grouping in the variance
rows (M7), and the orders export's Quantity column, now `19.8 KG + 8.1 LITRE + 135 PCS` rather than
a meaningless cross-unit scalar (open item 24 in the previous revision).

**New this round — duplicate master-data codes.** `POST /food/brands` and `POST /food/kitchens` with
an existing `code` returned **500 Internal server error** against the committed build. Both now
return **409** (`Brand code already exists` / `Kitchen code already exists`), as does
`PUT /kitchens/:id`, where `code` is editable. Creating a genuinely new brand still returns 201, and
a non-23505 failure still returns a logged 500. Zones, cities and clusters have **no** unique on
`code`, so they are not siblings on this invariant.

### 5 — Dynamic imports remaining in the bundle

Exactly **three**, all on `build.mjs`'s reviewed `OPTIONAL_RUNTIME_IMPORTS` list:
`bullmq`, `ioredis` (`notify-core/queue.ts`) and `web-push` (`lib/web-push.ts`). Plus two
third-party lazy probes esbuild cannot inline (`pg-native`, `supports-color`), both already wrapped
in their libraries' own try/catch.

I verified the allowlist's *safety claim* rather than accepting it: all four callers of
`enqueueDelivery` — `notification-service.ts:95`, `wallet.ts:78`, `residents.ts:62` and the sweep at
`process.ts:195` — wrap it in try/catch and fall back to inline delivery, so a missing `bullmq` in
the slim image degrades rather than dropping notifications. `pushToUser` likewise catches.

`sns-validator` and `@aws-sdk/client-sesv2` are now **bundled** (`signableKeysForSubscription` ×2,
`SESv2ServiceException` ×12 in `dist/index.mjs`), as is `nodemailer`.

### 7 — Deploy scripts: idempotency **and** the failure they exist to catch

Running a script that finds nothing to do proves only that it runs. Each was therefore also
exercised against the state it was written for, and the state restored afterwards:

| Script | Idempotency | Exercised failure path | Restored |
|---|---|---|---|
| `backfill:payment-property` | 2 runs, exit 0, no writes | Dropped `payments.property_id`; script re-added and filled all 50 rows; `push` then only did `SET NOT NULL` | ✅ 50/50 values identical to snapshot; `is_nullable = NO` |
| `backfill:user-scopes` | 2 runs, exit 0, dry-run | Revoked `clustermgr@uniliv.com`'s only grant → **exit 1**, "all 1 grant(s) revoked — NOT re-granted" | ✅ 22 scopes / 22 active, exit 0 |
| `dedupe:food` | 2 runs, exit 0, report-only | 18 checks all clean — **including** the two previously missing (`payments razorpay payment id`, `food_additional_order_items (request, dish)`) | n/a |
| `migrate:wallet-namespace` | 2 runs, exit 0, dry-run | Inserted synthetic `pay_…` + `plink_…` rows in the legacy `RAZORPAY` namespace; `--apply` moved them to `RAZORPAY_PAYMENT` / `RAZORPAY_LINK`; second `--apply` was a no-op | ✅ 125 txns, 0 in all three namespaces |

One incidental finding worth keeping: while a scratch table (`_verify_payments_backup`) existed in
`public`, `push` raised a data-loss banner offering to drop it. That is the runbook's abort rule
working exactly as documented — and a reminder that **any** unmanaged table in `public` will trip it.

Re-run this round on the committed build: all four exit 0 twice, second run a no-op
(`nothing to backfill` · `every scope-dependent account resolves` · 18 checks clean ·
`nothing to migrate`). `push` was then run twice **more** after the seeds — still `No changes
detected`, so the round did not disturb the convergence the branch fought for.

### 8 — Seed pair

`seed:food` alone leaves `food_menu_rotation.kitchen_id` NULL on all 385 rows (brand-level
templates), and `resolveMenu` requires an exact non-null kitchen match — so `seed:food` alone
**cannot** serve an order. `seed:food-extra` materialises **3080 per-kitchen rows**, after which:

```
GET /api/food/menu-rotation/resolve?propertyId=…&mealType=LUNCH&date=2026-08-07
→ 9 dishes: Mix Vegetable (SABZI/KG), Dal Tadka (DAL/LITRE), …
BREAKFAST → 6 · LUNCH → 9 · SNACKS → 3 · DINNER → 8
```

This is the documented two-step pair, not a bug — **and `seed:food` now says so itself**. It ends
with an orderability report that names the state it leaves behind and the command that fixes it:

```
⚠  NOT ORDERABLE — no property resolves a menu for 2026-08-07 (IST). …
     menu rows:  385 brand-level templates (kitchen_id IS NULL, served to nobody)
                 0 per-kitchen rows (the only kind resolveMenu matches)
   This is the EXPECTED half-way state — it is not a bug in resolveMenu.
   NEXT COMMAND — run this now, the environment is not usable until you do:
     pnpm --filter @workspace/scripts run seed:food-extra
```

`seed:food-extra` then reports `✅ ORDERABLE — 5 of 5 properties resolve a menu`. Both seeds were run
**twice**: exit 0 each time, and the second `seed:food-extra` is a clean no-op (`0 new, 0 restored,
6 kept, 0 revoked`; `no unassigned dispatched orders`). This closes follow-up 8 — the false CRITICAL
it caused a reviewer last round can no longer happen.

---

## Findings table — final status

**Counts: 52 FIXED · 0 PARTIAL · 0 NOT_FIXED** (of 52) — L12, the last PARTIAL, closed this round.
All 6 regressions introduced by earlier fix rounds (B0–B5) are closed; B6 remains a recorded product
decision.

| # | Finding | Status | Note |
|---|---------|--------|------|
| C1 | Razorpay webhook credits the same money twice | **FIXED** | Link cap persisted and clamped; dues no longer keyed on `linkId`; legacy `RAZORPAY` namespace migrated by script. Now covered by 29 tests in `webhook-idempotency.test.ts` (instalments, legacy links, unattributable money). |
| C2 | Reversing a checkout refund debits the wallet twice | **FIXED** | `WALLET_TXN_DIRECTION`; `CreditTxnType` makes the original mistake a compile error; frontend derives sign from the row delta. **Now directly covered on both sides:** `wallet-service.test.ts` (API) and `wallet-direction.test.ts` (web), each asserting the map is *total* over the transaction-type enum — mechanically, not against a copied list — so a new type fails the test instead of silently defaulting. |
| C3 | Dispatch marks orders DELIVERED with no receivedQty | **FIXED** | `canConfirmDelivery` + `mayCertify`; matrix keeps `FOOD_DISPATCH` and `FOOD_CONFIRM_DELIVERY` apart. The `Unconfirmed` column in the variance export is this rule surfacing. |
| C4 | ZONE/CLUSTER unresolvable; revoke grants org-wide access | **FIXED** | Resolver handles all five levels, honours soft revoke. The deploy consequence is B4, now closed. |
| C5 | Any FOOD_SETTINGS holder can re-point a property | **FIXED** | `assign-cluster` now checks the property (`isAccessible`), that the destination cluster is live (`scopeTargetIsLive`), **and** that a scoped caller may reach it (`deniedClusterScope`). |
| C6 | kitchen.ts: 19 endpoints, zero scoping | **FIXED** | 14 property-bound handlers scoped, 5 recipe-master routes legitimately unscoped, `scopePropertyCondition` fails closed. |
| H1 | No uniqueness on (property, meal, serviceDate) | **FIXED** | Partial unique index live; both insert paths map 23505 → 409. |
| H2 | Export shadowing downloads the ORDERS dataset | **FIXED** | **Re-proved at runtime this round** — four report types, four distinct headers. |
| H3 | Notification pipeline drops everything by default | **FIXED** | (a) fail-closed selector; (b) all producers catch → inline; (c) **SES, SMTP and sns-validator all bundled** — the last one this round; (d) bounded retry, never terminal in-request. |
| H4 | Config writes bypass the kitchen-scope guard | **FIXED** | 9 of 9. `PUT /meal-config/:mealType` now carries `deniedGlobalConfig` — plus a `MEAL_TYPES` membership check so an unknown meal 404s instead of 500ing. |
| H5 | `user_scopes` hard delete + no uniqueness | **FIXED** | Soft revoke via `isActive`; six paired partial unique indexes. |
| H6 | Batch order: client controls cook quantity and unit | **FIXED** | Quantity derived server-side, bounded by tolerance; unit never from the body. |
| H7 | Confirm-delivery unsubmittable when over-prepared | **FIXED** | Ceiling `max(orderedQty, preparedQty)`; shortfall still vs orderedQty. |
| H8 | PII readable by any authenticated user | **FIXED** | Four inline-gated routes; `mayReadKitchenContacts` / `mayReadPartnerContacts` at every row response. |
| H9 | resolveMenu picks day-of-week with host-local getters | **FIXED** | `istCalendarDayUtc` / `isoDayOfWeek`; no `getDay()`/`setHours()` on the menu path. |
| H10 | Soft-deleting a dish keeps it on the menu forever | **FIXED** | `activeDish` on the week probe, the row fetch, autofill and order-preview. |
| H11 | Unbounded exports, synchronous PDF rendering | **FIXED** | Caps on `/reports/export.*`; `toPdf` yields per page; `guestExportRows` now carries the same cap and 422. |
| H12 | generate-indent mints ₹0 indents without INDENTS | **FIXED** | Two chained `authorize()`; item shape matches procurement's reader. |
| M1 | Lifecycle transitions are SELECT-then-blind-UPDATE | **FIXED** | All 12 `update(foodOrdersTable)` sites transactional with a status predicate or `FOR UPDATE`. |
| M2 | Trip/order state drift, no reconciler, stuck vehicles | **FIXED** | Reconciler correct **and now integrated** — see B2. |
| M3 | createDispatchForOrders: no row lock, busy check outside txn | **FIXED** | Both named defects fixed; `departNow` now conditional on a status read under lock (the sibling previously missed). |
| M4 | Non-transactional multi-statement writes | **FIXED** | POST/PUT orders, kitchen-items, bulk dispatch all transactional. |
| M5 | Post-dispatch edits manufacture variance | **FIXED** | Count edits refused unless PLACED; cut-off re-checked. |
| M6 | Reports include CANCELLED and REJECTED | **FIXED** | 6 of 6 — `/food/dashboard` (`food.ts:435,465`) now excludes both. |
| M7 | Quantity totals sum incompatible units | **FIXED** | Every aggregate groups by unit; **orders export verified per-unit at runtime**. |
| M8 | Date windows time-of-day dependent | **FIXED** | Both export scopes route through `periodRange` (B5); bucketing uniform. |
| M9 | GET /food/revenue returns 5 months on the 29th–31st | **FIXED** | `istMonthStartYmd`, pure UTC calendar math. |
| M10 | Collections attributed via the resident's CURRENT property | **FIXED** | 8 of 8 writers; `finance.ts` bank-line confirm now 404s on an unknown resident instead of inserting NULL. |
| M11 | `total_quantity` holds two different things | **FIXED** | All writers store the item ordered-qty sum. |
| M12 | Removing a portion rule silently drops the dish | **FIXED** | DELETE and PUT guarded; client confirms drops. |
| M13 | Config tables have no uniqueness | **FIXED** | Seven unique indexes live; PUTs map 23505 → 409. |
| M14 | Boards silently truncate at 100 orders | **FIXED** | `listAllOrders` pages with `truncated` derived from a **short page**, not `length >= total` — the correct end-of-set signal over a live table. |
| M15 | Menu Planning blank for its own persona | **FIXED** | `authorizeAny(["PROPERTIES","MENU_PLANNING"],"view")`, handler still narrows. |
| M16 | Config pages render write controls to view-only principals | **FIXED** | All four pages, plus the slot-level controls inside both plate editors (`plate-composer.tsx:145,269,295`, `menu-rules.tsx:62,183,233`). `food-kitchen-summary.tsx` now derives `canAccept` (`:72`) separately from `canReadOrders` (`:65`). |
| M17 | No food mutation writes to `audit_log` | **FIXED** | Was the one NOT_FIXED. Now **70 audit call sites** across the two food routers (`food.ts` 47, `food-ops.ts` 23), several capturing a `before` row so the entry says what changed. |
| M18 | Additional food unaudited, un-idempotent, invisible | **FIXED** | `requestId` + unique index + `onConflictDoNothing` in one transaction. |
| M19 | Trip delivery never notifies the unit lead | **FIXED** | All three DELIVERED writers notify. |
| M20 | DELIVERED notification instructs users into a 422 | **FIXED** | Server inverted; UI counts down; 13 tests pin both directions. |
| M21 | POST /menu/share reports an undeliverable recipient count | **FIXED** | Three separate counts derived from per-user results; phone leak removed. |
| M22 | Trip-level check treated as a licence over every stop | **FIXED** | 5 of 5 — `POST /dispatches/:id/cancel` filters per order and reports `ordersOutOfScope`. |
| L1 | Zero indexes on the three hottest tables | **FIXED** | Plus `wallet_transactions_wallet_id_notes_idx`, confirmed live, serving both the history endpoint and the webhook's per-link SUM. |
| L2 | GET /next-orders fan-out | **FIXED** | Batched cut-off resolution. |
| L3 | Cancelling a trip strands delivered orders | **FIXED** | Conditional rollback; delivered orders kept as history. |
| L4 | Waste rewritable forever, uninformative audit note | **FIXED** | Hard deadline; note built from actual per-item changes under lock. |
| L5 | PREPARING is dead schema | **FIXED** | `preparing_at` dropped (confirmed absent live); `drop:dead-columns` makes it a documented deploy step rather than a data-loss prompt. |
| L6 | Enum-typed params validated as free strings | **FIXED** | `invalidEnumParam` across food routes; `notifications.ts` now has `invalidChannel` returning 400 with the valid list; `meal-config` membership-checks its path param. |
| L7 | Unescaped LIKE metacharacters | **FIXED** | `escapeLike` in both routers, including the guests search (`food-ops.ts:4774`). |
| L8 | cutoffTime/serviceTime unvalidated | **FIXED** | `zClockTime` at all four sites. |
| L9 | Cut-offs empty state states the opposite of behaviour | **FIXED** | Names the org default, rendered unconditionally. |
| L10 | Service Times uses the hardcoded two-brand constant | **FIXED** | `BRANDS` constant deleted; all boards read live brands. |
| L11 | Rotation-cycle phase jumps at the year boundary | **FIXED** | `istWeekIndex` + anchored phase. |
| L12 | Assorted validation and consistency gaps | **FIXED** | `roundMoney` applied everywhere including `wallet.ts:757,772`. The residual is closed: every money column now uses `MONEY_NUMERIC = { precision: 12, scale: 2 }` (`schema/wallet.ts:20`), so the 2-decimal invariant is enforced by the database, not only by application code. `push` converges on it. |

### Regressions introduced by earlier fix rounds

| # | Regression | Status |
|---|---|---|
| B0 | `payments.property_id NOT NULL` had no deploy path | **CLOSED** — proved end to end this round. |
| B1 | Trip-cancel no-ops the trip while reverting its orders | **CLOSED** — trip locked `for("update")`, update conditional on `locked.status`, `.returning()` zero-row branch acted on. |
| B2 | `PARTIAL` trip state not integrated | **CLOSED** — `PARTIAL: ["DELIVERED","IN_TRANSIT","CANCELLED"]`; `ACTIVE_TRIP_STATUSES` extracted and used at all three vehicle-busy sites. |
| B3 | Kitchen-scoped F&B manager cannot create any dish | **CLOSED, without removing a capability** — the portion requirement is now conditional (`orgWideConfig && filledMeals.length === 0`), with a `portionPending` affordance for the kitchen-scoped case. The seed persona is also KITCHEN-scoped now, so local walkthroughs exercise the real path. |
| B4 | Fail-closed scoping with no backfill | **CLOSED** — script exists, fails closed, and `KITCHEN_MANAGER` is in `FOOD_USER_ROLES` so the grant is visible and repairable. |
| B5 | Exports drop the first IST day of every range | **CLOSED** — both export scopes use `periodRange`. |
| B6 | Export narrowed to `SUPER_ADMIN` / `OPS_EXCELLENCE` | **Open product decision, not a defect.** FNB_MANAGER and CITY_HEAD lost report export. Server and client agree, so nothing appears broken — but no product sign-off is recorded. Decide it before or shortly after merge. |

---

## Deploy sequence

`DEPLOYMENT.md` §"Upgrading an existing database" is authoritative and was re-read against the
scripts this round. Summary:

1. `dedupe:food` → then `-- --yes`
2. `backfill:payment-property` (adds the column itself; `push` cannot)
3. `backfill:user-scopes` → then `-- --apply`
4. `migrate:wallet-namespace` → then `-- --apply` — **must precede the new API image**; skipping it
   double-credits real money on any Razorpay redelivery
5. `drop:dead-columns` → then `-- --yes` (removes `food_orders.preparing_at`, the one expected
   data-loss prompt)
6. `pnpm --filter @workspace/db run push` — **must print no data-loss banner. Any banner = abort.**
7. `docker compose up -d`

Never `push-force` on a populated database. Every script is idempotent, dry-run by default, and
exits non-zero while work remains, so a pipeline stops rather than shipping a lockout.

New this round: `docker/Dockerfile` sets `API_BUNDLE_VERIFY=strict` in the api build stage, and
DEPLOYMENT.md §3 documents `API_BUNDLE_VERIFY=strict pnpm --filter @workspace/api-server run build`
as the equivalent pre-deploy assertion outside Docker.

**Corrected in the follow-up round:** DEPLOYMENT.md §"(Optional) seed reference + demo data" ran the
three seeds without `-- --yes`. Inside `docker compose run --rm tools` with `.env.docker`,
`NODE_ENV=production`, so `assertSeedTarget` refuses and **the documented deploy stopped**. The
commands now carry `-- --yes`, with a sentence explaining that seeds refuse a non-development target
unless the operator says so — seeding production should be an act someone performed, not one that
happened. (The unix-socket DSN is correctly classified as *local*; `NODE_ENV` is what trips the
guard.) The seed ordering is now documented there as a hard prerequisite too, and `seed-demo.ts`'s
header records that it aborts on a fresh DB with an FK error on `kitchen_pincodes` until the food
seeds have run.

---

## Before you merge — checklist

Everything previously listed as blocking is done. What remains is process, not code:

- [x] **Split the commit by path.** Done for the food work: `2b4c40f` carries 85 files and **no**
      audit file. The 17 audit files remain uncommitted and untouched by subsequent rounds (their
      mtimes were re-checked at the end of the follow-up round). Keep them out of the next commit
      too — the follow-up round's own changes are still uncommitted alongside them.
- [ ] **Record the B6 product decision** next to `permissions.ts` — report export is now
      SUPER_ADMIN / OPS_EXCELLENCE only.
- [ ] **Run the deploy sequence against a restored production snapshot**, not just the dev DB. Every
      script was proved idempotent and fail-closed here, but this database has 50 payments and 22
      scopes; production has neither the volume nor the messiness.
- [ ] Manual walkthroughs still not automated: a KITCHEN-scoped FNB_MANAGER through Food Settings →
      Dishes → New dish (B3's real path), and a dispatch trip taken to PARTIAL and then cancelled
      (B1+B2 together). Both are correct in code; neither has an end-to-end test.

---

## Still open (follow-up scope)

**One item, and it is not this commit's.**

1. `scopeCrumbs` (`nav.ts:48`) is dead code — and it ships with the **AUDIT** commit, not this one.
   `nav.ts` is one of the 17 deliberately-uncommitted audit files, so it was explicitly out of scope
   for the follow-up round and remains untouched. Flagged for whoever commits the audit work.

### Closed in the follow-up round

The other ten items are done. Recorded here rather than deleted, because several were closed in a
way worth knowing about:

| Was | Item | How it closed |
|---|---|---|
| 1 | `verifySns`'s bare `catch` conflates forgery with a broken deployment | `verifySns` now returns a discriminated result (`INFRASTRUCTURE` vs `REJECTED`, with the error) and the caller logs `err` / `kind` / `reason` / `messageId` / `topicArn` while still returning a bare 403 to the caller. Covered by `ses-webhook-verification.test.ts`, which reads the captured log — a black-box status assertion could not have told the two apart, which was the whole point. |
| 2 | Two different `wastePct` denominators, one label | Split into `wastePctOfReceived` (kitchen efficiency, `/waste-analytics`) and `wastePctOfOrdered` (demand forecasting, `/analytics`, `/home-analytics`), with the invariant documented on both sides. The web types, all three pages and the `Food waste %` card now name their denominator; the deprecated `wastePct` aliases are deleted from the server. `/home-analytics` also ships `totalOrderedDelivered` — the percentage's real denominator — and `/waste-analytics` ships `receivedQty`, so both ratios are reproducible from the payload. |
| 3 | `POST /orders` 500s on a nameless 23505 | **Was stale.** Verified live: the duplicate POST returns 409 in the same `{success,error}` shape as its batch sibling, and the nameless-23505 branch (`violatedConstraint` + `liveOrderExists`) shipped in `2b4c40f` itself at `food.ts:850-858`. Replaced by the master-data `code` defect described above, which was real. |
| 4 | Money columns had no precision/scale | `MONEY_NUMERIC = { precision: 12, scale: 2 }` on every wallet money column. L12 is now FIXED rather than PARTIAL. |
| 5 | No unit test for `wallet-service.ts` | `wallet-service.test.ts` (API) and `wallet-direction.test.ts` (web). Both assert the direction map is **total over the transaction-type enum** mechanically — the API side against the pg enum, the web side against the generated `WalletTransactionDtoType` — so a new type fails a test instead of silently defaulting to DEBIT. The web map is typed `Record<string, …>`, so the compiler could never have caught it. Precedence is pinned too: balance delta beats the type map, `REFUND_WITHDRAWAL` is a DEBIT, `REVERSAL` falls back to DEBIT without balances. |
| 6 | Zones / clusters had no UI | `food-organization.tsx` now has a **Zones & Clusters** tab wired to `createZone` / `updateCluster` / etc., plus a spine view that surfaces orphans ("Clusters pointing at a missing city"). The org spine no longer requires a script. |
| 7 | The `unconfirmed` split shipped only in the export | `food-reports.tsx` calls `foodApi.reportsVariance` and renders it: an `Unconfirmed` column, a per-unit breakdown, and a callout naming how many delivered orders were never counted. The C3 signal is visible in the product. |
| 8 | `seed:food` leaves the module unorderable and does not say so | Both seeds end with an ORDERABLE / NOT ORDERABLE report; `seed:food`'s names `seed:food-extra` as the next command. Quoted in §8 above. |
| 9 | Seeds hard-DELETE `user_scopes` | Closed, and **wider than recorded**: there were four hard-DELETE sites (`seed-kitchen-managers.ts`, `seed-food.ts` ×2, `seed-food-extra.ts`), not two, plus a fifth related site — `reanchorGeoScopes`' in-place UPDATE, which became a 23505 abort once revocation went soft. The deferred `assertScopesResolve` `is_active` gap is closed too, and was demonstrated to be a real false-pass rather than a theoretical one. |
| 11 | `/reports/export.:fmt` shadowed by four explicit registrations | Collapsed: there are now exactly **two** registrations — the extensionless default-CSV route and `/reports/export.:fmt` — behind one handler. Proved at runtime: `.json`, `.exe` and `.tar` all reach the param route and return 400 with the valid list. |

### Residual notes (not defects)

- **Four constraint helpers now exist** — `isUniqueViolation` in `wallet-service.ts` (exported),
  `food.ts` (local) and `food-ops.ts` (local, with a `...names` parameter), plus `violatesCheck` in
  `food.ts`. They differ **intentionally**: `food-ops` treats a nameless 23505 as a match, `food.ts`
  must not, or its order-number-vs-duplicate-order distinction breaks. Unifying them is a judgement
  call, not a bug; a shared version would need the name-list parameter *and* a documented answer for
  the nameless case.
- `food.ts:878` still ORs a message-based `includes("unique")` test alongside `isUniqueViolation`.
  Harmless — the working check runs first — but it is dead weight of exactly the kind that produced
  the 500 fixed this round. Delete it when that line is next touched.
- **B6 is still an unrecorded product decision** (see the checklist above), not a defect.

---

## Notes for the next reader

Three things about this verification worth carrying forward:

- **A script that finds nothing to do has not been tested.** Every one of the four deploy scripts
  passed its first run trivially. Only after reproducing the state each was written for — dropping
  the column, revoking the grant, inserting legacy-namespace rows — did they demonstrate anything.
  All perturbations were restored and the restoration verified against a snapshot.
- **Black-box tests cannot see through a bare `catch`.** The `sns-validator` fix could not be proved
  by calling the webhook, because the broken and fixed builds return the same 403. It was proved by
  bundle contents plus booting from a directory with no `node_modules` above it. That is now fixed at
  the source — `verifySns` classifies and logs — so the next person does not need the trick.
- **`push` convergence is a usable drift signal now, and it is load-bearing.** Four consecutive
  `No changes detected` runs across the follow-up round, including two after the seeds rewrote data.
  But any unmanaged table in `public` will trip the data-loss banner — as my own scratch table did.
- **A guard that was never exercised is indistinguishable from no guard.** The duplicate-`code` 500
  found this round sat behind a `catch` block that *looked* correct: it tested the error message for
  the word "unique". Nobody had ever POSTed a duplicate. The message-based test could not fire
  because drizzle rewrites the message and moves `code`/`constraint` onto `err.cause` — a fact
  already written down in a comment **twelve lines above the working helper in the same file**.
  Reading the code would not have caught this; sending the request did. The new test therefore
  reproduces the failure before asserting the fix, and it was verified by reverting the fix and
  watching it fail with `expected 500 to be 409`. **A regression test that has never been seen red
  has not been shown to test anything.**
