/**
 * Food Ordering & Kitchen Operations
 * ----------------------------------
 * Implements the order→dispatch→delivery→waste lifecycle described in the
 * "Food Ordering & Kitchen Operations" PRD (v1.0). This is intentionally kept
 * separate from `kitchen.ts` (recipe library / weekly menu planning), which is
 * a different subsystem.
 *
 * Domain flow:
 *   Unit Lead places order → Kitchen aggregates (summary) → Dispatch (assign
 *   delivery partner) → Confirm Delivery (item-wise proof) → Waste Tracking.
 *
 * Geographic hierarchy (Zone → City → Cluster → Property) backs the
 * role-scoped filters required on nearly every screen.
 */
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  doublePrecision,
  json,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { propertiesTable, usersTable } from "./core";

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────── */

/** Meal types orders can be placed for. Fixed set of 4 (Evening Snacks = SNACKS). */
export const mealTypeEnum = pgEnum("food_meal_type", [
  "BREAKFAST",
  "LUNCH",
  "SNACKS",
  "DINNER",
]);

/**
 * Order lifecycle status (PRD §7.2–7.6; ACCEPTED/REJECTED added for Persona st.22).
 *   PLACED      → created by Unit Lead, editable/cancellable
 *   ACCEPTED    → kitchen acknowledged the order
 *   REJECTED    → kitchen declined the order (terminal; with rejectionReason)
 *   PREPARING   → kitchen marked it preparing from Kitchen Summary
 *   DISPATCHED  → delivery partner assigned & dispatched
 *   DELIVERED   → receipt confirmed with item-wise proof
 *   CANCELLED   → cancelled before dispatch only
 */
export const foodOrderStatusEnum = pgEnum("food_order_status", [
  "PLACED",
  "ACCEPTED",
  "REJECTED",
  "PREPARING",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
]);

/**
 * Brand is now an admin-managed master list (foodBrandsTable), not a fixed enum.
 * Every `brand` column stores the brand CODE as text (e.g. "UNILIV", "HUDDLE",
 * or any code an admin creates), validated at the app layer against active brands.
 */

/** Measurement units; Kitchen Summary auto-converts g→kg, ml→litre (PRD §7.4). */
export const measurementUnitEnum = pgEnum("food_measurement_unit", [
  "G",
  "KG",
  "ML",
  "LITRE",
  "PCS",
  "PLATE",
  "SERVING",
]);

/** Dish course/component (a category, NOT a diet tag — see preparation). */
export const dishComponentEnum = pgEnum("food_dish_component", [
  "HOT_FOOD",
  "SABZI",
  "DAL",
  "RICE",
  "BREAD",
  "SALAD",
  "CURD_RAITA",
  "DESSERT",
  "PAPAD_PICKLE",
  "CHUTNEY",
  "PICKLE",
  "FRUITS",
  "BAKERY",
  "BEVERAGE",
  "SNACK",
  "MILK",
  "OTHER",
]);

/** Dish preparation / diet tags (a dish can carry several, e.g. VEG + JAIN). */
export const PREPARATIONS = ["VEG", "NON_VEG", "JAIN"] as const;

/**
 * Access scope levels. Hierarchy is City → Kitchen → Property (ZONE/CLUSTER are
 * retained for back-compat data but no longer used by the resolver/UI).
 */
export const foodScopeLevelEnum = pgEnum("food_scope_level", [
  "GLOBAL",
  "ZONE",
  "CITY",
  "KITCHEN",
  "CLUSTER",
  "PROPERTY",
]);

/** Dispatch trip status (Persona st.24; CANCELLED for clean trip cancellation). */
export const foodDispatchStatusEnum = pgEnum("food_dispatch_status", [
  "LOADING",
  "IN_TRANSIT",
  "DELIVERED",
  "PARTIAL",
  "CANCELLED",
]);

/**
 * Allowed dispatch status transitions. Keyed by current status → array of
 * statuses it may move to (terminal states map to []).
 */
export const DISPATCH_TRANSITIONS: Record<string, string[]> = {
  LOADING: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "PARTIAL", "CANCELLED"],
  PARTIAL: ["DELIVERED", "IN_TRANSIT"],
  DELIVERED: [],
  CANCELLED: [],
};

