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
  kitchenPincodesTable,
  citiesTable,
  clustersTable,
  foodBrandsTable,
  foodDispatchesTable,
  foodDispatchEventsTable,
  agencyKitchensTable,
  DISPATCH_TRANSITIONS,
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
  systemConfigTable,
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
  getDefaultCutoffTime,
  getSystemConfigValue,
  FOOD_DEFAULT_CUTOFF_KEY,
  FOOD_WASTE_WINDOW_KEY,
} from "../lib/food-service.js";
import { notify, notifyOrderEvent } from "../lib/notification-service.js";
import { toCsv, toPdf, toXls, fmtDate, fmtDateTime, fileDateStamp, sanitizeForFilename } from "../lib/export-service.js";
import { blindIndex } from "../lib/field-crypto.js";
import { istDayYmd, addDaysYmd, atIst } from "../lib/tz.js";
import { z } from "zod";

export const foodOpsRouter: Router = Router();

/** Transaction client type (mirrors wallet-service); `db` itself also satisfies it. */
export type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either a transaction handle or the top-level db — both share the query surface used here. */
type DbLike = TxClient | typeof db;

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;

/** Base for public/share links (mirrors auth.ts; trailing slashes trimmed). */
const APP_BASE_URL = (process.env["APP_BASE_URL"] || "").replace(/\/+$/, "");

/* ────────────────────────────────────────────────────────────────────────────
 * Request-body validation (WS6)
 *
 * Additive zod gates on the mutating handlers below. Each runs BEFORE the
 * handler's existing body logic and only 400s malformed/missing-required input;
 * valid requests parse and flow through the unchanged code. Schemas are kept
 * permissive (bounded free-text/ids, enums only where the handler already
 * hand-checks them) so no previously-accepted request is newly rejected.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Mirror of operations.ts: validate req.body, 400 with field details on failure. */
function validateBody<T>(schema: z.ZodType<T>, req: { body: unknown }, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): boolean {
  const p = schema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ success: false, error: "Invalid request", details: p.error.flatten() });
    return false;
  }
  return true;
}

const zId = z.string().min(1).max(128);
const zText = z.string().max(1000);
const zMealType = z.enum(MEAL_TYPES);
const zBrand = z.string().min(1).max(128);
const zDateLike = z.union([z.string(), z.number(), z.coerce.date()]);

function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}
/**
 * Absolute instant for the IST wall-clock `HH:MM` on the IST CALENDAR day that
 * `base` falls on. Anchored to Asia/Kolkata (fixed UTC+5:30) so the result is the
 * same correct instant regardless of the server/process timezone.
 */
function atTime(base: Date, hhmm: string | null | undefined): Date | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (h == null || isNaN(h)) return null;
  return atIst(istDayYmd(base), `${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`);
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
  // Fall back to the SUPER_ADMIN-configured global default (system_config) so the
  // 09:00 default actually blocks ordering when no brand/property row exists.
  return row?.cutoffTime ?? (await getDefaultCutoffTime());
}

/**
 * Server-side enforcement of the order cut-off, shared by BOTH order-placement
 * endpoints (POST /food/orders in food.ts and POST /food/order-batches here) so
 * the cut-off can't be bypassed by calling the API directly. A single cut-off per
 * brand/property applies to all meals on the service day. Rejects when:
 *   1. the service day is already in the past, or
 *   2. the resolved cut-off time for that service date has passed.
 * Returns a user-facing error string (caller responds 422), or null if allowed.
 */
export async function checkOrderCutoff(
  brand: string,
  propertyId: string | undefined,
  serviceDate: Date,
): Promise<string | null> {
  const now = new Date();
  // The serviceDate is an IST CALENDAR date. All comparisons below are done on
  // IST wall-clock days / IST-anchored instants so cut-off logic is correct
  // regardless of the server/process timezone.
  const serviceYmd = istDayYmd(serviceDate);
  const todayYmd = istDayYmd(now);
  // 1) No ordering for a day that has already gone by (IST calendar comparison).
  if (serviceYmd < todayYmd) {
    return "Cannot place an order for a past date.";
  }
  // 2) Once the resolved cut-off passes, ordering is closed. The cut-off deadline
  //    is anchored on the DAY BEFORE the service date: an order for tomorrow must
  //    be placed by today's cut-off time (atIst(serviceDate - 1 day, cutoffTime)).
  const cutoffTime = await resolveCutoff(brand, propertyId);
  const prevDayYmd = addDaysYmd(serviceYmd, -1);
  const cutoffAt = cutoffTime ? atIst(prevDayYmd, cutoffTime) : null;
  if (cutoffAt && now > cutoffAt) {
    const [y, m, d] = serviceYmd.split("-");
    const label = `${d}/${m}/${y}`;
    return `Ordering for ${label} is closed — the ${cutoffTime} cut-off has passed.`;
  }
  return null;
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

const updateMealConfigSchema = z.object({
  displayLabel: z.string().max(256).optional(),
  sortOrder: z.coerce.number().optional(),
  isEnabled: z.boolean().optional(),
}).passthrough();

foodOpsRouter.put("/meal-config/:mealType", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateMealConfigSchema, req, res)) return;
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

