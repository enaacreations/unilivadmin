/**
 * Assert the database actually has every table/column the Drizzle schema declares.
 *
 *   pnpm -C scripts run verify:schema
 *
 * DEPLOY ORDER — runs IMMEDIATELY AFTER `push` and BEFORE the api/web containers
 * are started (see scripts/deploy.sh).
 *
 * The invariant it protects: a deploy must never start new code against a
 * database the migration step did not actually reach. That is not hypothetical —
 * it is how `GET /api/food/dishes` shipped 500ing on the dev box. `deploy.sh`
 * invoked the push as `pnpm --filter @workspace/db run push-force`, and pnpm
 * exits **0** when a `--filter` matches no project ("No projects matched the
 * filters"), so a push that never ran looked identical to a push that succeeded.
 * `set -e` had nothing to trip on, `docker compose up -d api web` ran anyway, and
 * the new API selected a `color` column the database had never been given.
 *
 * Why this and not "did push exit 0": exit status only tells you the migration
 * tool ran, not that the schema it produced matches the code about to query it.
 * This compares the two directly, so any path that leaves them divergent — a
 * skipped step, a wrong DATABASE_URL, a half-applied push — fails the deploy
 * instead of shipping a broken catalogue.
 *
 * Why a script and not psql: the `tools` image is node:22-slim with no
 * postgresql-client, so every DB step in the runbook has to be reachable through
 * pnpm — same reason drop-dead-columns.ts exists.
 *
 * Direction is deliberate: it reports what the code needs and the database
 * LACKS. Extra columns the schema no longer declares are NOT failures — they are
 * dead weight that drop-dead-columns.ts retires on its own schedule, and a
 * database is perfectly queryable with them present. Failing on those would make
 * every deploy that precedes a cleanup red for no operational reason.
 *
 * Read-only: it issues one catalogue query and never writes.
 */
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import { pool } from "@workspace/db";

type Drift =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string };

async function main(): Promise<void> {
  // Every PgTable the schema barrel exports. The barrel also exports enums,
  // relations and helpers, so filter by identity rather than by shape.
  // `is()` is the runtime guard; the assertion is only to collapse the barrel's
  // 200-member union of literally-typed tables and enums back to plain PgTable.
  // A `v is PgTable` predicate cannot be written here — PgTable<TableConfig> is
  // not assignable to a union member typed with its own literal table name.
  const tables = Object.values(schema).filter((v) => is(v, PgTable)) as unknown as PgTable[];

  if (!tables.length) {
    console.error("✖ No tables found in @workspace/db/schema — the import resolved to nothing.");
    process.exitCode = 1;
    return;
  }

  // One catalogue read for the whole database; per-table queries would be a
  // needless round trip each and this runs on every deploy.
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  );

  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    let cols = actual.get(r.table_name);
    if (!cols) actual.set(r.table_name, (cols = new Set()));
    cols.add(r.column_name);
  }

  const drift: Drift[] = [];
  let columnCount = 0;

  for (const table of tables) {
    const name = getTableName(table);
    const present = actual.get(name);
    if (!present) {
      drift.push({ kind: "table", table: name });
      continue;
    }
    // Column keys are the TS property names; `.name` is what Postgres sees, and
    // that is the only one worth comparing (photoUrl vs photo_url).
    for (const col of Object.values(getTableColumns(table))) {
      columnCount++;
      if (!present.has(col.name)) drift.push({ kind: "column", table: name, column: col.name });
    }
  }

  if (!drift.length) {
    console.log(`✓ Schema matches: ${tables.length} tables, ${columnCount} columns.`);
    return;
  }

  console.error("✖ The database is BEHIND the code — the migration step did not fully apply.\n");
  for (const d of drift) {
    if (d.kind === "table") console.error(`  MISSING TABLE   ${d.table}`);
    else console.error(`  MISSING COLUMN  ${d.table}.${d.column}`);
  }
  console.error(
    `\n${drift.length} difference(s). Every query touching the above will fail at runtime.\n` +
      "Apply the schema, then re-run this check:\n" +
      "  pnpm -C lib/db run push-force\n",
  );
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("✖ Schema verification could not run:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
