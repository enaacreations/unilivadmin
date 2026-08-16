# Food Module — End-to-End Analysis

**Date:** 2026-08-06 · **Branch:** `dev` · **Repo:** `/Users/sumit/Projects/unilivadmin`

Scope: `apps/api-server/src/routes/food.ts` (3,422 L, 87 routes), `food-ops.ts` (3,317 L, 63 routes), `kitchen.ts` (375 L, 19 routes), `wallet.ts`, `webhooks.ts`, `lib/food-service.ts` (819 L), `lib/db/src/schema/food.ts` (903 L), the notification pipeline (`lib/notify-core/*`, `apps/notify-service`), and the 17 food pages in `apps/uniliv-admin/src`.

130 raw findings survived adversarial verification across ten review dimensions plus a targeted gap round. This document consolidates them into 54 distinct defects, re-ranked by real-world risk. Every claim carries `file:line`. The twelve highest-risk findings were personally re-opened and re-read before publication.

---

## Executive summary

The food module is a large, actively-developed subsystem that works for the happy path and has clearly had targeted security attention (commit `ae42b5a` closed the kitchen-scope hole on menu rotation; `resolveAccessiblePropertyIds` is a real, deliberate multi-tenancy control with a thoughtful doc comment at `food-service.ts:112-129`). The problems are not carelessness — they are the residue of a fast-moving module where a control was added in one place and not propagated to its siblings, and where a schema comment describes an invariant no constraint enforces.

Six defects are severe enough to block a confident ship.

**Money.** The Razorpay webhook (`apps/api-server/src/routes/webhooks.ts:196-197`) derives its idempotency key as `refId: pl?.id || pay?.id` and routes **both** `payment_link.paid` and `payment.captured` through it (`:311`). Two event types produce two different ids for one collection, so the `referenceId` replay guard (`:213-216`) cannot dedupe them and the wallet is credited twice. With `acceptPartial: true` on the top-up link (`wallet.ts:361`), a ₹5,000 payment in two instalments credits ₹10,000. Separately, `REFUND_WITHDRAWAL` is created exclusively by `debitWallet` (`wallet.ts:946`) but is listed in `isCreditType` on the reversal path (`wallet.ts:1165`), so reversing a checkout refund performs a *second* debit (`:1181`) — a ₹5,000 correction becomes a ₹10,000 swing against the resident, and the double-reversal guard (`:1155-1161`) then blocks the fix.

**Multi-tenancy.** `resolveAccessiblePropertyIds` (`food-service.ts:135-181`) resolves only `GLOBAL`, `CITY`, `KITCHEN` and `PROPERTY`. It never reads `zoneId` or `clusterId` — yet `POST /food/scopes` still mints both (`food.ts:3370-3375`) and `scripts/src/seed-food.ts` assigns exactly those levels to four personas (`:414, :420, :431, :439`). Because `scopes.length > 0`, the fall-open branch is skipped and the function returns `[]` → `sql\`false\`` → four seeded oversight roles see **nothing** across the entire module, silently, with 200-OK empty arrays. The mirror failure is worse: for the five `BROAD_FALLBACK` roles (`food-service.ts:123-129`), *deleting* a scope row restores org-wide access, so the permission model rewards removing restrictions. `POST /properties/:id/assign-kitchen` (`food-ops.ts:802-809`) is nine lines with **no** scope check on `:id` and **no** validation of the supplied `kitchenId` — an F&B manager can pull any property in the org under their own kitchen and immediately gain its orders, because scope is derived from `properties.kitchenId`.

**Separation of duties.** The matrix deliberately gives FNB roles `FOOD_DISPATCH: VE` with `FOOD_CONFIRM_DELIVERY: VIEW` (`permissions.ts:151, 156, 169`). But `PATCH /dispatches/:id/status` (`food-ops.ts:1166`) writes `status: "DELIVERED"` on every linked order (`:1200`) under the dispatch gate alone — no `receivedQty`, no shortfall check, no auto-complaint. The kitchen certifies its own receipt, `confirm-delivery` then 422s permanently (`food.ts:1316`), and `/reports/variance` reads those orders as `received = 0` against full ordered (`food-ops.ts:2450`), i.e. a fabricated 100% shortfall.

**Unreviewed surface.** `apps/api-server/src/routes/kitchen.ts` — 19 endpoints across four routers mounted at `/recipes`, `/menu-plans`, `/daily-production`, `/kitchen-analytics` — contains **zero** occurrences of `scopedPropertyId`, `resolveAccessiblePropertyIds` or `isAccessible` (verified by grep, count 0). Every list omits the filter when no `propertyId` is supplied; every by-id write keys on the path id alone (`:158, :166, :193`); `POST /menu-plans/:id/generate-indent` mints procurement documents under `MENU_PLANNING:edit` for a role (`KITCHEN_MANAGER`) that holds no `INDENTS` grant at all (`permissions.ts:73`).

The remaining findings cluster into recognisable families: no DB uniqueness backing the schema's own comments, non-transactional multi-statement writes, silent 200-with-empty-result error handling, and reporting that mixes units, includes cancelled orders and drifts by a calendar day.

---

## Verdict: is it robustly stitched together?

**No — not yet ship-ready.** The seams between subsystems are where it fails, and it fails there consistently.

The module is robust *within* a component and fragile *between* components. Order placement works. The kitchen board works. The dispatch board works. What does not work is the contract between them: the dispatch path can terminate an order the receive path owns; the trip state machine and the order state machine drift apart with no reconciler; the reports read columns that two different write paths populate with two different meanings (`total_quantity` is a headcount from `food.ts:515` and a summed quantity from `food-ops.ts:1527`, and `PUT /orders/:id:1032` overwrites the latter with the former mid-lifecycle).

Three structural weaknesses explain most of the 54 findings:

1. **The schema documents invariants it does not enforce.** `lib/db/src/schema/food.ts:687` says "One row per property + meal + planned date"; the table declares no such constraint (`:690-755`, only `order_number` is unique). `:407-410` documents a per-property portion override that no API path can set. `:563-564` documents a global-vs-property meal-window precedence resolved by a non-transitive comparator over an unordered SELECT (`food-ops.ts:149`). Every one of these is enforced only by application code that is present on one write path and absent on its sibling.

2. **Controls are added per-endpoint, not per-invariant.** `deniedKitchen` guards all five menu-rotation writes (`food.ts:2268, 2393, 2459, 2619, 2646`) and none of the four sibling config surfaces that feed the same order pipeline. `residentsCapForProperty` is enforced on `POST /order-batches` (`food-ops.ts:1443`) and `PUT /orders/:id` (`food.ts:1018`) and absent on `POST /orders`. `dishesMissingPortionRule` runs on two of three rotation write paths.

3. **Failure is invisible by construction.** All 150 food handlers end in `catch (err) { req.log.error(err); res.status(500) }`, so the central `{statusCode, details}` convention in `app.ts:83-94` is unreachable from this module. The pino serializer strips the query string and never records the acting user (`app.ts:20-25`). Five of the six largest food pages contain zero `isError` references (verified: `food-orders`, `food-kitchen-summary`, `food-kitchen-home`, `food-dashboard`, `food-dispatch` all return 0), so a 403 or 500 renders identically to "quiet day". And in the default deployment the notification `logProvider` (`providers.ts:85-95`) returns success unconditionally with **no production gate**, so the outbox records `status: SENT` for messages that only ever reached `console.info`.

**Ship-readiness call:** fix the six critical findings and the four highest-risk high findings (roughly 3–5 engineer-days of focused work, most of it small and local) before exposing this to more properties. The module is not architecturally unsound — `resolveAccessiblePropertyIds`, `order-transitions.ts`, the transactional-outbox design and the `deniedKitchen` helper are all correct designs. They are just applied inconsistently.

---

## Architecture map

### Request path

```
client → nginx/proxy :80 → /api/* → apps/api-server (Express 5, esbuild → dist/index.mjs)
                                      └─ src/routes/index.ts
                                           :91  router.use("/food", foodRouter)      ← food.ts     (87 routes)
                                           :92  router.use("/food", foodOpsRouter)   ← food-ops.ts (63 routes)
                                           :63-66 /recipes /menu-plans /daily-production /kitchen-analytics ← kitchen.ts (19 routes)
```

**Mount-order consequence.** `foodRouter` is registered first, so any path defined in both files is served by `food.ts` and the `food-ops.ts` copy is dead code. There are exactly two such collisions, both real: `GET /reports/export.csv` (`food.ts:1695` shadows `food-ops.ts:2755`) and `GET /reports/export.pdf` (`food.ts:1697` shadows `food-ops.ts:2760`). The author was aware of the shadowing for the **auth guard** (comment at `food.ts:1691-1693`) but not for the **payload** — see Critical #6. `.xls` is registered only in `food-ops.ts:2765` and is therefore the only export format that reaches the report-aware pipeline.

### Middleware chain

Every protected route chains `authenticate` → `authorize(MODULE, perm)`. `authorize` (`middlewares/authorize.ts:4-17`) does nothing but `can(role, module, perm)` — it contains **no** property or tenant check. All multi-tenancy is per-handler, via `resolveAccessiblePropertyIds(req.user)` + `isAccessible(row.propertyId, ids)` or `scopeOrdersCondition(ids)`.

### Scope resolution (`lib/food-service.ts`)

```
ALWAYS_GLOBAL  (:104-110)  SUPER_ADMIN, OPS_EXCELLENCE, SENIOR_VICE_PRESIDENT, AUDIT_READONLY → null (= all)
BROAD_FALLBACK (:123-129)  ZONAL_HEAD, CITY_HEAD, CLUSTER_MANAGER, FNB_ZONAL_HEAD, FNB_SUPERVISOR
                           → null ONLY when scopes.length === 0 && !user.propertyId

resolveAccessiblePropertyIds (:135-181)
  GLOBAL   → null
  PROPERTY → ids.add(propertyId)                       (:152-155)
  CITY     → kitchens WHERE cityId IN (…) → properties WHERE kitchenId IN (…)   (:158-171)
  KITCHEN  → properties WHERE kitchenId IN (…)         (:151, :166-171)
  ZONE     → NOT HANDLED                               ← defect
  CLUSTER  → NOT HANDLED                               ← defect
  ids.size === 0 → [] → scopeOrdersCondition emits sql`false`  (:174-181, :185-189)

resolveAccessibleKitchenIds (:196-250)  — the twin, which DOES handle CLUSTER (:230-239)
```

The doc comment at `:196-199` states the invariant explicitly: *"the two must agree: the manager who sees a kitchen's orders is exactly the manager who may edit its menu."* For `CLUSTER` rows they do not.

### Data layer (`lib/db/src/schema/food.ts`, 32 tables)

Order spine: `food_order_batches` → `food_orders` → `food_order_items` / `food_order_events`; dispatch spine: `food_dispatches` → `food_dispatch_events`. Menu spine: `dishes` + `dish_side_options` → `food_menu_rotation` (keyed `kitchenId, brand, mealType, rotationWeek, dayOfWeek`) → `per_resident_rules` → `computeOrderItems`. Config: `food_meal_config`, `food_meal_windows`, `food_cutoffs`, `menu_composition_rules`. Access: `user_scopes` (`:193-205`).

Declared constraints on the three hottest tables: `food_orders` has `orderNumber UNIQUE` and nothing else (`:690-755` — no index callback); `food_order_items` and `food_order_events` declare **no index at all**, including none on their `order_id` FK. Sibling tables in the same file (`food_order_drafts:675`, `food_dispatch_events:814`, `agency_kitchens:492`, `food_menu_rotation:399-403`) do declare indexes, so this is an omission rather than a house style.

No migration files — `drizzle-kit push` only (per `CLAUDE.md`), which makes adding the missing constraints a one-step schema edit.

### Frontend

React 19 + Wouter + TanStack Query. `PageGuard` (`components/layout.tsx:591-598`) checks `can(mod, "view")` and nothing else; `PATH_TO_MODULE` in `lib/permissions.ts` maps routes to modules. All food calls go through the hand-written `lib/food-api.ts` (877 L) — `lib/api-spec/openapi.yaml` contains **zero** `/food` paths, so there is no generated-client drift to find, but also no schema contract.

### RBAC

`VE` is literally `FULL` (`apps/api-server/src/lib/permissions.ts:40: const VE = FULL`). I diffed all 12 `FOOD_*` modules × 21 roles between `apps/api-server/src/lib/permissions.ts` and `apps/uniliv-admin/src/lib/permissions.ts`: **the two matrices agree**. There is no backend/frontend drift. What does differ is enforcement depth — the backend enforces `edit`/`create`/`delete`; the frontend enforces only `view` via `PageGuard`.

---

## Critical findings

### C1 — Razorpay webhook credits the same money twice · CONFIRMED

