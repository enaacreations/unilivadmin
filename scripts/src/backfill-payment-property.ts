/**
 * Fill `payments.property_id` on rows written before that column existed.
 *
 *   pnpm --filter @workspace/scripts run backfill:payment-property
 *
 * DEPLOY ORDER — this script runs BEFORE `pnpm --filter @workspace/db run push`.
 *
 * It has to, and it also has to create the column itself. `lib/db/src/schema/core.ts`
 * declares `property_id` NOT NULL with no default, so push must emit
 * `ADD COLUMN … NOT NULL`, which Postgres rejects outright on a table that
 * already holds rows. A backfill that only UPDATEs cannot run first either —
 * there is no column to update. So the ordering that actually works is:
 *
 *   1. this script  — ADD COLUMN IF NOT EXISTS property_id text  (nullable)
 *   2. this script  — populate it from residents.property_id, verify zero NULLs
 *   3. drizzle push — sees an existing nullable column and only has to SET NOT NULL
 *
 * Step 3 is the step that fails loudly if step 2 left anything behind, which is
 * why this script exits non-zero rather than "succeeding" with NULLs in place.
 *
 * Why the column exists: collections analytics used to attribute every payment
 * through `residents.property_id` — the resident's CURRENT property — so one
 * inter-property transfer rewrote both properties' whole revenue history (M10).
 * `payments.property_id` is the snapshot taken at collection time.
 *
 * The backfill value is the resident's property TODAY, which is the best
 * available approximation for a historical row and is exactly what the read
 * path was already reporting — so this changes no number, it only freezes them.
 *
 * Idempotent: the ADD COLUMN is IF NOT EXISTS, the UPDATE touches only NULL
 * rows, and a second run on a finished database reports "nothing to backfill".
 * Safe to re-run after push too — the column is then NOT NULL and there is
 * nothing left to find.
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  // A fresh database has no payments table yet; push will create it complete.
  const exists = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public.payments') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) {
    console.log("payments table does not exist yet — nothing to backfill, `push` will create it");
    await pool.end();
    return;
  }

  // The column push cannot add on its own. Nullable and defaultless on purpose:
  // a default would silently attribute legacy money to one property, and the
  // NOT NULL only becomes true once every row is genuinely attributed below.
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS property_id text`);
  console.log("payments.property_id present (added nullable if it was missing)");

  const before = await pool.query<{ total: string; missing: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE property_id IS NULL) AS missing FROM payments`,
  );
  const total = Number(before.rows[0]?.total ?? 0);
  const missing = Number(before.rows[0]?.missing ?? 0);
  console.log(`payments: ${total} row(s), ${missing} without a collected-at property`);

  if (missing === 0) {
    console.log("\n✅ nothing to backfill — payments.property_id can be made NOT NULL");
    await pool.end();
    return;
  }

  const filled = await pool.query(
    `UPDATE payments p
        SET property_id = r.property_id
       FROM residents r
      WHERE r.id = p.resident_id
        AND p.property_id IS NULL`,
  );
  console.log(`  ✓ filled ${filled.rowCount} row(s) from residents.property_id`);

  // A payment whose resident row is gone cannot be attributed. residents.id is
  // an FK target on payments, so this should be zero — report it rather than
  // inventing a property, because push will name the column and not the row.
  const orphans = await pool.query<{ id: string; resident_id: string }>(
    `SELECT id, resident_id FROM payments WHERE property_id IS NULL`,
  );
  if (orphans.rowCount) {
    console.log(`\n⚠ ${orphans.rowCount} payment(s) have no resident to attribute to:`);
    for (const row of orphans.rows) console.log(`      ${row.id} (resident ${row.resident_id})`);
    console.log("  Attribute them by hand, then re-run. `drizzle-kit push` will fail until they are resolved.");
    await pool.end();
    process.exit(1);
  }

  console.log("\n✅ every payment now carries the property it was collected at — `push` is safe");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
