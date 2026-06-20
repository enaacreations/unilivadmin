/**
 * Phase 1–3 supplemental seed. Idempotent; run AFTER `seed` and `seed:food`.
 *
 *   pnpm --filter @workspace/scripts run seed:food-extra
 *
 * Seeds: system_config (OTP/login limits), per-user username + phone backfill,
 * food meal config (labels incl. "High Tea / Evening Snacks"), cut-off windows,
 * kitchens, and groups existing DISPATCHED orders into a dispatch trip so the
 * trip-based dispatch UI has data.
 */
import { db, pool } from "@workspace/db";
import {
  systemConfigTable,
  usersTable,
  foodMealConfigTable,
  foodMealWindowsTable,
  kitchensTable,
  foodDispatchesTable,
  foodOrdersTable,
} from "@workspace/db";
import { eq, isNull, or, and } from "drizzle-orm";
import { randomUUID } from "crypto";

const id = () => randomUUID();

async function seedConfig() {
  console.log("  system config...");
  const cfg: Array<{ key: string; value: number; description: string }> = [
    { key: "OTP_LENGTH", value: 6, description: "OTP code length" },
    { key: "OTP_EXPIRY_MINUTES", value: 10, description: "OTP validity window (minutes)" },
    { key: "OTP_MAX_ATTEMPTS", value: 3, description: "Max OTP verification attempts before lock" },
    { key: "OTP_MAX_RESEND", value: 3, description: "Max OTP resends per challenge" },
    { key: "LOGIN_LOCKOUT_MINUTES", value: 15, description: "Account lockout after failed logins (minutes)" },
  ];
  for (const c of cfg) {
    await db.insert(systemConfigTable)
      .values({ id: id(), key: c.key, value: c.value, description: c.description, updatedAt: new Date() })
      .onConflictDoNothing({ target: systemConfigTable.key });
  }
  console.log(`  ✓ ${cfg.length} config keys`);
}

async function backfillUsers() {
  console.log("  username + phone backfill...");
  const users = await db.select().from(usersTable).where(or(isNull(usersTable.username), isNull(usersTable.phone)));
  let n = 0;
  for (let i = 0; i < users.length; i++) {
    const u = users[i]!;
    const username = u.username ?? u.email.split("@")[0]!.toLowerCase();
    const phone = u.phone ?? `9876${String(500000 + i).slice(-6)}`;
    await db.update(usersTable).set({ username, phone, updatedAt: new Date() }).where(eq(usersTable.id, u.id));
    n++;
  }
  console.log(`  ✓ backfilled ${n} users`);
}

async function seedMealConfig() {
  console.log("  meal config...");
  const meals: Array<{ mealType: string; displayLabel: string; brand: string | null; sortOrder: number }> = [
    { mealType: "BREAKFAST", displayLabel: "Breakfast", brand: null, sortOrder: 1 },
    { mealType: "LUNCH", displayLabel: "Lunch", brand: null, sortOrder: 2 },
    { mealType: "SNACKS", displayLabel: "High Tea / Evening Snacks", brand: null, sortOrder: 3 },
    { mealType: "DINNER", displayLabel: "Dinner", brand: null, sortOrder: 4 },
    { mealType: "NIGHT_MILK", displayLabel: "Night Milk", brand: "UNILIV", sortOrder: 5 },
  ];
  for (const m of meals) {
    await db.insert(foodMealConfigTable)
      .values({ id: id(), mealType: m.mealType as never, displayLabel: m.displayLabel, brand: m.brand as never, sortOrder: m.sortOrder, isEnabled: true, updatedAt: new Date() })
      .onConflictDoNothing({ target: foodMealConfigTable.mealType });
  }
  console.log(`  ✓ ${meals.length} meal configs`);
}

async function seedMealWindows() {
  console.log("  meal windows (cut-offs)...");
  // Reset global defaults to stay idempotent.
  await pool.query(`DELETE FROM "food_meal_windows" WHERE property_id IS NULL`);
  const windows = [
    { brand: "UNILIV", mealType: "BREAKFAST", cutoffTime: "21:00", serviceTime: "08:00", leadTimeMinutes: 30 },
    { brand: "UNILIV", mealType: "LUNCH", cutoffTime: "09:00", serviceTime: "12:30", leadTimeMinutes: 30 },
    { brand: "UNILIV", mealType: "SNACKS", cutoffTime: "14:00", serviceTime: "17:00", leadTimeMinutes: 20 },
    { brand: "UNILIV", mealType: "DINNER", cutoffTime: "15:00", serviceTime: "20:00", leadTimeMinutes: 30 },
    { brand: "UNILIV", mealType: "NIGHT_MILK", cutoffTime: "19:00", serviceTime: "21:30", leadTimeMinutes: 15 },
    { brand: "HUDDLE", mealType: "BREAKFAST", cutoffTime: "21:00", serviceTime: "08:00", leadTimeMinutes: 30 },
    { brand: "HUDDLE", mealType: "LUNCH", cutoffTime: "09:00", serviceTime: "12:30", leadTimeMinutes: 30 },
    { brand: "HUDDLE", mealType: "SNACKS", cutoffTime: "14:00", serviceTime: "17:00", leadTimeMinutes: 20 },
    { brand: "HUDDLE", mealType: "DINNER", cutoffTime: "15:00", serviceTime: "20:00", leadTimeMinutes: 30 },
  ];
  await db.insert(foodMealWindowsTable).values(windows.map((w) => ({
    id: id(), brand: w.brand as never, propertyId: null, mealType: w.mealType as never,
    cutoffTime: w.cutoffTime, serviceTime: w.serviceTime, leadTimeMinutes: w.leadTimeMinutes,
    isActive: true, updatedAt: new Date(),
  })));
  console.log(`  ✓ ${windows.length} meal windows`);
}

