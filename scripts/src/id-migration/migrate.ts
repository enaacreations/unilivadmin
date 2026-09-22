/**
 * Swap every text/uuid primary key in this database for a bigint drawn from one
 * global sequence (ID_MIGRATION_PLAN.md §1).
 *
 *   pnpm -C scripts run id:migrate                  # dry-run: plans, writes nothing
 *   pnpm -C scripts run id:migrate -- --apply       # perform the swap
 *   pnpm -C scripts run id:migrate -- --apply --drop-drafts
 *
 * NEVER run this against dev or production from a developer machine. It refuses
 * to touch a database whose name is in PROTECTED_DBS unless --force-db is
 * passed, and the intended target is a scratch restore (see §6: rehearse on
 * restored data, not a seed).
 *
 * ── Relationship to the plan's four phases ──────────────────────────────────
 *
 * The plan splits this into an online A→B→C→D with the expand phase additive
 * and CONCURRENTLY-indexed so the previous release keeps serving. This runner
 * does A and C together in ONE transaction, which is the right shape for the
 * rehearsal §6 asks for and for any cutover that can take a maintenance window:
 *
 *   - Atomicity replaces resumability. Postgres DDL is transactional, so a
 *     failure at table 100 of 137 leaves nothing behind to reconcile. The
 *     plan's "idempotent and re-runnable" then costs nothing to honour: a
 *     re-run finds either a fully migrated database (no-op) or an untouched
 *     one.
 *   - Dependency ordering becomes unnecessary. Every FK is dropped up front and
 *     re-added at the end from its captured definition, inside the same
 *     transaction, so the topological sort the plan needs for an online expand
 *     has nothing to order.
 *   - CREATE INDEX CONCURRENTLY is not available in a transaction, so legacy_id
 *     indexes are built plainly. That is a lock this holds and the online
 *     version would not — the trade the window buys.
 *
 * For the online rollout, this file is the reference implementation of the
 * rewrites (§4 and the two surfaces §4 misses); id:expand / id:swap would split
 * the same steps across releases.
 *
 * ── The rename trick ────────────────────────────────────────────────────────
 *
 * Constraint and index definitions are captured as TEXT before the swap and
 * re-issued verbatim afterwards. That works because the swap preserves NAMES:
 * `parent_id` (text) becomes `parent_legacy_id` and `parent_id_new` becomes
 * `parent_id` (bigint), so a captured `FOREIGN KEY (parent_id) REFERENCES …`
 * is still syntactically correct and now binds the bigint column.
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 * Fail-closed on anything unclassified. Before writing, it re-derives the
 * uuid-bearing surface from the live database and compares it against
 * manifest.ts. A column holding uuids that the manifest does not classify
 * aborts the run — because the alternative is a rewrite that guesses, or an
 * omission nobody notices until a billing run doubles.
 */
import { pool } from "@workspace/db";
import {
  DERIVED_KEYS, JSON_COLUMNS, POINTER_COLUMNS, UUID_RE, EMBEDDED_UUID_RE,
  jsonRule, pointerRule, derivedKeyRule,
} from "./manifest.js";
import { rewrite } from "./json-paths.js";
import { readCatalog, fkColumns, compositeFks, q, type Catalog, type PgClient } from "./catalog.js";

const APPLY = process.argv.includes("--apply");
const FORCE_DB = process.argv.includes("--force-db");
const DROP_DRAFTS = process.argv.includes("--drop-drafts");

/** Databases this script will not touch without --force-db. */
const PROTECTED_DBS = (process.env["ID_MIGRATION_PROTECTED_DBS"] ?? "uniliv,uniliv_dev,uniliv_prod,postgres")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SEQ = "global_id_seq";
const MAP_TABLE = "id_migration_map";
/** Constraints dropped for the swap, so id:verify can prove they all came back. */
const CONSTRAINT_TABLE = "id_migration_constraints";
/** Suffix for the bigint column while both live side by side. */
const NEW = "_id_new";

