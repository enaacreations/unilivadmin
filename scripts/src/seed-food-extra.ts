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
  ];
  for (const m of meals) {
    await db.insert(foodMealConfigTable)
      .values({ id: id(), mealType: m.mealType as never, displayLabel: m.displayLabel, brand: m.brand as never, sortOrder: m.sortOrder, isEnabled: true, updatedAt: new Date() })
      .onConflictDoUpdate({ target: foodMealConfigTable.mealType, set: { displayLabel: m.displayLabel, sortOrder: m.sortOrder, updatedAt: new Date() } });
  }
  console.log(`  ✓ ${meals.length} meal configs`);
}

async function seedMealWindows() {
  console.log("  meal windows (per-meal service times)...");
  // Reset global defaults to stay idempotent.
  await pool.query(`DELETE FROM "food_meal_windows" WHERE property_id IS NULL`);
  // Cut-off is now a single brand value (seedCutoffs); windows carry per-meal service/lead only.
  const windows = [
    { brand: "UNILIV", mealType: "BREAKFAST", serviceTime: "08:00", leadTimeMinutes: 30 },
    { brand: "UNILIV", mealType: "LUNCH", serviceTime: "12:30", leadTimeMinutes: 30 },
    { brand: "UNILIV", mealType: "SNACKS", serviceTime: "17:00", leadTimeMinutes: 20 },
    { brand: "UNILIV", mealType: "DINNER", serviceTime: "20:00", leadTimeMinutes: 30 },
    { brand: "HUDDLE", mealType: "BREAKFAST", serviceTime: "08:00", leadTimeMinutes: 30 },
    { brand: "HUDDLE", mealType: "LUNCH", serviceTime: "12:30", leadTimeMinutes: 30 },
    { brand: "HUDDLE", mealType: "SNACKS", serviceTime: "17:00", leadTimeMinutes: 20 },
    { brand: "HUDDLE", mealType: "DINNER", serviceTime: "20:00", leadTimeMinutes: 30 },
  ];
  await db.insert(foodMealWindowsTable).values(windows.map((w) => ({
    id: id(), brand: w.brand as never, propertyId: null, mealType: w.mealType as never,
    cutoffTime: null, serviceTime: w.serviceTime, leadTimeMinutes: w.leadTimeMinutes,
    isActive: true, updatedAt: new Date(),
  })));
  console.log(`  ✓ ${windows.length} meal windows`);
}

async function seedCutoffs() {
  console.log("  single cut-off per brand...");
  // One global cut-off per brand (applies to all meals). Idempotent reset.
  await pool.query(`DELETE FROM "food_cutoffs" WHERE property_id IS NULL`);
  const brands = ["UNILIV", "HUDDLE"];
  for (const brand of brands) {
    await pool.query(
      `INSERT INTO food_cutoffs (id, brand, property_id, cutoff_time, is_active, created_at, updated_at)
       VALUES ($1,$2,NULL,'21:00',true,now(),now())`,
      [id(), brand],
    );
  }
  console.log(`  ✓ ${brands.length} brand cut-offs (21:00)`);
}

