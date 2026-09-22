/**
 * The unified access resolver (Access Controls PRD §5/§24/§26).
 *
 * One function answers "where may this user act", replacing two sibling systems
 * that answered it separately for food (user_scopes + food-service.ts) and audit
 * (audit_role_grants + audit-access.ts).
 *
 * ── The null / [] convention ────────────────────────────────────────────────
 * Both existing resolvers agree on this and it is NOT cosmetic:
 *
 *     null  =  unrestricted   (apply no filter at all)
 *     []    =  nothing        (apply a filter that matches no row)
 *
 * Conflating the two is precisely the bug class that removing food's
 * BROAD_FALLBACK fixed: "no grants" used to mean org-wide, so revoking a head's
 * last grant PROMOTED them from one zone to the whole network. Here, no grants
 * means [] — fail closed — and only an explicit org-wide grant or a super-admin
 * role yields null.
 *
 * Keeping this contract byte-identical to resolveAccessiblePropertyIds is what
 * lets the ~90 existing call sites cut over without a line change: the two
 * legacy resolvers become one-line adapters over this one.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Request } from "express";
import { overridesFor, type OverrideMap } from "./access/overrides.js";
import {
  db,
  accessGrantsTable,
  orgNodesTable,
  employeesTable,
  type AccessDataScope,
} from "@workspace/db";
import type { AuthUser } from "../middlewares/auth.js";
import { isSuperAdmin, forbidden, badRequest } from "./authz.js";
import { descendantIds } from "./org-tree.js";

export type DataScope = AccessDataScope;

export interface ResolvedGrant {
  roleKey: string;
  /** null = org-wide. A grant expanding to [] is DROPPED, never stored as []. */
  nodeIds: string[] | null;
  /**
   * The PROPERTY-typed subset of nodeIds, per grant.
   *
   * Carried here rather than derived by callers because the audit adapter needs
   * it PER GRANT (each audit grant has its own property set and its own audit
   * types), and computing it downstream would mean one query per grant.
   */
  propertyIds: string[] | null;
  dataScope: DataScope;
  qualifiers: string[];
  assignmentKind: string;
}

export interface EffectiveAccess {
  userId: string;
  role: string;
  roleKey: string;
  isGlobalAdmin: boolean;
  /** Union over every live grant. null = unrestricted, [] = nothing. */
  nodeIds: string[] | null;
  /** PROPERTY-typed subset — the drop-in for resolveAccessiblePropertyIds. */
  propertyIds: string[] | null;
  /** KITCHEN-typed subset — the drop-in for resolveAccessibleKitchenIds. */
  kitchenIds: string[] | null;
  grants: ResolvedGrant[];
  /** Widest scope held anywhere: ALL if any grant is ALL, else the narrowest. */
  dataScope: DataScope;
  /** The caller's employee row, when their login is linked to one. */
  employeeId: string | null;
  /** Direct + indirect reports. Lazy and memoized — only TEAM handlers pay. */
  teamEmployeeIds: () => Promise<string[]>;
  /**
   * This person's exceptions to their role's matrix ("MODULE:action" → effect).
   * Empty for almost everyone; decide() consults it before answering.
   *
   * OPTIONAL so that a hand-built EffectiveAccess (tests, the audit adapter's
   * fixtures) means "no exceptions" rather than failing to compile. resolveAccess
   * always populates it.
   */
  overrides?: OverrideMap;
}

/**
 * A grant whose roleKey names a MODULE role ("AUDIT.AUDITOR") confers access
 * inside that module only, and must not widen the general scope.
 *
 * Found the hard way against live data: an `AUDIT.VIEWER` org-wide grant was
 * making the FOOD scope unrestricted, handing a City Head the entire estate.
 * The general scope is built from `*` grants alone; module grants stay in
 * `grants[]` for their own adapter (see access/audit-adapter.ts) to read.
 */
export const GENERAL_ROLE_KEY = "*";
const isGeneralGrant = (g: { roleKey: string }) => g.roleKey === GENERAL_ROLE_KEY;

/** ALL is widest; SELF narrowest. A user holding several grants gets the widest. */
const SCOPE_WIDTH: Record<DataScope, number> = { ALL: 3, TEAM: 2, ASSIGNED: 1, SELF: 0 };

/** Live-grant predicate: not revoked, already effective, not yet expired. */
function liveGrantWindow(now: Date) {
  return and(
    isNull(accessGrantsTable.revokedAt),
    lte(accessGrantsTable.effectiveFrom, now),
    or(isNull(accessGrantsTable.expiresAt), gt(accessGrantsTable.expiresAt, now)),
  );
}

