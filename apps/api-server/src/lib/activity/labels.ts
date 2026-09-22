/**
 * Turn the raw ids inside a trail row's before/after payload into names.
 *
 * PRD §29 asks each event to record its previous and new value. Several of
 * those values are ids by nature — the node an access preview was run at, the
 * property an assignment moved to, the grant that was revoked — and an id is
 * not a value a human can read. "atNode: 7300ab1d-96e1-4676-9ab1-…" tells the
 * reviewer nothing about WHERE the preview was run.
 *
 * Resolving at READ time rather than at write time is deliberate:
 *
 *  - it fixes every event at once, including ones recorded before this existed,
 *    instead of asking each of the ~12 recordActivity() call sites to remember
 *    to join a name in;
 *  - the trail rows stay immutable and id-keyed, which is what the hash chain
 *    signs. Baking a name into the signed payload would mean a later rename
 *    makes old rows unreadable-but-still-valid, or worse, tempts a rewrite.
 *
 * The id itself is still returned to the client, which shows it on hover — so
 * nothing is lost, it is just no longer the first thing you read.
 *
 * G1 (a node's id IS its entity's id) is what makes this cheap: one lookup in
 * org_nodes covers properties, kitchens, cities, clusters and zones alike.
 */
import { inArray } from "drizzle-orm";
import { db, orgNodesTable, usersTable, propertiesTable } from "@workspace/db";

/** A value worth trying to resolve. Matches uuid v4 as produced by newId(). */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIdLike(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

/** Every id-shaped string anywhere inside a JSON value, arrays and nesting included. */
export function collectIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (isIdLike(value)) { into.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectIds(v, into, depth + 1); return; }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectIds(v, into, depth + 1);
  }
}

export interface LabelEntry {
  label: string;
  /** What the id turned out to be — the UI uses this only for a tone/tooltip. */
  kind: "node" | "user" | "property";
  /** Node type (PROPERTY, CITY, …) when kind is "node". */
  subtype?: string;
}

/**
 * Resolve a page of trail rows' ids to display labels.
 *
 * Three batched `IN` queries regardless of page size, in priority order: a node
 * name beats a property name for the same id (they are the same row under G1,
 * but the node carries its level, which is the more useful of the two).
 */
export async function resolveLabels(
  rows: Array<{ beforeJson?: unknown; afterJson?: unknown }>,
): Promise<Record<string, LabelEntry>> {
  const ids = new Set<string>();
  for (const r of rows) {
    collectIds(r.beforeJson, ids);
    collectIds(r.afterJson, ids);
  }
  if (!ids.size) return {};

  const list = [...ids];
  const out: Record<string, LabelEntry> = {};

  const [nodes, users, properties] = await Promise.all([
    db.select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
      .from(orgNodesTable).where(inArray(orgNodesTable.id, list)),
    db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable).where(inArray(usersTable.id, list)),
    db.select({ id: propertiesTable.id, name: propertiesTable.name })
      .from(propertiesTable).where(inArray(propertiesTable.id, list)),
  ]);

  // Lowest priority first, so a better answer overwrites a weaker one.
  for (const p of properties) out[p.id] = { label: p.name, kind: "property" };
  for (const u of users) out[u.id] = { label: u.name || u.email, kind: "user" };
  for (const n of nodes) out[n.id] = { label: n.name, kind: "node", subtype: n.nodeType };

  return out;
}
