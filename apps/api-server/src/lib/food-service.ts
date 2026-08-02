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
  citiesTable,
  kitchensTable,
  kitchenPincodesTable,
  foodBrandsTable,
  userScopesTable,
  dishesTable,
  foodMenuRotationTable,
  perResidentRuleTable,
  foodOrdersTable,
  foodMealWindowsTable,
  menuCompositionRuleTable,
  menuCompositionSlotTable,
  dishIngredientsTable,
  ingredientsTable,
  systemConfigTable,
} from "@workspace/db";
import { and, eq, or, isNull, lte, gte, sql, inArray, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/auth.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Admin-tunable global config (system_config). SUPER_ADMIN configures these; the
 * food module reads them at runtime with safe fallbacks if a row is missing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Default order cut-off time (HH:MM, 24h) when no brand/property cut-off is set. */
export const FOOD_DEFAULT_CUTOFF_KEY = "food_default_cutoff";
/** Minutes after delivery during which waste can still be recorded. */
export const FOOD_WASTE_WINDOW_KEY = "food_waste_edit_window_minutes";

/** Read a JSON scalar from system_config by key; returns `fallback` if missing/malformed. */
export async function getSystemConfigValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const [row] = await db.select().from(systemConfigTable).where(eq(systemConfigTable.key, key)).limit(1);
    if (!row || row.value === null || row.value === undefined) return fallback;
    return row.value as T;
  } catch {
    return fallback;
  }
}

/** Waste-edit window in milliseconds (default 60 min). Replaces the old hardcoded 3600000. */
export async function getWasteEditWindowMs(): Promise<number> {
  const minutes = Number(await getSystemConfigValue<number>(FOOD_WASTE_WINDOW_KEY, 60));
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60000;
}

/** Global default cut-off time "HH:MM" (default "09:00"), used by resolveCutoff as last resort. */
export async function getDefaultCutoffTime(): Promise<string> {
  const v = await getSystemConfigValue<string>(FOOD_DEFAULT_CUTOFF_KEY, "09:00");
  return typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v) ? v : "09:00";
}

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

  // Collect scope target ids by level. Hierarchy: City → Kitchen → Property.
  const cityIds = scopes.filter((s) => s.scopeLevel === "CITY" && s.cityId).map((s) => s.cityId!);
  const kitchenIds = scopes.filter((s) => s.scopeLevel === "KITCHEN" && s.kitchenId).map((s) => s.kitchenId!);
  scopes
    .filter((s) => s.scopeLevel === "PROPERTY" && s.propertyId)
    .forEach((s) => ids.add(s.propertyId!));

  // City → its kitchens → their properties.
  const allKitchenIds = [...kitchenIds];
  if (cityIds.length) {
    const kitchens = await db
      .select({ id: kitchensTable.id })
      .from(kitchensTable)
      .where(inArray(kitchensTable.cityId, cityIds));
    allKitchenIds.push(...kitchens.map((k) => k.id));
  }
  if (allKitchenIds.length) {
    const props = await db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(inArray(propertiesTable.kitchenId, allKitchenIds));
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
  preparations: string[];
  unit: string;
  slotLabel: string | null;
  sortOrder: number;
}

