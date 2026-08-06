/**
 * Find (and optionally remove) the rows that block the uniqueness constraints
 * this branch declares in `lib/db/src/schema/food.ts` / `wallet.ts` / `core.ts`.
 * Every unique index those files add is checked here — a check missing from
 * CHECKS is a clean run that push then fails on, which is worse than no script.
 *
 *   pnpm --filter @workspace/scripts run dedupe:food          # report only
 *   pnpm --filter @workspace/scripts run dedupe:food -- --yes # collapse duplicates
 *
 * Run this BEFORE `pnpm --filter @workspace/db run push` on any database that
 * already holds data: `drizzle-kit push` aborts when a unique index cannot be
 * built, and the failure message names the index, not the offending rows.
 *
 * Idempotent and safe to re-run: it collapses each duplicate group to a single
 * surviving row, so a second run finds nothing. On the local dev database it is
 * a no-op today (verified: zero duplicate groups across every key below) — it
 * exists for the seeded/e2e databases and for re-verification after a seed.
 *
 * CONFIG duplicates are collapsed (`--yes`); MONEY and ORDER duplicates are only
 * reported, with their rows printed. Payments, wallet transactions and live
 * orders are business records: a duplicate live order must be CANCELLED through
 * the API so the event log records who did it, a duplicate wallet transaction
 * must be reversed, and a duplicate payment voided in the finance module. A
 * database that suffered the pre-fix double-settlement bug is GUARANTEED to
 * carry payments duplicates — that is precisely what uq_payments_razorpay_pay_id
 * exists to stop — so expect this script to report them and expect resolving
 * them to be a finance decision, not a DELETE.
 *
 * Keeper rule for the collapsed groups: the most recently updated row wins
 * (ties broken by id), because config surfaces are edit-in-place and the newest
 * row is what the UI has been showing.
 */
import { pool } from "@workspace/db";

type Check = {
  /** Short name printed in the report. */
  label: string;
  table: string;
  /** Columns the unique index groups on. */
  keys: string[];
  /** Partial-index predicate, mirroring the schema's `.where()`. */
  predicate: string;
  /** ORDER BY inside the partition — row 1 survives. */
  keeper: string;
  /** Reported only; never deleted. */
  reportOnly?: boolean;
  /** Why it is report-only / anything the operator must know. */
  note?: string;
  /**
   * Columns printed for every row of a duplicate group. Set on the money checks:
   * "2× razorpay_pay_id=pay_x" is not enough to decide which record to keep, and
   * these are exactly the groups the operator has to resolve by hand.
   */
  detail?: string[];
};

