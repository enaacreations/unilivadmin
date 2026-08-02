/**
 * Audit & Inspection — fine-grained access resolution (FRD-ACC-02/03/05, D-10).
 *
 * `authorize(module, perm)` stays the coarse endpoint gate; this module answers
 * the fine questions per request: which module roles the user holds, over which
 * audit types (UL/CM/CX) and which org subtree, right now. Grants live in
 * audit_role_grants (module role × audit types × org node × validity window);
 * SUPER_ADMIN / OPS_EXCELLENCE are implicitly global-all and need no rows.
 *
 * Every list/dashboard/report/export query composes scopeAuditsCondition() so
 * scoped-out data is absent everywhere INCLUDING counts (FRD-ACC-05 AC), with
 * food-service's fail-closed semantics (no grants ⇒ own assignments only).
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  auditRoleGrantsTable,
  auditsTable,
  propertiesTable,
  citiesTable,
  clustersTable,
} from "@workspace/db";
import type { AuthUser } from "../middlewares/auth.js";
import { isSuperAdmin } from "./authz.js";

export type AuditType = "UL" | "CM" | "CX";
export const AUDIT_TYPES: AuditType[] = ["UL", "CM", "CX"];

export type AuditModuleRole =
  | "ADMIN"
  | "SCHEDULER"
  | "AUDITOR"
  | "AUDITEE"
  | "REVIEWER"
  | "VIEWER";

export interface GrantScope {
  auditTypes: AuditType[];
  /** Property ids the grant covers; null = unrestricted (GLOBAL scope). */
  propertyIds: string[] | null;
}

export interface AuditAccess {
  /** SUPER_ADMIN / OPS_EXCELLENCE: everything, all types, all nodes. */
  isGlobalAdmin: boolean;
  userId: string;
  byRole: Map<AuditModuleRole, GrantScope[]>;
}

/**
 * Resolve the caller's effective audit access. Expired/revoked/not-yet-
 * effective grants are excluded by the time predicate, so grant expiry takes
 * effect immediately (FRD-ACC-02 AC); the daily sweep only writes the event.
 */
export async function resolveAuditAccess(user: AuthUser): Promise<AuditAccess> {
  if (isSuperAdmin(user.role)) {
    return { isGlobalAdmin: true, userId: user.id, byRole: new Map() };
  }

  const now = new Date();
  const grants = await db
    .select()
    .from(auditRoleGrantsTable)
    .where(
      and(
        eq(auditRoleGrantsTable.userId, user.id),
        isNull(auditRoleGrantsTable.revokedAt),
        lte(auditRoleGrantsTable.effectiveFrom, now),
        or(
          isNull(auditRoleGrantsTable.expiresAt),
          gt(auditRoleGrantsTable.expiresAt, now),
        ),
      ),
    );

  const byRole = new Map<AuditModuleRole, GrantScope[]>();
  for (const grant of grants) {
    const auditTypes = (grant.auditTypes ?? []).filter((t): t is AuditType =>
      (AUDIT_TYPES as string[]).includes(t),
    );
    if (auditTypes.length === 0) continue; // fail-closed on malformed rows

    const propertyIds = await expandGrantToPropertyIds(grant);
    if (propertyIds !== null && propertyIds.length === 0) continue; // resolves to nothing

    const role = grant.moduleRole as AuditModuleRole;
    const scopes = byRole.get(role) ?? [];
    scopes.push({ auditTypes, propertyIds });
    byRole.set(role, scopes);
  }

  return { isGlobalAdmin: false, userId: user.id, byRole };
}

/** Expand one grant's org node to concrete property ids (null = unrestricted). */
async function expandGrantToPropertyIds(grant: {
  scopeLevel: string;
  zoneId: string | null;
  cityId: string | null;
  clusterId: string | null;
  propertyId: string | null;
}): Promise<string[] | null> {
  switch (grant.scopeLevel) {
    case "GLOBAL":
      return null;
    case "PROPERTY":
      return grant.propertyId ? [grant.propertyId] : [];
    case "CLUSTER": {
      if (!grant.clusterId) return [];
      return propertiesInClusters([grant.clusterId]);
    }
    case "CITY": {
      if (!grant.cityId) return [];
      const clusters = await db
        .select({ id: clustersTable.id })
        .from(clustersTable)
        .where(eq(clustersTable.cityId, grant.cityId));
      return propertiesInClusters(clusters.map((c) => c.id));
    }
    case "ZONE": {
      if (!grant.zoneId) return [];
      const cities = await db
        .select({ id: citiesTable.id })
        .from(citiesTable)
        .where(eq(citiesTable.zoneId, grant.zoneId));
      if (cities.length === 0) return [];
      const clusters = await db
        .select({ id: clustersTable.id })
        .from(clustersTable)
        .where(inArray(clustersTable.cityId, cities.map((c) => c.id)));
      return propertiesInClusters(clusters.map((c) => c.id));
    }
    default:
      return [];
  }
}

