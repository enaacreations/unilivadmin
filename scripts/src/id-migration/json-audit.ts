/**
 * Survey where entity ids actually live in this database. Read-only.
 *
 *   pnpm -C scripts run id:json-audit            # the three surfaces, summarised
 *   pnpm -C scripts run id:json-audit -- --json  # machine-readable
 *
 * This is the tool that produced ID_MIGRATION_PLAN.md §4. It exists as a
 * registered command rather than a throwaway because §4's classification is
 * only as good as its last run against real data, and the two questions it
 * answers — "which paths hold ids" and "which table do they point at" — are the
 * ones a reviewer will want to re-ask on the restored snapshot before the real
 * cutover, not take on trust from a document.
 *
 * Every uuid it finds is resolved against every text-id table, which is possible
 * precisely because ids are globally unique today. That is what separates a
 * real entity pointer (`residents.room_id` → rooms) from a coincidence
 * (`otp_challenges.verification_token`, a randomUUID secret that resolves to
 * nothing and must never be rewritten).
 *
 * Values are masked in the output: uuids print as their first 8 characters and
 * anything with an @ has its local part cut, so a survey of production data is
 * safe to paste into a plan document.
 */
import { pool } from "@workspace/db";
import { UUID_RE, EMBEDDED_UUID_RE, jsonRule, pointerRule, derivedKeyRule } from "./manifest.js";
import { q } from "./catalog.js";

const AS_JSON = process.argv.includes("--json");
const SAMPLE = Number(process.env["ID_AUDIT_SAMPLE"] ?? 500);

interface PathStat {
  path: string; seen: number; uuids: number;
  types: string[]; examples: string[]; resolvesTo: Record<string, number>;
}
interface ColumnReport {
  table: string; column: string; kind: "json" | "pointer" | "derived";
  rows: number; populated: number; sampled: number;
  classified: string; paths: PathStat[];
}

type Leaf = { path: string; value: unknown; isKey: boolean };

function walk(v: unknown, path: string, out: Leaf[]): void {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) { for (const el of v) walk(el, `${path}[*]`, out); return; }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (UUID_RE.test(k)) out.push({ path: `${path}.{key}`, value: k, isKey: true });
      walk(val, `${path}.${UUID_RE.test(k) ? "{*}" : k}`, out);
    }
    return;
  }
  out.push({ path, value: v, isKey: false });
}