const log = (s = "") => console.log(s);
// Annotated on the variable, not the arrow: that is what lets control-flow
// analysis treat a call as terminating.
const fail: (s: string) => never = (s) => { throw new Error(s); };

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows: [dbRow] } = await client.query<{ db: string }>(`SELECT current_database() AS db`);
    const db = dbRow!.db;
    log(`\nid:migrate · database ${db} · mode ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

    if (PROTECTED_DBS.includes(db) && !FORCE_DB) {
      fail(
        `Refusing to plan against "${db}" — it is in ID_MIGRATION_PROTECTED_DBS.\n` +
        `  This migration is destructive and must be rehearsed on a scratch restore.\n` +
        `  If you genuinely mean this database, re-run with --force-db.`,
      );
    }

    const cat = await readCatalog(client);
    log(`  ${cat.tables.length} tables · ${cat.textIdTables.length} with a text id PK · ${cat.fks.length} FK constraints`);

    if (await alreadyMigrated(client, cat)) {
      log(`\n✅ already migrated — every text id PK is gone and legacy_id is present. Nothing to do.`);
      return;
    }

    await preflight(client, cat);

    if (!APPLY) {
      log(`\nDry run complete. Re-run with -- --apply to perform the swap.`);
      return;
    }

    await client.query("BEGIN");
    try {
      await expand(client, cat);
      await rewriteJson(client);
      await rewritePointers(client, cat);
      await rewriteDerivedKeys(client);
      await swap(client, cat);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      log(`\n❌ rolled back — the database is exactly as it was.`);
      throw err;
    }

    log(`\n✅ swap complete. Run \`pnpm -C scripts run id:verify\` before trusting it.`);
  } finally {
    client.release();
    await pool.end();
  }
}

/* ───────────────────────────────────────────────────────────── idempotency ── */

/**
 * The migration is re-runnable because it is atomic: either every table has a
 * bigint id and a legacy_id, or none does. A database in between means someone
 * committed a partial run by hand, and that is a stop, not a resume.
 */
async function alreadyMigrated(client: PgClient, cat: Catalog): Promise<boolean> {
  const withLegacy = cat.tables.filter((t) => cat.columns.get(t)?.has("legacy_id"));
  if (withLegacy.length === 0) return false;
  if (cat.textIdTables.length === 0) return true;
  fail(
    `Database is half-migrated: ${withLegacy.length} table(s) have legacy_id but ` +
    `${cat.textIdTables.length} still have a text id PK.\n` +
    `  This runner is atomic, so it cannot have produced that state. Restore the ` +
    `snapshot and start again.`,
  );
}

/* ─────────────────────────────────────────────────────────────── preflight ── */

/**
 * Compare the live uuid surface against the manifest. Everything this reports
 * is a thing the migration would otherwise handle by guessing.
 */
