/**
 * Walking and rewriting the JSON path subset the manifest declares.
 *
 * Two operations, one traversal, so a path can never be rewritten by the
 * migration and then missed by the verifier:
 *
 *   collectUuids()  every uuid-shaped string in a payload, with its path.
 *                   Used by id:verify (find what is left) and id:json-audit
 *                   (find what is there at all).
 *   rewrite()       replace ids at EXACTLY the declared paths, nowhere else.
 *
 * Path grammar (see JsonPathRule for why keys matter):
 *
 *   $           the root
 *   .name       a literal object key
 *   .{*}        any object key — matches the key itself when kind is "key",
 *               otherwise descends into its value
 *   [*]         any array element
 *
 * A path that matches nothing is not an error: most of these columns are
 * nullable and sparsely populated, and a schedule with no `within` narrowing is
 * ordinary.
 *
 * What counts as an id is decided by MEMBERSHIP IN THE ID MAP, never by uuid
 * shape. Seeded rows in this database carry readable ids (`user_food_unit2`,
 * `dish_curd`), so a shape test would quietly skip them. Shape is used only
 * where there is no map to consult: discovery (id:json-audit) and the
 * verifier's belt-and-braces leftover check.
 */
import { UUID_RE, type JsonPathRule } from "./manifest.js";

/** One id-shaped string found in a payload, with the path that reached it. */
export interface FoundId {
  /** Array indices collapse to [*] and object keys to their literal name. */
  path: string;
  value: string;
  /** True when the uuid was an object KEY rather than a leaf value. */
  isKey: boolean;
}

export function collectUuids(value: unknown, path = "$", out: FoundId[] = []): FoundId[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    if (UUID_RE.test(value)) out.push({ path, value, isKey: false });
    return out;
  }
  if (Array.isArray(value)) {
    for (const el of value) collectUuids(el, `${path}[*]`, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (UUID_RE.test(k)) out.push({ path: `${path}.{key}`, value: k, isKey: true });
      collectUuids(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Split "$.within.{*}[*]" into ["within", "{*}", "[*]"]. */
function segments(path: string): string[] {
  const body = path.startsWith("$") ? path.slice(1) : path;
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === ".") {
      i++;
      let j = i;
      while (j < body.length && body[j] !== "." && body[j] !== "[") j++;
      out.push(body.slice(i, j));
      i = j;
    } else if (body[i] === "[") {
      const j = body.indexOf("]", i);
      out.push(body.slice(i, j + 1));
      i = j + 1;
    } else {
      throw new Error(`Unparseable JSON path segment at ${i} in "${path}"`);
    }
  }
  return out;
}

export interface RewriteResult {
  value: unknown;
  /** Ids actually replaced. */
  replaced: number;
  /**
   * Uuids sitting at a declared path that the id map could not resolve. For a
   * lenient rule these are ordinary (an email in a CUSTOM recipient list); for
   * a strict one they are a dangling pointer the caller must decide about.
   */
  unresolved: { path: string; value: string }[];
}

/**
 * Apply every rule to one payload. Returns a new value — the input is never
 * mutated, so a caller that decides not to write can simply drop the result.
 */
export function rewrite(
  value: unknown,
  rules: JsonPathRule[],
  lookup: (legacyId: string) => number | undefined,
): RewriteResult {
  const res: RewriteResult = { value, replaced: 0, unresolved: [] };
  let current = value;
  for (const rule of rules) {
    current = applyRule(current, segments(rule.path), 0, rule, lookup, res, "$");
  }
  res.value = current;
  return res;
}

function applyRule(
  node: unknown,
  segs: string[],
  depth: number,
  rule: JsonPathRule,
  lookup: (legacyId: string) => number | undefined,
  res: RewriteResult,
  here: string,
): unknown {
  if (node === null || node === undefined) return node;

  // Past the last segment: this node is the target value.
  if (depth === segs.length) return replaceValue(node, lookup, res, here);

  const seg = segs[depth]!;

  if (seg === "[*]") {
    if (!Array.isArray(node)) return node;
    return node.map((el, i) => applyRule(el, segs, depth + 1, rule, lookup, res, `${here}[${i}]`));
  }

  if (typeof node !== "object" || Array.isArray(node)) return node;
  const obj = node as Record<string, unknown>;

  if (seg === "{*}") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // A "key" rule terminating here rewrites the KEY and leaves the value;
      // otherwise the wildcard is just a step on the way down.
      const isTerminalKeyRule = rule.kind === "key" && depth === segs.length - 1;
      const newKey = isTerminalKeyRule ? replaceKey(k, lookup, res, here) : k;
      out[newKey] = isTerminalKeyRule
        ? v
        : applyRule(v, segs, depth + 1, rule, lookup, res, `${here}.${k}`);
    }
    return out;
  }

  if (!(seg in obj)) return node;
  return { ...obj, [seg]: applyRule(obj[seg], segs, depth + 1, rule, lookup, res, `${here}.${seg}`) };
}

function replaceValue(
  node: unknown,
  lookup: (legacyId: string) => number | undefined,
  res: RewriteResult,
  here: string,
): unknown {
  // Arrays reached without a trailing [*] (e.g. `$.ids` pointed at the array
  // itself) are still worth descending into one level; anything else passes.
  if (Array.isArray(node)) return node.map((el) => replaceValue(el, lookup, res, here));
  // Already a bigint: the migration is re-runnable and this is the second pass.
  if (typeof node !== "string") return node;

  // Membership in the id map, NOT uuid shape, decides. Most ids in this
  // database are randomUUID(), but seeded rows carry readable slugs
  // (`user_food_unit2`, `dish_curd`, `audit-scale-uniliv-standard`), and a
  // shape test walks straight past those — leaving a live-config pointer that
  // resolves to nothing and no error anywhere to say so.
  const mapped = lookup(node);
  if (mapped !== undefined) {
    res.replaced++;
    return mapped;
  }
  // Unmapped and id-shaped is a dangling pointer worth reporting; unmapped and
  // plainly not an id (an email in a CUSTOM recipient list) is ordinary.
  if (UUID_RE.test(node)) res.unresolved.push({ path: here, value: node });
  return node;
}

function replaceKey(
  k: string,
  lookup: (legacyId: string) => number | undefined,
  res: RewriteResult,
  here: string,
): string {
  const mapped = lookup(k);
  if (mapped === undefined) {
    if (UUID_RE.test(k)) res.unresolved.push({ path: `${here}.{key}`, value: k });
    return k;
  }
  res.replaced++;
  // JSON object keys are strings by definition — the bigint is stringified, and
  // every consumer indexes this map with a String(id) anyway.
  return String(mapped);
}
