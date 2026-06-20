/**
 * Food Ordering & Kitchen Operations — extended routes (Phases 1–3).
 *
 * Mounted at /food alongside the core foodRouter; holds capabilities added after
 * the original PRD build: kitchens, meal config & cut-off windows, dispatch
 * trips (van/driver/ETA), kitchen accept/reject, multi-meal order batches, menu
 * sharing, advanced analytics, XLS/PDF exports, and the Unit-Lead home insights
 * (property overview, active guests, monthly revenue).
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  kitchensTable,
  citiesTable,
  foodBrandsTable,
  foodDispatchesTable,
  foodOrderBatchesTable,
  foodMealConfigTable,
  foodMealWindowsTable,
  foodCutoffsTable,
  foodMenuSharesTable,
  foodOrdersTable,
  foodOrderItemsTable,
  foodOrderEventsTable,
  dishesTable,
  deliveryPartnersTable,
  agenciesTable,
  agencyVehiclesTable,
  propertiesTable,
  usersTable,
  residentsTable,
  roomsTable,
  paymentsTable,
  kycRequestsTable,
} from "@workspace/db";
import { and, eq, or, ilike, sql, desc, gte, lte, inArray, isNull, isNotNull } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import {
  resolveAccessiblePropertyIds,
  computeOrderItems,
  nextOrderNumber,
  getPropertyFoodConfig,
  resolveOrderPreview,
  resolveMenu,
} from "../lib/food-service.js";
import { notifyOrderEvent } from "../lib/notification-service.js";
import { toXls, toPdf } from "../lib/export-service.js";

export const foodOpsRouter: Router = Router();

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;

function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}
/** Sets `HH:MM` time-of-day onto a copy of `base`. */
function atTime(base: Date, hhmm: string | null | undefined): Date | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (h == null || isNaN(h)) return null;
  const d = new Date(base);
  d.setHours(h, m || 0, 0, 0);
  return d;
}

/** Resolves the applicable meal window (property override → global default). */
async function resolveWindow(brand: string, mealType: string, propertyId: string) {
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
  // Prefer property-specific.
  return rows.sort((a, b) => (a.propertyId === propertyId ? -1 : 1))[0] ?? null;
}

/** Resolves the single order cut-off time for a brand (property override → global). */
async function resolveCutoff(brand: string, propertyId?: string): Promise<string | null> {
  const rows = await db.select().from(foodCutoffsTable).where(and(
    eq(foodCutoffsTable.brand, brand as never),
    eq(foodCutoffsTable.isActive, true),
    propertyId ? or(isNull(foodCutoffsTable.propertyId), eq(foodCutoffsTable.propertyId, propertyId)) : isNull(foodCutoffsTable.propertyId),
  )).orderBy(desc(foodCutoffsTable.updatedAt));
  // Property-specific row wins; otherwise the newest global (deterministic).
  const row = rows.sort((a, b) => (a.propertyId === propertyId ? -1 : 1))[0] ?? null;
  return row?.cutoffTime ?? null;
}

/** Expected delivery time = serviceDate@serviceTime + leadTime (delay baseline). */
async function expectedDeliveryAt(brand: string, mealType: string, serviceDate: Date, propertyId: string) {
  const w = await resolveWindow(brand, mealType, propertyId);
  if (!w) return null;
  const base = atTime(serviceDate, w.serviceTime);
  if (!base) return null;
  return new Date(base.getTime() + (w.leadTimeMinutes ?? 0) * 60000);
}

async function nextSeq(prefix: string, column: any, table: any): Promise<string> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(table).where(sql`${column} like ${prefix + "%"}`);
  return prefix + String((row?.c ?? 0) + 1).padStart(6, "0");
}

/* ════════════════════════════════════════════════════════════════════════
 * Meal config & cut-off windows (Persona st.11, st.27)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/meal-config", authenticate, async (_req, res) => {
  try {
    const rows = await db.select().from(foodMealConfigTable).orderBy(foodMealConfigTable.sortOrder);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.put("/meal-config/:mealType", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.displayLabel !== undefined) u["displayLabel"] = b.displayLabel;
    if (b.sortOrder !== undefined) u["sortOrder"] = Number(b.sortOrder);
    if (b.isEnabled !== undefined) u["isEnabled"] = !!b.isEnabled;
    const [row] = await db.update(foodMealConfigTable).set(u as never)
      .where(eq(foodMealConfigTable.mealType, req.params["mealType"] as never)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/meal-windows", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const conds = [] as any[];
    if (brand) conds.push(eq(foodMealWindowsTable.brand, brand as never));
    if (propertyId) conds.push(or(isNull(foodMealWindowsTable.propertyId), eq(foodMealWindowsTable.propertyId, propertyId)));
    const rows = await db.select().from(foodMealWindowsTable).where(conds.length ? and(...conds) : undefined);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/meal-windows", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.brand || !b.mealType) { res.status(400).json({ success: false, error: "brand and mealType required" }); return; }
    const [row] = await db.insert(foodMealWindowsTable).values({
      id: newId(), brand: b.brand, propertyId: b.propertyId ?? null, mealType: b.mealType,
      cutoffTime: b.cutoffTime ?? null, serviceTime: b.serviceTime ?? null,
      leadTimeMinutes: b.leadTimeMinutes != null ? Number(b.leadTimeMinutes) : 0,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.put("/meal-windows/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "mealType", "cutoffTime", "serviceTime", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.propertyId !== undefined) u["propertyId"] = b.propertyId ?? null;
    if (b.leadTimeMinutes !== undefined) u["leadTimeMinutes"] = Number(b.leadTimeMinutes);
    const [row] = await db.update(foodMealWindowsTable).set(u as never).where(eq(foodMealWindowsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.delete("/meal-windows/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    await db.delete(foodMealWindowsTable).where(eq(foodMealWindowsTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ── Single cut-off per brand (applies to all meals; property-overridable) ── */