async function propertiesInClusters(clusterIds: string[]): Promise<string[]> {
  if (clusterIds.length === 0) return [];
  const props = await db
    .select({ id: propertiesTable.id })
    .from(propertiesTable)
    .where(inArray(propertiesTable.clusterId, clusterIds));
  return props.map((p) => p.id);
}

/** All scopes across the given roles (default: every role — i.e. view access). */
export function scopesFor(
  access: AuditAccess,
  roles?: AuditModuleRole[],
): GrantScope[] {
  const out: GrantScope[] = [];
  for (const [role, scopes] of access.byRole) {
    if (!roles || roles.includes(role)) out.push(...scopes);
  }
  return out;
}

function scopeCovers(
  scope: GrantScope,
  auditType: AuditType,
  propertyId: string,
): boolean {
  return (
    scope.auditTypes.includes(auditType) &&
    (scope.propertyIds === null || scope.propertyIds.includes(propertyId))
  );
}

/** May the caller conduct (create/execute) audits of this type at this property? */
export function canConduct(
  access: AuditAccess,
  auditType: AuditType,
  propertyId: string,
): boolean {
  if (access.isGlobalAdmin) return true;
  return scopesFor(access, ["AUDITOR", "ADMIN"]).some((s) =>
    scopeCovers(s, auditType, propertyId),
  );
}

/** May the caller view audits of this type at this property (any module role)? */
export function canView(
  access: AuditAccess,
  auditType: AuditType,
  propertyId: string,
): boolean {
  if (access.isGlobalAdmin) return true;
  return scopesFor(access).some((s) => scopeCovers(s, auditType, propertyId));
}

/** Audit types the caller can CONDUCT (drives the create-audit type picker). */
export function conductableAuditTypes(access: AuditAccess): AuditType[] {
  if (access.isGlobalAdmin) return [...AUDIT_TYPES];
  const set = new Set<AuditType>();
  for (const scope of scopesFor(access, ["AUDITOR", "ADMIN"])) {
    scope.auditTypes.forEach((t) => set.add(t));
  }
  return AUDIT_TYPES.filter((t) => set.has(t));
}

/**
 * Property ids where the caller may conduct the given audit type; null means
 * unrestricted (a GLOBAL grant or global admin). Empty array means none.
 */
export function conductablePropertyIds(
  access: AuditAccess,
  auditType: AuditType,
): string[] | null {
  if (access.isGlobalAdmin) return null;
  const ids = new Set<string>();
  for (const scope of scopesFor(access, ["AUDITOR", "ADMIN"])) {
    if (!scope.auditTypes.includes(auditType)) continue;
    if (scope.propertyIds === null) return null; // GLOBAL for this type
    scope.propertyIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

/** Audit types the caller can see at all (drives type pickers/dashboard tabs). */
export function visibleAuditTypes(access: AuditAccess): AuditType[] {
  if (access.isGlobalAdmin) return [...AUDIT_TYPES];
  const set = new Set<AuditType>();
  // Dashboard tabs / create-audit type pickers reflect the "see the program"
  // roles only. AUDITEE is a findings-ownership grant (a Unit Lead owns NCs
  // from any audit type on their property) and must not widen the dashboard.
  for (const scope of scopesFor(access, ["AUDITOR", "ADMIN", "VIEWER", "REVIEWER", "SCHEDULER"])) {
    scope.auditTypes.forEach((t) => set.add(t));
  }
  return AUDIT_TYPES.filter((t) => set.has(t));
}

/**
 * Drizzle WHERE condition restricting `audits` rows to what the caller may see:
 * the union of every grant's (audit types × property set), plus the caller's
 * own assignments. Global admin ⇒ undefined (no filtering); no access at all
 * still yields own-assignment visibility (auditors always see their queue).
 */
export function scopeAuditsCondition(access: AuditAccess) {
  if (access.isGlobalAdmin) return undefined;

  const parts = [eq(auditsTable.assigneeId, access.userId)];
  for (const scope of scopesFor(access)) {
    const typeCond = inArray(auditsTable.auditType, scope.auditTypes);
    parts.push(
      scope.propertyIds === null
        ? typeCond
        : and(typeCond, inArray(auditsTable.propertyId, scope.propertyIds))!,
    );
  }
  return or(...parts) ?? sql`false`;
}