**What.** `correlationFromEntity` reads both the payment-link entity and the payment entity and picks whichever id exists first: `refId: pl?.id || pay?.id`, with the amount taken as `amount_paid ?? amount ?? pay.amount` (`apps/api-server/src/routes/webhooks.ts:196-197`). The dispatcher routes **both** event types through it: `if (type === "payment_link.paid" || type === "payment.captured")` (`:311`). The only replay guard is that id — `eq(walletTransactionsTable.referenceId, refId)` (`:213-216`) for wallet top-ups, `eq(paymentsTable.reference, refId)` (`:242-245`) for dues.

**Why it matters.** A payment-link event carries `plink_xxx`; a payment event carries `pay_xxx`. They are different strings, so the two settlements cannot dedupe against each other. The file header at `:180-182` claims *"Idempotent: a top-up/dues settlement keyed off the Razorpay payment/link id is applied at most once"* — that guarantee holds only within one event type.

**Concrete failure.** The wallet top-up link is created with `acceptPartial: true` (`apps/api-server/src/routes/wallet.ts:361`). A resident pays ₹5,000 in two ₹2,500 instalments. Razorpay fires `payment.captured` twice (`pay_AAA`, `pay_BBB`, 250000 paise each) and `payment_link.paid` once (`plink_ZZZ`, `amount_paid` = 500000). Three distinct `refId`s → ₹2,500 + ₹2,500 + ₹5,000 = **₹10,000 credited for a ₹5,000 payment**. With both event types subscribed, even a single full payment credits twice. For `kind=RESIDENT_DUES` the same duality inserts two `SUCCESS` payment rows and re-runs the ledger auto-settle loop with a fresh `remaining`, marking further entries paid for money collected once.

**Reachability caveat.** Requires the Razorpay dashboard to subscribe to both events. Nothing in the repo, `.env` or `DEPLOYMENT.md` pins which events are subscribed — the only reference is the comment at `webhooks.ts:171-172`. That is precisely why this is dangerous: correctness depends on an unversioned dashboard setting.

**Fix.** Key idempotency on the Razorpay **payment** id only, namespaced: store `referenceType='RAZORPAY_PAYMENT'`, `referenceId=pay.id`, and derive the amount exclusively from `payment.entity.amount`. Handle exactly one event type. Add `UNIQUE (reference_type, reference_id)` on `wallet_transactions` so a duplicate credit fails at the DB rather than silently succeeding.

---

### C2 — Reversing a checkout refund debits the wallet a second time · CONFIRMED

**What.** `REFUND_WITHDRAWAL` rows are produced by exactly one call site, and it is the **debit** helper: `debitWallet(wallet.id, remainingBalance, "REFUND_WITHDRAWAL", …)` (`apps/api-server/src/routes/wallet.ts:942-946`), where `balanceAfter = balanceBefore - amount` (`lib/wallet-service.ts:131`). The reversal endpoint nevertheless classifies it as a credit: `const isCreditType = ["TOPUP", "ADJUSTMENT_CREDIT", "REFUND_WITHDRAWAL"].includes(original.type)` (`wallet.ts:1165`), and the credit branch hand-rolls another debit — `const balanceAfter = balanceBefore - originalAmount` (`:1181`) — deliberately bypassing `debitWallet`'s minimum-balance guard.

**Why it matters.** Direction is inferred from an enum value that is ambiguous by construction: `"REFUND_WITHDRAWAL"` appears in **both** `creditWallet`'s and `debitWallet`'s type unions (`lib/wallet-service.ts:62-66` and `:114-119`). The type alone cannot tell you the sign.

**Concrete failure.** Resident checks out with ₹5,000 remaining. `POST /wallet/residents/:id/checkout-refund` debits ₹5,000 (balance 5000 → 0) and staff are told to hand over cash. The cash is not handed over. Staff reverse the transaction — it is offered to them by name in the UI dropdown, which lists every non-`REVERSAL` transaction (`apps/uniliv-admin/src/pages/wallet-detail.tsx:404-406`, POSTed at `:135`). Expected: balance back to +₹5,000. Actual: **balance goes to −₹5,000**. The check at `wallet.ts:840` now blocks any future checkout ("Wallet balance is negative"), and the double-reversal guard (`:1155-1161`) returns 409 on a second corrective reversal. Error is 2× the refund; recovery requires a manual `ADJUSTMENT_CREDIT`.

The misclassification is replicated in the UI, so the resident's statement renders the debit in credit styling: `apps/uniliv-admin/src/pages/resident-detail.tsx:836` and `wallet-detail.tsx:41`.

**Fix.** Stop deriving direction from the enum. Add an explicit `direction` column (or split into `REFUND_WITHDRAWAL_DEBIT` / `REFUND_CREDIT`) and narrow the `creditWallet`/`debitWallet` unions so no type can appear in both. Minimal stopgap: remove `"REFUND_WITHDRAWAL"` from `wallet.ts:1165`.

---

### C3 — Dispatch marks orders DELIVERED with no receivedQty, defeating separation of duties and the shortfall control · CONFIRMED

**What.** Two dispatch-side paths terminate an order:

- `PATCH /dispatches/:id/status` (`apps/api-server/src/routes/food-ops.ts:1166`, gate `authorize("FOOD_DISPATCH","edit")`) — on target `DELIVERED` it loops every linked order and writes `status: "DELIVERED", deliveredAt, wasteEditableUntil, confirmedById: req.user!.id` (`:1195-1202`).
- `PATCH /dispatches/:id/orders/:orderId` (`:1222`, same gate) — same write at `:1245`.

Neither touches `food_order_items.receivedQty`; neither runs the shortfall/complaint logic. The canonical receive path `POST /orders/:id/confirm-delivery` (`food.ts:1307`) is gated `authorize("FOOD_CONFIRM_DELIVERY","edit")`, is the **only** writer of `receivedQty` (`:1357`), validates `0 ≤ receivedQty ≤ orderedQty` (`:1324-1327`), and is the only place the auto `TKT-` variance complaint is raised (`:1376-1405`).

The matrix splits these deliberately: `FNB_SUPERVISOR` (`permissions.ts:151`), `FNB_MANAGER` (`:156`) and `FNB_ZONAL_HEAD` (`:169`) each read `FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW`.

**Why it matters.** The party that cooks and ships the food certifies its own receipt. This is not API abuse — the dispatch board renders it as an ordinary "Mark delivered" button (`apps/uniliv-admin/src/pages/food-dispatch.tsx:1237`).

**Concrete failure.** An FNB_MANAGER finishes a 12-order trip and clicks Mark delivered. All 12 orders flip to `DELIVERED`, stamped `confirmedById` = the kitchen user, `receivedQty` NULL on every line. The unit lead who was to count the food is now locked out: `confirm-delivery` requires `status === "DISPATCHED"` (`food.ts:1316`) and returns 422 forever. No variance complaint is raised even if the van arrived short. `GET /reports/variance` then filters `eq(status, "DELIVERED")` (`food-ops.ts:2441`) and computes `received: coalesce(sum(receivedQty), 0)` (`:2450`) — those 12 orders report **ordered 480 kg, received 0, variance 480 kg**, a fabricated 100% shortfall against the kitchen. On a mixed day (some unit-lead-confirmed, some trip-delivered) the variance column is neither ordered-minus-received nor anything else meaningful. The waste cap also falls back to the wrong basis (`food.ts:1458`: `const cap = it.receivedQty == null ? Number(it.orderedQty) : …`).

**Compounding — the per-order toggle has no state machine.** `canTransition` is imported and used at `food-ops.ts:934, 1086, 1199` but **not** in the `:1222` handler; its only guard is `if (order.status === "CANCELLED" || order.status === "REJECTED")` (`:1237`). The `delivered:false` branch writes `status: "DISPATCHED", deliveredAt: null` (`:1249`) — a hop `ORDER_NEXT` forbids (`order-transitions.ts:16: DELIVERED: []`) — while leaving `wasteEditableUntil`, `confirmedById`, `deliveryRemarks` and every `receivedQty` in place. `confirm-delivery` then passes again and mints a **second** `TKT-` complaint for the same shortfall (`food.ts:1376-1405`, no idempotency). The loop is unbounded. The UI disables the checkbox once delivered (`food-dispatch.tsx:1264`), so the state machine is enforced client-side only.

**Fix.** (a) Require `FOOD_CONFIRM_DELIVERY:edit` for any code path that sets `food_orders.status = 'DELIVERED'` — either via an in-handler `can()` check or by making the trip transition move the trip only. (b) If kitchen-side delivery marking is genuinely intended, write `receivedQty = preparedQty ?? orderedQty` and run the same shortfall logic. (c) Gate both toggle branches on `canTransition`; drop the `delivered:false` revert or make it an audited compensating action that clears `wasteEditableUntil`/`confirmedById`/`receivedQty` and voids the complaint. (d) Exclude NULL-`receivedQty` orders from the variance denominator and report them as "unconfirmed".

---

### C4 — ZONE and CLUSTER scopes are unresolvable; four seeded personas see nothing, and revoking a scope grants org-wide access · CONFIRMED

This is one defect with six reinforcing facets. All were re-read directly.

**C4a — The resolver ignores two of five scope levels.** `resolveAccessiblePropertyIds` (`apps/api-server/src/lib/food-service.ts:135-181`) builds `cityIds` (`:151`), `kitchenIds` (`:152`) and PROPERTY rows (`:153-155`), then expands City → kitchens → properties (`:158-171`). `zoneId` and `clusterId` appear **nowhere** in the function. The schema documents the retirement (`lib/db/src/schema/food.ts:107-110`: *"ZONE/CLUSTER are retained for back-compat data but no longer used by the resolver/UI"*), but `POST /food/scopes` still advertises both — `geoIdByLevel = { ZONE: b.zoneId, CITY: …, CLUSTER: b.clusterId, … }` (`food.ts:3370-3375`) — validates the id is present (`:3378-3381`) and inserts with a 201 (`:3383-3394`). Nothing rejects the dead levels.

Because `scopes.length > 0`, the `BROAD_FALLBACK` escape at `:178` is skipped and the function returns `[]` (`:179`), which `scopeOrdersCondition` turns into `sql\`false\`` (`:187`) and `isAccessible` turns into a hard false.

**C4b — The seed re-issues the dead grants on every run.** `scripts/src/seed-food.ts` deletes and rebuilds scopes for its own users, then writes `scopeLevel: "ZONE"` for ZONAL_HEAD (`:414`) and FNB_ZONAL_HEAD (`:431`), and `scopeLevel: "CLUSTER"` for CLUSTER_MANAGER (`:420`) and FNB_SUPERVISOR (`:439`). None of the four has a home `propertyId`, so the `if (user.propertyId) ids.add(...)` rescue at `food-service.ts:148` never fires. Verified against the live dev DB: those four users now hold **CITY/KITCHEN** rows and the table contains **zero** ZONE and zero CLUSTER rows — someone has already hit this and hand-patched the data without fixing the seed. The next `pnpm seed:food` destroys the repair.

**C4c — The retirement is half-applied, so a "dead" grant still confers write authority.** `resolveAccessibleKitchenIds` **does** consume CLUSTER, with a comment acknowledging the split: *"// CLUSTER is retired in favour of CITY/KITCHEN but rows may still exist"* followed by a `kitchens WHERE clusterId IN (…)` lookup (`food-service.ts:230-239`). So for one and the same row, the kitchen resolver returns a non-empty set while the property resolver returns `[]`. `assertKitchenAccess` (`:272-284`) and `scopeRotationCondition` (`:287-291`) gate every menu-rotation write (`food.ts:2268, 2393, 2459, 2619-2620, 2646`). A CLUSTER-scoped `FNB_MANAGER` can therefore **rewrite the 4-week menu** for every kitchen in that cluster — driving what every served property orders — while being unable to see a single one of the resulting orders. The invariant the code itself states at `food-service.ts:196-199` is broken.

**C4d — Removing a restriction grants access.** For the five `BROAD_FALLBACK` roles (`:123-129`), `resolveAccessiblePropertyIds` returns `null` (= unrestricted) when `scopes.length === 0 && !user.propertyId` (`:178`). Adding a correct narrowing grant that happens to be ZONE/CLUSTER drops the user from org-wide to nothing; deleting it restores org-wide. `DELETE /food/scopes/:id` is a bare hard delete with no prior SELECT (`food.ts:3396-3401`), and `user_scopes` has no `isActive`/`revokedAt` and no unique constraint (`schema/food.ts:193-205`), so "never configured" and "deliberately revoked" are indistinguishable. The only two reachable states for these five roles are **everything** and **nothing**.

**C4e — Even the implemented CITY level resolves empty today.** Verified in the live dev DB: `cityhead@uniliv.com` holds `CITY / city_delhi`; the only kitchen with `city_id = city_delhi` is `kitchen_kit_del_cen`; **no property** points at it. `allKitchenIds` is non-empty but the `properties WHERE kitchenId IN (…)` lookup (`:167-171`) returns zero rows → `[]` → total lockout via a fully supported level. The chain is three hops through nullable, FK-less text columns; any gap zeroes the grant. `scripts/src/seed-food-extra.ts:116-131` never populates `kitchens.cityId` at all.

