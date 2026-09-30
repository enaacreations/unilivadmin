# UAM — handoff

Rewritten 30 Sep 2026. Supersedes the 26 Sep version, most of which went stale within
days — the module changed shape twice after it was written.

`UAM_MODULE.md` says what the module *is*. `ROLE_TAXONOMY_PROPOSAL.md` covers the 24-role
business taxonomy. This file is current state, the model's vocabulary, and the traps.

---

## 1. State as of this writing

| | |
|---|---|
| Branch / HEAD | `dev` @ `ea7686b` |
| Working tree | **clean** — everything committed |
| Tests | **50 files, 735 pass, 1 skipped, 0 failures** |
| Typecheck | **0 errors** across the workspace |
| Deployed | `e2e-server` (164.52.217.248), same commit, API + web both current |

There are no known-failing tests. If you see red, you caused it.

---

## 2. Local setup

Dev servers are **launch.json configs** — never `pnpm dev` at root:

```
uniliv-api   → :8090   (sources .env.api)
uniliv-web   → :3000   (proxies /api)
```

The API is **built, not watched** (`dev` = `build && start`). **Restart it after any
backend edit** or you are testing a stale `dist/index.mjs`.

Login `admin@uniliv.com` / `Admin@123`, then OTP. The dev OTP is **random per challenge**
and only appears in the login response — it is not `000000`. From a browser session the
quickest way in is to run the login + verify from the page itself:

```js
const r = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({email:'admin@uniliv.com', password:'Admin@123'})});
const {data} = await r.json();
await fetch('/api/auth/verify-otp', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({challengeId: data.challengeId, code: data.devOtp})});
```

### Still-live trap: do not source `.env.api` before tests

`vitest.config.ts:17-19` falls back to a throwaway `vitest` database **only when
`DATABASE_URL` is unset**. Sourcing `.env.api` points DB-backed tests at the real dev
database, which they are not written against, and you get ~19 phantom failures.

```bash
pnpm --filter @workspace/api-server exec vitest run     # correct
```

---

## 3. The vocabulary — read this before touching anything

The naming changed **twice**. Current model, three levels:

```
module          functionality          action
  food     →     food_all_orders   →   view_order
                                       add_order
```

The dotted permission id you see in the UI is `module.functionality.action`, e.g.
`food.food_all_orders.view_order`. 252 permissions across the manifest.

**Watch out**: a column called `functionality` holds what was once called `module`, and
`action` holds the *named* action (`view_order`), not the old CRUD verb (`view`). The CRUD
vocabulary was deliberately retired (`2a45710`). Code written against the 26 Sep naming is
wrong.

The manifest in `apps/api-server/src/lib/permissions.ts` is the source of truth for what
exists; the database stores which roles hold which cells.

---

## 4. Tables

| Table | Rows (local) | Means |
|---|---|---|
| `users` | 32 | the person |
| `user_roles` | 34 active | which roles they hold. **Soft-delete**: `is_active`, `revoked_at/by/reason` |
| `roles` | 26 | catalogue. `anchor_level` = the rung it is handed out at (city / cluster / kitchen) |
| `role_functionalities` | 497 | the matrix: `role_key` × `functionality` × `action` × `allowed` |
| `privileges` | 3 | exceptions. Also carries `role_key`, `from_set_id`, and an approval upload (`approval_key/filename/size/...`) |
| `privilege_sets` / `_items` / `_assignments` | 1 set | **named bundles** of permissions — see below |
| `access_grants` | 27 | placements only now (24 `*`, 2 UNIT_LEAD, 1 KITCHEN_MANAGER) |
| `audit_role_grants` | 26 | audit personas, **split out of `access_grants`** |
| `org_nodes` / `org_node_closure` | 80 / 431 | the place tree |

**The `access_grants` split I recommended on 26 Sep has happened.** Audit personas moved
to `audit_role_grants` with proper columns (`module_role`, `audit_types`, `scope_level`,
`zone_id`/`city_id`/`cluster_id`/`property_id`) instead of a `qualifiers` JSON blob.

### Privilege sets

A set is a **live reference**, not a copy: assigning it stores a pointer and the resolver
expands it per request. Editing a set therefore grants the new permission to everyone
already holding it, immediately, with no further action. That is the feature and the
hazard — see the header comment in `privilege-set-editor.tsx`, which explains why the
reach is stated next to the save button.

### Resolution ladder (`decide.ts`)

system role → manifest ceiling → privilege `DENY` → role matrix ∪ privilege `GRANT` →
scope (`access_grants`) → data scope.

Load-bearing asymmetry: **a privilege supplies capability but never scope.** A privilege
scoped to Baner gives nothing to someone who does not work at Baner.

---

## 5. Migrations — the exception to "push only"

`lib/db/migrations/` exists **despite** the repo using `drizzle-kit push` with no
migration files. Read `lib/db/migrations/README.md` before adding one.

The reason: **push cannot express a rename.** It drops and recreates, taking the data
with it. So renames are hand-written SQL, applied once, and push is then confirmed to
report *"No changes detected"*. Recent ones:

- `2026-09-26_access_axis_rename.sql`
- `2026-09-28_named_actions.sql` — without it the server loses every permission cell
- `2026-09-29_role_taxonomy.sql`

Anything that is not a rename still goes through push.

---

## 6. Provisioning roles

```bash
pnpm --filter @workspace/api-server run roles:sync
```

`sync-roles.ts` upserts every role the manifest declares and replaces its cells. It exists
because **nothing ever called `seedMatrix`** — it was written, tested, and never wired up,
so a freshly provisioned database came up with an empty `roles` table however many times
the seeds ran (`a1673a2`). Safe to re-run. It *reports* roles the manifest no longer
declares rather than deleting them.

Known benign drift: local has a `UNASSIGNED` role that is not in the manifest, disabled,
with zero holders. The server does not. Harmless leftover.

---

## 7. Screens

`apps/uniliv-admin/src/pages/uam/` — nav is **Users · Roles · Privileges**.

| File | Does |
|---|---|
| `users.tsx` | who has an account (not what they can do) |
| `user-detail.tsx` | Profile · Entities · Roles · Privileges · Access · History |
| `role-tree.tsx` | the Roles tab as a tree: role → place it was handed out at → properties reached → what they may do at each |
| `access-view.tsx` | the **resolved** answer, with a reason per refusal and an "At" place selector |
| `roles.tsx` | full-width list → full-width detail |
| `role-permissions.tsx` | the matrix, editable in place, per-permission switches |
| `permission-list.tsx` | one renderer for "which permissions, on which functionalities" |
| `privileges.tsx` | what the system can grant **at all** + named bundles |
| `privilege-set-editor.tsx`, `held-sets.tsx` | create/edit a set; the sets a subject holds |
| `select.tsx` | **the module's one picker** — every dropdown uses it |
| `copy-access.tsx` | the handover (roles + places + privileges, with a dry run) |
| `set-privilege.tsx`, `subject-picker.tsx`, `profile-editor.tsx`, `role-editor.tsx`, `disable-role.tsx`, `shell.tsx`, `words.ts`, `uam.css` | supporting |

---

## 8. Decisions with non-obvious reasons

1. **Access check is a tab, not a screen** — it shows what the server *decides*; Roles and
   Privileges tabs show what is *configured*. Different questions.
2. **Deactivate lives at the bottom of Profile**, deliberately away from everything else.
3. **Reason prompts are server-enforced**, not just form validation — role revoke, user
   deactivation, privilege writes, clone.
4. **Role membership is soft-deleted.** "Did she hold Warden in March?" is asked after
   incidents. A hard delete erases the answer.
5. **`--allow` / `--block` / `--warn` CSS tokens stay distinct** from the app's
   success/danger/warning even though they point at the same values.
6. **Open question, never answered**: I proposed renaming the Copy Access card to
   *"Replace all access with someone else's"*, because "Copy Access" undersells that it
   replaces roles and placement too. Ask the user.

---

## 9. Open work

- **`users.role` is still the legacy primary**; `user_roles` is the truth. ~50 call sites.
- **No UI to change where someone works** post-creation. `PUT /users/:id` accepts
  `propertyId`, nothing sets it. Doing it properly means writing `access_grants` too —
  `users.propertyId` alone leaves the two engines disagreeing.
- **58 of 252 permissions are granted by no role at all** (visible on the Privileges
  screen). Either dead permissions or missing role cells — nobody has triaged which.

---

## 10. Traps

- **IST/UTC.** Drizzle `timestamp` columns store **UTC wall-clock**; a `psql` session is
  IST. `insert … default now()` from psql writes ~5½ hours in the future, so the row looks
  "not yet effective". Fix: `effective_from - (now() - (now() at time zone 'UTC'))`.
- **Not every functionality has every action.** A privilege on a cell the manifest does
  not declare is silently inert. Check the manifest before concluding a feature is broken.
- **Browser automation**: `computer` ref-clicks sometimes report coordinates outside the
  frame and miss. `scroll_to` then click by ref, or click by screenshot coordinate.
- **Stale HMR errors** pile up in a long-lived tab, including 404s for deleted files.
  Confirm console cleanliness in a **fresh tab**.

---

## 11. Deployment

Host `e2e-server` (`164.52.217.248`), Docker Compose, **Postgres on the host** over a Unix
socket — never exposed on the network. Web on `:8080` reverse-proxies `/api` to the api
container on `:8090`. Full runbook in `DEPLOYMENT.md`.

Verified 30 Sep: server HEAD matches local `ea7686b`; api + web containers healthy; images
built after that commit; `/api/access/roles` returns 401 unauthenticated and 25 roles with
`anchorLevel` when authenticated; `privilege-catalogue` and `privilege-sets` both 200; the
served JS bundle contains the current screens.

`node` is **not** on the server's PATH and `pg` is not resolvable inside the api container
(it is bundled into `dist`). Verify through HTTP endpoints, not ad-hoc scripts. `sudo`
needs a password, so `sudo -u postgres psql` will not work non-interactively.