/** Channel a menu was shared through (Persona st.15). */
export const foodMenuShareChannelEnum = pgEnum("food_menu_share_channel", [
  "EMAIL",
  "WHATSAPP",
  "LINK",
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Geographic hierarchy: Zone → City → Cluster → Property
 * (Property lives in core.ts; we add `clusterId` to it — see core.ts changes.)
 * ──────────────────────────────────────────────────────────────────────────── */

export const zonesTable = pgTable("zones", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const citiesTable = pgTable("cities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Nullable — cities sit directly under the implicit "India" root. */
  zoneId: text("zone_id").references(() => zonesTable.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const clustersTable = pgTable("clusters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cityId: text("city_id")
    .notNull()
    .references(() => citiesTable.id),
  /** Cluster Manager who owns this cluster (PRD §4.2). */
  managerId: text("manager_id").references(() => usersTable.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Per-user access scope assignment. A user may have one or more scopes that
 * bound which orders/properties they can view/edit. Combined with the role's
 * permission matrix in permissions.ts to resolve effective access.
 *   e.g. Cluster Manager → { scopeLevel: CLUSTER, clusterId }
 *        City Head       → { scopeLevel: CITY, cityId }
 *        Ops Excellence  → { scopeLevel: GLOBAL }
 */
export const userScopesTable = pgTable("user_scopes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  scopeLevel: foodScopeLevelEnum("scope_level").notNull(),
  zoneId: text("zone_id").references(() => zonesTable.id),
  cityId: text("city_id").references(() => citiesTable.id),
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  clusterId: text("cluster_id").references(() => clustersTable.id),
  propertyId: text("property_id").references(() => propertiesTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data (PRD §7.9 Settings)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Brand master — admin-managed list of brands (Uniliv, Huddle, …). All `brand`
 * columns across the food schema store this table's `code`.
 */
export const foodBrandsTable = pgTable("food_brands", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Dish catalogue — shared, veg-only (PRD §10). A dish is tagged with one OR more
 * brand codes (`brands`); the same dish (e.g. Rice) can be reused across brands.
 */
export const dishesTable = pgTable("dishes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  component: dishComponentEnum("component").notNull(),
  /** Default unit this dish is measured/ordered in. */
  unit: measurementUnitEnum("unit").notNull(),
  /** Brand codes this dish belongs to (one or more). */
  brands: text("brands").array().notNull().default(sql`'{}'::text[]`),
  /** Preparation/diet tags (VEG, NON_VEG, JAIN — one or more). Replaces isVeg. */
  preparations: text("preparations").array().notNull().default(sql`'{}'::text[]`),
  photoUrl: text("photo_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Ingredient master (ingredients used in dishes — Aloo, Pyaaz, Tomato, …). */
export const ingredientsTable = pgTable("ingredients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  unit: measurementUnitEnum("unit").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ nameIdx: index("idx_raw_materials_name").on(t.name) }));

/** Per-dish ingredient list (dish ↔ ingredient, with optional quantity). */
export const dishIngredientsTable = pgTable("dish_ingredients", {
  id: text("id").primaryKey(),
  dishId: text("dish_id").notNull().references(() => dishesTable.id, { onDelete: "cascade" }),
  ingredientId: text("ingredient_id").notNull().references(() => ingredientsTable.id),
  quantity: numeric("quantity", { precision: 12, scale: 3 }),
  unit: measurementUnitEnum("unit"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  dishIdx: index("idx_dish_ingredients_dish").on(t.dishId),
  rmIdx: index("idx_dish_ingredients_rm").on(t.ingredientId),
}));

/**
 * Menu-composition rule — the STRUCTURE of a meal per (brand, mealType, kitchen?).
 * A rule = a header + N slots (e.g. Lunch = 1 DAL + 1 SABZI + 1 RICE + 1 SALAD).
 * A kitchen-specific rule (kitchenId set) overrides the brand default (kitchenId null).
 */
export const menuCompositionRuleTable = pgTable("menu_composition_rules", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(),
  mealType: mealTypeEnum("meal_type").notNull(),
  /** Null → applies to all kitchens of the brand (default). */
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  name: text("name"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  resolveIdx: index("idx_comp_rule_resolve").on(t.brand, t.mealType, t.kitchenId, t.isActive),
}));

/** A required slot within a composition rule (by component and/or preparation, with counts). */
export const menuCompositionSlotTable = pgTable("menu_composition_slots", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => menuCompositionRuleTable.id, { onDelete: "cascade" }),
  slotLabel: text("slot_label"),
  /** Match dishes of this component (nullable → any). */
  component: dishComponentEnum("component"),
  /** Match dishes whose preparations[] contains this tag (nullable → any). */
  preparation: text("preparation"),
  minCount: integer("min_count").default(1).notNull(),
  maxCount: integer("max_count"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ ruleIdx: index("idx_comp_slot_rule").on(t.ruleId) }));

/**
 * Weekly menu rotation = the meal → dish mapping per brand/service set, with a
 * multi-week rotation and day-of-week dimension (PRD §10, §10.2). This is the
 * single source of truth that drives Kitchen Summary aggregation: for a given
 * service date we resolve (rotationWeek, dayOfWeek, brand, mealType) → dishes.
 *
 * Service set is expressed by how many rows exist for a brand+meal+day, e.g.
 * Uniliv Lunch has 2 VEG rows (Veg + Veg 2), Huddle Lunch has 1 VEG row; both
 * share the Dal/Rice/Bread/etc. rows. Seasonal changes are handled by the
 * effectiveFrom/effectiveTo window (PRD §10: "subject to seasonal availability").
 */
export const foodMenuRotationTable = pgTable("food_menu_rotation", {
  id: text("id").primaryKey(),
  /** Kitchen this menu belongs to (menus are defined per kitchen). */
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  brand: text("brand").notNull(),
  /** 1-based rotation week index in the multi-week cycle (1, 2, 3, …). */
  rotationWeek: integer("rotation_week").default(1).notNull(),
  /** Day of week: 1 = Monday … 7 = Sunday. */
  dayOfWeek: integer("day_of_week").notNull(),
  mealType: mealTypeEnum("meal_type").notNull(),
  dishId: text("dish_id")
    .notNull()
    .references(() => dishesTable.id),
  /** Display label for the service-set slot, e.g. "Veg", "Veg 2", "Hot Food". */
  slotLabel: text("slot_label"),
  sortOrder: integer("sort_order").default(0).notNull(),
  /** Seasonal validity window; null = always applicable. */
  effectiveFrom: timestamp("effective_from"),
  effectiveTo: timestamp("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  resolveIdx: index("idx_rotation_resolve").on(
    t.kitchenId, t.brand, t.mealType, t.rotationWeek, t.dayOfWeek, t.isActive,
  ),
}));

/**
 * Per-resident quantity rules (PRD §7.9). Drive kitchen aggregation: ordered
 * quantity = residentsCount × qtyPerResident for each mapped dish. A null
 * propertyId is the global default; a property-specific row overrides it.
 */
export const perResidentRuleTable = pgTable("per_resident_rules", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(),
  mealType: mealTypeEnum("meal_type").notNull(),
  dishId: text("dish_id")
    .notNull()
    .references(() => dishesTable.id),
  /** Null → applies to all properties (default rule). */
  propertyId: text("property_id").references(() => propertiesTable.id),
  qtyPerResident: numeric("qty_per_resident", { precision: 12, scale: 3 }).notNull(),
  unit: measurementUnitEnum("unit").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Delivery partners — legacy flat table, superseded by agencies (kept for migration). */
export const deliveryPartnersTable = pgTable("delivery_partners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  vehicleNumber: text("vehicle_number"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Delivery AGENCY — a vendor with multiple locations + vehicles. Dispatch picks agency → vehicle. */
export const agenciesTable = pgTable("agencies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  contactName: text("contact_name"),
  email: text("email"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** A physical location/hub of an agency. */
export const agencyLocationsTable = pgTable("agency_locations", {
  id: text("id").primaryKey(),
  agencyId: text("agency_id").notNull().references(() => agenciesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  pincode: text("pincode"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ agencyIdx: index("idx_agency_locations_agency").on(t.agencyId) }));

export const agencyVehicleTypeEnum = pgEnum("food_vehicle_type", ["VAN", "BIKE", "TRUCK", "CAR", "TEMPO", "OTHER"]);

/** A vehicle belonging to an agency (optionally based at a location). */
export const agencyVehiclesTable = pgTable("agency_vehicles", {
  id: text("id").primaryKey(),
  agencyId: text("agency_id").notNull().references(() => agenciesTable.id, { onDelete: "cascade" }),
  locationId: text("location_id").references(() => agencyLocationsTable.id),
  vehicleNumber: text("vehicle_number").notNull(),
  vehicleType: agencyVehicleTypeEnum("vehicle_type").default("VAN").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ agencyIdx: index("idx_agency_vehicles_agency").on(t.agencyId) }));

/**
 * Agency ↔ kitchen serving map. Restricts which kitchens an agency can be
 * dispatched from, so the dispatch form only offers agencies serving the
 * order's kitchen.
 */
export const agencyKitchensTable = pgTable("agency_kitchens", {
  id: text("id").primaryKey(),
  agencyId: text("agency_id").notNull().references(() => agenciesTable.id, { onDelete: "cascade" }),
  kitchenId: text("kitchen_id").notNull().references(() => kitchensTable.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  agencyKitchenIdx: uniqueIndex("idx_agency_kitchens_agency_kitchen").on(t.agencyId, t.kitchenId),
  kitchenIdx: index("idx_agency_kitchens_kitchen").on(t.kitchenId),
}));

/**
 * Kitchen master — orders are dispatched FROM a kitchen (Persona st.24 requires
 * Kitchen ID / location / address with PINCODE on the dispatched-order view).
 * brand null = shared kitchen serving both service sets.
 */
export const kitchensTable = pgTable("kitchens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Human-facing Kitchen ID shown on dispatch details. */
  code: text("code").notNull().unique(),
  brand: text("brand"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  pincode: text("pincode"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  /** Kitchen head contact. */
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  /** City this kitchen belongs to (hierarchy: City → Kitchen → Property). */
  cityId: text("city_id").references(() => citiesTable.id),
  /** Legacy cluster link (retired in favour of cityId). */
  clusterId: text("cluster_id").references(() => clustersTable.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Master map of pincode → kitchen, used to AUTO-DERIVE a property's kitchen from
 * its pincode on the Add/Edit Property form (admin requirement). A kitchen serves
 * MANY pincodes, but each pincode maps to exactly ONE kitchen (pincode is globally
 * unique) so derivation is deterministic and the form can show a read-only kitchen.
 */
export const kitchenPincodesTable = pgTable("kitchen_pincodes", {
  id: text("id").primaryKey(),
  kitchenId: text("kitchen_id").notNull().references(() => kitchensTable.id),
  pincode: text("pincode").notNull().unique(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ kitchenIdx: index("idx_kitchen_pincodes_kitchen").on(t.kitchenId) }));

export type KitchenPincode = typeof kitchenPincodesTable.$inferSelect;
export type NewKitchenPincode = typeof kitchenPincodesTable.$inferInsert;

/**
 * Display/visibility overlay on the meal-type enum (Persona st.27 "configurable
 * order types"). Lets ops relabel SNACKS → "High Tea / Evening Snacks" and
 * enable/disable meals without an invasive enum→FK migration.
 */
export const foodMealConfigTable = pgTable("food_meal_config", {
  id: text("id").primaryKey(),
  mealType: mealTypeEnum("meal_type").notNull().unique(),
  displayLabel: text("display_label").notNull(),
  brand: text("brand"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Per-meal SERVICE windows (planned service/delivery time + lead time for delay
 * analytics). The cut-off time is now a single brand-level value (foodCutoffsTable);
 * `cutoffTime` here is legacy/ignored. Global default = null propertyId; a property
 * row overrides it (same pattern as perResidentRuleTable).
 */
export const foodMealWindowsTable = pgTable("food_meal_windows", {
  id: text("id").primaryKey(),
  brand: text("brand"),
  /** Null → applies to all properties (default). */
  propertyId: text("property_id").references(() => propertiesTable.id),
  mealType: mealTypeEnum("meal_type").notNull(),
  /** @deprecated Legacy per-meal cut-off; resolution now uses foodCutoffsTable. */
  cutoffTime: text("cutoff_time"),
  /** Planned service/delivery time of day, "HH:MM" 24h. */
  serviceTime: text("service_time"),
  /** Lead time used to compute expectedDeliveryAt for delay analytics. */
  leadTimeMinutes: integer("lead_time_minutes").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Single order cut-off time per brand (one value applies to ALL meals that day).
 * Global default = null propertyId; a property row overrides it. Per-meal service
 * times live on foodMealWindowsTable.
 */
export const foodCutoffsTable = pgTable("food_cutoffs", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(),
  /** Null → applies to all properties of the brand (default). */
  propertyId: text("property_id").references(() => propertiesTable.id),
  /** Cut-off time of day for placing orders, "HH:MM" 24h. */
  cutoffTime: text("cutoff_time").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  brandPropIdx: uniqueIndex("idx_food_cutoffs_brand_prop").on(t.brand, t.propertyId),
}));

/**
 * Dispatch trip / manifest (Persona st.24). One trip groups many orders carried
 * on a single van; orders link via foodOrders.dispatchId. Captures van number,
 * driver name+mobile, and estimated arrival time the Unit Lead sees.
 */
export const foodDispatchesTable = pgTable("food_dispatches", {
  id: text("id").primaryKey(),
  dispatchNumber: text("dispatch_number").notNull().unique(),
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  /** @deprecated column name kept; now references agencies.id. */
  deliveryPartnerId: text("delivery_partner_id").references(
    () => agenciesTable.id,
  ),
  vehicleId: text("vehicle_id").references(() => agencyVehiclesTable.id),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  driverPhone: text("driver_phone"),
  dispatchedById: text("dispatched_by_id").references(() => usersTable.id),
  dispatchedAt: timestamp("dispatched_at"),
  estimatedArrivalAt: timestamp("estimated_arrival_at"),
  status: foodDispatchStatusEnum("status").default("LOADING").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Multi-meal order batch (Persona st.16). A single Unit-Lead submission creates
 * one batch + one order per meal type; each order keeps its own lifecycle since
 * meals deliver at different times.
 */
export const foodOrderBatchesTable = pgTable("food_order_batches", {
  id: text("id").primaryKey(),
  batchNumber: text("batch_number").notNull().unique(),
  propertyId: text("property_id")
    .notNull()
    .references(() => propertiesTable.id),
  unitLeadId: text("unit_lead_id")
    .notNull()
    .references(() => usersTable.id),
  brand: text("brand").notNull(),
  serviceDate: timestamp("service_date").notNull(),
  residentsCount: integer("residents_count").notNull(),
  /** Staff eating the same meals — captured for reports/analytics. Total people
   *  fed = residentsCount + staffCount. */
  staffCount: integer("staff_count").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Server-side order draft. Persists a unit lead's in-progress Place-Order form
 * per USER (not per browser) so a draft survives device/browser switches. One
 * row per (user, property, service day); the payload is the frontend's opaque
 * draft state (jsonb, capped at the route layer). serviceDate is stored
 * day-anchored to 00:00 IST — the same anchoring parseServiceDate applies to
 * food_orders.service_date — so upsert/lookup equality is exact.
 */
export const foodOrderDraftsTable = pgTable("food_order_drafts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  propertyId: text("property_id")
    .notNull()
    .references(() => propertiesTable.id),
  /** IST calendar day the draft order is for (00:00 IST instant). */
  serviceDate: timestamp("service_date").notNull(),
  /** Opaque frontend draft state (validated only for size at the route). */
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userPropDayIdx: uniqueIndex("idx_food_order_drafts_user_prop_day").on(
    t.userId, t.propertyId, t.serviceDate,
  ),
  /** Backs the opportunistic stale-draft sweep (user's past service days). */
  userDayIdx: index("idx_food_order_drafts_user_day").on(t.userId, t.serviceDate),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Orders & lifecycle (PRD §7.2–7.7)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Food order header. One row per property + meal + planned date. Quantity is a
 * convenience total; per-dish breakdown lives in foodOrderItemsTable.
 */
export const foodOrdersTable = pgTable("food_orders", {
  id: text("id").primaryKey(),
  /** Human-facing auto-generated Order ID (e.g. ORD-2026-000123). Unique. */
  orderNumber: text("order_number").notNull().unique(),
  propertyId: text("property_id")
    .notNull()
    .references(() => propertiesTable.id),
  brand: text("brand").notNull(),
  mealType: mealTypeEnum("meal_type").notNull(),
  /** Unit Lead who placed the order (PRD §4.1). */
  unitLeadId: text("unit_lead_id")
    .notNull()
    .references(() => usersTable.id),
  residentsCount: integer("residents_count").notNull(),
  /** Staff eating the same meals — captured for reports/analytics. Total people
   *  fed = residentsCount + staffCount. */
  staffCount: integer("staff_count").notNull().default(0),
  /** Convenience total quantity (sum of item ordered quantities). */
  totalQuantity: numeric("total_quantity", { precision: 12, scale: 3 }),
  status: foodOrderStatusEnum("status").default("PLACED").notNull(),
  /** Date the meal is for (distinct from createdAt). */
  serviceDate: timestamp("service_date").notNull(),
  notes: text("notes"),

  // ── Dispatch (PRD §7.5) ──
  /** @deprecated column name kept; now references agencies.id. */
  deliveryPartnerId: text("delivery_partner_id").references(
    () => agenciesTable.id,
  ),
  vehicleId: text("vehicle_id").references(() => agencyVehiclesTable.id),
  dispatchedById: text("dispatched_by_id").references(() => usersTable.id),
  dispatchStartedAt: timestamp("dispatch_started_at"),
  dispatchedAt: timestamp("dispatched_at"),

  // ── Delivery confirmation (PRD §7.6) ──
  confirmedById: text("confirmed_by_id").references(() => usersTable.id),
  deliveredAt: timestamp("delivered_at"),
  deliveryRemarks: text("delivery_remarks"),
  /** Waste edits locked after this time = deliveredAt + 1h (PRD §7.7). */
  wasteEditableUntil: timestamp("waste_editable_until"),

  // ── Other lifecycle ──
  preparingAt: timestamp("preparing_at"),
  cancelledAt: timestamp("cancelled_at"),
  cancelReason: text("cancel_reason"),

  // ── Kitchen acknowledgement (Persona st.22) ──
  acceptedById: text("accepted_by_id").references(() => usersTable.id),
  acceptedAt: timestamp("accepted_at"),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),

  // ── Grouping & fulfilment links ──
  /** Set when placed as part of a multi-meal batch (Persona st.16). */
  batchId: text("batch_id").references(() => foodOrderBatchesTable.id),
  /** Kitchen fulfilling this order (Persona st.24 "dispatched from"). */
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  /** Dispatch trip/manifest carrying this order (Persona st.24 van/driver/ETA). */
  dispatchId: text("dispatch_id").references(() => foodDispatchesTable.id),
  /** Expected delivery time from the meal cut-off window; delay baseline (Persona st.33). */
  expectedDeliveryAt: timestamp("expected_delivery_at"),

  createdById: text("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Per-dish order line. Holds ordered, received (delivery proof), and wasted
 * quantities in the dish's ordered unit (PRD §7.4, §7.6, §7.7).
 */
export const foodOrderItemsTable = pgTable("food_order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => foodOrdersTable.id, { onDelete: "cascade" }),
  dishId: text("dish_id")
    .notNull()
    .references(() => dishesTable.id),
  unit: measurementUnitEnum("unit").notNull(),
  orderedQty: numeric("ordered_qty", { precision: 12, scale: 3 }).notNull(),
  /** Per-item head count the unit lead entered (default = order-level persons). */
  personsCount: integer("persons_count"),
  /**
   * Quantity the kitchen actually prepared (PRD §7.5 Dispatch shows prepared
   * qty). May differ from orderedQty; defaults to orderedQty at dispatch time.
   */
  preparedQty: numeric("prepared_qty", { precision: 12, scale: 3 }),
  /** Item-wise received quantity captured at Confirm Delivery (proof of receipt). */
  receivedQty: numeric("received_qty", { precision: 12, scale: 3 }),
  /** Wasted quantity; non-negative and ≤ orderedQty, editable within window. */
  wastedQty: numeric("wasted_qty", { precision: 12, scale: 3 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Append-only lifecycle event log powering the Confirm Delivery timeline
 * (PRD §7.6) and audit. One row per status transition / notable action.
 */
export const foodOrderEventsTable = pgTable("food_order_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => foodOrdersTable.id, { onDelete: "cascade" }),
  status: foodOrderStatusEnum("status").notNull(),
  note: text("note"),
  actorId: text("actor_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Append-only dispatch-trip event log (mirrors foodOrderEventsTable). One row
 * per dispatch status transition / notable action, powering the trip timeline.
 */
export const foodDispatchEventsTable = pgTable("food_dispatch_events", {
  id: text("id").primaryKey(),
  dispatchId: text("dispatch_id")
    .notNull()
    .references(() => foodDispatchesTable.id, { onDelete: "cascade" }),
  status: foodDispatchStatusEnum("status").notNull(),
  note: text("note"),
  actorId: text("actor_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ dispatchIdx: index("idx_food_dispatch_events_dispatch").on(t.dispatchId) }));

/**
 * Menu share audit (Persona st.15 "share the food menu with active guests").
 * recipients holds resident IDs / emails / phones depending on channel; a
 * shareToken backs an optional public link (st.14 download/share).
 */
export const foodMenuSharesTable = pgTable("food_menu_shares", {
  id: text("id").primaryKey(),
  sharedById: text("shared_by_id")
    .notNull()
    .references(() => usersTable.id),
  propertyId: text("property_id")
    .notNull()
    .references(() => propertiesTable.id),
  brand: text("brand").notNull(),
  mealType: mealTypeEnum("meal_type"),
  menuDate: timestamp("menu_date"),
  channel: foodMenuShareChannelEnum("channel").notNull(),
  /** GUESTS = all active residents at the property, or CUSTOM list. */
  recipientType: text("recipient_type").notNull(),
  recipients: json("recipients").$type<string[]>().default([]).notNull(),
  shareToken: text("share_token").unique(),
  sharedAt: timestamp("shared_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Inferred types
 * ──────────────────────────────────────────────────────────────────────────── */

export type Zone = typeof zonesTable.$inferSelect;
export type City = typeof citiesTable.$inferSelect;
export type Cluster = typeof clustersTable.$inferSelect;
export type UserScope = typeof userScopesTable.$inferSelect;
export type Dish = typeof dishesTable.$inferSelect;
export type FoodMenuRotation = typeof foodMenuRotationTable.$inferSelect;
export type PerResidentRule = typeof perResidentRuleTable.$inferSelect;
export type DeliveryPartner = typeof deliveryPartnersTable.$inferSelect;
export type Agency = typeof agenciesTable.$inferSelect;
export type AgencyLocation = typeof agencyLocationsTable.$inferSelect;
export type AgencyVehicle = typeof agencyVehiclesTable.$inferSelect;
export type AgencyKitchen = typeof agencyKitchensTable.$inferSelect;
export type FoodOrder = typeof foodOrdersTable.$inferSelect;
export type FoodOrderItem = typeof foodOrderItemsTable.$inferSelect;
export type FoodOrderEvent = typeof foodOrderEventsTable.$inferSelect;

/**
 * Additional Food — a LOG of top-up food requested from another property AFTER
 * an order is received (the real coordination happens offline). NOT part of the
 * order lifecycle. Each "+ Additional Food" submission shares one requestId,
 * records the source property it came from, and has one row per dish. The
 * received view sums received + these per dish; reports distinguish original
 * from additional and show the source property.
 */
export const foodAdditionalOrderItemsTable = pgTable("food_additional_order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => foodOrdersTable.id, { onDelete: "cascade" }),
  // Groups the dishes of one "+ Additional Food" submission ("additional order N").
  requestId: text("request_id").notNull(),
  // Property the extra food was sourced from (offline coordination).
  sourcePropertyId: text("source_property_id").notNull().references(() => propertiesTable.id),
  dishId: text("dish_id").notNull().references(() => dishesTable.id),
  unit: measurementUnitEnum("unit").notNull(),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  createdById: text("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type FoodAdditionalOrderItem = typeof foodAdditionalOrderItemsTable.$inferSelect;

export type FoodDispatchEvent = typeof foodDispatchEventsTable.$inferSelect;
export type Kitchen = typeof kitchensTable.$inferSelect;
export type FoodDispatch = typeof foodDispatchesTable.$inferSelect;
export type FoodOrderBatch = typeof foodOrderBatchesTable.$inferSelect;
export type FoodOrderDraft = typeof foodOrderDraftsTable.$inferSelect;
export type FoodMealConfig = typeof foodMealConfigTable.$inferSelect;
export type FoodMealWindow = typeof foodMealWindowsTable.$inferSelect;
export type FoodCutoffRow = typeof foodCutoffsTable.$inferSelect;
export type Ingredient = typeof ingredientsTable.$inferSelect;
export type DishIngredient = typeof dishIngredientsTable.$inferSelect;
export type MenuCompositionRule = typeof menuCompositionRuleTable.$inferSelect;
export type MenuCompositionSlot = typeof menuCompositionSlotTable.$inferSelect;
export type FoodMenuShare = typeof foodMenuSharesTable.$inferSelect;
export type FoodBrandRow = typeof foodBrandsTable.$inferSelect;

export type NewFoodOrder = typeof foodOrdersTable.$inferInsert;
export type NewFoodOrderItem = typeof foodOrderItemsTable.$inferInsert;
export type NewFoodDispatch = typeof foodDispatchesTable.$inferInsert;
export type NewFoodOrderBatch = typeof foodOrderBatchesTable.$inferInsert;