/** Resolves a property's food config (brand code + serving kitchen). */
export async function getPropertyFoodConfig(
  propertyId: string,
): Promise<{ brand: string | null; kitchenId: string | null }> {
  const [p] = await db
    .select({ brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  return { brand: p?.brand ?? null, kitchenId: p?.kitchenId ?? null };
}

/**
 * Resolve the kitchen that serves a pincode via the kitchen_pincodes master map.
 * Pincode is globally unique so at most one ACTIVE kitchen maps to it; returns
 * null when no active mapping exists. Server-side source of truth for property
 * kitchen derivation (never trust a client-supplied kitchenId).
 */
export async function resolveKitchenForPincode(
  pincode: string,
): Promise<{ id: string; name: string; code: string } | null> {
  const pc = String(pincode ?? "").trim();
  if (!/^\d{6}$/.test(pc)) return null;
  const [row] = await db
    .select({ id: kitchensTable.id, name: kitchensTable.name, code: kitchensTable.code })
    .from(kitchenPincodesTable)
    .innerJoin(kitchensTable, eq(kitchenPincodesTable.kitchenId, kitchensTable.id))
    .where(and(
      eq(kitchenPincodesTable.pincode, pc),
      eq(kitchenPincodesTable.isActive, true),
      eq(kitchensTable.isActive, true),
    ));
  return row ?? null;
}

/** True if `brand` is a non-empty code of an ACTIVE brand in the food_brands master. */
export async function isActiveBrand(brand: string | null | undefined): Promise<boolean> {
  const code = String(brand ?? "").trim();
  if (!code) return false;
  const [row] = await db
    .select({ id: foodBrandsTable.id })
    .from(foodBrandsTable)
    .where(and(eq(foodBrandsTable.code, code), eq(foodBrandsTable.isActive, true)));
  return !!row;
}

/**
 * Resolves the menu (list of dishes) for a kitchen + brand + meal on a given
 * service date, honoring the multi-week rotation and seasonal windows. Menus are
 * defined per kitchen; returns [] when no kitchen is given.
 */
export async function resolveMenu(
  kitchenId: string | null,
  brand: string,
  mealType: string,
  serviceDate: Date,
): Promise<ResolvedDish[]> {
  if (!kitchenId) return [];
  const dow = isoDayOfWeek(serviceDate);

  // Determine how many rotation weeks exist for this kitchen+brand, then cycle.
  const weeksRows = await db
    .selectDistinct({ w: foodMenuRotationTable.rotationWeek })
    .from(foodMenuRotationTable)
    .where(and(
      eq(foodMenuRotationTable.kitchenId, kitchenId),
      eq(foodMenuRotationTable.brand, brand as any),
      eq(foodMenuRotationTable.isActive, true),
    ));
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
      preparations: dishesTable.preparations,
      unit: dishesTable.unit,
    })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .where(
      and(
        eq(foodMenuRotationTable.kitchenId, kitchenId),
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
    preparations: r.preparations ?? [],
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

/** Resolves each dish's effective per-resident rule (global per brand + meal + dish). */
export async function resolveRulesByDish(
  brand: string,
  mealType: string,
  dishIds: string[],
): Promise<Map<string, { qty: number; unit: string }>> {
  const out = new Map<string, { qty: number; unit: string }>();
  if (dishIds.length === 0) return out;
  const rules = await db
    .select()
    .from(perResidentRuleTable)
    .where(and(
      eq(perResidentRuleTable.brand, brand as any),
      eq(perResidentRuleTable.mealType, mealType as any),
      eq(perResidentRuleTable.isActive, true),
      inArray(perResidentRuleTable.dishId, dishIds),
    ));
  for (const r of rules) {
    if (!out.has(r.dishId)) out.set(r.dishId, { qty: Number(r.qtyPerResident), unit: r.unit });
  }
  return out;
}

/**
 * Default per-dish ordered quantities (quantity-only path / back-compat):
 *   orderedQty = mealCount × qtyPerResident. Dishes without a rule are skipped.
 */
export async function computeOrderItems(
  kitchenId: string | null,
  brand: string,
  mealType: string,
  serviceDate: Date,
  mealCount: number,
): Promise<ComputedItem[]> {
  const menu = await resolveMenu(kitchenId, brand, mealType, serviceDate);
  if (menu.length === 0) return [];
  const rules = await resolveRulesByDish(brand, mealType, menu.map((m) => m.dishId));
  const items: ComputedItem[] = [];
  for (const m of menu) {
    const rule = rules.get(m.dishId);
    if (!rule) continue;
    items.push({
      dishId: m.dishId,
      unit: rule.unit || m.unit,
      orderedQty: Math.round(mealCount * rule.qty * 1000) / 1000,
    });
  }
  return items;
}

export interface OrderPreviewItem {
  dishId: string;
  dishName: string;
  component: string;
  preparations: string[];
  unit: string;
  slotLabel: string | null;
  sortOrder: number;
  qtyPerResident: number | null;
  defaultPersons: number;
  defaultOrderedQty: number;
}

/**
 * The resolved menu for a meal with each dish's effective per-resident rule and
 * a default ordered qty = defaultPersons × ruleQty. Drives the editable
 * per-item ordering grid (persons + quantity per item).
 */
export async function resolveOrderPreview(
  kitchenId: string | null,
  brand: string,
  mealType: string,
  serviceDate: Date,
  defaultPersons: number,
): Promise<OrderPreviewItem[]> {
  const menu = await resolveMenu(kitchenId, brand, mealType, serviceDate);
  if (menu.length === 0) return [];
  const rules = await resolveRulesByDish(brand, mealType, menu.map((m) => m.dishId));
  return menu.map((m) => {
    const rule = rules.get(m.dishId);
    const qpr = rule ? rule.qty : null;
    return {
      dishId: m.dishId,
      dishName: m.dishName,
      component: m.component,
      preparations: m.preparations,
      unit: rule?.unit || m.unit,
      slotLabel: m.slotLabel,
      sortOrder: m.sortOrder,
      qtyPerResident: qpr,
      defaultPersons,
      defaultOrderedQty: qpr != null ? Math.round(defaultPersons * qpr * 1000) / 1000 : 0,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Menu-composition rule engine
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CompositionSlot {
  id: string; slotLabel: string | null; component: string | null; preparation: string | null;
  minCount: number; maxCount: number | null; sortOrder: number;
}
export interface CompositionRule {
  id: string; brand: string; mealType: string; kitchenId: string | null; name: string | null;
  slots: CompositionSlot[];
}

/** Resolves the composition rule for a (brand, meal) — kitchen-specific overrides brand default. */
export async function resolveCompositionRule(
  brand: string, mealType: string, kitchenId: string | null,
): Promise<CompositionRule | null> {
  const rules = await db.select().from(menuCompositionRuleTable).where(and(
    eq(menuCompositionRuleTable.brand, brand as any),
    eq(menuCompositionRuleTable.mealType, mealType as any),
    eq(menuCompositionRuleTable.isActive, true),
    kitchenId ? or(isNull(menuCompositionRuleTable.kitchenId), eq(menuCompositionRuleTable.kitchenId, kitchenId)) : isNull(menuCompositionRuleTable.kitchenId),
  ));
  if (!rules.length) return null;
  const rule = rules.sort((a, b) => (a.kitchenId === kitchenId ? -1 : 1))[0]!;
  const slots = await db.select().from(menuCompositionSlotTable)
    .where(eq(menuCompositionSlotTable.ruleId, rule.id)).orderBy(menuCompositionSlotTable.sortOrder);
  return {
    id: rule.id, brand: rule.brand, mealType: rule.mealType, kitchenId: rule.kitchenId, name: rule.name,
    slots: slots.map((s) => ({ id: s.id, slotLabel: s.slotLabel, component: s.component, preparation: s.preparation, minCount: s.minCount, maxCount: s.maxCount, sortOrder: s.sortOrder })),
  };
}

export interface SlotValidation {
  slotId: string; slotLabel: string | null; component: string | null; preparation: string | null;
  minCount: number; maxCount: number | null; count: number; matchedDishIds: string[];
  status: "OK" | "MISSING" | "UNDER" | "OVER";
}
export interface CompositionValidation {
  ruleId: string | null; ruleName: string | null;
  slots: SlotValidation[]; unmatchedDishIds: string[]; isComplete: boolean;
}

const dishMatchesSlot = (d: { component: string; preparations: string[] }, slot: CompositionSlot): boolean => {
  const compOk = !slot.component || d.component === slot.component;
  const prepOk = !slot.preparation || (d.preparations ?? []).includes(slot.preparation);
  return compOk && prepOk;
};

/** Validates a set of chosen dishes against a composition rule (greedy match, each dish used once). */
export function validateMenuAgainstRule(
  rule: CompositionRule | null,
  dishes: { dishId: string; component: string; preparations: string[] }[],
): CompositionValidation {
  if (!rule) return { ruleId: null, ruleName: null, slots: [], unmatchedDishIds: dishes.map((d) => d.dishId), isComplete: true };
  const consumed = new Set<string>();
  const slots: SlotValidation[] = rule.slots.map((slot) => {
    const matched: string[] = [];
    for (const d of dishes) {
      if (consumed.has(d.dishId)) continue;
      if (dishMatchesSlot(d, slot)) { matched.push(d.dishId); consumed.add(d.dishId); }
    }
    const count = matched.length;
    const status: SlotValidation["status"] =
      count === 0 && slot.minCount > 0 ? "MISSING"
      : count < slot.minCount ? "UNDER"
      : slot.maxCount != null && count > slot.maxCount ? "OVER"
      : "OK";
    return { slotId: slot.id, slotLabel: slot.slotLabel, component: slot.component, preparation: slot.preparation, minCount: slot.minCount, maxCount: slot.maxCount, count, matchedDishIds: matched, status };
  });
  const unmatchedDishIds = dishes.filter((d) => !consumed.has(d.dishId)).map((d) => d.dishId);
  const isComplete = slots.every((s) => s.status === "OK");
  return { ruleId: rule.id, ruleName: rule.name, slots, unmatchedDishIds, isComplete };
}

/** Loads chosen dishes' component + preparations for validation. */
export async function loadDishesForValidation(dishIds: string[]): Promise<{ dishId: string; component: string; preparations: string[] }[]> {
  if (!dishIds.length) return [];
  const rows = await db.select({ id: dishesTable.id, component: dishesTable.component, preparations: dishesTable.preparations })
    .from(dishesTable).where(inArray(dishesTable.id, dishIds));
  return rows.map((r) => ({ dishId: r.id, component: r.component, preparations: r.preparations ?? [] }));
}

/** Candidate dishes to fill a slot (brand-tagged, matching component/prep), newest first. */
export async function suggestDishesForSlot(
  brand: string, slot: CompositionSlot, excludeDishIds: string[], limit = 10,
): Promise<{ id: string; name: string; component: string }[]> {
  const conds = [
    eq(dishesTable.isActive, true),
    sql`${dishesTable.brands} @> ARRAY[${brand}]::text[]`,
  ] as any[];
  if (slot.component) conds.push(eq(dishesTable.component, slot.component as any));
  if (slot.preparation) conds.push(sql`${dishesTable.preparations} @> ARRAY[${slot.preparation}]::text[]`);
  if (excludeDishIds.length) conds.push(sql`${dishesTable.id} <> ALL(ARRAY[${sql.join(excludeDishIds.map((d) => sql`${d}`), sql`, `)}]::text[])`);
  const rows = await db.select({ id: dishesTable.id, name: dishesTable.name, component: dishesTable.component })
    .from(dishesTable).where(and(...conds)).orderBy(desc(dishesTable.createdAt)).limit(limit);
  return rows;
}

/** Auto-fills a menu slot to satisfy the rule: picks minCount newest dishes per composition slot. */
export async function autoFillMenu(
  brand: string, mealType: string, kitchenId: string | null,
): Promise<{ dishId: string; slotLabel: string | null; sortOrder: number }[]> {
  const rule = await resolveCompositionRule(brand, mealType, kitchenId);
  if (!rule) return [];
  const chosen: { dishId: string; slotLabel: string | null; sortOrder: number }[] = [];
  const used = new Set<string>();
  for (const slot of rule.slots) {
    const need = Math.max(1, slot.minCount);
    const candidates = await suggestDishesForSlot(brand, slot, [...used], need);
    for (const c of candidates.slice(0, need)) {
      if (used.has(c.id)) continue;
      used.add(c.id);
      chosen.push({ dishId: c.id, slotLabel: slot.slotLabel, sortOrder: slot.sortOrder });
    }
  }
  return chosen;
}

export interface SharedIngredient { ingredientId: string; name: string; dishIds: string[] }

/** A single machine-readable rule violation the frontend can hard-block on. */
export interface CompositionViolation {
  type: "SLOT_MISSING" | "SLOT_UNDER" | "SLOT_OVER" | "SHARED_INGREDIENT";
  message: string;
  dishIds: string[];
}
export interface CompositionVerdict { ok: boolean; violations: CompositionViolation[] }

/**
 * Folds a slot-validation + shared-ingredient result into a flat, machine-readable
 * verdict ({ ok, violations }) the frontend can HARD-BLOCK on. `ok` is true only
 * when every slot is satisfied (no MISSING/UNDER/OVER) and no two dishes share an
 * ingredient. A null rule yields no slot violations (nothing to enforce).
 */
export function buildCompositionVerdict(
  validation: CompositionValidation,
  sharedIngredients: SharedIngredient[],
): CompositionVerdict {
  const violations: CompositionViolation[] = [];
  for (const s of validation.slots) {
    const label = s.slotLabel || s.component || "slot";
    if (s.status === "MISSING") {
      violations.push({ type: "SLOT_MISSING", message: `Missing a dish for "${label}" (needs ${s.minCount}).`, dishIds: [] });
    } else if (s.status === "UNDER") {
      violations.push({ type: "SLOT_UNDER", message: `"${label}" needs at least ${s.minCount} dish(es) but has ${s.count}.`, dishIds: s.matchedDishIds });
    } else if (s.status === "OVER") {
      violations.push({ type: "SLOT_OVER", message: `"${label}" allows at most ${s.maxCount} dish(es) but has ${s.count}.`, dishIds: s.matchedDishIds });
    }
  }
  for (const si of sharedIngredients) {
    violations.push({ type: "SHARED_INGREDIENT", message: `Two or more dishes share the ingredient "${si.name}".`, dishIds: si.dishIds });
  }
  return { ok: violations.length === 0, violations };
}

/** Ingredients used by 2+ of the given dishes (drives the menu shared-ingredient warning). */
export async function detectSharedIngredients(dishIds: string[]): Promise<SharedIngredient[]> {
  if (dishIds.length < 2) return [];
  const rows = await db.select({
    ingredientId: dishIngredientsTable.ingredientId, name: ingredientsTable.name, dishId: dishIngredientsTable.dishId,
  }).from(dishIngredientsTable)
    .leftJoin(ingredientsTable, eq(dishIngredientsTable.ingredientId, ingredientsTable.id))
    .where(inArray(dishIngredientsTable.dishId, dishIds));
  const byIng = new Map<string, { name: string; dishIds: Set<string> }>();
  for (const r of rows) {
    const e = byIng.get(r.ingredientId) ?? { name: r.name ?? r.ingredientId, dishIds: new Set<string>() };
    e.dishIds.add(r.dishId);
    byIng.set(r.ingredientId, e);
  }
  return [...byIng.entries()]
    .filter(([, v]) => v.dishIds.size >= 2)
    .map(([ingredientId, v]) => ({ ingredientId, name: v.name, dishIds: [...v.dishIds] }));
}

/** Generates the next human Order ID for the current year, e.g. ORD-2026-000123.
 *  Derived from max(orderNumber), NOT count(*): counting breaks the moment any
 *  order row is deleted (count+1 collides with a surviving higher number). The
 *  zero-padded fixed width makes lexicographic max equal numeric max. */
export async function nextOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;
  const [row] = await db
    .select({ m: sql<string | null>`max(${foodOrdersTable.orderNumber})` })
    .from(foodOrdersTable)
    .where(sql`${foodOrdersTable.orderNumber} like ${prefix + "%"}`);
  const last = row?.m ? parseInt(row.m.slice(prefix.length), 10) : 0;
  const seq = (Number.isFinite(last) ? last : 0) + 1;
  return prefix + String(seq).padStart(6, "0");
}

/**
 * Resolves the expected delivery time for an order = serviceDate@serviceTime +
 * leadTime, using the property-specific meal window if present else the global
 * default. Returns null when no window is configured. Feeds delay analytics.
 */
export async function resolveExpectedDeliveryAt(
  brand: string,
  mealType: string,
  serviceDate: Date,
  propertyId: string,
): Promise<Date | null> {
  const rows = await db
    .select()
    .from(foodMealWindowsTable)
    .where(
      and(
        eq(foodMealWindowsTable.brand, brand as never),
        eq(foodMealWindowsTable.mealType, mealType as never),
        eq(foodMealWindowsTable.isActive, true),
        or(isNull(foodMealWindowsTable.propertyId), eq(foodMealWindowsTable.propertyId, propertyId)),
      ),
    );
  const w = rows.sort((a, b) => (a.propertyId === propertyId ? -1 : 1))[0];
  if (!w?.serviceTime) return null;
  const [h, m] = w.serviceTime.split(":").map(Number);
  if (h == null || isNaN(h)) return null;
  const d = new Date(serviceDate);
  d.setHours(h, m || 0, 0, 0);
  return new Date(d.getTime() + (w.leadTimeMinutes ?? 0) * 60000);
}

/** Converts a base quantity to a friendlier display unit (g→kg, ml→litre). */
export function convertForDisplay(qty: number, unit: string): { qty: number; unit: string } {
  if (unit === "G" && qty >= 1000) return { qty: Math.round((qty / 1000) * 1000) / 1000, unit: "KG" };
  if (unit === "ML" && qty >= 1000) return { qty: Math.round((qty / 1000) * 1000) / 1000, unit: "LITRE" };
  return { qty, unit };
}

/** Resolves the kitchen + city label for a property (for display/grouping). */
export async function getPropertyHierarchy(propertyIds: string[]) {
  type Info = { kitchen?: string; city?: string };
  if (propertyIds.length === 0) return new Map<string, Info>();
  const rows = await db
    .select({
      propertyId: propertiesTable.id,
      kitchen: kitchensTable.name,
      city: citiesTable.name,
    })
    .from(propertiesTable)
    .leftJoin(kitchensTable, eq(propertiesTable.kitchenId, kitchensTable.id))
    .leftJoin(citiesTable, eq(kitchensTable.cityId, citiesTable.id))
    .where(inArray(propertiesTable.id, propertyIds));
  const map = new Map<string, Info>();
  for (const r of rows) {
    map.set(r.propertyId, { kitchen: r.kitchen ?? undefined, city: r.city ?? undefined });
  }
  return map;
}
