# Access Controls — build status

Against `~/.claude/plans/based-on-this-please-gentle-mitten.md`. Branch `dev`, **uncommitted**.

## State: the engine is built, verified against live data, and behind a flag

```bash
pnpm run typecheck                       # clean (see "known failures")
pnpm --filter @workspace/api-server test  # 649 passed, 4 failed (pre-existing)
```

**Known failures, none of them from this work:** `audit-scope-rule.test.ts` (4 tests) and
`scope-picker.tsx` are untracked files for a `within` narrowing feature never implemented in
`audit-scope.ts`. `scripts/src/id-migration/catalog.ts` typecheck errors belong to the
concurrent ID-migration session. Test count went 585 → 649; all 64 new tests pass.

## The cutover flag

`ACCESS_RESOLVER` in `apps/api-server/src/config/env.ts`, **default `legacy`**.

- `legacy` — `user_scopes` + `audit_role_grants`, exactly as shipped today.
- `next`   — the unified `org_nodes` / `access_grants` resolver.

Default is legacy deliberately: the new resolver reads tables that only exist where the
projection and backfill have run. Flipping it by default would mean any environment that
hadn't run them resolves every user to *no access* on deploy.

Two cutover points, both one-line delegations, so **none of the ~90 call sites changed**:
`food-service.ts resolveAccessiblePropertyIds` and `audit-access.ts resolveAuditAccess`.

## Verified on the live dev database

| Check | Result |
|---|---|
| `drizzle-kit push` | applied; **second run "No changes detected"** — the drift signal is intact (R6) |
| Columns lost | **0** (1499 → 1569; snapshot-diffed) |
| `verify:schema` | 144 tables, 1569 columns, pass |
| Projection | 1 company, 2 zones, 7 cities, 9 clusters, 6 kitchens, 5 properties, 50 rooms; 431 closure rows, 5 SERVES edges |
| Grants minted | 20 from `user_scopes`, 24 from audit grants, 2 PRIMARY, 4 org-wide |
| **Food equivalence, all 32 active users** | **0 divergences** |
| **Audit equivalence, all 32 active users** | **0 divergences** |
| **Flag off vs flag on, through the public resolvers** | **byte-identical** |

## Three bugs the verification caught — two of them mine

1. **Backfill promoted every regional role to org-wide.** I minted organization-scoped grants
   from `authz.ts`'s `ORG_WIDE_ROLES`. That set means "the *generic* helper doesn't restrict
   this role" — its own comment says the food roles are listed there *because the food module
   does its own scoping*. Every `FNB_MANAGER`, `CLUSTER_MANAGER` and `CITY_HEAD` got the whole
   estate. Diverged for 14 of 30 users. This is exactly the R3 risk the plan names
   ("do not let the code silently pick a winner" among the four role taxonomies) and I walked
   straight into it.
2. **Module grants leaked into the global scope.** An `AUDIT.VIEWER` org-wide grant was making
   the *food* scope unrestricted. Fixed by the rule that a grant whose `roleKey` names a module
   role confers access inside that module only (`GENERAL_ROLE_KEY` in `access.ts`).
3. **Closure tables flatten paths.** Deactivating an *intermediate* cluster did not remove the
   `city → property` row, so a retired cluster kept conferring access — a divergence from
   `expandZonesToCities`, which stops dead at an inactive node.

Plus two caught before they shipped: per-module action sets would have revoked `create/edit/delete`
from the parity roles (`actionsFor()` is now purely additive), and a require cycle in the audit
adapter.

## Findings in your data

- **2 users would lose access** if the *generic* helper moves to the new resolver:
  `cx@uniliv.com` (CUSTOMER_EXPERIENCE) and `warden@uniliv.com` (WARDEN) have no `propertyId`
  and no scope row. They are unscoped *today* because `isPropertyScoped()` requires a non-null
  value. **This does not block the current cutover** — both resolve identically under food and
  audit — but it gates Phase 9. Give them a grant or accept they see nothing.
- **2 kitchens have no `cityId`** (`Noida Sector 104`, `Jaipur Sitapura`) so they are absent
  from the projection and reachable by no city or zone grant.
- **0 of 50 employees match a user by email**, so TEAM/SELF data scope has no data to walk.
  The link column exists; the identities don't line up.
