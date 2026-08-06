/**
 * Wipe the food order history — orders, dispatches, batches and drafts — so
 * unit leads and the kitchen personas start from an empty board.
 *
 *   pnpm --filter @workspace/scripts run clear:food-orders          # dry run
 *   pnpm --filter @workspace/scripts run clear:food-orders -- --yes # execute
 *
 * DESTRUCTIVE and irreversible. Defaults to a dry run: without `--yes` it only
 * prints what it would remove. Take a dump before running it anywhere that
 * isn't a local dev database.
 *
 * Delete order matters — `food_orders.dispatch_id` and `.batch_id` are NO
 * ACTION, so orders must go before the trips and batches they point at:
 *
 *   food_orders      → cascades to food_order_items,
 *                                  food_order_events,
 *                                  food_additional_order_items
 *   food_dispatches  → cascades to food_dispatch_events
 *   food_order_batches
 *   food_order_drafts
 *
 * Deliberately NOT touched: menus (food_menu_rotation), dishes, portion rules,
 * cut-offs, meal windows, kitchens, properties, users and scopes. This clears
 * transactional history only, never configuration.
 *
 * Order numbering self-heals: nextOrderNumber() takes MAX(order_number) for the
 * current year, so an empty table simply restarts at ORD-<year>-000001.
 */
import { pool } from "@workspace/db";

const TABLES = [
  // Ordered by dependency: orders first (they reference dispatches + batches).
  { name: "food_orders", note: "cascades → items, events, additional items" },
  { name: "food_dispatches", note: "cascades → dispatch events" },
  { name: "food_order_batches", note: "" },
  { name: "food_order_drafts", note: "" },
  // Cascade targets, counted for reporting only — never deleted directly.
  { name: "food_order_items", note: "", countOnly: true },
  { name: "food_order_events", note: "", countOnly: true },
  { name: "food_additional_order_items", note: "", countOnly: true },
  { name: "food_dispatch_events", note: "", countOnly: true },
] as const;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${t.name}`);
    out[t.name] = r.rows[0].n;
  }
  return out;
}

async function main() {
  const execute = process.argv.includes("--yes");
  const db = (await pool.query("SELECT current_database() AS d")).rows[0].d;

  const before = await counts();
  console.log(`\nDatabase: ${db}`);
  console.log(execute ? "Mode: EXECUTE (destructive)\n" : "Mode: DRY RUN — pass --yes to execute\n");
  for (const t of TABLES) {
    const tag = "countOnly" in t && t.countOnly ? "  (via cascade)" : "";
    console.log(`  ${t.name.padEnd(30)} ${String(before[t.name]).padStart(6)}${tag}${t.note ? "  — " + t.note : ""}`);
  }

  if (!execute) {
    console.log("\nNothing changed. Re-run with --yes to delete.");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of TABLES) {
      if ("countOnly" in t && t.countOnly) continue;
      const r = await client.query(`DELETE FROM ${t.name}`);
      console.log(`  ✓ deleted ${String(r.rowCount).padStart(6)} from ${t.name}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const after = await counts();
  const leftover = Object.entries(after).filter(([, n]) => n > 0);
  console.log(
    leftover.length
      ? `\n⚠ rows remaining: ${leftover.map(([t, n]) => `${t}=${n}`).join(", ")}`
      : "\n✅ food order history cleared — all order, dispatch, batch and draft tables are empty",
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