**C4f — Two divergent geo spines.** Access walks `properties.kitchenId` (`food-service.ts:158-171`); the analytics geo filter walks `properties.clusterId → clusters.cityId` and says so in a comment (`food-ops.ts:1932-1943`); `audit-access.ts:137-145` uses the cluster spine too. They already disagree in live data: property `UNILIV Whitefield` has `kitchen_id = kitchen_kit_blr_wf` (cluster `cluster_blr_whitefield`) but `cluster_id = cluster_blr_koramangala`. Because the scope condition and the `cityId` filter are ANDed (`food-ops.ts:1929, 1943, 1954`), that property silently drops out of any City-filtered waste chart the user *does* have access to.

**C4g — No UI can fix any of it.** The only scope-management screen filters to one role and one level: `const leads = users.filter((u) => u.role === "UNIT_LEAD")` (`apps/uniliv-admin/src/pages/food-organization.tsx:397`), `scopes.filter((s) => s.scopeLevel === "PROPERTY" && s.propertyId)` (`:406`), and the write hard-codes `createScope({ userId, scopeLevel: "PROPERTY", propertyId })` (`:415`). A repo-wide grep finds no other `createScope`/`deleteScope` call site. `GET /food-users` returns nine roles (`food.ts:93-96`) and the tab discards eight of them. A broken ZONE row is invisible in the one place an admin would look.

**Concrete failure.** An admin grants a new CLUSTER_MANAGER `scopeLevel: "CLUSTER"` for their cluster — the correct action. The API returns 201. The user logs in and every food screen is empty (200 OK, zero rows) and every write returns 403 "Property not accessible". Meanwhile `GET /food/lookups` (`food.ts:1711`, `authenticate` only, unscoped) and `GET /food/hierarchy` (`food-ops.ts:759`, no resolver call at all) still render the complete portfolio, so the account looks healthy. Support cannot distinguish this from "no orders today". Meals are not ordered; the failure is discovered at service time.

**Fix.** (1) Reject `ZONE`/`CLUSTER` at `POST /food/scopes`, **or** implement them mirroring `audit-access.ts:116-134`. Do not leave one half implemented — either add the CLUSTER expansion to the property resolver or delete `food-service.ts:230-239`. (2) Fix `seed-food.ts:414/420/431/439` to CITY/KITCHEN, and assert non-empty resolution at the end of the seed. (3) Make `DELETE /scopes/:id` a soft revoke, and drop the `BROAD_FALLBACK` fall-open so "no rows" and "rows resolving to nothing" both mean no access. (4) Validate at grant time: resolve the new scope immediately and 422 when it expands to zero properties. (5) Generalise `UnitLeadsTab` to every role and level. (6) Pick one geo spine (`properties.clusterId → clusters → cities` is the better one — it is already what audit and the report filters use).

---

### C5 — Any FOOD_SETTINGS holder can re-point any property in the org to their own kitchen · CONFIRMED

**What.** The entire handler, verified verbatim:

```ts
foodOpsRouter.post("/properties/:id/assign-kitchen", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  if (!validateBody(assignKitchenSchema, req, res)) return;
  const kitchenId = req.body?.kitchenId ? String(req.body.kitchenId) : null;
  await db.update(propertiesTable).set({ kitchenId, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
  res.json({ success: true });
});
```
`apps/api-server/src/routes/food-ops.ts:802-809`. `assign-brand` at `:791-798` is identical for `brand`.

No `resolveAccessiblePropertyIds`/`isAccessible` on `:id`. No `assertKitchenAccess` on the body `kitchenId`. No existence check on either. `properties.brand` and `properties.kitchenId` are plain nullable text with FK enforcement explicitly deferred to the app layer (`lib/db/src/schema/core.ts:171-176`), so a bogus or foreign id is accepted silently.

**Why it matters.** `FOOD_SETTINGS: VE` is held by `FNB_MANAGER` (`permissions.ts:160`), a role the codebase states is one login per kitchen and deliberately excludes from the broad fallback precisely because *"falling open would silently hand a single kitchen's manager the whole network"* (`food-service.ts:114-122`). And scope is **derived from** `properties.kitchenId` (`food-service.ts:158-171`) — so this endpoint lets a kitchen-bound role widen its own scope.

**Concrete failure.** An FNB_MANAGER for kitchen K1 in Pune enumerates property ids from `GET /food/lookups` (`food.ts:1711-1716` — `authenticate`-only, returns every property id, and it is the most-called food endpoint with 14 frontend call sites) and POSTs `/api/food/properties/<Bangalore-property-id>/assign-kitchen {"kitchenId":"K1"}`. On the **next request**, `resolveAccessiblePropertyIds` includes that property: its orders, kitchen summary and dispatch trips all become readable and writable. Nothing is logged beyond `updatedAt`. The denial-of-service variant is a single call away: `{"kitchenId": null}` (or an empty string, which the `? :` coercion turns into null) leaves the property with no kitchen, so `resolveMenu` returns `[]` and `POST /orders` refuses with "no kitchen" (`food.ts:489-490`) — food ordering for that property is silently dead.

**Frontend aggravation.** The Configure-property dialog fires the two writes as independent sequential HTTP calls with no transaction and no rollback: `await foodApi.assignBrand(...); await foodApi.assignKitchen(...)` (`apps/uniliv-admin/src/pages/food-organization.tsx:100-108`). `invalidate()` is only in `onSuccess` (`:106`), so when the second call fails the tree still shows the pre-edit brand and the admin believes nothing changed — while the property is now brand=HUDDLE bound to the old kitchen, a `(kitchenId, brand)` pair with no `food_menu_rotation` rows (`schema/food.ts:363-403`), i.e. an empty menu for every unit lead.

**Fix.** Gate `:id` through `resolveAccessiblePropertyIds` + `isAccessible` (403 otherwise); validate the supplied `kitchenId` via `assertKitchenAccess`; verify both rows exist. Given the blast radius, consider restricting to `isSuperAdmin` like `PUT /system-config/food-defaults` (`food-ops.ts:484`). Collapse the two writes into one endpoint / one `UPDATE`.

---

### C6 — `kitchen.ts` (19 endpoints, 4 routers) has zero property scoping and mints procurement documents without the INDENTS permission · CONFIRMED

**What.** Verified by grep: `apps/api-server/src/routes/kitchen.ts` contains **0** occurrences of `scopedPropertyId`, `resolveAccessiblePropertyIds` or `isAccessible`. All four routers are live (`routes/index.ts:63-66`) and every gate is `authorize()` only, which performs no tenant check (`middlewares/authorize.ts:4-17`).

- Lists omit the filter entirely when no `propertyId` is supplied: `const where = propertyId ? eq(menuPlansTable.propertyId, propertyId) : undefined;` (`kitchen.ts:115`), same shape at `:260` (daily-production), `:318`/`:337`/`:360` (kitchen-analytics).
- By-id writes key on the path id alone: `PUT /menu-plans/:id` (`:158`), `POST /:id/publish` (`:166`), `POST /:id/generate-indent` (`:193`). `POST /menu-plans/copy` loads `src` by body id and writes to `propertyId || src.propertyId` (`:176-180`). `PUT`'s pick allow-list includes `"propertyId"` (`:156`), so an edit can relocate a plan to another property.
- `POST /recipes/:id/feedback` destructures `propertyId, rating, comment, weekStart` straight from `req.body` and inserts verbatim (`:95-103`) — no zod, no 1..5 bound, no scope check, and `weekStart: weekStart ? new Date(weekStart) : null` accepts any string.

The generic helper does not save it either: `scopedPropertyId` returns null for both `KITCHEN_MANAGER` (`lib/authz.ts:27`) and `FNB_MANAGER` (`:39`) because both are in `ORG_WIDE_ROLES` — exactly the assumption `food-service.ts:114-122` refuses to make.

**Concrete failure — read/write.** An FNB_MANAGER scoped to one kitchen calls `GET /api/menu-plans` with no `propertyId` and receives every property's weekly menu plan in the org; `GET /api/daily-production` and `/api/kitchen-analytics/wastage-trends` likewise return every property's dispatch, receiving and wastage figures. They then `PUT /api/menu-plans/<another property's plan id>` and rewrite a published menu for a property they were never scoped to. `KITCHEN_MANAGER` (`RECIPES/MENU_PLANNING: FULL`, `permissions.ts:73`) can do the same.

**Concrete failure — procurement.** `POST /menu-plans/:id/generate-indent` is gated `authorize("MENU_PLANNING","edit")` (`:191`) and inserts into `indentsTable` with `propertyId: plan.propertyId` (`:237`). `KITCHEN_MANAGER`'s entire matrix is `{ DASHBOARD: VIEW, RECIPES: FULL, MENU_PLANNING: FULL, INVENTORY: VIEW }` (`permissions.ts:73`) — **no INDENTS grant** — yet it creates procurement documents for any property. The number is `COALESCE(MAX(indent_number),'IND-01000') + 1` (`:230-232`) with no lock and no retry against a UNIQUE column (`schema/procurement.ts:70`), while the sibling writer wraps the identical logic in `withUniqueRetry` (`procurement.ts:277`, and `lib/id.ts:12` names `IND-` explicitly in its doc comment) — so concurrent generation is a hard 500. There is no idempotency check, and the UI button (`menu-planning.tsx:91`) has no disable-after-success, so three clicks create three DRAFT indents for the same week.

**Concrete failure — the indent is unreadable.** `generate-indent` emits items as `{ name, unit, quantity, estimatedCost: 0 }` (`:227`) and hardcodes `totalEstimatedValue: "0"` (`:241`). Procurement reads a different contract entirely: `Number(it["quantity"]) * Number(it["estUnitPrice"])` (`procurement.ts:273, :302`), and the UI renders `{it.itemName}` and `₹{Number(it.estUnitPrice || 0)}` (`indents.tsx:226, :230-231`). **Neither key is ever written.** The indent detail shows a blank Item column and ₹0 on every line; `convertToPO` (`indents.tsx:136-140`) prefills `itemName: undefined, rate: 0`. A PO can go out with unnamed lines valued at zero, and any value-based approval is satisfied at ₹0. Editing the indent makes it permanent — `PUT /indents/:id` recomputes the total from the missing key and writes "0" again.

**Fix.** Resolve scope once per handler and (a) AND it into every list, (b) 403 an out-of-scope explicit `propertyId`, (c) load the row and assert `row.propertyId` is in scope before every by-id write; drop `propertyId` from the `PUT` allow-list. Gate `generate-indent` on both `MENU_PLANNING:edit` **and** `INDENTS:create`, wrap the number in `withUniqueRetry`, make it idempotent per `(planId, weekStart)`, and emit the procurement item shape `{ itemName, specification, quantity, unit, estUnitPrice }`. Add zod to `/recipes/:id/feedback`.

---

## High findings

### H1 — No uniqueness on (propertyId, mealType, serviceDate); duplicate live orders are creatable two ways · CONFIRMED

`lib/db/src/schema/food.ts:687` states *"One row per property + meal + planned date."* The `pgTable` call at `:690` takes no second argument — the only unique is `orderNumber` (`:693`). Verified.

- **`POST /order-batches`** guards in application code only, and outside any transaction: the dedupe SELECT is at `food-ops.ts:1421-1437`, the batch insert at `:1453`, the order insert at `:1516`. Between the read and the write the handler awaits `residentsCapForProperty`, `nextSeq`, a property lookup, and per-meal `resolveMenu`/`expectedDeliveryAt` — many round trips. Two concurrent submissions (two tabs, phone + laptop, a client retry after a timed-out-but-committed request) both see no live LUNCH order and both insert one. The 409 at `:1435` never fires.
- **`POST /orders`** (`food.ts:468-528`) has **no dedupe at all**, and no `residentsCapForProperty` call either — the 120% occupancy cap enforced on both sibling write paths (`food-ops.ts:1443`, `food.ts:1018`) is simply absent. `residentsCount` is `z.coerce.number().nullish()` (`:464`) with no `.int()`/`.min()`, used raw (`:496`) and inserted into a `NOT NULL integer` (`schema/food.ts:703`). `residentsCount: 5000` for a 40-bed property is accepted silently; so is `-500`.

`GET /kitchen-summary` aggregates `inArray(status, ["PLACED","ACCEPTED"])` (`food.ts:1494`) with no de-duplication, so **the kitchen is told to cook double**. Headcount roll-ups (`sum(residentsCount + staffCount)` at `food-ops.ts:2256, 2260`, `food.ts:1610`) and the orders export (`food.ts:1668`) double-count too.

Mitigation observed: the UI button is disabled while the mutation is in flight (`food-dashboard.tsx:1897`), and `foodApi.placeOrder` has no caller in the frontend — so the plain double-click is blocked and the unguarded legacy path needs a direct API call. The duplicate is also visible to the kitchen as two order cards before anyone cooks.

**Fix.** Add a partial unique index `food_orders(property_id, meal_type, service_date) WHERE status NOT IN ('CANCELLED','REJECTED')`, map the violation to the existing 409, lift the dedupe + cap into a shared helper called by both endpoints, and bound `residentsCount` with `.int().min(0)`.