- The push also applied **pre-existing drift** — columns already declared in merged code that
  the DB lacked (`dishes`, `ingredients`, `food_meal_config`, `menu_*`, `form_drafts`).

## Enforcement burn-down: COMPLETE

Every one of the **518 mounted routes** is now classified, and the "NOT YET SCOPED" list is
empty. `src/__tests__/route-coverage.test.ts` walks the real express stack and fails the build
if a new route is added without answering "does this need property scoping?".

| File | What it was | Now |
|---|---|---|
| `rooms` | `GET` unfiltered, `POST` accepted any propertyId | scoped |
| `employees` + attendance | `EMPLOYEES:view` leaked every employee everywhere | scoped via employee join |
| `operations` (11 handlers) | omitting `?propertyId` returned everything | `effectivePropertyFilter` |
| `dashboard` | org-wide KPIs; headcount/leaves ignored the filter entirely | scoped |
| `users` | listed every account in the company | scoped |
| `finance` | ledger/expenses/summary org-wide | scoped (+`propertyScopeOrGlobal`) |
| `sales` | leads org-wide; convert could target any property | scoped |
| `procurement` | indents/GRN/inventory org-wide; writes took body propertyId | scoped + `assertWritableBody` |
| `kyc-esign` | identity docs + signed agreements across properties | 9 guards via resident |
| `audit-reviews` | queue showed every SUBMITTED audit | `resolveAuditAccess` + `loadAudit` chokepoint |
| `audit-schedules` | listed org-wide | `visibleAuditTypes` |
| `audit-admin` | **no grant guards at all** | self-grant / GLOBAL / rank guards |

### Two write-before-check bugs found in kyc-esign

`POST /esign/:id/void` and `POST /kyc/:id/verify` **wrote first and validated afterwards**. An
out-of-scope caller's void had already been applied by the time the 404 was returned — another
property's signed rent agreement genuinely voided, with only an error page shown. Both now load
and check before writing.

### audit-admin was the cheapest escalation path

It mints AUDIT grants including ADMIN, and had none of the guards `POST /food/scopes` has
carried since it shipped: no self-grant block, no restriction on minting GLOBAL scope, no rank
check. All three added.

## Separation of duties (PRD §33) — DONE

`apps/api-server/src/lib/access/sod.ts`. Two rules, both in code — making them
runtime-editable would hand an administrator a switch that disables the control constraining
administrators.

- **Static** — `CAPABILITY_CONFLICTS`. The ship-vs-receive invariant moves out of a 20-line
  comment in two files (plus three hardcoded assertions in `permissions-sync.test.ts`) into one
  rule object, checked from a single definition. It carries its own `rationale`, which the
  matrix editor will show an admin about to create the violation.
- **Dynamic** — `assertNotSelfApproval` + an `enforceSod({entity, action, load})` middleware
  declared next to `authorize(...)`, so it is visible in the route table.
- **`sod-coverage.test.ts`** sweeps every approval-shaped route and fails the build on one
  without a check.

That sweep found **four real gaps** nobody had flagged:

| Route | Why it matters |
|---|---|
| `procurement POST /indents/:id/approve` + `/reject` | **The PRD's own §33 example.** `INDENTS:edit` covered both raising and approving, so the raiser could approve their own purchase request |
| `kyc-esign POST /kyc/:id/verify` | whoever raised the KYC could verify it — both sides are `RESIDENTS:edit` |
| `food-ops POST /orders/:id/reject` | the placer could "reject" their own order, bypassing the cancel path's rules |
| `food POST /orders/:id/confirm-delivery` | the matrix keeps shipping and receiving apart, but the two parity roles hold both — nothing stopped one dispatching a trip and certifying its own receipt |

A parity role can still override, but only **with a stated reason**, and the override is
recorded as a `SOD_OVERRIDDEN` security event. An override that leaves no trace is a hole.

## Activity trail (PRD §29) — writing

New `activity_events` table (145 tables, drift signal intact). A **third** table, because
`audit_log` has no indexes/reason/before-after split, and `audit_events` chains through ONE
global advisory lock inside every caller's transaction — routing org-wide traffic through that
makes it the write mutex of the product.

- `event` and `category` are plain **text, not pg enums**: a new event family is a registry
  entry, never an `ALTER TYPE` + deploy. That is the lesson of `audit_events.kind`.
