# Role taxonomy — APPLIED

Applied on 2026-09-29 in `lib/db/migrations/2026-09-29_role_taxonomy.sql`, with
the code matrix in `permissions.ts` (both copies) as the source of the cells.
The three decisions below were answered: F&B Supervisor kept separate, the three
thin roles widened, anchor levels set from the Scope column.

Result: **24 business roles**, plus `OPS_EXCELLENCE` (break-glass, unlisted) and
`UNASSIGNED` (the default before a role is assigned). 497 permission cells, up
from 316 — the rise is the nine new roles plus the three widenings.

Nobody lost access. Two roles retired into survivors and their holders moved:
`WARDEN` → `UNIT_LEAD` (1), `FNB_ZONAL_HEAD` → `F&B Admin` (1).

## One consequence worth knowing

`UNIT_LEAD` was a FOOD role (`FOOD_*`, `AUDIT_*`) and `WARDEN` was the
property-operations role. They were different jobs that happened to share a
scope. With one property-level role in the new list it has to carry both, so
Unit Lead is now the union — which means **former Wardens gain the food set and
existing Unit Leads gain the operations set**. That is a two-way widening, not a
rename. Split it into two roles if the two jobs are meant to stay apart.

---

## The original proposal, for reference

Your list is 23 roles. The system has 32. This is **not a trim**: nine of your
roles do not exist, seven existing roles with live holders are absent from your
list, and two of the "extras" are load-bearing infrastructure rather than
strays.

Nothing below has been applied. Correct the table and I will execute it.

## Decisions already taken

| Question | Your answer |
|---|---|
| OPERATIONS_MANAGER / WARDEN | Rename into the list, holders keep their access |
| AUDIT.* personas | Remove — audit is a MODULE; the common roles get audit functionalities |
| The nine new roles | Clone from nearest, written up here for correction |
| F&B family | FNB_MANAGER → F&B Admin, KITCHEN_MANAGER → F&B Store |
| "Admin (Ops Excellence)" | The operations admin (38 cells). Break-glass stays hidden. |

## A note on keys

Where a role survives, **the key stays and only the label changes**. A key
rename would have to be migrated through `users.role` (a pg enum), `user_roles`,
`role_functionalities`, `access_grants` and `privileges` — five tables and an
enum, for a cosmetic gain. New keys are created only for genuinely new roles.

## The 23 roles

| # | Your role | Key | From | Holders | Permissions |
|---|---|---|---|---|---|
| 1 | Super Admin | `SUPER_ADMIN` | unchanged | 1 | system role, everything by rule |
| 2 | Admin (Ops Excellence) | `OPERATIONS_MANAGER` | relabel | 2 | keeps its 38 cells |
| 3 | Leadership – View All | `SENIOR_VICE_PRESIDENT` | relabel | 1 | keeps its 11 cells (food + audit read) — **but your scope says "All properties" and this role has no Operations at all. Widen?** |
| 4 | Zonal Head | `ZONAL_HEAD` | unchanged | 1 | 15 cells |
| 5 | City Head | `CITY_HEAD` | unchanged | 1 | 15 cells |
| 6 | Cluster Manager | `CLUSTER_MANAGER` | unchanged | 1 | 30 cells |
| 7 | Unit Lead | `UNIT_LEAD` | absorbs `WARDEN` | 2 + 1 | 26 cells; Warden's holder moves here |
| 8 | R&M Manager | `RM_MANAGER` | **new**, from WARDEN | 0 | Complaints (all actions) + Properties/Dashboard read, org-wide |
| 9 | R&M Supervisor | `RM_SUPERVISOR` | **new**, from WARDEN | 0 | as above, minus delete; property-scoped |
| 10 | Housekeeping Manager | `HOUSEKEEPING_MANAGER` | **new**, from WARDEN | 0 | same shape as R&M Manager |
| 11 | Housekeeping Supervisor | `HOUSEKEEPING_SUPERVISOR` | **new**, from WARDEN | 0 | same shape as R&M Supervisor |
| 12 | CX Admin (Care Desk) | `CUSTOMER_EXPERIENCE` | relabel | 1 | 9 cells (audit + properties) — **no Complaints today; a care desk surely needs them?** |
| 13 | Care Desk Agent | `CARE_DESK_AGENT` | **new**, from CUSTOMER_EXPERIENCE | 0 | as CX Admin, read-only on audits |
| 14 | F&B Admin | `FNB_MANAGER` | relabel; absorbs `FNB_SUPERVISOR`, `FNB_ZONAL_HEAD` | 11 + 3 | 16 cells |
| 15 | F&B Store | `KITCHEN_MANAGER` | relabel | 2 | 2 cells — **very thin for a store role; widen?** |
| 16 | Finance Admin | `FINANCE` | relabel | 1 | 33 cells |
| 17 | Finance Executive | `FINANCE_EXECUTIVE` | **new**, from FINANCE | 0 | FINANCE minus delete/approve |
| 18 | Procurement | `PROCUREMENT_MANAGER` | relabel | 1 | 21 cells |
| 19 | Sales Admin | `SALES_ADMIN` | **new**, from SALES_EXECUTIVE | 0 | Sales + Property leads, all actions, org-wide |
| 20 | Sales Manager | `SALES_MANAGER` | **new**, from SALES_EXECUTIVE | 0 | as Sales Admin, cluster-anchored |
| 21 | Sales Executive | `SALES_EXECUTIVE` | unchanged | 1 | 8 cells |
| 22 | HR Admin | `HR_MANAGER` | relabel | 1 | 19 cells |
| 23 | Viewer | `AUDIT_READONLY` | relabel | 1 | system role, read-only everywhere |

