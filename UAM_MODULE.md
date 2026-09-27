# User & Access Management (UAM) — built

> **Stale in places.** This file predates two rounds of renaming. The tables:
> `access_privileges` is now `privileges`, `access_role_permissions` is now
> `role_functionalities`, `access_roles` is now `roles`, and the `action` column on the
> last two is now `functionality`.
>
> The VOCABULARY has since changed too. Actions are no longer thirteen global verbs
> shared by every functionality — each functionality NAMES its own, and the manifest
> (`FUNCTIONALITY_ACTIONS` in `apps/api-server/src/lib/permissions.ts`) is the source of
> truth for what may be granted. A permission is one thing with one id,
> `operations.properties.add_property`, not a noun and a verb that happen to be adjacent.
> Read that file's header comment for the current model. The design reasoning below still
> holds; its examples say `create` where the code now says `add_property`.


Supersedes the screens described in `USER_MANAGEMENT_IAM_PLAN.md` for the parts now shipped.

## What the Uniliv team asked for, and where it lives

| Ask | Built as |
|---|---|
| Users CRUD | `/uam/users` + `/uam/users/:id`, `GET/POST/PUT/DELETE /api/users` (+ a detail endpoint that did not exist) |
| User Roles CRUD | `/uam/roles` + `/uam/roles/:key`, `GET/PUT /access/roles/:key`, `POST /access/roles/:key/{enable,disable}` |
| One user → many roles | `user_roles`; capability is the **union** across held roles |
| Privileges at role AND user level | `access_privileges` with `subjectType` USER or ROLE |
| propertyId → functionality | `access_privileges.nodeId`, inherited down the org tree |
| Assign roles at creation | the create-user wizard, step 2 |
| Copy privileges from an existing user | the wizard's `copyPrivilegesFrom`, and `POST /access/clone-access` |
| Enable/disable a role | `access_roles.isActive`, enforced in `readRoles` |

## The resolution ladder

One ladder, implemented once in `privileges.ts` and consumed by `decide()`, the `authorize()` gate
and the `/auth/me` capability blob:

1. System role → allow (ceiling still applies)
2. Manifest ceiling — the cell must exist
3. **User** privilege — nearest node covering the query node, then global
4. **Role** privilege — for any held role, nearest node then global
5. **Role matrix** — union over held roles
6. else `DENY_ROLE_LACKS_CAPABILITY`, then scope and data-scope

Two rules: **more specific wins** (user beats role, node beats global, deeper node beats shallower);
**at equal specificity, DENY wins**. Rule 2 is deliberately last — an organization-wide DENY must not
outrank a GRANT written for one property, because the narrower rule is the more deliberate one.

**A privilege says WHAT, never WHERE.** A granted cell is still checked against the person's grants,
so it cannot reach a property they were never placed at.

## One deliberate behaviour change

`AUDIT_READONLY` used to be a **cap**: as a sole role it limited its holder to `view`. Under a union
it can no longer cap anything — if you also hold WARDEN you get WARDEN's writes, because a role that
grants less cannot take away what another grants. Capping is now the job of a DENY privilege, which
says so explicitly and carries a reason. `AUDIT_READONLY` alone behaves exactly as before.

## Two bugs found and fixed on the way

- **`rolesFor` cached a fallback-derived value** under a key that did not include the fallback, so one
  caller's roles could be served to the next — and the legacy column would keep being served for a
  full TTL after the first membership row was written. Only real membership reads are cached now.
- **The lockout backstop read `users.role` only**, so it could not see someone whose access-admin role
  was their second. It now checks `user_roles` and the legacy column.

## Migration state

- `user_roles` backfilled for all 32 users; `access_privileges` carries the one migrated override.
- `users.role` is still written and still read by ~21 legacy scope helpers. It is now **derived**:
  `resolveAccess` sets `roleKey` to the highest-ranked held role. Dropping the column is the
  remaining step and is deliberately not bundled here.
- The backfill initially wrote IST wall-clock through psql into columns the app reads as UTC
  (`lib/db` pins the app session to UTC), which made every membership "not yet effective" for 5h30m.
  Corrected — worth remembering for any future SQL backfill of a timestamp column.

## Not built (and why)

- **Resident logins.** `userType` exists and a RESIDENT role can be created, but residents remain
  records: no credentials, no session, no link to `users`. Authenticating them is its own project.
- **Channel (Web/Mobile).** Dropped at the user's direction.
