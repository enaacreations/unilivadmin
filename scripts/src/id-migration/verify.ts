/**
 * Post-migration assertion pass. Exits non-zero on the first category that fails.
 *
 *   pnpm -C scripts run id:verify
 *
 * Read-only — it opens a read-only session and issues nothing but SELECTs, so
 * it is safe to point at any database including production.
 *
 * Seven checks, in the order a failure would matter:
 *
 *   1. shape        every table that had a text id now has a bigint id and a
 *                   legacy_id, and no legacy_id is null.
 *   2. orphans      every FK edge resolves. The constraints enforce this, so a
 *                   failure means a constraint was not re-added — which is
 *                   exactly the silent hole the check exists to find.
 *   3. pointers     every unconstrained pointer classified REWRITE resolves, or
 *                   is accounted for as a pre-existing dangle.
 *   4. live json    no uuid-shaped string survives at any live-config path.
 *   5. derived keys no uuid survives inside a REWRITE-classified idempotency key.
 *   6. preserved    the mirror of 4 and 5: every PRESERVE column STILL holds its
 *                   legacy uuids. A historical record that was quietly rewritten
 *                   is a worse outcome than one that was missed, and nothing
 *                   else in the pipeline would notice.
 *   7. chain        audit_events still hash-verifies end to end.
 *
 * Check 6 is the one a migration verifier usually lacks. §4's whole argument is
 * that rewriting a historical record is falsification; a verifier that only
 * looks for leftovers would pass a run that falsified all of them.
 */
import { createHash } from "crypto";
import { pool } from "@workspace/db";
import {
  DERIVED_KEYS, JSON_COLUMNS, POINTER_COLUMNS, PRESERVED_JSON_PATHS, EMBEDDED_UUID_RE,
} from "./manifest.js";
import { collectUuids } from "./json-paths.js";
import { readCatalog, q } from "./catalog.js";

interface Failure { check: string; detail: string }

const failures: Failure[] = [];
const log = (s = "") => console.log(s);
const bad = (check: string, detail: string) => failures.push({ check, detail });

async function main(): Promise<void> {
  await pool.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const { rows: [dbRow] } = await pool.query<{ db: string }>(`SELECT current_database() AS db`);
  log(`\nid:verify · database ${dbRow!.db}\n`);

  const cat = await readCatalog(pool);

  await checkShape(cat);
  await checkOrphans(cat);
  await checkPointers(cat);
  await checkLiveJson(cat);
  await checkDerivedKeys(cat);
  await checkPreserved(cat);
  await checkAuditChain(cat);

  if (failures.length) {
    log(`\n❌ ${failures.length} failure(s):\n`);
    for (const f of failures) log(`   [${f.check}] ${f.detail}`);
    log(`\nThe migration is NOT safe to release. Restore the pre-migration snapshot.`);
    process.exitCode = 1;
    return;
  }
  log(`\n✅ all checks passed`);
}

/* ─────────────────────────────────────────────────────────────── 1. shape ── */

/** The migration's own bookkeeping table; it has a legacy_id column but is not a migrated table. */
const BOOKKEEPING = new Set(["id_migration_map", "id_migration_constraints"]);

async function checkShape(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  const migrated = cat.tables
    .filter((t) => cat.columns.get(t)?.has("legacy_id"))
    .filter((t) => !BOOKKEEPING.has(t));
  if (migrated.length === 0) {
    bad("shape", `no table has a legacy_id column — the migration has not run on this database`);
    log(`  1. shape         ✗ nothing migrated`);
    return;
  }

  let nullLegacy = 0;
  let wrongType = 0;
  for (const table of migrated) {
    const idType = cat.columns.get(table)?.get("id");
    if (idType !== "bigint") {
      bad("shape", `${table}.id is ${idType ?? "missing"}, expected bigint`);
      wrongType++;
      continue;
    }
    // legacy_id NOT NULL is the plan's own requirement: idFilter()'s fallback
    // and the audit-log UI both resolve through it, and a null row is one that
    // can never be found by its old id again.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(table)} WHERE legacy_id IS NULL`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) {
      bad("shape", `${table}: ${n} row(s) have a NULL legacy_id`);
      nullLegacy += n;
    }
  }
  if (cat.textIdTables.length > 0) {
    bad("shape", `${cat.textIdTables.length} table(s) still have a text id PK: ${cat.textIdTables.slice(0, 5).join(", ")}`);
  }
  log(`  1. shape         ${nullLegacy || wrongType || cat.textIdTables.length ? "✗" : "✓"} ` +
      `${migrated.length} migrated table(s), ${nullLegacy} null legacy_id, ${wrongType} wrong id type`);
}