- Chaining is **opt-in per stream** — `pg_advisory_xact_lock(hashtext(chainKey))`, so an ACCESS
  append never waits on unrelated traffic. Only ACCESS/SECURITY chain.
- Central redaction (`REDACT_KEYS`) rather than per-call-site, and `reasonRequired` enforced by
  the writer — that is how §29's "Reason where required" becomes mechanical.

**Live now:** `ACCESS_DENIED` (at the gate, so no handler can forget it), `ACCESS_PREVIEWED`,
`GRANT_CREATED`, `GRANT_REVOKED`, `ROLE_CHANGED`, `PROPERTY_ASSIGNMENT_CHANGED`,
`SOD_OVERRIDDEN`. Verified end to end: opening the preview wrote a hash-chained row.

`activity-coverage.test.ts` fails on a registered event with no producer, and *also* fails when
a blocker excuse survives after the event is wired — so the waiting list cannot go stale.

## Configurable matrix (PRD §22/§25/§30) — backend DONE

**Hybrid, as decided.** The *vocabulary and ceiling* stay in code — which modules and actions
exist, and which cells may ever be granted. Only WHICH cells a role holds is editable. Fully
DB-driven would turn privilege escalation into one authenticated POST; today it takes a code
review by someone who reads `ROLE_PERMISSIONS`' hundred lines of load-bearing comments, and no
admin form conveys those.

**Seeded and live:** 22 roles, 311 cells. `can()` now reads the database.
`matrixSource: "db", matrixVersion: 1` is logged at boot.

**The acceptance test:** all **4752 legacy cells** (22 roles × 53 modules × 4 actions) resolve
identically DB vs code — 0 divergences, locked in by `access-matrix-parity.test.ts`.

Three constraints shaped it:

- **`can()` stays synchronous.** ~200 call sites, most inside express middleware that cannot
  await. So the matrix is a process snapshot refreshed out of band, never read inline.
- **A registration hook, not an import.** `matrix.ts` already imports `permissions.ts`;
  importing back would close the cycle. `installMatrixResolver()` also keeps the switch
  explicit and revertable — nothing reads the database until something installs it.
- **Fail-closed, never fail-open.** An empty table falls back to the code matrix (a fresh
  database must not lock everyone out); a load failure *after* a good load keeps the last
  snapshot rather than silently widening or narrowing.

### The guard set (`access/matrix-guards.ts`)

What replaces the code review that used to stand between an admin and a privilege change:

1. **Ceiling** — a cell outside the manifest cannot be granted, and is ignored on READ too, so
   a row surviving a module's removal grants nothing.
2. **System roles are computed** — `SUPER_ADMIN`'s cells are never stored, so "an admin edits
   the superuser into powerlessness" is impossible by construction, not merely discouraged.
3. **Protected modules** (`ACCESS_CONTROL`, `USERS`, `SETTINGS`, `FOOD_ORG`, `AUDIT_ADMIN`) —
   parity roles only. Each is a one-step route to everything.
4. **Rank** — you may not rewrite a role above your own.
5. **No privilege amplification** — you may only grant a cell you hold. Without this the editor
   *is* the escalation primitive.
6. **Self-demotion refused** — discovered otherwise by losing the screen mid-edit.
7. **Separation of duties**, checked against the POST-change state so adding one half to a role
   already holding the other is caught. The refusal carries the rule's `rationale`.
8. **Lockout prevention** — refuses a change leaving no ACTIVE user able to administer access.
9. **Optimistic concurrency** — a save against a stale version conflicts rather than clobbers.
10. **Mandatory reason**, recorded as a chained `MATRIX_CHANGED` event.

### Endpoints

`GET /access/roles` · `GET /access/matrix` (returns the ceiling alongside held cells, so the
editor can tell "could exist" from "is held") · `PUT /access/matrix` (batched + version-checked)
· `POST /access/roles` (with **clone** — the biggest lever on the PRD's "time to configure a new
role" metric; cloning never copies a cell the actor lacks).

## Per-employee overrides + access cloning — DONE (beyond the PRD)

Asked for after the PRD review: configure the matrix per role, have new hires inherit it, then
**add or remove permissions for one individual without touching the role** — and **copy one
person's whole access onto another** at onboarding.

The first two were already true (the matrix is the role-level config; capability resolves from
the role at request time, so nothing is copied at hire and a later role edit still reaches
everyone). The last two needed `access_user_permissions`.

**The model.** One row per person per cell, `GRANT` or `DENY`, with a mandatory reason and an
optional expiry. Resolution order, identical in all three consumers: **DENY beats GRANT beats
the role**. Everything not listed still resolves from the role — that is the whole reason this
is an exception table and not a cloned role, and `overrides.test.ts` asserts it directly.

**An override says WHAT, never WHERE.** A granted capability is still checked against the
person's grants, so it cannot reach a property they were never placed at (`DENY_NODE_OUT_OF_SCOPE`
still wins). Two reason codes join the contract: `ALLOW_USER_OVERRIDE`, `DENY_USER_OVERRIDE`.

