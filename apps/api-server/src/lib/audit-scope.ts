/**
 * Audit & Inspection — hierarchical scope resolution (FRD-SCH-01).
 *
 * A schedule stores WHERE it applies as a rule against the org hierarchy
 * (Zone → City → Cluster → Property → Room), not as a frozen list of targets.
 * The materializer resolves it on every occurrence, so the estate changing is
 * picked up automatically instead of silently drifting out of date.
 *
 * Legacy schedules carry no rule and keep using their `audit_schedule_targets`
 * rows — see `resolveScheduleTargets`.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  auditScheduleTargetsTable,
  citiesTable,
  clustersTable,
  propertiesTable,
  roomsTable,
  type AuditScopeRule,
} from "@workspace/db";

/** One materializable target: a property, optionally narrowed to a room. */
export interface ResolvedTarget {
  targetType: "PROPERTY" | "ROOM";
  propertyId: string;
  roomId: string | null;
}

export const SCOPE_LEVELS = ["ORG", "ZONE", "CITY", "CLUSTER", "PROPERTY", "ROOM"] as const;

/** Returns a human-readable problem, or null when the rule is usable. */
export function validateScope(scope: AuditScopeRule): string | null {
  if (!SCOPE_LEVELS.includes(scope.level)) return `Unknown scope level "${scope.level}"`;
  if (scope.level === "ORG") return null;
  if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
    return `Pick at least one ${scope.level.toLowerCase()} to scope this schedule`;
  }
  return null;
}

/**
 * Every property id the scope covers. Walks the hierarchy downward; an empty
 * result is legitimate (an empty cluster) and callers must handle it.
 */
async function propertyIdsForScope(scope: AuditScopeRule): Promise<string[]> {
  if (scope.level === "ORG") {
    const rows = await db.select({ id: propertiesTable.id }).from(propertiesTable);
    return rows.map((r) => r.id);
  }
  if (scope.level === "PROPERTY") return scope.ids;
  if (scope.level === "ROOM") {
    const rows = await db
      .select({ propertyId: roomsTable.propertyId })
      .from(roomsTable)
      .where(inArray(roomsTable.id, scope.ids));
    return [...new Set(rows.map((r) => r.propertyId))];
  }

  // ZONE / CITY / CLUSTER all resolve to a cluster set, then to properties.
  let clusterIds: string[];
  if (scope.level === "CLUSTER") {
    clusterIds = scope.ids;
  } else {
    const cityIds =
      scope.level === "CITY"
        ? scope.ids
        : (
            await db
              .select({ id: citiesTable.id })
              .from(citiesTable)
              .where(inArray(citiesTable.zoneId, scope.ids))
          ).map((c) => c.id);
    if (cityIds.length === 0) return [];
    clusterIds = (
      await db
        .select({ id: clustersTable.id })
        .from(clustersTable)
        .where(inArray(clustersTable.cityId, cityIds))
    ).map((c) => c.id);
  }
  if (clusterIds.length === 0) return [];

  const rows = await db
    .select({ id: propertiesTable.id })
    .from(propertiesTable)
    .where(and(isNotNull(propertiesTable.clusterId), inArray(propertiesTable.clusterId, clusterIds)));
  return rows.map((r) => r.id);
}

/**
 * Resolve a scope rule into materializable targets for a template.
 *
 * `targetType` comes from the template and decides the grain: PROPERTY yields
 * one target per property; ROOM expands each property into its rooms, so a
 * room added to a property later is audited without touching the schedule.
 */
export async function resolveScope(
  scope: AuditScopeRule,
  targetType: "PROPERTY" | "ROOM",
): Promise<ResolvedTarget[]> {
  // A ROOM-level scope already names the rooms — never widen it back out to
  // every room of their properties.
  if (targetType === "ROOM" && scope.level === "ROOM") {
    const rows = await db
      .select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
      .from(roomsTable)
      .where(inArray(roomsTable.id, scope.ids));
    return rows.map((r) => ({ targetType: "ROOM" as const, propertyId: r.propertyId, roomId: r.id }));
  }

  const propertyIds = await propertyIdsForScope(scope);
  if (propertyIds.length === 0) return [];

  if (targetType === "PROPERTY") {
    return propertyIds.map((id) => ({ targetType: "PROPERTY" as const, propertyId: id, roomId: null }));
  }

  const rooms = await db
    .select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
    .from(roomsTable)
    .where(inArray(roomsTable.propertyId, propertyIds));
  return rooms.map((r) => ({ targetType: "ROOM" as const, propertyId: r.propertyId, roomId: r.id }));
}

/**
 * The targets a schedule should generate for right now.
 *
 * Rule-based schedules re-resolve live; pre-scope schedules fall back to their
 * stored target rows so their behaviour is untouched.
 */
export async function resolveScheduleTargets(schedule: {
  id: string;
  scopeJson?: AuditScopeRule | null;
}, targetType: "PROPERTY" | "ROOM"): Promise<ResolvedTarget[]> {
  if (schedule.scopeJson) return resolveScope(schedule.scopeJson, targetType);

  const rows = await db
    .select()
    .from(auditScheduleTargetsTable)
    .where(eq(auditScheduleTargetsTable.scheduleId, schedule.id));
  return rows
    .filter((t) => t.propertyId)
    .map((t) => ({
      targetType: t.targetType as "PROPERTY" | "ROOM",
      propertyId: t.propertyId!,
      roomId: t.roomId,
    }));
}

/** Short human description of a scope, e.g. "3 clusters" or "Whole estate". */
export function describeScope(scope: AuditScopeRule): string {
  if (scope.level === "ORG") return "Whole estate";
  const n = scope.ids.length;
  const noun = scope.level.toLowerCase();
  const plural = n === 1 ? noun : noun === "city" ? "cities" : `${noun}s`;
  return `${n} ${plural}`;
}