### H2 — Variance / Waste / On-time CSV and PDF exports silently download the ORDERS dataset · CONFIRMED

`routes/index.ts:91-92` mounts `foodRouter` before `foodOpsRouter`. `food.ts:1694-1697` registers `/reports/export`, `.csv` and `.pdf` bound to `reportsCsvHandler` / an inline PDF twin, whose only data source is `fetchReportOrdersForExport` (`:1634-1671`) — that function reads `propertyId`/`from`/`to` and **never** `req.query["report"]`. The report-aware pipeline `serveReportExport` → `buildReportTable(report, req)` is registered second at `food-ops.ts:2755, 2760` and is unreachable dead code. Only `.xls` (`food-ops.ts:2765`), which `food.ts` never registers, honours `?report=`.

The frontend does send it: `buildExportParams` sets `p.report` (`food-reports.tsx:289`) and names the file from the report key (`:302-306`), and `apiDownload` forces the client-chosen filename over the server's `Content-Disposition` (`lib/api-fetch.ts:132-155`). So "Ordered vs Delivered Variance → CSV" downloads `food-variance-Koramangala-2026-08-06.csv` containing `Order ID, Property, Unit Lead, Brand, Meal, Residents, Staff, Total, Quantity, Status, Service Date, Delivered At` — the raw orders list. No error; the toast says "Export ready". Two of three formats × three of four reports are affected. The existing test asserts the URL, not the payload (`apps/uniliv-admin/src/lib/__tests__/food-api.test.ts:94`), so it does not catch this.

Partial mitigation: `toCsv`/`toPdf` embed a title row and `food.ts:1685/1701` passes `"Food Orders Report"`, so the file self-identifies — but the filename asserts otherwise.

**Fix.** Delete the three `/reports/export*` routes from `food.ts:1694-1705` and let `serveReportExport` serve csv/pdf/xls (keeping the `requireRoles` guard), or have the `food.ts` handlers delegate to `buildReportTable`. Add a route-collision assertion over the two routers so any future shadow fails CI.

### H3 — The notification pipeline silently drops everything in the default deployment · CONFIRMED

Three independent mechanisms, each verified:

**H3a — `logProvider` marks the outbox SENT in production.** `selectProvider` falls back unconditionally with **no `NODE_ENV` gate anywhere in the file**: `return candidates.find((p) => p.isConfigured()) ?? logProvider(channel)` (`lib/notify-core/src/providers.ts:103-105`), and `logProvider.isConfigured` is `() => true` with a `send` that only `console.info`s and returns `log-<uuid>` (`:85-95`). `processDelivery` treats that as success and writes `status: "SENT", providerMessageId, sentAt` (`process.ts:37-42`). The shipped template ships every real provider commented out (`.env.docker.example:89, 104, 118`), so the default deployment selects `logProvider` for EMAIL and SMS. Every food order-lifecycle notification, every resident payment link (`residents.ts:431-432`) and every wallet top-up link (`wallet.ts:368-369`) is discarded — and the outbox, described as *"the durable source of truth + audit"*, affirmatively records that it was sent.

**H3b — Setting `REDIS_URL` disables delivery entirely.** The inline safety net runs only on a false **return**: `const queued = await enqueueDelivery(id); if (!queued) await processDelivery(id);` (`notification-service.ts:85-90`). `enqueueDelivery` returns false in exactly one case — no `REDIS_URL` (`queue.ts:26, 48-52`); every other failure **throws**, including the lazy `await import("bullmq")` at `:28-29`. That import is guaranteed to fail in the shipped image: `build.mjs` externalises `bullmq` and `ioredis` (lines 55-59) and the api Docker stage copies only `dist` with no `node_modules`. The throw is swallowed by `notify()`'s catch-all (`:154-156`) after the PENDING row has committed. The only drain is `reconcile()` in `apps/notify-service/src/index.ts:43-57`, and that worker is not in `docker-compose.yml` — `.env.docker.example:133` admits it. `apps/api-server/src/index.ts:50-79` starts SLA, finance and audit jobs and no outbox sweeper. So setting one env var that reads as a performance improvement stops **all** notification delivery, permanently, with a single log line as the only signal.

**H3c — The documented remedy makes it worse.** `nodemailer` and `twilio` are also externalised (`build.mjs:55-56`) while `@aws-sdk/*` is deliberately not (comment at `:70-73`). The moment an operator sets `SMTP_HOST` — the exact fix `.env.docker.example:89` suggests — `smtpProvider` wins `selectProvider` (`providers.ts:55, 104`) and every send throws `ERR_MODULE_NOT_FOUND` (I confirmed `const pkg = "nodemailer"` survives verbatim in `dist/index.mjs`). Combined with H3d, each such row is marked terminally FAILED.

**H3d — Inline delivery gets one attempt and is terminal.** `processDelivery(id)` is called with no `AttemptCtx`, so the default `{ attemptNo: 1, isLastAttempt: true }` applies (`process.ts:22`) and any provider error writes `status: "FAILED"` (`:44-51`). The BullMQ retry policy (`attempts: 6`, exponential — `queue.ts:36-41`) is unreachable inline, and the reconciler selects `status = "PENDING"` only (`notify-service/src/index.ts:49`), so nothing anywhere ever resets FAILED.

**Fix.** Gate `logProvider` on `NODE_ENV === 'development'` (or add a distinct `LOGGED` status and never write SENT). Wrap the enqueue in try/catch and fall through to `processDelivery` on **throw**, not just on false. Add an outbox reconciliation sweep to the `RUN_SCHEDULERS` block in `api-server/src/index.ts`. Stop externalising `nodemailer`/`twilio` (both bundle fine, as the SES SDK does) and correct the now-stale SES caveat at `.env.docker.example:96-103`.

### H4 — Config writes bypass the kitchen-scope guard that the sibling rotation writes enforce · CONFIRMED

Every menu-rotation write calls `deniedKitchen` (`food.ts:2268, 2393, 2459, 2619, 2620, 2646`), and `assertKitchenAccess` explicitly refuses a null kitchenId with *"Pick one of your kitchens — you cannot edit the brand-wide menu"* (`food-service.ts:275-279`). Four sibling surfaces carry the identical `FOOD_SETTINGS` gate and **no** scope check:

- **Composition rules** — `POST` takes `kitchenId: b.kitchenId || null` straight from the body (`food.ts:2795-2802`); `PUT` maps `b[k] === "" ? null : b[k]` over `[brand, mealType, kitchenId, …]`, so a blank string **promotes the rule to brand-wide** (`:2824-2831`); `DELETE` is a bare delete by path id (`:2847`).
- **Per-resident rules** — `POST` hard-codes `propertyId: null` (`:2702`); `PUT`/`DELETE` update/delete by path id with no prior SELECT and no scope (`:2721-2740`). `per_resident_rules` has **no kitchen or property dimension at all** (keyed brand+meal+dish), so even a *legitimate* portion edit by a kitchen-scoped manager is unavoidably network-wide. `computeOrderItems` multiplies headcount by `rule.qty` (`food-service.ts:497-511`), so one `PUT` changes ordered kilograms for every property on the brand.
- **Cut-offs** (`food-ops.ts:371, 401, 413`) and **meal windows** (`:307, 332, 346`) — same shape; `PUT` even accepts an arbitrary `propertyId` in the update set (`:406, :338`).

This is the exact escalation `ae42b5a` closed for menu rotation, left open on the four surfaces that feed the same order pipeline. `FOOD_SETTINGS: VE` = FULL, so `FNB_MANAGER` holds delete as well.

**Fix.** Call `deniedKitchen` on composition-rule POST/PUT/DELETE (loading the row first so DELETE and PUT can check the stored kitchenId). For per-resident rules, cut-offs and meal windows add an `isAccessible(propertyId, ids)` check — or, since `per_resident_rules` genuinely has no scope column, move it behind `isSuperAdmin` like `PUT /system-config/food-defaults`.

### H5 — `user_scopes` hard delete + no uniqueness · CONFIRMED

Covered as C4d above; recorded separately because it applies beyond the retired levels. `DELETE /food/scopes/:id` is `db.delete(...).where(eq(id))` returning `{success:true}` unconditionally with no prior SELECT (`food.ts:3396-3401`); `user_scopes` has no `isActive`/`revokedAt` and no unique constraint (`schema/food.ts:193-205`); `POST /scopes` has no duplicate check, so duplicate grant rows are freely creatable and "delete the grant" becomes ambiguous. Deleting the last row of a `BROAD_FALLBACK` role escalates them to org-wide.

### H6 — Batch order: client controls the cook quantity and its unit, with no transaction and no failure signal · CONFIRMED

`POST /order-batches` (`food-ops.ts:1384`) is the live order-placement path (`food-dashboard.tsx:643`). Verified:

- **Quantity/unit are client-supplied and unbounded.** `zBatchMealItem` declares `orderedQty: z.coerce.number().nullish()`, `unit: z.string().max(64).nullish()`, with a comment that it is *"Permissive on purpose"* (`:1353-1361`). For any non-pinned dish, `const oq = … : Number(it.orderedQty)` and `unit: … : (it.unit || md.unit)` (`:1494, :1502`); the only guard is `if (!Number.isFinite(oq) || oq <= 0) continue` — a **lower bound only** (`:1495`). The 120% cap at `:1443-1449` validates `residentsCount` and never looks at `orderedQty` or per-item `personsCount`. Food orders carry no price, so `orderedQty` **is** the cost: the kilograms the kitchen is told to cook. The per-resident portion engine is consulted only for `isQtyLocked` dishes (`:1483-1493`).
- **The unit is the sharper half.** Sending a *valid* enum `"KG"` for a dish whose portion rule is in `G` passes every check, and `GET /kitchen-summary` keys the cook plan by `r.dishId + "|" + r.unit` with **no conversion** — its own comment says mixing units would be meaningless (`food.ts:1536-1546`). A 1000× error reaches the kitchen with no error anywhere.
- **An invalid unit strands an order.** `unit: r.unit as never` is cast into `measurementUnitEnum` (`:1531`, target `schema/food.ts:769`). The batch row (`:1453`), each order (`:1516`), its items (`:1530`) and its event (`:1534`) are four independent statements with **no `db.transaction`**. A bad enum or a `numeric(12,3)` overflow throws *after* the order row commits, leaving a PLACED order with **zero line items** that the kitchen summary counts and that blocks re-ordering via the dedupe guard.
- **Zero orders returns 201 with confetti.** Items are dropped at `:1486` (dish no longer on the resolved menu), `:1493` (pinned dish whose portion rule lapsed) and `:1495`; the whole meal is skipped at `:1511`. The response is an unconditional `res.status(201).json({ success: true, data: { batch, orders: created } })` (`:1539`) with `created` possibly `[]`. The client's `onSuccess` deletes the server draft, clears headcounts, fires confetti and toasts `"${res.orders.length} meals on the way"` with **no zero check** (`food-dashboard.tsx:650-674`). The lead sees "Tomorrow's order sent — 0 meals on the way", their recovery state is destroyed, and the cut-off passes.

**Fix.** Take `unit` exclusively from the resolved rule/dish (never the body) and validate against `MEASUREMENT_UNITS`; bound `orderedQty` and per-item `personsCount` against `personsCount × rule.qty` with a tolerance; wrap batch/order/items/event in one `db.transaction`; return 422 with the skipped-meal reasons when `created.length === 0`, and guard the client `onSuccess` on `res.orders.length > 0`.

### H7 — Confirm-delivery is unsubmittable when the kitchen prepared more than ordered · CONFIRMED

`preparedQty` has **no upper bound**: `kitchenItemsSchema` is `z.coerce.number().min(0).finite()` (`food.ts:1183`), the handler checks only ownership and `status === "ACCEPTED"` (`:1191-1228`), and the client guard is only `Number(v) < 0` (`food-kitchen-home.tsx:180-182`). `confirm-delivery` hard-caps against **ordered**: `rq > Number(it.orderedQty)` → 400 (`food.ts:1324-1327`). The receive UI prefills received from **prepared** — `sentOf = num(i.preparedQty ?? i.orderedQty)` (`food-dashboard.tsx:698-701`) — and the stepper's ceiling is that same value (`:1455`).

**Concrete failure.** Kitchen bumps Dal from 40 kg ordered to 45 kg prepared with a reason. The van delivers. The unit lead sees "sent 45", taps Confirm, and gets `receivedQty … must be between 0 and 40`. Every reachable value 41–45 is rejected. Stepping down to 40 makes `rec !== sent`, forcing a shortfall reason, and the server writes a real `TKT-` FOOD/DELIVERY_VARIANCE complaint **inside the same transaction** (`food.ts:1370-1405`) for food that was actually **over**-delivered. Either the lead is blocked or the record is falsified.

**Fix.** Cap `receivedQty` at `Math.max(orderedQty, preparedQty ?? 0)` at `food.ts:1325` and keep computing the shortfall against `orderedQty`; or bound `preparedQty ≤ orderedQty` in `kitchenItemsSchema`. Make the stepper max and the server cap read the same field.