**Enforced in three places, one order:**

- `decide()` — the preview and every resolver path
- `authorize()` — **now async**, reading a per-user override map cached in-process (30 s TTL plus
  explicit invalidation on write). Empty for almost everyone, so the common path is a map lookup,
  not a query. Verified live: a `DENY` turned `GET /residents` from 200 into 403 for one warden
  while an untouched module stayed 200.
- `/auth/me` capabilities — so the UI never offers a page the server will refuse.

**System roles are exempt at both ends**: `decide()` short-circuits them, and the write guard
refuses to store an override against one. A DENY the UI displayed and the server ignored would
be worse than no DENY at all.

### The guard set (`access/override-guards.ts`)

1. **Never yourself** — not even a super admin; self-service capability editing makes every other
   guard decorative.
2. **Mandatory reason** on all three transitions, including the one that *removes* an exception.
3. **System-role subjects refused** (see above).
4. **Rank** — you may not rewrite someone above your own tier.
5. **Manifest ceiling** — an override cannot invent a cell the module does not define.
6. **Protected modules** — super admin only, same list the matrix uses.
7. **No amplification** — you cannot grant a capability you do not hold. `DENY` is exempt:
   withholding is not escalation.
8. **Window sanity** — an already-expired override is refused rather than silently inert.

### Cloning access

`GET /access/clone-access/:from/:to` is a **dry run** returning role, grants and overrides
side by side with what each would replace. `POST /access/clone-access` applies it.

Two decisions worth stating: it **replaces rather than merges** (otherwise a transfer quietly
accumulates the access of every desk someone ever sat at, and the dry run names what goes away);
and every copied row is **re-validated against the actor's own authority**, never trusted because
it exists on the source — otherwise cloning is the escalation path around every other guard.

Both events are on the chained ACCESS stream: `PERMISSION_OVERRIDDEN`, `ACCESS_CLONED`.

### Endpoints

`GET /access/overrides/:userId` · `PUT /access/overrides/:userId` (one cell per call, effect
`GRANT` / `DENY` / `INHERIT`) · `GET /access/clone-access/:from/:to` · `POST /access/clone-access`.

UI: the three-state **Role / Allow / Block** control on every action row of the access preview,
a **Personal exceptions** card listing divergences with their reasons, and **Copy access from
someone**, both in the placement dialog on the preview.

### Module roles were never seeded — found through the grant UI

`access_roles` held 22 platform roles and **zero module roles**, while **24 live grants already
referenced them** (`AUDIT.AUDITOR` ×11, `AUDIT.VIEWER` ×11, `AUDIT.AUDITEE` ×2). The resolver
reads the key straight off the grant, so enforcement was correct throughout — but the grant
picker, which deliberately offers module roles only, had nothing to show.

`MODULE_ROLES` is now a code registry (same "vocabulary in code, cells in data" rule as the
matrix ceiling), seeded by `seedMatrix()` and present in the dev database. They carry NO
permission cells by design — capability comes from the person's platform role, and a module role
answers "which persona inside this module", which the module's own adapter reads. The matrix
editor therefore filters them out: a row of permanently empty checkboxes is worse than no row.

## The 13 actions are now usable

`authorize()` and `can()` widened from `Permission` to `Action`. `Permission` is a strict subset,
so **no existing call site changed**, and `PUT /access/matrix` is the first route to gate on a
non-legacy action (`configure`). A non-legacy action against the code matrix misses and returns
false — the right fallback: a route gating on `approve` before the matrix is seeded denies
rather than accidentally allows.

## Frontend enforcement — DONE (it used to fail OPEN)

`PageGuard` rendered any path `PATH_TO_MODULE` did not list. Since the mapping is a separate
hand-maintained list, forgetting an entry silently opened a page.

