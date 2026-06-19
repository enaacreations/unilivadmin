/**
 * Food Ordering & Kitchen Operations — shared service logic.
 *
 * Pure-ish helpers used by routes/food.ts: role/geo scoped access resolution,
 * order-number generation, weekly-menu resolution, per-resident quantity
 * computation, and unit conversion for the kitchen summary.
 */
import { db } from "@workspace/db";
import {
  propertiesTable,
  zonesTable,
  citiesTable,
  clustersTable,
  userScopesTable,
  dishesTable,
  foodMenuRotationTable,
  perResidentRuleTable,
  foodOrdersTable,
} from "@workspace/db";
import { and, eq, or, isNull, lte, gte, sql, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/auth.js";

/** Roles that always see every property regardless of scope rows. */
const ALWAYS_GLOBAL = new Set([
  "SUPER_ADMIN",
  "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT",
  "AUDIT_READONLY",
]);

/**
 * Oversight/kitchen roles that fall back to "all properties" when no explicit
 * scope rows are configured for them (prevents lockout before scopes are set).
 * Unit Lead is intentionally excluded — it must be scoped to a property.
 */
const BROAD_FALLBACK = new Set([
  "ZONAL_HEAD",
  "CITY_HEAD",
  "CLUSTER_MANAGER",
  "FNB_ZONAL_HEAD",
  "FNB_MANAGER",
  "FNB_SUPERVISOR",
]);

/**
 * Resolves the set of property IDs a user may access.
 * Returns `null` to mean "ALL properties" (no restriction).
 */
export async function resolveAccessiblePropertyIds(
  user: AuthUser,
): Promise<string[] | null> {
  if (ALWAYS_GLOBAL.has(user.role)) return null;

  const scopes = await db
    .select()
    .from(userScopesTable)
    .where(eq(userScopesTable.userId, user.id));

  if (scopes.some((s) => s.scopeLevel === "GLOBAL")) return null;

  const ids = new Set<string>();
  if (user.propertyId) ids.add(user.propertyId);

  // Collect scope target ids by level
  const zoneIds = scopes.filter((s) => s.scopeLevel === "ZONE" && s.zoneId).map((s) => s.zoneId!);
  const cityIds = scopes.filter((s) => s.scopeLevel === "CITY" && s.cityId).map((s) => s.cityId!);
  const clusterIds = scopes.filter((s) => s.scopeLevel === "CLUSTER" && s.clusterId).map((s) => s.clusterId!);
  scopes
    .filter((s) => s.scopeLevel === "PROPERTY" && s.propertyId)
    .forEach((s) => ids.add(s.propertyId!));

  // Expand zone → cities → clusters
  let allClusterIds = [...clusterIds];
  let allCityIds = [...cityIds];
  if (zoneIds.length) {
    const cities = await db
      .select({ id: citiesTable.id })
      .from(citiesTable)
      .where(inArray(citiesTable.zoneId, zoneIds));
    allCityIds.push(...cities.map((c) => c.id));
  }
  if (allCityIds.length) {
    const clusters = await db
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(inArray(clustersTable.cityId, allCityIds));
    allClusterIds.push(...clusters.map((c) => c.id));
  }
  if (allClusterIds.length) {
    const props = await db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(inArray(propertiesTable.clusterId, allClusterIds));
    props.forEach((p) => ids.add(p.id));
  }

  if (ids.size === 0) {
    // Only fall back to "all properties" when there are genuinely no scope rows
    // at all. If scope rows exist but resolved to an empty set (e.g. malformed
    // rows with a null geo id), the user must see nothing rather than everything.
    if (scopes.length === 0 && !user.propertyId && BROAD_FALLBACK.has(user.role)) return null;
    return []; // restricted/misconfigured role with nothing assigned → sees nothing
  }
  return [...ids];
}

/** Builds a drizzle condition restricting food_orders to accessible properties. */
export function scopeOrdersCondition(propertyIds: string[] | null) {
  if (propertyIds === null) return undefined;
  if (propertyIds.length === 0) return sql`false`; // matches nothing
  return inArray(foodOrdersTable.propertyId, propertyIds);
}

/** JS Date → ISO day of week (1 = Monday … 7 = Sunday). */
export function isoDayOfWeek(date: Date): number {
  const d = date.getDay(); // 0 = Sun … 6 = Sat
  return d === 0 ? 7 : d;
}

/** ISO week number (1–53) for rotation cycling. */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export interface ResolvedDish {
  dishId: string;
  dishName: string;
  component: string;
  unit: string;
  slotLabel: string | null;
  sortOrder: number;
}

/**
 * Resolves the menu (list of dishes) for a brand + meal on a given service
 * date, honoring the multi-week rotation and seasonal effective windows.
 */
export async function resolveMenu(
  brand: string,
  mealType: string,
  serviceDate: Date,
): Promise<ResolvedDish[]> {
  const dow = isoDayOfWeek(serviceDate);

  // Determine how many rotation weeks exist for this brand, then cycle.
  const weeksRows = await db
    .selectDistinct({ w: foodMenuRotationTable.rotationWeek })
    .from(foodMenuRotationTable)
    .where(and(eq(foodMenuRotationTable.brand, brand as any), eq(foodMenuRotationTable.isActive, true)));
  const weeks = weeksRows.map((r) => r.w).sort((a, b) => a - b);
  const numWeeks = weeks.length || 1;
  const rotationWeek = weeks.length
    ? weeks[(isoWeekNumber(serviceDate) - 1) % numWeeks]!
    : 1;

  const rows = await db
    .select({
      dishId: foodMenuRotationTable.dishId,
      slotLabel: foodMenuRotationTable.slotLabel,
      sortOrder: foodMenuRotationTable.sortOrder,
      dishName: dishesTable.name,
      component: dishesTable.component,
      unit: dishesTable.unit,
    })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .where(
      and(
        eq(foodMenuRotationTable.brand, brand as any),
        eq(foodMenuRotationTable.mealType, mealType as any),
        eq(foodMenuRotationTable.rotationWeek, rotationWeek),
        eq(foodMenuRotationTable.dayOfWeek, dow),
        eq(foodMenuRotationTable.isActive, true),
        or(isNull(foodMenuRotationTable.effectiveFrom), lte(foodMenuRotationTable.effectiveFrom, serviceDate)),
        or(isNull(foodMenuRotationTable.effectiveTo), gte(foodMenuRotationTable.effectiveTo, serviceDate)),
      ),
    )
    .orderBy(foodMenuRotationTable.sortOrder);

  return rows.map((r) => ({
    dishId: r.dishId,
    dishName: r.dishName,
    component: r.component,
    unit: r.unit,
    slotLabel: r.slotLabel,
    sortOrder: r.sortOrder,
  }));
}

export interface ComputedItem {
  dishId: string;
  unit: string;
  orderedQty: number;
}

/**
 * Computes per-dish ordered quantities for an order:
 *   orderedQty = mealCount × qtyPerResident (property-specific rule preferred,
 *   else the global default rule). Dishes without a rule are skipped.
 */
export async function computeOrderItems(
  brand: string,
  mealType: string,
  serviceDate: Date,
  mealCount: number,
  propertyId: string,
): Promise<ComputedItem[]> {
  const menu = await resolveMenu(brand, mealType, serviceDate);
  if (menu.length === 0) return [];

  const dishIds = menu.map((m) => m.dishId);
  const rules = await db
    .select()
    .from(perResidentRuleTable)
    .where(
      and(
        eq(perResidentRuleTable.brand, brand as any),
        eq(perResidentRuleTable.mealType, mealType as any),
        eq(perResidentRuleTable.isActive, true),
        inArray(perResidentRuleTable.dishId, dishIds),
        or(isNull(perResidentRuleTable.propertyId), eq(perResidentRuleTable.propertyId, propertyId)),
      ),
    );

  // Prefer property-specific rule over the global default per dish.
  const ruleByDish = new Map<string, { qty: number; unit: string; specific: boolean }>();
  for (const r of rules) {
    const prev = ruleByDish.get(r.dishId);
    const specific = r.propertyId === propertyId;
    if (!prev || (specific && !prev.specific)) {
      ruleByDish.set(r.dishId, { qty: Number(r.qtyPerResident), unit: r.unit, specific });
    }
  }

  const items: ComputedItem[] = [];
  for (const m of menu) {
    const rule = ruleByDish.get(m.dishId);
    if (!rule) continue;
    items.push({
      dishId: m.dishId,
      unit: rule.unit || m.unit,
      orderedQty: Math.round(mealCount * rule.qty * 1000) / 1000,
    });
  }
  return items;
}

/** Generates the next human Order ID for the current year, e.g. ORD-2026-000123. */
export async function nextOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(foodOrdersTable)
    .where(sql`${foodOrdersTable.orderNumber} like ${prefix + "%"}`);
  const seq = (row?.c ?? 0) + 1;
  return prefix + String(seq).padStart(6, "0");
}

