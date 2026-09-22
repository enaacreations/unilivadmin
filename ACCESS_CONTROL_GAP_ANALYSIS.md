# Access Controls (v1.0 Draft) — Requirement Analysis & Codebase Gap Report

Source: `Access Controls.pdf`, Version 1.0, Status **Draft**, Product: *Property Operations ERP*.
Codebase compared: `dev` @ `30d3077`.

---

## 1. What the document actually asks for

Despite the title, this is **not** an access-control spec bolted onto the existing app. It is a
**full product PRD for a Property Operations ERP** (39 sections), of which access control is the
spine. Two things must be read separately:

**(a) The authorization model** — the recurring six-stage chain:

```
User → Role → Module → Action → Property Scope → Data Scope → Access
```

with the stated design principle (§39):

> A user's role determines **what** they can do, while the property and organizational
> hierarchy determine **where** they can do it.

Its concrete demands:

| # | Requirement | Section |
|---|---|---|
| R1 | Two parallel hierarchies: `Company → Region → Property → Building → Floor → Room → Bed` **and** `Employee → Reporting Manager → Department → Property/Properties → Region` | §4, §39 |
| R2 | 13 named actions (View, Create, Edit, Delete, Submit, Approve, Reject, Assign, Complete, Verify, Export, Download, Configure) | §23 |
| R3 | 9 scopes in one list: Assigned Property, Multiple Assigned Properties, Region, Organization, Specific Building, Specific Floor, Specific Room, **Assigned Tasks**, **Self** | §24 |
| R4 | **Team** scope, derived dynamically from the reporting chain (named only in §26, not in the §24 list) | §26 |
| R5 | Team scope computed **dynamically** from the reporting hierarchy; moving an employee re-derives access automatically | §26 |
| R6 | Multi-property assignment: `Employee → Primary Property + Secondary Properties` | §27 |
| R7 | The role × module matrix is **configurable from the Admin panel**, not code | §22, §25, §30 |
| R8 | **"View Access As User"** admin preview — resolve and display a named user's effective access | §31 |
| R9 | Server-side enforcement on every API; frontend visibility is explicitly *not* a security mechanism | §32 |
| R10 | **Separation of Duties**: creator ≠ approver (maintenance requests, menu creator ≠ menu approver) | §33 |
| R11 | Audit trail on 13 named operational events with user/timestamp/action/entity/prev value/new value/reason | §29 |
| R12 | 15 seed roles, themselves configurable | §22 |

**(b) The operational modules** the access model is meant to govern — Property, Room, **Bed**,
Room Audit, Issue Management, Maintenance, Housekeeping, Staff, Attendance, Shift, Food & Menu,
Reports, Dashboard, Notifications, Admin Console.

**This is the crux: our codebase is a different product.** UNILIV Admin is a co-living platform
(residents, complaints, laundry, finance, wallet, KYC, procurement, sales CRM, food ordering,
audits). The PDF describes a property-*operations* ERP (beds, housekeeping, maintenance
work-orders, shifts). The overlap is roughly 45%. Treating the PDF as "the new RBAC requirements"
understates it by a wide margin — a large part of it is **net-new product**.

---

## 2. Verdict at a glance

| Requirement | Status | Where |
|---|---|---|
| R1 Geo hierarchy (Zone→City→Cluster→Property) | 🟡 Partial — exists, but named Zone/City/Cluster, **no Building / Floor / Bed** | `lib/db/src/schema/food.ts:167-198`, `core.ts:141` |
| R1 Employee hierarchy | 🟡 Data exists (`employees.managerId`, `department`), **never used for access** | `lib/db/src/schema/hrms.ts:39` |
| R2 13 actions | 🔴 Only 4: `view / create / edit / delete` | `apps/api-server/src/lib/permissions.ts:39` |
| R3 9 scopes | 🔴 Effectively 2: "my one property" or "everything" | `apps/api-server/src/lib/authz.ts:20-39,131` |
| R4 Team scope (reporting-chain derived) | 🔴 Not modelled anywhere | — |
| R5 Dynamic team derivation | 🔴 Absent | — |
| R6 Multi-property assignment | 🟡 `users.propertyId` is a single column; `user_scopes` can express it but **only the food module reads it** | `core.ts:234`, `food.ts:207` |
| R7 Configurable matrix | 🔴 Hard-coded TypeScript, duplicated FE/BE, needs a deploy to change | `permissions.ts` (both sides) |
| R8 View Access As User | 🔴 No endpoint, no UI | — |
| R9 Server-side enforcement | 🟢 Solid for *module × action*; 🔴 weak for *scope* (7 of 38 route files scope at all) | `middlewares/authorize.ts` |
| R10 Separation of duties | 🟡 One hand-maintained instance (food dispatch ≠ confirm-delivery), no generic rule | `permissions.ts:100-118` |
| R11 Audit trail | 🟡 `audit_log` table exists but has **one writer** (wallet); the Audit module has its own rich hash-chained event log | `system.ts:32`, `audit.ts:575` |
| R12 15 seed roles | 🟡 22 roles exist, but they are a *different* 22 | `permissions.ts:1-11` |

