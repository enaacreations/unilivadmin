-- 2026-09-26b_complaints_laundry_housekeeping_modules.sql
--
-- RUN AFTER 2026-09-26_access_axis_rename.sql, BEFORE `drizzle-kit push`.
--
-- Complaint Management, Laundry and Housekeeping become MODULES of their own
-- (product, 2026-09-26). Complaints and Laundry were functionalities inside
-- Operations; Housekeeping is new.
--
-- ── Why this needs a data migration at all ───────────────────────────────────
-- Module keys and functionality keys are disjoint by construction (asserted at
-- import in permissions.ts), so `COMPLAINTS` cannot be both. Promoting it to a
-- module therefore frees the key, and the functionality beneath it is renamed:
--
--   COMPLAINTS  ->  COMPLAINT_TICKETS   (the queue)
--   LAUNDRY     ->  LAUNDRY_BATCHES     (gates laundry_batches, the whole surface)
--
-- `isManifestCell()` enforces the code manifest as a CEILING on read: a stored
-- row naming a functionality the manifest no longer knows is skipped, not
-- honoured. So shipping the rename without this migration does not error — it
-- SILENTLY REVOKES every stored grant on those two keys. At the time of writing
-- that is 16 matrix cells (OPERATIONS_MANAGER and WARDEN) and 2 privileges.
-- A silent revocation is the worst failure mode this table has; hence a data
-- migration rather than a code-only change.
--
-- The two NEW functionalities need no rows here:
--   COMPLAINT_ROUTING  — granted through the code matrix, mirroring each role's
--                        existing SETTINGS level so the /settings/sla and
--                        /settings/routing endpoints keep exactly their current
--                        audience after moving off the SETTINGS gate.
--   HOUSEKEEPING_TASKS — reserved, gates no route yet. Only the parity roles
--                        hold it, and they hold it by computation, not by row.

BEGIN;

UPDATE role_functionalities SET functionality = 'COMPLAINT_TICKETS' WHERE functionality = 'COMPLAINTS';
UPDATE role_functionalities SET functionality = 'LAUNDRY_BATCHES'   WHERE functionality = 'LAUNDRY';

UPDATE privileges           SET functionality = 'COMPLAINT_TICKETS' WHERE functionality = 'COMPLAINTS';
UPDATE privileges           SET functionality = 'LAUNDRY_BATCHES'   WHERE functionality = 'LAUNDRY';

-- COMPLAINT_ROUTING: carry every stored SETTINGS grant across to it, so the
-- /settings/sla and /settings/routing endpoints keep exactly the audience they
-- had before the gate moved off SETTINGS.
--
-- The code matrix alone is NOT enough here. It is a fallback: once
-- role_functionalities has rows, `can()` answers from the DATABASE snapshot, so
-- a cell added only to ROLE_PERMISSIONS is invisible on any seeded environment.
-- Today that is HR_MANAGER:view — without this, they silently lose a screen
-- they can use right now.
INSERT INTO role_functionalities (id, role_key, functionality, action, allowed, updated_by)
SELECT 'crt-' || md5(role_key || ':' || action::text), role_key, 'COMPLAINT_ROUTING', action, allowed, NULL
  FROM role_functionalities
 WHERE functionality = 'SETTINGS' AND allowed
ON CONFLICT (role_key, functionality, action) DO NOTHING;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
--   SELECT count(*) FROM role_functionalities
--    WHERE functionality IN ('COMPLAINTS','LAUNDRY');          -- must be 0
--   SELECT count(*) FROM role_functionalities
--    WHERE functionality IN ('COMPLAINT_TICKETS','LAUNDRY_BATCHES');
--                                                              -- must equal the
--                                                              -- pre-migration
--                                                              -- count (16 here)
--
-- Unlike the axis rename, this one is idempotent: re-running matches zero rows
-- and changes nothing.