const createMealWindowSchema = z.object({
  brand: zBrand,
  mealType: zMealType,
  propertyId: zId.nullish(),
  cutoffTime: z.string().max(16).nullish(),
  serviceTime: z.string().max(16).nullish(),
  leadTimeMinutes: z.coerce.number().nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/meal-windows", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createMealWindowSchema, req, res)) return;
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

const updateMealWindowSchema = z.object({
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  cutoffTime: z.string().max(16).nullish(),
  serviceTime: z.string().max(16).nullish(),
  isActive: z.boolean().optional(),
  propertyId: zId.nullish(),
  leadTimeMinutes: z.coerce.number().optional(),
}).passthrough();

foodOpsRouter.put("/meal-windows/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateMealWindowSchema, req, res)) return;
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

const createCutoffSchema = z.object({
  brand: zBrand,
  cutoffTime: z.string().min(1).max(16),
  propertyId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/cutoff-config", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createCutoffSchema, req, res)) return;
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

const updateCutoffSchema = z.object({
  brand: zBrand.optional(),
  propertyId: zId.nullish(),
  cutoffTime: z.string().max(16).optional(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.put("/cutoff-config/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateCutoffSchema, req, res)) return;
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
    // The deadline is anchored on the DAY BEFORE the service date, matching
    // server-side enforcement in checkOrderCutoff (order tomorrow by today's cut-off).
    // serviceDate is an IST calendar date; anchor the deadline to the IST
    // wall-clock cut-off on the DAY BEFORE so it matches checkOrderCutoff.
    const cutoffTime = await resolveCutoff(brand, propertyId);
    const prevDayYmd = addDaysYmd(istDayYmd(date), -1);
    const cutoffAt = cutoffTime ? atIst(prevDayYmd, cutoffTime) : null;
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
 * Global food defaults (system_config) — SUPER_ADMIN configures the org-wide
 * fallback cut-off time and waste-edit window. Stored as raw JSON scalars under
 * canonical keys (food_default_cutoff = "09:00", food_waste_edit_window_minutes = 60).
 * ════════════════════════════════════════════════════════════════════════ */

/** Read the current global food defaults. Any authenticated food user may read. */
foodOpsRouter.get("/system-config/food-defaults", authenticate, async (req, res) => {
  try {
    const defaultCutoff = await getDefaultCutoffTime();
    const rawWindow = await getSystemConfigValue<number>(FOOD_WASTE_WINDOW_KEY, 60);
    const wasteWindowMinutes = Number.isFinite(Number(rawWindow)) && Number(rawWindow) > 0 ? Number(rawWindow) : 60;
    res.json({ success: true, data: { defaultCutoff, wasteWindowMinutes } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Upsert the global food defaults. SUPER_ADMIN only (org-wide setting). */
// Both fields optional; the handler hand-validates HH:MM / positive-number formats
// (keep these loose so those specific 400 messages are preserved).
const foodDefaultsSchema = z.object({
  defaultCutoff: z.union([z.string(), z.number()]).optional(),
  wasteWindowMinutes: z.union([z.string(), z.number()]).optional(),
}).passthrough();

foodOpsRouter.put("/system-config/food-defaults", authenticate, async (req, res) => {
  try {
    if (req.user?.role !== "SUPER_ADMIN") {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" });
      return;
    }
    if (!validateBody(foodDefaultsSchema, req, res)) return;
    const b = req.body || {};
    const updates: Array<{ key: string; value: unknown; description: string }> = [];

    if (b.defaultCutoff !== undefined) {
      const v = String(b.defaultCutoff);
      if (!/^\d{1,2}:\d{2}$/.test(v)) { res.status(400).json({ success: false, error: "defaultCutoff must be HH:MM" }); return; }
      updates.push({ key: FOOD_DEFAULT_CUTOFF_KEY, value: v, description: "Default order cut-off time (HH:MM) when no brand/property cut-off is set." });
    }
    if (b.wasteWindowMinutes !== undefined) {
      const n = Number(b.wasteWindowMinutes);
      if (!Number.isFinite(n) || n <= 0) { res.status(400).json({ success: false, error: "wasteWindowMinutes must be a positive number" }); return; }
      updates.push({ key: FOOD_WASTE_WINDOW_KEY, value: n, description: "Minutes after delivery during which waste can still be recorded." });
    }
    if (!updates.length) { res.status(400).json({ success: false, error: "Nothing to update" }); return; }

    for (const u of updates) {
      await db.insert(systemConfigTable)
        .values({ id: newId(), key: u.key, value: u.value as never, description: u.description, updatedAt: new Date() })
        .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: u.value as never, updatedAt: new Date() } });
    }

    const defaultCutoff = await getDefaultCutoffTime();
    const rawWindow = await getSystemConfigValue<number>(FOOD_WASTE_WINDOW_KEY, 60);
    const wasteWindowMinutes = Number.isFinite(Number(rawWindow)) && Number(rawWindow) > 0 ? Number(rawWindow) : 60;
    res.json({ success: true, data: { defaultCutoff, wasteWindowMinutes } });
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

const createKitchenSchema = z.object({
  name: zText,
  code: z.string().min(1).max(64),
  brand: zBrand.nullish(),
  address: z.string().max(1000).nullish(),
  city: z.string().max(256).nullish(),
  state: z.string().max(256).nullish(),
  pincode: z.string().max(16).nullish(),
  contactName: z.string().max(256).nullish(),
  contactPhone: z.string().max(32).nullish(),
  contactEmail: z.string().max(256).nullish(),
  cityId: zId.nullish(),
  clusterId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/kitchens", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createKitchenSchema, req, res)) return;
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

const updateKitchenSchema = z.object({
  name: zText.optional(),
  code: z.string().max(64).optional(),
  brand: zBrand.nullish(),
  address: z.string().max(1000).nullish(),
  city: z.string().max(256).nullish(),
  state: z.string().max(256).nullish(),
  pincode: z.string().max(16).nullish(),
  contactName: z.string().max(256).nullish(),
  contactPhone: z.string().max(32).nullish(),
  contactEmail: z.string().max(256).nullish(),
  cityId: zId.nullish(),
  clusterId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.put("/kitchens/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateKitchenSchema, req, res)) return;
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

/**
 * Resolve the kitchen that serves a given pincode (kitchen_pincodes → kitchens).
 * Pincode is globally unique so at most ONE active kitchen maps to it. Used by
 * the Add/Edit Property form to auto-derive a read-only kitchen from the pincode.
 *
 * Returns HTTP 200 with { kitchenId: null } (NOT 404) when no active mapping
 * exists, so the form can render a friendly "no kitchen for this pincode" message
 * and block submission. authenticate-only (non-sensitive reference read).
 */
foodOpsRouter.get("/kitchen-by-pincode", authenticate, async (req, res) => {
  try {
    const pincode = String(req.query["pincode"] ?? "").trim();
    if (!/^\d{6}$/.test(pincode)) {
      res.status(400).json({ success: false, error: "A valid 6-digit pincode is required" });
      return;
    }
    const [row] = await db
      .select({ kitchenId: kitchensTable.id, kitchenName: kitchensTable.name, kitchenCode: kitchensTable.code })
      .from(kitchenPincodesTable)
      .innerJoin(kitchensTable, eq(kitchenPincodesTable.kitchenId, kitchensTable.id))
      .where(and(
        eq(kitchenPincodesTable.pincode, pincode),
        eq(kitchenPincodesTable.isActive, true),
        eq(kitchensTable.isActive, true),
      ));
    if (!row) { res.json({ success: true, data: { kitchenId: null } }); return; }
    res.json({ success: true, data: { kitchenId: row.kitchenId, kitchenName: row.kitchenName, kitchenCode: row.kitchenCode } });
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

const createBrandSchema = z.object({
  code: z.string().min(1).max(128),
  name: zText,
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/brands", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createBrandSchema, req, res)) return;
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

const updateBrandSchema = z.object({
  name: zText.optional(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.put("/brands/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateBrandSchema, req, res)) return;
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

const assignBrandSchema = z.object({ brand: z.union([z.string().max(128), z.null()]).optional() }).passthrough();

foodOpsRouter.post("/properties/:id/assign-brand", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignBrandSchema, req, res)) return;
    const brand = req.body?.brand ? String(req.body.brand) : null;
    await db.update(propertiesTable).set({ brand, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const assignKitchenSchema = z.object({ kitchenId: z.union([z.string().max(128), z.null()]).optional() }).passthrough();

foodOpsRouter.post("/properties/:id/assign-kitchen", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignKitchenSchema, req, res)) return;
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

const rejectOrderSchema = z.object({ reason: zText.nullish() }).passthrough();

foodOpsRouter.post("/orders/:id/reject", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    if (!validateBody(rejectOrderSchema, req, res)) return;
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

/** A dispatch is accessible if at least one of its orders is in the caller's scope. */
async function isDispatchAccessible(dispatchId: string, ids: string[] | null): Promise<boolean> {
  if (ids === null) return true;
  if (!ids.length) return false;
  const orders = await db.select({ propertyId: foodOrdersTable.propertyId }).from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, dispatchId));
  return orders.some((o) => isAccessible(o.propertyId, ids));
}

/** tx-aware variant of nextSeq so the dispatch number is allocated inside the same transaction. */
async function nextSeqTx(tx: DbLike, prefix: string, column: any, table: any): Promise<string> {
  const [row] = await tx.select({ c: sql<number>`count(*)::int` }).from(table).where(sql`${column} like ${prefix + "%"}`);
  return prefix + String((row?.c ?? 0) + 1).padStart(6, "0");
}

/** Append a dispatch lifecycle event (audit timeline; mirrors foodOrderEventsTable writes). */
async function writeDispatchEvent(
  tx: DbLike,
  dispatchId: string,
  status: string,
  note: string | null,
  actorId: string | null,
): Promise<void> {
  await tx.insert(foodDispatchEventsTable).values({
    id: newId(), dispatchId, status: status as never, note: note ?? null, actorId: actorId ?? null,
  });
}

/**
 * Shared dispatch-creation helper (Lane C contract; reused by Lane B's quick-dispatch).
 *
 * Creates ONE foodDispatches row in status 'LOADING', stamps dispatchId/dispatchedAt
 * (+ partner/vehicle/kitchen links) on every order in `orderIds`, and writes a
 * food_dispatch_events row. This guarantees EVERY dispatched order carries a
 * dispatchId (fixes quick-dispatch consistency gap C8). Caller is responsible for
 * scope/RBAC checks and order-status filtering; this only mutates the rows it is given.
 *
 * Runs against the supplied `tx` (or `db`) so it composes inside a larger transaction.
 */
export async function createDispatchForOrders(
  tx: DbLike,
  opts: {
    orderIds: string[];
    agencyId?: string | null;
    vehicleId?: string | null;
    vehicleNumber?: string | null;
    driverName?: string | null;
    driverPhone?: string | null;
    kitchenId?: string | null;
    etaMinutes?: number | null;
    actorId: string;
  },
): Promise<typeof foodDispatchesTable.$inferSelect> {
  const now = new Date();
  const etaMinutes = opts.etaMinutes != null ? Number(opts.etaMinutes) : null;
  const estimatedArrivalAt = etaMinutes ? new Date(now.getTime() + etaMinutes * 60000) : null;
  const dispatchNumber = await nextSeqTx(tx, `DISP-${now.getFullYear()}-`, foodDispatchesTable.dispatchNumber, foodDispatchesTable);

  const [trip] = await tx.insert(foodDispatchesTable).values({
    id: newId(), dispatchNumber, kitchenId: opts.kitchenId ?? null, deliveryPartnerId: opts.agencyId ?? null,
    vehicleId: opts.vehicleId ?? null, vehicleNumber: opts.vehicleNumber ?? null,
    driverName: opts.driverName ?? null, driverPhone: opts.driverPhone ?? null,
    dispatchedById: opts.actorId, dispatchedAt: now, estimatedArrivalAt, status: "LOADING", updatedAt: now,
  }).returning();

  for (const orderId of opts.orderIds) {
    await tx.update(foodOrdersTable).set({
      status: "DISPATCHED", dispatchId: trip!.id,
      ...(opts.kitchenId ? { kitchenId: opts.kitchenId } : {}),
      deliveryPartnerId: opts.agencyId ?? null, vehicleId: opts.vehicleId ?? null,
      dispatchedById: opts.actorId, dispatchedAt: now, dispatchStartedAt: now, updatedAt: now,
    }).where(eq(foodOrdersTable.id, orderId));
  }

  await writeDispatchEvent(tx, trip!.id, "LOADING", `Dispatch ${dispatchNumber} created (loading)`, opts.actorId);
  return trip!;
}

foodOpsRouter.get("/dispatches", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    // Org-wide roles see all; scoped roles only see trips that include an accessible order.
    const scope = ids === null ? undefined : (ids.length
      ? sql`exists (select 1 from ${foodOrdersTable} where ${foodOrdersTable.dispatchId} = ${foodDispatchesTable.id} and ${inArray(foodOrdersTable.propertyId, ids)})`
      : sql`false`);
    const rows = await db.select({
      d: foodDispatchesTable,
      kitchenName: kitchensTable.name,
      kitchenCode: kitchensTable.code,
      partnerName: agenciesTable.name,
      orderCount: sql<number>`(select count(*)::int from ${foodOrdersTable} where ${foodOrdersTable.dispatchId} = ${foodDispatchesTable.id})`,
    }).from(foodDispatchesTable)
      .leftJoin(kitchensTable, eq(foodDispatchesTable.kitchenId, kitchensTable.id))
      .leftJoin(agenciesTable, eq(foodDispatchesTable.deliveryPartnerId, agenciesTable.id))
      .where(scope)
      .orderBy(desc(foodDispatchesTable.createdAt)).limit(100);
    res.json({ success: true, data: rows.map((r) => ({ ...r.d, kitchenName: r.kitchenName, kitchenCode: r.kitchenCode, partnerName: r.partnerName, orderCount: r.orderCount })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* C6: vehicle IDs currently committed to a LOADING/IN_TRANSIT dispatch (for the
 * create form to grey out busy vehicles). Declared BEFORE "/dispatches/:id" so
 * Express does not match "active-vehicles" as an :id. */
foodOpsRouter.get("/dispatches/active-vehicles", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const rows = await db.select({ vehicleId: foodDispatchesTable.vehicleId }).from(foodDispatchesTable)
      .where(and(isNotNull(foodDispatchesTable.vehicleId), inArray(foodDispatchesTable.status, ["LOADING", "IN_TRANSIT"])));
    const vehicleIds = Array.from(new Set(rows.map((r) => r.vehicleId).filter((v): v is string => !!v)));
    res.json({ success: true, data: { vehicleIds } });
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
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    // C1: enrich each order with the delivery address (property), the unit-lead
    // contact (users via unitLeadId), and residentsCount so the dispatch detail
    // view has everything Persona st.24 requires without extra round-trips.
    const orders = await db.select({
      o: foodOrdersTable,
      propertyName: propertiesTable.name,
      deliveryAddress: propertiesTable.address,
      deliveryCity: propertiesTable.city,
      deliveryPincode: propertiesTable.pincode,
      unitLeadName: usersTable.name,
      unitLeadPhone: usersTable.phone,
      unitLeadEmail: usersTable.email,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .where(eq(foodOrdersTable.dispatchId, id));
    res.json({ success: true, data: { ...row.d, kitchen: row.kitchen, partnerName: row.partnerName, orders: orders.map((r) => ({
      ...r.o,
      propertyName: r.propertyName,
      deliveryAddress: r.deliveryAddress,
      deliveryCity: r.deliveryCity,
      deliveryPincode: r.deliveryPincode,
      unitLeadName: r.unitLeadName,
      unitLeadPhone: r.unitLeadPhone,
      unitLeadEmail: r.unitLeadEmail,
      residentsCount: r.o.residentsCount,
      totalQuantity: r.o.totalQuantity != null ? Number(r.o.totalQuantity) : null,
    })) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Create a dispatch trip and dispatch its orders in one action. */
const createDispatchSchema = z.object({
  orderIds: z.array(zId).optional(),
  // agencyId is the new field; deliveryPartnerId kept as alias (handler resolves either).
  agencyId: zId.nullish(),
  deliveryPartnerId: zId.nullish(),
  vehicleId: zId.nullish(),
  vehicleNumber: z.string().max(64).nullish(),
  kitchenId: zId.nullish(),
  driverName: z.string().max(256).nullish(),
  driverPhone: z.string().max(32).nullish(),
  etaMinutes: z.coerce.number().nullish(),
  estimatedArrivalAt: zDateLike.nullish(),
  notes: zText.nullish(),
  // C3: when true, the trip departs immediately (LOADING -> IN_TRANSIT via the
  // validated transition path) instead of staying parked in LOADING.
  departNow: z.boolean().nullish(),
}).passthrough();

foodOpsRouter.post("/dispatches", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(createDispatchSchema, req, res)) return;
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
      // C6: a vehicle already out on a LOADING/IN_TRANSIT trip cannot be re-used.
      const [busy] = await db.select({ id: foodDispatchesTable.id }).from(foodDispatchesTable)
        .where(and(eq(foodDispatchesTable.vehicleId, vehicleId), inArray(foodDispatchesTable.status, ["LOADING", "IN_TRANSIT"])))
        .limit(1);
      if (busy) { res.status(422).json({ success: false, error: "Vehicle is already in use on an active dispatch" }); return; }
    }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    const orders = await db.select().from(foodOrdersTable).where(inArray(foodOrdersTable.id, orderIds));
    const dispatchable = orders.filter((o) => isAccessible(o.propertyId, ids) && !["DISPATCHED", "DELIVERED", "CANCELLED", "REJECTED"].includes(o.status));
    if (!dispatchable.length) { res.status(422).json({ success: false, error: "No dispatchable orders in selection" }); return; }

    // C5: kitchen integrity. If a kitchen is named, the agency must serve it
    // (agency_kitchens) and every dispatchable order must share that kitchen.
    const kitchenId = b.kitchenId ?? null;
    if (kitchenId) {
      const [link] = await db.select({ id: agencyKitchensTable.id }).from(agencyKitchensTable)
        .where(and(eq(agencyKitchensTable.agencyId, agencyId), eq(agencyKitchensTable.kitchenId, kitchenId), eq(agencyKitchensTable.isActive, true)))
        .limit(1);
      if (!link) { res.status(422).json({ success: false, error: "Agency does not serve this kitchen" }); return; }
      const mismatch = dispatchable.some((o) => o.kitchenId != null && o.kitchenId !== kitchenId);
      if (mismatch) { res.status(422).json({ success: false, error: "All dispatchable orders must share the selected kitchen" }); return; }
    }

    const now = new Date();
    const etaMinutes = b.etaMinutes != null ? Number(b.etaMinutes) : null;
    const estimatedArrivalAt = etaMinutes ? new Date(now.getTime() + etaMinutes * 60000) : (b.estimatedArrivalAt ? new Date(b.estimatedArrivalAt) : null);
    const departNow = !!b.departNow;

    // C3/C8: create through the shared helper so the trip starts in LOADING and
    // every order reliably carries dispatchId. notes/explicit-ETA (not covered by
    // the helper's etaMinutes path) are stamped in a follow-up update.
    const trip = await db.transaction(async (tx) => {
      const t = await createDispatchForOrders(tx, {
        orderIds: dispatchable.map((o) => o.id),
        agencyId, vehicleId, vehicleNumber,
        driverName: b.driverName ?? null, driverPhone: b.driverPhone ?? null,
        kitchenId, etaMinutes, actorId: req.user!.id,
      });
      if (b.notes != null || (estimatedArrivalAt && !etaMinutes)) {
        const [u] = await tx.update(foodDispatchesTable).set({
          ...(b.notes != null ? { notes: b.notes } : {}),
          ...(estimatedArrivalAt && !etaMinutes ? { estimatedArrivalAt } : {}),
          updatedAt: new Date(),
        }).where(eq(foodDispatchesTable.id, t.id)).returning();
        return u ?? t;
      }
      return t;
    });

    // Per-order kitchen fallback + DISPATCHED order events + unit-lead notifications.
    // (The helper sets dispatch links; this adds the order-level audit + comms that
    // mirror the prior behavior.)
    const etaText = estimatedArrivalAt ? estimatedArrivalAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : (etaMinutes ? `~${etaMinutes} min` : null);
    for (const o of dispatchable) {
      await db.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "DISPATCHED", note: `Dispatched on ${trip.dispatchNumber}`, actorId: req.user!.id });
      const items = await db.select({ name: dishesTable.name, qty: foodOrderItemsTable.preparedQty, ordered: foodOrderItemsTable.orderedQty, unit: foodOrderItemsTable.unit })
        .from(foodOrderItemsTable).leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id)).where(eq(foodOrderItemsTable.orderId, o.id));
      await notifyForOrder(o, "DISPATCHED", {
        vehicleNumber, driverName: b.driverName ?? null, etaText,
        items: items.map((it) => ({ name: it.name ?? "Item", qty: Number(it.qty ?? it.ordered ?? 0), unit: it.unit })),
      });
    }

    // C3: depart immediately via the validated LOADING -> IN_TRANSIT transition.
    let finalTrip = trip;
    if (departNow && DISPATCH_TRANSITIONS["LOADING"]?.includes("IN_TRANSIT")) {
      const [moved] = await db.update(foodDispatchesTable).set({ status: "IN_TRANSIT", updatedAt: new Date() }).where(eq(foodDispatchesTable.id, trip.id)).returning();
      if (moved) {
        await writeDispatchEvent(db, trip.id, "IN_TRANSIT", "Departed (LOADING → IN_TRANSIT)", req.user!.id);
        finalTrip = moved;
      }
    }

    res.status(201).json({ success: true, data: { ...finalTrip, dispatchedCount: dispatchable.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// status is left a bounded string (not enum) so the handler's own "Invalid status"
// message is preserved for unknown values.
const dispatchStatusSchema = z.object({ status: z.string().max(32), note: zText.nullish() }).passthrough();

foodOpsRouter.patch("/dispatches/:id/status", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(dispatchStatusSchema, req, res)) return;
    const target = req.body?.status as string;
    const note = (req.body?.note as string | null | undefined) ?? null;
    if (!Object.prototype.hasOwnProperty.call(DISPATCH_TRANSITIONS, target)) { res.status(400).json({ success: false, error: "Invalid status" }); return; }
    const id = req.params["id"]!;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    const [current] = await db.select().from(foodDispatchesTable).where(eq(foodDispatchesTable.id, id));
    if (!current) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // C2: enforce the state machine. A no-op (same status) is allowed; otherwise
    // the target must be in DISPATCH_TRANSITIONS[current].
    if (target !== current.status && !(DISPATCH_TRANSITIONS[current.status] ?? []).includes(target)) {
      res.status(422).json({ success: false, error: `Cannot move from ${current.status} to ${target}` });
      return;
    }

    const now = new Date();
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(foodDispatchesTable).set({ status: target as never, updatedAt: now }).where(eq(foodDispatchesTable.id, id)).returning();
      // C2: audit every change.
      await writeDispatchEvent(tx, id, target, note ?? `Status ${current.status} → ${target}`, req.user!.id);
      // C2: reaching DELIVERED flips the linked (still-active) orders to DELIVERED
      // so the trip and its orders stay in sync.
      if (target === "DELIVERED" && current.status !== "DELIVERED") {
        const linked = await tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id));
        for (const o of linked) {
          if (["DELIVERED", "CANCELLED", "REJECTED"].includes(o.status)) continue;
          await tx.update(foodOrdersTable).set({ status: "DELIVERED", deliveredAt: o.deliveredAt ?? now, confirmedById: o.confirmedById ?? req.user!.id, updatedAt: now }).where(eq(foodOrdersTable.id, o.id));
          await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "DELIVERED", note: `Delivered with dispatch ${current.dispatchNumber}`, actorId: req.user!.id });
        }
      }
      return updated;
    });
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C4 — Per-order delivery toggle within a trip.
 * Marks a single order DELIVERED or reverts it to DISPATCHED. When finalizing the
 * trip (markTripDelivered:true): if all linked orders are delivered the trip goes
 * DELIVERED, else it goes PARTIAL (audit note records the split).
 * ────────────────────────────────────────────────────────────────────────── */
const dispatchOrderDeliverySchema = z.object({
  delivered: z.boolean(),
  remarks: zText.nullish(),
  markTripDelivered: z.boolean().nullish(),
}).passthrough();

foodOpsRouter.patch("/dispatches/:id/orders/:orderId", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(dispatchOrderDeliverySchema, req, res)) return;
    const id = req.params["id"]!;
    const orderId = req.params["orderId"]!;
    const delivered = !!req.body?.delivered;
    const remarks = (req.body?.remarks as string | null | undefined) ?? null;
    const markTripDelivered = !!req.body?.markTripDelivered;

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    const [trip] = await db.select().from(foodDispatchesTable).where(eq(foodDispatchesTable.id, id));
    if (!trip) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [order] = await db.select().from(foodOrdersTable).where(and(eq(foodOrdersTable.id, orderId), eq(foodOrdersTable.dispatchId, id)));
    if (!order) { res.status(404).json({ success: false, error: "Order not on this dispatch" }); return; }
    if (order.status === "CANCELLED" || order.status === "REJECTED") { res.status(422).json({ success: false, error: `Cannot change a ${order.status} order` }); return; }

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Toggle the single order.
      if (delivered) {
        await tx.update(foodOrdersTable).set({ status: "DELIVERED", deliveredAt: order.deliveredAt ?? now, confirmedById: order.confirmedById ?? req.user!.id, deliveryRemarks: remarks ?? order.deliveryRemarks ?? null, updatedAt: now }).where(eq(foodOrdersTable.id, orderId));
        await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId, status: "DELIVERED", note: remarks ? `Delivered: ${remarks}` : `Delivered (dispatch ${trip.dispatchNumber})`, actorId: req.user!.id });
      } else {
        // Revert: a delivered order goes back to DISPATCHED (still on the trip).
        await tx.update(foodOrdersTable).set({ status: "DISPATCHED", deliveredAt: null, updatedAt: now }).where(eq(foodOrdersTable.id, orderId));
        await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId, status: "DISPATCHED", note: "Delivery reverted", actorId: req.user!.id });
      }

      let tripRow = trip;
      // C4: optionally finalize the trip based on per-order delivery state.
      if (markTripDelivered) {
        const linked = await tx.select({ status: foodOrdersTable.status }).from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id));
        const active = linked.filter((o) => o.status !== "CANCELLED" && o.status !== "REJECTED");
        const allDelivered = active.length > 0 && active.every((o) => o.status === "DELIVERED");
        const tripTarget = allDelivered ? "DELIVERED" : "PARTIAL";
        // Only transition if the state machine allows it from the trip's current status.
        if (tripTarget !== trip.status && (DISPATCH_TRANSITIONS[trip.status] ?? []).includes(tripTarget)) {
          const [moved] = await tx.update(foodDispatchesTable).set({ status: tripTarget as never, updatedAt: now }).where(eq(foodDispatchesTable.id, id)).returning();
          const deliveredCount = active.filter((o) => o.status === "DELIVERED").length;
          await writeDispatchEvent(tx, id, tripTarget, allDelivered ? "All orders delivered" : `Partial delivery (${deliveredCount}/${active.length} delivered)`, req.user!.id);
          if (moved) tripRow = moved;
        }
      }
      return tripRow;
    });
    res.json({ success: true, data: result });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C7 — Cancel a dispatch. Reverts its linked orders DISPATCHED → PREPARING
 * (clearing dispatchId/dispatchedAt), sets the trip CANCELLED, writes audit
 * events, and best-effort notifies the unit leads.
 * ────────────────────────────────────────────────────────────────────────── */
const cancelDispatchSchema = z.object({ reason: zText.nullish() }).passthrough();

foodOpsRouter.post("/dispatches/:id/cancel", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(cancelDispatchSchema, req, res)) return;
    const id = req.params["id"]!;
    const reason = (req.body?.reason as string | null | undefined) ?? null;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    const [trip] = await db.select().from(foodDispatchesTable).where(eq(foodDispatchesTable.id, id));
    if (!trip) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (!(DISPATCH_TRANSITIONS[trip.status] ?? []).includes("CANCELLED")) {
      res.status(422).json({ success: false, error: `Cannot move from ${trip.status} to CANCELLED` });
      return;
    }

    const now = new Date();
    const reverted = await db.transaction(async (tx) => {
      const linked = await tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id));
      const toRevert = linked.filter((o) => o.status === "DISPATCHED");
      for (const o of toRevert) {
        await tx.update(foodOrdersTable).set({
          status: "PREPARING", dispatchId: null, dispatchedAt: null, dispatchStartedAt: null,
          deliveryPartnerId: null, vehicleId: null, updatedAt: now,
        }).where(eq(foodOrdersTable.id, o.id));
        await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "PREPARING", note: reason ? `Dispatch ${trip.dispatchNumber} cancelled: ${reason}` : `Dispatch ${trip.dispatchNumber} cancelled`, actorId: req.user!.id });
      }
      await tx.update(foodDispatchesTable).set({ status: "CANCELLED", updatedAt: now }).where(eq(foodDispatchesTable.id, id));
      await writeDispatchEvent(tx, id, "CANCELLED", reason ? `Cancelled: ${reason}` : "Dispatch cancelled", req.user!.id);
      return toRevert;
    });

    // Best-effort notify (outside the txn; failures must not roll back the cancel).
    // PREPARING has no order-lifecycle template, so notify the unit lead directly.
    for (const o of reverted) {
      try {
        await notify({
          userId: o.unitLeadId,
          title: "Dispatch cancelled",
          body: `Order ${o.orderNumber} is back in preparation${reason ? `: ${reason}` : ""}.`,
          type: "FOOD_ORDER",
          entityType: "FOOD_ORDER",
          entityId: o.id,
        });
      } catch (err) { req.log.error({ err, orderId: o.id }, "dispatch-cancel notify failed"); }
    }

    const [row] = await db.select().from(foodDispatchesTable).where(eq(foodDispatchesTable.id, id));
    res.json({ success: true, data: { ...row, revertedCount: reverted.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* Audit timeline for a dispatch (food_dispatch_events + actor names). */
foodOpsRouter.get("/dispatches/:id/events", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    const events = await db.select({
      e: foodDispatchEventsTable, actorName: usersTable.name,
    }).from(foodDispatchEventsTable)
      .leftJoin(usersTable, eq(foodDispatchEventsTable.actorId, usersTable.id))
      .where(eq(foodDispatchEventsTable.dispatchId, id))
      .orderBy(desc(foodDispatchEventsTable.createdAt));
    res.json({ success: true, data: events.map((r) => ({ ...r.e, actorName: r.actorName })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Multi-meal order batch (Persona st.16)
 * ════════════════════════════════════════════════════════════════════════ */

// meal.mealType is kept a bounded string (not enum): the handler skips invalid
// meal types internally (`continue`), so over-restricting here would change behavior.
const zBatchMealItem = z.object({
  dishId: zId,
  personsCount: z.coerce.number().nullish(),
  // Permissive on purpose: the handler itself skips items whose orderedQty is
  // missing/blank/<=0 (and still returns 201), so the gate must NOT 400 a batch
  // that the old code would have accepted-and-skipped.
  orderedQty: z.coerce.number().nullish(),
  unit: z.string().max(64).nullish(),
}).passthrough();
const zBatchMeal = z.object({
  mealType: z.string().max(32),
  quantity: z.coerce.number().nullish(),
  items: z.array(zBatchMealItem).optional(),
}).passthrough();
const orderBatchSchema = z.object({
  propertyId: zId,
  serviceDate: zDateLike,
  meals: z.array(zBatchMeal).optional(),
  persons: z.coerce.number().nullish(),
  residentsCount: z.coerce.number().nullish(),
  notes: zText.nullish(),
}).passthrough();

foodOpsRouter.post("/order-batches", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    if (!validateBody(orderBatchSchema, req, res)) return;
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

    // Enforce the order cut-off server-side (past date / past cut-off → 422).
    const cutoffError = await checkOrderCutoff(brand, propertyId, sd);
    if (cutoffError) { res.status(422).json({ success: false, error: cutoffError }); return; }

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

const menuShareSchema = z.object({
  propertyId: zId,
  brand: zBrand,
  channel: z.string().min(1).max(64),
  recipients: z.array(z.string().max(256)).optional(),
  recipientType: z.string().max(32).nullish(),
  mealType: z.string().max(32).nullish(),
  date: zDateLike.nullish(),
}).passthrough();

foodOpsRouter.post("/menu/share", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    if (!validateBody(menuShareSchema, req, res)) return;
    const b = req.body || {};
    if (!b.propertyId || !b.brand || !b.channel) { res.status(400).json({ success: false, error: "propertyId, brand, channel required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(b.propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    let recipients: string[] = Array.isArray(b.recipients) ? b.recipients : [];
    // Resolved active-guest rows (kept for dispatch below); empty for CUSTOM shares.
    let guestRows: { id: string; name: string; email: string; phone: string }[] = [];
    if (b.recipientType === "GUESTS") {
      guestRows = await db.select({ id: residentsTable.id, name: residentsTable.name, email: residentsTable.email, phone: residentsTable.phone })
        .from(residentsTable).where(and(eq(residentsTable.propertyId, b.propertyId), eq(residentsTable.status, "ACTIVE")));
      recipients = guestRows.map((r) => r.id);
    }
    const shareToken = newId();
    const [row] = await db.insert(foodMenuSharesTable).values({
      id: newId(), sharedById: req.user!.id, propertyId: b.propertyId, brand: b.brand,
      mealType: b.mealType ?? null, menuDate: b.date ? new Date(b.date) : null, channel: b.channel,
      recipientType: b.recipientType ?? "CUSTOM", recipients, shareToken,
    }).returning();

    // #15 — actually dispatch the public menu link to each resolved active guest.
    // LINK (copy-link) channels keep the prior no-dispatch behavior. Guests aren't
    // app users, so `notify` (which resolves contact from usersTable) is invoked for
    // any matching user row (matched by the guest's email); dispatch is best-effort
    // per recipient — a single failure never fails the share request.
    const channel = String(b.channel || "").toUpperCase();
    if (channel !== "LINK" && guestRows.length) {
      const shareUrl = `${APP_BASE_URL}/m/${shareToken}`;
      const propName = (await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, b.propertyId)))[0]?.name ?? null;
      const mealLabel = b.mealType ? ` ${String(b.mealType).toLowerCase()}` : "";
      const summary = `Here's today's${mealLabel} menu${propName ? ` for ${propName}` : ""}.`;
      const useSms = channel === "SMS" || channel === "WHATSAPP";
      // Map guest emails → app users so `notify` can resolve a deliverable contact.
      const emails = [...new Set(guestRows.map((g) => g.email).filter(Boolean))];
      const userByEmail = new Map<string, string>();
      if (emails.length) {
        const users = await db.select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable).where(inArray(usersTable.email, emails));
        for (const u of users) userByEmail.set(u.email, u.id);
      }
      for (const g of guestRows) {
        const userId = userByEmail.get(g.email);
        if (!userId) continue; // no deliverable user-contact for this guest
        try {
          await notify({
            userId,
            title: "Today's menu is ready",
            body: `${summary} View it here: ${shareUrl}`,
            type: "FOOD_MENU_SHARE",
            link: shareUrl,
            entityType: "FOOD_MENU_SHARE",
            entityId: row!.id,
            ...(useSms
              ? { sms: `${summary} View the menu: ${shareUrl}` }
              : { email: { subject: "Today's menu", text: `${summary}\n\nView the full menu here:\n${shareUrl}` } }),
          });
        } catch (err) {
          req.log.error({ err, residentId: g.id }, "menu-share dispatch failed for recipient");
        }
      }
    }

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

/* ── Fiscal-year helpers (India FY = Apr 1 → Mar 31) ────────────────────────── */

/** Fiscal year a date belongs to (Jan–Mar roll back to the previous FY label). */
function fiscalYear(date: Date): number {
  return date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
}

/** Apr 1 (00:00) of the FY that `date` falls in. */
function fyStart(date: Date): Date {
  return new Date(fiscalYear(date), 3, 1, 0, 0, 0, 0);
}

/** [start, end) for an FY quarter. Q1=Apr–Jun, Q2=Jul–Sep, Q3=Oct–Dec, Q4=Jan–Mar (next cal year). */
function fyQuarterRange(fyYear: number, quarter: 1 | 2 | 3 | 4): { from: Date; to: Date } {
  const startMonth = 3 + (quarter - 1) * 3; // Q1→3(Apr), Q2→6(Jul), Q3→9(Oct), Q4→12(Jan next yr)
  const from = new Date(fyYear, startMonth, 1, 0, 0, 0, 0);
  const to = new Date(fyYear, startMonth + 3, 1, 0, 0, 0, 0); // exclusive end
  return { from, to };
}

/** FY-quarter index (1–4) the date falls in. */
function fyQuarterOf(date: Date): 1 | 2 | 3 | 4 {
  const m = date.getMonth();
  if (m >= 3 && m <= 5) return 1;
  if (m >= 6 && m <= 8) return 2;
  if (m >= 9 && m <= 11) return 3;
  return 4; // Jan–Mar
}

/**
 * Resolve the home-dashboard window from a period keyword.
 *  - week  : current week's prior 7-day window (also exposes prior 7-day bucket)
 *  - month : current calendar month
 *  - fq    : current FY quarter
 *  - fy    : current fiscal year (Apr–Mar)
 * Explicit ?from/?to always win. Returns the current window plus the immediately
 * prior comparable window so charts can render "current vs prior".
 */
function homePeriodRange(
  period: string | undefined,
  q: Record<string, unknown>,
): { from: Date; to: Date; prevFrom: Date; prevTo: Date; bucket: "day" | "week" | "month" } {
  const explicitFrom = parseDate(q["from"]);
  const explicitTo = parseDate(q["to"]);
  const now = explicitTo ?? new Date();
  // Window ends are used with `lte`; calendar-bounded ends are exclusive, so step
  // back 1ms to keep adjacent periods from overlapping on the boundary midnight.
  const lastMs = (exclusiveEnd: Date) => new Date(exclusiveEnd.getTime() - 1);

  if (period === "fy") {
    const from = explicitFrom ?? fyStart(now);
    const to = explicitTo ?? lastMs(new Date(from.getFullYear() + 1, 3, 1, 0, 0, 0, 0));
    const prevFrom = new Date(from.getFullYear() - 1, 3, 1, 0, 0, 0, 0);
    return { from, to, prevFrom, prevTo: lastMs(from), bucket: "month" };
  }
  if (period === "fq") {
    const fy = fiscalYear(now);
    const qtr = fyQuarterOf(now);
    const cur = fyQuarterRange(fy, qtr);
    const from = explicitFrom ?? cur.from;
    const to = explicitTo ?? lastMs(cur.to);
    const prevQtr = (qtr === 1 ? 4 : (qtr - 1)) as 1 | 2 | 3 | 4;
    const prevFy = qtr === 1 ? fy - 1 : fy;
    const prev = fyQuarterRange(prevFy, prevQtr);
    return { from, to, prevFrom: prev.from, prevTo: lastMs(prev.to), bucket: "week" };
  }
  if (period === "month") {
    const from = explicitFrom ?? new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = explicitTo ?? lastMs(new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0));
    const prevFrom = new Date(from.getFullYear(), from.getMonth() - 1, 1, 0, 0, 0, 0);
    return { from, to, prevFrom, prevTo: lastMs(from), bucket: "day" };
  }
  // default: week
  const to = explicitTo ?? new Date();
  const from = explicitFrom ?? new Date(to.getTime() - 7 * 86400000);
  const span = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from, bucket: "day" };
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
 * Cross-property food-waste analytics (B3-17)
 *
 * Org-wide waste insight across the geographic hierarchy (Zone → City → Cluster
 * → Property). Property-scoped roles (CITY_HEAD / CLUSTER) are automatically
 * narrowed to their geography via resolveAccessiblePropertyIds; org-wide roles
 * (OPS_EXCELLENCE / SUPER_ADMIN) see everything. All metrics sum numeric
 * food_order_items quantities (wastedQty / receivedQty / orderedQty), joined to
 * food_orders for the property/meal/brand/date dimensions and to clusters/cities
 * for the geography labels (properties.city is the denormalised city name; the
 * real city/cluster come through properties.clusterId → clusters → cities).
 *
 * Dimensions:
 *   summary     — totals + wastePct (wasted/received) + ordersWithWaste count
 *   byProperty  — top properties by wasted qty (with property wastePct)
 *   byDish      — top dishes by wasted qty
 *   byMealType  — wasted qty per meal
 *   byMenu      — wasted qty per brand (brand is the menu dimension; orders carry
 *                 no menu_id, so brand stands in for "menu")
 *   trend       — wasted qty per period (day|month) across the range
 *
 * Filters: from/to (IST calendar days, default last 90 days), propertyId,
 * clusterId, cityId (resolved via clusters), brand. granularity defaults to
 * month when the range spans > 60 days, else day.
 * ════════════════════════════════════════════════════════════════════════ */

/** Number → numeric(…,3) rounding shared by the waste-analytics responses. */
const wr3 = (n: unknown) => Math.round(Number(n ?? 0) * 1000) / 1000;
/** wastePct = wasted/received, guarded against /0; one-decimal percentage. */
const wastePctOf = (wasted: unknown, received: unknown) =>
  Number(received) > 0 ? Math.round((Number(wasted) / Number(received)) * 1000) / 10 : 0;

/**
 * Resolve the shared scope + filter conditions for the waste-analytics endpoints.
 * Returns the order-level WHERE (scope ∩ date-range ∩ filters), the resolved
 * IST from/to YMD strings, the granularity, and the cityId→clusterId expansion
 * used to apply the cityId filter without a properties.cityId column.
 */
async function wasteAnalyticsScope(req: any): Promise<{
  where: ReturnType<typeof and>;
  fromYmd: string; toYmd: string;
  granularity: "day" | "month";
}> {
  const ids = await resolveAccessiblePropertyIds(req.user!);

  // Date range — default last 90 days, anchored on IST calendar days.
  const todayYmd = istDayYmd(new Date());
  const toRaw = parseDate(req.query["to"]);
  const fromRaw = parseDate(req.query["from"]);
  const toYmd = toRaw ? istDayYmd(toRaw) : todayYmd;
  const fromYmd = fromRaw ? istDayYmd(fromRaw) : addDaysYmd(toYmd, -89);
  // Inclusive day bounds → [00:00 IST of from, 00:00 IST of (to + 1 day)).
  const fromAt = atIst(fromYmd, "00:00");
  const toAtExclusive = atIst(addDaysYmd(toYmd, 1), "00:00");

  const propertyId = req.query["propertyId"] as string | undefined;
  const clusterId = req.query["clusterId"] as string | undefined;
  const cityId = req.query["cityId"] as string | undefined;
  const brand = req.query["brand"] as string | undefined;

  const conds = [
    gte(foodOrdersTable.serviceDate, fromAt),
    lte(foodOrdersTable.serviceDate, toAtExclusive),
  ] as any[];
  // Geography scope from the caller's role (null = org-wide; [] = nothing).
  if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));

  // cityId / clusterId filters resolve to a set of property ids via the
  // clusters→cities hierarchy (properties has clusterId but no cityId column).
  if (clusterId || cityId) {
    const geoConds = [] as any[];
    if (clusterId) geoConds.push(eq(propertiesTable.clusterId, clusterId));
    if (cityId) geoConds.push(eq(clustersTable.cityId, cityId));
    const geoProps = await db.select({ id: propertiesTable.id })
      .from(propertiesTable)
      .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
      .where(and(...geoConds));
    const geoIds = geoProps.map((p) => p.id);
    conds.push(geoIds.length ? inArray(foodOrdersTable.propertyId, geoIds) : sql`false`);
  }

  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));

  // Granularity: explicit query wins; else month for ranges > 60 days, else day.
  const gParam = String(req.query["granularity"] ?? "").toLowerCase();
  const spanDays = Math.round((atIst(toYmd, "00:00").getTime() - fromAt.getTime()) / 86400000);
  const granularity: "day" | "month" =
    gParam === "day" || gParam === "month" ? gParam : spanDays > 60 ? "month" : "day";

  return { where: and(...conds), fromYmd, toYmd, granularity };
}

foodOpsRouter.get("/waste-analytics", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const { where, fromYmd, toYmd, granularity } = await wasteAnalyticsScope(req);

    // ── Summary — totals across the filtered set ─────────────────────────────
    const [summaryRow] = await db.select({
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where);

    // Orders that recorded any waste (distinct order ids with wasted > 0).
    const [withWasteRow] = await db.select({
      n: sql<number>`count(distinct ${foodOrdersTable.id})::int`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(where, sql`${foodOrderItemsTable.wastedQty} > 0`));

    const totalWasted = wr3(summaryRow?.wasted);
    const totalReceived = wr3(summaryRow?.received);
    const totalOrdered = wr3(summaryRow?.ordered);

    // ── byProperty — top properties by wasted qty (with city/cluster labels) ──
    const byPropertyRows = await db.select({
      propertyId: foodOrdersTable.propertyId,
      name: propertiesTable.name,
      city: citiesTable.name,
      cluster: clustersTable.name,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
      .leftJoin(citiesTable, eq(clustersTable.cityId, citiesTable.id))
      .where(where)
      .groupBy(foodOrdersTable.propertyId, propertiesTable.name, citiesTable.name, clustersTable.name)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(50);

    // ── byDish — top dishes by wasted qty ────────────────────────────────────
    const byDishRows = await db.select({
      dishId: foodOrderItemsTable.dishId,
      name: dishesTable.name,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(where)
      .groupBy(foodOrderItemsTable.dishId, dishesTable.name)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(50);

    // ── byMealType — wasted qty per meal ─────────────────────────────────────
    const byMealRows = await db.select({
      mealType: foodOrdersTable.mealType,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType);

    // ── byMenu — wasted qty per brand (brand stands in for menu) ──────────────
    const byMenuRows = await db.select({
      brand: foodOrdersTable.brand,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.brand)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));

    // ── trend — wasted qty per period (IST day or month) over the range ───────
    // serviceDate is a UTC timestamp; shift +5:30 before truncating so the bucket
    // boundaries land on IST calendar days/months (consistent with the rest of food-ops).
    const periodExpr = granularity === "month"
      ? sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM')`
      : sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const trendRows = await db.select({
      period: periodExpr,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(periodExpr).orderBy(periodExpr);

    res.json({
      success: true,
      data: {
        range: { from: fromYmd, to: toYmd },
        granularity,
        summary: {
          totalWasted,
          totalReceived,
          totalOrdered,
          wastePct: wastePctOf(totalWasted, totalReceived),
          ordersWithWaste: Number(withWasteRow?.n ?? 0),
        },
        byProperty: byPropertyRows.map((r) => ({
          propertyId: r.propertyId,
          name: r.name ?? "—",
          city: r.city ?? null,
          cluster: r.cluster ?? null,
          wastedQty: wr3(r.wasted),
          wastePct: wastePctOf(r.wasted, r.received),
        })),
        byDish: byDishRows.map((r) => ({
          dishId: r.dishId,
          name: r.name ?? "—",
          wastedQty: wr3(r.wasted),
        })),
        byMealType: MEAL_TYPES.map((mt) => ({
          mealType: mt,
          wastedQty: wr3(byMealRows.find((r) => r.mealType === mt)?.wasted),
        })),
        byMenu: byMenuRows.map((r) => ({
          brand: r.brand ?? "—",
          wastedQty: wr3(r.wasted),
        })),
        trend: trendRows.map((r) => ({
          period: r.period,
          wastedQty: wr3(r.wasted),
        })),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ── Waste-analytics widget export (CSV / XLSX / PDF) ─────────────────────────
 * Renders one chosen widget's rows through the shared export-service encoders
 * (formula-injection-safe CSV, paginated PDF, XLS). `widget` selects the dataset
 * (property|dish|mealtype|menu|trend); all the same filters/scope as the JSON
 * endpoint apply, so the file mirrors exactly what the on-screen widget shows.
 * Accepts `xlsx` as an alias for this codebase's `xls` encoder. */
const WASTE_EXPORT_WIDGETS = new Set(["property", "dish", "mealtype", "menu", "trend"]);

/** Build the {title, headers, rows} export table for a waste-analytics widget. */
async function buildWasteWidgetTable(widget: string, req: any): Promise<{
  title: string; headers: string[]; rows: (string | number | null)[][]; fileBase: string; dateRange: string;
}> {
  const { where, fromYmd, toYmd, granularity } = await wasteAnalyticsScope(req);
  const dateRange = `${fromYmd} → ${toYmd}`;

  if (widget === "property") {
    const rows = await db.select({
      name: propertiesTable.name, city: citiesTable.name, cluster: clustersTable.name,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
      .leftJoin(citiesTable, eq(clustersTable.cityId, citiesTable.id))
      .where(where)
      .groupBy(foodOrdersTable.propertyId, propertiesTable.name, citiesTable.name, clustersTable.name)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    return {
      title: "Food Waste by Property", headers: ["Property", "City", "Cluster", "Wasted", "Waste %"],
      rows: rows.map((r) => [r.name ?? "—", r.city ?? "", r.cluster ?? "", wr3(r.wasted), `${wastePctOf(r.wasted, r.received)}%`]),
      fileBase: "food-waste-by-property",
      dateRange,
    };
  }

  if (widget === "dish") {
    const rows = await db.select({
      name: dishesTable.name,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(where).groupBy(dishesTable.name)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    return {
      title: "Food Waste by Dish", headers: ["Dish", "Wasted"],
      rows: rows.map((r) => [r.name ?? "—", wr3(r.wasted)]),
      fileBase: "food-waste-by-dish",
      dateRange,
    };
  }

  if (widget === "mealtype") {
    const grouped = await db.select({
      mealType: foodOrdersTable.mealType,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType);
    return {
      title: "Food Waste by Meal", headers: ["Meal", "Wasted"],
      rows: MEAL_TYPES.map((mt) => [mt, wr3(grouped.find((r) => r.mealType === mt)?.wasted)]),
      fileBase: "food-waste-by-meal",
      dateRange,
    };
  }

  if (widget === "menu") {
    const rows = await db.select({
      brand: foodOrdersTable.brand,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.brand)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    return {
      title: "Food Waste by Menu", headers: ["Menu (Brand)", "Wasted"],
      rows: rows.map((r) => [r.brand ?? "—", wr3(r.wasted)]),
      fileBase: "food-waste-by-menu",
      dateRange,
    };
  }

  // trend
  const periodExpr = granularity === "month"
    ? sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM')`
    : sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
  const rows = await db.select({
    period: periodExpr,
    wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
  }).from(foodOrdersTable)
    .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
    .where(where).groupBy(periodExpr).orderBy(periodExpr);
  return {
    title: `Food Waste Trend (${granularity === "month" ? "Monthly" : "Daily"})`,
    headers: ["Period", "Wasted"],
    rows: rows.map((r) => [r.period, wr3(r.wasted)]),
    fileBase: "food-waste-trend",
    dateRange,
  };
}

foodOpsRouter.get("/waste-analytics/export.:fmt", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    // Normalise fmt: accept csv | xlsx | pdf (xlsx aliases this codebase's xls encoder).
    const fmtRaw = String(req.params["fmt"] ?? "").toLowerCase();
    const fmt = fmtRaw === "xlsx" ? "xls" : fmtRaw;
    if (!["csv", "xls", "pdf"].includes(fmt)) {
      res.status(400).json({ success: false, error: "fmt must be csv, xlsx or pdf" }); return;
    }
    const widget = String(req.query["widget"] ?? "property").toLowerCase();
    if (!WASTE_EXPORT_WIDGETS.has(widget)) {
      res.status(400).json({ success: false, error: "widget must be one of property, dish, mealtype, menu, trend" }); return;
    }
    const t = await buildWasteWidgetTable(widget, req);
    const table = { title: t.title, headers: t.headers, rows: t.rows, dateRange: t.dateRange };
    const filename = `${t.fileBase}-${fileDateStamp()}.${fmt}`;

    if (fmt === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toCsv(table));
    } else if (fmt === "pdf") {
      const pdf = await toPdf(table);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(Buffer.from(pdf));
    } else {
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toXls(table));
    }
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Unit-Lead Home dashboard analytics (WS7)
 *
 * Aggregates across ALL the unit lead's accessible properties by default, with
 * an optional single-property ?propertyId filter. Period keys: week | month |
 * fq (FY quarter) | fy (FY year, Apr–Mar). Returns the chart datasets the home
 * page needs beyond /analytics — "people ordered for" (sum of residentsCount
 * bucketed by date AND grouped by property), active-resident trend, occupancy /
 * collections roll-up — and stubs renewals/newSignups (no data model yet).
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/home-analytics", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const period = (req.query["period"] as string | undefined) ?? "week";
    const { from, to, prevFrom, prevTo } = homePeriodRange(period, req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    if (propertyId && !isAccessible(propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" }); return;
    }

    // Order scope for the current window.
    const orderScope = [gte(foodOrdersTable.serviceDate, from), lte(foodOrdersTable.serviceDate, to)] as any[];
    if (ids !== null) orderScope.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) orderScope.push(eq(foodOrdersTable.propertyId, propertyId));
    const where = and(...orderScope);
    const day = sql<string>`to_char(${foodOrdersTable.serviceDate}, 'YYYY-MM-DD')`;

    // ── People ordered for — bucketed by day (sum of residentsCount) ──────────
    const peopleRows = await db.select({ date: day, people: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount}), 0)::int` })
      .from(foodOrdersTable).where(where).groupBy(day).orderBy(day);
    const peopleOrderedTrend = peopleRows.map((r) => ({ date: r.date, people: Number(r.people) }));

    // ── People ordered for — grouped across properties ────────────────────────
    const peopleByPropRows = await db.select({
      propertyId: foodOrdersTable.propertyId, propertyName: propertiesTable.name,
      people: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount}), 0)::int`,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .where(where).groupBy(foodOrdersTable.propertyId, propertiesTable.name)
      .orderBy(desc(sql`sum(${foodOrdersTable.residentsCount})`));
    const peopleByProperty = peopleByPropRows.map((r) => ({
      propertyId: r.propertyId, propertyName: r.propertyName ?? "—", people: Number(r.people),
    }));

    // ── People ordered for — current vs prior comparable window ───────────────
    const [curPeople] = await db.select({ total: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount}), 0)::int` })
      .from(foodOrdersTable).where(where);
    const prevScope = [gte(foodOrdersTable.serviceDate, prevFrom), lte(foodOrdersTable.serviceDate, prevTo)] as any[];
    if (ids !== null) prevScope.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) prevScope.push(eq(foodOrdersTable.propertyId, propertyId));
    const [prevPeople] = await db.select({ total: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount}), 0)::int` })
      .from(foodOrdersTable).where(and(...prevScope));
    const peopleComparison = {
      current: Number(curPeople?.total ?? 0),
      prior: Number(prevPeople?.total ?? 0),
      currentLabel: `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
      priorLabel: `${prevFrom.toISOString().slice(0, 10)} → ${prevTo.toISOString().slice(0, 10)}`,
    };

    // ── Wastage trend (sum wasted qty per day) ────────────────────────────────
    const wastageRows = await db.select({ date: day, wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float` })
      .from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(day).orderBy(day);
    const wastageTrend = wastageRows.map((r) => ({ date: r.date, wasted: Math.round(Number(r.wasted) * 1000) / 1000 }));

    // ── Top 20% items by wastage ──────────────────────────────────────────────
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

    // ── Food-order delays per day ─────────────────────────────────────────────
    const delivered = await db.select({
      date: sql<string>`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`,
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*)::int`,
    }).from(foodOrdersTable).where(and(where, isNotNull(foodOrdersTable.deliveredAt)))
      .groupBy(sql`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`).orderBy(sql`to_char(${foodOrdersTable.deliveredAt}, 'YYYY-MM-DD')`);
    const orderDelays = delivered.map((r) => ({ date: r.date, delayed: r.delayed, total: r.total }));

    // ── Active-resident trend (cumulative active check-ins per day) ───────────
    const resScope = [eq(residentsTable.status, "ACTIVE"), isNotNull(residentsTable.checkInDate),
      lte(residentsTable.checkInDate, to)] as any[];
    if (ids !== null) resScope.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
    if (propertyId) resScope.push(eq(residentsTable.propertyId, propertyId));
    const resDay = sql<string>`to_char(${residentsTable.checkInDate}, 'YYYY-MM-DD')`;
    const checkInRows = await db.select({ date: resDay, c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(...resScope)).groupBy(resDay).orderBy(resDay);
    // Build cumulative series clipped to [from, to]; the count at `from` is the
    // running total of everyone checked-in on/before `from`.
    let running = 0;
    const fromKey = from.toISOString().slice(0, 10);
    const activeResidentTrend: { date: string; residents: number }[] = [];
    for (const r of checkInRows) {
      running += Number(r.c);
      if (r.date >= fromKey) activeResidentTrend.push({ date: r.date, residents: running });
    }

    // ── Occupancy + collections roll-up (current month, aggregate) ────────────
    const propScope = ids === null ? undefined : (ids.length ? inArray(propertiesTable.id, ids) : sql`false`);
    const propWhere = propertyId
      ? (propScope ? and(propScope, eq(propertiesTable.id, propertyId)) : eq(propertiesTable.id, propertyId))
      : propScope;
    const [beds] = await db.select({ total: sql<number>`coalesce(sum(${propertiesTable.totalBeds}), 0)::int` })
      .from(propertiesTable).where(propWhere);
    const residentWhere = [eq(residentsTable.status, "ACTIVE")] as any[];
    if (ids !== null) residentWhere.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
    if (propertyId) residentWhere.push(eq(residentsTable.propertyId, propertyId));
    const [activeRes] = await db.select({ c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(...residentWhere));
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const collScope = [eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)] as any[];
    if (ids !== null) collScope.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
    if (propertyId) collScope.push(eq(residentsTable.propertyId, propertyId));
    const [coll] = await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(...collScope));
    // ── New signups (real) & renewals (proxy) ──────────────────────────────────
    // New signups = residents who checked in during the period. Renewals (proxy)
    // = active residents whose lease term completes in the period (move-in +
    // property leaseTermMonths, default 12) — i.e. up for renewal now.
    const signupWhere = (lo: Date, hi: Date) => {
      const c: any[] = [isNotNull(residentsTable.checkInDate), gte(residentsTable.checkInDate, lo), lte(residentsTable.checkInDate, hi)];
      if (ids !== null) c.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
      if (propertyId) c.push(eq(residentsTable.propertyId, propertyId));
      return and(...c);
    };
    const [signupCur] = await db.select({ c: sql<number>`count(*)::int` }).from(residentsTable).where(signupWhere(from, to));
    const [signupPrev] = await db.select({ c: sql<number>`count(*)::int` }).from(residentsTable).where(signupWhere(prevFrom, prevTo));
    const renewAt = sql`(${residentsTable.checkInDate} + (coalesce((${propertiesTable.portfolioAttributes}->>'leaseTermMonths')::int, 12) || ' months')::interval)`;
    const renewWhere = (lo: Date, hi: Date) => {
      const c: any[] = [eq(residentsTable.status, "ACTIVE"), isNotNull(residentsTable.checkInDate), sql`${renewAt} >= ${lo}`, sql`${renewAt} <= ${hi}`];
      if (ids !== null) c.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
      if (propertyId) c.push(eq(residentsTable.propertyId, propertyId));
      return and(...c);
    };
    const [renewCur] = await db.select({ c: sql<number>`count(*)::int` }).from(residentsTable).innerJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id)).where(renewWhere(from, to));
    const [renewPrev] = await db.select({ c: sql<number>`count(*)::int` }).from(residentsTable).innerJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id)).where(renewWhere(prevFrom, prevTo));

    const totalBeds = Number(beds?.total ?? 0);
    const activeGuests = Number(activeRes?.c ?? 0);

    // ── Summaries ─────────────────────────────────────────────────────────────
    const [wasteSummary] = await db.select({
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id)).where(where);
    const [delaySummary] = await db.select({
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*) filter (where ${foodOrdersTable.deliveredAt} is not null)::int`,
    }).from(foodOrdersTable).where(where);

    res.json({
      success: true,
      data: {
        period,
        range: { from, to },
        prevRange: { from: prevFrom, to: prevTo },
        peopleOrderedTrend,
        peopleByProperty,
        peopleComparison,
        wastageTrend,
        topWasteItems,
        orderDelays,
        activeResidentTrend,
        occupancy: {
          totalBeds, activeGuests,
          occupancyPct: totalBeds ? Math.round((activeGuests / totalBeds) * 100) : 0,
          monthlyCollections: Math.round(Number(coll?.total ?? 0)),
        },
        newSignups: { current: signupCur?.c ?? 0, prior: signupPrev?.c ?? 0 },
        // Proxy: residents whose lease term completes this period (move-in + leaseTermMonths).
        renewals: { current: renewCur?.c ?? 0, prior: renewPrev?.c ?? 0 },
        summary: {
          totalPeopleOrdered: Number(curPeople?.total ?? 0),
          totalWasted: Math.round(Number(wasteSummary?.wasted ?? 0) * 1000) / 1000,
          totalOrdered: Math.round(Number(wasteSummary?.ordered ?? 0) * 1000) / 1000,
          wastePct: Number(wasteSummary?.ordered) > 0 ? Math.round((Number(wasteSummary?.wasted) / Number(wasteSummary?.ordered)) * 1000) / 10 : 0,
          delayedOrders: delaySummary?.delayed ?? 0,
          deliveredOrders: delaySummary?.total ?? 0,
          activeResidents: activeGuests,
        },
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Ordered-vs-delivered variance report (#26)
 *
 * Aggregates delivered/confirmed orders in range, grouped by mealType, summing
 * ordered / received / wasted qty (variance = ordered − received). Mirrors the
 * /analytics scoping (resolveAccessiblePropertyIds + optional ?propertyId) and
 * the periodRange date conventions used by the other food reports. "Delivered/
 * confirmed" = orders that reached DELIVERED (per-item receivedQty is the proof-
 * of-receipt captured at Confirm Delivery, same convention as food-order-detail).
 * ════════════════════════════════════════════════════════════════════════ */
foodOpsRouter.get("/reports/variance", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const { from, to } = periodRange(req.query["period"] as string | undefined, req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    if (propertyId && !isAccessible(propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" }); return;
    }

    const conds = [
      gte(foodOrdersTable.serviceDate, from),
      lte(foodOrdersTable.serviceDate, to),
      eq(foodOrdersTable.status, "DELIVERED" as never),
    ] as any[];
    if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    const where = and(...conds);

    const grouped = await db.select({
      mealType: foodOrdersTable.mealType,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType);

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const byMeal = new Map(grouped.map((g) => [g.mealType, g]));
    const rows = MEAL_TYPES.map((mt) => {
      const g = byMeal.get(mt);
      const ordered = r3(Number(g?.ordered ?? 0));
      const received = r3(Number(g?.received ?? 0));
      const wasted = r3(Number(g?.wasted ?? 0));
      return { mealType: mt, ordered, received, wasted, variance: r3(ordered - received) };
    });
    const totals = rows.reduce((t, r) => ({
      ordered: r3(t.ordered + r.ordered), received: r3(t.received + r.received),
      wasted: r3(t.wasted + r.wasted), variance: r3(t.variance + r.variance),
    }), { ordered: 0, received: 0, wasted: 0, variance: 0 });

    res.json({ success: true, data: { rows, totals } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * On-time delivery report (O15/O16) + tolerance config (system_config)
 *
 * A delivery is ON-TIME when deliveredAt <= (serviceDate @ the meal's SCHEDULED
 * SERVICE TIME) + TOLERANCE minutes. This deliberately uses the configured
 * meal-window serviceTime (NOT expectedDeliveryAt, which adds lead time) so the
 * SLA is measured against the promised service moment. TOLERANCE is a global
 * system_config value `FOOD_ONTIME_TOLERANCE_MINUTES` (default 45).
 *
 * The service-time instant is built in IST (atTime → atIst) so it is the correct
 * absolute instant regardless of server/process timezone, matching the cut-off
 * logic above.
 * ════════════════════════════════════════════════════════════════════════ */

/** Global on-time tolerance config key + default (minutes). */
const FOOD_ONTIME_TOLERANCE_KEY = "FOOD_ONTIME_TOLERANCE_MINUTES";
const FOOD_ONTIME_TOLERANCE_DEFAULT = 45;

/** Current on-time tolerance in minutes (clamped to 0..240; default 45). */
async function getOntimeToleranceMinutes(): Promise<number> {
  const raw = await getSystemConfigValue<number>(FOOD_ONTIME_TOLERANCE_KEY, FOOD_ONTIME_TOLERANCE_DEFAULT);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 240 ? n : FOOD_ONTIME_TOLERANCE_DEFAULT;
}

/**
 * Resolves, per (brand, mealType, propertyId), the scheduled serviceTime "HH:MM"
 * from the active meal windows. Pre-fetches ALL active windows once and resolves
 * in JS (property-specific overrides the global default) so an on-time report
 * over many orders runs without an N+1 DB hit per order.
 */
async function loadServiceTimeResolver(): Promise<(brand: string, mealType: string, propertyId: string) => string | null> {
  const rows = await db.select().from(foodMealWindowsTable).where(eq(foodMealWindowsTable.isActive, true));
  return (brand, mealType, propertyId) => {
    let global: string | null | undefined;
    for (const w of rows) {
      if (w.brand !== brand || w.mealType !== mealType) continue;
      if (w.propertyId === propertyId) return w.serviceTime ?? null;
      if (w.propertyId === null && global === undefined) global = w.serviceTime;
    }
    return global ?? null;
  };
}

/**
 * GET /food/reports/on-time — on-time vs late delivered orders over a window.
 * Scoped via resolveAccessiblePropertyIds + optional propertyId/brand filters.
 * Only DELIVERED orders with a deliveredAt are counted; orders whose meal has no
 * configured serviceTime can't be measured and are skipped (excluded from totals).
 */
foodOpsRouter.get("/reports/on-time", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const { from, to } = periodRange(req.query["period"] as string | undefined, req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    if (propertyId && !isAccessible(propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" }); return;
    }

    const conds = [
      gte(foodOrdersTable.serviceDate, from),
      lte(foodOrdersTable.serviceDate, to),
      eq(foodOrdersTable.status, "DELIVERED" as never),
      isNotNull(foodOrdersTable.deliveredAt),
    ] as any[];
    if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));

    const orders = await db.select({
      brand: foodOrdersTable.brand, mealType: foodOrdersTable.mealType, propertyId: foodOrdersTable.propertyId,
      serviceDate: foodOrdersTable.serviceDate, deliveredAt: foodOrdersTable.deliveredAt,
    }).from(foodOrdersTable).where(and(...conds));

    const toleranceMinutes = await getOntimeToleranceMinutes();
    const resolveServiceTime = await loadServiceTimeResolver();
    const tolMs = toleranceMinutes * 60000;

    const byDay = new Map<string, { onTime: number; late: number }>();
    let onTimeCount = 0, lateCount = 0;
    for (const o of orders) {
      const serviceTime = resolveServiceTime(o.brand, o.mealType, o.propertyId);
      const base = atTime(o.serviceDate, serviceTime); // IST-anchored service instant
      if (!base || !o.deliveredAt) continue; // unmeasurable — excluded from totals
      const onTime = o.deliveredAt.getTime() <= base.getTime() + tolMs;
      const day = istDayYmd(o.serviceDate);
      const bucket = byDay.get(day) ?? { onTime: 0, late: 0 };
      if (onTime) { bucket.onTime++; onTimeCount++; } else { bucket.late++; lateCount++; }
      byDay.set(day, bucket);
    }
    const totalDelivered = onTimeCount + lateCount;
    const byDayRows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, onTime: v.onTime, late: v.late }));

    res.json({
      success: true,
      data: {
        onTimePct: totalDelivered ? Math.round((onTimeCount / totalDelivered) * 1000) / 10 : 0,
        lateCount, onTimeCount, totalDelivered,
        toleranceMinutes,
        byDay: byDayRows,
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * GET /food/settings/ontime-tolerance — read the global on-time tolerance (min).
 * Any authenticated food user may read (needed to label the on-time report).
 */
foodOpsRouter.get("/settings/ontime-tolerance", authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: { minutes: await getOntimeToleranceMinutes() } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * PUT /food/settings/ontime-tolerance — set the tolerance. SUPER_ADMIN only
 * (org-wide SLA setting), mirroring the OTP-config gate. Validates 0..240.
 */
const ontimeToleranceSchema = z.object({ minutes: z.union([z.string(), z.number()]) }).passthrough();

foodOpsRouter.put("/settings/ontime-tolerance", authenticate, async (req, res) => {
  try {
    if (req.user?.role !== "SUPER_ADMIN") {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" }); return;
    }
    if (!validateBody(ontimeToleranceSchema, req, res)) return;
    const n = Number((req.body || {}).minutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) {
      res.status(400).json({ success: false, error: "minutes must be an integer between 0 and 240" }); return;
    }
    await db.insert(systemConfigTable)
      .values({ id: newId(), key: FOOD_ONTIME_TOLERANCE_KEY, value: n as never, description: "On-time delivery tolerance (minutes) past the meal's scheduled service time.", updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: n as never, updatedAt: new Date() } });
    res.json({ success: true, data: { minutes: await getOntimeToleranceMinutes() } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Variance grouped by service-day (O17)
 *
 * Per IST service-day ordered/received/wasted/variance over DELIVERED orders,
 * with an optional single-meal filter. Mirrors /reports/variance scoping; the
 * date bucket is the IST calendar day of serviceDate.
 * ════════════════════════════════════════════════════════════════════════ */
foodOpsRouter.get("/reports/variance-by-day", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const { from, to } = periodRange(req.query["period"] as string | undefined, req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    if (propertyId && !isAccessible(propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" }); return;
    }
    if (mealType && !MEAL_TYPES.includes(mealType as never)) {
      res.status(400).json({ success: false, error: "Invalid mealType" }); return;
    }

    const conds = [
      gte(foodOrdersTable.serviceDate, from),
      lte(foodOrdersTable.serviceDate, to),
      eq(foodOrdersTable.status, "DELIVERED" as never),
    ] as any[];
    if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (mealType) conds.push(eq(foodOrdersTable.mealType, mealType as never));

    // Group by IST calendar day of serviceDate (to_char in IST: shift +5:30).
    const day = sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const grouped = await db.select({
      date: day,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(...conds)).groupBy(day).orderBy(day);

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const rows = grouped.map((g) => {
      const ordered = r3(Number(g.ordered));
      const received = r3(Number(g.received));
      const wasted = r3(Number(g.wasted));
      return { date: g.date, ordered, received, variance: r3(ordered - received), wasted };
    });
    res.json({ success: true, data: { rows } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Exports — orders & guests (Persona st.34, st.47)
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Resolves the filtered order rows for export plus the metadata (property name,
 * data date-range) used in the file header + filename. propertyName is set only
 * when a single property is in scope (explicit ?propertyId= filter); multi-
 * property exports leave it null so the filename/header stays generic.
 */
async function fetchOrdersForExport(req: any): Promise<{
  rows: (string | number | null | undefined)[][];
  propertyName: string | null;
  dateRange: string | null;
}> {
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

  // Property name for header/filename: prefer the explicit filter; otherwise, if
  // every row resolves to the same property, use that; else leave generic.
  let propertyName: string | null = null;
  if (propertyId) {
    propertyName = rows.find((r) => r.propertyName)?.propertyName ?? null;
  } else {
    const names = new Set(rows.map((r) => r.propertyName ?? "").filter(Boolean));
    if (names.size === 1) propertyName = [...names][0];
  }
  const dateRange = from || to ? `${from ? fmtDate(from) : "…"} → ${to ? fmtDate(to) : "…"}` : null;

  const mapped = rows.map((r) => [
    r.o.orderNumber, r.propertyName ?? "", r.unitLeadName ?? "", r.o.brand, r.o.mealType,
    r.o.residentsCount, r.o.totalQuantity != null ? Number(r.o.totalQuantity) : "", r.o.status,
    fmtDate(r.o.serviceDate), fmtDateTime(r.o.deliveredAt),
  ]);
  return { rows: mapped, propertyName, dateRange };
}
const ORDER_HEADERS = ["Order ID", "Property", "Unit Lead", "Brand", "Meal", "Residents", "Quantity", "Status", "Service Date", "Delivered At"];

/** Build "food-orders-{property?}-{date}.{ext}" filename. */
function ordersFilename(propertyName: string | null, ext: string): string {
  const prop = propertyName ? `-${sanitizeForFilename(propertyName)}` : "";
  return `food-orders${prop}-${fileDateStamp()}.${ext}`;
}

// NOTE: these literal `.csv/.pdf/.xls` routes are registered BEFORE the unified
// `/reports/export.:fmt` route below, so Express matches them first. To keep the
// O20 `?report=` contract working on these paths too, each delegates to the same
// buildReportTable() pipeline. With no `?report=` (or report=orders) the output
// is byte-identical to the original orders export, so existing callers are unaffected.
async function serveReportExport(req: any, res: any, fmt: "csv" | "pdf" | "xls"): Promise<void> {
  const report = String(req.query["report"] ?? "orders").toLowerCase();
  if (!EXPORT_REPORTS.has(report)) {
    res.status(400).json({ success: false, error: "report must be one of orders, variance, waste, ontime" }); return;
  }
  const t = await buildReportTable(report, req);
  const table = { title: t.title, headers: t.headers, rows: t.rows, propertyName: t.propertyName, dateRange: t.dateRange };
  const filename = report === "orders"
    ? ordersFilename(t.propertyName, fmt)          // preserve the original orders filename
    : reportFilename(t.fileBase, t.propertyName, fmt);
  if (fmt === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.send(toCsv(table));
  } else if (fmt === "pdf") {
    const pdf = await toPdf(table);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.send(Buffer.from(pdf));
  } else {
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.send(toXls(table));
  }
}

foodOpsRouter.get("/reports/export.csv", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try { await serveReportExport(req, res, "csv"); }
  catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/reports/export.pdf", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try { await serveReportExport(req, res, "pdf"); }
  catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/reports/export.xls", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try { await serveReportExport(req, res, "xls"); }
  catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Unified report export (O20) — GET /food/reports/export.:fmt
 *
 * One endpoint serves every report widget. `?report=` selects which dataset to
 * render (orders | variance | waste | ontime); fmt (csv|pdf|xls) selects the
 * encoder. Scoping (resolveAccessiblePropertyIds + ?propertyId/?brand) and the
 * from/to filters mirror the per-report JSON endpoints, so an export reflects
 * exactly what the on-screen widget shows. `orders` reuses fetchOrdersForExport.
 * ════════════════════════════════════════════════════════════════════════ */

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Shared property/brand/date scope for the variance/waste/ontime export datasets. */
async function reportExportScope(req: any): Promise<{
  where: ReturnType<typeof and>; propertyName: string | null; dateRange: string | null; from?: Date; to?: Date;
}> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const from = parseDate(req.query["from"]); const to = parseDate(req.query["to"]);
  const propertyId = req.query["propertyId"] as string | undefined;
  const brand = req.query["brand"] as string | undefined;
  const conds = [] as any[];
  if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
  if (from) conds.push(gte(foodOrdersTable.serviceDate, from));
  if (to) conds.push(lte(foodOrdersTable.serviceDate, to));
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
  conds.push(eq(foodOrdersTable.status, "DELIVERED" as never));
  let propertyName: string | null = null;
  if (propertyId) {
    const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    propertyName = p?.name ?? null;
  }
  const dateRange = from || to ? `${from ? fmtDate(from) : "…"} → ${to ? fmtDate(to) : "…"}` : null;
  return { where: and(...conds), propertyName, dateRange, from, to };
}

/** Builds the {title, headers, rows, propertyName, dateRange} table for a report. */
async function buildReportTable(report: string, req: any): Promise<{
  title: string; headers: string[]; rows: (string | number | null | undefined)[][];
  propertyName: string | null; dateRange: string | null; fileBase: string;
}> {
  if (report === "orders") {
    const { rows, propertyName, dateRange } = await fetchOrdersForExport(req);
    return { title: "Food Orders Report", headers: ORDER_HEADERS, rows, propertyName, dateRange, fileBase: "food-orders" };
  }

  if (report === "variance") {
    const { where, propertyName, dateRange } = await reportExportScope(req);
    const grouped = await db.select({
      mealType: foodOrdersTable.mealType,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType);
    const byMeal = new Map(grouped.map((g) => [g.mealType, g]));
    const rows = MEAL_TYPES.map((mt) => {
      const g = byMeal.get(mt);
      const ordered = r3(Number(g?.ordered ?? 0));
      const received = r3(Number(g?.received ?? 0));
      const wasted = r3(Number(g?.wasted ?? 0));
      return [mt, ordered, received, r3(ordered - received), wasted];
    });
    return {
      title: "Ordered vs Delivered Variance", headers: ["Meal", "Ordered", "Received", "Variance", "Wasted"],
      rows, propertyName, dateRange, fileBase: "food-variance",
    };
  }

  if (report === "waste") {
    const { where, propertyName, dateRange } = await reportExportScope(req);
    const wasteByDish = await db.select({
      dishName: dishesTable.name, unit: foodOrderItemsTable.unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(where).groupBy(dishesTable.name, foodOrderItemsTable.unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    const nonZero = wasteByDish.filter((d) => Number(d.wasted) > 0);
    const topCount = Math.max(1, Math.ceil(nonZero.length * 0.2));
    const rows = nonZero.slice(0, topCount).map((d) => {
      const wasted = r3(Number(d.wasted)); const ordered = r3(Number(d.ordered));
      const pct = ordered > 0 ? Math.round((Number(d.wasted) / Number(d.ordered)) * 1000) / 10 : 0;
      return [d.dishName ?? "—", d.unit ?? "", ordered, wasted, `${pct}%`];
    });
    return {
      title: "Top Waste Items", headers: ["Dish", "Unit", "Ordered", "Wasted", "Waste %"],
      rows, propertyName, dateRange, fileBase: "food-waste",
    };
  }

  if (report === "ontime") {
    const { where, propertyName, dateRange } = await reportExportScope(req);
    const orders = await db.select({
      brand: foodOrdersTable.brand, mealType: foodOrdersTable.mealType, propertyId: foodOrdersTable.propertyId,
      serviceDate: foodOrdersTable.serviceDate, deliveredAt: foodOrdersTable.deliveredAt,
    }).from(foodOrdersTable).where(and(where, isNotNull(foodOrdersTable.deliveredAt)));
    const tolMs = (await getOntimeToleranceMinutes()) * 60000;
    const resolveServiceTime = await loadServiceTimeResolver();
    const byDay = new Map<string, { onTime: number; late: number }>();
    for (const o of orders) {
      const base = atTime(o.serviceDate, resolveServiceTime(o.brand, o.mealType, o.propertyId));
      if (!base || !o.deliveredAt) continue;
      const day = istDayYmd(o.serviceDate);
      const bucket = byDay.get(day) ?? { onTime: 0, late: 0 };
      if (o.deliveredAt.getTime() <= base.getTime() + tolMs) bucket.onTime++; else bucket.late++;
      byDay.set(day, bucket);
    }
    const rows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => {
      const total = v.onTime + v.late;
      return [date, v.onTime, v.late, total ? `${Math.round((v.onTime / total) * 1000) / 10}%` : "0%"];
    });
    return {
      title: "On-Time Delivery", headers: ["Date", "On-Time", "Late", "On-Time %"],
      rows, propertyName, dateRange, fileBase: "food-ontime",
    };
  }

  throw new Error("INVALID_REPORT");
}

/** Build "{base}-{property?}-{date}.{ext}" filename for a report export. */
function reportFilename(fileBase: string, propertyName: string | null, ext: string): string {
  const prop = propertyName ? `-${sanitizeForFilename(propertyName)}` : "";
  return `${fileBase}${prop}-${fileDateStamp()}.${ext}`;
}

const EXPORT_REPORTS = new Set(["orders", "variance", "waste", "ontime"]);

foodOpsRouter.get("/reports/export.:fmt", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const fmt = String(req.params["fmt"] ?? "").toLowerCase();
    if (!["csv", "pdf", "xls"].includes(fmt)) {
      res.status(400).json({ success: false, error: "fmt must be csv, pdf or xls" }); return;
    }
    const report = String(req.query["report"] ?? "orders").toLowerCase();
    if (!EXPORT_REPORTS.has(report)) {
      res.status(400).json({ success: false, error: "report must be one of orders, variance, waste, ontime" }); return;
    }
    const t = await buildReportTable(report, req);
    const table = { title: t.title, headers: t.headers, rows: t.rows, propertyName: t.propertyName, dateRange: t.dateRange };
    const filename = reportFilename(t.fileBase, t.propertyName, fmt);

    if (fmt === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toCsv(table));
    } else if (fmt === "pdf") {
      const pdf = await toPdf(table);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(Buffer.from(pdf));
    } else {
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toXls(table));
    }
  } catch (err) {
    if ((err as Error)?.message === "INVALID_REPORT") {
      res.status(400).json({ success: false, error: "Invalid report" }); return;
    }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
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

    // All-time delivered-order counts per property (for the "delivered" chip).
    const deliveredRows = await db.select({ propertyId: foodOrdersTable.propertyId, c: sql<number>`count(*)::int` })
      .from(foodOrdersTable)
      .where(and(inArray(foodOrdersTable.propertyId, propIds), eq(foodOrdersTable.status, "DELIVERED" as never)))
      .groupBy(foodOrdersTable.propertyId);
    const deliveredByProp = new Map(deliveredRows.map((r) => [r.propertyId, r.c]));

    const data = props.map((p) => {
      const active = guestCount.get(p.id) ?? 0;
      const pend = pendingByProp.get(p.id) ?? { active: 0, awaitingDelivery: 0 };
      return {
        id: p.id, name: p.name, city: p.city, brand: p.brand,
        kitchenId: p.kitchenId, kitchenName: p.kitchenId ? (kitchenName.get(p.kitchenId) ?? null) : null,
        totalBeds: p.totalBeds, occupied: active, activeGuests: active,
        occupancyPct: p.totalBeds ? Math.round((active / p.totalBeds) * 100) : 0,
        monthlyRevenue: revByProp.get(p.id) ?? 0,
        activeOrders: pend.active, awaitingDelivery: pend.awaitingDelivery,
        deliveredCount: deliveredByProp.get(p.id) ?? 0,
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
async function fetchGuests(req: any, res: any): Promise<{ where: any } | null> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const propertyId = req.query["propertyId"] as string | undefined;
  const search = (req.query["search"] as string | undefined)?.trim();

  // An explicit propertyId must never bypass the caller's accessible scope.
  if (propertyId && !isAccessible(propertyId, ids)) {
    res.status(403).json({ success: false, error: "Property not accessible" });
    return null;
  }

  const conds = [eq(residentsTable.status, "ACTIVE")] as any[];
  // Always apply the accessible-property scope; the explicit filter narrows within it.
  if (ids !== null) conds.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
  if (propertyId) conds.push(eq(residentsTable.propertyId, propertyId));

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
    // idNumber is now encrypted at rest (WS5), so substring search is impossible.
    // Aadhaar/PAN search is EXACT-MATCH by design: we look up the HMAC blind index
    // of the full normalized search term (spaces/case ignored) against id_number_index.
    // Guarded: blindIndex() throws when ENCRYPTION_KEY is unset (local dev without a
    // key) — degrade gracefully to name/phone/email/room search instead of 500ing
    // the whole guest listing/export.
    try {
      const idx = blindIndex(search);
      const kycRows = await db
        .select({ rid: kycRequestsTable.residentId })
        .from(kycRequestsTable)
        .where(eq(kycRequestsTable.idNumberIndex, idx));
      if (kycRows.length) orParts.push(inArray(residentsTable.id, kycRows.map((r) => r.rid)));
    } catch (e) {
      req.log?.warn?.({ err: e }, "KYC id-number search skipped (encryption key unavailable)");
    }
    conds.push(or(...orParts));
  }
  return { where: and(...conds) };
}

foodOpsRouter.get("/guests", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const guard = await fetchGuests(req, res); if (!guard) return;
    const { where } = guard;
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
/**
 * Resolves guest export rows + metadata. propertyName is set when the list
 * resolves to a single property (scoped export); otherwise null. Returns null
 * if the underlying access guard rejected (response already sent).
 */
async function guestExportRows(req: any, res: any): Promise<{
  rows: (string | number | null | undefined)[][];
  propertyName: string | null;
} | null> {
  const guard = await fetchGuests(req, res); if (!guard) return null;
  const { where } = guard;
  const rows = await db.select({ r: residentsTable, propertyName: propertiesTable.name, roomNumber: roomsTable.number })
    .from(residentsTable).leftJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id))
    .leftJoin(roomsTable, eq(residentsTable.roomId, roomsTable.id)).where(where).orderBy(residentsTable.name);
  const names = new Set(rows.map((r) => r.propertyName ?? "").filter(Boolean));
  const propertyName = names.size === 1 ? [...names][0] : null;
  const mapped = rows.map((r) => [
    r.r.id.slice(0, 8), r.r.name, r.r.phone, r.r.email, r.r.gender ?? "", r.roomNumber ?? "",
    r.propertyName ?? "", fmtDate(r.r.checkInDate),
  ]);
  return { rows: mapped, propertyName };
}

/** Build "active-guests-{property?}-{date}.{ext}" filename. */
function guestsFilename(propertyName: string | null, ext: string): string {
  const prop = propertyName ? `-${sanitizeForFilename(propertyName)}` : "";
  return `active-guests${prop}-${fileDateStamp()}.${ext}`;
}

foodOpsRouter.get("/guests/export.csv", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    const csv = toCsv({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "csv")}`);
    res.send(csv);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/guests/export.pdf", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    const pdf = await toPdf({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "pdf")}`);
    res.send(Buffer.from(pdf));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/guests/export.xls", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    const xls = toXls({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "xls")}`);
    res.send(xls);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default foodOpsRouter;