async function seedKitchens() {
  console.log("  kitchens...");
  const kitchens = [
    { code: "KIT-BLR-KMG", name: "Bengaluru Koramangala Central Kitchen", brand: null, address: "12 Tech Park Ave, Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", contactName: "Rajesh Iyer", contactPhone: "9980012340", clusterId: "cluster_blr_koramangala" },
    { code: "KIT-BLR-WF", name: "Bengaluru Whitefield Kitchen", brand: "UNILIV", address: "456 ITPL Main Rd, Whitefield", city: "Bengaluru", state: "Karnataka", pincode: "560066", contactName: "Meera Patel", contactPhone: "9980012341", clusterId: "cluster_blr_whitefield" },
    { code: "KIT-PUN-HINJ", name: "Pune Hinjewadi Kitchen", brand: "HUDDLE", address: "789 Rajiv Gandhi Infotech Park", city: "Pune", state: "Maharashtra", pincode: "411057", contactName: "Vikram Sharma", contactPhone: "9980012342", clusterId: "cluster_pune_hinjewadi" },
    { code: "KIT-DEL-CEN", name: "Delhi Central Kitchen", brand: null, address: "5 Connaught Place", city: "New Delhi", state: "Delhi", pincode: "110001", contactName: "Anil Kapoor", contactPhone: "9980012343", clusterId: "cluster_delhi_central" },
    { code: "KIT-GGN-CH", name: "Gurugram Cyber Hub Kitchen", brand: null, address: "DLF Cyber Hub, Phase 2", city: "Gurugram", state: "Haryana", pincode: "122002", contactName: "Pooja Nair", contactPhone: "9980012344", clusterId: "cluster_ggn_cyberhub" },
    { code: "KIT-MUM-AND", name: "Mumbai Andheri Kitchen", brand: null, address: "Andheri East, MIDC", city: "Mumbai", state: "Maharashtra", pincode: "400093", contactName: "Sameer Joshi", contactPhone: "9980012345", clusterId: "cluster_mumbai_andheri" },
    // New cities' clusters are created by seed:food (not seed:food-extra), so keep
    // these kitchens cluster-less here to stay runnable standalone; the city text
    // drives property→kitchen matching (cluster is optional).
    { code: "KIT-NOI-S104", name: "Noida Sector 104 Kitchen", brand: null, address: "Sector 104, Noida", city: "Noida", state: "Uttar Pradesh", pincode: "201304", contactName: "Ritu Sharma", contactPhone: "9980012346", clusterId: null },
    { code: "KIT-JAI-SIT", name: "Jaipur Sitapura Kitchen", brand: null, address: "Sitapura Industrial Area", city: "Jaipur", state: "Rajasthan", pincode: "302022", contactName: "Mahesh Saini", contactPhone: "9980012347", clusterId: null },
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
  // unit2 → top property; unit1 → next property + (if available) a 2nd property to
  // demo a unit lead managing MULTIPLE properties. Scope rows are rebuilt from
  // scratch each run so re-seeding stays idempotent (no duplicate/clobbered rows).
  const leads: Array<{ u: string; primary: string; props: string[] }> = [
    { u: "user_food_unit2", primary: rows[0]!.id, props: [rows[0]!.id] },
    { u: "user_food_unit1", primary: rows[1]!.id, props: rows[2] ? [rows[1]!.id, rows[2]!.id] : [rows[1]!.id] },
  ];
  for (const l of leads) {
    await db.update(usersTable).set({ propertyId: l.primary, updatedAt: new Date() }).where(eq(usersTable.id, l.u));
    await pool.query(`DELETE FROM user_scopes WHERE user_id=$1 AND scope_level='PROPERTY'`, [l.u]);
    for (const p of l.props) {
      await pool.query(
        `INSERT INTO user_scopes (id, user_id, scope_level, property_id, created_at) VALUES ($1,$2,'PROPERTY',$3,now())`,
        [id(), l.u, p],
      );
    }
    // Existing orders/batches for this lead point at the PRIMARY property.
    await pool.query(`UPDATE food_orders SET property_id=$1 WHERE unit_lead_id=$2`, [l.primary, l.u]);
    await pool.query(`UPDATE food_order_batches SET property_id=$1 WHERE unit_lead_id=$2`, [l.primary, l.u]);
  }
  const total = leads.reduce((n, l) => n + l.props.length, 0);
  console.log(`  ✓ tagged ${leads.length} unit leads to ${total} properties (unit1 multi-property)`);
}

async function groupDispatchTrip() {
  console.log("  dispatch trip for existing DISPATCHED orders...");
  const orders = await db.select().from(foodOrdersTable).where(and(eq(foodOrdersTable.status, "DISPATCHED"), isNull(foodOrdersTable.dispatchId)));
  if (!orders.length) { console.log("  ✓ no unassigned dispatched orders"); return; }
  const now = new Date();
  const tripId = id();
  // Unique dispatch number (timestamp) so we never collide with seed:demo trips —
  // a collision would skip the insert and leave the order FK dangling.
  await db.insert(foodDispatchesTable).values({
    id: tripId,
    dispatchNumber: `DISP-SEED-${now.getTime()}`,
    // Use whatever kitchen the orders already belong to (preserve the per-city
    // assignment); fall back to a real kitchen id only if none is set.
    kitchenId: orders[0]!.kitchenId ?? "kitchen_kit_blr_kmg",
    deliveryPartnerId: orders[0]!.deliveryPartnerId ?? "dp_swift",
    vehicleNumber: "KA05AB5001", driverName: "Ravi Kumar", driverPhone: "9876543210",
    dispatchedById: "user_food_fnbsup", dispatchedAt: now,
    estimatedArrivalAt: new Date(now.getTime() + 90 * 60000), status: "IN_TRANSIT",
    notes: "Auto-grouped seed trip", updatedAt: now,
  });
  for (const o of orders) {
    // Link the trip; do NOT rewrite kitchen_id — keep each order's own kitchen.
    await db.update(foodOrdersTable).set({ dispatchId: tripId, updatedAt: now }).where(eq(foodOrdersTable.id, o.id));
  }
  console.log(`  ✓ grouped ${orders.length} order(s) into a trip`);
}

/* ── New-model backfill (brands, City→Kitchen→Property, per-item ordering) ───── */

async function seedBrands() {
  console.log("  food brands (master)...");
  const brands = [
    { code: "UNILIV", name: "Uniliv" },
    { code: "HUDDLE", name: "Huddle" },
  ];
  for (const b of brands) {
    await pool.query(
      `INSERT INTO food_brands (id, code, name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,true,now(),now()) ON CONFLICT (code) DO NOTHING`,
      [id(), b.code, b.name],
    );
  }
  console.log(`  ✓ ${brands.length} brands`);
}

async function assignKitchenCities() {
  console.log("  kitchens → cities...");
  const r = await pool.query(
    `UPDATE kitchens k SET city_id = c.city_id, updated_at = now()
       FROM clusters c
      WHERE k.cluster_id = c.id AND k.city_id IS DISTINCT FROM c.city_id`,
  );
  console.log(`  ✓ ${r.rowCount} kitchens linked to cities`);
}

async function assignPropertyKitchensByCity() {
  console.log("  properties → kitchen STRICTLY by property city + cluster realign...");
  // Authoritative city-based assignment: every property gets a kitchen IN ITS
  // OWN city (matching properties.city text), never a different-city kitchen.
  // Mirrors the prod SQL already applied so re-seeding stays consistent.
  //
  // Rules:
  //   • Bengaluru — Koramangala-named props → Koramangala kitchen,
  //     Whitefield-named → Whitefield kitchen, else lowest-id BLR kitchen.
  //   • New Delhi / Delhi → Delhi Central; Gurgaon/Gurugram → Gurugram Cyber Hub;
  //     Mumbai → Mumbai Andheri; Pune → Pune Hinjewadi; Noida/Greater Noida →
  //     Noida kitchen; Jaipur → Jaipur kitchen.
  //   • Cluster is realigned to a same-city cluster so cluster.city_id agrees
  //     with the kitchen's city (downstream code derives city via cluster).
  const { rows: kitchens } = await pool.query<{ id: string; name: string; city: string; cluster_id: string | null }>(
    `SELECT id, name, lower(coalesce(city,'')) AS city, cluster_id FROM kitchens WHERE is_active = true`,
  );
  // Map "city token" → kitchen id. For Bengaluru we keep BOTH named kitchens.
  const kitchenByCity = new Map<string, string>();   // lowest-id kitchen per city
  const blrKoramangala = kitchens.find((k) => /koramangala/i.test(k.name))?.id;
  const blrWhitefield = kitchens.find((k) => /whitefield/i.test(k.name))?.id;
  // cluster id keyed by lower-cased kitchen city (a same-city cluster to realign to)
  const clusterByCity = new Map<string, string>();
  const { rows: clusterRows } = await pool.query<{ id: string; city_id: string }>(
    `SELECT cl.id, cl.city_id FROM clusters cl`,
  );
  const { rows: cityRows } = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM cities`);
  const cityNameById = new Map(cityRows.map((c) => [c.id, c.name.toLowerCase()]));
  for (const cl of clusterRows) {
    const cn = cityNameById.get(cl.city_id);
    if (cn && !clusterByCity.has(cn)) clusterByCity.set(cn, cl.id);
  }
  for (const k of [...kitchens].sort((a, b) => a.id.localeCompare(b.id))) {
    if (k.city && !kitchenByCity.has(k.city)) kitchenByCity.set(k.city, k.id);
  }
  // Normalise a property's city to a kitchen-city token.
  const cityToken = (c: string): string => {
    const x = (c || "").trim().toLowerCase();
    if (x === "gurgaon" || x === "gurugram") return "gurugram";
    if (x === "new delhi" || x === "delhi") return "new delhi";
    if (x === "greater noida" || x === "noida") return "noida";
    return x;
  };
  const resolveKitchen = (name: string, city: string): string | null => {
    const x = cityToken(city);
    if (x === "bengaluru" || x === "bangalore") {
      if (/koramangala/i.test(name) && blrKoramangala) return blrKoramangala;
      if (/whitefield/i.test(name) && blrWhitefield) return blrWhitefield;
      return kitchenByCity.get("bengaluru") ?? blrKoramangala ?? blrWhitefield ?? null;
    }
    // Delhi kitchen's city text is "New Delhi"; index covers both via token.
    return kitchenByCity.get(x) ?? kitchenByCity.get("new delhi") ?? null;
  };
  const resolveCluster = (city: string): string | null => {
    const x = cityToken(city);
    if (x === "bengaluru" || x === "bangalore") return clusterByCity.get("bengaluru") ?? null;
    return clusterByCity.get(x) ?? clusterByCity.get("new delhi") ?? clusterByCity.get("delhi") ?? null;
  };

  const { rows: props } = await pool.query<{ id: string; name: string; city: string; kitchen_id: string | null; cluster_id: string | null }>(
    `SELECT id, name, city, kitchen_id, cluster_id FROM properties`,
  );
  let kFixed = 0;
  let clFixed = 0;
  let unresolved = 0;
  for (const p of props) {
    const kid = resolveKitchen(p.name, p.city);
    if (!kid) { unresolved++; continue; }
    if (p.kitchen_id !== kid) {
      await pool.query(`UPDATE properties SET kitchen_id=$1, updated_at=now() WHERE id=$2`, [kid, p.id]);
      kFixed++;
    }
    const clid = resolveCluster(p.city);
    if (clid && p.cluster_id !== clid) {
      await pool.query(`UPDATE properties SET cluster_id=$1, updated_at=now() WHERE id=$2`, [clid, p.id]);
      clFixed++;
    }
  }
  console.log(`  ✓ ${kFixed} props → same-city kitchen, ${clFixed} props → same-city cluster${unresolved ? `, ${unresolved} unresolved (no kitchen in city)` : ""}`);
}

async function assignPropertyKitchensAndBrands() {
  console.log("  properties → kitchen (by city) + brand...");
  // Each property → a kitchen in its city (lowest id when several). Property's city
  // comes via its cluster (cluster.city_id), since properties have no direct city FK.
  const k = await pool.query(
    `UPDATE properties p SET kitchen_id = sub.kid, updated_at = now()
       FROM (
         SELECT c.id AS cluster_id,
                (SELECT k2.id FROM kitchens k2 WHERE k2.city_id = c.city_id AND k2.is_active ORDER BY k2.id LIMIT 1) AS kid
           FROM clusters c
       ) sub
      WHERE p.cluster_id = sub.cluster_id AND sub.kid IS NOT NULL
        AND p.kitchen_id IS DISTINCT FROM sub.kid`,
  );
  const br = await pool.query(
    `UPDATE properties
        SET brand = CASE WHEN upper(name) LIKE '%HUDDLE%' THEN 'HUDDLE' ELSE 'UNILIV' END,
            updated_at = now()
      WHERE brand IS NULL`,
  );
  console.log(`  ✓ ${k.rowCount} properties → kitchen, ${br.rowCount} → brand`);
}

async function seedFoodSystemConfig() {
  console.log("  food system_config defaults (cut-off + waste window)...");
  // Canonical keys (raw JSON scalars). Readers live in food-service.ts
  // (getDefaultCutoffTime / getWasteEditWindowMs). Idempotent upsert: keep
  // description fresh but do NOT clobber an operator-tuned value blindly — we
  // set the documented defaults here so a fresh DB resolves correctly.
  const cfg: Array<{ key: string; value: string | number; description: string }> = [
    { key: "food_default_cutoff", value: "09:00", description: "Global default order cut-off time (HH:MM 24h) applied when no brand/property cut-off row exists." },
    { key: "food_waste_edit_window_minutes", value: 60, description: "Minutes after delivery during which waste quantities remain editable (PRD §7.7)." },
  ];
  for (const c of cfg) {
    await db.insert(systemConfigTable)
      .values({ id: id(), key: c.key, value: c.value as never, description: c.description, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: c.value as never, description: c.description, updatedAt: new Date() } });
  }
  console.log(`  ✓ ${cfg.length} food config keys (food_default_cutoff, food_waste_edit_window_minutes)`);
}

async function seedKitchenPincodes() {
  console.log("  kitchen_pincodes (property pincode → kitchen)...");
  // pincode is GLOBALLY UNIQUE (one kitchen per pincode; a kitchen serves many).
  // Cover EVERY existing property pincode so downstream auto-derivation resolves.
  // Resolve each property's kitchen: property.kitchen_id if set, else the
  // lowest-id active kitchen in the property's city (via cluster.city_id).
  // Skip-on-conflict keeps this idempotent and respects the global-unique rule
  // (if two properties share a pincode, the first mapping wins — intended).
  const r = await pool.query(
    `INSERT INTO kitchen_pincodes (id, kitchen_id, pincode, is_active, created_at, updated_at)
       SELECT gen_random_uuid()::text, sub.kid, sub.pincode, true, now(), now()
         FROM (
           SELECT DISTINCT ON (p.pincode)
                  p.pincode,
                  COALESCE(
                    p.kitchen_id,
                    (SELECT k.id FROM kitchens k
                       JOIN clusters c2 ON c2.city_id = k.city_id
                      WHERE c2.id = p.cluster_id AND k.is_active
                      ORDER BY k.id LIMIT 1)
                  ) AS kid
             FROM properties p
            WHERE p.pincode IS NOT NULL
            ORDER BY p.pincode, p.kitchen_id NULLS LAST
         ) sub
        WHERE sub.kid IS NOT NULL
     ON CONFLICT (pincode) DO NOTHING`,
  );
  console.log(`  ✓ ${r.rowCount} kitchen_pincodes inserted (existing skipped)`);
}

async function backfillPropertyBrandAndKitchen() {
  console.log("  backfill properties → kitchen + brand (none left NULL)...");
  // 1) kitchen_id: derive from the property's pincode via kitchen_pincodes
  //    (authoritative once seedKitchenPincodes has run); fall back to the
  //    lowest-id active kitchen in the property's city. Idempotent via IS DISTINCT FROM.
  const k = await pool.query(
    `UPDATE properties p
        SET kitchen_id = sub.kid, updated_at = now()
       FROM (
         SELECT p2.id,
                COALESCE(
                  p2.kitchen_id,
                  (SELECT kp.kitchen_id FROM kitchen_pincodes kp
                    WHERE kp.pincode = p2.pincode AND kp.is_active LIMIT 1),
                  (SELECT k.id FROM kitchens k
                     JOIN clusters c ON c.city_id = k.city_id
                    WHERE c.id = p2.cluster_id AND k.is_active
                    ORDER BY k.id LIMIT 1)
                ) AS kid
           FROM properties p2
       ) sub
      WHERE p.id = sub.id AND sub.kid IS NOT NULL
        AND p.kitchen_id IS DISTINCT FROM sub.kid`,
  );
  // 2) brand: kitchen.brand if present, else keep existing, else default 'UNILIV'.
  //    Preserve already-set values (only fill where it changes / is NULL).
  const br = await pool.query(
    `UPDATE properties p
        SET brand = COALESCE(k.brand, p.brand, 'UNILIV'), updated_at = now()
       FROM kitchens k
      WHERE p.kitchen_id = k.id
        AND p.brand IS DISTINCT FROM COALESCE(k.brand, p.brand, 'UNILIV')`,
  );
  // 3) any property still lacking a brand (e.g. no kitchen.brand and was NULL) → default.
  const def = await pool.query(
    `UPDATE properties SET brand = 'UNILIV', updated_at = now() WHERE brand IS NULL`,
  );
  console.log(`  ✓ ${k.rowCount} props → kitchen, ${br.rowCount} props → brand, ${def.rowCount} props → default brand`);
}

async function setDishBrands() {
  console.log("  dishes → brand tags...");
  const r = await pool.query(
    `UPDATE dishes SET brands = ARRAY['UNILIV','HUDDLE']::text[], updated_at = now()
      WHERE brands IS NULL OR cardinality(brands) = 0`,
  );
  console.log(`  ✓ ${r.rowCount} dishes tagged (UNILIV + HUDDLE)`);
}

async function seedKitchenMenus() {
  console.log("  per-kitchen menu rotation (copy brand templates → each kitchen)...");
  // seed-food.ts builds brand-level rotation rows with kitchen_id NULL (templates).
  // Copy each template into every active kitchen so menus resolve per (kitchen, brand).
  await pool.query(`DELETE FROM food_menu_rotation WHERE kitchen_id IS NOT NULL`);
  const r = await pool.query(
    `INSERT INTO food_menu_rotation
       (id, kitchen_id, brand, rotation_week, day_of_week, meal_type, dish_id, slot_label, sort_order, effective_from, effective_to, is_active, created_at, updated_at)
     SELECT gen_random_uuid()::text, k.id, t.brand, t.rotation_week, t.day_of_week, t.meal_type, t.dish_id, t.slot_label, t.sort_order, t.effective_from, t.effective_to, t.is_active, now(), now()
       FROM food_menu_rotation t CROSS JOIN kitchens k
      WHERE t.kitchen_id IS NULL AND k.is_active = true`,
  );
  console.log(`  ✓ ${r.rowCount} per-kitchen rotation rows`);
}

async function backfillOrdersAndItems() {
  console.log("  orders → kitchen, order items → persons_count...");
  const ok = await pool.query(
    `UPDATE food_orders o SET kitchen_id = p.kitchen_id, updated_at = now()
       FROM properties p
      WHERE o.property_id = p.id AND p.kitchen_id IS NOT NULL
        AND o.kitchen_id IS DISTINCT FROM p.kitchen_id`,
  );
  const oi = await pool.query(
    `UPDATE food_order_items i SET persons_count = o.residents_count
       FROM food_orders o
      WHERE i.order_id = o.id AND i.persons_count IS NULL`,
  );
  console.log(`  ✓ ${ok.rowCount} orders → kitchen, ${oi.rowCount} items → persons_count`);
}

async function migrateGeoScopes() {
  console.log("  migrate ZONE/CLUSTER scopes → CITY/KITCHEN...");
  // ZONE (retired) → CITY; CLUSTER (retired) → KITCHEN. Demos the new scope levels.
  const moves: Array<[string, string]> = [
    [`UPDATE user_scopes SET scope_level='CITY', city_id='city_bengaluru', zone_id=NULL WHERE user_id='user_food_fnbzonal' AND scope_level='ZONE'`, "fnbzonal → CITY Bengaluru"],
    [`UPDATE user_scopes SET scope_level='CITY', city_id='city_pune', zone_id=NULL WHERE user_id='user_food_zonal' AND scope_level='ZONE'`, "zonal → CITY Pune"],
    [`UPDATE user_scopes SET scope_level='KITCHEN', kitchen_id='kitchen_kit_blr_kmg', cluster_id=NULL WHERE user_id='user_food_cluster' AND scope_level='CLUSTER'`, "cluster → KITCHEN BLR-KMG"],
    [`UPDATE user_scopes SET scope_level='KITCHEN', kitchen_id='kitchen_kit_del_cen', cluster_id=NULL WHERE user_id='user_food_fnbsup' AND scope_level='CLUSTER'`, "fnbsup → KITCHEN DEL-CEN"],
  ];
  for (const [sql] of moves) await pool.query(sql);
  console.log(`  ✓ migrated ${moves.length} geo scopes`);
}

async function seedIngredients() {
  console.log("  ingredients + dish ingredients...");
  // ── Ingredients master ──────────────────────────────────────────────────
  // Realistic Indian-kitchen pantry. Each row = [id, name, base unit].
  // Base unit: KG for solids/produce/grains/pulses, LITRE for milk/oil/ghee/
  // curd, GRAM for spices used in tiny amounts, PCS for bread.
  const mats: Array<[string, string, string]> = [
    // Aromatics & produce
    ["rm_aloo", "Aloo (Potato)", "KG"],
    ["rm_pyaaz", "Pyaaz (Onion)", "KG"],
    ["rm_tomato", "Tomato", "KG"],
    ["rm_adrak", "Adrak (Ginger)", "KG"],
    ["rm_lehsun", "Lehsun (Garlic)", "KG"],
    ["rm_hari_mirch", "Hari Mirch (Green Chilli)", "KG"],
    ["rm_dhaniya", "Hara Dhaniya (Coriander)", "KG"],
    // Vegetables
    ["rm_gobi", "Gobi (Cauliflower)", "KG"],
    ["rm_bhindi", "Bhindi (Okra)", "KG"],
    ["rm_baingan", "Baingan (Brinjal)", "KG"],
    ["rm_lauki", "Lauki (Bottle Gourd)", "KG"],
    ["rm_matar", "Matar (Peas)", "KG"],
    ["rm_palak", "Palak (Spinach)", "KG"],
    ["rm_methi", "Methi (Fenugreek)", "KG"],
    ["rm_mixed_veg", "Mixed Vegetables", "KG"],
    // Flours & grains
    ["rm_atta", "Atta (Wheat Flour)", "KG"],
    ["rm_maida", "Maida (Refined Flour)", "KG"],
    ["rm_sooji", "Sooji (Semolina)", "KG"],
    ["rm_besan", "Besan (Gram Flour)", "KG"],
    ["rm_rice", "Chawal (Rice)", "KG"],
    ["rm_poha", "Poha (Flattened Rice)", "KG"],
    ["rm_sabudana", "Sabudana (Sago)", "KG"],
    ["rm_sevaiya", "Sevaiya (Vermicelli)", "KG"],
    ["rm_bread", "Bread", "PCS"],
    // Pulses
    ["rm_toor_dal", "Toor Dal", "KG"],
    ["rm_moong_dal", "Moong Dal", "KG"],
    ["rm_chana_dal", "Chana Dal", "KG"],
    ["rm_masoor_dal", "Masoor Dal", "KG"],
    ["rm_urad_dal", "Urad Dal", "KG"],
    ["rm_rajma", "Rajma", "KG"],
    ["rm_chana", "Kabuli Chana", "KG"],
    // Dairy & fats
    ["rm_paneer", "Paneer", "KG"],
    ["rm_dahi", "Dahi (Curd)", "LITRE"],
    ["rm_doodh", "Doodh (Milk)", "LITRE"],
    ["rm_khoya", "Khoya (Milk Solids)", "KG"],
    ["rm_ghee", "Desi Ghee", "LITRE"],
    ["rm_oil", "Cooking Oil", "LITRE"],
    // Pantry & spices
    ["rm_cheeni", "Cheeni (Sugar)", "KG"],
    ["rm_namak", "Namak (Salt)", "KG"],
    ["rm_garam_masala", "Garam Masala (Mixed Spices)", "G"],
    ["rm_chai_patti", "Chai Patti (Tea Leaves)", "G"],
    ["rm_coffee", "Coffee", "G"],
    // Dry fruits & garnish
    ["rm_mungfali", "Mungfali (Peanuts)", "KG"],
    ["rm_nariyal", "Nariyal (Coconut)", "KG"],
    ["rm_kaju", "Kaju (Cashew)", "KG"],
    ["rm_kishmish", "Kishmish (Raisins)", "KG"],
    ["rm_fruit", "Seasonal Fruit", "KG"],
  ];
  for (const [rid, name, unit] of mats) {
    await pool.query(
      `INSERT INTO ingredients (id, name, unit, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,true,now(),now())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, updated_at=now()`,
      [rid, name, unit],
    );
  }
  // Quick lookup of an ingredient's base unit (so each dish_ingredient row
  // carries the ingredient's own unit, not a blanket 'KG').
  const unitOf = new Map(mats.map(([rid, , unit]) => [rid, unit]));

  // ── Dish → ingredient mapping (authentic Indian cooking, 3-7 each) ───────
  // Quantities are per-batch reference amounts in the ingredient's base unit;
  // realistic relative magnitudes (mains 0.08-0.18 KG, spices a few grams,
  // milk/oil/ghee in litres). EVERY one of the 55 dishes is mapped below.
  const links: Array<{ dish: string; mats: Array<[string, string]> }> = [
    // ── Breakfast hot food ──────────────────────────────────────────────
    { dish: "dish_poha", mats: [["rm_poha", "0.08"], ["rm_pyaaz", "0.03"], ["rm_aloo", "0.03"], ["rm_mungfali", "0.01"], ["rm_oil", "0.01"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_upma", mats: [["rm_sooji", "0.08"], ["rm_mixed_veg", "0.04"], ["rm_oil", "0.01"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_aloo_paratha", mats: [["rm_atta", "0.1"], ["rm_aloo", "0.08"], ["rm_pyaaz", "0.02"], ["rm_hari_mirch", "0.005"], ["rm_ghee", "0.02"]] },
    { dish: "dish_idli_sambar", mats: [["rm_rice", "0.06"], ["rm_urad_dal", "0.03"], ["rm_toor_dal", "0.03"], ["rm_mixed_veg", "0.04"], ["rm_tomato", "0.03"]] },
    { dish: "dish_masala_dosa", mats: [["rm_rice", "0.07"], ["rm_urad_dal", "0.03"], ["rm_aloo", "0.06"], ["rm_pyaaz", "0.03"], ["rm_oil", "0.01"]] },
    { dish: "dish_veg_sandwich", mats: [["rm_bread", "2"], ["rm_tomato", "0.03"], ["rm_mixed_veg", "0.04"], ["rm_dhaniya", "0.005"]] },
    { dish: "dish_vermicelli", mats: [["rm_sevaiya", "0.07"], ["rm_mixed_veg", "0.04"], ["rm_oil", "0.01"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_moong_cheela", mats: [["rm_moong_dal", "0.07"], ["rm_pyaaz", "0.02"], ["rm_hari_mirch", "0.005"], ["rm_oil", "0.01"]] },
    { dish: "dish_veg_cutlet", mats: [["rm_aloo", "0.07"], ["rm_mixed_veg", "0.05"], ["rm_besan", "0.02"], ["rm_oil", "0.02"]] },
    { dish: "dish_besan_cheela", mats: [["rm_besan", "0.07"], ["rm_pyaaz", "0.02"], ["rm_tomato", "0.02"], ["rm_oil", "0.01"]] },
    { dish: "dish_medu_vada", mats: [["rm_urad_dal", "0.07"], ["rm_rice", "0.01"], ["rm_oil", "0.03"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_uttapam", mats: [["rm_urad_dal", "0.04"], ["rm_rice", "0.06"], ["rm_pyaaz", "0.02"], ["rm_tomato", "0.02"], ["rm_oil", "0.01"]] },
    { dish: "dish_hash_brown", mats: [["rm_aloo", "0.12"], ["rm_maida", "0.02"], ["rm_oil", "0.02"]] },
    { dish: "dish_sabudana", mats: [["rm_sabudana", "0.08"], ["rm_aloo", "0.04"], ["rm_mungfali", "0.02"], ["rm_hari_mirch", "0.005"]] },
    // ── Veg mains (primary) ─────────────────────────────────────────────
    { dish: "dish_aloo_gobi", mats: [["rm_aloo", "0.08"], ["rm_gobi", "0.08"], ["rm_pyaaz", "0.04"], ["rm_tomato", "0.04"], ["rm_garam_masala", "3"]] },
    { dish: "dish_paneer_butter", mats: [["rm_paneer", "0.1"], ["rm_tomato", "0.08"], ["rm_doodh", "0.03"], ["rm_ghee", "0.02"], ["rm_kaju", "0.01"], ["rm_garam_masala", "4"]] },
    { dish: "dish_bhindi_masala", mats: [["rm_bhindi", "0.13"], ["rm_pyaaz", "0.04"], ["rm_tomato", "0.04"], ["rm_garam_masala", "3"]] },
    { dish: "dish_chana_masala", mats: [["rm_chana", "0.1"], ["rm_tomato", "0.05"], ["rm_pyaaz", "0.04"], ["rm_garam_masala", "4"]] },
    { dish: "dish_mix_veg", mats: [["rm_mixed_veg", "0.13"], ["rm_tomato", "0.04"], ["rm_pyaaz", "0.04"], ["rm_garam_masala", "3"]] },
    { dish: "dish_rajma", mats: [["rm_rajma", "0.1"], ["rm_tomato", "0.05"], ["rm_pyaaz", "0.04"], ["rm_adrak", "0.01"], ["rm_lehsun", "0.01"], ["rm_garam_masala", "4"]] },
    { dish: "dish_matar_paneer", mats: [["rm_paneer", "0.08"], ["rm_matar", "0.06"], ["rm_tomato", "0.05"], ["rm_pyaaz", "0.04"], ["rm_garam_masala", "3"]] },
    // ── Veg mains (second) ──────────────────────────────────────────────
    { dish: "dish_jeera_aloo", mats: [["rm_aloo", "0.14"], ["rm_oil", "0.01"], ["rm_hari_mirch", "0.005"], ["rm_garam_masala", "2"]] },
    { dish: "dish_dum_aloo", mats: [["rm_aloo", "0.13"], ["rm_tomato", "0.05"], ["rm_dahi", "0.03"], ["rm_garam_masala", "3"]] },
    { dish: "dish_lauki_kofta", mats: [["rm_lauki", "0.1"], ["rm_besan", "0.03"], ["rm_tomato", "0.05"], ["rm_pyaaz", "0.04"], ["rm_garam_masala", "3"]] },
    { dish: "dish_baingan_bharta", mats: [["rm_baingan", "0.12"], ["rm_pyaaz", "0.04"], ["rm_tomato", "0.05"], ["rm_garam_masala", "3"]] },
    { dish: "dish_aloo_methi", mats: [["rm_aloo", "0.1"], ["rm_methi", "0.06"], ["rm_pyaaz", "0.03"], ["rm_garam_masala", "2"]] },
    { dish: "dish_kadhi_pakora", mats: [["rm_besan", "0.05"], ["rm_dahi", "0.1"], ["rm_pyaaz", "0.03"], ["rm_oil", "0.02"]] },
    { dish: "dish_veg_kolhapuri", mats: [["rm_mixed_veg", "0.12"], ["rm_tomato", "0.05"], ["rm_pyaaz", "0.04"], ["rm_nariyal", "0.02"], ["rm_garam_masala", "4"]] },
    // ── Daily accompaniments ────────────────────────────────────────────
    { dish: "dish_dal_tadka", mats: [["rm_toor_dal", "0.06"], ["rm_tomato", "0.03"], ["rm_pyaaz", "0.02"], ["rm_adrak", "0.005"], ["rm_lehsun", "0.005"], ["rm_ghee", "0.01"], ["rm_garam_masala", "3"]] },
    { dish: "dish_steamed_rice", mats: [["rm_rice", "0.12"]] },
    { dish: "dish_ghee_chapatti", mats: [["rm_atta", "0.06"], ["rm_ghee", "0.01"]] },
    { dish: "dish_plain_chapatti", mats: [["rm_atta", "0.06"]] },
    { dish: "dish_green_salad", mats: [["rm_tomato", "0.03"], ["rm_pyaaz", "0.02"], ["rm_mixed_veg", "0.03"]] },
    { dish: "dish_curd", mats: [["rm_dahi", "0.1"]] },
    { dish: "dish_papad", mats: [["rm_maida", "0.01"], ["rm_oil", "0.005"]] },
    { dish: "dish_pickle", mats: [["rm_mixed_veg", "0.01"], ["rm_oil", "0.005"]] },
    { dish: "dish_chutney", mats: [["rm_dhaniya", "0.02"], ["rm_nariyal", "0.02"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_fruits", mats: [["rm_fruit", "0.1"]] },
    { dish: "dish_bakery", mats: [["rm_maida", "0.05"], ["rm_cheeni", "0.02"], ["rm_doodh", "0.02"]] },
    { dish: "dish_tea_coffee", mats: [["rm_chai_patti", "3"], ["rm_doodh", "0.1"], ["rm_cheeni", "0.01"]] },
    { dish: "dish_hot_milk", mats: [["rm_doodh", "0.2"], ["rm_cheeni", "0.01"]] },
    // ── Desserts ────────────────────────────────────────────────────────
    { dish: "dish_gulab_jamun", mats: [["rm_khoya", "0.05"], ["rm_maida", "0.02"], ["rm_cheeni", "0.05"], ["rm_oil", "0.02"]] },
    { dish: "dish_kheer", mats: [["rm_rice", "0.03"], ["rm_doodh", "0.15"], ["rm_cheeni", "0.03"], ["rm_kaju", "0.005"], ["rm_kishmish", "0.005"]] },
    { dish: "dish_fruit_custard", mats: [["rm_doodh", "0.12"], ["rm_cheeni", "0.03"], ["rm_fruit", "0.05"]] },
    { dish: "dish_suji_halwa", mats: [["rm_sooji", "0.06"], ["rm_ghee", "0.03"], ["rm_cheeni", "0.05"], ["rm_kishmish", "0.005"]] },
    { dish: "dish_rasgulla", mats: [["rm_paneer", "0.06"], ["rm_cheeni", "0.06"]] },
    { dish: "dish_moong_halwa", mats: [["rm_moong_dal", "0.06"], ["rm_ghee", "0.03"], ["rm_cheeni", "0.05"], ["rm_kaju", "0.005"]] },
    { dish: "dish_sevaiya", mats: [["rm_sevaiya", "0.05"], ["rm_doodh", "0.12"], ["rm_cheeni", "0.03"], ["rm_kishmish", "0.005"]] },
    // ── Evening snacks ──────────────────────────────────────────────────
    { dish: "dish_samosa", mats: [["rm_maida", "0.05"], ["rm_aloo", "0.08"], ["rm_matar", "0.02"], ["rm_oil", "0.03"], ["rm_garam_masala", "2"]] },
    { dish: "dish_veg_pakora", mats: [["rm_besan", "0.06"], ["rm_mixed_veg", "0.06"], ["rm_oil", "0.03"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_dhokla", mats: [["rm_besan", "0.08"], ["rm_dahi", "0.02"], ["rm_hari_mirch", "0.005"]] },
    { dish: "dish_bread_pakora", mats: [["rm_bread", "2"], ["rm_besan", "0.04"], ["rm_aloo", "0.04"], ["rm_oil", "0.03"]] },
    { dish: "dish_aloo_tikki", mats: [["rm_aloo", "0.1"], ["rm_besan", "0.02"], ["rm_oil", "0.02"], ["rm_garam_masala", "2"]] },
    { dish: "dish_spring_roll", mats: [["rm_maida", "0.04"], ["rm_mixed_veg", "0.06"], ["rm_oil", "0.03"]] },
    { dish: "dish_mathri", mats: [["rm_maida", "0.07"], ["rm_oil", "0.03"], ["rm_namak", "0.005"]] },
  ];
  let linked = 0;
  for (const l of links) {
    await pool.query(`DELETE FROM dish_ingredients WHERE dish_id=$1`, [l.dish]);
    for (const [rm, qty] of l.mats) {
      // Each row carries the ingredient's own base unit (fallback KG).
      const u = unitOf.get(rm) ?? "KG";
      await pool.query(
        `INSERT INTO dish_ingredients (id, dish_id, ingredient_id, quantity, unit, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,now(),now() WHERE EXISTS (SELECT 1 FROM dishes WHERE id=$2)`,
        [id(), l.dish, rm, qty, u],
      );
    }
    linked++;
  }
  console.log(`  ✓ ${mats.length} ingredients, ${linked} dishes linked`);
}

async function seedCompositionRules() {
  console.log("  menu composition rules...");
  // Culinarily sensible per-meal slot plans:
  //   LUNCH/DINNER = 1 Sabzi (main) + 1 Dal + Rice + Bread + Salad/Raita
  //                  (+ optional Dessert / Papad)
  //   BREAKFAST    = 1 Hot Food + Beverage + Fruits/Milk
  //   SNACKS       = 1 Snack + Beverage
  // Uniliv allows a 2nd sabzi (max 2); the brand-level max is kept generous so
  // the premium menu validates. Idempotent: clear brand-default rules for all
  // seeded meals, then re-insert.
  const allMeals = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];
  await pool.query(
    `DELETE FROM menu_composition_rules WHERE kitchen_id IS NULL AND meal_type IN ('BREAKFAST','LUNCH','SNACKS','DINNER')`,
  );
  const brands = ["UNILIV", "HUDDLE"];

  type Slot = { label: string; component: string; min: number; max: number | null };
  // Per-meal slot definitions. Uniliv gets a richer Sabzi/Hot-Food allowance.
  const slotsFor = (meal: string, brand: string): Slot[] => {
    const isUniliv = brand === "UNILIV";
    if (meal === "BREAKFAST") {
      return [
        { label: "Hot Food", component: "HOT_FOOD", min: 1, max: isUniliv ? 2 : 1 },
        { label: "Chutney", component: "CHUTNEY", min: 0, max: 1 },
        { label: "Fruits", component: "FRUITS", min: 1, max: 1 },
        { label: "Beverage", component: "BEVERAGE", min: 1, max: 1 },
        ...(isUniliv ? [{ label: "Milk", component: "MILK", min: 0, max: 1 } as Slot] : []),
      ];
    }
    if (meal === "SNACKS") {
      return [
        { label: "Snack", component: "SNACK", min: 1, max: 1 },
        { label: "Chutney", component: "CHUTNEY", min: 0, max: 1 },
        { label: "Beverage", component: "BEVERAGE", min: 1, max: 1 },
      ];
    }
    // LUNCH / DINNER
    return [
      { label: "Sabzi", component: "SABZI", min: 1, max: isUniliv ? 2 : 1 },
      { label: "Dal", component: "DAL", min: 1, max: 1 },
      { label: "Rice", component: "RICE", min: 1, max: 1 },
      { label: "Bread", component: "BREAD", min: 1, max: 1 },
      { label: "Salad / Raita", component: "SALAD", min: 1, max: 1 },
      { label: "Dessert", component: "DESSERT", min: 0, max: 1 },
      { label: "Papad", component: "PAPAD_PICKLE", min: 0, max: 1 },
    ];
  };

  let n = 0;
  for (const brand of brands) for (const meal of allMeals) {
    const rid = id();
    await pool.query(
      `INSERT INTO menu_composition_rules (id, brand, meal_type, kitchen_id, name, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,$4,true,now(),now())`,
      [rid, brand, meal, `Standard ${meal[0]}${meal.slice(1).toLowerCase()}`],
    );
    let i = 0;
    for (const s of slotsFor(meal, brand)) {
      await pool.query(
        `INSERT INTO menu_composition_slots (id, rule_id, slot_label, component, preparation, min_count, max_count, sort_order, created_at, updated_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,now(),now())`,
        [id(), rid, s.label, s.component, s.min, s.max, i++],
      );
    }
    n++;
  }
  console.log(`  ✓ ${n} composition rules`);
}

async function main() {
  console.log("Seeding Phase 1–3 supplemental data...");
  await seedConfig();
  await backfillUsers();
  await seedMealConfig();
  await seedMealWindows();
  await seedCutoffs();
  await seedKitchens();
  await seedBrands();
  await assignKitchenCities();
  await seedFoodSystemConfig();
  await assignResidentialProperties();
  await assignPropertyKitchensAndBrands();
  await seedKitchenPincodes();
  await backfillPropertyBrandAndKitchen();
  // Final authoritative pass: pin every property to a kitchen in its OWN city
  // (overrides any pincode/cluster-derived cross-city kitchen) + realign cluster.
  await assignPropertyKitchensByCity();
  await setDishBrands();
  await seedIngredients();
  await seedCompositionRules();
  await seedKitchenMenus();
  await backfillOrdersAndItems();
  await migrateGeoScopes();
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
