/**
 * Building the org_nodes projection, and backfilling access_grants.
 *
 * Lives here rather than in scripts/ so it is unit-testable and so a thin CLI
 * wrapper can call it later without duplicating the logic. Both functions are
 * IDEMPOTENT and re-runnable: this is the Phase 1 backfill AND the recovery path
 * when the projection drifts.
 *
 * org_nodes is a PROJECTION, not a replacement. zones/cities/clusters/kitchens/
 * properties/rooms remain the tables the app writes; deliberately not converted
 * to views, because `drizzle-kit push` would try to CREATE TABLE over a view
 * name while verify-schema (which reads information_schema.columns, where a view
 * is indistinguishable from a table) reported everything fine.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  zonesTable,
  citiesTable,
  clustersTable,
  kitchensTable,
  propertiesTable,
  roomsTable,
  usersTable,
  employeesTable,
  userScopesTable,
  auditRoleGrantsTable,
  orgNodesTable,
  orgNodeClosureTable,
  accessGrantsTable,
  type OrgNodeType,
} from "@workspace/db";
import { newId } from "./id.js";

/** The implicit root every zone and unparented city hangs from. */
export const COMPANY_NODE_ID = "org-root";

export interface SyncReport {
  nodes: Record<string, number>;
  closureRows: number;
  servesEdges: number;
  /** Rows the projection could not place — each one is access nobody will get. */
  orphans: string[];
}

interface FlatNode {
  id: string;
  nodeType: OrgNodeType;
  parentId: string | null;
  name: string;
  code: string | null;
  isActive: boolean;
}

/**
 * Rebuild org_nodes + org_node_closure from the live source tables.
 *
 * Full rebuild rather than incremental: the closure of a few hundred thousand
 * rows is cheap, and an incremental path would need to be exactly right about
 * subtree moves — the one case worth not being clever about.
 */