async function preflight(client: PgClient, cat: Catalog): Promise<void> {
  log(`\n── preflight ──`);
  const problems: string[] = [];

  const composite = compositeFks(cat);
  if (composite.length) {
    problems.push(
      `${composite.length} composite FK(s) — this runner only migrates single-column edges: ` +
      composite.map((f) => f.name).join(", "),
    );
  }

  // Every id string that exists right now, in one session-local temp table.
  // Discovery cannot be shape-based: seeded rows carry readable ids
  // (`user_food_unit2`, `dish_curd`, `org-root`), and a uuid regex walks past
  // every one of them — which would make "fail closed on anything
  // unclassified" a claim this script does not actually honour. This is the
  // only thing a dry run writes, and it lives and dies with the connection.
  await client.query(`CREATE TEMP TABLE IF NOT EXISTS _id_all (id text PRIMARY KEY) ON COMMIT PRESERVE ROWS`);
  await client.query(`TRUNCATE _id_all`);
  for (const t of cat.textIdTables) {
    await client.query(`INSERT INTO _id_all (id) SELECT id FROM ${q(t)} ON CONFLICT DO NOTHING`);
  }
  const { rows: idCount } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM _id_all`);
  log(`  ${idCount[0]!.n} distinct id(s) in play`);

  // 1. Unconstrained text columns holding ids that the manifest does not know.
  const declaredFk = new Set(fkColumns(cat).map((c) => `${c.table}.${c.column}`));
  const { rows: candidates } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.data_type = 'text' AND c.column_name <> 'id'
      ORDER BY 1, 2`,
  );
  let unclassifiedPointers = 0;
  let unclassifiedDerived = 0;
  for (const c of candidates) {
    const name = `${c.table_name}.${c.column_name}`;
    if (declaredFk.has(name)) continue;
    const { rows } = await client.query<{ whole: string; embedded: string; known: string }>(
      `SELECT count(*) FILTER (WHERE t.${q(c.column_name)} ~* $1)::text AS whole,
              count(*) FILTER (WHERE t.${q(c.column_name)} ~ $2 AND t.${q(c.column_name)} !~* $1)::text AS embedded,
              count(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM _id_all a WHERE a.id = t.${q(c.column_name)})
              )::text AS known
         FROM ${q(c.table_name)} t`,
      [UUID_RE.source, EMBEDDED_UUID_RE.source],
    );
    const whole = Number(rows[0]!.whole);
    const embedded = Number(rows[0]!.embedded);
    // `known` is the real signal — it catches a non-uuid id that `whole` cannot.
    const known = Number(rows[0]!.known);
    if ((whole > 0 || known > 0) && !pointerRule(c.table_name, c.column_name)) {
      problems.push(
        `unclassified id pointer: ${name} (${whole} uuid row(s), ${known} row(s) matching a live id) ` +
        `— add it to POINTER_COLUMNS`,
      );
      unclassifiedPointers++;
    }
    if (embedded > 0 && !derivedKeyRule(c.table_name, c.column_name)) {
      problems.push(`unclassified derived key: ${name} (${embedded} rows embed a uuid) — add it to DERIVED_KEYS`);
      unclassifiedDerived++;
    }
  }
  log(`  scanned ${candidates.length} unconstrained text column(s): ` +
      `${unclassifiedPointers} unclassified pointer(s), ${unclassifiedDerived} unclassified derived key(s)`);

  // 2. json/jsonb columns the manifest does not classify.
  const { rows: jsonCols } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.data_type IN ('json', 'jsonb')
      ORDER BY 1, 2`,
  );
  for (const c of jsonCols) {
    if (!jsonRule(c.table_name, c.column_name)) {
      problems.push(`unclassified json column: ${c.table_name}.${c.column_name} — add it to JSON_COLUMNS`);
    }
  }
  log(`  scanned ${jsonCols.length} json/jsonb column(s)`);

  // 3. BLOCKED columns that turned out to hold something.
  for (const rule of JSON_COLUMNS.filter((r) => r.verdict === "BLOCKED")) {
    if (!cat.columns.get(rule.table)?.has(rule.column)) continue;
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(rule.table)}
        WHERE ${q(rule.column)} IS NOT NULL AND ${q(rule.column)}::text ~ $1`,
      [EMBEDDED_UUID_RE.source],
    );
    const n = Number(rows[0]!.n);
    if (n === 0) continue;
    const isDraft = rule.column === "payload" && rule.table.endsWith("_drafts");
    if (isDraft && DROP_DRAFTS) {
      log(`  ${rule.table}.${rule.column}: ${n} row(s) hold ids — will DELETE (--drop-drafts)`);
      continue;
    }
    problems.push(
      `${rule.table}.${rule.column} holds ${n} row(s) with embedded ids and its shape is not ` +
      `statically knowable.\n      ${rule.note.split("\n")[0]}` +
      (isDraft ? `\n      Re-run with --drop-drafts to delete them.` : ``),
    );
  }

  if (problems.length) {
    log(`\n❌ preflight found ${problems.length} thing(s) the migration would have to guess at:\n`);
    for (const p of problems) log(`   • ${p}`);
    fail(`Classify them in scripts/src/id-migration/manifest.ts, then re-run.`);
  }
  log(`  ✓ every uuid-bearing column is classified`);
}

/* ────────────────────────────────────────────────────────────────── expand ── */