### H8 — Kitchen contact PII, driver phone numbers and the whole property/fleet master are readable by any authenticated user · CONFIRMED

Three endpoints registered with `authenticate` and nothing else:

- `GET /kitchens` — unprojected `db.select().from(kitchensTable)` (`food-ops.ts:591-598`); the table carries address, `contactName`, `contactPhone`, `contactEmail` (`schema/food.ts:504-516`).
- `GET /delivery-partners` — unprojected select including `phone` and `vehicleNumber` (`food.ts:2858-2865`).
- `GET /lookups` — every property (id, name, city, brand, kitchenId, clusterId), every active agency with vehicles, service locations and agency→kitchen links (`food.ts:1711-1743`); only `myKitchenIds` is scoped (`:1736-1743`).

`VENDOR_RESTRICTED` holds `{ DASHBOARD: VIEW }` (`permissions.ts:79`); `WARDEN`, `HR_MANAGER`, `FINANCE` and `SALES_EXECUTIVE` hold no `FOOD_*` module at all — all pass `authenticate`. `GET /hierarchy` (`food-ops.ts:759-786`) compounds it: gated on `FOOD_DASHBOARD:view`, its handler parameter is literally `_req` because the request is never used — it returns every city, every kitchen (unprojected, contact PII included) and every property with `totalBeds` plus a live `count(*) … status='ACTIVE'` occupancy subquery (`:766`), while the sibling `GET /my-properties` does scope correctly.

Also in this family: `GET /menu-rotation/resolve` (`food.ts:2095-2110`) is `authenticate`-only and accepts an arbitrary `?kitchenId`, 47 lines above `GET /menu-rotation` (`:2142`) which carries `authorize("FOOD_SETTINGS","view")` + `scopeRotationCondition` under a comment explaining that the scope filter exists precisely to stop this (`:2139-2141`). Same for `/menu/full` (`food-ops.ts:1570`), `/meal-windows` (`:285`), `/cutoffs` (`:421`), `/composition-rules` (`food.ts:2766`).

**Fix.** Add `authorizeAny(FOOD_MODULES, "view")` to all of these; project away contact columns for callers without `FOOD_ORG`/`FOOD_SETTINGS`; scope the `properties` array in `/lookups` and the tree in `/hierarchy` through `resolveAccessiblePropertyIds`; validate any caller-supplied `propertyId`/`kitchenId` against the caller's scope.

### H9 — `resolveMenu` picks the day of week with host-local getters · CONFIRMED

`isoDayOfWeek` uses `date.getDay()` (`food-service.ts:294-297`) and `isoWeekNumber` uses `getFullYear/getMonth/getDate` (`:300-306`) — both host-timezone. The instants they receive are IST-day-start instants: `ymdToIstDayStart` → `Date.UTC(...) - IST_OFFSET_MS` (`lib/tz.ts:70`), i.e. **18:30 UTC on the previous calendar day**. `lib/tz.ts:5-8` explicitly warns against exactly this, and `DEPLOYMENT.md:91-93` claims the app *"anchors to IST in code regardless of the host clock"* — which is false for this one function.

Executed under both zones on `ymdToIstDayStart('2026-08-10')` = `2026-08-09T18:30:00Z`: `TZ=Asia/Kolkata` → day 1 (Mon), week 33; `TZ=UTC` → day **7** (Sun), week **32**. On a container missing `TZ`, every menu resolves to the previous day's plate and the rotation week is off. The two order endpoints also disagree: `POST /order-batches` passes `new Date(serviceDate)` (UTC midnight, `food-ops.ts:1400`) while `/next-orders` and `POST /orders` pass the IST anchor.

Mitigated in the shipped stack (`TZ=Asia/Kolkata` in `.env`, `.env.docker.example:18`, mandated by `DEPLOYMENT.md:89-93`), but correctness rests on an env var rather than on code, and every food test is host-TZ dependent.

**Fix.** Derive dow/week from `istDayYmd(serviceDate)` via `Date.UTC` (the pattern `addDaysYmd` already uses at `lib/tz.ts:77-81`). Same for `resolveExpectedDeliveryAt`'s `d.setHours(...)` at `food-service.ts:789`.

### H10 — Soft-deleting a dish keeps it on the menu forever · CONFIRMED

`DELETE /dishes/:id` is a soft delete only — `db.update(dishesTable).set({ isActive: false, updatedAt })` (`food.ts:2023-2029`) — with no rotation cleanup. `resolveMenu`'s filter set is `kitchenId, brand, mealType, dayOfWeek, foodMenuRotation.isActive` and the effective window (`food-service.ts:391-399`), and the join at `:425` is `innerJoin(dishesTable, eq(rotation.dishId, dishes.id))` with **no** `eq(dishesTable.isActive, true)`. Repo-wide, `dishesTable.isActive` appears only at `food-service.ts:659` (auto-fill candidates) and `food.ts:1765` (list filter) — neither on the ordering path.

The dish vanishes from the catalogue, so nobody can see it — but `resolveMenu` still returns it, `/order-preview` still prices it, `POST /order-batches` still accepts it (the `allowed` set is built from `resolveMenu`, `food-ops.ts:1464`), the kitchen keeps being told to cook it, and the public shared-menu page still advertises it (`food-ops.ts:1690`). Worse, the confirm dialog **promises the opposite**: `dishes-catalogue.tsx:222-223` tells the user the dish "is currently on N rotation plate(s), which will lose it", computed from the live rotation — while the server prunes nothing. The codebase already implements this cascade for side dishes, with a comment explaining exactly why (`food.ts:1841-1862`, `pruneRotationSidesForDish`).

**Fix.** Add `eq(dishesTable.isActive, true)` to `resolveMenu`'s join, and on delete either refuse with the referencing rotation cells or prune them as `pruneRotationSidesForDish` already does.

### H11 — Report exports are unbounded and render PDFs synchronously on the event loop · CONFIRMED

`fetchReportOrdersForExport` (`food.ts:1634-1652`) builds `where` from `reportConds`, which adds `from`/`to` **only when supplied** (`:1571-1587`), and runs a two-leftJoin select ordered by `serviceDate` with **no `.limit()`**. For `SUPER_ADMIN`/`OPS_EXCELLENCE`, `resolveAccessiblePropertyIds` returns null and `scopeOrdersCondition(null)` returns undefined — so a bare `GET /api/food/reports/export.pdf` selects the **entire** `food_orders` table. `toPdf` is fully synchronous on the main thread with a per-cell character-by-character truncation loop (`lib/export-service.ts:118-149`).

The UI always sends a 30-day window (`food-reports.tsx:101, 109, 288-295`), so this is an admin curl/bookmark/script risk rather than a UI click — but the table has no index either (H13), the process is single-threaded, and the same shape applies to `GET /kitchen-summary` when `?date` is omitted (`food.ts:1494-1526`, no limit on the item join).

**Fix.** Default to a bounded window when `from`/`to` are absent, add a hard row cap returning 422 beyond it, stream CSV rather than buffering, and move PDF generation off the request path (the audit module already has `runReportWorker`).

### H12 — `POST /menu-plans/:id/generate-indent` — see C6. Recorded here for the procurement-money angle: ₹0 indents with unnamed lines converting into POs.

---

## Medium findings

**M1 — Every order lifecycle transition is SELECT-then-blind-UPDATE.** Accept (`food-ops.ts:839-852`), reject (`:861-869`) and cancel (`food.ts:1121-1134`) read the order in one statement and update with `where(eq(id))` only — no status predicate, no transaction, no lock. `canTransition` (`order-transitions.ts:22`) is a pure in-memory check against a stale read. A cancel landing between a concurrent accept's read and write produces a live ACCEPTED order carrying `cancelledAt` and `cancelReason` plus a cancellation event — cooked and dispatched after the lead was told it was cancelled. Both actors are real and distinct (cancel accepts either `FOOD_PLACE_ORDER:edit` or `FOOD_KITCHEN_SUMMARY:edit`, `food.ts:1117-1119`). Fix: make every transition `UPDATE … WHERE id = $1 AND status = $expected RETURNING *` and 422 on zero rows.

**M2 — Trip and order state drift with no reconciler; vehicles get stuck.** `confirm-delivery` (`food.ts:1355-1413`) contains **no** reference to `foodDispatchesTable` — verified. `createDispatchForOrders` always inserts `status: "LOADING"` (`food-ops.ts:945`), and `markTripDelivered`'s guard (`:1259-1261`) checks `DISPATCH_TRANSITIONS[trip.status]`, which for `LOADING` is `["IN_TRANSIT","CANCELLED"]` (`schema/food.ts:133`) — so ticking every order Done on a LOADING trip **silently no-ops**, with no 422 and no dispatch event. The vehicle-busy guard filters `inArray(status, ["LOADING","IN_TRANSIT"])` (`:1075-1078, :988-990`), so that van is reported busy and every future trip creation 422s. Recoverable in two clicks via the board's transition buttons, and vehicle-less quick/bulk trips block nothing — but nothing auto-reconciles, and the workaround (`PATCH /dispatches/:id/status`) is the path that triggers C3.

**M3 — `createDispatchForOrders` has no row lock; the vehicle-busy check is outside the transaction.** The status re-check is a plain `tx.select` (`food-ops.ts:932-936`), the order update carries no status predicate (`:949-954`), and the C6 vehicle check runs on `db` at `:1075-1078` **before** the transaction opens at `:1116`. Two dispatchers picking the same van both pass, both create trips, and the second commit wins on `dispatchId` — leaving a phantom LOADING trip holding the vehicle. `isDispatchAccessible` returns false for a zero-order trip (`:875-881`), so only an org-wide role can cancel it.

**M4 — Non-transactional multi-statement writes across the module.** `POST /orders` writes header (`food.ts:506-522`), items (`:533`) and event (`:547`) as three unrelated statements — and `if (computed.length)` (`:531`) means an empty menu resolution creates a PLACED header with **zero items** and returns 201. `PUT /orders/:id` commits the header (`:1038`) then rescales items in a separate loop (`:1068-1078`). `PATCH /orders/:id/kitchen-items` applies quantities in a loop and writes the **mandatory reason event last** (`:1213-1225`) — the accountability record the endpoint exists to produce is the statement most likely to be skipped. `POST /orders/dispatch/bulk` commits one trip per order and discards the entire `results` array when any order throws (`food.ts:687-731`).

**M5 — Post-dispatch edits manufacture variance.** `PUT /orders/:id` admits `DISPATCHED` (`food.ts:984-987`) and the cut-off re-check is scoped to `PLACED` only (`:998`). The rescale loop touches `personsCount`/`orderedQty` and never `preparedQty` (backfilled at accept, `food-ops.ts:846-848`). Edit down after dispatch → `confirm-delivery` caps `receivedQty` at the *new* `orderedQty` (`:1325`), so the real delivered quantity is unrecordable. Edit up → the shortfall detector fires against an inflated basis (`:1344`) and auto-files a HIGH-priority complaint against a kitchen that delivered exactly what was asked.

**M6 — Reports include CANCELLED and REJECTED orders.** `wasteAnalyticsScope` (`food-ops.ts:1924-1946`), `/analytics` (`:1796-1801`) and `/home-analytics` (`:2241-2244`) build their WHERE with **no status predicate**, while `/reports/variance` (`:2441`) and `/reports/variance-by-day` (`:2637`) pin `DELIVERED` and the dashboard uses `count(*) filter (where status <> 'CANCELLED')` (`food.ts:196`). Cancel is a soft status change that leaves items joinable (`food.ts:1128-1131`). Two reports labelled "ordered" on the same screen return different values; `/home-analytics` computes `wastePct = wasted/ordered` against the inflated denominator (`:2405`).

**M7 — Quantity totals sum grams, kilograms, litres, plates and pieces.** `/reports/variance` groups by `mealType` only (`food-ops.ts:2448-2456`) and reduces to a unitless grand total (`:2465-2469`); `unit` is a per-row enum (`schema/food.ts:73, 769`) and is in no grouping key. Same for variance-by-day (`:2645-2652`), the waste summary (`:1961-1972`) and home-analytics (`:2376-2379`). The codebase knows better — the cook plan keys by `dishId|unit` precisely because *"mixing them would yield a meaningless total"* (`food.ts:1536-1541`) — and `/analytics`'s `wasteByDish` does group by unit (`:1802-1806`). `variance = ordered − received` subtracts two mixed-unit sums, and that delta is the shortfall signal.

