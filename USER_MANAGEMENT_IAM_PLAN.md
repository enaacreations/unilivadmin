# User Management — IAM-style redesign

**Status:** plan only, nothing built.
**Trigger:** Uniliv review — the UI was rejected; they want AWS/GCP IAM idiom, the module renamed
**User Management**, and user / role / permission creation inside it.

---

## 1. The reframe: the engine is already an IAM engine

This matters before any screen work, because it decides whether this is a redesign or a rebuild.

**It is a redesign.** What was rejected is the presentation. Every concept AWS and GCP IAM expose
already exists in our data model — under different names:

| IAM concept | What we already have | Live rows |
|---|---|---|
| Resource hierarchy (org → folder → project) | `org_nodes` + closure table (Company → Zone → City → Cluster → Property → Room) | 80 |
| Principal / member | `users`, plus `subjectType: ROLE` for role-wide bindings | 32 |
| Role (a named bundle of permissions) | `access_roles` + `access_role_permissions` | 28 roles / 318 cells |
| Permission (`compute.instances.start`) | `MODULE:action` — e.g. `RESIDENTS:view` | 54 modules × 13 actions |
| Predefined vs custom roles | system roles (computed, uneditable) vs editable roles | 3 system |
| Policy binding (principal + role + resource) | `access_grants` | 47 live |
| Inheritance down the hierarchy | `includeDescendants` + closure table | — |
| Conditions (time-bound access) | `effectiveFrom` / `expiresAt` on a grant | — |
| AWS explicit deny / inline policy | `access_user_permissions` (per-user GRANT/DENY) | 1 |
| Policy Troubleshooter / Policy Simulator | the access preview, driven by `decide()` | — |
| CloudTrail / Cloud Audit Logs | `activity_events`, hash-chained | 55 |

Two things we have that neither AWS nor GCP does, and should be kept and *named* in IAM terms:

- **`dataScope`** (ALL / TEAM / ASSIGNED / SELF) — row-level narrowing orthogonal to the resource.
  Closest analogue is an ABAC condition; present it as a **condition on the binding**.
- **The second spine** — a kitchen SERVES properties across clusters. In IAM terms the resource
  graph is a DAG, not a tree. Worth stating explicitly rather than hiding, because it is the one
  thing an IAM-literate reviewer will not expect.

**Conclusion:** no engine work. `decide()`, the grants table, the closure table, the matrix and the
override layer all stay. This is an information-architecture and screen rewrite, plus three
genuinely new CRUD surfaces.

---

## 2. Naming and information architecture

### 2.1 The rename

Today the sidebar group is **Admin** with a single item **RBAC** at `/access-control`, and a
separate **Users & Roles** item lives under **Settings** at `/users`. That split is itself part of
the complaint: user creation is in one place, their access in another.

| Thing | Today | Proposed |
|---|---|---|
| Sidebar group | `Admin` | **`User Management`** |
| Items in it | RBAC | Users · Groups* · Roles · Permissions · Access · Simulator · Organization · Activity |
| `/users` (Users & Roles) | under Settings | moves into the group as **Users** |
| Module key (code/data) | `ACCESS_CONTROL` | **unchanged** |

**The module key stays `ACCESS_CONTROL`.** It is referenced by grants, the matrix, `PATH_TO_MODULE`,
`PROTECTED_MODULES` and the route registry. Renaming the label is free; renaming the key is a data
migration across five surfaces for a string nobody outside the code sees. Same call we made when
"Access Control" became "RBAC" in the nav.

`USERS` stays a separate module key too — it already gates user CRUD, and keeping them distinct
means "can manage people" and "can manage permissions" remain separately grantable, which is the
correct separation of duties.

### 2.2 Tabs → routed sub-navigation

The current shell is a six-tab strip holding tab state in React. Neither AWS nor GCP uses tabs at
this level, and more importantly **nothing is linkable** — you cannot send a colleague "look at
this role". Every screen becomes its own route:

```
/user-management/users                     Users (principals)
/user-management/users/:id                 User detail  → Permissions | Access | Exceptions | Activity
/user-management/groups                    Groups*  (see open question Q1)
/user-management/roles                     Roles — predefined + custom
/user-management/roles/:key                Role detail  → Permissions | Members | Bindings | History
/user-management/permissions               Permission catalogue (read-only reference)
/user-management/access                    Access / bindings — "who can do what, where"
/user-management/simulator                 Policy simulator (today's preview)
/user-management/organization              Resource hierarchy (the org tree)
/user-management/activity                  Activity log
```

Left sub-nav inside the section, AWS-style. `/access-control` redirects to
`/user-management/users` so existing links and the demo script keep working.

---

## 3. Screen-by-screen

Each entry says what exists, what changes, and what is new.

### 3.1 Users *(principals)*