/**
 * Give every DISTINCT id string one bigint, and every row that carries it the
 * same bigint. Recorded in a persisted map, old → new.
 *
 * ONE map for every table, keyed by the legacy id alone. That is what lets a
 * json payload or a polymorphic pointer be rewritten without first knowing
 * which table its id came from.
 *
 * ── Why allocation is per id STRING and not per row ─────────────────────────
 *
 * §1 of the plan says a global sequence "preserves G1 exactly as randomUUID()
 * did" — G1 being the access-control invariant that an org node's id IS the
 * entity's id. That reads the invariant backwards. randomUUID() never had to
 * preserve anything: the application deliberately writes the SAME string as
 * both `properties.id` and the `org_nodes.id` of that property's node. G1 needs
 * two rows in two tables to SHARE an id, which is the one thing a uniqueness
 * guarantee does not give you.
 *
 * Drawing nextval() per table, as §1's `ADD COLUMN … UPDATE … nextval` sketch
 * does, hands the property and its org node two different numbers and G1 is
 * gone — silently, with every ~90 food/audit scoping call site the plan says
 * "change by zero lines" now resolving against a node that is no longer the
 * entity. This database has 82 such shared id strings across 164 rows
 * (org_nodes ↔ zones/cities/clusters/properties, and agencies ↔
 * delivery_partners).
 *
 * Allocating from the map instead makes the aliasing survive by construction:
 * one string in, one number out, however many tables hold it.
 */