export async function syncOrgNodes(): Promise<SyncReport> {
  const [zones, cities, clusters, kitchens, properties, rooms] = await Promise.all([
    db.select().from(zonesTable),
    db.select().from(citiesTable),
    db.select().from(clustersTable),
    db.select().from(kitchensTable),
    db.select().from(propertiesTable),
    db.select().from(roomsTable),
  ]);

  const orphans: string[] = [];
  const nodes: FlatNode[] = [
    { id: COMPANY_NODE_ID, nodeType: "COMPANY", parentId: null, name: "Uniliv", code: null, isActive: true },
  ];

  for (const z of zones) {
    nodes.push({ id: z.id, nodeType: "ZONE", parentId: COMPANY_NODE_ID, name: z.name, code: z.code ?? null, isActive: z.isActive });
  }
  for (const c of cities) {
    // cities.zoneId is nullable by design — "cities sit directly under the
    // implicit India root" — so an unzoned city attaches to the company node
    // rather than being dropped.
    nodes.push({ id: c.id, nodeType: "CITY", parentId: c.zoneId ?? COMPANY_NODE_ID, name: c.name, code: null, isActive: c.isActive });
  }
  for (const cl of clusters) {
    nodes.push({ id: cl.id, nodeType: "CLUSTER", parentId: cl.cityId, name: cl.name, code: null, isActive: cl.isActive });
  }
  for (const k of kitchens) {
    if (!k.cityId) { orphans.push(`kitchen ${k.id} (${k.name}) has no cityId`); continue; }
    nodes.push({ id: k.id, nodeType: "KITCHEN", parentId: k.cityId, name: k.name, code: k.code, isActive: k.isActive });
  }
  for (const p of properties) {
    // A property with no cluster is invisible to every CLUSTER/CITY/ZONE grant —
    // the same drift the food-organization screen already warns about. Record it
    // rather than silently attaching it to the root, which would over-grant.
    if (!p.clusterId) orphans.push(`property ${p.id} (${p.name}) is in no cluster`);
    nodes.push({
      id: p.id, nodeType: "PROPERTY", parentId: p.clusterId ?? COMPANY_NODE_ID,
      name: p.name, code: p.code ?? null, isActive: p.status === "ACTIVE",
    });
  }
  for (const r of rooms) {
    // No BUILDING/FLOOR nodes exist yet (rooms.floor is an integer, not an
    // entity), so rooms attach straight to their property. ALLOWED_PARENTS
    // permits exactly that, which is why the chain is optional there.
    nodes.push({ id: r.id, nodeType: "ROOM", parentId: r.propertyId, name: r.number, code: null, isActive: true });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Drop anything whose parent is missing; keeping it would make depth/path lie.
  const placeable = nodes.filter((n) => {
    if (n.parentId === null) return true;
    if (byId.has(n.parentId)) return true;
    orphans.push(`${n.nodeType} ${n.id} references missing parent ${n.parentId}`);
    return false;
  });

  const depthOf = new Map<string, number>();
  const pathOf = new Map<string, string>();
  const resolve = (n: FlatNode): { depth: number; path: string } => {
    if (depthOf.has(n.id)) return { depth: depthOf.get(n.id)!, path: pathOf.get(n.id)! };
    if (!n.parentId) {
      depthOf.set(n.id, 0);
      pathOf.set(n.id, `/${n.id}/`);
    } else {
      const parent = resolve(byId.get(n.parentId)!);
      depthOf.set(n.id, parent.depth + 1);
      pathOf.set(n.id, `${parent.path}${n.id}/`);
    }
    return { depth: depthOf.get(n.id)!, path: pathOf.get(n.id)! };
  };
  for (const n of placeable) resolve(n);

  // Closure: walk each node's ancestor chain. O(nodes x depth), depth <= 7.
  const closure: Array<{ ancestorId: string; descendantId: string; depth: number; pathKind: "TREE" | "SERVES" }> = [];
  for (const n of placeable) {
    let cur: string | null = n.id;
    let depth = 0;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: n.id, depth, pathKind: "TREE" });
      cur = byId.get(cur)?.parentId ?? null;
      depth++;
    }
  }

  // SERVES: kitchen -> property, plus the kitchen's own ancestors, so a CITY
  // grant with followLinks reaches served properties exactly as the food
  // resolver does today.
  let servesEdges = 0;
  for (const p of properties) {
    if (!p.kitchenId || !byId.has(p.kitchenId)) continue;
    let cur: string | null = p.kitchenId;
    let depth = 1;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: p.id, depth, pathKind: "SERVES" });
      cur = byId.get(cur)?.parentId ?? null;
      depth++;
    }
    servesEdges++;
  }

  await db.transaction(async (tx) => {
    await tx.delete(orgNodeClosureTable);
    await tx.delete(orgNodesTable);
    if (placeable.length) {
      await tx.insert(orgNodesTable).values(
        placeable.map((n) => ({
          id: n.id, nodeType: n.nodeType, parentId: n.parentId,
          path: pathOf.get(n.id)!, depth: depthOf.get(n.id)!,
          name: n.name, code: n.code, isActive: n.isActive, updatedAt: new Date(),
        })),
      );
    }
    for (let i = 0; i < closure.length; i += 1000) {
      await tx.insert(orgNodeClosureTable).values(closure.slice(i, i + 1000));
    }
  });

  const counts: Record<string, number> = {};
  for (const n of placeable) counts[n.nodeType] = (counts[n.nodeType] ?? 0) + 1;
  return { nodes: counts, closureRows: closure.length, servesEdges, orphans };
}

export interface BackfillReport {
  fromUserScopes: number;
  fromAuditGrants: number;
  fromHomeProperty: number;
  orgWide: number;
  employeesLinked: number;
  /** Users who had access before and would have none now. MUST be empty. */
  wouldLoseAccess: string[];
}

/**
 * Mint access_grants from the two legacy scope systems plus users.propertyId.
 *
 * Idempotent: every grant is keyed by the paired partial uniques, so a re-run
 * conflicts and does nothing rather than duplicating.
 *
 * The `wouldLoseAccess` list is the important output. The big-bang rollout has
 * no production shadow period, so this report is the only thing standing between
 * a cutover and a user silently losing access — it must be empty before Phase 2.
 */
