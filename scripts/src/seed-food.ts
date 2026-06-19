/**
 * Seeds the Food Ordering & Kitchen Operations domain end-to-end.
 *
 * Runs AFTER the main seed (scripts/src/seed.ts) which creates properties +
 * users. This script NEVER truncates or wipes core tables (properties, users);
 * it only adds/updates food-domain data and is safe to run multiple times.
 *
 * Seeds, in FK-safe order:
 *   1. Geographic hierarchy: zones → cities → clusters (stable ids, upsert)
 *   2. Assigns every existing property to a cluster (deterministic round-robin)
 *   3. Food-role users (stable ids/emails, bcrypt "Admin@123", upsert)
 *   4. user_scopes for each seeded user (cleaned + reinserted per run)
 *   5. Dish catalogue (PRD §10) — upsert by stable id
 *   6. Weekly menu rotation for both brands (PRD §10.1) — replaced each run
 *   7. Per-resident quantity rules (PRD §7.9) — replaced each run
 *   8. Delivery partners — upsert by stable id
 *   9. Sample orders spanning every lifecycle state (truncated + reseeded)
 *
 * Run:  pnpm --filter @workspace/scripts run seed:food
 */
import { db, pool } from "@workspace/db";
import {
  dishesTable,
  foodMenuRotationTable,
  perResidentRuleTable,
  deliveryPartnersTable,
  zonesTable,
  citiesTable,
  clustersTable,
  userScopesTable,
  usersTable,
  propertiesTable,
  foodOrdersTable,
  foodOrderItemsTable,
  foodOrderEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const id = () => randomUUID();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

type Brand = "UNILIV" | "HUDDLE";
type Meal = "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER" | "NIGHT_MILK";
type Component =
  | "HOT_FOOD" | "VEG" | "DAL" | "RICE" | "BREAD" | "SALAD" | "CURD_RAITA"
  | "DESSERT" | "PAPAD_PICKLE" | "CHUTNEY" | "PICKLE" | "FRUITS" | "BAKERY"
  | "BEVERAGE" | "SNACK" | "MILK";
type Unit = "G" | "KG" | "ML" | "LITRE" | "PCS" | "PLATE" | "SERVING";

/** Canonical unit + qty-per-resident for each component (PRD §7.9 rules). */
const COMPONENT_RULE: Record<Component, { unit: Unit; qty: number }> = {
  HOT_FOOD:     { unit: "KG", qty: 0.18 },
  VEG:          { unit: "KG", qty: 0.15 },
  DAL:          { unit: "LITRE", qty: 0.2 },
  RICE:         { unit: "KG", qty: 0.15 },
  BREAD:        { unit: "PCS", qty: 2 },
  SALAD:        { unit: "KG", qty: 0.05 },
  CURD_RAITA:   { unit: "LITRE", qty: 0.1 },
  DESSERT:      { unit: "KG", qty: 0.1 },
  PAPAD_PICKLE: { unit: "PCS", qty: 1 },
  PICKLE:       { unit: "KG", qty: 0.01 },
  CHUTNEY:      { unit: "KG", qty: 0.03 },
  FRUITS:       { unit: "KG", qty: 0.1 },
  BAKERY:       { unit: "PCS", qty: 1 },
  BEVERAGE:     { unit: "LITRE", qty: 0.2 },
  SNACK:        { unit: "KG", qty: 0.1 },
  MILK:         { unit: "LITRE", qty: 0.2 },
};

// ─── Dish catalogue ──────────────────────────────────────────────────────────
// Stable ids (dish_<key>) make re-runs upsert instead of duplicate.
const DISHES: { key: string; name: string; component: Component }[] = [
  // Breakfast hot food (7-day rotation, primary)
  { key: "poha", name: "Poha", component: "HOT_FOOD" },
  { key: "upma", name: "Upma", component: "HOT_FOOD" },
  { key: "aloo_paratha", name: "Aloo Paratha", component: "HOT_FOOD" },
  { key: "idli_sambar", name: "Idli Sambar", component: "HOT_FOOD" },
  { key: "masala_dosa", name: "Masala Dosa", component: "HOT_FOOD" },
  { key: "veg_sandwich", name: "Veg Sandwich", component: "HOT_FOOD" },
  { key: "vermicelli", name: "Vegetable Vermicelli", component: "HOT_FOOD" },
  // Breakfast hot food 2 (Uniliv premium add-on)
  { key: "moong_cheela", name: "Moong Dal Cheela", component: "HOT_FOOD" },
  { key: "veg_cutlet", name: "Veg Cutlet", component: "HOT_FOOD" },
  { key: "besan_cheela", name: "Besan Cheela", component: "HOT_FOOD" },
  { key: "medu_vada", name: "Medu Vada", component: "HOT_FOOD" },
  { key: "uttapam", name: "Uttapam", component: "HOT_FOOD" },
  { key: "hash_brown", name: "Veg Hash Browns", component: "HOT_FOOD" },
  { key: "sabudana", name: "Sabudana Khichdi", component: "HOT_FOOD" },
  // Veg mains (primary, 7-day)
  { key: "aloo_gobi", name: "Aloo Gobi", component: "VEG" },
  { key: "paneer_butter", name: "Paneer Butter Masala", component: "VEG" },
  { key: "bhindi_masala", name: "Bhindi Masala", component: "VEG" },
  { key: "chana_masala", name: "Chana Masala", component: "VEG" },
  { key: "mix_veg", name: "Mix Vegetable", component: "VEG" },
  { key: "rajma", name: "Rajma Masala", component: "VEG" },
  { key: "matar_paneer", name: "Matar Paneer", component: "VEG" },
  // Veg 2 (Uniliv premium second veg, 7-day)
  { key: "jeera_aloo", name: "Jeera Aloo", component: "VEG" },
  { key: "dum_aloo", name: "Dum Aloo", component: "VEG" },
  { key: "lauki_kofta", name: "Lauki Kofta", component: "VEG" },
  { key: "baingan_bharta", name: "Baingan Bharta", component: "VEG" },
  { key: "aloo_methi", name: "Aloo Methi", component: "VEG" },
  { key: "kadhi_pakora", name: "Kadhi Pakora", component: "VEG" },
  { key: "veg_kolhapuri", name: "Veg Kolhapuri", component: "VEG" },
  // Daily accompaniments (repeat every day)
  { key: "dal_tadka", name: "Dal Tadka", component: "DAL" },
  { key: "steamed_rice", name: "Steamed Rice", component: "RICE" },
  { key: "ghee_chapatti", name: "Desi Ghee Chapatti", component: "BREAD" },
  { key: "plain_chapatti", name: "Plain Chapatti", component: "BREAD" },
  { key: "green_salad", name: "Green Salad", component: "SALAD" },
  { key: "curd", name: "Curd / Raita", component: "CURD_RAITA" },
  { key: "papad", name: "Papad", component: "PAPAD_PICKLE" },
  { key: "pickle", name: "Pickle", component: "PICKLE" },
  { key: "chutney", name: "Chutney", component: "CHUTNEY" },
  { key: "fruits", name: "Seasonal Fruits", component: "FRUITS" },
  { key: "bakery", name: "Bakery Item", component: "BAKERY" },
  { key: "tea_coffee", name: "Tea / Coffee", component: "BEVERAGE" },
  { key: "hot_milk", name: "Hot Milk", component: "MILK" },
  // Desserts (7-day)
  { key: "gulab_jamun", name: "Gulab Jamun", component: "DESSERT" },
  { key: "kheer", name: "Rice Kheer", component: "DESSERT" },
  { key: "fruit_custard", name: "Fruit Custard", component: "DESSERT" },
  { key: "suji_halwa", name: "Suji Halwa", component: "DESSERT" },
  { key: "rasgulla", name: "Rasgulla", component: "DESSERT" },
  { key: "moong_halwa", name: "Moong Dal Halwa", component: "DESSERT" },
  { key: "sevaiya", name: "Sevaiya", component: "DESSERT" },
  // Evening snacks (7-day)
  { key: "samosa", name: "Samosa", component: "SNACK" },
  { key: "veg_pakora", name: "Veg Pakora", component: "SNACK" },
  { key: "dhokla", name: "Dhokla", component: "SNACK" },
  { key: "bread_pakora", name: "Bread Pakora", component: "SNACK" },
  { key: "aloo_tikki", name: "Aloo Tikki", component: "SNACK" },
  { key: "spring_roll", name: "Veg Spring Roll", component: "SNACK" },
  { key: "mathri", name: "Mathri", component: "SNACK" },
];

const dishId = (key: string) => `dish_${key}`;
const componentOf = (key: string): Component =>
  DISHES.find((d) => d.key === key)!.component;

// 7-day rotation arrays (index 0 = Monday … 6 = Sunday)
const VEG_PRIMARY = ["aloo_gobi", "paneer_butter", "bhindi_masala", "chana_masala", "mix_veg", "rajma", "matar_paneer"];
const VEG_SECOND  = ["jeera_aloo", "dum_aloo", "lauki_kofta", "baingan_bharta", "aloo_methi", "kadhi_pakora", "veg_kolhapuri"];
const HOT_PRIMARY = ["poha", "upma", "aloo_paratha", "idli_sambar", "masala_dosa", "veg_sandwich", "vermicelli"];
const HOT_SECOND  = ["moong_cheela", "veg_cutlet", "besan_cheela", "medu_vada", "uttapam", "hash_brown", "sabudana"];
const DESSERTS    = ["gulab_jamun", "kheer", "fruit_custard", "suji_halwa", "rasgulla", "moong_halwa", "sevaiya"];
const SNACKS_ROT  = ["samosa", "veg_pakora", "dhokla", "bread_pakora", "aloo_tikki", "spring_roll", "mathri"];

type RotationRow = typeof foodMenuRotationTable.$inferInsert;

/**
 * Builds the weekly rotation for one brand encoding the §10.1 service set:
 * Uniliv serves Veg + Veg 2 and Hot Food + Hot Food 2 and Desi Ghee Chapatti +
 * Night Milk; Huddle serves a single Veg / Hot Food, Plain Chapatti, no milk.
 */
function buildRotation(brand: Brand): RotationRow[] {
  const rows: RotationRow[] = [];
  const isUniliv = brand === "UNILIV";
  const breadKey = isUniliv ? "ghee_chapatti" : "plain_chapatti";

  for (let i = 0; i < 7; i++) {
    const day = i + 1; // 1 = Monday … 7 = Sunday
    const add = (meal: Meal, key: string, slotLabel: string, sortOrder: number) =>
      rows.push({
        id: id(),
        brand,
        rotationWeek: 1,
        dayOfWeek: day,
        mealType: meal,
        dishId: dishId(key),
        slotLabel,
        sortOrder,
        isActive: true,
      });

    // Breakfast
    add("BREAKFAST", HOT_PRIMARY[i]!, "Hot Food", 1);
    if (isUniliv) add("BREAKFAST", HOT_SECOND[i]!, "Hot Food 2", 2);
    add("BREAKFAST", "chutney", "Chutney", 3);
    add("BREAKFAST", "curd", "Curd", 4);
    add("BREAKFAST", "fruits", "Fruits", 5);
    add("BREAKFAST", "bakery", "Bakery", 6);
    add("BREAKFAST", "tea_coffee", "Beverage", 7);

    // Lunch
    add("LUNCH", VEG_PRIMARY[i]!, "Veg", 1);
    if (isUniliv) add("LUNCH", VEG_SECOND[i]!, "Veg 2", 2);
    add("LUNCH", "dal_tadka", "Dal", 3);
    add("LUNCH", "steamed_rice", "Rice", 4);
    add("LUNCH", breadKey, "Bread", 5);
    add("LUNCH", "green_salad", "Salad", 6);
    add("LUNCH", "curd", "Curd/Raita", 7);
    add("LUNCH", DESSERTS[i]!, "Dessert", 8);
    add("LUNCH", "papad", "Papad", 9);
    add("LUNCH", "pickle", "Pickle", 10);

    // Snacks
    add("SNACKS", SNACKS_ROT[i]!, "Snack", 1);
    add("SNACKS", "chutney", "Chutney", 2);
    add("SNACKS", "tea_coffee", "Beverage", 3);

    // Dinner
    add("DINNER", VEG_PRIMARY[(i + 3) % 7]!, "Veg", 1); // offset so dinner ≠ lunch
    if (isUniliv) add("DINNER", VEG_SECOND[(i + 3) % 7]!, "Veg 2", 2);
    add("DINNER", "dal_tadka", "Dal", 3);
    add("DINNER", "steamed_rice", "Rice", 4);
    add("DINNER", breadKey, "Bread", 5);
    add("DINNER", "green_salad", "Salad", 6);
    add("DINNER", DESSERTS[(i + 3) % 7]!, "Dessert", 7);
    add("DINNER", "papad", "Papad", 8);
    add("DINNER", "pickle", "Pickle", 9);

    // Night milk — Uniliv only (§10.1)
    if (isUniliv) add("NIGHT_MILK", "hot_milk", "Hot Milk", 1);
  }
  return rows;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Geographic hierarchy (stable ids)
 * ──────────────────────────────────────────────────────────────────────────── */

const ZONES = [
  { id: "zone_north", name: "North Zone", code: "NORTH" },
  { id: "zone_west", name: "West Zone", code: "WEST" },
];

const CITIES = [
  { id: "city_delhi", name: "Delhi", zoneId: "zone_north" },
  { id: "city_gurugram", name: "Gurugram", zoneId: "zone_north" },
  { id: "city_mumbai", name: "Mumbai", zoneId: "zone_west" },
  { id: "city_pune", name: "Pune", zoneId: "zone_west" },
  { id: "city_bengaluru", name: "Bengaluru", zoneId: "zone_west" },
];

const CLUSTERS = [
  { id: "cluster_delhi_central", name: "Delhi Central", cityId: "city_delhi" },
  { id: "cluster_delhi_south", name: "Delhi South", cityId: "city_delhi" },
  { id: "cluster_ggn_cyberhub", name: "Gurugram Cyber Hub", cityId: "city_gurugram" },
  { id: "cluster_mumbai_andheri", name: "Mumbai Andheri", cityId: "city_mumbai" },
  { id: "cluster_pune_hinjewadi", name: "Pune Hinjewadi", cityId: "city_pune" },
  { id: "cluster_blr_koramangala", name: "Bengaluru Koramangala", cityId: "city_bengaluru" },
  { id: "cluster_blr_whitefield", name: "Bengaluru Whitefield", cityId: "city_bengaluru" },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Food-role users (stable ids/emails)
 * ──────────────────────────────────────────────────────────────────────────── */

type FoodUserRole =
  | "OPS_EXCELLENCE" | "SENIOR_VICE_PRESIDENT" | "ZONAL_HEAD" | "CITY_HEAD"
  | "CLUSTER_MANAGER" | "UNIT_LEAD" | "FNB_SUPERVISOR" | "FNB_MANAGER"
  | "FNB_ZONAL_HEAD";

interface SeedUser {
  id: string;
  name: string;
  email: string;
  role: FoodUserRole;
  /** Index into the (sorted) property list for UNIT_LEADs; null otherwise. */
  propertyIndex: number | null;
}

const FOOD_USERS: SeedUser[] = [
  { id: "user_food_ops",       name: "Ops Excellence",     email: "opsexcellence@uniliv.com",role: "OPS_EXCELLENCE",        propertyIndex: null },
  { id: "user_food_svp",       name: "Senior VP",          email: "svp@uniliv.com",          role: "SENIOR_VICE_PRESIDENT", propertyIndex: null },
  { id: "user_food_zonal",     name: "Zonal Head North",   email: "zonalhead@uniliv.com",    role: "ZONAL_HEAD",            propertyIndex: null },
  { id: "user_food_cityhead",  name: "City Head Delhi",    email: "cityhead@uniliv.com",     role: "CITY_HEAD",             propertyIndex: null },
  { id: "user_food_cluster",   name: "Cluster Manager",    email: "clustermgr@uniliv.com",   role: "CLUSTER_MANAGER",       propertyIndex: null },
  { id: "user_food_unit1",     name: "Unit Lead One",      email: "unitlead1@uniliv.com",    role: "UNIT_LEAD",             propertyIndex: 0 },
  { id: "user_food_unit2",     name: "Unit Lead Two",      email: "unitlead2@uniliv.com",    role: "UNIT_LEAD",             propertyIndex: 1 },
  { id: "user_food_fnbsup",    name: "F&B Supervisor",     email: "fnbsupervisor@uniliv.com",role: "FNB_SUPERVISOR",        propertyIndex: null },
  { id: "user_food_fnbmgr",    name: "F&B Manager",        email: "fnbmanager@uniliv.com",   role: "FNB_MANAGER",           propertyIndex: null },
  { id: "user_food_fnbzonal",  name: "F&B Zonal Head",     email: "fnbzonal@uniliv.com",     role: "FNB_ZONAL_HEAD",        propertyIndex: null },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Per-resident item computation (replicated from api-server food-service.ts —
 * the seed is a separate package and cannot import from api-server).
 * ──────────────────────────────────────────────────────────────────────────── */

/** JS Date → ISO day of week (1 = Monday … 7 = Sunday). */
function isoDayOfWeek(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

interface ComputedItem {
  dishId: string;
  unit: Unit;
  orderedQty: number;
}

/**
 * Resolves the dishes for (brand, meal, day) from the in-memory rotation and
 * applies the global per-resident rule (fallback 0.15) to get ordered qty.
 */
function computeItemsForOrder(
  rotation: RotationRow[],
  brand: Brand,
  meal: Meal,
  serviceDate: Date,
  quantity: number,
): ComputedItem[] {
  const dow = isoDayOfWeek(serviceDate);
  const dishes = rotation.filter(
    (r) => r.brand === brand && r.mealType === meal && r.dayOfWeek === dow,
  );
  return dishes.map((r) => {
    const key = String(r.dishId).replace(/^dish_/, "");
    const comp = componentOf(key);
    const rule = COMPONENT_RULE[comp] ?? { unit: "KG" as Unit, qty: 0.15 };
    return {
      dishId: String(r.dishId),
      unit: rule.unit,
      orderedQty: Math.round(quantity * rule.qty * 1000) / 1000,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────────── */

async function main() {
  console.log("🍽️  Seeding food ordering domain (comprehensive)...");

  // 1. Geographic hierarchy: zones → cities → clusters ──────────────────────
  await db.insert(zonesTable).values(ZONES).onConflictDoNothing({ target: zonesTable.id });
  await db.insert(citiesTable).values(CITIES).onConflictDoNothing({ target: citiesTable.id });
  await db.insert(clustersTable).values(CLUSTERS).onConflictDoNothing({ target: clustersTable.id });
  console.log(`  ✓ ${ZONES.length} zones, ${CITIES.length} cities, ${CLUSTERS.length} clusters`);

  // 2. Assign every existing property to a cluster (deterministic round-robin)
  const properties = await db
    .select({ id: propertiesTable.id })
    .from(propertiesTable)
    .orderBy(propertiesTable.id);
  const propIds = properties.map((p) => p.id);
  if (propIds.length === 0) {
    throw new Error("No properties found — run the main seed (seed) first.");
  }
  for (let i = 0; i < propIds.length; i++) {
    const cluster = CLUSTERS[i % CLUSTERS.length]!;
    await db
      .update(propertiesTable)
      .set({ clusterId: cluster.id, updatedAt: new Date() })
      .where(eq(propertiesTable.id, propIds[i]!));
  }
  console.log(`  ✓ assigned ${propIds.length} properties to clusters (round-robin)`);

  // 3. Food-role users (upsert by stable id) ────────────────────────────────
  const passwordHash = await bcrypt.hash("Admin@123", 10);
  await db
    .insert(usersTable)
    .values(
      FOOD_USERS.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        propertyId:
          u.propertyIndex !== null
            ? propIds[u.propertyIndex % propIds.length]!
            : null,
        passwordHash,
        isActive: true,
        updatedAt: new Date(),
      })),
    )
    // No target → skip on ANY unique-constraint conflict (id OR email), so
    // re-runs and pre-existing emails from the main seed never crash.
    .onConflictDoNothing();
  console.log(`  ✓ ${FOOD_USERS.length} food-role users`);

  // Set one seeded cluster manager as the manager of every cluster (display).
  const clusterMgrId = "user_food_cluster";
  await db
    .update(clustersTable)
    .set({ managerId: clusterMgrId, updatedAt: new Date() })
    .where(inArray(clustersTable.id, CLUSTERS.map((c) => c.id)));

  // 4. user_scopes — clean for seeded users then reinsert ───────────────────
  const seededUserIds = FOOD_USERS.map((u) => u.id);
  await db.delete(userScopesTable).where(inArray(userScopesTable.userId, seededUserIds));

  type ScopeRow = typeof userScopesTable.$inferInsert;
  const scopeRows: ScopeRow[] = [];
  const addScope = (row: Omit<ScopeRow, "id">) => scopeRows.push({ id: id(), ...row });

  const firstZone = ZONES[0]!.id;       // zone_north
  const firstCity = CITIES[0]!.id;      // city_delhi
  const firstCluster = CLUSTERS[0]!.id; // cluster_delhi_central

  for (const u of FOOD_USERS) {
    switch (u.role) {
      case "OPS_EXCELLENCE":
      case "SENIOR_VICE_PRESIDENT":
        addScope({ userId: u.id, scopeLevel: "GLOBAL" });
        break;
      case "ZONAL_HEAD":
        addScope({ userId: u.id, scopeLevel: "ZONE", zoneId: firstZone });
        break;
      case "CITY_HEAD":
        addScope({ userId: u.id, scopeLevel: "CITY", cityId: firstCity });
        break;
      case "CLUSTER_MANAGER":
        addScope({ userId: u.id, scopeLevel: "CLUSTER", clusterId: firstCluster });
        break;
      case "UNIT_LEAD":
        addScope({
          userId: u.id,
          scopeLevel: "PROPERTY",
          propertyId: propIds[(u.propertyIndex ?? 0) % propIds.length]!,
        });
        break;
      case "FNB_ZONAL_HEAD":
        // F&B zonal oversight maps to a zone.
        addScope({ userId: u.id, scopeLevel: "ZONE", zoneId: firstZone });
        break;
      case "FNB_MANAGER":
        // F&B manager — global kitchen oversight.
        addScope({ userId: u.id, scopeLevel: "GLOBAL" });
        break;
      case "FNB_SUPERVISOR":
        // F&B supervisor — bound to a single cluster's kitchen.
        addScope({ userId: u.id, scopeLevel: "CLUSTER", clusterId: firstCluster });
        break;
    }
  }
  await db.insert(userScopesTable).values(scopeRows);
  console.log(`  ✓ ${scopeRows.length} user scopes`);

  // 5. Dishes (upsert by stable id) ─────────────────────────────────────────
  await db
    .insert(dishesTable)
    .values(
      DISHES.map((d) => ({
        id: dishId(d.key),
        name: d.name,
        component: d.component,
        unit: COMPONENT_RULE[d.component].unit,
        isVeg: true,
        isActive: true,
      })),
    )
    .onConflictDoNothing({ target: dishesTable.id });
  console.log(`  ✓ ${DISHES.length} dishes`);

  // 6. Menu rotation (replace) ──────────────────────────────────────────────
  await pool.query(`TRUNCATE TABLE "food_menu_rotation";`);
  const rotation = [...buildRotation("UNILIV"), ...buildRotation("HUDDLE")];
  await db.insert(foodMenuRotationTable).values(rotation);
  console.log(`  ✓ ${rotation.length} menu rotation rows (Uniliv + Huddle, week 1)`);

  // 7. Per-resident rules (replace) ─────────────────────────────────────────
  // Derive one rule per unique (brand, meal, dish) appearing in the rotation.
  await pool.query(`TRUNCATE TABLE "per_resident_rules";`);
  const seen = new Set<string>();
  const rules = rotation.flatMap((r) => {
    const k = `${r.brand}|${r.mealType}|${r.dishId}`;
    if (seen.has(k)) return [];
    seen.add(k);
    const comp = componentOf(String(r.dishId).replace(/^dish_/, ""));
    const { unit, qty } = COMPONENT_RULE[comp];
    return [{
      id: id(),
      brand: r.brand,
      mealType: r.mealType,
      dishId: r.dishId,
      propertyId: null, // global default rule
      qtyPerResident: String(qty),
      unit,
      isActive: true,
    }];
  });
  await db.insert(perResidentRuleTable).values(rules);
  console.log(`  ✓ ${rules.length} per-resident rules`);

  // 8. Delivery partners (upsert by stable id) ──────────────────────────────
  await db
    .insert(deliveryPartnersTable)
    .values([
      { id: "dp_swift", name: "Swift Logistics", phone: "9000000001", vehicleNumber: "DL01AB1234", isActive: true },
      { id: "dp_fresh", name: "FreshMove Couriers", phone: "9000000002", vehicleNumber: "DL02CD5678", isActive: true },
      { id: "dp_inhouse", name: "In-house Fleet", phone: "9000000003", vehicleNumber: "DL03EF9012", isActive: true },
    ])
    .onConflictDoNothing({ target: deliveryPartnersTable.id });
  console.log("  ✓ 3 delivery partners");

  // 9. Sample orders spanning every lifecycle state ─────────────────────────
  // Truncate ONLY the three food-order tables (CASCADE-safe) so re-runs stay
  // clean. Core tables (properties, users) are never touched.
  await pool.query(
    `TRUNCATE TABLE "food_order_events", "food_order_items", "food_orders" RESTART IDENTITY CASCADE;`,
  );

  const deliveryPartnerIds = ["dp_swift", "dp_fresh", "dp_inhouse"];
  const unitLeads = FOOD_USERS.filter((u) => u.role === "UNIT_LEAD");

  // Lifecycle plan: one order per status per unit lead's property.
  const STATUSES = ["PLACED", "PREPARING", "DISPATCHED", "DELIVERED", "CANCELLED"] as const;
  type Status = (typeof STATUSES)[number];

  interface OrderPlan {
    status: Status;
    brand: Brand;
    meal: Meal;
    residentsCount: number;
    serviceOffsetDays: number; // +future for upcoming, -past for delivered
  }

  const PLANS: OrderPlan[] = [
    { status: "PLACED",     brand: "UNILIV", meal: "LUNCH",     residentsCount: 80, serviceOffsetDays: 1 },
    { status: "PREPARING",  brand: "UNILIV", meal: "BREAKFAST", residentsCount: 60, serviceOffsetDays: 0 },
    { status: "DISPATCHED", brand: "HUDDLE", meal: "DINNER",    residentsCount: 45, serviceOffsetDays: 0 },
    { status: "DELIVERED",  brand: "UNILIV", meal: "LUNCH",     residentsCount: 90, serviceOffsetDays: -1 },
    { status: "CANCELLED",  brand: "HUDDLE", meal: "SNACKS",    residentsCount: 30, serviceOffsetDays: -2 },
  ];

  let orderSeq = 0;
  const orderRows: (typeof foodOrdersTable.$inferInsert)[] = [];
  const itemRows: (typeof foodOrderItemsTable.$inferInsert)[] = [];
  const eventRows: (typeof foodOrderEventsTable.$inferInsert)[] = [];
  const year = new Date().getFullYear();

  for (const lead of unitLeads) {
    const propertyId = propIds[(lead.propertyIndex ?? 0) % propIds.length]!;
    for (const plan of PLANS) {
      orderSeq += 1;
      const orderId = id();
      const orderNumber = `ORD-${year}-${String(orderSeq).padStart(6, "0")}`;
      const serviceDate = plan.serviceOffsetDays >= 0
        ? daysFromNow(plan.serviceOffsetDays)
        : daysAgo(-plan.serviceOffsetDays);
      const createdAt = daysAgo(Math.max(1, -plan.serviceOffsetDays + 1));

      const computed = computeItemsForOrder(
        rotation, plan.brand, plan.meal, serviceDate, plan.residentsCount,
      );
      const totalQuantity = computed.reduce((sum, c) => sum + c.orderedQty, 0);

      // Lifecycle-dependent timestamps & actors.
      const isDispatched = plan.status === "DISPATCHED" || plan.status === "DELIVERED";
      const isDelivered = plan.status === "DELIVERED";
      const isPreparing = plan.status === "PREPARING" || isDispatched;
      const isCancelled = plan.status === "CANCELLED";
      const deliveryPartnerId = isDispatched
        ? deliveryPartnerIds[orderSeq % deliveryPartnerIds.length]!
        : null;
      const dispatcherId = isDispatched ? "user_food_fnbsup" : null;
      const confirmerId = isDelivered ? lead.id : null;
      const deliveredAt = isDelivered ? new Date(serviceDate.getTime() + 2 * 3_600_000) : null;
      const wasteEditableUntil = deliveredAt
        ? new Date(deliveredAt.getTime() + 3_600_000) // delivered + 1h (PRD §7.7)
        : null;

      orderRows.push({
        id: orderId,
        orderNumber,
        propertyId,
        brand: plan.brand,
        mealType: plan.meal,
        unitLeadId: lead.id,
        residentsCount: plan.residentsCount,
        totalQuantity: String(Math.round(totalQuantity * 1000) / 1000),
        status: plan.status,
        serviceDate,
        notes: `Seeded ${plan.status} order for ${plan.meal.toLowerCase()}.`,
        deliveryPartnerId,
        dispatchedById: dispatcherId,
        dispatchStartedAt: isDispatched ? new Date(serviceDate.getTime() - 3_600_000) : null,
        dispatchedAt: isDispatched ? new Date(serviceDate.getTime() - 1_800_000) : null,
        confirmedById: confirmerId,
        deliveredAt,
        deliveryRemarks: isDelivered ? "Delivered in full, verified by unit lead." : null,
        wasteEditableUntil,
        preparingAt: isPreparing ? new Date(serviceDate.getTime() - 4 * 3_600_000) : null,
        cancelledAt: isCancelled ? createdAt : null,
        cancelReason: isCancelled ? "Resident count dropped; meal not required." : null,
        createdById: lead.id,
        createdAt,
        updatedAt: new Date(),
      });

      // Items: ordered always; prepared at dispatch; received + wasted at delivery.
      for (const c of computed) {
        const preparedQty = isDispatched ? c.orderedQty : null;
        // Delivered: receive most of it, waste a small slice.
        const wastedQty = isDelivered ? Math.round(c.orderedQty * 0.08 * 1000) / 1000 : null;
        const receivedQty = isDelivered ? Math.round((c.orderedQty - (wastedQty ?? 0)) * 1000) / 1000 : null;
        itemRows.push({
          id: id(),
          orderId,
          dishId: c.dishId,
          unit: c.unit,
          orderedQty: String(c.orderedQty),
          preparedQty: preparedQty !== null ? String(preparedQty) : null,
          receivedQty: receivedQty !== null ? String(receivedQty) : null,
          wastedQty: wastedQty !== null ? String(wastedQty) : null,
          createdAt,
          updatedAt: new Date(),
        });
      }

      // Events: one per transition the order has passed through.
      const pushEvent = (status: Status, note: string, actorId: string, at: Date) =>
        eventRows.push({ id: id(), orderId, status, note, actorId, createdAt: at });

      pushEvent("PLACED", "Order placed by unit lead.", lead.id, createdAt);
      if (isCancelled) {
        pushEvent("CANCELLED", "Order cancelled before dispatch.", lead.id, createdAt);
      } else {
        if (isPreparing) {
          pushEvent("PREPARING", "Kitchen started preparation.", "user_food_fnbsup",
            new Date(serviceDate.getTime() - 4 * 3_600_000));
        }
        if (isDispatched) {
          pushEvent("DISPATCHED", "Dispatched to property.", dispatcherId!,
            new Date(serviceDate.getTime() - 1_800_000));
        }
        if (isDelivered) {
          pushEvent("DELIVERED", "Delivery confirmed with item-wise proof.", lead.id, deliveredAt!);
        }
      }
    }
  }

  await db.insert(foodOrdersTable).values(orderRows);
  await db.insert(foodOrderItemsTable).values(itemRows);
  await db.insert(foodOrderEventsTable).values(eventRows);
  console.log(
    `  ✓ ${orderRows.length} sample orders (${unitLeads.length} leads × ${PLANS.length} states), ` +
      `${itemRows.length} items, ${eventRows.length} events`,
  );

  console.log("✅ Food domain seeded.");
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