function mask(v: unknown): string {
  const s = String(v);
  if (UUID_RE.test(s)) return `${s.slice(0, 8)}…`;
  if (s.includes("@")) return s.replace(/^[^@]+/, (m) => `${m.slice(0, 2)}***`);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

async function main(): Promise<void> {
  await pool.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");

  const { rows: idTables } = await pool.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'id' AND c.data_type = 'text'
      ORDER BY 1`,
  );
  const idTableNames = idTables.map((r: { table_name: string }) => r.table_name);

  const resolveCache = new Map<string, string>();
  async function resolve(uuids: string[]): Promise<Record<string, number>> {
    const todo = uuids.filter((u) => !resolveCache.has(u));
    if (todo.length && idTableNames.length) {
      const union = idTableNames
        // Table names come from the catalogue, never from user input.
        .map((t) => `SELECT '${t.replace(/'/g, "''")}'::text AS t, id FROM ${q(t)} WHERE id = ANY($1::text[])`)
        .join(" UNION ALL ");
      const { rows } = await pool.query<{ t: string; id: string }>(union, [todo]);
      for (const r of rows) resolveCache.set(r.id, r.t);
      for (const u of todo) if (!resolveCache.has(u)) resolveCache.set(u, "UNRESOLVED");
    }
    const out: Record<string, number> = {};
    for (const u of uuids) { const t = resolveCache.get(u) ?? "UNRESOLVED"; out[t] = (out[t] ?? 0) + 1; }
    return out;
  }

  const reports: ColumnReport[] = [];

  /* ---- surface 1: json ---- */
  const { rows: jsonCols } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.data_type IN ('json', 'jsonb') ORDER BY 1, 2`,
  );
  for (const c of jsonCols) {
    const { rows: cnt } = await pool.query<{ total: string; populated: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE ${q(c.column_name)} IS NOT NULL
                                 AND ${q(c.column_name)}::text NOT IN ('null','{}','[]','""'))::text AS populated
         FROM ${q(c.table_name)}`,
    );
    const populated = Number(cnt[0]!.populated);
    const stats = new Map<string, { seen: number; uuids: number; types: Set<string>; examples: string[]; samples: Set<string> }>();
    let sampled = 0;
    if (populated > 0) {
      const { rows } = await pool.query<{ v: unknown }>(
        `SELECT ${q(c.column_name)} AS v FROM ${q(c.table_name)}
          WHERE ${q(c.column_name)} IS NOT NULL AND ${q(c.column_name)}::text NOT IN ('null','{}','[]','""')
          LIMIT ${SAMPLE}`,
      );
      sampled = rows.length;
      for (const r of rows) {
        const leaves: Leaf[] = [];
        walk(r.v, "$", leaves);
        for (const l of leaves) {
          let s = stats.get(l.path);
          if (!s) stats.set(l.path, (s = { seen: 0, uuids: 0, types: new Set(), examples: [], samples: new Set() }));
          s.seen++;
          s.types.add(l.value === null ? "null" : typeof l.value);
          if (typeof l.value === "string" && UUID_RE.test(l.value)) {
            s.uuids++;
            if (s.samples.size < 12) s.samples.add(l.value);
          }
          if (s.examples.length < 3) { const m = mask(l.value); if (!s.examples.includes(m)) s.examples.push(m); }
        }
      }
    }
    const paths: PathStat[] = [];
    for (const [path, s] of [...stats].sort((a, b) => b[1].uuids - a[1].uuids || a[0].localeCompare(b[0]))) {
      paths.push({
        path, seen: s.seen, uuids: s.uuids, types: [...s.types], examples: s.examples,
        resolvesTo: s.uuids ? await resolve([...s.samples]) : {},
      });
    }
    const rule = jsonRule(c.table_name, c.column_name);
    reports.push({
      table: c.table_name, column: c.column_name, kind: "json",
      rows: Number(cnt[0]!.total), populated, sampled,
      classified: rule ? `${rule.verdict} (${rule.evidence})` : "UNCLASSIFIED",
      paths,
    });
  }

  /* ---- surfaces 2 and 3: plain text columns ---- */
  const { rows: textCols } = await pool.query<{ table_name: string; column_name: string }>(
    `WITH fkcols AS (
       SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
         FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace)
     SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.data_type = 'text' AND c.column_name <> 'id'
        AND NOT EXISTS (SELECT 1 FROM fkcols f WHERE f.tbl = c.table_name AND f.col = c.column_name)
      ORDER BY 1, 2`,
  );
  for (const c of textCols) {
    const { rows } = await pool.query<{ whole: string; embedded: string; total: string }>(
      `SELECT count(*) FILTER (WHERE ${q(c.column_name)} ~* $1)::text AS whole,
              count(*) FILTER (WHERE ${q(c.column_name)} ~ $2 AND ${q(c.column_name)} !~* $1)::text AS embedded,
              count(${q(c.column_name)})::text AS total
         FROM ${q(c.table_name)}`,
      [UUID_RE.source, EMBEDDED_UUID_RE.source],
    );
    const whole = Number(rows[0]!.whole);
    const embedded = Number(rows[0]!.embedded);
    if (whole === 0 && embedded === 0) continue;

    const kind = whole > 0 ? "pointer" : "derived";
    const { rows: vals } = await pool.query<{ v: string }>(
      `SELECT DISTINCT ${q(c.column_name)} AS v FROM ${q(c.table_name)}
        WHERE ${q(c.column_name)} ~ $1 LIMIT 25`,
      [EMBEDDED_UUID_RE.source],
    );
    const found = vals.flatMap((r) => r.v.match(EMBEDDED_UUID_RE) ?? []);
    const rule = kind === "pointer"
      ? pointerRule(c.table_name, c.column_name)
      : derivedKeyRule(c.table_name, c.column_name);
    reports.push({
      table: c.table_name, column: c.column_name, kind,
      rows: Number(rows[0]!.total), populated: whole + embedded, sampled: vals.length,
      classified: rule ? `${rule.verdict} (${rule.evidence})` : "UNCLASSIFIED",
      paths: [{
        path: whole > 0 ? "(whole value)" : "(embedded in string)",
        seen: whole + embedded, uuids: whole + embedded,
        types: ["string"], examples: vals.slice(0, 3).map((r) => mask(r.v)),
        resolvesTo: await resolve(found),
      }],
    });
  }

  if (AS_JSON) { console.log(JSON.stringify(reports, null, 2)); await pool.end(); return; }

  const withIds = reports.filter((r) => r.paths.some((p) => p.uuids > 0));
  const unclassified = reports.filter((r) => r.classified === "UNCLASSIFIED");

  for (const kind of ["json", "pointer", "derived"] as const) {
    const group = withIds.filter((r) => r.kind === kind);
    if (!group.length) continue;
    console.log(`\n${"═".repeat(78)}\n  ${kind.toUpperCase()} columns holding entity ids (${group.length})\n${"═".repeat(78)}`);
    for (const r of group) {
      console.log(`\n${r.table}.${r.column}  ·  ${r.populated}/${r.rows} populated  ·  ${r.classified}`);
      for (const p of r.paths.filter((x) => x.uuids > 0)) {
        const targets = Object.entries(p.resolvesTo).map(([t, n]) => `${t}×${n}`).join(", ");
        console.log(`    ${p.path.padEnd(44)} ${String(p.uuids).padStart(5)} id(s) → ${targets || "?"}`);
      }
    }
  }

  const clean = reports.filter((r) => r.kind === "json" && !r.paths.some((p) => p.uuids > 0));
  console.log(`\n${"═".repeat(78)}\n  JSON columns with no ids (${clean.length})\n${"═".repeat(78)}`);
  for (const r of clean) {
    console.log(`  ${`${r.table}.${r.column}`.padEnd(48)} ${String(r.populated).padStart(5)} populated · ${r.classified}`);
  }

  if (unclassified.length) {
    console.log(`\n⚠  ${unclassified.length} column(s) are NOT in manifest.ts — id:migrate will refuse to run:`);
    for (const r of unclassified) console.log(`     ${r.table}.${r.column} (${r.kind})`);
    await pool.end();
    process.exit(1);
  }
  console.log(`\n✅ every surveyed column is classified in manifest.ts`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