/* ───────────────────────────────────────────────────────────── 2. orphans ── */

async function checkOrphans(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  // First: did every constraint the swap dropped actually come back? Checking
  // orphans alone cannot answer this — a constraint that was never re-added
  // removes the edge from the catalogue, so the loop below simply does not look
  // at it and reports zero orphans on a database that has lost its integrity.
  const present = new Set([
    ...cat.fks.map((f) => f.name),
    ...cat.keys.map((k) => k.name),
  ]);
  const { rows: baseline } = await pool.query<{ name: string; table_name: string; kind: string }>(
    `SELECT name, table_name, kind FROM id_migration_constraints`,
  ).catch(() => ({ rows: [] as { name: string; table_name: string; kind: string }[] }));
  if (baseline.length === 0) {
    bad("orphans", `no constraint baseline — id_migration_constraints is missing or empty, so "every constraint came back" cannot be proven`);
  }
  let missing = 0;
  for (const b of baseline) {
    if (!present.has(b.name)) {
      missing++;
      bad("orphans", `${b.kind} ${b.name} on ${b.table_name} was dropped for the swap and never re-added`);
    }
  }

  let checked = 0;
  let orphans = 0;
  for (const fk of cat.fks) {
    if (fk.childColumns.length !== 1 || fk.parentColumns.length !== 1) continue;
    const [cc] = fk.childColumns as [string];
    const [pc] = fk.parentColumns as [string];
    checked++;
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(fk.childTable)} c
        WHERE c.${q(cc)} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${q(fk.parentTable)} p WHERE p.${q(pc)} = c.${q(cc)})`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) {
      bad("orphans", `${fk.childTable}.${cc} → ${fk.parentTable}.${pc}: ${n} orphan(s)`);
      orphans += n;
    }
  }
  log(`  2. orphans       ${orphans || missing || !baseline.length ? "✗" : "✓"} ` +
      `${checked} FK edge(s), ${orphans} orphan(s) · ${baseline.length} baselined constraint(s), ${missing} missing`);
}

/* ──────────────────────────────────────────────────────────── 3. pointers ── */

async function checkPointers(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  let checked = 0;
  let unconverted = 0;
  for (const rule of POINTER_COLUMNS) {
    if (rule.verdict !== "REWRITE" || !rule.target) continue;
    const cols = cat.columns.get(rule.table);
    if (!cols?.has(rule.column)) continue;
    checked++;

    const type = cols.get(rule.column);
    if (type !== "bigint") {
      bad("pointers", `${rule.table}.${rule.column} is still ${type} — it was never converted`);
      unconverted++;
      continue;
    }
    // The values that survived as legacy ids are the pre-existing dangles the
    // migration reported; what must not exist is a converted column whose value
    // points at no row.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${q(rule.table)} c
        WHERE c.${q(rule.column)} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${q(rule.target)} p WHERE p.id = c.${q(rule.column)})`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) bad("pointers", `${rule.table}.${rule.column} → ${rule.target}: ${n} value(s) resolve to no row`);
  }
  log(`  3. pointers      ${unconverted || failures.some((f) => f.check === "pointers") ? "✗" : "✓"} ` +
      `${checked} unconstrained pointer column(s)`);
}