Legend: 🟢 met · 🟡 partial / divergent · 🔴 missing

---

## 3. The authorization model: what we have vs. what is asked

### 3.1 What exists today

Our engine is a **two-stage** chain, not six:

```
User → Role → Module → Permission(view|create|edit|delete)          ← authorize() middleware
                                    ↓
                   scopedPropertyId(req) → one propertyId, or null  ← opt-in, per handler
```

- `ROLE_PERMISSIONS` (`apps/api-server/src/lib/permissions.ts`) maps 22 roles × ~52 modules ×
  4 permissions. It is mirrored by hand in `apps/uniliv-admin/src/lib/permissions.ts` and the two
  are locked together by `permissions-sync.test.ts`.
- `authorize(MODULE, perm)` / `authorizeAny([...], perm)` gate every protected route. This part is
  genuinely good and satisfies R9 for the *action* half of the chain.
- Property scope is a **binary**: `ORG_WIDE_ROLES` (a hard-coded allow-list of 18 roles) see
  everything; everyone else is pinned to `users.propertyId`.

### 3.2 The three gaps that matter most

**Gap A — scope is binary, the PRD wants a lattice.**
`isPropertyScoped()` returns true or false. There is no way to express "these 3 properties",
"this region", "this building", "rooms assigned to me". §24 asks for 8 scopes and §26 asks for
team-derived scope on top. Today a Cluster Manager is simply listed in `ORG_WIDE_ROLES` — i.e. a
role that is *supposed* to manage a subset of properties is granted **all** of them, because the
model has no vocabulary for the middle ground. That is the exact "over-permission" failure the
PDF's §2 problem statement names.

**Gap B — scope enforcement is opt-in per handler, and mostly not opted into.**
`scopedPropertyId` appears in **7 of 38** route files (communications, wallet, complaints, laundry,
bulk, residents, bookings). Concrete consequence, verifiable today:

```
GET /api/rooms            →  authorize("PROPERTIES","view") only; no property filter
POST /api/rooms           →  accepts any propertyId in the body
GET /api/attendance       →  authorize("EMPLOYEES","view") only; no property or self filter
```

A WARDEN bound to Property A can list and create rooms in Property B, and can read attendance for
every employee in the company. §32 ("every API should validate … Property Scope → Data Scope") is
not met on these paths. **This is the most urgent item in the report and it is a bug, not a
missing feature.**

**Gap C — two rich scope systems already exist, but siloed.**
We have *already solved* hierarchical scoping twice:

| System | Table | Levels | Read by |
|---|---|---|---|
| Food ops | `user_scopes` | GLOBAL / ZONE / CITY / CLUSTER / KITCHEN / PROPERTY | `food-service.ts` only |
| Audit & Inspection | `audit_role_grants` | module role × audit types × org node × validity window | `audit-access.ts` only |

`audit_role_grants` in particular is close to what §24+§26 describe (scoped grant + effective
window + fine-grained subject). **The right move is to promote one of these to a platform-level
scope resolver rather than build a third.**

---

## 4. Module-by-module comparison

