## DB migrations

**`drizzle-kit push` is the canonical schema-apply path for ALL environments,
including production** (see `package.json`'s `push` / `push-force` scripts and
`DEPLOYMENT.md`). It syncs `src/schema/*` directly to the target database, so the
schema in code is always the single source of truth.

```bash
# applies lib/db/src/schema/* to $DATABASE_URL
pnpm --filter @workspace/db exec drizzle-kit push --force
```

### ⚠️ The hand-written `*.sql` files below are DEPRECATED / not maintained

They were an early secondary convenience for a manual `psql` runner and were
**not kept in sync** with later schema work (the org/brand overhaul, the menu
module, agencies, composition rules, etc.). Do **not** provision a database from
them — they will not match `src/schema/*`. They are retained only for historical
reference. Use `drizzle-kit push --force` instead.

### The one exception: column RENAMES

`push` has no rename detection outside an interactive prompt, so on a rename it
DROPS the old column and ADDs the new one — discarding the data. A rename
therefore gets an explicit, dated `*.sql` file here that must be run **before**
`push` on any environment that predates it. `push` then reports "No changes
detected", which is the check that the two agree.

These files are live and maintained, unlike the deprecated numbered ones above:

| File | What it renames |
|---|---|
| `2026-09-26_access_axis_rename.sql` | The access axis: `role_functionalities` / `privileges` gain `functionality` + `action` in place of `module` + `functionality`, matching the Module → Functionality → Action vocabulary. Also restores the `roles.rank` column lost in an earlier table rename. |