- **Exists:** `/users` list + create + edit + delete (`USERS` module, `POST /api/users`).
- **Changes:** moves into the section; list gains IAM columns — role, resource scope
  ("4 properties" / "Organization"), exceptions count, last activity, status.
- **New:** a **user detail page** with tabs, replacing today's dialog-per-action pattern:
  - **Permissions** — effective permissions grouped by module, each row saying *where it came from*
    (role / binding / exception). This is AWS's "Permissions" tab.
  - **Access** — the bindings that place them, add/remove inline.
  - **Exceptions** — the per-user GRANT/DENY overrides, already built.
  - **Activity** — the trail filtered to this person, already built.
- **Also new:** the create flow becomes a wizard — identity → role → resource scope → review —
  so a user cannot be created with no placement, which is today's most common misconfiguration.

### 3.2 Roles

- **Exists:** `GET /access/roles`, `POST /access/roles` (with clone), `PUT /access/matrix`.
  The matrix editor is the only UI, and it is module-first, not role-first.
- **Changes:** a **roles list** — predefined (system, badge "computed") vs custom, with holder
  counts and permission counts. GCP's Roles page, essentially.
- **New:** **role detail** with a permission picker (search the catalogue, tick cells, staged diff,
  mandatory reason — reusing the existing guard set unchanged), plus **Members** and **Bindings**
  tabs so "who is a Warden, and where" is answerable from the role side.
- **New:** **Create role** — from scratch, or **clone an existing role** (endpoint exists), which is
  the single biggest lever on "time to configure a new role".
- **Keep:** the module × roles matrix as a secondary "compare roles" view. It is genuinely good for
  auditing one module across all roles, which the role-detail view cannot show.

### 3.3 Permissions *(catalogue)*

- **Exists:** `GET /access/manifest` (the full vocabulary) — no UI.
- **New:** a searchable catalogue of all `MODULE:action` permissions, grouped by family, each
  showing which roles include it and how many people hold it. This is AWS's policy/permission
  reference and GCP's permission picker.
- **See §4 for what "permission creation" can and cannot mean.** This is the one place where the
  Uniliv ask and the architecture need a conversation.

### 3.4 Access *(bindings)*

- **Exists:** the Grants screen — list, create drawer, revoke/restore with reason.
- **Changes:** renamed **Access**, and re-presented as GCP's IAM page: **group by principal** by
  default, with a toggle to group by resource or by role. Today it is a flat grant list, which is
  the least readable of the three.
- **Keep unchanged:** the create form's five questions (principal → role → resource → inheritance →
  condition) already map one-to-one onto an IAM binding. Only the labels change.

### 3.5 Policy simulator

- **Exists:** the access preview, server-resolved by the same `decide()` the API enforces with.
- **Changes:** rename to **Policy simulator**, and add the missing IAM affordance — simulate a
  *specific* action against a *specific* resource and get allow/deny plus the deciding rule. Today
  it renders the whole surface, which is more information than the question usually needs.
- **Keep:** the full-surface view as the default; it is better than AWS's simulator and is the thing
  the PRD (§31) actually asks for.

### 3.6 Organization *(resource hierarchy)*

- **Exists:** the tree, with drift findings.
- **Changes:** present it as the **resource hierarchy** — the thing bindings attach to — and show,
  per node, the *inherited* bindings alongside the direct ones. GCP's "Inherited permissions" toggle.
  That is the one genuinely missing piece: today a node shows only grants made *at* it.

### 3.7 Activity

- **Exists:** the hash-chained trail with before/after, reasons and chain verification.
- **Changes:** cosmetic only. This is already stronger than what either cloud console shows.

---

## 4. "Permission creation" — the one thing to settle first

This ask has three possible meanings and they are very different jobs:

**(a) Build a custom role out of existing permissions.** This is what GCP calls a custom role and is
what people usually mean. **Already supported** end to end (`POST /access/roles` + matrix write);
it needs a UI, not a model change. *Small.*

**(b) Define a named, reusable permission set** ("Front-desk bundle") that several roles include.
A real feature, a modest schema addition (`permission_sets` + a join), and it makes role editing
much less repetitive at our cell count. *Medium.*

**(c) Create a genuinely new permission** — a new module or a new action verb — from the admin UI.
**This one has a hard constraint worth stating plainly:** a permission only means something because
some route enforces it. Our routes gate on `authorize("RESIDENTS", "view")`, written in code. A
permission invented in the database would appear in every picker, be grantable, be shown as held —
and change nothing, because nothing checks it. That is the worst possible outcome for a module whose
entire job is to be trustworthy about who can do what.

This is also a decision already made and documented: the *vocabulary and ceiling* live in code, only
*which cells a role holds* is data. Fully DB-driven permissions turn privilege escalation into one
authenticated POST.