- **Fails closed.** An unmapped path is now a refusal. `PUBLIC_PATHS` is the explicit escape
  hatch — 8 entries: pre-auth flows, token links, the launcher, and the 403 page itself (a
  refusal page that refuses is an infinite loop that renders as a blank screen).
- **`routes.test.ts`** reads App.tsx and asserts all 88 routes are mapped or listed public, so
  fail-closed cannot lock out a real page.
- **`/auth/me` capabilities are consumed.** The web app reads the SERVED blob rather than its
  bundled matrix copy, so an admin's matrix edit reaches the UI. `staleTime` dropped 5 min → 60s:
  a revoked grant should not keep lighting up the nav.
- **`<Can>` / `useCan`** gate write controls per action, returning false while loading — no
  control is clickable before authorization is known. The matrix grid is read-only without
  `ACCESS_CONTROL:configure`.

## Resolver default — safe to ship as `next`

`ACCESS_RESOLVER` now has three modes, decided once at boot:

- **`auto`** (unset) — use the unified resolver IF the projection exists, else stay legacy and
  warn. This is what makes a `next` default safe: an environment where `syncOrgNodes()` never
  ran would otherwise resolve every user to *no access* on deploy — a total outage dressed as a
  permissions bug.
- **`next`** — forced. Does NOT fall back: a missing projection logs FATAL and stays legacy,
  because if you asked for it explicitly that is a deployment error, not something to paper over.
- **`legacy`** — as originally shipped.

Boot logs `configured / effective / orgNodes`.

## Role taxonomies — locked (R3 closed)

`role-taxonomy.test.ts` pins the four lists together, and **found a real defect immediately**:
`CUSTOMER_EXPERIENCE` was in NEITHER `ORG_WIDE_ROLES` nor `ROLE_RANK` — so it ranked 0, the
*least* privileged role in the system (nobody could be assigned it), while being unrestricted
only by accident of a null `propertyId`. Now explicitly org-wide and ranked 50. Verified: 0
resolution divergences across all 32 users after the change.

Full collapse into one table still waits on routes migrating to the async resolver; the tests
stop the lists drifting further in the meantime.

## §12 reshaping — schema + attendance workflow

Enum values **appended, never substituted** — a pg enum cannot drop a value, and live rows hold
the old ones:

| PRD | Added |
|---|---|
| §7 Property statuses | `TEMPORARILY_CLOSED`, `UNDER_SETUP` |
| §7 Property attributes | `region` (a LABEL — reach still resolves through org_nodes, adding a second hierarchy scoping also read would recreate the problem this rewrite removed), `openingDate` |
| §8 Room statuses | `PARTIALLY_OCCUPIED`, `CLEANING`, `BLOCKED`, `OUT_OF_SERVICE` |
| §8 Room status fields | `housekeepingStatus`, `maintenanceStatus`, `auditStatus` — separate columns, because a room can be occupied AND awaiting a re-clean AND overdue an audit at once |
| §16 Attendance states | `LATE`, `WEEKLY_OFF`, `HOLIDAY`, `ON_DUTY` |

**§16 workflow shipped:** self check-in/out (writes only the caller's own row, resolved from
their email), correction requests that write PROPOSED values *beside* the originals (§29 needs
the previous value; an edit that overwrote first would leave nothing to record), and manager
approval under separation of duties — the requester cannot approve their own correction.

That unblocks two of §29's thirteen: **ATTENDANCE_MODIFIED** and **ROOM_STATUS_CHANGED** now
have producers, and their blocker entries are gone (the coverage test fails on a stale excuse).

## Admin Console UI — all PRD-backed screens live

Built from the Claude Design handoff, scoped to what the PRD actually asks for. The design's
"Badges & states kit" and Forbidden-page redesign were **dropped** — neither is a PRD
requirement.

| Screen | PRD | State |
|---|---|---|
| Access preview | §31 "View Access As User" | verdict-first, 8 family rows, drill to per-action reasons |
| Permission matrix | §25 · §30 | one module × all roles; stage → guards → save |
| Grants | §30 → "Scopes" | list + create drawer + revoke/restore, reason required |
| Placement (§27) | §27 · §30 → "Property assignments" | home + additional properties, per person — a dialog on the preview, no longer its own tab |
| Organization | §30 → Organization | one tree, dual spine, drift findings |
| Activity trail | §29 | all seven capture fields + chain state |

