/**
 * Org-node tree maintenance (Access Controls PRD §4).
 *
 * One adjacency tree plus a closure table stands in for the PRD's two
 * hierarchies and eleven levels. The closure table is what makes "everything
 * under X" a single `inArray` instead of a recursive query or a path LIKE — see
 * the G2 note in lib/db/src/schema/access.ts for why that choice is load-bearing.
 *
 * WRITE SOURCE: org_nodes is a PROJECTION. zones/cities/clusters/kitchens remain
 * the tables the app writes, and their generic registry in routes/masters.ts is
 * the single hook that keeps the projection in step — one hook, not five.
 * Properties and rooms project from their own routers. The levels with no legacy
 * table (COMPANY/REGION/BUILDING/FLOOR/BED) are org-nodes-native and written here
 * directly. That is the payoff: the sprawl stops going forward without a risky
 * rewrite of what already works.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  orgNodesTable,
  orgNodeClosureTable,
  type OrgNodeType,
  type OrgPathKind,
} from "@workspace/db";
import { badRequest } from "./authz.js";

/**
 * Which parent types each level accepts — ONE table of pairs rather than eleven
 * branches, so adding a level is a row here plus an enum append.
 *
 * Several levels accept more than one parent on purpose: the estate is not
 * uniformly deep. A city may sit under a zone or a region or directly under the
 * company (cities.zoneId is already nullable — "cities sit directly under the
 * implicit India root"), and a room may hang off a floor, a building, or a bare
 * property, because most properties today have neither buildings nor floors
 * modelled. Requiring the full chain would make every existing room unmappable.
 */
export const ALLOWED_PARENTS: Record<OrgNodeType, readonly OrgNodeType[]> = {
  COMPANY: [],
  ZONE: ["COMPANY"],
  REGION: ["COMPANY", "ZONE"],
  CITY: ["ZONE", "REGION", "COMPANY"],
  CLUSTER: ["CITY"],
  KITCHEN: ["CITY"],
  PROPERTY: ["CLUSTER", "CITY", "REGION"],
  BUILDING: ["PROPERTY"],
  FLOOR: ["BUILDING", "PROPERTY"],
  ROOM: ["FLOOR", "BUILDING", "PROPERTY"],
  BED: ["ROOM"],
};

/** Depth ordering for display and validation. NOT the pg enum order. */
export const NODE_LEVEL_ORDER: readonly OrgNodeType[] = [
  "COMPANY", "ZONE", "REGION", "CITY", "CLUSTER", "KITCHEN",
  "PROPERTY", "BUILDING", "FLOOR", "ROOM", "BED",
];

export interface OrgNodeInput {
  id: string;
  nodeType: OrgNodeType;
  parentId: string | null;
  name: string;
  code?: string | null;
  isActive?: boolean;
}

type Tx = Pick<typeof db, "select" | "insert" | "delete" | "update">;

/** 400 unless `parentType` may legally parent `childType`. */
export function assertValidParent(childType: OrgNodeType, parentType: OrgNodeType | null): void {
  const allowed = ALLOWED_PARENTS[childType];
  if (parentType === null) {
    if (allowed.length === 0) return;
    throw badRequest(`${childType} requires a parent`, {
      code: "ORG_PARENT_REQUIRED",
      allowed,
    });
  }
  if (!allowed.includes(parentType)) {
    throw badRequest(`${childType} cannot sit under ${parentType}`, {
      code: "ORG_PARENT_INVALID",
      allowed,
    });
  }
}

/**
 * Insert a node and its closure rows.
 *
 * Two statements: copy every ancestor row of the parent down one level, then the
 * node's own depth-0 self-row. Both TREE — a SERVES edge is added separately by
 * linkServes(), because a node may serve many parents but structurally has one.
 */
export async function insertNode(tx: Tx, input: OrgNodeInput): Promise<void> {
  let parentPath = "/";
  let depth = 0;

  if (input.parentId) {
    const [parent] = await tx
      .select({ nodeType: orgNodesTable.nodeType, path: orgNodesTable.path, depth: orgNodesTable.depth })
      .from(orgNodesTable)
      .where(eq(orgNodesTable.id, input.parentId));
    if (!parent) throw badRequest("Parent node not found", { code: "ORG_PARENT_MISSING" });
    assertValidParent(input.nodeType, parent.nodeType);
    parentPath = parent.path;
    depth = parent.depth + 1;
  } else {
    assertValidParent(input.nodeType, null);
  }

  await tx.insert(orgNodesTable).values({
    id: input.id,
    nodeType: input.nodeType,
    parentId: input.parentId,
    path: `${parentPath}${input.id}/`,
    depth,
    name: input.name,
    code: input.code ?? null,
    isActive: input.isActive ?? true,
    updatedAt: new Date(),
  });

  if (input.parentId) {
    await tx.insert(orgNodeClosureTable).select(
      db
        .select({
          ancestorId: orgNodeClosureTable.ancestorId,
          descendantId: sql<string>`${input.id}`.as("descendant_id"),
          depth: sql<number>`${orgNodeClosureTable.depth} + 1`.as("depth"),
          pathKind: orgNodeClosureTable.pathKind,
        })
        .from(orgNodeClosureTable)
        .where(
          and(
            eq(orgNodeClosureTable.descendantId, input.parentId),
            eq(orgNodeClosureTable.pathKind, "TREE"),
          ),
        ),
    );
  }

  await tx.insert(orgNodeClosureTable).values({
    ancestorId: input.id,
    descendantId: input.id,
    depth: 0,
    pathKind: "TREE",
  });
}