/* ─────────────────────────────────────────────────────────── 4. live json ── */

async function checkLiveJson(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  let checked = 0;
  let leftovers = 0;
  for (const rule of JSON_COLUMNS) {
    if (rule.verdict !== "REWRITE") continue;
    if (!cat.columns.get(rule.table)?.has(rule.column)) continue;
    checked++;

    const { rows } = await pool.query<{ id: string; v: unknown }>(
      `SELECT id::text AS id, ${q(rule.column)} AS v FROM ${q(rule.table)} WHERE ${q(rule.column)} IS NOT NULL`,
    );
    for (const row of rows) {
      for (const found of collectUuids(row.v)) {
        if (PRESERVED_JSON_PATHS.has(`${rule.table}.${rule.column}:${found.path}`)) continue;
        // A lenient path may legitimately hold a non-id string, but never a
        // uuid: every uuid in this database is an entity id.
        bad("live-json",
          `${rule.table}.${rule.column} row ${row.id}: uuid still at ${found.path}` +
          `${found.isKey ? " (object KEY)" : ""} = ${found.value}`);
        leftovers++;
      }
    }
  }
  log(`  4. live json     ${leftovers ? "✗" : "✓"} ${checked} live-config column(s), ${leftovers} surviving uuid(s)`);
}

/* ────────────────────────────────────────────────────── 5. derived keys ── */

async function checkDerivedKeys(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  let checked = 0;
  let leftovers = 0;
  for (const rule of DERIVED_KEYS) {
    if (rule.verdict !== "REWRITE") continue;
    if (!cat.columns.get(rule.table)?.has(rule.column)) continue;
    checked++;
    const where = [`${q(rule.column)} ~ $1`, rule.whereSql].filter(Boolean).join(" AND ");
    const { rows } = await pool.query<{ n: string; sample: string | null }>(
      `SELECT count(*)::text AS n, min(${q(rule.column)}) AS sample FROM ${q(rule.table)} WHERE ${where}`,
      [EMBEDDED_UUID_RE.source],
    );
    const n = Number(rows[0]!.n);
    if (n > 0) {
      bad("derived-keys",
        `${rule.table}.${rule.column}: ${n} idempotency key(s) still embed a uuid, e.g. "${rows[0]!.sample}". ` +
        `The guarded operation will run a second time.`);
      leftovers += n;
    }
  }
  log(`  5. derived keys  ${leftovers ? "✗" : "✓"} ${checked} key column(s), ${leftovers} stale key(s)`);
}

/* ─────────────────────────────────────────────────────────── 6. preserved ── */

/**
 * The falsification check. Every PRESERVE column that held uuids before the
 * migration must still hold them — we know it did, because the manifest records
 * the observed counts from dev.
 */
async function checkPreserved(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  const targets: { table: string; column: string; json: boolean; why: string }[] = [
    // Only columns the audit actually SAW ids in. audit_responses.answer_json is
    // PRESERVE and heavily populated but holds no ids at all (its optionId is a
    // slug), so asserting on it would fail every clean run.
    ...JSON_COLUMNS.filter((r) => r.verdict === "PRESERVE" && (r.observedIds ?? 0) > 0)
      .map((r) => ({ table: r.table, column: r.column, json: true, why: "historical JSON" })),
    ...POINTER_COLUMNS.filter((r) => r.verdict === "PRESERVE")
      .map((r) => ({ table: r.table, column: r.column, json: false, why: "preserved pointer" })),
    ...DERIVED_KEYS.filter((r) => r.verdict === "PRESERVE")
      .map((r) => ({ table: r.table, column: r.column, json: false, why: "preserved key" })),
  ];

  let checked = 0;
  let emptied = 0;
  for (const t of targets) {
    if (!cat.columns.get(t.table)?.has(t.column)) continue;
    checked++;
    const expr = t.json ? `${q(t.column)}::text` : q(t.column);
    const { rows } = await pool.query<{ n: string; total: string }>(
      `SELECT count(*) FILTER (WHERE ${expr} ~ $1)::text AS n,
              count(${q(t.column)})::text AS total
         FROM ${q(t.table)}`,
      [EMBEDDED_UUID_RE.source],
    );
    const n = Number(rows[0]!.n);
    const total = Number(rows[0]!.total);
    if (total > 0 && n === 0) {
      bad("preserved",
        `${t.table}.${t.column} (${t.why}) has ${total} populated row(s) and NOT ONE legacy uuid left. ` +
        `A historical record appears to have been rewritten — that is falsification, not migration.`);
      emptied++;
    }
  }
  log(`  6. preserved     ${emptied ? "✗" : "✓"} ${checked} historical column(s) still hold their legacy ids`);
}