| PDF module | Our status | Notes |
|---|---|---|
| §7 Property Management | 🟢 Exists | `properties` has code/name/address/city/status/portfolio. Missing: `region` as a first-class field (we have `clusterId` → city → zone), `openingDate`, building/room/bed counts are derived not stored. Statuses differ: ours `ACTIVE/…`, PDF wants Active / Temporarily Closed / Under Setup / Inactive. |
| §8 Room Management | 🟡 Partial | `rooms` has number/floor(int)/wing/type/capacity/status. **No Building entity; floor is an integer, not an entity.** Statuses: ours `VACANT/OCCUPIED/MAINTENANCE/RESERVED` vs PDF's 7 (adds Partially Occupied, Cleaning, Blocked, Out of Service). No housekeeping/maintenance/audit status per room. |
| §9 Bed Management | 🔴 **Absent** | There is no `beds` table anywhere. `properties.totalBeds` is a scalar count; residents and bookings attach to a **room**. The PDF makes the bed the central operational entity with its own lifecycle (Created→Available→Occupied→Vacated→Cleaning→Available) and status log. This is a substantial new data model plus migration of residents/bookings/occupancy. |
| §10-11 Room Audit + Scoring | 🟢 Strong, and *ahead* of the PDF | Full module: templates + versions, sections, questions (10 types), schedules with recurrence, runs, responses, evidence with geotagging, reviews, comments, reports, share links, hash-chained events. `audits.targetType` already supports `ROOM`. Configurable rating scales and performance bands (`audit_rating_scales`, `audit_performance_bands`) satisfy §11's "thresholds and weightages should be configurable". Divergence: our audit types are `UL / CM / CX`, not the PDF's 10 checklist categories — those map to *template sections*, not types. |
| §12 Issue Management | 🔴 Gap | The PDF wants a failed audit answer to auto-spawn a tracked issue with category/assignee/priority/SLA and an Open→Assigned→In Progress→Resolved→Verified→Closed lifecycle. Our audit module records findings inside the run and has comments/reviews, but **no issue entity and no audit→task conversion**. The `NC`/`CAPA` enum values in `audit.ts:159` are explicitly noted as orphaned and no longer written. |
| §13 Maintenance | 🟡 Proxy exists | `complaints` is the closest: ticketNo, category (incl. MAINTENANCE), priority, assignedTo, `slaHours`/`slaDeadline`/`slaBreach`, escalations, photos, resolution. But it is **resident-complaint shaped**, not a work-order module: no room/bed linkage beyond property, no maintenance categories (Electrical/Plumbing/HVAC/Civil/Appliances/Network), no Verified step. |
| §14 Housekeeping | 🔴 **Absent** | No tables, no routes, no module in the RBAC matrix. Cleaning task creation, room/staff assignment, inspection, re-clean, daily dashboard — all net-new. |
| §15 Staff Management | 🟢 Exists | `employees` covers code/name/email/phone/department/designation/propertyId/managerId/joiningDate/status. Note `employees` and `users` are **separate tables with no FK** — the PDF's model assumes one identity whose hierarchy drives access (§15 "the employee hierarchy will be used by the authorization engine"). Reconciling these two tables is a prerequisite for R4/R5. |
| §16 Attendance | 🟡 Partial | `attendance` (employeeId/date/status/inTime/outTime) + `leaves` exist. Statuses: ours vs PDF's 9 (PDF adds Weekly Off, Holiday, On Duty). **No self-service check-in/check-out, no correction workflow, no manager approval.** Gated on `EMPLOYEES` — so no Self/Team data scope. |
| §17 Shift Management | 🔴 **Absent** | No shift entity, assignment, staffing-gap view, or approval. |
| §18-19 Food & Menu | 🟡 Different shape | We have a far larger food-ops system (orders, dispatch, kitchens, agencies, brands, dishes, ingredients, composition rules, rotation, waste). What we **lack** is the PDF's simple property × date × meal menu with the **Draft→Submitted→Manager Review→Approved→Published** workflow. `food_menu_rotation` has no approval state machine. §33's "Menu Creator ≠ Menu Approver" therefore has nothing to attach to. |
| §20 Reports & Analytics | 🟡 Partial | Dashboards, executive dashboard, food reports, audit reports, report jobs exist. Cross-property KPI comparison on the PDF's exact metric list (bed utilization, housekeeping completion, menu compliance) is not there — mostly because the underlying modules aren't. |
| §28 Notifications | 🟢 Strong | Transactional-outbox + BullMQ broker, 6 channels, preferences, push subscriptions. The PDF's event list maps cleanly once the source modules exist. "Notifications should respect user permissions" needs an explicit check at fan-out time. |
| §29 Audit Trail | 🔴 Effectively missing | `audit_log` (user/action/entity/entityId/…) exists and is *readable* via `GET /api/settings/audit-log` with a UI page — but it has **one producer**: `wallet-service.ts:287`. None of the 13 events the PDF names (bed status, room status, audit completed, issue lifecycle, attendance modified, menu approved, role changed, property assignment changed) are written. The Audit & Inspection module's own `audit_events` hash chain is excellent but scoped to audit runs only. |
| §30 Admin Console | 🟡 Partial | Org (properties/rooms), Users, Masters, Settings, audit config all have UI. Missing: the whole **Access Control** section (roles / modules / actions / scopes / permission matrix editor) and Building/Floor/Bed management. |
| §31 Access Preview | 🔴 Absent | No "View Access As User". Would be low-effort and high-value once a scope resolver exists. |
| §33 Separation of Duties | 🟡 One instance | Food dispatch vs. confirm-delivery is held apart by a documented convention + `permissions-sync.test.ts`. There is **no generic creator≠approver enforcement** — no handler checks `createdBy !== req.user.id` before an approve action. |
| §34 Key User Journeys | 🟡 1 of 4 | Room Audit journey works end-to-end *except* the issue-generation tail. Staff Attendance, Menu Management and Maintenance journeys are all missing their middle steps (check-in, approval workflow, verification). |

