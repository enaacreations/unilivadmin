/**
 * What the database actually looks like, read from pg_catalog.
 *
 * Deliberately NOT read from the Drizzle barrel, unlike verify-schema.ts. That
 * script's job is to compare code against the database; this one's job is to
 * ALTER the database, so the database is the only honest source. The two
 * diverge in practice — `form_drafts` and `access_grants` are declared in
 * lib/db/src/schema today and do not exist in dev — and a migration that
 * ALTERs a table it read from the barrel would abort halfway through on a table
 * that was never there.
 */
import { pool } from "@workspace/db";

/**
 * The slice of node-postgres these scripts use, declared structurally.
 *
 * `scripts` depends on @workspace/db, not on `pg`, and a one-off migration is
 * not a reason to add a shared dependency (which CLAUDE.md would then want
 * pinned in the workspace catalog). Both `pool` and a checked-out client
 * satisfy this, so the catalogue reader works against either.
 */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PgClient extends Queryable {
  release(): void;
}

export interface FkEdge {
  name: string;
  childTable: string;
  childColumns: string[];
  parentTable: string;
  parentColumns: string[];
  /** `FOREIGN KEY (…) REFERENCES … ON DELETE …` — re-issued verbatim after the swap. */
  definition: string;
}

export interface ConstraintDef {
  name: string;
  table: string;
  type: "p" | "u";
  columns: string[];
  definition: string;
}

export interface Catalog {
  /** Base tables in the public schema. */
  tables: string[];
  /** Tables whose primary key is exactly the single text column `id`. */
  textIdTables: string[];
  fks: FkEdge[];
  /** PK and UNIQUE constraints, needed when they span a converted column. */
  keys: ConstraintDef[];
  /** table → column → postgres type name. */
  columns: Map<string, Map<string, string>>;
}

export async function readCatalog(db: Queryable): Promise<Catalog> {
  const { rows: tableRows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const tables = tableRows.map((r: { table_name: string }) => r.table_name);

  const { rows: colRows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const columns = new Map<string, Map<string, string>>();
  for (const r of colRows) {
    let m = columns.get(r.table_name);
    if (!m) columns.set(r.table_name, (m = new Map()));
    m.set(r.column_name, r.data_type);
  }

  const { rows: keyRows } = await db.query<{
    name: string; table_name: string; contype: "p" | "u"; cols: string[]; def: string;
  }>(
    `SELECT c.conname AS name,
            c.conrelid::regclass::text AS table_name,
            c.contype,
            array_agg(a.attname::text ORDER BY k.ord) AS cols,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype IN ('p', 'u') AND c.connamespace = 'public'::regnamespace
      GROUP BY c.oid, c.conname, c.conrelid, c.contype
      ORDER BY 2, 1`,
  );
  const keys: ConstraintDef[] = keyRows.map((r: typeof keyRows[number]) => ({
    name: r.name, table: r.table_name, type: r.contype, columns: r.cols, definition: r.def,
  }));

  const { rows: fkRows } = await db.query<{
    name: string; child: string; child_cols: string[]; parent: string; parent_cols: string[]; def: string;
  }>(
    `SELECT c.conname AS name,
            c.conrelid::regclass::text AS child,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
            c.confrelid::regclass::text AS parent,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      ORDER BY 2, 1`,
  );
  const fks: FkEdge[] = fkRows.map((r: typeof fkRows[number]) => ({
    name: r.name, childTable: r.child, childColumns: r.child_cols,
    parentTable: r.parent, parentColumns: r.parent_cols, definition: r.def,
  }));

  const textIdTables = keys
    .filter((k) => k.type === "p" && k.columns.length === 1 && k.columns[0] === "id")
    .filter((k) => columns.get(k.table)?.get("id") === "text")
    .map((k) => k.table)
    .sort();

  return { tables, textIdTables, fks, keys, columns };
}

/**
 * Every text column that is one end of a declared FK. These are the edges the
 * plan counts; the manifest's POINTER_COLUMNS are the ones it does not.
 */
export function fkColumns(cat: Catalog): { table: string; column: string; parent: string }[] {
  const out: { table: string; column: string; parent: string }[] = [];
  for (const fk of cat.fks) {
    // Composite FKs would need positional pairing; none exist here, and a new
    // one is caught by the assertion below rather than silently half-migrated.
    if (fk.childColumns.length !== 1 || fk.parentColumns.length !== 1) continue;
    const type = cat.columns.get(fk.childTable)?.get(fk.childColumns[0]!);
    if (type !== "text") continue;
    out.push({ table: fk.childTable, column: fk.childColumns[0]!, parent: fk.parentTable });
  }
  return out;
}

export function compositeFks(cat: Catalog): FkEdge[] {
  return cat.fks.filter((f) => f.childColumns.length > 1);
}

/** `"public"."table"` — every identifier this migration emits is quoted. */
export const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