**Two adaptations worth knowing.** The design's module list is illustrative (it has
`VISITORS`, `PAYROLL`, `MOVE_IN_OUT`; it misses several of ours) — I used our real 54 modules
grouped into its eight families, served from a new `MODULE_FAMILY` map rather than hardcoded in
the UI. And the design shows seven screens behind its own left rail; our app already has a
sidebar, so the shell is a tab strip and each screen owns its header.

### The scale problem, solved by inverting the axes

22 roles × 54 modules × 13 actions is ~15,000 cells and no grid survives that. The matrix shows
**one module with every role beneath it** — about forty cells, all answering the same question.
Verified live: staged a change, reviewed it, saved with a reason (v1 → v2, cell count 21 → 22),
then reverted it (v3) so no spurious permission was left in the database. Both saves landed on
the chained ACCESS stream with linked hashes.

### §29 rendered in full

Expanding a trail row shows User, Timestamp, Action, Entity, **Previous value**, **New value**
and the **Reason** — with `chain ACCESS · seq 8 · bc29305315bd…` beneath it.

### Grant guards (`access/grant-guards.ts`)

Nine, the union of what `POST /food/scopes` had and `POST /audit/admin/grants` lacked, plus two
neither had: no self-grant · subject must be active · org-wide is parity-only · the node must
exist **and be live** · a ROOM/BED grant cannot include descendants (that is how §24's "specific
room" silently becomes "everything beneath") · `assertCanAssignRole` · you may only place
someone where you can reach yourself · duplicates 409 rather than hitting the partial unique ·
a window already closed is refused.

`PUT /assignments/:userId` writes **both** the grants and `users.propertyId`, because the legacy
helper reads the latter and treats null as *unrestricted* — writing one side is worse than
writing neither.

## Demoable now — Access Control UI

`/access-control` (nav: **Admin → RBAC**, gated on `ACCESS_CONTROL`, which only
SUPER_ADMIN / OPS_EXCELLENCE hold). Verified running against the dev DB with
`ACCESS_RESOLVER=next`:

- **View access as user** (PRD §31) — pick a user, see their resolved scope and every
  module x action with **explicit denials and reasons**, filterable, with a "denied only"
  toggle and an "at property" selector that re-runs the whole matrix at one node.
- **Grants** — every live grant with its node, kind, data scope and status; `+kitchens`
  marks the grants that follow the F&B spine, making the food/audit difference visible.
- **Organization** — the unified tree, inactive nodes struck through.

Everything on the page is resolved server-side by the same `decide()` the `authorize()`
middleware calls, so it explains the 403 a user is actually getting rather than a second
opinion about it.

To run it:
```bash
# Browser pane: preview_start "uniliv-api-8091-access-next", then "uniliv-web-8091"
# login admin@uniliv.com / Admin@123, OTP 000000
```

## Built

- **Phase 0** — property scoping on `rooms.ts`, `employees.ts` (+attendance), 11 `operations.ts`
  handlers; `assertPropertyAccess(req, null)` now 400s; `effectivePropertyFilter()`.
- **Phase 1** — `access.ts` schema (6 tables), `users.role_key`, `employees.user_id`; pushed.
- **Phase 2** — `resolveAccess`, `getAccess`, `org-tree.ts`, both adapters, flag.
- **Phase 3** — `decide()` with machine reason codes; `GET /api/access/preview/:userId`,
  `/manifest`, `/nodes`.
- **Backfill** — `org-sync.ts`: `syncOrgNodes()`, `backfillAccessGrants()`, `findDanglingGrants()`.

## To flip it on

```bash
# 1. project + backfill (already done on dev)
# 2. confirm wouldLoseAccess is acceptable
ACCESS_RESOLVER=next   # in the api environment
```
Reversible: unset it and the legacy path answers again.

## Not built

Phases 4–12: activity trail, separation of duties, matrix-as-data, admin console UI, frontend
hardening, and the net-new Bed / Housekeeping / Shift / Maintenance / Issue modules plus the
Property/Room/Attendance/Menu reshaping. That is the bulk of the PRD by volume and it is months
of work, not a night.

## Open decision

New tables use `text` ids like every other table, so the ID migration sweeps them with the
other 125. If you want them as bigint from the start that is a small edit now and a large
divergence later.
