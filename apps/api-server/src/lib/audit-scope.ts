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
  zonesTable,
  type AuditScopeRule,
} from "@workspace/db";

/** One materializable target: a property, optionally narrowed to a room. */
export interface ResolvedTarget {
  targetType: "PROPERTY" | "ROOM";
  propertyId: string;
  roomId: string | null;
}

export const SCOPE_LEVELS = ["ORG", "ZONE", "CITY", "CLUSTER", "PROPERTY", "ROOM"] as const;

/**
 * Caps on the narrowing map.
 *
 * It is re-read on EVERY materialization, forever, so an unbounded map is a
 * permanent cost paid by a schedule somebody created once. The numbers are
 * deliberately far above any real estate — they exist to stop a runaway
 * client, not to constrain an operator.
 */
const MAX_NARROWED_BRANCHES = 2000;
const MAX_IDS_PER_BRANCH = 5000;

/** Returns a human-readable problem, or null when the rule is usable. */
export function validateScope(scope: AuditScopeRule): string | null {
  if (!SCOPE_LEVELS.includes(scope.level)) return `Unknown scope level "${scope.level}"`;
  if (scope.level !== "ORG" && (!Array.isArray(scope.ids) || scope.ids.length === 0)) {
    return `Pick at least one ${scope.level.toLowerCase()} to scope this schedule`;
  }
  return validateNarrowing(scope.within);
}

/** The `within` half of `validateScope`, kept separate because it is all edge cases. */
function validateNarrowing(within: AuditScopeRule["within"]): string | null {
  if (within == null) return null;
  if (typeof within !== "object" || Array.isArray(within)) {
    return "Narrowing must be a map keyed by the id being narrowed";
  }

  const keys = Object.keys(within);
  if (keys.length > MAX_NARROWED_BRANCHES) {
    return `Too many narrowed branches (${keys.length}); the limit is ${MAX_NARROWED_BRANCHES}`;
  }

  for (const key of keys) {
    const ids = within[key];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      return `Narrowing for "${key}" must be a list of ids`;
    }
    // An empty list is not "narrowed to nothing" — it is a branch somebody left
    // checked with every child unchecked, which resolves to no targets at all
    // and looks like a broken schedule rather than a deliberate one.
    if (ids.length === 0) {
      return `Narrowing for "${key}" is empty — uncheck it instead of narrowing it to nothing`;
    }
    if (ids.length > MAX_IDS_PER_BRANCH) {
      return `Narrowing for "${key}" has ${ids.length} ids; the limit is ${MAX_IDS_PER_BRANCH}`;
    }
  }
  return null;
}

/**
 * One hop down the hierarchy, honouring narrowing.
 *
 * This is where "absent = live, present = frozen" is actually enforced. A
 * parent listed in `within` contributes exactly the ids written there; every
 * other parent is expanded by querying its children now. Validating `within`
 * without applying it here would be the worst of both: the UI would let
 * somebody exclude a site and the materializer would audit it anyway.
 */
async function descend(
  parentIds: string[],
  within: AuditScopeRule["within"],
  liveChildren: (ids: string[]) => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  if (parentIds.length === 0) return [];
  const frozen = parentIds.filter((id) => within?.[id]?.length);
  const live = parentIds.filter((id) => !within?.[id]?.length);

  const out = frozen.flatMap((id) => within![id]!);
  if (live.length) {
    const rows = await liveChildren(live);
    out.push(...rows.map((r) => r.id));
  }
  return [...new Set(out)];
}

/**
 * Every property id the scope covers. Walks the hierarchy downward; an empty
 * result is legitimate (an empty cluster) and callers must handle it.
 */
async function propertyIdsForScope(scope: AuditScopeRule): Promise<string[]> {
  const within = scope.within;

  if (scope.level === "PROPERTY") return scope.ids;
  if (scope.level === "ROOM") {
    const rows = await db
      .select({ propertyId: roomsTable.propertyId })
      .from(roomsTable)
      .where(inArray(roomsTable.id, scope.ids));
    return [...new Set(rows.map((r) => r.propertyId))];
  }

  const citiesOf = (zoneIds: string[]) =>
    db.select({ id: citiesTable.id })
      .from(citiesTable)
      .where(inArray(citiesTable.zoneId, zoneIds));
  const clustersOf = (cityIds: string[]) =>
    db.select({ id: clustersTable.id })
      .from(clustersTable)
      .where(inArray(clustersTable.cityId, cityIds));
  const propertiesOf = (clusterIds: string[]) =>
    db.select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(and(isNotNull(propertiesTable.clusterId), inArray(propertiesTable.clusterId, clusterIds)));

  // ORG with no narrowing is every property, in one query — walking the whole
  // tree to reach the same answer would be several round trips for nothing.
  if (scope.level === "ORG" && !within) {
    const rows = await db.select({ id: propertiesTable.id }).from(propertiesTable);
    return rows.map((r) => r.id);
  }

  // ORG WITH narrowing has to start at the top, because the narrowing may name
  // a zone — the level ORG otherwise skips straight past.
  let ids: string[];
  let level: (typeof SCOPE_LEVELS)[number];
  if (scope.level === "ORG") {
    ids = (await db.select({ id: zonesTable.id }).from(zonesTable)).map((z) => z.id);
    level = "ZONE";
  } else {
    ids = scope.ids;
    level = scope.level;
  }

  if (level === "ZONE") {
    ids = await descend(ids, within, (zoneIds) => citiesOf(zoneIds));
    level = "CITY";
  }
  if (level === "CITY") {
    ids = await descend(ids, within, (cityIds) => clustersOf(cityIds));
    level = "CLUSTER";
  }
  return descend(ids, within, (clusterIds) => propertiesOf(clusterIds));
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

  // Narrowing applies at the room hop too: "this property, only these rooms".
  // Fetched by id rather than trusted, so a room deleted or moved since the
  // rule was written cannot produce a target pointing at nothing.
  const narrowedProps = propertyIds.filter((id) => scope.within?.[id]?.length);
  const liveProps = propertyIds.filter((id) => !scope.within?.[id]?.length);

  const [pinned, live] = await Promise.all([
    narrowedProps.length
      ? db.select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
          .from(roomsTable)
          .where(inArray(roomsTable.id, narrowedProps.flatMap((id) => scope.within![id]!)))
      : Promise.resolve([]),
    liveProps.length
      ? db.select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
          .from(roomsTable)
          .where(inArray(roomsTable.propertyId, liveProps))
      : Promise.resolve([]),
  ]);

  return [...pinned, ...live].map((r) => ({
    targetType: "ROOM" as const, propertyId: r.propertyId, roomId: r.id,
  }));
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
  // ", narrowed" is not decoration. Two schedules can name the SAME anchor and
  // cover different estates — one live, one pinned — and without this they read
  // identically in the list, which is exactly when somebody picks the wrong one.
  const narrowed = scope.within && Object.keys(scope.within).length > 0 ? ", narrowed" : "";
  if (scope.level === "ORG") return `Whole estate${narrowed}`;
  const n = scope.ids.length;
  const noun = scope.level.toLowerCase();
  const plural = n === 1 ? noun : noun === "city" ? "cities" : `${noun}s`;
  return `${n} ${plural}${narrowed}`;
}