foodOpsRouter.get("/cutoff-config", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const conds = [] as any[];
    if (brand) conds.push(eq(foodCutoffsTable.brand, brand as never));
    const rows = await db.select().from(foodCutoffsTable).where(conds.length ? and(...conds) : undefined).orderBy(foodCutoffsTable.brand);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/cutoff-config", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.brand || !b.cutoffTime) { res.status(400).json({ success: false, error: "brand and cutoffTime required" }); return; }
    const propertyId = b.propertyId ?? null;
    // Unique index doesn't catch NULL propertyId (Postgres treats NULLs as distinct), so dedup explicitly.
    const existing = await db.select({ id: foodCutoffsTable.id }).from(foodCutoffsTable).where(and(
      eq(foodCutoffsTable.brand, b.brand as never),
      propertyId ? eq(foodCutoffsTable.propertyId, propertyId) : isNull(foodCutoffsTable.propertyId),
    ));
    if (existing.length) { res.status(409).json({ success: false, error: "A cut-off already exists for this brand/property" }); return; }
    const [row] = await db.insert(foodCutoffsTable).values({
      id: newId(), brand: b.brand, propertyId, cutoffTime: b.cutoffTime,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    const dup = String((err as Error)?.message || "").toLowerCase().includes("unique");
    req.log.error(err); res.status(dup ? 409 : 500).json({ success: false, error: dup ? "A cut-off already exists for this brand/property" : "Internal server error" });
  }
});

