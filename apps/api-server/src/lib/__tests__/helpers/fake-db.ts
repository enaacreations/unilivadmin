/**
 * In-memory stand-in for the drizzle `db` handle.
 *
 * The food helpers under test (scope resolution, menu resolution, the cut-off)
 * are real query code, not pure functions — mocking each call site out would
 * leave the thing that actually breaks (which rows a condition selects)
 * untested. So instead of stubbing return values this evaluates the drizzle
 * condition tree against seeded rows: `eq` / `and` / `or` / `isNull` / `inArray`
 * / `lte` / `gte` and inner joins all behave, so a test seeds tables and the
 * production query decides the answer.
 *
 * Deliberately small. Anything the food paths don't use (aggregates other than
 * count, group by, writes) throws rather than returning a plausible wrong
 * answer — a silent lie here would be a test asserting fiction.
 */
import { getTableColumns, getTableName } from "drizzle-orm";

/* ── drizzle node shapes (duck-typed; the classes aren't all public) ──────── */

type AnyTable = Parameters<typeof getTableName>[0];
type Row = Record<string, unknown>;
/** A row per joined table, keyed by table name — what a condition reads from. */
type Bundle = Record<string, Row>;

const isSql = (x: any): boolean => !!x && typeof x === "object" && Array.isArray(x.queryChunks);
const isColumn = (x: any): boolean =>
  !!x && typeof x === "object" && typeof x.name === "string" && !!x.table && typeof x.getSQL === "function";
const isStringChunk = (x: any): boolean => !!x && typeof x === "object" && Array.isArray(x.value) && !("encoder" in x);
const isParam = (x: any): boolean => !!x && typeof x === "object" && "encoder" in x && "value" in x;
/**
 * A bare value sitting in the chunk list. `eq()` wraps its right-hand side in a
 * Param, but a hand-written `sql` fragment interpolates a primitive verbatim —
 * so an operand that is not a Param is not therefore absent, and treating it as
 * absent silently made every such comparison false.
 */
const isLiteral = (x: any): boolean =>
  x === null || x instanceof Date || ["string", "number", "boolean", "bigint"].includes(typeof x);

const chunkText = (chunks: any[]): string =>
  chunks.filter(isStringChunk).map((c) => c.value.join("")).join(" ").trim().toLowerCase();

/** The JS property name of a column (rows are drizzle-shaped, not db-shaped). */
function colKey(col: any): string {
  for (const [k, c] of Object.entries(getTableColumns(col.table) as Record<string, unknown>)) {
    if (c === col) return k;
  }
  return col.name;
}

function readCol(bundle: Bundle, col: any): unknown {
  return bundle[getTableName(col.table)]?.[colKey(col)];
}

/** Dates compare by instant; everything else by value. */
const norm = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

function operandValue(chunk: any, bundle: Bundle): unknown {
  if (isColumn(chunk)) return readCol(bundle, chunk);
  if (isParam(chunk)) return chunk.value;
  return chunk;
}

/**
 * Scalar functions a hand-written `sql` fragment may wrap a column in. Only the
 * ones the code under test actually uses — an unknown name throws rather than
 * being ignored, because silently comparing the RAW column is exactly the
 * false pass this exists to prevent (a case-insensitive duplicate check would
 * "work" in the test and let duplicates through in production).
 */
const SQL_FNS: Record<string, (v: unknown) => unknown> = {
  lower: (v) => (typeof v === "string" ? v.toLowerCase() : v),
  upper: (v) => (typeof v === "string" ? v.toUpperCase() : v),
  trim: (v) => (typeof v === "string" ? v.trim() : v),
};

/**
 * Apply the calls that immediately ENCLOSE a column, given the fragment text
 * that precedes it — `lower(trim(` applies trim then lower, the order Postgres
 * evaluates them in.
 *
 * Walks backwards from the end rather than scanning the whole prefix, because
 * text further left is context, not a wrapper: the `count(*) FILTER (WHERE `
 * that evalAtomic is also handed would otherwise read as a call on the column.
 */