**Recommendation:** ship (a) and (b), and for (c) give the admin a **read-only permission catalogue**
plus a documented path — adding a module or action is a code change, reviewed, and appears in the
catalogue on deploy. If Uniliv specifically wants self-service permission registration, the honest
version is a **"declared but unenforced" state**: a new permission can be registered from the UI,
shows as *Inactive — not yet enforced by any endpoint*, and only becomes live when a route claims
it. That keeps the UI truthful. It is more work than it sounds and I would not do it before launch.

---

## 5. Phasing

Sizes are rough, assume one developer, and exclude review cycles.

| Phase | Scope | Size | Depends on |
|---|---|---|---|
| **0** | Rename to User Management, routed sub-nav, `/access-control` redirect, move `/users` in | S | — |
| **1** | Users list + user detail (Permissions / Access / Exceptions / Activity), create wizard | M | 0 |
| **2** | Roles list + role detail + create/clone UI | M | 0 |
| **3** | Permission catalogue (read-only) | S | 0 |
| **4** | Access (bindings) re-presentation: group by principal / resource / role | M | 0 |
| **5** | Policy simulator: targeted action-on-resource query | S | 1 |
| **6** | Organization: inherited-bindings view | S–M | 0 |
| **7** | Permission sets (§4b) | M | 3 |
| **8** | Groups (§Q1) — new schema, resolver change, migration | L | 1 |

**Suggested first cut for the Uniliv re-review:** phases 0–3. That is the rename, the IAM
navigation, and the three creation surfaces they asked for by name — the complete answer to their
feedback without touching the resolver.

Phases 4–6 are presentation improvements on screens that already work. Phase 8 is the only one that
changes the access model and should not be started until Q1 is answered.

---

## 6. What survives, and what gets thrown away

**Survives untouched** — this is the majority of the work already done, and none of it was the
subject of the complaint:

- `decide()` and every reason code
- the resolver, closure table, dual spine, `dataScope`
- the grant guard set, matrix guard set, override guard set
- the async `authorize()` gate and the override cache
- the hash-chained activity trail
- all 693 tests

**Thrown away:** the six-tab shell, the current preview layout, the grants list layout, the matrix
screen's role-row presentation. Roughly 2,400 lines of screen code — real work, but screen code is
the cheapest layer to replace and the only layer being rejected.

**Worth keeping from the current UI even in IAM idiom:** the reason-first denial explanations, the
mandatory-reason dialogs, the drift findings, and the "personal exceptions" concept. None of those
exist in AWS or GCP consoles and all three came out of this PRD.

---

## 7. Open questions for Uniliv — answer before phase 1

**Q1. Groups.** AWS has user groups; GCP has principal sets. Do you want an employee's access to come
from *group membership* rather than a direct role? It is the single largest addition on this list
(new table, resolver change, migration of 47 bindings) and it changes how every future grant is made.
If the answer is "eventually", we should still design the bindings UI around it now.

**Q2. What does "permission creation" mean?** See §4 — (a) custom roles, (b) permission sets, or
(c) genuinely new permissions. This changes phase 3 from small to large.

**Q3. AWS or GCP flavour?** AWS = JSON policy documents with Effect/Action/Resource/Condition
statements. GCP = forms binding principals to roles on resources. **Strong recommendation: GCP.**
Our model already *is* GCP's; AWS-style JSON policies would mean a second evaluation engine and a
policy language to validate, for the same expressive power.

**Q4. Should DENY be visible as policy?** We have per-user DENY overrides (AWS-style explicit deny).
Keep them as "exceptions on a person", or promote them to first-class deny policies attachable to
roles and resources? The second is more IAM-like and considerably more dangerous.

**Q5. Is the property tree the resource tree?** Everything assumes bindings attach to org nodes
(Zone/City/Cluster/Property/Room). Confirm they are not expecting bindings on *modules* or on
*record types* instead — that would be a different model.

---

## 8. Risks

1. **The rename touches the demo script.** `ACCESS_CONTROL_DEMO.md` walks five screens by name; it
   needs rewriting alongside phase 0, or the next demo contradicts the app.
2. **Route coverage.** Every new endpoint must be classified in `route-scope-registry.ts` or
   `route-coverage.test.ts` fails the build. This is working as designed — budget for it, don't be
   surprised by it.
3. **IAM idiom vs. operator vocabulary.** Uniliv's operators are wardens and city heads, not cloud
   engineers. "Principal", "binding" and "policy" are precise but unfamiliar. Recommend IAM
   *structure* with plain-language *labels* — "People", "Access", "Where they work" — rather than
   importing cloud jargon wholesale. Worth agreeing on the vocabulary in the same conversation as Q3.
4. **Scope creep through "IAM-like".** AWS IAM has permission boundaries, service control policies,
   access analyzers, credential reports and last-used data. None are in the PRD. Agree explicitly
   that "IAM style" means the navigation and mental model, not the feature list.
