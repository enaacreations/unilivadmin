# Food module fix — final verification status

**Branch:** `dev-food-module-fix` — **still zero commits**; everything is uncommitted working-tree
state (`git log dev..HEAD` is empty). 81 tracked files changed vs `dev` (+9333 / −2181), plus 20
untracked new files.
**Baseline:** `FOOD_MODULE_ANALYSIS.md`, 52 numbered defects (C1–C6, H1–H12, M1–M22, L1–L12).
**Method:** four rounds of fixes, each followed by independent re-verification. This document
records the state after the final round, in which every check below was executed rather than read.

---

## Verdict

**Merge, with the follow-up list below tracked as real work.**

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

Runtime state is genuinely healthy: `pnpm run typecheck` is clean across all 5 projects with **zero
TS suppressions**, **279 API tests** and **14 web tests** pass, the API boots from its built bundle
and serves all nine required food endpoints with **zero 500s and zero error-level log lines**, the
variance CSV export returns the variance dataset, `push` is convergent, all four deploy scripts are
idempotent, the two-step seed produces an orderable menu, and the frontend builds.

What keeps this from being "done" rather than "shippable" is the follow-up list: it is shorter and
much less severe than in previous rounds, but it is not empty, and two of its entries (the
`verifySns` bare catch, and the still-absent zones/clusters UI) are the kind of thing that is
easiest to fix now and hardest to notice later.

---

## Verification run — every check, with its actual result

