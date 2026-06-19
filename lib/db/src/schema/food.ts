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
 * Order lifecycle status (PRD §7.2–7.6).
 *   PLACED      → created by Unit Lead, editable/cancellable
 *   PREPARING   → kitchen marked it preparing from Kitchen Summary
 *   DISPATCHED  → delivery partner assigned & dispatched
 *   DELIVERED   → receipt confirmed with item-wise proof
 *   CANCELLED   → cancelled before dispatch only
 */
export const foodOrderStatusEnum = pgEnum("food_order_status", [
  "PLACED",
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

export type NewFoodOrder = typeof foodOrdersTable.$inferInsert;
export type NewFoodOrderItem = typeof foodOrderItemsTable.$inferInsert;
