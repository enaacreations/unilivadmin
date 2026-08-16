/**
 * Drop the columns this release removed from the schema, BEFORE `push` offers to.
 *
 *   pnpm --filter @workspace/scripts run drop:dead-columns          # report only
 *   pnpm --filter @workspace/scripts run drop:dead-columns -- --yes # drop them
 *
 * DEPLOY ORDER — runs AFTER every backfill and IMMEDIATELY BEFORE
 * `pnpm --filter @workspace/db run push`.
 *
 * The invariant it protects: once the backfills have run, `push` must have ZERO
 * data-loss statements left to propose, so the runbook's rule can stay absolute
 * — **any** data-loss prompt from `push` means stop. Without this step the rule
 * is unusable: `push` prompts "You're about to delete preparing_at column in
 * food_orders table with N items" on every database that holds orders, and an
 * operator told to abort on a data-loss prompt cannot finish the upgrade, while
 * an operator told to accept "the expected one" is being asked to tell a dead
 * column apart from `TRUNCATE payments` inside a two-line prompt, under time
 * pressure, with --force-grade consequences either way. Removing the prompt is
 * the only answer that needs no judgement.
 *
 * Why a script and not a psql one-liner: the `tools` image is node:22-slim with
 * no postgresql-client, so every DDL step in the runbook has to be reachable
 * through pnpm. `backfill-payment-property.ts` already does its own ADD COLUMN
 * for the same reason.
 *
 * Safety: a column is dropped only when it is entirely NULL — i.e. it never
 * held anything, which is the definition of dead. A dead column that turns out
 * to carry values on some database is NOT dropped; the script reports it and
 * exits non-zero so the operator (not the script, and not `--force`) decides.
 *
 * Idempotent: `DROP COLUMN IF EXISTS`, and a second run finds every entry
 * already gone and reports a clean no-op.
 */
import { pool } from "@workspace/db";

const APPLY = process.argv.includes("--yes");

type DeadColumn = {
  table: string;
  column: string;
  /** Why the schema no longer declares it — printed, so the drop is auditable. */
  why: string;
};

/**
 * Every column this branch removed from `lib/db/src/schema/**`. An entry missing
 * here is a data-loss prompt at `push` time, which is exactly the failure this
 * script exists to remove — add to this list in the same commit that deletes a
 * column from the schema.
 */
const DEAD_COLUMNS: DeadColumn[] = [
  {
    table: "food_orders",
    column: "preparing_at",
    why:
      "PREPARING is dead schema (L5): no producer has ever written this column " +
      "and ORDER_NEXT has no key for it, so canTransition('PREPARING', x) is " +
      "false for all x. The enum LABEL has to stay (Postgres cannot drop one in " +
      "place), but the timestamp column is gone from schema/food.ts.",
  },
];

async function main(): Promise<void> {
  console.log(
    `\n${DEAD_COLUMNS.length} dead column(s) to check · mode ${APPLY ? "APPLY (dropping)" : "REPORT (no writes)"}\n`,
  );

  const pending: DeadColumn[] = [];
  const blocked: { col: DeadColumn; populated: number }[] = [];

  for (const dc of DEAD_COLUMNS) {
    const label = `${dc.table}.${dc.column}`;

    // A fresh database has neither the table nor the column; push creates the
    // table already correct, so both cases are a clean no-op.
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS present`,
      [dc.table, dc.column],
    );
    if (!rows[0]?.present) {
      console.log(`  ✓  ${label.padEnd(28)} already absent — nothing for push to propose`);
      continue;
    }

    const { rows: cnt } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${dc.table}" WHERE "${dc.column}" IS NOT NULL`,
    );
    const populated = cnt[0]?.n ?? 0;
    if (populated > 0) {
      blocked.push({ col: dc, populated });
      console.log(`  ✗  ${label.padEnd(28)} holds ${populated} non-NULL value(s) — NOT dropped`);
      continue;
    }

    pending.push(dc);
    console.log(`  →  ${label.padEnd(28)} present and entirely NULL — ${APPLY ? "dropping" : "would drop"}`);
    console.log(`     ${dc.why}`);
  }

  if (APPLY) {
    for (const dc of pending) {
      await pool.query(`ALTER TABLE "${dc.table}" DROP COLUMN IF EXISTS "${dc.column}"`);
      console.log(`  ✓ dropped ${dc.table}.${dc.column}`);
    }
  }

  if (blocked.length) {
    console.log(`\n❌ ${blocked.length} dead column(s) still hold data. Do NOT run push yet —`);
    console.log("  it would offer to delete them and the runbook tells you to abort on that prompt.");
    console.log("  Export or reconcile the values, empty the column, then re-run this script:");
    for (const b of blocked) {
      console.log(`     ${b.col.table}.${b.col.column} — ${b.populated} non-NULL row(s)`);
    }
    await pool.end();
    process.exit(1);
  }

  if (!APPLY && pending.length) {
    console.log(`\nRe-run with -- --yes to drop ${pending.length} column(s). Until then \`push\` will`);
    console.log("  prompt to delete them and the upgrade cannot proceed.");
    await pool.end();
    return;
  }

  console.log("\n✅ no dead columns left — `push` has no data-loss statement to propose");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