| # | Check | Result |
|---|-------|--------|
| 1 | `pnpm run typecheck` (5 projects) | ✅ **clean.** Zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` in `apps/**/src`, `lib/**/src`, `scripts/src`. |
| 2 | `pnpm --filter @workspace/api-server run test` | ✅ **279 passed / 12 files** (baseline was 194; +85). No test deleted or skipped. |
| 3 | `pnpm --filter @workspace/uniliv-admin run test` | ✅ **14 passed / 1 file** (`food-api.test.ts`). |
| 4 | Build + boot from `dist/`, log in, hit 10 endpoints | ✅ **all 200, zero 500s.** Details below. |
| 5 | Dynamic imports left in `dist/index.mjs` | ✅ **3, all allowlisted.** Details below. |
| 6 | `pnpm --filter @workspace/db run push` ×2 | ✅ **both `No changes detected`.** Also convergent after a real DDL change (see B0). |
| 7 | Four deploy scripts ×2 | ✅ **all exit 0, second run mutates nothing.** Perturbation tests below. |
| 8 | `seed:food` → `seed:food-extra` → resolve a menu | ✅ **3080 per-kitchen rotation rows; menu resolves non-empty for all three meals.** |
| 9 | Frontend production build | ✅ **exit 0**, 4217 modules, `dist/public` emitted. Warnings only (chunk >500 kB, sourcemap noise) — pre-existing. |

### 4 — API smoke test (built bundle, `RUN_SCHEDULERS=false`, port 8123)

Login is two-step: `POST /api/auth/login` returns a **random per-challenge `devOtp`** (observed
`719876`, then `934712` — it is not `000000`), redeemed at `POST /api/auth/verify-otp` with the
field name **`code`** (not `otp`).

| Endpoint | Status |
|---|---|
| `/api/healthz` | 200 |
| `/api/food/dashboard` | 200 |
| `/api/food/orders` | 200 |
| `/api/food/kitchen-summary` | 200 |
| `/api/food/analytics` | 200 |
| `/api/food/hierarchy` | 200 |
| `/api/food/my-properties` | 200 |
| `/api/food/next-orders` | 200 |
| `/api/food/dispatches` | 200 |
| `/api/food/reports/export.csv?report=variance` | 200 |

Zero `level:50`/`level:60` lines in the server log across the whole run.

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

### 8 — Seed pair

`seed:food` alone leaves `food_menu_rotation.kitchen_id` NULL on all 385 rows (brand-level
templates), and `resolveMenu` requires an exact non-null kitchen match — so `seed:food` alone
**cannot** serve an order. `seed:food-extra` materialises **3080 per-kitchen rows**, after which:

```
GET /api/food/menu-rotation/resolve?propertyId=…&mealType=LUNCH&date=2026-08-07
→ 9 dishes: Mix Vegetable (SABZI/KG), Dal Tadka (DAL/LITRE), …
BREAKFAST → 6 dishes · LUNCH → 9 · DINNER → 8
```

This is the documented two-step pair, not a bug — but `seed:food`'s own output still does not say
so (see follow-up 8).

---

## Findings table — final status

**Counts: 48 FIXED · 4 PARTIAL · 0 NOT_FIXED** (of 52). All 6 regressions introduced by earlier fix
rounds (B0–B5) are closed; B6 remains a recorded product decision.

| # | Finding | Status | Note |
|---|---------|--------|------|
| C1 | Razorpay webhook credits the same money twice | **FIXED** | Link cap persisted and clamped; dues no longer keyed on `linkId`; legacy `RAZORPAY` namespace migrated by script. Now covered by 29 tests in `webhook-idempotency.test.ts` (instalments, legacy links, unattributable money). |
| C2 | Reversing a checkout refund debits the wallet twice | **FIXED** | `WALLET_TXN_DIRECTION`; `CreditTxnType` makes the original mistake a compile error; frontend derives sign from the row delta. *No direct unit test — see follow-up 5.* |
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
| L12 | Assorted validation and consistency gaps | **PARTIAL** | `roundMoney` applied everywhere including `wallet.ts:757,772`. **Residual:** money columns still carry no precision/scale (`schema/wallet.ts` `numeric` with no `(12,2)`), so the invariant is enforced only in application code. |

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

---

## Before you merge — checklist

Everything previously listed as blocking is done. What remains is process, not code:

- [ ] **Split the commit by path.** This is now the single largest risk in the change. There are
      **zero commits** on the branch and unrelated audit work is interleaved in the same working
      tree — `audit-*.ts`, `audits/*.tsx`, `schema/audit.ts`, `components/layout.tsx`, `lib/nav.ts`,
      `apps.tsx`, `AUDIT_PRD_GAP_ANALYSIS.md`. It is separable file-by-file; separate it before
      committing, or the food fix and the audit work become one unrevertable change.
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

Honest and complete. Nothing here blocks merge; the ordering is by how much it would cost to
discover later.

**Observability / correctness-adjacent**

1. **`verifySns`'s bare `catch` cannot distinguish a forged signature from a broken deployment**
   (`webhooks.ts:50-66`). A missing module, an unreachable `SigningCertURL`, and a genuinely forged
   envelope all return the same 403 with no log line. This is exactly what made H3c invisible for
   three rounds — the bug was fixed but the *detector* was not. I confirmed the limitation during
   this round's smoke test: a bogus SNS envelope returned 403, which is correct, but that response
   is identical to the one the broken build produced. Conclusive proof had to come from bundle
   contents instead. **Log the caught error and distinguish infrastructure failure from rejection.**
2. `wastePct` is computed against two different denominators depending on surface — `wasted/received`
   via `wastePctOf` (`food-ops.ts:3153,3342,3353,3417`) but `wasted/ordered` at `:3076`, `:3114`,
   `:3625`. The comment at `:3137` documents the first as intentional; either way two numbers labelled
   "waste %" disagree. Pick one, or label them differently.
3. `POST /orders` answers 500 on a nameless 23505 (`food.ts`) where its batch sibling handles it.

**Money**

4. `wallet_transactions.amount` / `balance` are `numeric` with no precision/scale (`schema/wallet.ts`).
   The 2-decimal invariant lives only in `roundMoney`; the database would accept anything. (L12 residual.)
5. **No unit test for `wallet-service.ts`.** The webhook settlement paths are now well covered (29
   tests), but `roundMoney`, `WALLET_TXN_DIRECTION` and the C2 reversal direction — the defect that
   double-debited a wallet — have **zero** direct coverage on either side (`grep roundMoney` over both
   `__tests__` trees returns nothing). This is the highest-value test still missing.

**Product surface**

6. **Zones, clusters and property→cluster wiring still have no UI** (`food-organization.tsx` has four
   tabs: Hierarchy, Brands, Agencies, Access — no create affordance for zones or clusters). The API
   supports all of it and the seed creates 2 zones / 9 clusters, so the org spine can only be
   changed by a script. This is the largest remaining product gap in the module.
7. `/reports/variance`'s `unconfirmed` split ships only in the export — no page calls
   `foodApi.reportsVariance`, so the C3 signal is invisible in the UI.
8. `seed:food` alone leaves the module unable to serve an order and does not say so. One line of
   output pointing at `seed:food-extra` would have saved a reviewer a false CRITICAL last round.

**Tooling / hygiene**

9. `scripts/src/seed-kitchen-managers.ts:80` and `seed-food.ts` hard-DELETE `user_scopes` rows while
   H5 made revocation a soft `isActive` flag. Harmless for seeds (they re-create what they delete),
   but pointed at a live database they would erase revocation history.
10. `scopeCrumbs` (`nav.ts:48`) is dead code — and it will ship with the **audit** commit, not this
    one. Flagged for whoever splits the tree.
11. `/reports/export.:fmt` (`food-ops.ts:4422`) is still shadowed by the four explicit
    `.csv`/`.pdf`/`.xls`/extensionless registrations above it. Harmless now (all five carry the same
    guard and the shadowing is documented at `:4211`), but it is the exact shape H2 started from and
    a future format would silently take the wrong branch.

---

## Notes for the next reader

Three things about this verification worth carrying forward:

- **A script that finds nothing to do has not been tested.** Every one of the four deploy scripts
  passed its first run trivially. Only after reproducing the state each was written for — dropping
  the column, revoking the grant, inserting legacy-namespace rows — did they demonstrate anything.
  All perturbations were restored and the restoration verified against a snapshot.
- **Black-box tests cannot see through a bare `catch`.** The `sns-validator` fix could not be proved
  by calling the webhook, because the broken and fixed builds return the same 403. It was proved by
  bundle contents plus booting from a directory with no `node_modules` above it. Follow-up 1 exists
  so the next person does not need that trick.
- **`push` convergence is a usable drift signal now, and it is load-bearing.** Two consecutive
  `No changes detected` runs, and a third after a real `SET NOT NULL`. But any unmanaged table in
  `public` will trip the data-loss banner — as my own scratch table did.
