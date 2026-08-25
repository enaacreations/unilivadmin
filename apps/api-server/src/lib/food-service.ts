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
  clustersTable,
  kitchensTable,
  kitchenPincodesTable,
  foodBrandsTable,
  userScopesTable,
  dishesTable,
  foodMenuRotationTable,
  perResidentRuleTable,
  foodOrdersTable,
  foodMealWindowsTable,
  usersTable,
  menuCompositionRuleTable,
  menuCompositionSlotTable,
  menuRuleOverrideTable,
  dishIngredientsTable,
  ingredientsTable,
  systemConfigTable,
} from "@workspace/db";
import { and, eq, or, isNull, lte, gte, sql, inArray, notInArray, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/auth.js";
import { httpError } from "./authz.js";
import { atIst, istDayYmd, istParts } from "./tz.js";
import { logger } from "./logger.js";

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

/* ── Menu rule switches (Service Set → Menu Rules) ──────────────────────────
 * Both default to ON so an environment with no rows behaves exactly as it did
 * when the rules were hard-coded — turning a rule off has to be a deliberate,
 * recorded act, never the consequence of a missing config row.
 */

/** Block saving a plate whose dishes share an ingredient. */
export const FOOD_RULE_INGREDIENT_CLASH_KEY = "food_rule_ingredient_clash";
/** Flag (never block) a dish already used for the same meal within N days. */
export const FOOD_RULE_REPEAT_FLAG_KEY = "food_rule_repeat_flag";
/** How many days apart two servings must be before they stop counting as a repeat. */
export const FOOD_RULE_REPEAT_DAYS_KEY = "food_rule_repeat_days";
/** The window the rule shipped with, used whenever the row is absent. */
export const REPEAT_WINDOW_DEFAULT_DAYS = 3;
/**
 * Widest window worth offering: the gap between two days is measured the short
 * way round a 28-day cycle, so 14 already reaches every other day in it — the
 * rule becomes "never repeat anywhere in the rotation", and higher numbers
 * cannot mean anything more.
 */
export const REPEAT_WINDOW_MAX_DAYS = 14;

/**
 * Boolean from system_config. `getSystemConfigValue` does an unchecked cast, and
 * older rows in this table are sometimes a wrapped object rather than a bare
 * scalar (see configToNumber in routes/settings.ts), so coerce rather than trust:
 * true / "true" / 1 / { anything: true } all read as true.
 */
export async function getSystemConfigBool(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSystemConfigValue<unknown>(key, fallback);
  const v = raw !== null && typeof raw === "object" ? Object.values(raw as object)[0] : raw;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

/** Is the shared-ingredient block switched on? Defaults ON. */
export async function isIngredientClashRuleOn(): Promise<boolean> {
  return getSystemConfigBool(FOOD_RULE_INGREDIENT_CLASH_KEY, true);
}

/** Is the repeat hint switched on? Defaults ON. */
export async function isRepeatFlagRuleOn(): Promise<boolean> {
  return getSystemConfigBool(FOOD_RULE_REPEAT_FLAG_KEY, true);
}

/**
 * Number from system_config, tolerating the same wrapped-object rows
 * getSystemConfigBool does. A value that is not a usable number falls back
 * rather than propagating NaN into a comparison.
 */
export async function getSystemConfigNumber(key: string, fallback: number): Promise<number> {
  const raw = await getSystemConfigValue<unknown>(key, fallback);
  const v = raw !== null && typeof raw === "object" ? Object.values(raw as object)[0] : raw;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** How many days apart two servings of a dish stop counting as a repeat. */
export async function getRepeatWindowDays(): Promise<number> {
  const n = await getSystemConfigNumber(FOOD_RULE_REPEAT_DAYS_KEY, REPEAT_WINDOW_DEFAULT_DAYS);
  // Clamp on READ as well as on write: a row set by an older client, a migration
  // or by hand must never widen the window past what the cycle can express.
  return Math.min(Math.max(Math.round(n), 1), REPEAT_WINDOW_MAX_DAYS);
}

/** Same clamp as getRepeatWindowDays, applied to an override row's value. */
const clampRepeatDays = (n: number) =>
  Math.min(Math.max(Math.round(n), 1), REPEAT_WINDOW_MAX_DAYS);

export interface MenuRuleSettings {
  ingredientClashBlocks: boolean;
  flagRepeats: boolean;
  repeatWithinDays: number;
}

/**
 * The three Menu Rules switches as they apply to one scope. The org-wide
 * system_config values are the base; a kitchen override layers on top, and a
 * property override on top of that. Each column is independently nullable, so
 * a property that only pins the repeat window still inherits the clash switch
 * from whatever is above it.
 *
 * Called with no scope this is exactly the old global behaviour, which is why
 * an install with no override rows needs no migration.
 */
export async function resolveMenuRuleSettings(
  kitchenId: string | null = null,
  propertyId: string | null = null,
): Promise<MenuRuleSettings> {
  const settings: MenuRuleSettings = {
    ingredientClashBlocks: await isIngredientClashRuleOn(),
    flagRepeats: await isRepeatFlagRuleOn(),
    repeatWithinDays: await getRepeatWindowDays(),
  };
  if (!kitchenId && !propertyId) return settings;

  const scopeConds = [];
  if (propertyId) scopeConds.push(eq(menuRuleOverrideTable.propertyId, propertyId));
  if (kitchenId) scopeConds.push(eq(menuRuleOverrideTable.kitchenId, kitchenId));
  const rows = await db.select().from(menuRuleOverrideTable)
    .where(scopeConds.length === 1 ? scopeConds[0] : or(...scopeConds));

  // Widest first so the narrowest scope is applied last and wins.
  const ordered = [...rows].sort(
    (a, b) => scopeRank(a, kitchenId, propertyId) - scopeRank(b, kitchenId, propertyId),
  );
  for (const r of ordered) {
    if (r.ingredientClashBlocks !== null) settings.ingredientClashBlocks = r.ingredientClashBlocks;
    if (r.flagRepeats !== null) settings.flagRepeats = r.flagRepeats;
    if (r.repeatWithinDays !== null) settings.repeatWithinDays = clampRepeatDays(r.repeatWithinDays);
  }
  return settings;
}

/** Roles that always see every property regardless of scope rows. */
const ALWAYS_GLOBAL = new Set([
  "SUPER_ADMIN",
  "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT",
  "AUDIT_READONLY",
]);

/**
 * Geo grants are strictly ADDITIVE: a scope row can only ever widen what a user
 * sees. The invariant that follows — and the one this file now enforces — is
 * that revoking a grant can never escalate. Any role outside ALWAYS_GLOBAL with
 * no scope rows and no home property sees nothing, whatever its title.
 *
 * This replaces a BROAD_FALLBACK set (ZONAL_HEAD, CITY_HEAD, CLUSTER_MANAGER,
 * FNB_ZONAL_HEAD, FNB_SUPERVISOR) that fell open to every property when the user
 * had no scope rows, on a "prevent lockout before scopes are configured"
 * rationale. It inverted the control: revoking a head's last grant promoted them
 * from one zone to the whole network. Soft revocation (user_scopes.isActive) now
 * tells "never configured" apart from "deliberately revoked", but neither may
 * grant anything — missing scope surfaces the misconfiguration instead of hiding
 * it behind org-wide access.
 *
 * Two real geo spines reach a property and BOTH are authoritative:
 *   • F&B spine — zone → city → kitchen → properties.kitchenId
 *   • org spine — zone → city → cluster → properties.clusterId
 * Properties carry the two columns independently and they disagree in live data,
 * so every grant expands down both spines and the results are unioned: a city
 * head who owns a city owns every property in it, however that property happens
 * to be wired. (audit-access.ts walks the org spine alone; the food module needs
 * the kitchen spine too, because a kitchen serves properties outside its cluster.)
 */

type ScopeRow = typeof userScopesTable.$inferSelect;

/**
 * A user's live grants. Revocation is a soft flag (user_scopes.isActive), so the
 * filter belongs here, in the one place both resolvers read grants from — a
 * revoked row that still resolves is the same escalation as falling open.
 */
async function activeScopesFor(userId: string): Promise<ScopeRow[]> {
  return db
    .select()
    .from(userScopesTable)
    .where(and(eq(userScopesTable.userId, userId), eq(userScopesTable.isActive, true)));
}

/** The geo-id column each scope level narrows on. */
const scopeTargets = (
  scopes: ScopeRow[],
  level: string,
  col: "zoneId" | "cityId" | "kitchenId" | "clusterId" | "propertyId",
): string[] => scopes.filter((s) => s.scopeLevel === level && s[col]).map((s) => s[col]!);

/**
 * ZONE fans out to its cities; from there both spines run in parallel.
 *
 * Deactivated nodes are not traversed, here or in the cluster/kitchen walks
 * below. POST /scopes refuses to MINT a grant on an inactive zone/city/cluster/
 * kitchen (food.ts scopeTargetIsLive), so resolve-time has to apply the same
 * rule or a node retired from the org spine keeps handing out access that no
 * admin can see, re-create, or reason about. A DIRECT grant is governed by its
 * own row instead — revoking it flips user_scopes.isActive (activeScopesFor).
 */
async function expandZonesToCities(scopes: ScopeRow[]): Promise<Set<string>> {
  const cityIds = new Set(scopeTargets(scopes, "CITY", "cityId"));
  const zoneIds = scopeTargets(scopes, "ZONE", "zoneId");
  if (zoneIds.length) {
    const rows = await db
      .select({ id: citiesTable.id })
      .from(citiesTable)
      .where(and(inArray(citiesTable.zoneId, zoneIds), eq(citiesTable.isActive, true)));
    rows.forEach((c) => cityIds.add(c.id));
  }
  return cityIds;
}

/**
 * Resolves the set of property IDs a user may access.
 * Returns `null` to mean "ALL properties" (no restriction).
 */
export async function resolveAccessiblePropertyIds(
  user: AuthUser,
): Promise<string[] | null> {
  if (ALWAYS_GLOBAL.has(user.role)) return null;

  const scopes = await activeScopesFor(user.id);

  if (scopes.some((s) => s.scopeLevel === "GLOBAL")) return null;

  const ids = new Set<string>();
  if (user.propertyId) ids.add(user.propertyId);
  scopeTargets(scopes, "PROPERTY", "propertyId").forEach((p) => ids.add(p));

  const cityIds = await expandZonesToCities(scopes);

  // Org spine: (zone →) city → clusters → properties.clusterId.
  const clusterIds = new Set(scopeTargets(scopes, "CLUSTER", "clusterId"));
  if (cityIds.size) {
    const rows = await db
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(and(inArray(clustersTable.cityId, [...cityIds]), eq(clustersTable.isActive, true)));
    rows.forEach((c) => clusterIds.add(c.id));
  }
  if (clusterIds.size) {
    const props = await db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(inArray(propertiesTable.clusterId, [...clusterIds]));
    props.forEach((p) => ids.add(p.id));
  }

  // F&B spine: (zone →) city → kitchens → properties.kitchenId.
  const kitchenIds = new Set(scopeTargets(scopes, "KITCHEN", "kitchenId"));
  if (cityIds.size) {
    const kitchens = await db
      .select({ id: kitchensTable.id })
      .from(kitchensTable)
      .where(and(inArray(kitchensTable.cityId, [...cityIds]), eq(kitchensTable.isActive, true)));
    kitchens.forEach((k) => kitchenIds.add(k.id));
  }
  if (kitchenIds.size) {
    const props = await db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(inArray(propertiesTable.kitchenId, [...kitchenIds]));
    props.forEach((p) => ids.add(p.id));
  }

  // Scope rows that resolve to nothing (a null geo id, a cluster with no
  // properties tagged to it) must still mean "sees nothing", never "sees
  // everything" — the fail-closed control that keeps a misconfigured grant from
  // silently widening into org-wide access.
  return ids.size === 0 ? [] : [...ids];
}

/** Builds a drizzle condition restricting food_orders to accessible properties. */
export function scopeOrdersCondition(propertyIds: string[] | null) {
  if (propertyIds === null) return undefined;
  if (propertyIds.length === 0) return sql`false`; // matches nothing
  return inArray(foodOrdersTable.propertyId, propertyIds);
}

/**
 * Resolves the set of kitchen IDs a user may act on. Returns `null` for "ALL
 * kitchens" (no restriction) — the same null-means-unrestricted convention as
 * resolveAccessiblePropertyIds.
 *
 * This is the kitchen-side twin of that helper, and the two must agree: the
 * F&B manager model is one login per kitchen, so the manager who sees a
 * kitchen's orders is exactly the manager who may edit its menu.
 *
 * An explicit KITCHEN scope row counts on its own, without going through
 * properties — a newly opened kitchen has no properties tagged to it yet, and
 * its manager still has to be able to build the first menu.
 *
 * It walks the same two spines from the same grants as its property-side twin
 * (see the block comment above ALWAYS_GLOBAL's neighbours): a kitchen carries
 * BOTH a cityId and a clusterId and either may be null, so a ZONE or CITY grant
 * has to reach kitchens through both columns. Resolving one level here that the
 * property resolver ignored is what let a CLUSTER-scoped F&B manager rewrite the
 * menu of every kitchen in a cluster while seeing none of the resulting orders.
 */
export async function resolveAccessibleKitchenIds(
  user: AuthUser,
): Promise<string[] | null> {
  if (ALWAYS_GLOBAL.has(user.role)) return null;

  const scopes = await activeScopesFor(user.id);

  if (scopes.some((s) => s.scopeLevel === "GLOBAL")) return null;

  const ids = new Set<string>();
  scopeTargets(scopes, "KITCHEN", "kitchenId").forEach((k) => ids.add(k));

  const cityIds = await expandZonesToCities(scopes);
  if (cityIds.size) {
    const rows = await db
      .select({ id: kitchensTable.id })
      .from(kitchensTable)
      .where(and(inArray(kitchensTable.cityId, [...cityIds]), eq(kitchensTable.isActive, true)));
    rows.forEach((k) => ids.add(k.id));
  }

  // Org spine: (zone →) city → clusters → kitchens.clusterId.
  const clusterIds = new Set(scopeTargets(scopes, "CLUSTER", "clusterId"));
  if (cityIds.size) {
    const rows = await db
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(and(inArray(clustersTable.cityId, [...cityIds]), eq(clustersTable.isActive, true)));
    rows.forEach((c) => clusterIds.add(c.id));
  }
  if (clusterIds.size) {
    const rows = await db
      .select({ id: kitchensTable.id })
      .from(kitchensTable)
      .where(and(inArray(kitchensTable.clusterId, [...clusterIds]), eq(kitchensTable.isActive, true)));
    rows.forEach((k) => ids.add(k.id));
  }

  // Property-bound users (Unit Lead, Warden) reach the kitchen that serves them.
  const propIds = scopeTargets(scopes, "PROPERTY", "propertyId");
  if (user.propertyId) propIds.push(user.propertyId);
  if (propIds.length) {
    const rows = await db
      .select({ kitchenId: propertiesTable.kitchenId })
      .from(propertiesTable)
      .where(inArray(propertiesTable.id, propIds));
    rows.forEach((p) => { if (p.kitchenId) ids.add(p.kitchenId); });
  }

  // Same fail-closed rule as resolveAccessiblePropertyIds: grants that resolve
  // to nothing mean nothing. Never fall open, or revoking a grant escalates.
  return ids.size === 0 ? [] : [...ids];
}

/**
 * The kitchen-side users to tell when an order they are going to cook changes
 * after it was placed.
 *
 * This is a deliberately NARROW inverse of resolveAccessibleKitchenIds: only
 * holders of a live KITCHEN grant on this exact kitchen, and only in the roles
 * that actually work a kitchen queue. The F&B model is one login per kitchen
 * (see the comment on resolveAccessibleKitchenIds), so that grant is precisely
 * "the people who run this kitchen".
 *
 * The wider spines (CITY / ZONE / CLUSTER grants, which DO confer access) are
 * intentionally not walked here. Access answers "may you see it"; this answers
 * "should you be interrupted about it", and paging a zonal head about a unit
 * lead correcting a headcount is noise, not oversight — the edit is on the order
 * timeline for anyone who looks.
 *
 * Returns `[]` when nobody matches; callers must treat that as "notify nobody",
 * never as "notify everybody".
 */
export async function resolveKitchenNotifyUserIds(
  kitchenId: string | null | undefined,
): Promise<string[]> {
  if (!kitchenId) return [];
  const rows = await db
    .select({ id: usersTable.id })
    .from(userScopesTable)
    .innerJoin(usersTable, eq(usersTable.id, userScopesTable.userId))
    .where(and(
      eq(userScopesTable.scopeLevel, "KITCHEN"),
      eq(userScopesTable.kitchenId, kitchenId),
      eq(userScopesTable.isActive, true),
      eq(usersTable.isActive, true),
      inArray(usersTable.role, KITCHEN_SIDE_ROLES as unknown as never[]),
    ));
  return [...new Set(rows.map((r) => r.id))];
}

/** Roles that run a kitchen queue — the audience for kitchen-side alerts. */
const KITCHEN_SIDE_ROLES = ["FNB_MANAGER", "FNB_SUPERVISOR", "KITCHEN_MANAGER"] as const;

/**
 * Throws 403 unless the caller may act on `kitchenId`. A no-op for unrestricted
 * callers.
 *
 * A null/absent `kitchenId` means a brand-level row that applies to EVERY
 * kitchen, so it is refused for anyone who is kitchen-restricted — otherwise a
 * single kitchen's manager could write a menu the whole network serves.
 */
export async function assertKitchenAccess(
  user: AuthUser,
  kitchenId: string | null | undefined,
): Promise<void> {
  const allowed = await resolveAccessibleKitchenIds(user);
  if (allowed === null) return;
  if (!kitchenId) {
    throw httpError(403, "Pick one of your kitchens — you cannot edit the brand-wide menu");
  }
  if (!allowed.includes(kitchenId)) {
    throw httpError(403, "Outside your kitchen scope");
  }
}

/* ── Menu-rotation scoping: READING a brand-wide row is not WRITING one ─────
 *
 * food_menu_rotation.kitchenId is nullable, and a NULL means "brand-wide
 * template — applies to no kitchen until it is copied down to one" (see
 * scripts/seed-food-extra.ts, which materialises the per-kitchen rows).
 * resolveMenu only ever matches an exact kitchenId, so a NULL row can never be
 * served to a resident; it is reference data the rotation board shows.
 *
 * The two directions therefore have OPPOSITE requirements, and a single helper
 * cannot satisfy both:
 *   read  — a kitchen-scoped user must SEE the brand-wide templates their own
 *           menu is derived from. A SQL IN-list never matches NULL, so the
 *           strict filter blanked the rotation board entirely for them: on the
 *           dev DB all 385 rotation rows are brand-wide, and a KITCHEN-scoped
 *           FNB_MANAGER (11 of the 12 seeded) resolved 0 of them.
 *   write — a kitchen-scoped user must NOT touch a brand-wide row, or one
 *           kitchen's manager rewrites the menu the whole network serves. This
 *           is the same invariant assertKitchenAccess above enforces on the
 *           single-row path, and it is why the strict IN-list must survive on
 *           every mutating query.
 */

/**
 * Restricts a menu-rotation READ to the caller's kitchens PLUS the brand-wide
 * templates (kitchenId IS NULL), which belong to no kitchen and are visible to
 * everyone who may see any menu at all. `null` kitchenIds = unrestricted.
 */
export function scopeRotationReadCondition(kitchenIds: string[] | null) {
  if (kitchenIds === null) return undefined;
  // Fail closed: an empty scope set is "sees nothing", never "sees the
  // templates" — same rule the resolvers above apply to an unresolvable grant.
  if (kitchenIds.length === 0) return sql`false`; // matches nothing
  return or(
    isNull(foodMenuRotationTable.kitchenId),
    inArray(foodMenuRotationTable.kitchenId, kitchenIds),
  );
}

/**
 * Restricts a menu-rotation WRITE (update/delete/prune) to rows the caller owns
 * outright. Brand-wide rows (kitchenId IS NULL) are excluded on purpose — the
 * IN-list not matching NULL is the guard, not an accident. `null` = unrestricted.
 */
export function scopeRotationWriteCondition(kitchenIds: string[] | null) {
  if (kitchenIds === null) return undefined;
  if (kitchenIds.length === 0) return sql`false`; // matches nothing
  return inArray(foodMenuRotationTable.kitchenId, kitchenIds);
}

/* ── Retiring a dish is a network-wide write, not a catalogue edit ───────────
 *
 * `dishes` is an ORG-WIDE master with no kitchen column, and resolveMenu joins
 * it on isActive (see activeDish there), so flipping one dish to isActive=false
 * empties that slot on EVERY kitchen's plate at once — including kitchens the
 * caller has no scope over. PUT /dishes/:id carries isActive in its update
 * whitelist and DELETE /dishes/:id is the same soft-deactivate, so both had to
 * be guarded or the guard is decoration.
 *
 * The rule is deliberately NARROW, because a kitchen-scoped F&B manager is
 * allowed to CREATE a dish (the B3 decision) and it would be incoherent to let
 * them mint one they can never correct:
 *   • editing a dish's ATTRIBUTES (name, component, unit, brands, photo,
 *     preparations, qty lock) stays open to a scoped manager;
 *   • RETIRING one is refused when a rotation row they do not own still serves
 *     it — another kitchen's row, or a brand-wide (kitchenId IS NULL) template,
 *     which is exactly the row set scopeRotationWriteCondition above already
 *     keeps them out of.
 * A dish nothing outside their kitchens serves is still theirs to retire.
 */

export interface DishRetirementBlockers {
  dishName: string;
  /** Live rotation cells outside the caller's kitchens still serving this dish. */
  rotationCount: number;
  /** Display names of the OTHER kitchens that would lose it off their menu. */
  kitchenNames: string[];
  /** A brand-wide template (kitchenId IS NULL) — i.e. every kitchen — serves it. */
  brandWide: boolean;
}

/**
 * The rotation cells that still serve `dishId` and that a caller restricted to
 * `kitchenIds` does not own. `null` kitchenIds = unrestricted caller, who owns
 * every rotation row; returns null when nothing outside their kitchens is left.
 *
 * Rotation is the reference that matters: sides are stored as ordinary rotation
 * rows (schema/food.ts parentRotationId) so they are covered here too, while
 * per-resident rules and dish_side_options only ever narrow what an already
 * rotating dish produces.
 */
export async function findDishRotationOutsideKitchens(
  dishId: string,
  kitchenIds: string[] | null,
): Promise<DishRetirementBlockers | null> {
  if (kitchenIds === null) return null;
  // An empty scope set owns no rotation row at all, so EVERY row is outside it.
  const outside = kitchenIds.length
    ? or(
        isNull(foodMenuRotationTable.kitchenId),
        notInArray(foodMenuRotationTable.kitchenId, kitchenIds),
      )
    : sql`true`;
  const rows = await db
    .select({
      kitchenId: foodMenuRotationTable.kitchenId,
      kitchenName: kitchensTable.name,
      dishName: dishesTable.name,
    })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .leftJoin(kitchensTable, eq(foodMenuRotationTable.kitchenId, kitchensTable.id))
    .where(and(
      eq(foodMenuRotationTable.dishId, dishId),
      eq(foodMenuRotationTable.isActive, true),
      // Only cells that can still resolve matter — an expired seasonal window has
      // nothing left to lose. Same rule findPortionRuleUsage applies below.
      or(isNull(foodMenuRotationTable.effectiveTo), gte(foodMenuRotationTable.effectiveTo, new Date())),
      outside,
    ));
  if (!rows.length) return null;
  return {
    dishName: rows[0]!.dishName,
    rotationCount: rows.length,
    kitchenNames: [...new Set(rows.map((r) => r.kitchenName).filter((n): n is string => !!n))],
    brandWide: rows.some((r) => r.kitchenId === null),
  };
}

/**
 * Throws 403 unless the caller may withdraw `dishId` from the catalogue. A no-op
 * for unrestricted callers and for a dish no out-of-scope rotation still serves.
 * The message names the kitchens that would lose the dish — a refusal that does
 * not say whose menu is in the way is one the manager cannot act on.
 */
export async function assertMayRetireDish(user: AuthUser, dishId: string): Promise<void> {
  const blockers = await findDishRotationOutsideKitchens(
    dishId,
    await resolveAccessibleKitchenIds(user),
  );
  if (!blockers) return;
  const shown = blockers.kitchenNames.slice(0, 4);
  const rest = blockers.kitchenNames.length - shown.length;
  const affected = [
    ...shown,
    ...(rest > 0 ? [`${rest} more kitchen${rest === 1 ? "" : "s"}`] : []),
    ...(blockers.brandWide ? ["the brand-wide menu every kitchen is built from"] : []),
  ].join(", ");
  const slots = `${blockers.rotationCount} menu rotation slot${blockers.rotationCount === 1 ? "" : "s"}`;
  // The affected kitchens belong in the TOP-LEVEL message, not only in details:
  // api-fetch.ts surfaces `error` as the thrown Error and most toasts show that
  // alone, and a refusal that does not say whose menu is in the way is one the
  // manager cannot act on.
  throw httpError(
    403,
    `"${blockers.dishName}" is still on ${slots} outside your kitchens — ${affected}`,
    `Dishes are an organisation-wide master with no kitchen of their own, so retiring one takes it off the plate everywhere. Take it off those rotations first, or ask an org-wide admin to retire the dish.`,
  );
}

/**
 * The UTC-midnight instant of an instant's IST calendar day — the anchor every
 * calendar helper below counts from.
 *
 * A serviceDate reaching this module is an IST day-start instant (18:30 UTC on
 * the PREVIOUS calendar day, see ymdToIstDayStart), so reading it with the host
 * getters made the menu resolve to the wrong weekday on any box whose TZ was not
 * Asia/Kolkata. Which plate is served must not depend on an env var.
 */
function istCalendarDayUtc(date: Date): Date {
  const p = istParts(date);
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

/** Instant → ISO day of week of its IST date (1 = Monday … 7 = Sunday). */
export function isoDayOfWeek(date: Date): number {
  const d = istCalendarDayUtc(date).getUTCDay(); // 0 = Sun … 6 = Sat
  return d === 0 ? 7 : d;
}

/*
 * isoWeekNumber() lived here and is deliberately gone. It resets to 1 every
 * January, so using it as the rotation cycle's phase made the menu jump an
 * arbitrary number of weeks on 1 January (L11). Nothing may reintroduce it for
 * that purpose — istWeekIndex below is the counter, and leaving a plausible-
 * looking ISO-week helper exported next to it was an invitation to reach for the
 * wrong one. Reach for date-fns if a display-only ISO week number is ever needed.
 */

/**
 * Continuous Monday-week index of an instant's IST date, counting from Monday
 * 1970-01-05 (= 0). Never resets, which is the whole point: it is the counter a
 * rotation cycle's phase is measured with.
 */
export function istWeekIndex(date: Date): number {
  const days = Math.floor(istCalendarDayUtc(date).getTime() / 86400000);
  return Math.floor((days - 4) / 7); // 1970-01-01 was a Thursday; day 4 is the Monday
}

export interface ResolvedDish {
  dishId: string;
  dishName: string;
  component: string;
  preparations: string[];
  unit: string;
  slotLabel: string | null;
  sortOrder: number;
  /** Set when this dish is a side served with another dish on the same plate
   *  (rotation rows tagged parentRotationId) — consumers group them as one item. */
  parentDishId: string | null;
  /** Dish-level quantity pin — see dishesTable.isQtyLocked. Carried here so the
   *  ordering UI and the placement guard both read it off the resolved menu. */
  isQtyLocked: boolean;
  lockedPersons: number | null;
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
): Promise<{ id: string; name: string; code: string; city: string | null } | null> {
  const pc = String(pincode ?? "").trim();
  if (!/^\d{6}$/.test(pc)) return null;
  const [row] = await db
    // `city` is the kitchen's own free-text city, NOT cities.name via cityId:
    // the two disagree in live data (KIT-DEL-CEN is "New Delhi" under a "Delhi"
    // city row), and callers compare it against properties.city, which is the
    // same free-text vocabulary.
    .select({
      id: kitchensTable.id, name: kitchensTable.name,
      code: kitchensTable.code, city: kitchensTable.city,
    })
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
 * True if `brand` names ANY row in the food_brands master — active **or** retired.
 *
 * The READ twin of isActiveBrand, and the distinction is load-bearing:
 * DELETE /brands/:id is a soft delete, so a retired brand still owns every order
 * it ever took. isActiveBrand is the WRITE gate (a new order/share/config row has
 * to name a brand people can still order under); this is the FILTER gate, which
 * must keep letting a retired brand's history be reported and exported.
 *
 * Neither is a hardcoded list — the master is the only authority on what a brand
 * is, so adding a brand needs no code change here.
 */
export async function isKnownBrand(brand: string | null | undefined): Promise<boolean> {
  const code = String(brand ?? "").trim();
  if (!code) return false;
  const [row] = await db
    .select({ id: foodBrandsTable.id })
    .from(foodBrandsTable)
    .where(eq(foodBrandsTable.code, code));
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

  // The rotation cycles over the weeks that actually have a plate for THIS
  // (meal, day) inside its seasonal window — not every week that exists for the
  // kitchen. Counting weeks kitchen-wide meant one plate saved into week 2 gave
  // every meal a 2-week cycle, so on alternate ISO weeks the meals still only
  // filled in week 1 resolved to an empty week and the unit lead had nothing to
  // order. Scoping the cycle this way makes an empty resolve impossible: every
  // week in `weeks` is one this query already proved has rows.
  const cellWhere = and(
    eq(foodMenuRotationTable.kitchenId, kitchenId),
    eq(foodMenuRotationTable.brand, brand as any),
    eq(foodMenuRotationTable.mealType, mealType as any),
    eq(foodMenuRotationTable.dayOfWeek, dow),
    eq(foodMenuRotationTable.isActive, true),
    or(isNull(foodMenuRotationTable.effectiveFrom), lte(foodMenuRotationTable.effectiveFrom, serviceDate)),
    or(isNull(foodMenuRotationTable.effectiveTo), gte(foodMenuRotationTable.effectiveTo, serviceDate)),
  );
  // Both queries below join dishes on isActive: a soft-deleted dish is gone from
  // the catalogue, so it must be gone from the plate too. Keeping the predicate on
  // the week probe as well as the row fetch preserves the invariant above — a week
  // whose only rows point at deleted dishes is not a week the cycle may land on.
  const activeDish = eq(dishesTable.isActive, true);
  const weeksRows = await db
    .selectDistinct({ w: foodMenuRotationTable.rotationWeek, from: foodMenuRotationTable.effectiveFrom })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .where(and(cellWhere, activeDish));
  const weeks = [...new Set(weeksRows.map((r) => r.w))].sort((a, b) => a - b);
  const numWeeks = weeks.length || 1;

  // Cycle phase counts whole weeks since the cell's own start, NOT the ISO week
  // number: that counter resets on 1 January, so a 3-week rotation skipped a week
  // and a 4-week rotation repeated one every new year. Anchored on the earliest
  // effectiveFrom in the cell (the epoch Monday when the cell has no seasonal
  // window at all) the phase advances by exactly one every week, for ever.
  const anchor = weeksRows.reduce<Date | null>(
    (min, r) => (r.from && (!min || r.from < min) ? r.from : min),
    null,
  );
  const phase = istWeekIndex(serviceDate) - (anchor ? istWeekIndex(anchor) : 0);
  const rotationWeek = weeks.length
    ? weeks[((phase % numWeeks) + numWeeks) % numWeeks]!
    : 1;

  const rows = await db
    .select({
      id: foodMenuRotationTable.id,
      parentRotationId: foodMenuRotationTable.parentRotationId,
      dishId: foodMenuRotationTable.dishId,
      slotLabel: foodMenuRotationTable.slotLabel,
      sortOrder: foodMenuRotationTable.sortOrder,
      dishName: dishesTable.name,
      component: dishesTable.component,
      preparations: dishesTable.preparations,
      unit: dishesTable.unit,
      isQtyLocked: dishesTable.isQtyLocked,
      lockedPersons: dishesTable.lockedPersons,
    })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .where(and(cellWhere, activeDish, eq(foodMenuRotationTable.rotationWeek, rotationWeek)))
    .orderBy(foodMenuRotationTable.sortOrder);

  // A side's parent row lives in the same resolved cell, so the id → dishId map
  // is local. A dangling parentRotationId (parent row deleted) degrades to a
  // standalone dish rather than an orphan.
  const dishByRotationId = new Map(rows.map((r) => [r.id, r.dishId]));
  return rows.map((r) => ({
    dishId: r.dishId,
    dishName: r.dishName,
    component: r.component,
    preparations: r.preparations ?? [],
    unit: r.unit,
    slotLabel: r.slotLabel,
    sortOrder: r.sortOrder,
    parentDishId: r.parentRotationId ? (dishByRotationId.get(r.parentRotationId) ?? null) : null,
    isQtyLocked: r.isQtyLocked,
    lockedPersons: r.lockedPersons,
  }));
}

export interface ComputedItem {
  dishId: string;
  unit: string;
  orderedQty: number;
  /**
   * People this line was priced for. Normally the meal's headcount, but a
   * quantity-locked dish overrides it with its own pinned count — callers must
   * persist THIS rather than the order-wide headcount, or the pin is lost the
   * moment the row is inserted.
   */
  personsCount: number;
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
  const unpriced: string[] = [];
  for (const m of menu) {
    const rule = rules.get(m.dishId);
    if (!rule) { unpriced.push(m.dishName); continue; }
    // A quantity-locked dish ignores the meal headcount entirely — it is ordered
    // for its own pinned number of people. Applying it here covers every caller
    // of this helper (legacy POST /food/orders and the quantity-only fallback in
    // POST /order-batches) from one place, so the two can't drift.
    const persons = m.isQtyLocked && m.lockedPersons != null ? m.lockedPersons : mealCount;
    items.push({
      dishId: m.dishId,
      unit: rule.unit || m.unit,
      orderedQty: Math.round(persons * rule.qty * 1000) / 1000,
      personsCount: persons,
    });
  }
  // A menu dish with no active portion rule is dropped from the order: the
  // property still sees it advertised while the kitchen is never told to cook it.
  // The rotation write path refuses to create that state (dishesMissingPortionRule
  // in routes/food.ts), but deleting the rule afterwards still reaches it, so the
  // drop is at least recorded instead of happening in silence.
  if (unpriced.length) {
    logger.warn(
      { kitchenId, brand, mealType, serviceDate: istDayYmd(serviceDate), dishes: unpriced },
      "food: menu dishes dropped from order — no active per-resident portion rule",
    );
  }
  return items;
}

export interface PortionRuleUsage {
  dishId: string;
  dishName: string;
  /** Live rotation cells still serving this dish for the rule's brand + meal. */
  rotationCount: number;
  /** Kitchens whose menu would start dropping the dish. */
  kitchenIds: string[];
}

/**
 * The rotation cells that still serve `dishId` for this (brand, mealType) and
 * would therefore silently drop it the moment its per-resident rule is deleted.
 * Returns null when nothing serves it — i.e. the rule is free to delete.
 *
 * The delete-path twin of dishesMissingPortionRule (routes/food.ts), which guards
 * the rotation write path against the same end state: a dish on the menu that no
 * order can ever carry.
 */
export async function findPortionRuleUsage(
  brand: string,
  mealType: string,
  dishId: string,
): Promise<PortionRuleUsage | null> {
  const rows = await db
    .select({ kitchenId: foodMenuRotationTable.kitchenId, dishName: dishesTable.name })
    .from(foodMenuRotationTable)
    .innerJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .where(and(
      eq(foodMenuRotationTable.dishId, dishId),
      eq(foodMenuRotationTable.brand, brand as any),
      eq(foodMenuRotationTable.mealType, mealType as any),
      eq(foodMenuRotationTable.isActive, true),
      eq(dishesTable.isActive, true),
      // Only cells that can still resolve matter — an expired seasonal window
      // has nothing left to lose.
      or(isNull(foodMenuRotationTable.effectiveTo), gte(foodMenuRotationTable.effectiveTo, new Date())),
    ));
  if (!rows.length) return null;
  return {
    dishId,
    dishName: rows[0]!.dishName,
    rotationCount: rows.length,
    kitchenIds: [...new Set(rows.map((r) => r.kitchenId).filter((k): k is string => !!k))],
  };
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
  /** Side served with another dish — the ordering UI groups it under its parent. */
  parentDishId: string | null;
  /** Dish-level quantity pin — the ordering UI renders these rows read-only and
   *  the server re-derives them at placement. */
  isQtyLocked: boolean;
  lockedPersons: number | null;
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
      parentDishId: m.parentDishId,
      isQtyLocked: m.isQtyLocked,
      lockedPersons: m.lockedPersons,
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
  id: string; brand: string; mealType: string; kitchenId: string | null;
  propertyId: string | null; name: string | null;
  slots: CompositionSlot[];
}

/**
 * How specific a scoped row is for the (kitchen, property) being resolved.
 * Higher wins: property beats kitchen beats the brand-wide default. Shared by
 * composition rules and the menu-rule overrides so the two can never disagree
 * about which scope is narrower.
 */
export function scopeRank(
  row: { kitchenId?: string | null; propertyId?: string | null },
  kitchenId: string | null,
  propertyId: string | null,
): number {
  if (propertyId && row.propertyId === propertyId) return 3;
  if (kitchenId && row.kitchenId === kitchenId) return 2;
  return 1;
}

/**
 * Resolves the composition rule for a (brand, meal) at the narrowest scope that
 * applies: a property rule overrides a kitchen rule, which overrides the
 * brand default. Passing propertyId null asks for the kitchen/brand answer,
 * which is what the kitchen-level rotation board wants.
 */
export async function resolveCompositionRule(
  brand: string, mealType: string, kitchenId: string | null, propertyId: string | null = null,
): Promise<CompositionRule | null> {
  const rules = await db.select().from(menuCompositionRuleTable).where(and(
    eq(menuCompositionRuleTable.brand, brand as any),
    eq(menuCompositionRuleTable.mealType, mealType as any),
    eq(menuCompositionRuleTable.isActive, true),
    propertyId
      ? or(isNull(menuCompositionRuleTable.propertyId), eq(menuCompositionRuleTable.propertyId, propertyId))
      : isNull(menuCompositionRuleTable.propertyId),
    kitchenId
      ? or(isNull(menuCompositionRuleTable.kitchenId), eq(menuCompositionRuleTable.kitchenId, kitchenId))
      : isNull(menuCompositionRuleTable.kitchenId),
  ));
  if (!rules.length) return null;
  const rule = [...rules].sort(
    (a, b) => scopeRank(b, kitchenId, propertyId) - scopeRank(a, kitchenId, propertyId),
  )[0]!;
  const slots = await db.select().from(menuCompositionSlotTable)
    .where(eq(menuCompositionSlotTable.ruleId, rule.id)).orderBy(menuCompositionSlotTable.sortOrder);
  return {
    id: rule.id, brand: rule.brand, mealType: rule.mealType, kitchenId: rule.kitchenId,
    propertyId: rule.propertyId, name: rule.name,
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
  // serviceTime is an IST wall-clock time, so anchor it with atIst rather than
  // Date#setHours — the delivery SLA a property is measured against cannot move
  // by five and a half hours because the host clock is set to UTC.
  const d = atIst(istDayYmd(serviceDate), `${h}:${m || 0}`);
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

/* ────────────────────────────────────────────────────────────────────────────
 * Menu-slot guards — the rules a plate must satisfy before it can be saved.
 * Shared by the slot/bulk write endpoints in routes/food.ts and the menu bulk
 * import in routes/bulk.ts, so an imported rotation is held to exactly the
 * same standard as one built in the plate composer.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A rotation row whose dish has no per-resident portion rule for this (brand,
 * mealType) is silently skipped by computeOrderItems — it shows on the menu but
 * never reaches the kitchen. Reject the save instead.
 *
 * This covers mains as well as sides. It used to check sides only, on the
 * reasoning that mains go through the deliberate builder flow and all carried
 * rules; but a main can now be created straight from the Dishes grid without
 * ever opening the portion editor, so an unpriced main is just as reachable —
 * and a silently-uncooked main is the worse failure. Returns offending names.
 */
export async function dishesMissingPortionRule(
  brand: string, mealType: string, dishIds: string[],
): Promise<string[]> {
  const unique = [...new Set(dishIds.filter(Boolean))];
  if (!unique.length) return [];
  const rules = await db.select({ dishId: perResidentRuleTable.dishId })
    .from(perResidentRuleTable)
    .where(and(
      eq(perResidentRuleTable.brand, brand as never),
      eq(perResidentRuleTable.mealType, mealType as never),
      eq(perResidentRuleTable.isActive, true),
      inArray(perResidentRuleTable.dishId, unique),
    ));
  const priced = new Set(rules.map((r) => r.dishId));
  const missing = unique.filter((id) => !priced.has(id));
  if (!missing.length) return [];
  const named = await db.select({ name: dishesTable.name })
    .from(dishesTable).where(inArray(dishesTable.id, missing));
  return named.map((n) => n.name);
}

/** Every dish a slot payload would put on the menu — the items and their sides. */
export const collectDishIds = (items: Array<{ dishId: string; sideDishIds?: string[] }>): string[] =>
  [...new Set(items.flatMap((it) => [it.dishId, ...(it.sideDishIds ?? [])]).filter(Boolean))];

/**
 * The shared-ingredient rule, enforced where it actually matters.
 *
 * `detectSharedIngredients` has existed since the rule engine was written, but
 * was wired only into GET /menu/validate — a read-only endpoint the admin client
 * never calls. The real block lived in the plate composer's disabled save button,
 * so "duplicate the week" (28 direct slot writes) and any API caller sailed past
 * a rule the UI advertised as always enforced. This closes that.
 *
 * Returns a 422 payload to send, or null when the plate is acceptable — either
 * because nothing clashes or because the rule is switched off in Service Set.
 */
export async function ingredientClashError(
  dishIds: string[],
): Promise<{ error: string; details: Record<string, unknown> } | null> {
  if (dishIds.length < 2) return null;
  if (!(await isIngredientClashRuleOn())) return null;
  const shared = await detectSharedIngredients(dishIds);
  if (!shared.length) return null;
  const names = shared.map((s) => s.name).join(", ");
  return {
    error: `Two or more dishes on this plate share an ingredient (${names}). Swap one of them, or turn off the shared-ingredient rule under Menu Rules.`,
    details: { sharedIngredients: shared },
  };
}
