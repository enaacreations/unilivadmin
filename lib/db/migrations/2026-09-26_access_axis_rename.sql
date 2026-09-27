-- 2026-09-26_access_axis_rename.sql
--
-- RUN THIS BEFORE `drizzle-kit push` ON ANY ENVIRONMENT THAT PREDATES IT.
--
-- Unlike the deprecated numbered files in this directory, this one is live and
-- load-bearing: it performs COLUMN RENAMES, which is the one schema change
-- `push` cannot express. Drizzle has no rename detection without a TTY prompt,
-- so an un-migrated database would be "reconciled" by DROPPING the old columns
-- and ADDING the new ones — silently discarding every stored permission cell.
-- Run this first; `push` then reports "No changes detected".
--
-- ── What changed, and why ────────────────────────────────────────────────────
-- The access model became an explicit three-level hierarchy:
--
--   Module (10)        a product area — "Audits & Inspection". DERIVED from the
--                      code manifest, never stored (see below).
--   Functionality (54) a capability inside a module — "Audit register". The
--                      unit that is stored and enforced; every authorize() gate
--                      names one.
--   Action (13)        the verb — view / create / edit / approve / …
--
-- The columns already held exactly these three things; only two of them were
-- misnamed. `module` held functionality keys (AUDIT_REGISTER, FOOD_DISPATCH —
-- never a module), and `functionality` held action verbs, a leftover from an
-- earlier rename that moved `action` onto that name.
--
-- So this is PURELY a rename. No row is rewritten, no value changes, and the
-- unique indexes follow their columns automatically, landing in exactly the
-- order the Drizzle schema declares: (role_key, functionality, action).
--
-- ── Why the module is not a column ───────────────────────────────────────────
-- It is derived from the functionality by the code manifest (`moduleOf`), so
-- there is no second copy to drift, moving a functionality between modules is a
-- code change with no data migration, and — the load-bearing part — there is no
-- module-level row for a wildcard grant to hang off. A stored "all of AUDITS"
-- would silently confer functionalities added to that module later. The module
-- level is a FOLD over the functionality rows instead, computed at read time.

BEGIN;

-- The enum holds verbs, so it is the action enum.
ALTER TYPE functionality RENAME TO action;

-- Innermost first: `functionality` must vacate the name before `module` takes it.
ALTER TABLE role_functionalities RENAME COLUMN functionality TO action;
ALTER TABLE role_functionalities RENAME COLUMN module        TO functionality;

ALTER TABLE privileges           RENAME COLUMN functionality TO action;
ALTER TABLE privileges           RENAME COLUMN module        TO functionality;

-- ── Unrelated, found while auditing the schema against the database ──────────
-- roles.rank was lost when access_roles was renamed to roles in an earlier
-- session. The Drizzle schema has always declared it and two call sites read it,
-- so the matrix editor's "you may not rewrite a role above your own" guard
-- (matrix-guards.ts step 4) threw for any non-superadmin actor, and seedMatrix()
-- failed outright. Restored with the schema's own default, then backfilled from
-- ROLE_RANK (apps/api-server/src/lib/authz.ts) and MODULE_ROLES so the rank
-- comparison means what it meant before the column went missing.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 0;

UPDATE roles SET rank = v.rank FROM (VALUES
  ('SUPER_ADMIN',100),('OPS_EXCELLENCE',100),
  ('SENIOR_VICE_PRESIDENT',80),('AUDIT_READONLY',80),('FINANCE',80),('HR_MANAGER',80),
  ('OPERATIONS_MANAGER',80),('PROCUREMENT_MANAGER',80),('PROJECTS_MANAGER',80),
  ('PROPERTY_ACQUISITION',80),('FNB_ZONAL_HEAD',80),('ZONAL_HEAD',80),
  ('CITY_HEAD',50),('CLUSTER_MANAGER',50),('FNB_MANAGER',50),('FNB_SUPERVISOR',50),
  ('CUSTOMER_EXPERIENCE',50),
  ('WARDEN',20),('UNIT_LEAD',20),('SALES_EXECUTIVE',20),('KITCHEN_MANAGER',20),
  ('VENDOR_RESTRICTED',20),
  ('AUDIT.ADMIN',80),('AUDIT.SCHEDULER',50),('AUDIT.AUDITOR',20),
  ('AUDIT.REVIEWER',50),('AUDIT.AUDITEE',20),('AUDIT.VIEWER',20)
) AS v(key, rank) WHERE roles.key = v.key;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
--   \d role_functionalities   -> columns: role_key, functionality, action
--                                index role_functionalities_uq on
--                                (role_key, functionality, action)
--   \d privileges             -> columns: ..., functionality, action, ...
--   \d roles                  -> has `rank`
--   pnpm --filter @workspace/db run push   -> "No changes detected"
--
-- Row counts must be UNCHANGED across this migration — it renames, never
-- rewrites. Snapshot before and diff after if you want the proof.