export async function resolveAccess(user: AuthUser, now = new Date()): Promise<EffectiveAccess> {
  const roleKey = (user as { roleKey?: string | null }).roleKey || user.role;
  const [employeeId, overrides] = await Promise.all([
    resolveEmployeeId(user.id),
    overridesFor(user.id),
  ]);
  const base = {
    userId: user.id,
    role: user.role,
    roleKey,
    employeeId,
    overrides,
    teamEmployeeIds: memoizedTeam(employeeId),
  };

  // Super-admin short-circuits with zero queries, exactly as resolveAuditAccess does.
  if (isSuperAdmin(user.role)) {
    return {
      ...base,
      isGlobalAdmin: true,
      nodeIds: null,
      propertyIds: null,
      kitchenIds: null,
      grants: [],
      dataScope: "ALL",
    };
  }

  // A grant reaches a user directly, or through the role they hold.
  const rows = await db
    .select()
    .from(accessGrantsTable)
    .where(
      and(
        or(
          and(eq(accessGrantsTable.subjectType, "USER"), eq(accessGrantsTable.subjectId, user.id)),
          and(eq(accessGrantsTable.subjectType, "ROLE"), eq(accessGrantsTable.subjectId, roleKey)),
        ),
        liveGrantWindow(now),
      ),
    );

  const grants: ResolvedGrant[] = [];
  let unrestricted = false;

  for (const g of rows) {
    if (g.nodeId === null) {
      // Only a GENERAL org-wide grant makes the general scope unrestricted.
      if (isGeneralGrant(g)) unrestricted = true;
      grants.push({
        roleKey: g.roleKey,
        nodeIds: null,
        propertyIds: null,
        dataScope: g.dataScope,
        qualifiers: g.qualifiers ?? [],
        assignmentKind: g.assignmentKind,
      });
      continue;
    }

    const ids = g.includeDescendants
      ? await descendantIds([g.nodeId], { followLinks: g.followLinks })
      : [g.nodeId];

    // A grant that resolves to nothing is dropped entirely rather than
    // contributing []; other grants still count. Matches audit-access.ts, and
    // it is why a stale grant on a deleted cluster cannot blank out a user.
    if (!ids.length) continue;

    grants.push({
      roleKey: g.roleKey,
      nodeIds: ids,
      propertyIds: [],
      dataScope: g.dataScope,
      qualifiers: g.qualifiers ?? [],
      assignmentKind: g.assignmentKind,
    });
  }

  // Home-property seed. food-service seeds from user.propertyId today, so this
  // keeps behaviour identical for a property-bound user whose grant row has not
  // been backfilled yet. Once every such user has a PRIMARY grant this is
  // redundant — harmless either way, and it prevents a lockout in between.
  const homeSeed = !unrestricted && user.propertyId ? [user.propertyId] : [];

  const nodeIds = unrestricted
    ? null
    : [...new Set([...grants.filter(isGeneralGrant).flatMap((g) => g.nodeIds ?? []), ...homeSeed])];

  // One query for every property id across every grant, then intersect — rather
  // than a narrowToType call per grant.
  const everyNodeId = [...new Set(grants.flatMap((g) => g.nodeIds ?? []))];
  const propertySet = new Set(await propertyIdsAmong(everyNodeId));
  for (const g of grants) {
    if (g.nodeIds === null) continue;
    g.propertyIds = g.nodeIds.filter((id) => propertySet.has(id));
  }

  const dataScope = pickWidestScope(grants.filter(isGeneralGrant));

  return {
    ...base,
    isGlobalAdmin: false,
    nodeIds,
    propertyIds: await narrowToType(nodeIds, "PROPERTY"),
    kitchenIds: await narrowToType(nodeIds, "KITCHEN"),
    grants,
    dataScope,
  };
}

function pickWidestScope(grants: ResolvedGrant[]): DataScope {
  if (!grants.length) return "ALL";
  return grants.reduce<DataScope>(
    (widest, g) => (SCOPE_WIDTH[g.dataScope] > SCOPE_WIDTH[widest] ? g.dataScope : widest),
    "SELF",
  );
}