async function seedKitchens() {
  console.log("  kitchens...");
  const kitchens = [
    { code: "KIT-BLR-KMG", name: "Bengaluru Koramangala Central Kitchen", brand: null, address: "12 Tech Park Ave, Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", contactName: "Rajesh Iyer", contactPhone: "9980012340", clusterId: "cluster_blr_koramangala" },
    { code: "KIT-BLR-WF", name: "Bengaluru Whitefield Kitchen", brand: "UNILIV", address: "456 ITPL Main Rd, Whitefield", city: "Bengaluru", state: "Karnataka", pincode: "560066", contactName: "Meera Patel", contactPhone: "9980012341", clusterId: "cluster_blr_whitefield" },
    { code: "KIT-PUN-HINJ", name: "Pune Hinjewadi Kitchen", brand: "HUDDLE", address: "789 Rajiv Gandhi Infotech Park", city: "Pune", state: "Maharashtra", pincode: "411057", contactName: "Vikram Sharma", contactPhone: "9980012342", clusterId: "cluster_pune_hinjewadi" },
    { code: "KIT-DEL-CEN", name: "Delhi Central Kitchen", brand: null, address: "5 Connaught Place", city: "New Delhi", state: "Delhi", pincode: "110001", contactName: "Anil Kapoor", contactPhone: "9980012343", clusterId: "cluster_delhi_central" },
  ];
  for (const k of kitchens) {
    await db.insert(kitchensTable)
      .values({ id: `kitchen_${k.code.toLowerCase().replace(/-/g, "_")}`, name: k.name, code: k.code, brand: k.brand as never, address: k.address, city: k.city, state: k.state, pincode: k.pincode, contactName: k.contactName, contactPhone: k.contactPhone, clusterId: k.clusterId, isActive: true, updatedAt: new Date() })
      .onConflictDoNothing({ target: kitchensTable.code });
  }
  console.log(`  ✓ ${kitchens.length} kitchens`);
}

async function assignResidentialProperties() {
  console.log("  reassigning unit leads to residential properties (with guests)...");
  const rows = (await pool.query(
    `SELECT p.id, count(r.*) FILTER (WHERE r.status='ACTIVE') AS active
       FROM properties p LEFT JOIN residents r ON r.property_id = p.id
      WHERE p.total_beds > 0
      GROUP BY p.id ORDER BY active DESC, p.id`,
  )).rows as Array<{ id: string }>;
  if (rows.length < 2) { console.log("  ✓ not enough residential properties"); return; }
  // Top residential property → unit2, next → unit1 (both have guests + beds + revenue).
  const leads = [
    { u: "user_food_unit2", p: rows[0]!.id },
    { u: "user_food_unit1", p: rows[1]!.id },
  ];
  for (const l of leads) {
    await db.update(usersTable).set({ propertyId: l.p, updatedAt: new Date() }).where(eq(usersTable.id, l.u));
    await pool.query(`UPDATE user_scopes SET property_id=$1 WHERE user_id=$2 AND scope_level='PROPERTY'`, [l.p, l.u]);
    await pool.query(`UPDATE food_orders SET property_id=$1 WHERE unit_lead_id=$2`, [l.p, l.u]);
    await pool.query(`UPDATE food_order_batches SET property_id=$1 WHERE unit_lead_id=$2`, [l.p, l.u]);
  }
  console.log(`  ✓ assigned ${leads.length} unit leads to residential properties`);
}

async function groupDispatchTrip() {
  console.log("  dispatch trip for existing DISPATCHED orders...");
  const orders = await db.select().from(foodOrdersTable).where(and(eq(foodOrdersTable.status, "DISPATCHED"), isNull(foodOrdersTable.dispatchId)));
  if (!orders.length) { console.log("  ✓ no unassigned dispatched orders"); return; }
  const now = new Date();
  const tripId = id();
  await db.insert(foodDispatchesTable).values({
    id: tripId,
    dispatchNumber: `DISP-${now.getFullYear()}-000001`,
    kitchenId: "kitchen_kit_blr_kmg",
    deliveryPartnerId: orders[0]!.deliveryPartnerId ?? "dp_swift",
    vehicleNumber: "KA05AB5001", driverName: "Ravi Kumar", driverPhone: "9876543210",
    dispatchedById: "user_food_fnbsup", dispatchedAt: now,
    estimatedArrivalAt: new Date(now.getTime() + 90 * 60000), status: "IN_TRANSIT",
    notes: "Auto-grouped seed trip", updatedAt: now,
  }).onConflictDoNothing({ target: foodDispatchesTable.dispatchNumber });
  for (const o of orders) {
    await db.update(foodOrdersTable).set({ dispatchId: tripId, kitchenId: "kitchen_kit_blr_kmg", updatedAt: now }).where(eq(foodOrdersTable.id, o.id));
  }
  console.log(`  ✓ grouped ${orders.length} order(s) into a trip`);
}

async function main() {
  console.log("Seeding Phase 1–3 supplemental data...");
  await seedConfig();
  await backfillUsers();
  await seedMealConfig();
  await seedMealWindows();
  await seedKitchens();
  await assignResidentialProperties();
  await groupDispatchTrip();
  console.log("✅ Supplemental food data seeded");
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