/* ─────────────────────────────────────────────────────────────── 7. chain ── */

/**
 * Recompute the audit_events hash chain.
 *
 * This mirrors appendAuditEvent/verifyChain in
 * apps/api-server/src/lib/audit-events.ts — which is the source of truth and
 * the thing that must actually pass in production. It is duplicated here rather
 * than imported because `scripts` depends only on @workspace/db, and because a
 * migration verifier that cannot answer "did I break the trail?" without
 * booting the API is not much of a gate. Keep the two in step: the payload
 * field list below is the contract.
 *
 * Note which columns are hashed — entityId, auditId and actorId as well as the
 * two json columns. That is why all five are PRESERVE in the manifest, and why
 * this check would catch a rewrite of any of them.
 */
async function checkAuditChain(cat: Awaited<ReturnType<typeof readCatalog>>): Promise<void> {
  if (!cat.tables.includes("audit_events")) {
    log(`  7. chain         – audit_events not present`);
    return;
  }
  // created_at is read as TEXT and re-instantiated as UTC, mirroring what
  // Drizzle's node-postgres driver does (`value + "+0000"`). Letting pg parse a
  // `timestamp` itself applies the PROCESS timezone — Asia/Kolkata on these
  // boxes — which shifts every createdAt by 5h30m and mismatches all 292
  // hashes while the prevHash linkage still lines up perfectly. That reads
  // exactly like a migration that rewrote a hashed column, and it is not one.
  // See the UTC wall-clock invariant documented in lib/db/src/index.ts.
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT seq, entity_type, entity_id, audit_id, actor_id, actor_role, kind,
            from_state, to_state, reason, before_json, after_json,
            prev_hash, hash, created_at::text AS created_at_text
       FROM audit_events ORDER BY seq ASC`,
  );

  let prevHash = "GENESIS";
  let broken: number | null = null;
  for (const r of rows) {
    const payload = {
      entityType: r["entity_type"],
      entityId: r["entity_id"],
      auditId: r["audit_id"] ?? null,
      actorId: r["actor_id"] ?? null,
      actorRole: r["actor_role"] ?? null,
      kind: r["kind"],
      fromState: r["from_state"] ?? null,
      toState: r["to_state"] ?? null,
      reason: r["reason"] ?? null,
      beforeJson: r["before_json"] ?? null,
      afterJson: r["after_json"] ?? null,
      createdAt: new Date(`${r["created_at_text"] as string}+0000`).toISOString(),
    };
    const expected = createHash("sha256").update(prevHash).update(canonicalJson(payload)).digest("hex");
    if (r["prev_hash"] !== prevHash || r["hash"] !== expected) {
      broken = Number(r["seq"]);
      break;
    }
    prevHash = r["hash"] as string;
  }

  if (broken !== null) {
    bad("chain", `audit_events chain breaks at seq ${broken} — a hashed column was modified`);
  }
  log(`  7. chain         ${broken !== null ? "✗" : "✓"} ${rows.length} event(s) verified`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(JSON.parse(JSON.stringify(value ?? null))));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortValue((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value ?? null;
}

main()
  .catch((err) => {
    console.error(`\n❌ verification could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