/** The PROPERTY-typed ids among `nodeIds`. */
async function propertyIdsAmong(nodeIds: string[]): Promise<string[]> {
  if (!nodeIds.length) return [];
  const rows = await db
    .select({ id: orgNodesTable.id })
    .from(orgNodesTable)
    .where(and(inArray(orgNodesTable.id, nodeIds), eq(orgNodesTable.nodeType, "PROPERTY")));
  return rows.map((r) => r.id);
}

/** Keep only the ids that name a node of `nodeType`. null passes through. */
async function narrowToType(nodeIds: string[] | null, nodeType: "PROPERTY" | "KITCHEN"): Promise<string[] | null> {
  if (nodeIds === null) return null;
  if (!nodeIds.length) return [];
  const rows = await db
    .select({ id: orgNodesTable.id })
    .from(orgNodesTable)
    .where(and(inArray(orgNodesTable.id, nodeIds), eq(orgNodesTable.nodeType, nodeType)));
  return rows.map((r) => r.id);
}

async function resolveEmployeeId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(eq(employeesTable.userId, userId));
  return row?.id ?? null;
}

/**
 * Reports beneath an employee, walked breadth-first over employees.managerId.
 *
 * Iterative with a seen-set rather than recursive SQL: managerId has no cycle
 * constraint, and a manager loop entered by a recursive CTE does not terminate.
 */
function memoizedTeam(employeeId: string | null): () => Promise<string[]> {
  let cached: Promise<string[]> | null = null;
  return () => {
    if (cached) return cached;
    cached = (async () => {
      if (!employeeId) return [];
      const seen = new Set<string>([employeeId]);
      let frontier = [employeeId];
      while (frontier.length) {
        const rows = await db
          .select({ id: employeesTable.id })
          .from(employeesTable)
          .where(inArray(employeesTable.managerId, frontier));
        frontier = rows.map((r) => r.id).filter((id) => !seen.has(id));
        for (const id of frontier) seen.add(id);
      }
      return [...seen];
    })();
    return cached;
  };
}

/* ── Query helpers ────────────────────────────────────────────────────────── */

/**
 * Scope a query by node id. Byte-identical in behaviour to
 * food-service's scopeOrdersCondition, so it is a drop-in for it.
 */
export function scopeCondition(col: PgColumn, ids: string[] | null): SQL | undefined {
  if (ids === null) return undefined;
  if (!ids.length) return sql`false`;
  return inArray(col, ids);
}

/**
 * As scopeCondition, but also admits rows that name the caller.
 *
 * DELIBERATELY SEPARATE, and opt-in. The audit module ORs in
 * `eq(assigneeId, userId)` so an auditor always sees their own queue; folding
 * that into scopeCondition would silently widen EVERY list in the app to "rows
 * that mention me", which is a different and much larger promise.
 */
export function scopeConditionWithSelf(
  col: PgColumn,
  ids: string[] | null,
  selfCol: PgColumn,
  userId: string,
): SQL | undefined {
  if (ids === null) return undefined;
  const mine = eq(selfCol, userId);
  if (!ids.length) return mine;
  return or(inArray(col, ids), mine);
}

/**
 * 403 if `nodeId` lies outside the caller's scope; 400 if it is missing.
 *
 * The missing-target case is the direct fix for assertPropertyAccess(req, null)
 * having been a silent no-op — an unscoped write must not pass the check that
 * exists to catch it. Unrestricted callers pass either way: for them a null
 * target legitimately means "no particular node".
 */
export function assertNodeAccess(access: EffectiveAccess, nodeId: string | null | undefined): void {
  if (access.nodeIds === null) return;
  if (!nodeId) throw badRequest("A target scope is required", { code: "SCOPE_REQUIRED" });
  if (!access.nodeIds.includes(nodeId)) throw forbidden("Outside your access scope");
}

/* ── Request-scoped memoization ───────────────────────────────────────────── */

const ACCESS_KEY = Symbol.for("uniliv.access");

/**
 * resolveAccess once per request.
 *
 * Caches the PROMISE, not the value, so two concurrent branches of a
 * Promise.all share one resolution instead of racing two. Neither existing
 * resolver caches anything today, which costs 4-6 duplicated queries per handler
 * across ~90 call sites.
 */
export function getAccess(req: Request): Promise<EffectiveAccess> {
  const holder = req as unknown as Record<symbol, Promise<EffectiveAccess> | undefined>;
  const cached = holder[ACCESS_KEY];
  if (cached) return cached;
  const p = resolveAccess(req.user!);
  holder[ACCESS_KEY] = p;
  return p;
}