async function expand(client: PgClient, cat: Catalog): Promise<void> {
  log(`\n── expand ──`);
  await client.query(`CREATE SEQUENCE IF NOT EXISTS ${q(SEQ)} AS bigint START 1000 CACHE 100`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${q(MAP_TABLE)} (
       legacy_id text PRIMARY KEY,
       new_id    bigint NOT NULL UNIQUE,
       table_name text NOT NULL,
       migrated_at timestamp NOT NULL DEFAULT now()
     )`,
  );

  // Pass 1: claim a number for every id string. ON CONFLICT DO NOTHING is what
  // makes a shared id resolve to one number; the nextval it burns on the losing
  // row is a gap in the sequence, which §1 already accepts as cosmetic.
  let mapped = 0;
  for (const table of cat.textIdTables) {
    await client.query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q("id" + NEW)} bigint`);
    const res = await client.query(
      `INSERT INTO ${q(MAP_TABLE)} (legacy_id, new_id, table_name)
       SELECT id, nextval('${SEQ}'), $1 FROM ${q(table)}
       ON CONFLICT (legacy_id) DO NOTHING`,
      [table],
    );
    mapped += res.rowCount ?? 0;
  }

  // Pass 2: every row takes the number its id string was given.
  let rows = 0;
  for (const table of cat.textIdTables) {
    const res = await client.query(
      `UPDATE ${q(table)} t SET ${q("id" + NEW)} = m.new_id
         FROM ${q(MAP_TABLE)} m
        WHERE m.legacy_id = t.id AND t.${q("id" + NEW)} IS NULL`,
    );
    rows += res.rowCount ?? 0;
  }

  const shared = rows - mapped;
  log(`  ${cat.textIdTables.length} table(s) given a bigint id · ${mapped} distinct id(s) → ${rows} row(s)`);
  if (shared > 0) {
    log(`  ${shared} row(s) share an id with a row in another table — alias preserved (G1)`);
  }

  // FK columns get their bigint twin, filled through the map rather than by
  // joining the parent — one code path for constrained and unconstrained
  // pointers alike, and it cannot pick the wrong parent because the map is
  // globally unique.
  const fkCols = fkColumns(cat);
  for (const c of fkCols) {
    await client.query(`ALTER TABLE ${q(c.table)} ADD COLUMN IF NOT EXISTS ${q(c.column + NEW)} bigint`);
    await client.query(
      `UPDATE ${q(c.table)} t SET ${q(c.column + NEW)} = m.new_id
         FROM ${q(MAP_TABLE)} m
        WHERE m.legacy_id = t.${q(c.column)} AND t.${q(c.column + NEW)} IS NULL`,
    );
  }
  log(`  ${fkCols.length} FK column(s) backfilled`);

  // An FK value that mapped to nothing is a pre-existing orphan. The constraint
  // says it cannot happen; say so loudly if it did, because re-adding the
  // constraint at the end would fail anyway and this names the row.
  for (const c of fkCols) {
    const { rows: bad } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(c.table)}
        WHERE ${q(c.column)} IS NOT NULL AND ${q(c.column + NEW)} IS NULL`,
    );
    if (Number(bad[0]!.n) > 0) {
      fail(`${c.table}.${c.column}: ${bad[0]!.n} row(s) point at an id that does not exist in ${c.parent}.`);
    }
  }
}

/* ────────────────────────────────────────────────────── rewrite: json ── */

async function rewriteJson(client: PgClient): Promise<void> {
  log(`\n── rewrite live-config JSON ──`);
  const map = await loadMap(client);
  const lookup = (legacy: string) => map.get(legacy);

  let touchedRows = 0;
  let replacedIds = 0;

  for (const rule of JSON_COLUMNS) {
    if (rule.verdict === "BLOCKED" && DROP_DRAFTS && rule.table.endsWith("_drafts")) {
      const res = await client.query(`DELETE FROM ${q(rule.table)}`);
      log(`  ${rule.table}: deleted ${res.rowCount} draft row(s) (--drop-drafts)`);
      continue;
    }
    if (rule.verdict !== "REWRITE" || rule.paths.length === 0) continue;

    const { rows } = await client.query<{ id: string; v: unknown }>(
      `SELECT id, ${q(rule.column)} AS v FROM ${q(rule.table)} WHERE ${q(rule.column)} IS NOT NULL`,
    );
    let rowsHere = 0;
    let idsHere = 0;
    const unresolved: string[] = [];

    for (const row of rows) {
      const out = rewrite(row.v, rule.paths, lookup);
      for (const u of out.unresolved) {
        // A lenient path is allowed to hold non-ids; a strict one is not.
        const lenient = rule.paths.some((p) => p.lenient);
        if (!lenient) unresolved.push(`${row.id} ${u.path}=${u.value}`);
      }
      if (out.replaced === 0) continue;
      await client.query(
        `UPDATE ${q(rule.table)} SET ${q(rule.column)} = $1 WHERE id = $2`,
        [JSON.stringify(out.value), row.id],
      );
      rowsHere++;
      idsHere += out.replaced;
    }

    if (unresolved.length) {
      fail(
        `${rule.table}.${rule.column}: ${unresolved.length} id(s) at a declared live-config path ` +
        `resolve to no row:\n      ${unresolved.slice(0, 5).join("\n      ")}` +
        `\n  A live-config pointer to a deleted row is a data problem to settle before migrating.`,
      );
    }
    if (rowsHere) log(`  ${rule.table}.${rule.column}: ${idsHere} id(s) in ${rowsHere} row(s)`);
    touchedRows += rowsHere;
    replacedIds += idsHere;
  }

  const preserved = JSON_COLUMNS.filter((r) => r.verdict === "PRESERVE").length;
  log(`  ${replacedIds} id(s) rewritten across ${touchedRows} row(s) · ${preserved} historical column(s) left untouched`);
}

/* ─────────────────────────────────────────────────── rewrite: pointers ── */

/**
 * The 60 unconstrained pointer columns. Same conversion as a declared FK — a
 * bigint twin filled through the map — but without a constraint to re-add,
 * since adding one now would change behaviour the app has never had (and
 * several of these legitimately dangle, e.g. complaints.order_id).
 */
async function rewritePointers(client: PgClient, cat: Catalog): Promise<void> {
  log(`\n── convert unconstrained pointers ──`);
  let converted = 0;
  let dangling = 0;

  for (const rule of POINTER_COLUMNS) {
    if (rule.verdict !== "REWRITE") continue;
    if (!cat.columns.get(rule.table)?.has(rule.column)) continue;

    await client.query(`ALTER TABLE ${q(rule.table)} ADD COLUMN IF NOT EXISTS ${q(rule.column + NEW)} bigint`);
    const res = await client.query(
      `UPDATE ${q(rule.table)} t SET ${q(rule.column + NEW)} = m.new_id
         FROM ${q(MAP_TABLE)} m
        WHERE m.legacy_id = t.${q(rule.column)} AND t.${q(rule.column + NEW)} IS NULL`,
    );
    converted += res.rowCount ?? 0;

    // Unlike a constrained edge, a dangling value here is expected in places —
    // report it, keep the legacy string in *_legacy_id, and move on.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(rule.table)}
        WHERE ${q(rule.column)} IS NOT NULL AND ${q(rule.column + NEW)} IS NULL`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) {
      dangling += n;
      log(`  ${rule.table}.${rule.column}: ${n} value(s) point at no row — left as a legacy id`);
    }
  }
  const preserved = POINTER_COLUMNS.filter((r) => r.verdict === "PRESERVE").length;
  log(`  ${converted} pointer value(s) converted · ${dangling} dangling · ${preserved} column(s) preserved (hash-chain inputs, tokens, logs)`);
}