const CHECKS: Check[] = [
  // ── Config: collapsed automatically ──────────────────────────────────────
  {
    label: "food_menu_rotation slot (kitchen-scoped)",
    table: "food_menu_rotation",
    keys: ["kitchen_id", "brand", "rotation_week", "day_of_week", "meal_type", "dish_id"],
    predicate: "kitchen_id is not null",
    // Prefer a row that other rows hang off as their parent, so collapsing a
    // duplicate never cascade-deletes a side dish that is still in use.
    keeper:
      "(select count(*) from food_menu_rotation c where c.parent_rotation_id = t.id) desc, t.updated_at desc, t.id",
  },
  {
    label: "food_menu_rotation slot (no kitchen)",
    table: "food_menu_rotation",
    keys: ["brand", "rotation_week", "day_of_week", "meal_type", "dish_id"],
    predicate: "kitchen_id is null",
    keeper:
      "(select count(*) from food_menu_rotation c where c.parent_rotation_id = t.id) desc, t.updated_at desc, t.id",
  },
  {
    label: "per_resident_rules (property override)",
    table: "per_resident_rules",
    keys: ["brand", "meal_type", "dish_id", "property_id"],
    predicate: "property_id is not null",
    keeper: "t.updated_at desc, t.id",
  },
  {
    label: "per_resident_rules (global default)",
    table: "per_resident_rules",
    keys: ["brand", "meal_type", "dish_id"],
    predicate: "property_id is null",
    keeper: "t.updated_at desc, t.id",
  },
  {
    label: "food_meal_windows (property override)",
    table: "food_meal_windows",
    keys: ["brand", "meal_type", "property_id"],
    predicate: "property_id is not null",
    keeper: "t.updated_at desc, t.id",
  },
  {
    label: "food_meal_windows (global default)",
    table: "food_meal_windows",
    keys: ["brand", "meal_type"],
    predicate: "property_id is null",
    keeper: "t.updated_at desc, t.id",
  },
  {
    label: "food_cutoffs (property override)",
    table: "food_cutoffs",
    keys: ["brand", "property_id"],
    predicate: "property_id is not null",
    keeper: "t.updated_at desc, t.id",
  },
  {
    label: "food_cutoffs (global default)",
    table: "food_cutoffs",
    keys: ["brand"],
    predicate: "property_id is null",
    keeper: "t.updated_at desc, t.id",
  },
  // One check per uq_user_scopes_grant_* partial index (schema/food.ts). Checked
  // one geo column at a time because that is how the indexes are declared: a
  // single grouping over all five columns would call a malformed row that
  // populates two of them "distinct", and push would then fail on an index this
  // script had just reported clean.
  ...(["zone_id", "city_id", "cluster_id", "kitchen_id", "property_id"] as const).map(
    (col): Check => ({
      label: `user_scopes grant (${col})`,
      table: "user_scopes",
      keys: ["user_id", "scope_level", col],
      predicate: `${col} is not null`,
      keeper: "t.created_at desc, t.id",
    }),
  ),
  {
    label: "user_scopes grant (no geo target)",
    table: "user_scopes",
    keys: ["user_id", "scope_level"],
    predicate:
      "zone_id is null and city_id is null and cluster_id is null and kitchen_id is null and property_id is null",
    keeper: "t.created_at desc, t.id",
  },

  {
    label: "food_additional_order_items (request, dish)",
    table: "food_additional_order_items",
    keys: ["order_id", "request_id", "dish_id"],
    predicate: "true",
    // Keep the FIRST row of the submission; the later ones are the replays the
    // pre-M18 content-similarity heuristic could not tell from a genuine
    // second top-up, and every one of them double-counts food that arrived once.
    keeper: "t.created_at, t.id",
  },

  // ── Transactional: reported only ─────────────────────────────────────────
  {
    label: "payments razorpay payment id",
    table: "payments",
    keys: ["razorpay_pay_id"],
    predicate: "razorpay_pay_id is not null",
    keeper: "t.created_at, t.id",
    reportOnly: true,
    detail: ["id", "resident_id", "amount", "status", "created_at"],
    note:
      "these ARE the double-settlement corruption uq_payments_razorpay_pay_id prevents — " +
      "keep the first SUCCESS row, void the rest through the finance module; never DELETE a payment record",
  },
  {
    label: "food_orders live (property, meal, service date)",
    table: "food_orders",
    keys: ["property_id", "meal_type", "service_date"],
    predicate: "status <> 'CANCELLED' and status <> 'REJECTED'",
    keeper: "t.created_at, t.id",
    reportOnly: true,
    note: "cancel the surplus order through the API (POST /food/orders/:id/cancel) — never delete it",
  },
  {
    label: "wallet_transactions reference",
    table: "wallet_transactions",
    keys: ["reference_type", "reference_id"],
    predicate: "reference_id is not null",
    keeper: "t.created_at, t.id",
    reportOnly: true,
    detail: ["id", "wallet_id", "type", "amount", "created_at"],
    note: "a duplicate credit must be reversed through the wallet API, never deleted",
  },
];

function dupGroupsSql(c: Check): string {
  return `
    SELECT ${c.keys.join(", ")}, count(*)::int AS n
      FROM ${c.table}
     WHERE ${c.predicate}
     GROUP BY ${c.keys.map((_, i) => i + 1).join(", ")}
    HAVING count(*) > 1
     ORDER BY n DESC
     LIMIT 20`;
}