**M8 — Report date windows are time-of-day dependent, and the waste range overshoots by a day.** `periodRange` anchors `to` on the current instant and derives `from` by subtracting N×86400000 ms (`food-ops.ts:1703-1705`), while `serviceDate` is the IST day-start instant — so which service day sits at the lower edge flips at 18:30 UTC and two runs on the same calendar day return different totals. Separately, `wasteAnalyticsScope` computes an explicitly **exclusive** bound and compares it **inclusively**: `const toAtExclusive = atIst(addDaysYmd(toYmd,1), "00:00")` (`:1917`) vs `lte(serviceDate, toAtExclusive)` (`:1926`) — stored values land exactly on that instant, so the whole `to+1` service day is pulled into every waste figure. Three endpoints also bucket `serviceDate` with a bare `to_char` while three siblings add `+ interval '330 minutes'` (`food.ts:1599`, `food-ops.ts:1802, 2246` vs `:2033, 2170, 2644`).

**M9 — `GET /food/revenue` returns 5 months instead of 6 on the 29th–31st.** `since.setMonth(since.getMonth() - 5)` runs while the day-of-month is still 31 (`food-ops.ts:3177`). Reproduced with node: from 2026-07-31 it yields Mar 1, not Feb 1. Single-site — the sibling `monthStart` computations at `:2342, :3009, :3156` have no `setMonth`.

**M10 — Collections are attributed through the resident's CURRENT property.** `paymentsTable` has no property column (`schema/core.ts:310-324`) while `wallet_transactions` does snapshot it (`schema/wallet.ts:51-53`). Every collections figure joins payments → residents and filters `residents.propertyId` (`food-ops.ts:2346-2348, 3010-3013, 3158-3160, 3178-3180`). Inter-property transfer is a first-class flow (`residents.ts:210-219`), so a transfer silently rewrites all six buckets of the 6-month revenue chart for both properties — and gives the destination unit lead visibility of collections taken at a property they never had access to.

**M11 — `total_quantity` holds two different things.** Schema says *"sum of item ordered quantities"* (`schema/food.ts:707-708`). `POST /order-batches` writes the item sum (`food-ops.ts:1512, 1527`); `POST /orders` writes the headcount (`food.ts:515`); and `PUT /orders/:id` overwrites **both** with `String(people)` (`:1032`). That PUT is the live edit-headcount flow (`food-order-detail.tsx:224`). The column is emitted verbatim as "Quantity" in the export alongside separate Residents/Staff/Total columns (`food.ts:1628, 1668`), so an order's Quantity cell changes unit mid-lifecycle after a routine headcount edit.

**M12 — Deleting a per-resident portion rule silently drops the dish from every future order.** `DELETE /rules/:id` is a bare delete with no usage check (`food.ts:2734-2739`), and the consumer skips silently: `const rule = rules.get(m.dishId); if (!rule) continue;` (`food-service.ts:499-500`). The menu keeps advertising the dish; `/order-preview` returns `qtyPerResident: null, defaultOrderedQty: 0` (`:551-563`); the batch path drops it at `oq <= 0` (`food-ops.ts:1495`). This is a normal UI action — clearing a portion field in the dish drawer fires the delete (`dish-drawer.tsx:154`). The team already built the inverse guard for the rotation write path (`dishesMissingPortionRule`, `food.ts:2325-2344`, called at `:2394, :2481`) with a comment explaining exactly this failure.

**M13 — Config tables have no uniqueness and resolve arbitrarily.**
- `food_meal_windows` declares **no constraint of any kind** (`schema/food.ts:566-581`), unlike its sibling `food_cutoffs` (`:599`); `POST /meal-windows` inserts unconditionally (`food-ops.ts:307-320`). Both resolvers (`resolveWindow` `:136-150`, `resolveExpectedDeliveryAt` `food-service.ts:772-789`) have **no ORDER BY** and use a non-antisymmetric comparator, so with two global rows the winner is whatever the heap scan returns. `expectedDeliveryAt` is the stored delay baseline for `/reports/on-time`.
- `food_cutoffs`' unique index is `(brand, propertyId)` (`:599`), which Postgres does not enforce across NULLs — `POST` dedupes explicitly with a comment saying so (`food-ops.ts:377-382`), `PUT` does neither and has no unique→409 mapping (`:401-411`). The edit dialog re-sends `propertyId: form.propertyId || null` on every save and offers "Global (all properties)" while editing (`food-settings.tsx:290, 353-357`), so promoting a property override to global creates a second global row.
- `food_menu_rotation` has no unique on its resolve key (`:399-404`); `POST /menu-rotation` and `/bulk` insert with no existence check (`food.ts:2282-2296, 2417-2437`) — though neither has a frontend caller, so this is latent.
- `per_resident_rules` has no unique (`:411-425`); `PUT /rules/:id` lacks the duplicate check `POST` has (`food.ts:2694-2698` vs `:2721-2732`), and `resolveRulesByDish` takes the first row of an unordered SELECT (`food-service.ts:477-479`).

**M14 — Boards silently truncate at 100 orders.** `getPagination` clamps to `Math.min(100, …)` (`lib/paginate.ts:3`). `food-kitchen-summary.tsx:113` requests 200, consumes only `data` (`:119`), renders no pager, and "Accept for this meal" iterates that truncated array then fires confetti and "Accepted N orders" (`:159-160, :190-219`). `food-dispatch.tsx:190-191` and `food-orders.tsx:201` do the same at limit 100. Meanwhile `GET /kitchen-summary` is **unpaginated** (`food.ts:1512-1525`), so the cook plan and the order list on the same screen disagree. `food-kitchen-home.tsx:379-398` already implements the correct paging loop with a comment naming this exact hazard.

**M15 — Menu Planning is blank for its own persona.** `menu-planning.tsx:39-41` fetches `/properties` unconditionally and seeds `propertyId` from it; every downstream query is `enabled: !!propertyId`. `GET /properties` requires `authorize("PROPERTIES","view")` (`properties.ts:205`). `KITCHEN_MANAGER`'s whole matrix is `{ DASHBOARD: VIEW, RECIPES: FULL, MENU_PLANNING: FULL, INVENTORY: VIEW }` (`permissions.ts:73`) — no PROPERTIES. `FNB_MANAGER` likewise. The nav gates on `MENU_PLANNING` only (`nav.ts:126`), so the page is reachable and renders permanently empty; `grep -c isError menu-planning.tsx` = 0, so the 403 is swallowed. Only SUPER_ADMIN and OPS_EXCELLENCE can use the page.

**M16 — Config pages render every write control to view-only principals.** `food-dispatch.tsx` contains **zero** `can()` calls — the only role logic is `const kitchenBound = role === "FNB_MANAGER"` (`:112`) — and `PageGuard` checks view only (`layout.tsx:591-598`). `CLUSTER_MANAGER`, `CITY_HEAD`, `ZONAL_HEAD`, `SVP` and `AUDIT_READONLY` hold `FOOD_DISPATCH: VIEW`, see the page in the nav (`nav.ts:124`), and get a fully-armed trip builder where every action 403s (`food-ops.ts:1057, 1166, 1222, 1281`). `food-organization.tsx` imports nothing from `use-permissions` at all and renders Add City/Kitchen, Configure property, Add/Edit/Delete Brand and Untag unconditionally (`:130-131, 269, 288, 334, 352-353, 463`); `food-settings.tsx` uses `role` solely for the super-admin Food Defaults tab (`:100-105`). The sibling `food-agencies.tsx:60` and `food-kitchen-home.tsx:351` do it correctly.

**M17 — No food mutation writes to `audit_log`.** A queryable `audit_log` table exists (`schema/system.ts:32-39`) with a viewer (`settings.ts:115-170`). Repo-wide grep: the **only** writer is `wallet-service.ts:186`. Zero hits in `food.ts`, `food-ops.ts` or `food-service.ts`. So the settings that decide how many kilograms get ordered network-wide (`per_resident_rules`), which property is fed by which kitchen (`assign-kitchen`) and who can see what (`user_scopes`) change with no record of the previous value or the actor — and the hard deletes (`food.ts:2734-2739, 3396-3401`) leave nothing at all. Order-level history *is* preserved in `food_order_events`; this gap is master-data and config.

**M18 — Additional food is unaudited and invisible to every report.** `POST /orders/:id/additional-food` (`food.ts:900-946`) writes only `food_additional_order_items` — no event, no notify, no order total update — and mints a fresh `requestId` per call, so duplicates cannot be detected. Repo-wide it has exactly two consumers: `GET /orders/:id` (`:844-871`) and the order-detail UI (`food-dashboard.tsx:1361-1406`). The behaviour is documented as deliberate (`:899-904`), and excluding it from *kitchen* variance is arguably correct — but there is no idempotency key and the waste cap ignores top-ups (`:1458`).