/* ────────────────────────────────────────────── rewrite: derived keys ── */

/**
 * Idempotency keys that embed an id, rewritten segment by segment.
 *
 * Not a uuid regex: these keys are delimiter-joined (`AUTO:<cycleId>:2026-W28`,
 * `<scheduleId>:<iso>:<targetId>`, `/org-root/zone_west/<propertyId>/`), and
 * the id in any segment may be a readable seeded id rather than a uuid. So the
 * string is split on its delimiters and every segment that IS a known id is
 * replaced — which also leaves date segments, prefixes and slugs untouched by
 * construction rather than by hoping the pattern does not match them.
 */
const KEY_DELIMITERS = /([:/])/;

async function rewriteDerivedKeys(client: PgClient): Promise<void> {
  log(`\n── rewrite derived idempotency keys ──`);
  const map = await loadMap(client);
  let total = 0;

  for (const rule of DERIVED_KEYS) {
    if (rule.verdict !== "REWRITE") continue;
    const where = rule.whereSql ? `WHERE ${rule.whereSql}` : "";
    const { rows } = await client.query<{ id: string; v: string | null }>(
      `SELECT id, ${q(rule.column)} AS v FROM ${q(rule.table)} ${where}`,
    );
    let n = 0;
    for (const row of rows) {
      if (row.v === null) continue;
      let changed = false;
      const next = row.v
        .split(KEY_DELIMITERS)
        .map((seg) => {
          const mapped = map.get(seg);
          if (mapped === undefined) return seg; // a delimiter, a date, or a deleted row
          changed = true;
          return String(mapped);
        })
        .join("");
      if (!changed) continue;
      await client.query(`UPDATE ${q(rule.table)} SET ${q(rule.column)} = $1 WHERE id = $2`, [next, row.id]);
      n++;
    }
    if (n) log(`  ${rule.table}.${rule.column}: ${n} key(s) rewritten`);
    total += n;
  }
  const preserved = DERIVED_KEYS.filter((r) => r.verdict === "PRESERVE").length;
  log(`  ${total} key(s) rewritten · ${preserved} column(s) preserved (deep links, provider ids, free text)`);
}

/* ──────────────────────────────────────────────────────────────── the swap ── */