function applyWrappers(prefix: string, v: unknown): unknown {
  const names: string[] = [];
  let head = prefix.trimEnd();
  for (let m = head.match(/([a-z_]+)\s*\(\s*$/); m; m = head.match(/([a-z_]+)\s*\(\s*$/)) {
    names.push(m[1]!);
    head = head.slice(0, m.index).trimEnd();
  }
  let out = v;
  for (const n of names) {
    const fn = SQL_FNS[n];
    if (!fn) throw new Error(`fake-db: unsupported sql function "${n}()"`);
    out = fn(out);
  }
  return out;
}

function evalAtomic(chunks: any[], bundle: Bundle): boolean {
  const i = chunks.findIndex(isColumn);
  // A hand-written fragment may WRAP the column — `lower(trim(col)) = $1`. The
  // opening calls sit in the string chunk before the column and their closing
  // parens in the one after it, so both have to be read: ignoring them compared
  // the raw column value AND mis-read ")) =" as the operator.
  const before = chunks[i - 1];
  const prefix = isStringChunk(before) ? before.value.join("").toLowerCase() : "";
  const left = norm(applyWrappers(prefix, readCol(bundle, chunks[i])));
  const rest = chunks.slice(i + 1);
  const op = (rest.find(isStringChunk)?.value.join("") ?? "").replace(/^[)\s]+/, "").trim().toLowerCase();
  const operand = rest.find((c: any) => isParam(c) || isColumn(c) || Array.isArray(c) || isLiteral(c));
  switch (op) {
    case "is null":
      return left === null || left === undefined;
    case "is not null":
      return left !== null && left !== undefined;
    case "in":
      return (operand as any[]).map((p) => norm(operandValue(p, bundle))).includes(left);
    case "not in":
      return !(operand as any[]).map((p) => norm(operandValue(p, bundle))).includes(left);
    case "=":
      return left === norm(operandValue(operand, bundle));
    case "<>":
    case "!=":
      return left !== norm(operandValue(operand, bundle));
    case "<=":
      return (left as any) <= (norm(operandValue(operand, bundle)) as any);
    case ">=":
      return (left as any) >= (norm(operandValue(operand, bundle)) as any);
    case "<":
      return (left as any) < (norm(operandValue(operand, bundle)) as any);
    case ">":
      return (left as any) > (norm(operandValue(operand, bundle)) as any);
    default:
      throw new Error(`fake-db: unsupported operator "${op}"`);
  }
}

/** Evaluate a drizzle condition tree against one row bundle. */
function evalCond(node: any, bundle: Bundle): boolean {
  if (node == null) return true;
  const chunks: any[] = node.queryChunks ?? [];
  if (chunks.some(isColumn)) return evalAtomic(chunks, bundle);
  const subs = chunks.filter(isSql);
  if (subs.length === 0) {
    const text = chunkText(chunks);
    if (text === "false") return false;
    if (text === "true") return true;
    throw new Error(`fake-db: unsupported condition "${text}"`);
  }
  if (subs.length === 1) return evalCond(subs[0], bundle);
  // and(...) / or(...) render their operands into one flat chunk list separated
  // by the keyword; a mixed tree nests, so each branch is resolved recursively.
  const joiner = chunks.filter(isStringChunk).map((c: any) => c.value.join("").trim().toLowerCase());
  return joiner.includes("or")
    ? subs.some((s) => evalCond(s, bundle))
    : subs.every((s) => evalCond(s, bundle));
}

/* ── seeded storage ──────────────────────────────────────────────────────── */

const tables = new Map<string, Row[]>();
let txHandler: ((fn: (tx: unknown) => unknown) => unknown) | null = null;

/** Seed the fake database. Rows are drizzle-shaped (JS keys, real Dates). */
export function seedDb(fixtures: Array<[AnyTable, Row[]]>): void {
  for (const [table, rows] of fixtures) tables.set(getTableName(table), rows);
}

/** Drop every seeded row and any transaction override. Call in beforeEach. */
export function resetDb(): void {
  tables.clear();
  txHandler = null;
}

/**
 * Replace `db.transaction`. Used to observe whether a handler reached its write
 * phase at all (the waste-window gate is decided before the transaction opens).
 */
export function setTransactionHandler(fn: (cb: (tx: unknown) => unknown) => unknown): void {
  txHandler = fn;
}

const rowsOf = (table: AnyTable): Row[] => tables.get(getTableName(table)) ?? [];

/* ── the query builder ───────────────────────────────────────────────────── */

class FakeQuery implements PromiseLike<Row[]> {
  private bundles: Bundle[] = [];
  private base = "";
  private limitN: number | null = null;

  constructor(private fields: Record<string, unknown> | undefined, private distinct: boolean) {}

  from(table: AnyTable): this {
    this.base = getTableName(table);
    this.bundles = rowsOf(table).map((r) => ({ [this.base]: r }));
    return this;
  }

  innerJoin(table: AnyTable, on: unknown): this {
    return this.join(table, on, false);
  }

  leftJoin(table: AnyTable, on: unknown): this {
    return this.join(table, on, true);
  }

  private join(table: AnyTable, on: unknown, outer: boolean): this {
    const name = getTableName(table);
    const rows = rowsOf(table);
    const out: Bundle[] = [];
    for (const b of this.bundles) {
      const matched = rows.filter((r) => evalCond(on, { ...b, [name]: r }));
      if (matched.length) matched.forEach((r) => out.push({ ...b, [name]: r }));
      else if (outer) out.push({ ...b, [name]: {} });
    }
    this.bundles = out;
    return this;
  }

  where(cond: unknown): this {
    this.bundles = this.bundles.filter((b) => evalCond(cond, b));
    return this;
  }

  orderBy(...args: any[]): this {
    const keys = args.map((a) => {
      const col = isColumn(a) ? a : (a.queryChunks ?? []).find(isColumn);
      return { col, desc: !isColumn(a) && chunkText(a.queryChunks ?? []).includes("desc") };
    });
    this.bundles = [...this.bundles].sort((x, y) => {
      for (const k of keys) {
        const a = norm(readCol(x, k.col)) as any;
        const b = norm(readCol(y, k.col)) as any;
        if (a === b) continue;
        const cmp = a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1;
        return k.desc ? -cmp : cmp;
      }
      return 0;
    });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  /** `.for("update")` — the fake is single-threaded, so locking is a no-op. */
  for(): this {
    return this;
  }

  private project(bundle: Bundle): Row {
    if (!this.fields) return bundle[this.base] ?? {};
    const out: Row = {};
    for (const [k, f] of Object.entries(this.fields)) {
      if (isColumn(f)) out[k] = readCol(bundle, f);
      else throw new Error(`fake-db: unsupported projection for "${k}"`);
    }
    return out;
  }

  private rows(): Row[] {
    // Aggregates collapse the whole filtered set to one row. Only the three the
    // code under test actually uses are implemented — count(*) (the food cap),
    // count(*) FILTER and sum() (the webhook's per-link accounting). Anything
    // else still throws: a plausible wrong answer here is a test asserting fiction.
    const agg = Object.entries(this.fields ?? {}).filter(([, f]) => isSql(f));
    if (agg.length) {
      const row: Row = {};
      for (const [k, f] of agg) {
        const chunks: any[] = (f as any).queryChunks ?? [];
        const text = chunkText(chunks);
        if (text.includes("sum(")) {
          // Postgres returns a numeric sum as a STRING and the readers Number()
          // it; return the same shape so the test exercises that conversion too.
          const col = chunks.find(isColumn);
          const total = this.bundles.reduce((s, b) => s + Number(readCol(b, col) ?? 0), 0);
          row[k] = String(Math.round(total * 1e6) / 1e6);
        } else if (text.includes("count(")) {
          // count(*) FILTER (WHERE <col> <op> <param>): the filter is a single
          // atomic predicate, which evalAtomic already knows how to read.
          row[k] = text.includes("filter (where")
            ? this.bundles.filter((b) => evalAtomic(chunks, b)).length
            : this.bundles.length;
        } else {
          throw new Error(`fake-db: unsupported aggregate "${text}"`);
        }
      }
      return [row];
    }
    let out = this.bundles.map((b) => this.project(b));
    if (this.distinct) {
      const seen = new Set<string>();
      out = out.filter((r) => {
        const k = JSON.stringify(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return this.limitN === null ? out : out.slice(0, this.limitN);
  }

  then<A = Row[], B = never>(
    onOk?: ((v: Row[]) => A | PromiseLike<A>) | null,
    onErr?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.rows())
      .then(onOk, onErr);
  }
}

/* ── writes ──────────────────────────────────────────────────────────────────
 * Seeded rows are mutated in place, so a handler's own follow-up SELECT reads
 * what it just wrote — which is what makes an end-to-end assertion (post waste,
 * read it back) possible without a database.
 */

/**
 * Fill in what the DATABASE would have filled in: `defaultNow()` timestamps and
 * literal column defaults. Without this a row inserted by the code under test
 * has no `created_at`, so a later window query (`gte(createdAt, …)`) silently
 * skips it — and the fake would hide the very duplicate row a test exists to
 * catch, which is worse than not having the test.
 */
function withDefaults(table: AnyTable, row: Row): Row {
  const out: Row = { ...row };
  for (const [key, col] of Object.entries(getTableColumns(table) as Record<string, any>)) {
    if (out[key] !== undefined || !col?.hasDefault) continue;
    const def = col.default;
    if (def === undefined) continue;
    if (isSql(def)) {
      if (chunkText(def.queryChunks).includes("now()")) out[key] = new Date();
    } else {
      out[key] = def;
    }
  }
  return out;
}

/** Thenable that also answers `.returning()`, matching the drizzle write chain. */
const writeResult = (rows: Row[]) => ({
  returning: () => Promise.resolve(rows),
  then: <A>(ok?: (v: Row[]) => A) => Promise.resolve(rows).then(ok),
});

/** The `db` stand-in. Mock `@workspace/db`'s `db` export with this. */
export const fakeDb = {
  select: (fields?: Record<string, unknown>) => new FakeQuery(fields, false),
  selectDistinct: (fields?: Record<string, unknown>) => new FakeQuery(fields, true),
  transaction: (fn: (tx: unknown) => unknown) => (txHandler ? txHandler(fn) : fn(fakeDb)),
  insert: (table: AnyTable) => ({
    values: (v: Row | Row[]) => {
      const incoming = (Array.isArray(v) ? v : [v]).map((r) => withDefaults(table, r));
      /* Drizzle's insert builder is LAZY — it runs when awaited, which is what
       * lets `.onConflictDoUpdate()` change the statement before anything is
       * written. Executing eagerly in `values()` (as this used to) made every
       * upsert handler a plain insert here: the config-writing routes all use
       * `insert().values().onConflictDoUpdate()`, and against an eager fake the
       * second save appended a duplicate row instead of updating the first, so
       * the read-back assertion that matters most silently passed on the stale
       * row. Deferred, and memoised so `.returning()` after an `await` does not
       * write twice. */
      const exec = (run: () => Row[]) => {
        let done: Row[] | null = null;
        const once = () => (done ??= run());
        const chain: any = {
          returning: () => Promise.resolve(once()),
          then: <A>(ok?: (r: Row[]) => A) => Promise.resolve(once()).then(ok),
          onConflictDoNothing: () => exec(() => upsert(null)),
          onConflictDoUpdate: (cfg: { target?: unknown; set?: Row }) =>
            exec(() => upsert(cfg?.set ?? {}, cfg?.target)),
        };
        return chain;
      };
      /** The property keys behind a conflict target (a column or array of them). */
      const targetKeys = (target: unknown): string[] => {
        const cols = Array.isArray(target) ? target : target == null ? [] : [target];
        const entries = Object.entries(getTableColumns(table) as Record<string, unknown>);
        return cols
          .map((c) => entries.find(([, col]) => col === c)?.[0])
          .filter((k): k is string => !!k);
      };
      /** `set === null` is DO NOTHING; otherwise DO UPDATE with those values.
       *  `set` is taken as literals — a real `sql`/excluded expression is not
       *  evaluated here, so a handler that needs one wants a real database. */
      const upsert = (set: Row | null, target?: unknown): Row[] => {
        const keys = targetKeys(target);
        const rows = rowsOf(table);
        const out: Row[] = [];
        const added: Row[] = [];
        for (const r of incoming) {
          const clash = keys.length
            ? rows.find((e) => keys.every((k) => e[k] === r[k]))
            : undefined;
          if (clash) {
            if (set) { Object.assign(clash, set); out.push(clash); }
          } else {
            added.push(r);
            out.push(r);
          }
        }
        if (added.length) tables.set(getTableName(table), [...rows, ...added]);
        return out;
      };
      return exec(() => {
        tables.set(getTableName(table), [...rowsOf(table), ...incoming]);
        return incoming;
      });
    },
  }),
  update: (table: AnyTable) => ({
    set: (values: Row) => ({
      where: (cond: unknown) => {
        const name = getTableName(table);
        const hit = rowsOf(table).filter((r) => evalCond(cond, { [name]: r }));
        hit.forEach((r) => Object.assign(r, values));
        return writeResult(hit);
      },
    }),
  }),
  delete: (table: AnyTable) => ({
    where: (cond: unknown) => {
      const name = getTableName(table);
      const keep: Row[] = [];
      const gone: Row[] = [];
      for (const r of rowsOf(table)) (evalCond(cond, { [name]: r }) ? gone : keep).push(r);
      tables.set(name, keep);
      return writeResult(gone);
    },
  }),
};