/** Converts a base quantity to a friendlier display unit (g→kg, ml→litre). */
export function convertForDisplay(qty: number, unit: string): { qty: number; unit: string } {
  if (unit === "G" && qty >= 1000) return { qty: Math.round((qty / 1000) * 1000) / 1000, unit: "KG" };
  if (unit === "ML" && qty >= 1000) return { qty: Math.round((qty / 1000) * 1000) / 1000, unit: "LITRE" };
  return { qty, unit };
}

/** Resolves the full hierarchy label for a property (for display/grouping). */
export async function getPropertyHierarchy(propertyIds: string[]) {
  if (propertyIds.length === 0) return new Map<string, { cluster?: string; city?: string; zone?: string }>();
  const rows = await db
    .select({
      propertyId: propertiesTable.id,
      cluster: clustersTable.name,
      city: citiesTable.name,
      zone: zonesTable.name,
    })
    .from(propertiesTable)
    .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
    .leftJoin(citiesTable, eq(clustersTable.cityId, citiesTable.id))
    .leftJoin(zonesTable, eq(citiesTable.zoneId, zonesTable.id))
    .where(inArray(propertiesTable.id, propertyIds));
  const map = new Map<string, { cluster?: string; city?: string; zone?: string }>();
  for (const r of rows) {
    map.set(r.propertyId, {
      cluster: r.cluster ?? undefined,
      city: r.city ?? undefined,
      zone: r.zone ?? undefined,
    });
  }
  return map;
}