async function swap(client: PgClient, cat: Catalog): Promise<void> {
  log(`\n── swap ──`);
  const converting = new Set<string>();
  for (const t of cat.textIdTables) converting.add(`${t}.id`);
  for (const c of fkColumns(cat)) converting.add(`${c.table}.${c.column}`);
  for (const r of POINTER_COLUMNS) {
    if (r.verdict === "REWRITE" && cat.columns.get(r.table)?.has(r.column)) {
      converting.add(`${r.table}.${r.column}`);
    }
  }

  // Drop every FK first: their types are about to stop matching.
  for (const fk of cat.fks) {
    await client.query(`ALTER TABLE ${q(fk.childTable)} DROP CONSTRAINT ${q(fk.name)}`);
  }
  log(`  dropped ${cat.fks.length} FK constraint(s)`);

  // Drop the PK/UNIQUE constraints that span a converting column, so the rename
  // does not drag them onto the legacy columns.
  const spanningKeys = cat.keys.filter((k) => k.columns.some((c) => converting.has(`${k.table}.${c}`)));
  for (const k of spanningKeys) {
    await client.query(`ALTER TABLE ${q(k.table)} DROP CONSTRAINT ${q(k.name)}`);
  }
  log(`  dropped ${spanningKeys.length} key constraint(s) spanning a converted column`);

  // Rename. Names are preserved, which is what makes the captured definitions
  // re-issuable verbatim below.
  for (const name of converting) {
    const [table, column] = name.split(".") as [string, string];
    const legacy = legacyName(column);
    // A rename onto an existing column is how a naming bug shows up: Postgres
    // accepts `RENAME x TO x` silently and only fails one statement later, on
    // the twin, with a message that names the wrong problem.
    if (legacy === column || cat.columns.get(table)?.has(legacy)) {
      fail(`${table}: cannot move ${column} to ${legacy} — that column already exists.`);
    }
    await client.query(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(column)} TO ${q(legacy)}`);
    await client.query(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(column + NEW)} TO ${q(column)}`);
  }
  log(`  renamed ${converting.size} column(s) to their bigint twin`);

  // Record what was dropped BEFORE re-adding it, so id:verify can assert that
  // every constraint came back. Without this baseline the orphan check is blind
  // to the one failure it exists for: a constraint that is never re-added
  // leaves no orphan to find, because there is no longer an edge to check.
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${q(CONSTRAINT_TABLE)} (
       name text PRIMARY KEY,
       table_name text NOT NULL,
       kind text NOT NULL,
       definition text NOT NULL
     )`,
  );
  for (const k of spanningKeys) {
    await client.query(
      `INSERT INTO ${q(CONSTRAINT_TABLE)} (name, table_name, kind, definition)
       VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
      [k.name, k.table, k.type === "p" ? "PRIMARY KEY" : "UNIQUE", k.definition],
    );
  }
  for (const fk of cat.fks) {
    await client.query(
      `INSERT INTO ${q(CONSTRAINT_TABLE)} (name, table_name, kind, definition)
       VALUES ($1, $2, 'FOREIGN KEY', $3) ON CONFLICT (name) DO NOTHING`,
      [fk.name, fk.childTable, fk.definition],
    );
  }

  // Re-issue the keys, then the FKs, from the definitions captured pre-swap.
  for (const k of spanningKeys) {
    await client.query(`ALTER TABLE ${q(k.table)} ADD CONSTRAINT ${q(k.name)} ${k.definition}`);
  }
  for (const fk of cat.fks) {
    await client.query(`ALTER TABLE ${q(fk.childTable)} ADD CONSTRAINT ${q(fk.name)} ${fk.definition}`);
  }
  log(`  re-created ${spanningKeys.length} key constraint(s) and ${cat.fks.length} FK constraint(s) on the bigint columns`);

  for (const table of cat.textIdTables) {
    await client.query(`ALTER TABLE ${q(table)} ALTER COLUMN id SET DEFAULT nextval('${SEQ}')`);
    await client.query(`ALTER TABLE ${q(table)} ALTER COLUMN id SET NOT NULL`);
    // §4's whole premise: historical JSON keeps legacy ids and the log UI
    // resolves through this column, so it is indexed, not merely retained.
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${q(`${table}_legacy_id_idx`)} ON ${q(table)} (legacy_id)`,
    );
  }
  log(`  set the sequence default and indexed legacy_id on ${cat.textIdTables.length} table(s)`);

  const { rows } = await client.query<{ max: string | null }>(`SELECT max(new_id)::text AS max FROM ${q(MAP_TABLE)}`);
  if (rows[0]?.max) await client.query(`SELECT setval('${SEQ}', $1::bigint)`, [rows[0].max]);
}

/**
 * Where a converted column's original text value goes.
 *
 *   id            → legacy_id          (the plan's name; idFilter() reads it)
 *   parent_id     → parent_legacy_id   (the plan's name for an edge)
 *   updated_by    → updated_by_legacy  (an edge that is not spelled *_id)
 *
 * The third case is not hypothetical: `access_matrix_version.updated_by` and
 * `audits.start_evidence_id`'s neighbours are ordinary FK columns whose names
 * do not end in _id, and a rule that only rewrote the _id suffix renamed them
 * to themselves — a silent no-op that then collided with the bigint twin.
 */
function legacyName(column: string): string {
  if (column === "id") return "legacy_id";
  if (column.endsWith("_id")) return `${column.slice(0, -3)}_legacy_id`;
  return `${column}_legacy`;
}

async function loadMap(client: PgClient): Promise<Map<string, number>> {
  const { rows } = await client.query<{ legacy_id: string; new_id: string }>(
    `SELECT legacy_id, new_id::text FROM ${q(MAP_TABLE)}`,
  );
  return new Map(rows.map((r: { legacy_id: string; new_id: string }) => [r.legacy_id, Number(r.new_id)] as const));
}

main().catch(async (err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