## Removed (13)

| Key | Holders | Where they go |
|---|---|---|
| `WARDEN` | 1 | → Unit Lead |
| `FNB_SUPERVISOR` | 2 | → F&B Admin — **a widening across the C3 boundary, see below** |
| `FNB_ZONAL_HEAD` | 1 | → F&B Admin |
| `AUDIT.ADMIN` `AUDIT.AUDITOR` `AUDIT.AUDITEE` `AUDIT.REVIEWER` `AUDIT.SCHEDULER` `AUDIT.VIEWER` | 0 | gone; audit access comes from the 23 roles' `AUDIT_*` functionalities |
| `NIGHT_WRDEN` | 0 | gone (9 cells, nobody holds it) |
| `PROJECTS_MANAGER` | 0 | gone |
| `PROPERTY_ACQUISITION` | 0 | gone |
| `VENDOR_RESTRICTED` | 0 | gone |
| `RESIDENT` | 0 | gone (already inactive) |

## Kept but unlisted (2)

| Key | Why it cannot go |
|---|---|
| `OPS_EXCELLENCE` | Break-glass system role, every permission by rule. With SUPER_ADMIN it is the lockout backstop: `assertAccessControlReachable` counts it when deciding whether a change would leave nobody able to administer access. Not offered in any role picker. |
| `UNASSIGNED` | The default `users.role` for an account created before roles are assigned. Deleting it breaks user creation. It is the ABSENCE of a role, not a role. |

## Three things to decide

**1. F&B Supervisor → F&B Admin is a separation-of-duties widening.**
The C3 rule is that whoever ships must not certify receipt. FNB_SUPERVISOR sits
on the shipping side (`mark_dispatched`, no `confirm_receipt`); F&B Admin holds
both. Moving those 2 people makes them both shipper and certifier. A test
enforces C3 and will fail on it. Options: accept and exempt F&B Admin, keep a
separate supervisor role, or split F&B Admin's dispatch and receipt actions.

**2. Three roles look too thin for the scope you wrote.**
Leadership–View All has no Operations functionalities despite "All properties";
CX Admin has no Complaints despite being the care desk; F&B Store has 2 cells.
Say what each should reach and I will set it.

**3. Scope column.** Your scopes (Zone / City / Cluster / Property / assigned)
map onto the existing `anchorLevel`, which controls what kind of place a role
may be handed out at. 21 roles currently have none set. I will set them from
your column as part of this.