function surplusIdsSql(c: Check): string {
  return `
    SELECT id FROM (
      SELECT t.id,
             row_number() OVER (
               PARTITION BY ${c.keys.map((k) => `t.${k}`).join(", ")}
               ORDER BY ${c.keeper}
             ) AS rn
        FROM ${c.table} t
       WHERE ${c.predicate}
    ) s WHERE rn > 1`;
}

/**
 * Every row of every duplicate group, for the checks the operator resolves by
 * hand. PARTITION BY (not GROUP BY … IN) so a NULL key column still groups —
 * wallet_transactions.reference_type is nullable and row-comparison IN would
 * silently drop those groups from the report.
 */
function detailRowsSql(c: Check): string {
  const partition = c.keys.map((k) => `t.${k}`).join(", ");
  return `
    SELECT * FROM (
      SELECT ${c.keys.map((k) => `t.${k}`).join(", ")}, ${c.detail!.map((d) => `t.${d}`).join(", ")},
             count(*)  OVER (PARTITION BY ${partition}) AS grp_n,
             row_number() OVER (PARTITION BY ${partition} ORDER BY ${c.keeper}) AS rn
        FROM ${c.table} t
       WHERE ${c.predicate}
    ) s WHERE grp_n > 1
     ORDER BY ${c.keys.join(", ")}, rn
     LIMIT 100`;
}

async function main() {
  const execute = process.argv.includes("--yes");
  const dbName = (await pool.query("SELECT current_database() AS d")).rows[0].d;

  console.log(`\nDatabase: ${dbName}`);
  console.log(execute ? "Mode: EXECUTE (deletes surplus config rows)\n" : "Mode: REPORT ONLY — pass --yes to collapse duplicates\n");

  let blocking = 0;
  let removed = 0;

  for (const c of CHECKS) {
    const groups = await pool.query(dupGroupsSql(c));
    const surplus = await pool.query(surplusIdsSql(c));
    const n = surplus.rowCount ?? 0;

    if (groups.rowCount === 0) {
      console.log(`  ✓ ${c.label.padEnd(42)} clean`);
      continue;
    }

    console.log(`  ✗ ${c.label.padEnd(42)} ${groups.rowCount} duplicate group(s), ${n} surplus row(s)`);
    for (const row of groups.rows) {
      const key = c.keys.map((k) => `${k}=${row[k] ?? "NULL"}`).join(" ");
      console.log(`      ${row.n}× ${key}`);
    }
    if (c.detail) {
      const rows = await pool.query(detailRowsSql(c));
      for (const r of rows.rows) {
        const keep = Number(r["rn"]) === 1 ? "KEEP  " : "SURPLUS";
        const cols = c.detail.map((d) => `${d}=${r[d] ?? "NULL"}`).join(" ");
        console.log(`        ${keep} ${cols}`);
      }
    }
    if (c.note) console.log(`      → ${c.note}`);

    if (c.reportOnly) {
      blocking += n;
      continue;
    }
    if (!execute) {
      blocking += n;
      continue;
    }
    const del = await pool.query(`DELETE FROM ${c.table} WHERE id IN (${surplusIdsSql(c)})`);
    removed += del.rowCount ?? 0;
    console.log(`      ✓ removed ${del.rowCount} surplus row(s)`);
  }

  if (execute) console.log(`\nRemoved ${removed} surplus config row(s).`);

  if (blocking > 0) {
    console.log(
      `\n⚠ ${blocking} row(s) still violate a declared unique index. ` +
        (execute ? "Resolve the report-only tables by hand." : "Re-run with --yes to collapse the config duplicates.") +
        "\n  `drizzle-kit push` will fail until they are gone.",
    );
    await pool.end();
    process.exit(1);
  }

  console.log("\n✅ no duplicates — every unique index this branch declares can be created");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