export async function backfillAccessGrants(): Promise<BackfillReport> {
  const report: BackfillReport = {
    fromUserScopes: 0, fromAuditGrants: 0, fromHomeProperty: 0,
    orgWide: 0, employeesLinked: 0, wouldLoseAccess: [],
  };

  const nodeIds = new Set((await db.select({ id: orgNodesTable.id }).from(orgNodesTable)).map((r) => r.id));
  const rows: Array<typeof accessGrantsTable.$inferInsert> = [];

  // 1. Food scopes. followLinks TRUE: the food spine is the one that traverses
  //    kitchens today, and the backfill must preserve exactly what users had.
  const scopes = await db.select().from(userScopesTable).where(eq(userScopesTable.isActive, true));
  for (const s of scopes) {
    const node = s.propertyId ?? s.clusterId ?? s.kitchenId ?? s.cityId ?? s.zoneId ?? null;
    if (s.scopeLevel !== "GLOBAL" && (!node || !nodeIds.has(node))) continue;
    rows.push({
      id: newId(), subjectType: "USER", subjectId: s.userId, roleKey: "*",
      nodeId: s.scopeLevel === "GLOBAL" ? null : node,
      includeDescendants: true, followLinks: true, dataScope: "ALL",
      qualifiers: [], assignmentKind: "GRANT",
    });
    report.fromUserScopes++;
  }

  // 2. Audit grants. followLinks FALSE — audit has never crossed the kitchen
  //    spine, and turning it on here would widen every auditor's reach.
  const auditGrants = await db
    .select()
    .from(auditRoleGrantsTable)
    .where(isNull(auditRoleGrantsTable.revokedAt));
  for (const g of auditGrants) {
    const node = g.propertyId ?? g.clusterId ?? g.cityId ?? g.zoneId ?? null;
    if (g.scopeLevel !== "GLOBAL" && (!node || !nodeIds.has(node))) continue;
    rows.push({
      id: newId(), subjectType: "USER", subjectId: g.userId,
      roleKey: `AUDIT.${g.moduleRole}`,
      nodeId: g.scopeLevel === "GLOBAL" ? null : node,
      includeDescendants: true, followLinks: false, dataScope: "ALL",
      qualifiers: g.auditTypes ?? [], assignmentKind: "GRANT",
      effectiveFrom: g.effectiveFrom, expiresAt: g.expiresAt,
    });
    report.fromAuditGrants++;
  }

  // 3. users.propertyId -> a PRIMARY assignment (PRD §27).
  //
  // CRITICAL: do NOT mint org-wide grants from authz.ts's ORG_WIDE_ROLES.
  //
  // That set means "the GENERIC scopedPropertyId helper does not restrict this
  // role" — its own comment says the food/regional roles are listed there
  // *because the food module does its own hierarchy scoping*. Treating it as
  // "unrestricted everywhere" promotes every FNB_MANAGER, CLUSTER_MANAGER and
  // CITY_HEAD from their granted cities to the entire estate. Verified against
  // live data: it diverged for 14 of 30 users.
  //
  // Org-wide-ness is currently PER MODULE, and the four role taxonomies
  // (ROLE_PERMISSIONS / ORG_WIDE_ROLES / ROLE_RANK / ALWAYS_GLOBAL) disagree
  // about it. Collapsing them needs a decision per role, so until then the only
  // roles that get a genuine org-wide grant are the ones the FOOD resolver
  // already treats as global. The generic helper keeps using ORG_WIDE_ROLES
  // untouched, so residents/complaints/laundry behaviour does not move either.
  const ALWAYS_GLOBAL = ["SUPER_ADMIN", "OPS_EXCELLENCE", "SENIOR_VICE_PRESIDENT", "AUDIT_READONLY"];
  const { ORG_WIDE_ROLES_LIST } = await import("./authz.js");

  const users = await db.select().from(usersTable).where(eq(usersTable.isActive, true));
  for (const u of users) {
    if (ALWAYS_GLOBAL.includes(u.role)) {
      // SUPER_ADMIN / OPS_EXCELLENCE short-circuit in the resolver anyway; the
      // row matters for SENIOR_VICE_PRESIDENT and AUDIT_READONLY, which do not.
      rows.push({
        id: newId(), subjectType: "USER", subjectId: u.id, roleKey: "*",
        nodeId: null, includeDescendants: true, followLinks: false,
        dataScope: "ALL", qualifiers: [], assignmentKind: "GRANT",
      });
      report.orgWide++;
      continue;
    }

    if (u.propertyId && nodeIds.has(u.propertyId)) {
      rows.push({
        id: newId(), subjectType: "USER", subjectId: u.id, roleKey: "*",
        nodeId: u.propertyId, includeDescendants: true, followLinks: false,
        dataScope: "ALL", qualifiers: [], assignmentKind: "PRIMARY",
      });
      report.fromHomeProperty++;
      continue;
    }

    // A PROPERTY-BOUND role with a null propertyId is unscoped TODAY — a quirk
    // of isPropertyScoped() requiring a non-null value — and would resolve to []
    // after cutover. Security fix and availability risk at once, so it is
    // reported, never silently applied. Roles the generic helper already treats
    // as org-wide are not affected by that quirk and are not listed.
    if (!u.propertyId && !ORG_WIDE_ROLES_LIST.includes(u.role)) {
      report.wouldLoseAccess.push(`${u.id} (${u.email}, ${u.role}) has no propertyId and no scope row`);
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(accessGrantsTable).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }

  // 4. Link logins to employee records by unique email — both columns are
  //    .unique(), so the match is deterministic. Unmatched users simply get no
  //    TEAM scope, which fails closed.
  const emps = await db.select({ id: employeesTable.id, email: employeesTable.email }).from(employeesTable);
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  for (const e of emps) {
    const uid = userByEmail.get(e.email.toLowerCase());
    if (!uid) continue;
    await db.update(employeesTable).set({ userId: uid }).where(eq(employeesTable.id, e.id));
    report.employeesLinked++;
  }

  return report;
}

/**
 * Assign a user's PRIMARY property (PRD §27).
 *
 * Writes BOTH sides on purpose:
 *
 *  - `access_grants` PRIMARY row — what the new resolver reads.
 *  - `users.propertyId`          — what the LEGACY generic helper reads.
 *
 * Writing only the grant would leave the user still unscoped on every route
 * that has not moved to the new resolver yet, because `isPropertyScoped()`
 * treats a null `propertyId` as unrestricted. That quirk is the very hole this
 * is usually being called to close, so closing half of it would be worse than
 * useless — it would look fixed in the preview while the user kept seeing
 * everything everywhere.
 *
 * Idempotent: the paired partial unique on access_grants makes a repeat a no-op.
 */
export async function assignPrimaryProperty(userId: string, propertyId: string): Promise<void> {
  const [node] = await db
    .select({ id: orgNodesTable.id, nodeType: orgNodesTable.nodeType })
    .from(orgNodesTable)
    .where(eq(orgNodesTable.id, propertyId));
  if (!node) throw new Error(`No org node for property ${propertyId} — run syncOrgNodes() first`);
  if (node.nodeType !== "PROPERTY") throw new Error(`${propertyId} is a ${node.nodeType}, not a PROPERTY`);

  await db.transaction(async (tx) => {
    await tx
      .insert(accessGrantsTable)
      .values({
        id: newId(),
        subjectType: "USER",
        subjectId: userId,
        roleKey: "*",
        nodeId: propertyId,
        includeDescendants: true,
        followLinks: false,
        dataScope: "ALL",
        qualifiers: [],
        assignmentKind: "PRIMARY",
      })
      .onConflictDoNothing();
    await tx.update(usersTable).set({ propertyId, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  });
}

/** Nodes referenced by a live grant that no longer exist — drift, reported not fixed. */
export async function findDanglingGrants(): Promise<string[]> {
  const grants = await db
    .select({ id: accessGrantsTable.id, nodeId: accessGrantsTable.nodeId })
    .from(accessGrantsTable)
    .where(isNull(accessGrantsTable.revokedAt));
  const referenced = grants.map((g) => g.nodeId).filter((n): n is string => !!n);
  if (!referenced.length) return [];
  const live = new Set(
    (await db.select({ id: orgNodesTable.id }).from(orgNodesTable).where(inArray(orgNodesTable.id, referenced))).map((r) => r.id),
  );
  return grants.filter((g) => g.nodeId && !live.has(g.nodeId)).map((g) => `${g.id} -> ${g.nodeId}`);
}