---

## 5. Where we are *ahead* of the document

Worth saying explicitly when replying to the Uniliv team — the PDF is written as if greenfield:

- **Audit & Inspection** is materially more capable than §10-11 (versioned templates, recurrence
  rules, geotagged start/submit evidence, review workflow, tamper-evident event chain, shareable
  reports, configurable bands).
- **Notifications** (§28) already exceed the ask.
- **Privilege-escalation defence** (`ROLE_RANK` / `assertCanAssignRole`) and **mass-assignment
  defence** (`pick()`) are not in the PDF at all and should be kept.
- Whole domains we run that the PDF ignores: residents, finance/ledger/wallet/billing, KYC/e-sign,
  procurement, sales CRM, L&D, laundry, IoT/electricity.

**Do not let a v1.0 draft regress any of this.** The matrix in §25 has 6 columns; ours has 22 roles
× 52 modules. Adopting §25 literally would be a large downgrade.

---

## 6. Risks & open questions for the Uniliv team

1. **Is this a replacement or an extension?** §35's "MVP Scope" lists login, employee master, user
   management, roles and permissions as things to *build* — all of which we shipped. Confirm the
   PDF is an evolution spec, not a rebuild brief.
2. **Bed-level operations: in or out?** §9 is the single biggest data-model change. It cascades into
   occupancy, bookings, residents, housekeeping, maintenance and every KPI. Needs an explicit
   go/no-go before anything else is planned.
3. **Region vs. our Zone/City/Cluster.** The PDF says `Region`. We have a 3-level geography. Is
   "Region" == Zone, == City, or a new 4th level? This blocks R3.
4. **Does "configurable matrix" (§7 of the ask) mean runtime-editable in production?** A DB-backed
   matrix trades our compile-time safety (and the FE/BE sync test) for flexibility, and makes
   privilege escalation a data problem rather than a code-review problem. Recommend: configurable
   **grants and scopes**, but keep the role→module→action *capability* matrix in code.
5. **`users` vs `employees` are two tables.** R4/R5 (Self/Team scope from the reporting chain)
   cannot be built until an authenticated user resolves to an employee record.
6. The document is **Draft / v1.0 with example values** ("Example weighting", "may include"). Treat
   all enumerations as indicative until confirmed.

---

## 7. Recommended sequencing

**Phase 0 — close the security gaps the PDF exposes (days, not weeks).** These are defects against
the model we *already claim* to implement, independent of any PDF decision:
- Apply `scopedPropertyId` / `assertPropertyAccess` to `rooms.ts`, `employees.ts` (incl. the
  attendance sub-router), `operations.ts`, and audit the remaining 31 route files.
- Add a generic `assertNotSelfApproval()` helper and apply it to every approve/verify action (§33).
- Wire `audit_log` writes into role change, property assignment change, and status transitions (§29).

**Phase 1 — unify scoping (the actual "access controls" work).**
- Promote `user_scopes` to a platform-level table (or generalize `audit_role_grants`), add a single
  `resolveUserScope(user) → { propertyIds[], level }` used by *all* routes, and retire the
  `ORG_WIDE_ROLES` allow-list in favour of a real `ORGANIZATION` scope row. This delivers R3 and R6
  together.
- Extend `Permission` beyond 4 actions — minimally add `approve`, `assign`, `export` (R2). Full 13
  can wait; those 3 unblock §33 and the matrix's View/Approve cells.
- Ship `GET /api/admin/users/:id/effective-access` + a viewer panel (R8). Cheap once the resolver
  exists, and it is the single best tool for validating everything above.

**Phase 2 — data-scope & hierarchy.**
- Link `users` ↔ `employees`; derive Team scope from `managerId` (R4/R5).
- Decide Building/Floor/Bed (R1) and, if yes, plan it as its own project.

**Phase 3 — net-new modules** (Housekeeping, Shifts, Maintenance work-orders, Issue Management,
Menu approval workflow), each landing with its module + actions + scope in the matrix from day one.

---

*Generated from `Access Controls.pdf` v1.0 against `dev` @ `30d3077`.*
