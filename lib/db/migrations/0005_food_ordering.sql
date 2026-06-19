-- Food Ordering & Kitchen Operations (PRD v1.0)
-- Adds the order→dispatch→delivery→waste lifecycle, the geographic hierarchy
-- (Zone → City → Cluster → Property), menu rotation + master data, and the 9
-- food-ops roles.
--
-- Apply with:
--   psql "$DATABASE_URL" -f lib/db/migrations/0005_food_ordering.sql
--
-- Day-to-day dev uses `pnpm --filter @workspace/db run push` against
-- `src/schema/food.ts`. This SQL captures the same change for environments
-- where push isn't appropriate (production).

-- ─── New user_role enum values (PRD §3) ──────────────────────────────────────
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- PostgreSQL, so these run before BEGIN. Safe/idempotent via IF NOT EXISTS.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'UNIT_LEAD';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'CLUSTER_MANAGER';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'CITY_HEAD';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'ZONAL_HEAD';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'OPS_EXCELLENCE';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'SENIOR_VICE_PRESIDENT';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'FNB_SUPERVISOR';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'FNB_MANAGER';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'FNB_ZONAL_HEAD';

BEGIN;

-- ─── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "food_brand" AS ENUM ('UNILIV', 'HUDDLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "food_meal_type" AS ENUM (
    'BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER', 'NIGHT_MILK'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "food_order_status" AS ENUM (
    'PLACED', 'PREPARING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "food_measurement_unit" AS ENUM (
    'G', 'KG', 'ML', 'LITRE', 'PCS', 'PLATE', 'SERVING'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "food_dish_component" AS ENUM (
    'HOT_FOOD', 'VEG', 'DAL', 'RICE', 'BREAD', 'SALAD', 'CURD_RAITA',
    'DESSERT', 'PAPAD_PICKLE', 'CHUTNEY', 'PICKLE', 'FRUITS', 'BAKERY',
    'BEVERAGE', 'SNACK', 'MILK', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "food_scope_level" AS ENUM (
    'GLOBAL', 'ZONE', 'CITY', 'CLUSTER', 'PROPERTY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Property → cluster link ────────────────────────────────────────────────
ALTER TABLE "properties"
  ADD COLUMN IF NOT EXISTS "cluster_id" text;
CREATE INDEX IF NOT EXISTS "idx_properties_cluster" ON "properties"("cluster_id");

-- ─── Geographic hierarchy: Zone → City → Cluster ────────────────────────────
CREATE TABLE IF NOT EXISTS "zones" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "code" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "cities" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "zone_id" text NOT NULL REFERENCES "zones"("id"),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_cities_zone" ON "cities"("zone_id");

CREATE TABLE IF NOT EXISTS "clusters" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "city_id" text NOT NULL REFERENCES "cities"("id"),
  "manager_id" text REFERENCES "users"("id"),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_clusters_city" ON "clusters"("city_id");

CREATE TABLE IF NOT EXISTS "user_scopes" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope_level" "food_scope_level" NOT NULL,
  "zone_id" text REFERENCES "zones"("id"),
  "city_id" text REFERENCES "cities"("id"),
  "cluster_id" text REFERENCES "clusters"("id"),
  "property_id" text REFERENCES "properties"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_user_scopes_user" ON "user_scopes"("user_id");

-- ─── Master data ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "dishes" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "component" "food_dish_component" NOT NULL,
  "unit" "food_measurement_unit" NOT NULL,
  "is_veg" boolean NOT NULL DEFAULT true,
  "photo_url" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_dishes_component" ON "dishes"("component");

CREATE TABLE IF NOT EXISTS "food_menu_rotation" (
  "id" text PRIMARY KEY,
  "brand" "food_brand" NOT NULL,
  "rotation_week" integer NOT NULL DEFAULT 1,
  "day_of_week" integer NOT NULL,
  "meal_type" "food_meal_type" NOT NULL,
  "dish_id" text NOT NULL REFERENCES "dishes"("id"),
  "slot_label" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "effective_from" timestamp,
  "effective_to" timestamp,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_menu_rotation_lookup"
  ON "food_menu_rotation"("brand", "meal_type", "rotation_week", "day_of_week");

CREATE TABLE IF NOT EXISTS "per_resident_rules" (
  "id" text PRIMARY KEY,
  "brand" "food_brand" NOT NULL,
  "meal_type" "food_meal_type" NOT NULL,
  "dish_id" text NOT NULL REFERENCES "dishes"("id"),
  "property_id" text REFERENCES "properties"("id"),
  "qty_per_resident" numeric(12, 3) NOT NULL,
  "unit" "food_measurement_unit" NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_per_resident_rules_dish" ON "per_resident_rules"("dish_id");
CREATE INDEX IF NOT EXISTS "idx_per_resident_rules_property" ON "per_resident_rules"("property_id");

CREATE TABLE IF NOT EXISTS "delivery_partners" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "phone" text,
  "vehicle_number" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- ─── Orders & lifecycle ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "food_orders" (
  "id" text PRIMARY KEY,
  "order_number" text NOT NULL UNIQUE,
  "property_id" text NOT NULL REFERENCES "properties"("id"),
  "brand" "food_brand" NOT NULL,
  "meal_type" "food_meal_type" NOT NULL,
  "unit_lead_id" text NOT NULL REFERENCES "users"("id"),
  "residents_count" integer NOT NULL,
  "total_quantity" numeric(12, 3),
  "status" "food_order_status" NOT NULL DEFAULT 'PLACED',
  "service_date" timestamp NOT NULL,
  "notes" text,
  "delivery_partner_id" text REFERENCES "delivery_partners"("id"),
  "dispatched_by_id" text REFERENCES "users"("id"),
  "dispatch_started_at" timestamp,
  "dispatched_at" timestamp,
  "confirmed_by_id" text REFERENCES "users"("id"),
  "delivered_at" timestamp,
  "delivery_remarks" text,
  "waste_editable_until" timestamp,
  "preparing_at" timestamp,
  "cancelled_at" timestamp,
  "cancel_reason" text,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_food_orders_property" ON "food_orders"("property_id");
CREATE INDEX IF NOT EXISTS "idx_food_orders_status" ON "food_orders"("status");
CREATE INDEX IF NOT EXISTS "idx_food_orders_service_date" ON "food_orders"("service_date");
CREATE INDEX IF NOT EXISTS "idx_food_orders_unit_lead" ON "food_orders"("unit_lead_id");

CREATE TABLE IF NOT EXISTS "food_order_items" (
  "id" text PRIMARY KEY,
  "order_id" text NOT NULL REFERENCES "food_orders"("id") ON DELETE CASCADE,
  "dish_id" text NOT NULL REFERENCES "dishes"("id"),
  "unit" "food_measurement_unit" NOT NULL,
  "ordered_qty" numeric(12, 3) NOT NULL,
  "prepared_qty" numeric(12, 3),
  "received_qty" numeric(12, 3),
  "wasted_qty" numeric(12, 3),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_food_order_items_order" ON "food_order_items"("order_id");
CREATE INDEX IF NOT EXISTS "idx_food_order_items_dish" ON "food_order_items"("dish_id");

CREATE TABLE IF NOT EXISTS "food_order_events" (
  "id" text PRIMARY KEY,
  "order_id" text NOT NULL REFERENCES "food_orders"("id") ON DELETE CASCADE,
  "status" "food_order_status" NOT NULL,
  "note" text,
  "actor_id" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_food_order_events_order" ON "food_order_events"("order_id");

COMMIT;