**M19 — Trip delivery never notifies the unit lead.** `confirm-delivery` calls `notifyOrderEvent("DELIVERED", …)` (`food.ts:1415-1418`). `PATCH /dispatches/:id/status` (`food-ops.ts:1195-1204`) and the per-order toggle (`:1244-1246`) update the order and insert an event and **return** — no notify anywhere in either handler, even though the sibling `POST /dispatches` calls `notifyForOrder` for DISPATCHED (`:1141-1145`). Persona story 22 (`Persona-Unit-Lead.md:49`) requires notification on accepted/rejected/dispatched/**delivered**. `POST /orders/:id/waste` writes no notification either.

**M20 — The DELIVERED notification instructs users into a guaranteed 422.** Template body: *"was delivered. Please record any wastage within 1 hour"* (`notification-service.ts:236-241`). `wasteEditableUntil` is stamped `now + 60min` (`food.ts:1358-1361`, `food-service.ts:52-56`) and `POST /orders/:id/waste` rejects with 422 whenever `new Date() < order.wasteEditableUntil` (`:1441-1447`) — the column marks when logging **OPENS**, with no upper bound. The two semantics are exact inverses: never during the first hour, forever after. `Persona-Unit-Lead.md:91` matches the notification; `FOOD_MODULE_TEST_CASES.md` D2-01/02 matches the code.

**M21 — `POST /menu/share` reports a recipient count it cannot deliver to.** The handler loads active residents and sets `recipients = guestRows.map(r => r.id)` (`food-ops.ts:1611-1614`), but delivery requires an app-user match on email — `const userId = userByEmail.get(g.email); if (!userId) continue;` (`:1647`) — and `notify()` resolves the contact from `usersTable`, never from the resident row (`notification-service.ts:126-129`). `userRoleEnum` has no RESIDENT/GUEST value (`schema/core.ts:33-58`) and the only `usersTable` inserts are staff creation. So the response returns `recipientCount: recipients.length` (`:1670`) while delivering to essentially nobody; `g.phone` is selected at `:1612` and never used, so the SMS/WHATSAPP option routes to a staff member's phone on an email collision.

**M22 — Cross-tenant disclosure on the trip sheet.** `isDispatchAccessible` grants if **any** order on the trip is in scope — `orders.some((o) => isAccessible(o.propertyId, ids))` (`food-ops.ts:876-881`) — and `GET /dispatches/:id` then selects the whole manifest with only `eq(dispatchId, id)` (`:1022`), projecting `deliveryAddress`, `deliveryCity`, `deliveryPincode`, `unitLeadName`, `unitLeadPhone`, `unitLeadEmail` (`:1013-1018`). The same trip-level check gates the mutations at `:1222` and `:1192-1203`, which never test the target order's own `propertyId`. Bounded today because trips are single-kitchen by construction (`:1094-1097`) and kitchen scope covers that kitchen's properties — it becomes live the moment anyone creates a PROPERTY-level scope row for a CLUSTER_MANAGER or an F&B role.

---

## Low findings and cleanups

**L1 — Zero indexes on the three hottest tables.** `food_orders`, `food_order_items` and `food_order_events` declare no index argument at all (`schema/food.ts:690-755, 761-784, 790-799`), including none on the child tables' `order_id` FK (Postgres does not auto-index FKs). Every order-detail load sequentially scans both child tables; `GET /kitchen-summary` scans `food_orders` joined against all of `food_order_items` (`food.ts:1512-1525`); `/home-analytics` runs ~18 aggregations keyed on `serviceDate` + `propertyId`. Cheap to fix: `drizzle-kit push` needs only the schema edit. Suggested: `food_order_items(order_id)`, `food_order_events(order_id, created_at)`, `food_orders(property_id, service_date)`, `(status)`, `(dispatch_id)`, `(batch_id)`, `(created_at)`.

**L2 — `GET /next-orders` fan-out.** `Promise.all(props.map(...))` with no concurrency cap (`food-ops.ts:3087-3143`), each callback awaiting `resolveCutoff` + a serial per-meal `resolveMenu` (2 queries each) + an existing-orders select ≈ 10-11 queries per property, and `props` is unfiltered for org-wide roles. At 200 properties that is ~2,200 concurrent queries against a small pool. (The sibling `/my-properties` presign loop is not a real problem — `getObjectUrl` is local HMAC signing or a string concat, `lib/storage/src/index.ts:83-87`.)

**L3 — Cancelling a trip strands delivered orders.** `POST /dispatches/:id/cancel` reverts only `status === "DISPATCHED"` rows (`food-ops.ts:1298-1303`) — a `DISPATCHED → ACCEPTED` hop `ORDER_NEXT` does not declare (`order-transitions.ts:15`) — while already-DELIVERED orders keep `dispatchId` pointing at a now-CANCELLED trip along with stale `deliveryPartnerId`/`vehicleId`. Order detail and track then render "Dispatch CANCELLED" for food the property received; `orderCount` on the cancelled trip still counts them (`:973`).

**L4 — Waste is rewritable forever with an uninformative audit note.** `wasteEditableUntil` is an opening bound only, with "No upper bound for now" (`food.ts:1440-1444`); the write is an unconditional overwrite (`:1466-1467`) and the event note is the fixed string `"Waste recorded"` with no quantities or delta (`:1469-1471`), outside any transaction. Actor and timestamp *are* recorded, and the endpoint is property-scoped — so this is a self-reporting integrity weakness, not cross-actor data loss.

**L5 — `PREPARING` is dead schema.** The enum declares it (`schema/food.ts:60`) and `preparingAt` exists (`:732`), but `git log -S'"PREPARING"'` returns zero commits touching `apps/api-server/src` and `ORDER_NEXT` has no key for it, so `canTransition('PREPARING', x)` is false for all x. No producer has ever existed. Drop the enum value and the column.

**L6 — Enum-typed params validated as free strings.** `status`/`mealType` query params are cast to Postgres enums with no membership check (`food.ts:418-419, 430`; `food-ops.ts:2683-2687`), and body/path fields likewise: dish `component`/`unit` (`food.ts:1923-1924`), menu-share `channel`/`mealType` (`food-ops.ts:1596-1599`), `PUT /meal-config/:mealType` (`:270-279`, where the intended 404 at `:280` is unreachable). Outcome is an opaque 500 instead of 400/404. No bad value can persist — Postgres rejects it. UI pickers prevent most of these.

**L7 — Unescaped LIKE metacharacters.** `GET /orders/track` passes the raw term to `ilike` with `limit(1)`, no ORDER BY, and the scope check **after** the fetch (`food.ts:737-752`). `?orderNumber=%` matches an arbitrary row org-wide, giving a 403-vs-404 existence oracle — though order numbers are a guessable zero-padded sequence anyway, so the practical leak is nil. The correctness half is real: a legitimate order number containing `_` silently matches the wrong row. Same unescaped `%${search}%` at `food.ts:431, 1764, 2932` and `food-ops.ts:3205` (all within-scope, so cosmetic).

**L8 — `cutoffTime`/`serviceTime` are unvalidated 16-char strings.** `createCutoffSchema` (`food-ops.ts:364-369`) and `updateCutoffSchema` (`:397`) accept any string while the org-wide default on the same tab enforces `/^\d{1,2}:\d{2}$/` (`:494`). `atIst` degrades an unparseable value to 00:00 via `h || 0` (`lib/tz.ts:67-71`), closing ordering for the whole brand. Unreachable from the UI — every field is a `<TimePicker stepMinutes={15}>` that only emits `HH:MM` (`food-settings.tsx:348, 473, 560`; `time-picker.tsx:16-23`) — so this is defence-in-depth plus protection for legacy rows.

**L9 — The Cut-offs empty state states the opposite of the enforced behaviour.** `"No cut-off set — orders never close. Add one."` (`food-settings.tsx:316`) versus `resolveCutoff`'s `return row?.cutoffTime ?? (await getDefaultCutoffTime())` (`food-ops.ts:159-163`), where `getDefaultCutoffTime()` can never return null — it falls back to the literal `"09:00"` (`food-service.ts:59-62`). The tab that shows that value is hidden from non-super-admins (`food-settings.tsx:89, 105, 127, 146`), so the persona who owns cut-offs cannot see the value in force.

**L10 — Service Times uses the hardcoded two-brand constant.** `BRANDS = ["UNILIV","HUDDLE"]` is a documented dev fallback (`lib/food-api.ts:12-24`), yet `food-settings.tsx:445, 459, 270` uses it for the Service Times filter, form and default while the sibling Cut-offs panel correctly uses `useActiveBrands()` (`:279`). Any brand created in the Brands tab can never be given a service time, so its orders get `expectedDeliveryAt: null` and are absent from on-time reporting.

**L11 — Rotation-cycle phase jumps at the year boundary.** `rotationWeek = weeks[(isoWeekNumber(serviceDate) - 1) % numWeeks]` (`food-service.ts:404-408`) with no cycle-anchor column, so a 3-week rotation skips a week and a 4-week rotation repeats one across 1 January. Menu-variety only; every consumer resolves consistently.

**L12 — Assorted validation and consistency gaps.** Rotation writes accept arbitrary `dayOfWeek`/`rotationWeek` and any string as `effectiveFrom` (`food.ts:2252-2257`); `PUT /menu-rotation/:id` skips the portion-rule and composition-rule guards its two siblings enforce (`:2592-2640`); side dishes are not validated against `dish_side_options` (`:2422-2431, 2510-2519`); client and server pick a *different* composition rule when a kitchen override exists, and the client comment falsely claims parity (`menu-lib.ts:98-106` vs `food-service.ts:585-602`); quick/bulk dispatch skip the agency-serves-this-kitchen check (`food-ops.ts:1101-1106`) that `POST /dispatches` enforces; wallet balances are computed with JS floats and written back verbatim into unbounded `numeric` columns (`wallet-service.ts:77-82, 131-151`; `schema/wallet.ts:27, 42-44`), which leaks into the staff-facing refund instruction (`wallet.ts:948, 988`).

---

## What is missing

**Tests.** Five test files exist repo-wide outside `node_modules`: three audit, one food backend, one food frontend. `apps/api-server/src/lib/__tests__/food-composition.test.ts` imports only `buildCompositionVerdict` and `validateMenuAgainstRule` — pure slot-matching functions with no DB. Nothing imports `canTransition`, `computeOrderItems`, `resolveAccessiblePropertyIds`, `checkOrderCutoff` or `residentsCapForProperty` in any test. The `null` vs `[]` distinction in `resolveAccessiblePropertyIds` **is** the multi-tenancy boundary and is asserted nowhere; a regression turning `[]` into `null` would make every scoped role org-wide with a green CI run. Highest-value additions (all pure, no DB): every `ORDER_NEXT` edge including explicit "terminal states accept nothing"; `resolveAccessiblePropertyIds` with a mocked db covering ALWAYS_GLOBAL → null, scoped → exact ids, scoped-with-no-rows → `[]`, plus a `BROAD_FALLBACK` membership assertion so the `ae42b5a` FNB_MANAGER removal cannot be silently reverted; `computeOrderItems` rounding / skip-unpriced / `isQtyLocked` override; `checkOrderCutoff` + `residentsCapForProperty` against a fixed clock.

**Schedulers.** `apps/api-server/src/index.ts:50-79` starts SLA (complaints), finance billing and five audit jobs. There is **no food import in the file at all**. Missing: a trip reconciler (closing LOADING/IN_TRANSIT trips whose orders are all terminal — see M2); a pre-cut-off reminder for properties with no order (`GET /next-orders` at `food-ops.ts:3065` already computes the `NOT_ORDERED` state, but only on demand when a human opens the page); a post-cut-off miss escalation (the hardcoded escalation contact at `food-dashboard.tsx:41` is standing in for it); and any retention for `food_order_events`.

**Observability.** The pino request serializer returns `{ id, method, url.split('?')[0] }` (`app.ts:20-25`) — query string deliberately stripped, no user field — and `grep -rn 'log.child\|req.log ='` across `apps/api-server/src` returns nothing, so no middleware attaches `req.user`. Food handlers log a bare `req.log.error(err)` (150 occurrences). A failed order placement produces a log line with no userId, role, propertyId, mealType or serviceDate. Two counter-examples prove the pattern is available and unused (`food.ts:1101`, `food-ops.ts:1323`).

**Error semantics.** All 150 food handlers terminate in a local `catch → 500`, so `app.ts:83-94`'s `{statusCode, details}` convention is structurally unreachable from this module. `deniedKitchen` (`food.ts:2121-2131`) works around it inline and its own comment names the problem. Only two `throw new` statements exist across both routers; one of them — `createDispatchForOrders`'s defence-in-depth guard (`food-ops.ts:935`) — surfaces a retryable conflict as "Internal server error".

**Delivery proof.** `confirmDeliverySchema` is `{ items?: [...], remarks? }` (`food.ts:1299-1305`) — no photo, no OTP, no signature, and `items` is optional, so an empty body flips the order to DELIVERED with every `receivedQty` NULL. No spec in the repo requires proof, so this is a product gap rather than a regression — but combined with C3 it means an order can reach a terminal, unreconcilable state through three different paths.

**Suppression has no operator surface.** A single SES permanent bounce or complaint adds an address to `notification_suppressions` (`webhooks.ts:83-93`) permanently — the table has no expiry or active flag (`schema/system.ts:131-145`) — and `processDelivery` closes the row out as SKIPPED without raising anything (`process.ts:29-35`). A repo-wide grep finds no list, delete or un-suppress route and no UI. A unit lead with a full mailbox for one day loses order-lifecycle email forever.

**Menu-share tokens never expire.** `food_menu_shares` has no `expiresAt`, `revokedAt` or usage counter (`schema/food.ts:821-839`) and the public handler does no time check (`food-ops.ts:1673-1697`); `share.menuDate ?? new Date()` (`:1678`) makes an undated share a permanent window onto today's live menu. Payload is brand/date/property/city/dishes — no PII — so impact is low, but there is no revocation path. Related: `APP_BASE_URL` defaults silently to `""` (`food-ops.ts:85`) and `config/env.ts` — the fail-closed module — reads it only as a CORS fallback (`:137`), so an unset var produces `/m/<uuid>` relative links in outbound messages with no boot error.

---

## Flow-by-flow assessment

| Flow | Rating | Where it breaks |
|---|---|---|
| **Place order (batch)** | ⚠️ Fragile | Works. Breaks on: no `db.transaction` around batch/order/items/event (`food-ops.ts:1453-1534`); client-controlled `orderedQty`/`unit` with a lower bound only (`:1494-1502`); `201 + confetti` when zero orders were created (`:1539` + `food-dashboard.tsx:650-674`); dedupe is a check-then-insert with no covering constraint (`:1421-1437`); an unpriced or off-menu dish is dropped silently. |
| **Place order (legacy `POST /orders`)** | ❌ Broken | No dedupe, no 120% cap, `residentsCount` unbounded and unsigned (`food.ts:464-514`), three un-transacted writes, and `if (computed.length)` means an unresolvable menu returns 201 with a zero-item order. No frontend caller, but the endpoint is live and gated identically. |
| **Kitchen accept / reject** | ⚠️ Fragile | Correct in isolation. Breaks on: SELECT-then-blind-UPDATE with no status predicate and no transaction (`food-ops.ts:839-869`); "Accept all" on Kitchen Summary silently operates on the first 100 orders and then celebrates (`food-kitchen-summary.tsx:113, 190-219`) while the unpaginated cook plan counts them all. |
| **Dispatch** | ❌ Broken | Trip creation re-checks status without a lock and checks the vehicle **outside** the transaction (`food-ops.ts:932-936, 1075-1078, 1116`). A LOADING trip can never be finalised — the transition guard silently no-ops (`:1259-1261` vs `schema/food.ts:133`) — stranding the vehicle as busy. Cancel reverts with an undeclared transition and orphans delivered orders (`:1298-1303`). Quick/bulk dispatch skip the agency-serves-kitchen rule. The board renders every write control to four view-only roles. |
| **Deliver / receive** | ❌ Broken | The core defect. Two dispatch-side paths terminate the order without `receivedQty`, without `FOOD_CONFIRM_DELIVERY`, and without the shortfall complaint (`food-ops.ts:1200, 1245`), after which `confirm-delivery` 422s forever (`food.ts:1316`). The per-order toggle has no `canTransition`, so DELIVERED→DISPATCHED→DELIVERED mints unbounded duplicate `TKT-` complaints. Over-preparation makes the legitimate path unsubmittable (`food.ts:1325` vs `food-dashboard.tsx:1455`). Trip delivery sends no notification. |
| **Waste** | ⚠️ Fragile | Functional. Breaks on: the DELIVERED notification instructs users into a guaranteed 422 for the entire hour it names (`notification-service.ts:238` vs `food.ts:1444`); no upper bound so waste is rewritable indefinitely with a contentless audit note; the cap falls back to `orderedQty` for trip-delivered orders whose `receivedQty` is NULL (`:1458`). |
| **Menu rotation** | ⚠️ Fragile | The write path is the best-guarded surface in the module (`deniedKitchen` on all five writes). Breaks on: a soft-deleted dish keeps resolving forever (`food-service.ts:425`); deleting a portion rule silently drops the dish from every order (`food.ts:2734`); `resolveMenu` derives the day of week host-locally (`food-service.ts:294-306`); `PUT /dishes/:id` prunes rotation rows network-wide with no kitchen filter (`:1855-1864`); `PUT /menu-rotation/:id` skips both guards its siblings enforce. |
| **Reports / exports** | ❌ Broken | Variance/waste/on-time CSV and PDF download the **orders** dataset under a report-specific filename (`food.ts:1695-1697` shadowing `food-ops.ts:2755-2760`). Quantity totals sum grams with plates. Waste and headcount aggregates include CANCELLED orders. Trip-delivered orders read as 100% shortfall. Date windows are time-of-day dependent and the waste range overshoots by a day. Collections re-attribute when a resident transfers. `/food/revenue` returns 5 months on the 31st. |
| **Menu planning / recipes / production (`kitchen.ts`)** | ❌ Broken | Zero property scoping across 19 endpoints; cross-tenant read and write. `generate-indent` bypasses the INDENTS module and emits an item shape procurement cannot read (₹0, blank names). The page is permanently blank for `KITCHEN_MANAGER` and `FNB_MANAGER` — its two intended personas. |
| **Notifications** | ❌ Broken | Default deployment discards everything while recording `SENT`. `REDIS_URL` disables delivery entirely. The documented SMTP remedy hard-fails. Inline delivery is single-attempt and terminal. No un-suppress path. |
| **Access control (scopes)** | ❌ Broken | See C4 — two of five scope levels unresolvable, the seed re-issues them, revoking a grant escalates, CITY resolves empty in the current data, two divergent geo spines, and no UI can grant or inspect any non-unit-lead scope. |

---

## Recommended remediation order

### Stop the bleeding (do before any further rollout)

1. **Razorpay idempotency** — key on `pay.id` only with `referenceType='RAZORPAY_PAYMENT'`; handle one event type; add `UNIQUE (reference_type, reference_id)` on `wallet_transactions`. *(`webhooks.ts:196-197, 311`)*
2. **Reversal direction** — remove `"REFUND_WITHDRAWAL"` from `isCreditType` and add an explicit direction column; narrow the `creditWallet`/`debitWallet` unions. *(`wallet.ts:1165`, `wallet-service.ts:62-66, 114-119`)*
3. **Scope-level integrity** — reject `ZONE`/`CLUSTER` at `POST /food/scopes` (or implement both, mirroring `audit-access.ts:116-134`); delete the half-applied CLUSTER branch in `resolveAccessibleKitchenIds` if not implementing; fix `seed-food.ts:414/420/431/439`; make `DELETE /scopes/:id` a soft revoke; drop the `BROAD_FALLBACK` fall-open. *(`food-service.ts:135-181, 230-239`)*
4. **`assign-brand` / `assign-kitchen`** — add `isAccessible(:id)` and `assertKitchenAccess(body.kitchenId)`, or restrict to `isSuperAdmin`. *(`food-ops.ts:791-809`)*
5. **Delivery separation of duties** — require `FOOD_CONFIRM_DELIVERY:edit` for any write that sets `status = 'DELIVERED'`; add `canTransition` to the per-order toggle and drop the `delivered:false` revert; exclude NULL-`receivedQty` orders from the variance denominator. *(`food-ops.ts:1192-1203, 1222-1251`, `food.ts:1307`)*
6. **`kitchen.ts` scoping** — resolve scope in all 19 handlers; gate `generate-indent` on `INDENTS:create`; fix the indent item shape to `{ itemName, estUnitPrice, … }`; wrap the indent number in `withUniqueRetry`. *(`kitchen.ts:115-245`)*
7. **Notification fail-closed** — gate `logProvider` on `NODE_ENV === 'development'`; catch a throwing enqueue and fall through to `processDelivery`; stop externalising `nodemailer`/`twilio`. *(`providers.ts:103-105`, `notification-service.ts:85-90`, `build.mjs:55-56`)*
8. **Export shadowing** — delete `food.ts:1694-1705` and let `serveReportExport` own csv/pdf/xls. Add a route-collision assertion test.

### Structural

9. **DB constraints** (one `drizzle-kit push`): partial unique on `food_orders(property_id, meal_type, service_date) WHERE status NOT IN ('CANCELLED','REJECTED')`; unique on `food_meal_windows(brand, meal_type, property_id)` + a partial for the global rows; the same NULL-aware pair for `food_cutoffs`; unique on `per_resident_rules(brand, meal_type, dish_id, property_id)`; unique on the `food_menu_rotation` slot key; and CHECK constraints `residents_count >= 0`, `staff_count >= 0`, `ordered_qty >= 0` etc.
10. **Transactions** — wrap batch/order/items/event; `PUT /orders/:id` header + rescale; `PATCH kitchen-items` loop + reason event; and make every lifecycle transition a conditional `UPDATE … WHERE status = $expected RETURNING *`.
11. **Shared guards** — lift dedupe + `residentsCapForProperty` into one helper used by both order-creation paths; call `deniedKitchen` (or an `isAccessible` equivalent) on composition rules, cut-offs, meal windows and per-resident rules; add `eq(dishesTable.isActive, true)` to `resolveMenu`'s join.
12. **Report semantics** — one status convention (`DELIVERED` for received/wasted, non-cancelled for ordered/people) shared by `/analytics`, `/waste-analytics`, `/home-analytics` and `/reports/variance`; group every quantity aggregate by unit; normalise both ends of every date window to IST calendar days with a single helper; snapshot `property_id` on `payments`.
13. **Trip reconciliation** — have `confirm-delivery` re-evaluate its trip inside the same transaction (the logic already exists as `markTripDelivered`, `food-ops.ts:1256-1266`), fix the LOADING no-op, and add a food scheduler alongside the existing ones for stale trips and pre-cut-off reminders.
14. **Timezone** — route `isoDayOfWeek`/`isoWeekNumber`/`resolveExpectedDeliveryAt` through the IST helpers so correctness stops depending on `TZ`.

### Hardening

15. **Indexes** — `food_order_items(order_id)`, `food_order_events(order_id, created_at)`, `food_orders(property_id, service_date)`, `(status)`, `(dispatch_id)`, `(batch_id)`, `(created_at)`.
16. **Error surfacing** — re-throw when the error carries a `statusCode` so `app.ts`'s handler runs; give `createDispatchForOrders`'s guard `statusCode = 422`.
17. **Frontend gates and error states** — `can(MODULE,"edit")` on `food-dispatch`, `food-settings` and `food-organization` (copy `food-agencies.tsx:60`); read `isError` on the primary query of the five large pages; page the boards (copy `food-kitchen-home.tsx:379-398`); guard the batch `onSuccess` on a non-zero order count.
18. **Observability and audit** — `req.log.child({ userId, role, propertyId })` after `authenticate`; a `logFoodAudit` wrapper mirroring `wallet-service.ts:180-196` on every master-data and config mutation, storing the prior row on deletes; a PENDING/FAILED outbox count on `/healthz`.
19. **Bounds and validation** — `z.enum` for every field backed by a pg enum; `HH:MM` regex on cut-off/service times; upper bounds on `orderedQty`, `personsCount`, `staffCount`, `quantity`; escape LIKE metacharacters and push the scope predicate into the WHERE on `/orders/track`.
20. **Tests** — the four pure-function suites listed under "What is missing", plus one integration assertion that `GET /reports/export.csv?report=variance` returns the variance dataset.
21. **Cleanups** — drop `PREPARING` and `preparingAt`; reconcile the DELIVERED notification text with the waste cool-down; fix the Cut-offs empty state; switch Service Times to `useActiveBrands()`; generalise the scope-management tab to all nine food roles; add expiry/revocation to menu-share tokens and validate `APP_BASE_URL` in `config/env.ts`.

---

## Appendix: review methodology and coverage limits

**Method.** Ten parallel review dimensions (authz, injection/input-validation, transactions/concurrency, lifecycle/state machine, money, contract/frontend-backend, menu engine, dispatch, gaps, data integrity) plus a targeted gap round covering four surfaces no dimension had opened. Each raw finding was independently adversarially verified by two verifiers who were free to refute it; 130 survived. This synthesis deduplicated them to 54, re-ranked by real-world risk, and re-opened the cited files for the twelve highest-risk items.

**Personally re-verified for this document** (files opened and read, not inherited): `webhooks.ts:180-330`; `wallet.ts:940-960, 1145-1195`; `wallet-service.ts:60-155`; `food-ops.ts:591-598, 759-786, 785-812, 930-960, 1155-1270, 1348-1365, 1418-1440, 1484-1540, 2725-2770`; `food.ts:1296-1420, 1436-1475, 1626-1706, 2020-2032, 3355-3405`; `food-service.ts:100-200, 225-245, 291-308, 388-430`; `kitchen.ts:110-250` plus the scope grep (count 0); `permissions.ts:36-42`; `routes/index.ts:91-92`; `schema/food.ts:686-760`; `providers.ts:80-113`; `process.ts:20-55`; `queue.ts:24-55`; `notification-service.ts:80-95, 232-245`; `build.mjs`; `seed-food.ts` scope block; `food-organization.tsx:98-110, 395-417`; and the `isError` counts on the five large food pages.

**Confirmed negatives** (checked, and *not* defects — recorded so they are not re-litigated):

- **No backend/frontend RBAC matrix drift.** `const VE = FULL` (`permissions.ts:40`), so `VE` and `FULL` are the same object. All 12 `FOOD_*` modules × 21 roles agree between the two files.
- **No SQL injection.** Repo-wide grep for `sql.raw` / `sql.identifier` across `apps/api-server/src` returns zero. Every `sql\`\`` interpolation inspected is a drizzle column object or a bound parameter; the only dynamic ordering is an allow-listed ternary.
- **No CSV/XLS formula injection.** `export-service.ts:75-79` prefixes `= + - @ \t \r` with `'` and XLS emits every cell as `ss:Type="String"`. Filenames go through `sanitizeForFilename` which collapses `\s+`, so no header injection.
- **No frontend call targets a missing route.** Every `/food/*` URL in `lib/food-api.ts` (877 L, read in full) resolves to a real handler; method+path overlap between the two routers is exactly two entries, both covered in H2.
- **Route shadowing has no authz consequence.** Both the live and dead copies of the two shadowed export routes carry the identical `requireRoles("SUPER_ADMIN","OPS_EXCELLENCE")` chain.
- **No scheduler mutates food tables**, so there is no scheduler-vs-request race in this module.
- **The food module moves no money directly** — no price/cost column exists in `schema/food.ts` and no food route imports `wallet-service`. `orderedQty` is the cost proxy, which is why H6 is ranked where it is.
- **Cut-off is enforced server-side** on both placement paths and on PLACED edits, not display-only.
- **`PUT /order-draft` uses `onConflictDoUpdate`** on its unique index — no race.
- **No fan-out multiplication** in the report joins: `/kitchen-summary`, `/reports/variance`, `/waste-analytics` and `/home-analytics` all sum item-level columns over a 1:N join, and order-level counts use `count(distinct)`.
- **`PUT /system-config/food-defaults` and `PUT /settings/ontime-tolerance`** are registered `authenticate`-only but run `isSuperAdmin` in-handler *before* `validateBody`. Safe.
- **`POST /orders/:id/cancel`** has no `authorize()` middleware but performs a correct inline `can()` check plus a scope check.

**Coverage limits — where this review could not reach a conclusion:**

- Nothing was executed against a running server. Express matching for the shadowed export paths is inferred from mount order (`routes/index.ts:91-92`), not observed. Race conditions are derived from reading the statement sequence and confirming the absence of a covering constraint, lock or conditional WHERE — none were reproduced.
- The live dev database *was* queried for the scope findings (C4b, C4e, C4f) and those DB claims are first-hand. No other environment was inspected, and the Razorpay dashboard's subscribed-event configuration (the trigger for C1) could not be verified from the repo.
- Index/performance claims (L1, L2, H11) are reasoned from the declared schema and query shapes. No `EXPLAIN` was run and no table row counts were measured, so the volume thresholds in those findings are projections.
- `finance.ts` and the billing-cycle scheduler were not read, so whether `ledger_entries` amounts are themselves computed with floats is unknown. The `notify-service` worker was read; its deployment (absent from `docker-compose.yml`) was confirmed from the compose file and `.env.docker.example:133`.
- Doc-vs-code claims were verified first-hand against `Persona-Unit-Lead.md` and `DEPLOYMENT.md`. Claims referencing `FOOD_MODULE_TEST_CASES.md`, `FOOD_API_TESTING_MAP.md`, `FOOD_DB_PLAN.md` and `SERVICE_SET_REDESIGN.md` are second-hand from the dimension reports and should be re-checked against those files before being cited externally.
- Several large frontend files were read only in the regions relevant to a finding, not end to end: `food-dashboard.tsx` (88k), `food-order-detail.tsx`, `plate-composer.tsx`, `menu-rules.tsx`, and the `shared-menu` / `food-my-properties` / `unit-lead-home` pages. Further contract mismatches may exist there.
- The full bodies of the analytics handlers (`food-ops.ts:1788-2760`) were not traced aggregate-by-aggregate for scope-after-filter ordering bugs; each was confirmed to call `resolveAccessiblePropertyIds` and push the scope condition.
- `notification_suppressions`, menu-share token lifetime and `APP_BASE_URL` were verified in code but their production impact depends on deployment configuration not present in the repo.