/**
 * Record that `servingId` serves `servedId` — the F&B kitchen→property edge.
 *
 * The served node is attached to the server AND to the server's own ancestors,
 * so a CITY grant with followLinks reaches kitchen-served properties exactly as
 * food-service's resolveAccessiblePropertyIds does today. Nothing below the
 * served node is pulled in: serving a property does not serve its rooms.
 */
export async function linkServes(tx: Tx, servingId: string, servedId: string): Promise<void> {
  const ancestors = await tx
    .select({ ancestorId: orgNodeClosureTable.ancestorId, depth: orgNodeClosureTable.depth })
    .from(orgNodeClosureTable)
    .where(
      and(eq(orgNodeClosureTable.descendantId, servingId), eq(orgNodeClosureTable.pathKind, "TREE")),
    );

  if (!ancestors.length) return;
  await tx
    .insert(orgNodeClosureTable)
    .values(
      ancestors.map((a) => ({
        ancestorId: a.ancestorId,
        descendantId: servedId,
        depth: a.depth + 1,
        pathKind: "SERVES" as OrgPathKind,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Every node id at or below `nodeIds`.
 *
 * `followLinks` decides whether SERVES edges count. Off by default — see the
 * followLinks comment on access_grants for how defaulting it true over-grants.
 *
 * ── Why inactivity needs a second query ─────────────────────────────────────
 * A closure table FLATTENS the path: deactivating an intermediate cluster does
 * not remove the (city → property) row, so filtering on the descendant's own
 * isActive is not enough. food-service's expandZonesToCities walks level by
 * level and therefore stops dead at an inactive node, and a retired cluster must
 * keep behaving that way — otherwise deactivating it silently leaves every
 * property under it still granted.
 *
 * So: take the candidates, then subtract everything reachable beneath any
 * inactive node. Two extra queries total, not one per node.
 */
export async function descendantIds(
  nodeIds: string[],
  opts: { followLinks?: boolean; includeInactive?: boolean } = {},
): Promise<string[]> {
  if (!nodeIds.length) return [];
  const kinds: OrgPathKind[] = opts.followLinks ? ["TREE", "SERVES"] : ["TREE"];

  const rows = await db
    .select({ id: orgNodeClosureTable.descendantId })
    .from(orgNodeClosureTable)
    .innerJoin(orgNodesTable, eq(orgNodeClosureTable.descendantId, orgNodesTable.id))
    .where(
      and(
        inArray(orgNodeClosureTable.ancestorId, nodeIds),
        inArray(orgNodeClosureTable.pathKind, kinds),
        opts.includeInactive ? undefined : eq(orgNodesTable.isActive, true),
      ),
    );

  const ids = [...new Set(rows.map((r) => r.id))];
  if (opts.includeInactive || !ids.length) return ids;

  const blocked = await idsBeneathInactiveNodes(kinds);
  return blocked.size ? ids.filter((id) => !blocked.has(id)) : ids;
}

/**
 * Every node sitting beneath (or being) an inactive node, for the given edge
 * kinds. Returned as a Set so the caller subtracts in one pass.
 */
async function idsBeneathInactiveNodes(kinds: OrgPathKind[]): Promise<Set<string>> {
  const inactive = await db
    .select({ id: orgNodesTable.id })
    .from(orgNodesTable)
    .where(eq(orgNodesTable.isActive, false));
  if (!inactive.length) return new Set();

  const rows = await db
    .select({ id: orgNodeClosureTable.descendantId })
    .from(orgNodeClosureTable)
    .where(
      and(
        inArray(
          orgNodeClosureTable.ancestorId,
          inactive.map((r) => r.id),
        ),
        inArray(orgNodeClosureTable.pathKind, kinds),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** As descendantIds, but only nodes of the given type (e.g. every PROPERTY). */
export async function descendantIdsOfType(
  nodeIds: string[],
  nodeType: OrgNodeType,
  opts: { followLinks?: boolean; includeInactive?: boolean } = {},
): Promise<string[]> {
  const ids = await descendantIds(nodeIds, opts);
  if (!ids.length) return [];
  const rows = await db
    .select({ id: orgNodesTable.id })
    .from(orgNodesTable)
    .where(and(inArray(orgNodesTable.id, ids), eq(orgNodesTable.nodeType, nodeType)));
  return rows.map((r) => r.id);
}