foodOpsRouter.put("/cutoff-config/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "propertyId", "cutoffTime", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(foodCutoffsTable).set(u as never).where(eq(foodCutoffsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.delete("/cutoff-config/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    await db.delete(foodCutoffsTable).where(eq(foodCutoffsTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Resolved cut-off info for placing orders on a given date (single cut-off, all meals). */
foodOpsRouter.get("/cutoffs", authenticate, async (req, res) => {
  try {
    const brand = (req.query["brand"] as string) || "UNILIV";
    const propertyId = req.query["propertyId"] as string | undefined;
    const date = parseDate(req.query["date"]) ?? new Date();
    const now = new Date();

    // Single cut-off for ALL meals that day (property override → brand default).
    const cutoffTime = await resolveCutoff(brand, propertyId);
    const cutoffAt = cutoffTime ? atTime(date, cutoffTime) : null;
    const isPastCutoff = cutoffAt ? now > cutoffAt : false;

    // Each meal keeps its own service time (for ETAs); the cut-off is shared.
    const out = [];
    for (const mt of MEAL_TYPES) {
      const w = propertyId ? await resolveWindow(brand, mt, propertyId) : (
        await db.select().from(foodMealWindowsTable).where(and(
          eq(foodMealWindowsTable.brand, brand as never), eq(foodMealWindowsTable.mealType, mt as never),
          isNull(foodMealWindowsTable.propertyId), eq(foodMealWindowsTable.isActive, true))))[0] ?? null;
      out.push({
        mealType: mt,
        cutoffTime,
        serviceTime: w?.serviceTime ?? null,
        cutoffAt,
        isPastCutoff,
      });
    }
    res.json({ success: true, data: out });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Kitchens (Persona st.24)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/kitchens", authenticate, async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const conds = [] as any[];
    if (active !== undefined) conds.push(eq(kitchensTable.isActive, active === "true"));
    const rows = await db.select().from(kitchensTable).where(conds.length ? and(...conds) : undefined).orderBy(kitchensTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/kitchens", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.code) { res.status(400).json({ success: false, error: "name and code required" }); return; }
    const [row] = await db.insert(kitchensTable).values({
      id: newId(), name: b.name, code: b.code, brand: b.brand ?? null,
      address: b.address ?? null, city: b.city ?? null, state: b.state ?? null, pincode: b.pincode ?? null,
      contactName: b.contactName ?? null, contactPhone: b.contactPhone ?? null, contactEmail: b.contactEmail ?? null,
      cityId: b.cityId ?? null, clusterId: b.clusterId ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.put("/kitchens/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "code", "brand", "address", "city", "state", "pincode", "contactName", "contactPhone", "contactEmail", "cityId", "clusterId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(kitchensTable).set(u as never).where(eq(kitchensTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.delete("/kitchens/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(kitchensTable).set({ isActive: false, updatedAt: new Date() }).where(eq(kitchensTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Brands (admin-managed master) + org hierarchy + property assignment
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/brands", authenticate, async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const conds = [] as any[];
    if (active !== undefined) conds.push(eq(foodBrandsTable.isActive, active === "true"));
    const rows = await db.select().from(foodBrandsTable).where(conds.length ? and(...conds) : undefined).orderBy(foodBrandsTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/brands", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !b.name) { res.status(400).json({ success: false, error: "code and name required" }); return; }
    const code = String(b.code).trim().toUpperCase().replace(/\s+/g, "_");
    const [row] = await db.insert(foodBrandsTable).values({ id: newId(), code, name: b.name, isActive: b.isActive !== false, updatedAt: new Date() }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    const dup = String((err as Error)?.message || "").toLowerCase().includes("unique");
    req.log.error(err); res.status(dup ? 409 : 500).json({ success: false, error: dup ? "Brand code already exists" : "Internal server error" });
  }
});

foodOpsRouter.put("/brands/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.name !== undefined) u["name"] = b.name;
    if (b.isActive !== undefined) u["isActive"] = !!b.isActive;
    const [row] = await db.update(foodBrandsTable).set(u as never).where(eq(foodBrandsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.delete("/brands/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(foodBrandsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(foodBrandsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Full org tree: City → Kitchen → Property (with brand + active-guest counts). */
foodOpsRouter.get("/hierarchy", authenticate, authorize("FOOD_DASHBOARD", "view"), async (_req, res) => {
  try {
    const cities = await db.select().from(citiesTable).orderBy(citiesTable.name);
    const kitchens = await db.select().from(kitchensTable).orderBy(kitchensTable.name);
    const props = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, brand: propertiesTable.brand,
      kitchenId: propertiesTable.kitchenId, city: propertiesTable.city, totalBeds: propertiesTable.totalBeds,
      active: sql<number>`(select count(*)::int from ${residentsTable} where ${residentsTable.propertyId}=${propertiesTable.id} and ${residentsTable.status}='ACTIVE')`,
    }).from(propertiesTable).orderBy(propertiesTable.name);

    const propsByKitchen = new Map<string, any[]>();
    const propertiesNoKitchen: any[] = [];
    for (const p of props) {
      if (!p.kitchenId) { propertiesNoKitchen.push(p); continue; }
      const arr = propsByKitchen.get(p.kitchenId) ?? [];
      arr.push(p); propsByKitchen.set(p.kitchenId, arr);
    }
    const kitchensByCity = new Map<string, any[]>();
    const kitchensNoCity: any[] = [];
    for (const k of kitchens) {
      const node = { ...k, properties: propsByKitchen.get(k.id) ?? [] };
      if (!k.cityId) { kitchensNoCity.push(node); continue; }
      const arr = kitchensByCity.get(k.cityId) ?? [];
      arr.push(node); kitchensByCity.set(k.cityId, arr);
    }
    const tree = cities.map((c) => ({ ...c, kitchens: kitchensByCity.get(c.id) ?? [] }));
    res.json({ success: true, data: { cities: tree, kitchensNoCity, propertiesNoKitchen } });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/properties/:id/assign-brand", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const brand = req.body?.brand ? String(req.body.brand) : null;
    await db.update(propertiesTable).set({ brand, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/properties/:id/assign-kitchen", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const kitchenId = req.body?.kitchenId ? String(req.body.kitchenId) : null;
    await db.update(propertiesTable).set({ kitchenId, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Kitchen accept / reject (Persona st.22)
 * ════════════════════════════════════════════════════════════════════════ */

async function loadOrderForActor(req: any, res: any): Promise<typeof foodOrdersTable.$inferSelect | null> {
  const id = req.params["id"]!;
  const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
  if (!order) { res.status(404).json({ success: false, error: "Not found" }); return null; }
  const ids = await resolveAccessiblePropertyIds(req.user!);
  if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return null; }
  return order;
}

async function notifyForOrder(order: typeof foodOrdersTable.$inferSelect, event: any, extra: any = {}) {
  const [prop] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, order.propertyId));
  await notifyOrderEvent(event, {
    unitLeadId: order.unitLeadId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    propertyName: prop?.name ?? null,
    mealType: order.mealType,
    brand: order.brand,
    ...extra,
  });
}

foodOpsRouter.post("/orders/:id/accept", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    const order = await loadOrderForActor(req, res); if (!order) return;
    if (order.status !== "PLACED") { res.status(422).json({ success: false, error: "Only PLACED orders can be accepted" }); return; }
    const now = new Date();
    const [updated] = await db.update(foodOrdersTable).set({ status: "ACCEPTED", acceptedAt: now, acceptedById: req.user!.id, updatedAt: now }).where(eq(foodOrdersTable.id, order.id)).returning();
    await db.insert(foodOrderEventsTable).values({ id: newId(), orderId: order.id, status: "ACCEPTED", note: "Order accepted by kitchen", actorId: req.user!.id });
    await notifyForOrder(order, "ACCEPTED");
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/orders/:id/reject", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    const order = await loadOrderForActor(req, res); if (!order) return;
    if (order.status !== "PLACED" && order.status !== "ACCEPTED") { res.status(422).json({ success: false, error: "Only PLACED/ACCEPTED orders can be rejected" }); return; }
    const reason = req.body?.reason ?? null;
    const now = new Date();
    const [updated] = await db.update(foodOrdersTable).set({ status: "REJECTED", rejectedAt: now, rejectionReason: reason, updatedAt: now }).where(eq(foodOrdersTable.id, order.id)).returning();
    await db.insert(foodOrderEventsTable).values({ id: newId(), orderId: order.id, status: "REJECTED", note: reason ? `Rejected: ${reason}` : "Order rejected", actorId: req.user!.id });
    await notifyForOrder(order, "REJECTED", { reason });
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Dispatch trips (Persona st.24)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/dispatches", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const rows = await db.select({
      d: foodDispatchesTable,
      kitchenName: kitchensTable.name,
      kitchenCode: kitchensTable.code,
      partnerName: agenciesTable.name,
      orderCount: sql<number>`(select count(*)::int from ${foodOrdersTable} where ${foodOrdersTable.dispatchId} = ${foodDispatchesTable.id})`,
    }).from(foodDispatchesTable)
      .leftJoin(kitchensTable, eq(foodDispatchesTable.kitchenId, kitchensTable.id))
      .leftJoin(agenciesTable, eq(foodDispatchesTable.deliveryPartnerId, agenciesTable.id))
      .orderBy(desc(foodDispatchesTable.createdAt)).limit(100);
    res.json({ success: true, data: rows.map((r) => ({ ...r.d, kitchenName: r.kitchenName, kitchenCode: r.kitchenCode, partnerName: r.partnerName, orderCount: r.orderCount })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/dispatches/:id", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [row] = await db.select({
      d: foodDispatchesTable, kitchen: kitchensTable, partnerName: agenciesTable.name,
    }).from(foodDispatchesTable)
      .leftJoin(kitchensTable, eq(foodDispatchesTable.kitchenId, kitchensTable.id))
      .leftJoin(agenciesTable, eq(foodDispatchesTable.deliveryPartnerId, agenciesTable.id))
      .where(eq(foodDispatchesTable.id, id));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const orders = await db.select({
      o: foodOrdersTable, propertyName: propertiesTable.name,
    }).from(foodOrdersTable).leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .where(eq(foodOrdersTable.dispatchId, id));
    res.json({ success: true, data: { ...row.d, kitchen: row.kitchen, partnerName: row.partnerName, orders: orders.map((r) => ({ ...r.o, propertyName: r.propertyName, totalQuantity: r.o.totalQuantity != null ? Number(r.o.totalQuantity) : null })) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Create a dispatch trip and dispatch its orders in one action. */
foodOpsRouter.post("/dispatches", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const orderIds: string[] = Array.isArray(b.orderIds) ? b.orderIds : [];
    if (!orderIds.length) { res.status(400).json({ success: false, error: "orderIds required" }); return; }
    // agencyId is the new field; deliveryPartnerId kept as alias.
    const agencyId = b.agencyId || b.deliveryPartnerId;
    if (!agencyId) { res.status(400).json({ success: false, error: "agencyId required" }); return; }

    // Resolve vehicle (must belong to the agency); default vehicleNumber from it.
    let vehicleId = b.vehicleId ?? null;
    let vehicleNumber = b.vehicleNumber ?? null;
    if (vehicleId) {
      const [veh] = await db.select().from(agencyVehiclesTable).where(eq(agencyVehiclesTable.id, vehicleId));
      if (!veh || veh.agencyId !== agencyId) { res.status(422).json({ success: false, error: "Vehicle does not belong to the selected agency" }); return; }
      vehicleNumber = vehicleNumber || veh.vehicleNumber;
    }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    const orders = await db.select().from(foodOrdersTable).where(inArray(foodOrdersTable.id, orderIds));
    const dispatchable = orders.filter((o) => isAccessible(o.propertyId, ids) && !["DISPATCHED", "DELIVERED", "CANCELLED", "REJECTED"].includes(o.status));
    if (!dispatchable.length) { res.status(422).json({ success: false, error: "No dispatchable orders in selection" }); return; }

    const now = new Date();
    const etaMinutes = b.etaMinutes != null ? Number(b.etaMinutes) : null;
    const estimatedArrivalAt = etaMinutes ? new Date(now.getTime() + etaMinutes * 60000) : (b.estimatedArrivalAt ? new Date(b.estimatedArrivalAt) : null);
    const dispatchNumber = await nextSeq(`DISP-${now.getFullYear()}-`, foodDispatchesTable.dispatchNumber, foodDispatchesTable);

    const [trip] = await db.insert(foodDispatchesTable).values({
      id: newId(), dispatchNumber, kitchenId: b.kitchenId ?? null, deliveryPartnerId: agencyId, vehicleId,
      vehicleNumber, driverName: b.driverName ?? null, driverPhone: b.driverPhone ?? null,
      dispatchedById: req.user!.id, dispatchedAt: now, estimatedArrivalAt, status: "IN_TRANSIT", notes: b.notes ?? null, updatedAt: now,
    }).returning();

    const etaText = estimatedArrivalAt ? estimatedArrivalAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : (etaMinutes ? `~${etaMinutes} min` : null);
    for (const o of dispatchable) {
      await db.update(foodOrdersTable).set({
        status: "DISPATCHED", dispatchId: trip!.id, kitchenId: b.kitchenId ?? o.kitchenId ?? null,
        deliveryPartnerId: agencyId, vehicleId, dispatchedById: req.user!.id, dispatchedAt: now,
        dispatchStartedAt: o.dispatchStartedAt ?? now, updatedAt: now,
      }).where(eq(foodOrdersTable.id, o.id));
      await db.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "DISPATCHED", note: `Dispatched on ${dispatchNumber}`, actorId: req.user!.id });
      const items = await db.select({ name: dishesTable.name, qty: foodOrderItemsTable.preparedQty, ordered: foodOrderItemsTable.orderedQty, unit: foodOrderItemsTable.unit })
        .from(foodOrderItemsTable).leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id)).where(eq(foodOrderItemsTable.orderId, o.id));
      await notifyForOrder(o, "DISPATCHED", {
        vehicleNumber, driverName: b.driverName ?? null, etaText,
        items: items.map((it) => ({ name: it.name ?? "Item", qty: Number(it.qty ?? it.ordered ?? 0), unit: it.unit })),
      });
    }

    res.status(201).json({ success: true, data: { ...trip, dispatchedCount: dispatchable.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.patch("/dispatches/:id/status", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    const status = req.body?.status as string;
    if (!["LOADING", "IN_TRANSIT", "DELIVERED", "PARTIAL"].includes(status)) { res.status(400).json({ success: false, error: "Invalid status" }); return; }
    const [row] = await db.update(foodDispatchesTable).set({ status: status as never, updatedAt: new Date() }).where(eq(foodDispatchesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Multi-meal order batch (Persona st.16)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.post("/order-batches", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    const { propertyId, serviceDate } = b;
    const persons = b.persons != null ? Number(b.persons) : (b.residentsCount != null ? Number(b.residentsCount) : 0);
    type MealIn = { mealType: string; quantity?: number; items?: Array<{ dishId: string; personsCount?: number; orderedQty: number; unit?: string }> };
    const meals: MealIn[] = Array.isArray(b.meals) ? b.meals : [];
    if (!propertyId || !serviceDate || !meals.length) {
      res.status(400).json({ success: false, error: "propertyId, serviceDate and at least one meal required" }); return;
    }
    const sd = new Date(serviceDate);
    if (isNaN(sd.getTime())) { res.status(400).json({ success: false, error: "Invalid serviceDate" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }

    // Brand + kitchen are inherited from the property.
    const { brand, kitchenId } = await getPropertyFoodConfig(propertyId);
    if (!brand || !kitchenId) {
      res.status(422).json({ success: false, error: "This property is not configured for ordering (missing brand or kitchen). Ask an admin to assign them." }); return;
    }

    const now = new Date();
    const batchNumber = await nextSeq(`BATCH-${now.getFullYear()}-`, foodOrderBatchesTable.batchNumber, foodOrderBatchesTable);
    const [batch] = await db.insert(foodOrderBatchesTable).values({
      id: newId(), batchNumber, propertyId, unitLeadId: req.user!.id, brand,
      serviceDate: sd, residentsCount: persons, notes: b.notes ?? null,
    }).returning();

    const [prop] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    const created: any[] = [];

    for (const meal of meals) {
      if (!(MEAL_TYPES as readonly string[]).includes(meal.mealType)) continue; // skip invalid meal types
      const menu = await resolveMenu(kitchenId, brand, meal.mealType, sd);
      const allowed = new Set(menu.map((m) => m.dishId));

      // Per-item editing path, else legacy quantity path.
      let itemRows: Array<{ dishId: string; personsCount: number; orderedQty: number; unit: string }> = [];
      if (Array.isArray(meal.items) && meal.items.length) {
        for (const it of meal.items) {
          const oq = Number(it.orderedQty);
          if (!it.dishId || !allowed.has(it.dishId) || !Number.isFinite(oq) || oq <= 0) continue;
          const md = menu.find((m) => m.dishId === it.dishId)!;
          itemRows.push({
            dishId: it.dishId,
            personsCount: it.personsCount != null ? Number(it.personsCount) : persons,
            orderedQty: Math.round(oq * 1000) / 1000,
            unit: it.unit || md.unit,
          });
        }
      } else if (meal.quantity != null) {
        const computed = await computeOrderItems(kitchenId, brand, meal.mealType, sd, Number(meal.quantity));
        itemRows = computed.map((c) => ({ dishId: c.dishId, personsCount: persons, orderedQty: c.orderedQty, unit: c.unit }));
      }
      if (!itemRows.length) continue;

      const totalQty = Math.round(itemRows.reduce((s, r) => s + r.orderedQty, 0) * 1000) / 1000;
      const expDelivery = await expectedDeliveryAt(brand, meal.mealType, sd, propertyId);
      const orderNumber = await nextOrderNumber();
      const [order] = await db.insert(foodOrdersTable).values({
        id: newId(), orderNumber, propertyId, brand, kitchenId, mealType: meal.mealType as never,
        unitLeadId: req.user!.id, residentsCount: persons || itemRows[0]!.personsCount,
        totalQuantity: String(totalQty), status: "PLACED", serviceDate: sd, batchId: batch!.id,
        expectedDeliveryAt: expDelivery, notes: b.notes ?? null, createdById: req.user!.id, updatedAt: now,
      }).returning();
      await db.insert(foodOrderItemsTable).values(itemRows.map((r) => ({
        id: newId(), orderId: order!.id, dishId: r.dishId, unit: r.unit as never,
        personsCount: r.personsCount, orderedQty: String(r.orderedQty), updatedAt: now,
      })));
      await db.insert(foodOrderEventsTable).values({ id: newId(), orderId: order!.id, status: "PLACED", note: `Order placed (batch ${batchNumber})`, actorId: req.user!.id });
      await notifyOrderEvent("PLACED", { unitLeadId: req.user!.id, orderId: order!.id, orderNumber, propertyName: prop?.name ?? null, mealType: meal.mealType, brand });
      created.push({ ...order, totalQuantity: totalQty });
    }

    res.status(201).json({ success: true, data: { batch, orders: created } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Per-item order preview: resolved menu + per-resident rule + default qty (editable grid). */
foodOpsRouter.get("/order-preview", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    if (!propertyId) { res.status(400).json({ success: false, error: "propertyId required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const sd = parseDate(req.query["serviceDate"] ?? req.query["date"]) ?? new Date();
    const persons = req.query["persons"] != null ? Number(req.query["persons"]) : 0;
    const { brand, kitchenId } = await getPropertyFoodConfig(propertyId);
    if (!brand || !kitchenId) { res.json({ success: true, data: { brand, kitchenId, configured: false, meals: [] } }); return; }

    const cfg = await db.select().from(foodMealConfigTable).where(eq(foodMealConfigTable.isEnabled, true)).orderBy(foodMealConfigTable.sortOrder);
    const meals = [];
    for (const c of cfg) {
      if (c.brand && c.brand !== brand) continue;
      const items = await resolveOrderPreview(kitchenId, brand, c.mealType, sd, persons);
      if (items.length) meals.push({ mealType: c.mealType, label: c.displayLabel, items });
    }
    res.json({ success: true, data: { brand, kitchenId, configured: true, meals } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Menu — full day + share (Persona st.13–15)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/menu/full", authenticate, async (req, res) => {
  try {
    const date = parseDate(req.query["date"]) ?? new Date();
    const propertyId = req.query["propertyId"] as string | undefined;
    let brand = (req.query["brand"] as string) || "";
    let kitchenId = (req.query["kitchenId"] as string) || "";
    if (propertyId) {
      const cfg = await getPropertyFoodConfig(propertyId);
      brand = cfg.brand || brand;
      kitchenId = cfg.kitchenId || kitchenId;
    }
    if (!brand || !kitchenId) { res.json({ success: true, data: { brand, date, meals: [] } }); return; }
    const mealCfg = await db.select().from(foodMealConfigTable).where(eq(foodMealConfigTable.isEnabled, true)).orderBy(foodMealConfigTable.sortOrder);
    const meals = [];
    for (const c of mealCfg) {
      if (c.brand && c.brand !== brand) continue;
      const dishes = await resolveMenu(kitchenId, brand, c.mealType, date);
      if (dishes.length) meals.push({ mealType: c.mealType, label: c.displayLabel, dishes });
    }
    res.json({ success: true, data: { brand, date, meals } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.post("/menu/share", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.propertyId || !b.brand || !b.channel) { res.status(400).json({ success: false, error: "propertyId, brand, channel required" }); return; }
    let recipients: string[] = Array.isArray(b.recipients) ? b.recipients : [];
    if (b.recipientType === "GUESTS") {
      const rows = await db.select({ id: residentsTable.id, name: residentsTable.name, phone: residentsTable.phone })
        .from(residentsTable).where(and(eq(residentsTable.propertyId, b.propertyId), eq(residentsTable.status, "ACTIVE")));
      recipients = rows.map((r) => r.id);
    }
    const shareToken = newId();
    const [row] = await db.insert(foodMenuSharesTable).values({
      id: newId(), sharedById: req.user!.id, propertyId: b.propertyId, brand: b.brand,
      mealType: b.mealType ?? null, menuDate: b.date ? new Date(b.date) : null, channel: b.channel,
      recipientType: b.recipientType ?? "CUSTOM", recipients, shareToken,
    }).returning();
    res.status(201).json({ success: true, data: { ...row, recipientCount: recipients.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** PUBLIC — renders a shared menu link (the `/m/:token` web page). No auth:
 *  anyone holding the share token can view that day's menu (read-only, no PII). */
foodOpsRouter.get("/menu/shared/:token", async (req, res) => {
  try {
    const token = req.params["token"];
    const [share] = await db.select().from(foodMenuSharesTable).where(eq(foodMenuSharesTable.shareToken, token));
    if (!share) { res.status(404).json({ success: false, error: "This menu link is invalid or has expired." }); return; }
    const date = share.menuDate ?? new Date();
    const cfg = await getPropertyFoodConfig(share.propertyId);
    const brand = share.brand || cfg.brand || "";
    const kitchenId = cfg.kitchenId || "";
    const [property] = await db.select({ name: propertiesTable.name, city: propertiesTable.city })
      .from(propertiesTable).where(eq(propertiesTable.id, share.propertyId));
    const meals: Array<{ mealType: string; label: string; dishes: unknown[] }> = [];
    if (brand && kitchenId) {
      const mealCfg = await db.select().from(foodMealConfigTable).where(eq(foodMealConfigTable.isEnabled, true)).orderBy(foodMealConfigTable.sortOrder);
      for (const c of mealCfg) {
        if (c.brand && c.brand !== brand) continue;
        if (share.mealType && c.mealType !== share.mealType) continue; // single-meal share
        const dishes = await resolveMenu(kitchenId, brand, c.mealType, date);
        if (dishes.length) meals.push({ mealType: c.mealType, label: c.displayLabel, dishes });
      }
    }
    res.json({ success: true, data: { brand, date, propertyName: property?.name ?? null, city: property?.city ?? null, meals } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Advanced analytics (Persona st.33)
 * ════════════════════════════════════════════════════════════════════════ */

function periodRange(period: string | undefined, q: Record<string, unknown>): { from: Date; to: Date } {
  const to = parseDate(q["to"]) ?? new Date();
  const days = period === "week" ? 7 : period === "quarter" ? 90 : period === "year" ? 365 : 30;
  const from = parseDate(q["from"]) ?? new Date(to.getTime() - days * 86400000);
  return { from, to };
}

foodOpsRouter.get("/analytics", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const period = req.query["period"] as string | undefined;
    const { from, to } = periodRange(period, req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;

    const orderScope = [gte(foodOrdersTable.serviceDate, from), lte(foodOrdersTable.serviceDate, to)] as any[];
    if (ids !== null) orderScope.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) orderScope.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) orderScope.push(eq(foodOrdersTable.brand, brand as never));
    const where = and(...orderScope);

    const day = sql<string>`to_char(${foodOrdersTable.serviceDate}, 'YYYY-MM-DD')`;

    // Wastage trend (sum wasted qty per day)
    const wastageTrend = await db.select({ date: day, wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float` })
      .from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(day).orderBy(day);

    // Top waste items (by total wasted qty), then take top ~20%.
    const wasteByDish = await db.select({
      dishId: foodOrderItemsTable.dishId, dishName: dishesTable.name, unit: foodOrderItemsTable.unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(where).groupBy(foodOrderItemsTable.dishId, dishesTable.name, foodOrderItemsTable.unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    const nonZero = wasteByDish.filter((d) => Number(d.wasted) > 0);
    const topCount = Math.max(1, Math.ceil(nonZero.length * 0.2));
    const topWasteItems = nonZero.slice(0, topCount).map((d) => ({
      dishId: d.dishId, dishName: d.dishName, unit: d.unit,
      wasted: Math.round(Number(d.wasted) * 1000) / 1000, ordered: Math.round(Number(d.ordered) * 1000) / 1000,
      wastePct: Number(d.ordered) > 0 ? Math.round((Number(d.wasted) / Number(d.ordered)) * 1000) / 10 : 0,
    }));

    // Delays: delivered later than expectedDeliveryAt.
    const delivered = await db.select({
      date: sql<string>`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`,
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*)::int`,
    }).from(foodOrdersTable).where(and(where, isNotNull(foodOrdersTable.deliveredAt)))
      .groupBy(sql`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`).orderBy(sql`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`);

    const [delaySummary] = await db.select({
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*) filter (where ${foodOrdersTable.deliveredAt} is not null)::int`,
    }).from(foodOrdersTable).where(where);

    const [wasteSummary] = await db.select({
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id)).where(where);

    res.json({
      success: true,
      data: {
        period: period ?? "month",
        range: { from, to },
        wastageTrend: wastageTrend.map((r) => ({ date: r.date, wasted: Math.round(Number(r.wasted) * 1000) / 1000 })),
        topWasteItems,
        delays: delivered.map((r) => ({ date: r.date, delayed: r.delayed, total: r.total })),
        summary: {
          totalWasted: Math.round(Number(wasteSummary?.wasted ?? 0) * 1000) / 1000,
          totalOrdered: Math.round(Number(wasteSummary?.ordered ?? 0) * 1000) / 1000,
          wastePct: Number(wasteSummary?.ordered) > 0 ? Math.round((Number(wasteSummary?.wasted) / Number(wasteSummary?.ordered)) * 1000) / 10 : 0,
          delayedOrders: delaySummary?.delayed ?? 0,
          deliveredOrders: delaySummary?.total ?? 0,
        },
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Exports — orders & guests (Persona st.34, st.47)
 * ════════════════════════════════════════════════════════════════════════ */

async function fetchOrdersForExport(req: any) {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const conds = [] as any[];
  if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
  const status = req.query["status"] as string | undefined;
  const from = parseDate(req.query["from"]); const to = parseDate(req.query["to"]);
  const propertyId = req.query["propertyId"] as string | undefined;
  const brand = req.query["brand"] as string | undefined;
  if (status) conds.push(eq(foodOrdersTable.status, status as never));
  if (from) conds.push(gte(foodOrdersTable.serviceDate, from));
  if (to) conds.push(lte(foodOrdersTable.serviceDate, to));
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
  const rows = await db.select({ o: foodOrdersTable, propertyName: propertiesTable.name, unitLeadName: usersTable.name })
    .from(foodOrdersTable).leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
    .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(foodOrdersTable.serviceDate));
  return rows.map((r) => [
    r.o.orderNumber, r.propertyName ?? "", r.unitLeadName ?? "", r.o.brand, r.o.mealType,
    r.o.residentsCount, r.o.totalQuantity != null ? Number(r.o.totalQuantity) : "", r.o.status,
    r.o.serviceDate ? new Date(r.o.serviceDate).toISOString().slice(0, 10) : "",
    r.o.deliveredAt ? new Date(r.o.deliveredAt).toISOString().slice(0, 16).replace("T", " ") : "",
  ]);
}
const ORDER_HEADERS = ["Order ID", "Property", "Unit Lead", "Brand", "Meal", "Residents", "Quantity", "Status", "Service Date", "Delivered At"];

foodOpsRouter.get("/reports/export.xlsx", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const rows = await fetchOrdersForExport(req);
    const xls = toXls({ title: "Food Orders", headers: ORDER_HEADERS, rows });
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", "attachment; filename=food-orders.xls");
    res.send(xls);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/reports/export.pdf", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const rows = await fetchOrdersForExport(req);
    const pdf = await toPdf({ title: "Food Orders Report", headers: ORDER_HEADERS, rows });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=food-orders.pdf");
    res.send(Buffer.from(pdf));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Unit-Lead home insights — property, guests, revenue (Persona st.42–48)
 * ════════════════════════════════════════════════════════════════════════ */

/** Pick the property to report on: explicit ?propertyId, user's own, or first accessible. */
async function targetProperty(req: any): Promise<string | null> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const requested = req.query["propertyId"] as string | undefined;
  if (requested && isAccessible(requested, ids)) return requested;
  if (req.user!.propertyId && isAccessible(req.user!.propertyId, ids)) return req.user!.propertyId;
  if (ids === null) {
    const [p] = await db.select({ id: propertiesTable.id }).from(propertiesTable).orderBy(propertiesTable.name).limit(1);
    return p?.id ?? null;
  }
  return ids[0] ?? null;
}

/** Per-property cards for every property the signed-in user can access (unit-lead "My Properties"). */
foodOpsRouter.get("/my-properties", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const where = ids === null ? undefined : (ids.length ? inArray(propertiesTable.id, ids) : sql`false`);
    const props = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city,
      brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId, totalBeds: propertiesTable.totalBeds,
    }).from(propertiesTable).where(where).orderBy(propertiesTable.name);
    if (!props.length) { res.json({ success: true, data: [] }); return; }
    const propIds = props.map((p) => p.id);

    const kitchens = await db.select({ id: kitchensTable.id, name: kitchensTable.name }).from(kitchensTable);
    const kitchenName = new Map(kitchens.map((k) => [k.id, k.name]));

    const guests = await db.select({ propertyId: residentsTable.propertyId, c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(inArray(residentsTable.propertyId, propIds), eq(residentsTable.status, "ACTIVE")))
      .groupBy(residentsTable.propertyId);
    const guestCount = new Map(guests.map((g) => [g.propertyId, g.c]));

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const revs = await db.select({ propertyId: residentsTable.propertyId, total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(inArray(residentsTable.propertyId, propIds), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)))
      .groupBy(residentsTable.propertyId);
    const revByProp = new Map(revs.map((r) => [r.propertyId, Math.round(Number(r.total))]));

    // Non-terminal order counts per property + status, for "pending actions".
    const ordRows = await db.select({ propertyId: foodOrdersTable.propertyId, status: foodOrdersTable.status, c: sql<number>`count(*)::int` })
      .from(foodOrdersTable)
      .where(and(inArray(foodOrdersTable.propertyId, propIds), sql`${foodOrdersTable.status} not in ('DELIVERED','CANCELLED','REJECTED')`))
      .groupBy(foodOrdersTable.propertyId, foodOrdersTable.status);
    const pendingByProp = new Map<string, { active: number; awaitingDelivery: number }>();
    for (const r of ordRows) {
      const e = pendingByProp.get(r.propertyId) ?? { active: 0, awaitingDelivery: 0 };
      e.active += r.c;
      if (r.status === "DISPATCHED") e.awaitingDelivery += r.c;
      pendingByProp.set(r.propertyId, e);
    }

    const data = props.map((p) => {
      const active = guestCount.get(p.id) ?? 0;
      const pend = pendingByProp.get(p.id) ?? { active: 0, awaitingDelivery: 0 };
      return {
        id: p.id, name: p.name, city: p.city, brand: p.brand,
        kitchenId: p.kitchenId, kitchenName: p.kitchenId ? (kitchenName.get(p.kitchenId) ?? null) : null,
        totalBeds: p.totalBeds, activeGuests: active,
        occupancyPct: p.totalBeds ? Math.round((active / p.totalBeds) * 100) : 0,
        monthlyRevenue: revByProp.get(p.id) ?? 0,
        activeOrders: pend.active, awaitingDelivery: pend.awaitingDelivery,
        configured: Boolean(p.brand && p.kitchenId),
      };
    });
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/property-overview", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const propertyId = await targetProperty(req);
    if (!propertyId) { res.json({ success: true, data: null }); return; }
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    if (!prop) { res.json({ success: true, data: null }); return; }
    const [occ] = await db.select({ c: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.propertyId, propertyId), eq(residentsTable.status, "ACTIVE")));
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const [rev] = await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(eq(residentsTable.propertyId, propertyId), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)));
    res.json({
      success: true,
      data: {
        id: prop.id, name: prop.name, address: prop.address, city: prop.city, state: prop.state, pincode: prop.pincode,
        totalBeds: prop.totalBeds, occupied: occ?.c ?? 0, activeGuests: occ?.c ?? 0,
        occupancyPct: prop.totalBeds ? Math.round(((occ?.c ?? 0) / prop.totalBeds) * 100) : 0,
        monthlyRevenue: Math.round(Number(rev?.total ?? 0)),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/revenue", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const propertyId = await targetProperty(req);
    if (!propertyId) { res.json({ success: true, data: { months: [] } }); return; }
    const since = new Date(); since.setMonth(since.getMonth() - 5); since.setDate(1); since.setHours(0, 0, 0, 0);
    const month = sql<string>`to_char(${paymentsTable.createdAt}, 'YYYY-MM')`;
    const rows = await db.select({ month, total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(eq(residentsTable.propertyId, propertyId), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, since)))
      .groupBy(month).orderBy(month);
    res.json({ success: true, data: { months: rows.map((r) => ({ month: r.month, total: Math.round(Number(r.total)) })) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Active-guest list with global search (name/phone/email/room/PAN/Aadhaar). */
async function fetchGuests(req: any) {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const propertyId = req.query["propertyId"] as string | undefined;
  const search = (req.query["search"] as string | undefined)?.trim();

  const conds = [eq(residentsTable.status, "ACTIVE")] as any[];
  if (propertyId) conds.push(eq(residentsTable.propertyId, propertyId));
  else if (ids !== null) conds.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);

  if (search) {
    const like = `%${search}%`;
    const orParts: any[] = [
      ilike(residentsTable.name, like),
      ilike(residentsTable.phone, like),
      ilike(residentsTable.email, like),
    ];
    // Room number match.
    const rmRows = await db.select({ id: roomsTable.id }).from(roomsTable).where(ilike(roomsTable.number, like));
    if (rmRows.length) orParts.push(inArray(residentsTable.roomId, rmRows.map((r) => r.id)));
    // PAN / Aadhaar via KYC id number (Persona st.46) — index + join, no PII on residents.
    const kycRows = await db.select({ rid: kycRequestsTable.residentId }).from(kycRequestsTable).where(ilike(kycRequestsTable.idNumber, like));
    if (kycRows.length) orParts.push(inArray(residentsTable.id, kycRows.map((r) => r.rid)));
    conds.push(or(...orParts));
  }
  return { where: and(...conds) };
}

foodOpsRouter.get("/guests", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const { where } = await fetchGuests(req);
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(where);
    const rows = await db.select({
      r: residentsTable, propertyName: propertiesTable.name, roomNumber: roomsTable.number,
    }).from(residentsTable)
      .leftJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id))
      .leftJoin(roomsTable, eq(residentsTable.roomId, roomsTable.id))
      .where(where).orderBy(residentsTable.name).limit(limit).offset(offset);
    const data = rows.map((r) => ({
      id: r.r.id, name: r.r.name, phone: r.r.phone, email: r.r.email, gender: r.r.gender,
      roomNumber: r.roomNumber, propertyId: r.r.propertyId, propertyName: r.propertyName,
      checkInDate: r.r.checkInDate, status: r.r.status,
    }));
    res.json({ success: true, data, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const GUEST_HEADERS = ["Guest ID", "Name", "Mobile", "Email", "Gender", "Room", "Property", "Guest Since"];
async function guestExportRows(req: any) {
  const { where } = await fetchGuests(req);
  const rows = await db.select({ r: residentsTable, propertyName: propertiesTable.name, roomNumber: roomsTable.number })
    .from(residentsTable).leftJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id))
    .leftJoin(roomsTable, eq(residentsTable.roomId, roomsTable.id)).where(where).orderBy(residentsTable.name);
  return rows.map((r) => [
    r.r.id.slice(0, 8), r.r.name, r.r.phone, r.r.email, r.r.gender ?? "", r.roomNumber ?? "",
    r.propertyName ?? "", r.r.checkInDate ? new Date(r.r.checkInDate).toISOString().slice(0, 10) : "",
  ]);
}

foodOpsRouter.get("/guests/export.xlsx", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const rows = await guestExportRows(req);
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", "attachment; filename=active-guests.xls");
    res.send(toXls({ title: "Active Guests", headers: GUEST_HEADERS, rows }));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/guests/export.pdf", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const rows = await guestExportRows(req);
    const pdf = await toPdf({ title: "Active Guests", headers: GUEST_HEADERS, rows });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=active-guests.pdf");
    res.send(Buffer.from(pdf));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default foodOpsRouter;
