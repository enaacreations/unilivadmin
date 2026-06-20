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
  pgEnum,
} from "drizzle-orm/pg-core";
import { propertiesTable, usersTable } from "./core";

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────── */

/** Meal types orders can be placed for (PRD §7.3, §10). */
export const mealTypeEnum = pgEnum("food_meal_type", [
  "BREAKFAST",
  "LUNCH",
  "SNACKS",
  "DINNER",
  "NIGHT_MILK",
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

/** Brand / service set — same menu, different number of components served (PRD §10.1). */
export const foodBrandEnum = pgEnum("food_brand", ["UNILIV", "HUDDLE"]);

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

/** Menu components from the catalogue (PRD §10.1). */
export const dishComponentEnum = pgEnum("food_dish_component", [
  "HOT_FOOD",
  "VEG",
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

/** Access scope levels for the role hierarchy (PRD §3–5). */
export const foodScopeLevelEnum = pgEnum("food_scope_level", [
  "GLOBAL",
  "ZONE",
  "CITY",
  "CLUSTER",
  "PROPERTY",
]);

/** Dispatch trip status (Persona st.24). */
export const foodDispatchStatusEnum = pgEnum("food_dispatch_status", [
  "LOADING",
  "IN_TRANSIT",
  "DELIVERED",
  "PARTIAL",
]);

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
  zoneId: text("zone_id")
    .notNull()
    .references(() => zonesTable.id),
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
  clusterId: text("cluster_id").references(() => clustersTable.id),
  propertyId: text("property_id").references(() => propertiesTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data (PRD §7.9 Settings)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Dish catalogue — veg-only shared menu (PRD §10). Dishes are shared across
 * brands; brands differ only in how many are served (see foodMenuRotationTable).
 */
export const dishesTable = pgTable("dishes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  component: dishComponentEnum("component").notNull(),
  /** Default unit this dish is measured/ordered in. */
  unit: measurementUnitEnum("unit").notNull(),
  isVeg: boolean("is_veg").default(true).notNull(),
  photoUrl: text("photo_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  brand: foodBrandEnum("brand").notNull(),
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
});

/**
 * Per-resident quantity rules (PRD §7.9). Drive kitchen aggregation: ordered
 * quantity = residentsCount × qtyPerResident for each mapped dish. A null
 * propertyId is the global default; a property-specific row overrides it.
 */
export const perResidentRuleTable = pgTable("per_resident_rules", {
  id: text("id").primaryKey(),
  brand: foodBrandEnum("brand").notNull(),
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

/** Delivery partners assignable at Dispatch (PRD §7.5, §7.9). */
export const deliveryPartnersTable = pgTable("delivery_partners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  vehicleNumber: text("vehicle_number"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  brand: foodBrandEnum("brand"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  pincode: text("pincode"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  /** Cluster this kitchen primarily serves (geo hierarchy); nullable. */
  clusterId: text("cluster_id").references(() => clustersTable.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Display/visibility overlay on the meal-type enum (Persona st.27 "configurable
 * order types"). Lets ops relabel SNACKS → "High Tea / Evening Snacks" and
 * enable/disable meals without an invasive enum→FK migration.
 */
export const foodMealConfigTable = pgTable("food_meal_config", {
  id: text("id").primaryKey(),
  mealType: mealTypeEnum("meal_type").notNull().unique(),
  displayLabel: text("display_label").notNull(),
  brand: foodBrandEnum("brand"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Order cut-off windows per meal (Persona st.11 cut-off time; st.33 delay
 * baseline). Global default = null propertyId; a property row overrides it
 * (same pattern as perResidentRuleTable).
 */
export const foodMealWindowsTable = pgTable("food_meal_windows", {
  id: text("id").primaryKey(),
  brand: foodBrandEnum("brand"),
  /** Null → applies to all properties (default). */
  propertyId: text("property_id").references(() => propertiesTable.id),
  mealType: mealTypeEnum("meal_type").notNull(),
  /** Cut-off time of day for placing orders, "HH:MM" 24h. */
  cutoffTime: text("cutoff_time").notNull(),
  /** Planned service/delivery time of day, "HH:MM" 24h. */
  serviceTime: text("service_time"),
  /** Lead time used to compute expectedDeliveryAt for delay analytics. */
  leadTimeMinutes: integer("lead_time_minutes").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Dispatch trip / manifest (Persona st.24). One trip groups many orders carried
 * on a single van; orders link via foodOrders.dispatchId. Captures van number,
 * driver name+mobile, and estimated arrival time the Unit Lead sees.
 */
export const foodDispatchesTable = pgTable("food_dispatches", {
  id: text("id").primaryKey(),
  dispatchNumber: text("dispatch_number").notNull().unique(),
  kitchenId: text("kitchen_id").references(() => kitchensTable.id),
  deliveryPartnerId: text("delivery_partner_id").references(
    () => deliveryPartnersTable.id,
  ),
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
  brand: foodBrandEnum("brand").notNull(),
  serviceDate: timestamp("service_date").notNull(),
  residentsCount: integer("residents_count").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
  brand: foodBrandEnum("brand").notNull(),
  mealType: mealTypeEnum("meal_type").notNull(),
  /** Unit Lead who placed the order (PRD §4.1). */
  unitLeadId: text("unit_lead_id")
    .notNull()
    .references(() => usersTable.id),
  residentsCount: integer("residents_count").notNull(),
  /** Convenience total quantity (sum of item ordered quantities). */
  totalQuantity: numeric("total_quantity", { precision: 12, scale: 3 }),
  status: foodOrderStatusEnum("status").default("PLACED").notNull(),
  /** Date the meal is for (distinct from createdAt). */
  serviceDate: timestamp("service_date").notNull(),
  notes: text("notes"),

  // ── Dispatch (PRD §7.5) ──
  deliveryPartnerId: text("delivery_partner_id").references(
    () => deliveryPartnersTable.id,
  ),
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
  brand: foodBrandEnum("brand").notNull(),
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
export type FoodOrder = typeof foodOrdersTable.$inferSelect;
export type FoodOrderItem = typeof foodOrderItemsTable.$inferSelect;
export type FoodOrderEvent = typeof foodOrderEventsTable.$inferSelect;
export type Kitchen = typeof kitchensTable.$inferSelect;
export type FoodDispatch = typeof foodDispatchesTable.$inferSelect;
export type FoodOrderBatch = typeof foodOrderBatchesTable.$inferSelect;
export type FoodMealConfig = typeof foodMealConfigTable.$inferSelect;
export type FoodMealWindow = typeof foodMealWindowsTable.$inferSelect;
export type FoodMenuShare = typeof foodMenuSharesTable.$inferSelect;

export type NewFoodOrder = typeof foodOrdersTable.$inferInsert;
export type NewFoodOrderItem = typeof foodOrderItemsTable.$inferInsert;
export type NewFoodDispatch = typeof foodDispatchesTable.$inferInsert;
export type NewFoodOrderBatch = typeof foodOrderBatchesTable.$inferInsert;
