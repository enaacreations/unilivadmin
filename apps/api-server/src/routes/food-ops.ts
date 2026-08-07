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
  foodMenuShareChannelEnum,
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
  propertyPhotosTable,
  measurementUnitEnum,
} from "@workspace/db";
import { and, eq, or, ilike, sql, desc, asc, gte, lte, lt, inArray, notInArray, isNull, isNotNull } from "drizzle-orm";
import { getObjectUrl, isStorageConfigured } from "@workspace/storage";
import { canTransition } from "../lib/order-transitions.js";
import { authenticate, authorize as requireRoles } from "../middlewares/auth.js";
import { authorize, authorizeAny } from "../middlewares/authorize.js";
import { can, type UserRole } from "../lib/permissions.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { isSuperAdmin } from "../lib/authz.js";
import { logger } from "../lib/logger.js";
import { newId } from "../lib/id.js";
import {
  resolveAccessiblePropertyIds,
  resolveAccessibleKitchenIds,
  computeOrderItems,
  getPropertyFoodConfig,
  resolveOrderPreview,
  resolveMenu,
  resolveRulesByDish,
  isActiveBrand,
  isIngredientClashRuleOn,
  isRepeatFlagRuleOn,
  FOOD_RULE_INGREDIENT_CLASH_KEY,
  FOOD_RULE_REPEAT_FLAG_KEY,
  getDefaultCutoffTime,
  getSystemConfigValue,
  getWasteEditWindowMs,
  FOOD_DEFAULT_CUTOFF_KEY,
  FOOD_WASTE_WINDOW_KEY,
} from "../lib/food-service.js";
import { notify, notifyAll, notifyOrderEvent } from "../lib/notification-service.js";
import { writeAuditLog } from "../lib/wallet-service.js";
import { toCsv, toPdf, toXls, fmtDate, fmtDateTime, fileDateStamp, sanitizeForFilename } from "../lib/export-service.js";
import { blindIndex } from "../lib/field-crypto.js";
import { istDayYmd, addDaysYmd, atIst, ymdToIstDayStart } from "../lib/tz.js";
import { z } from "zod";

export const foodOpsRouter: Router = Router();

/** Transaction client type (mirrors wallet-service); `db` itself also satisfies it. */
export type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either a transaction handle or the top-level db — both share the query surface used here. */
type DbLike = TxClient | typeof db;

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;

/** The measurement units the DB enum accepts — an order item's unit is validated
 *  against this BEFORE the `as never` cast, so a bad value 400s instead of
 *  throwing mid-insert (H6). Sourced from the enum itself so the two cannot drift. */
const MEASUREMENT_UNITS = measurementUnitEnum.enumValues;

/** Tolerance on a client-edited order quantity: at most 120% of what the standing
 *  per-resident rule derives for that headcount. Mirrors the 20% residents cap in
 *  residentsCapForProperty — the editable grid is a product feature, an unbounded
 *  cook quantity is not (H6). */
const ORDER_QTY_TOLERANCE = 1.2;

/** Base for public/share links (mirrors auth.ts; trailing slashes trimmed).
 *  NOTE: unset, this silently yields relative `/m/<token>` links in outbound
 *  email — useless in a mail client. It belongs in the fail-closed boot check in
 *  config/env.ts (routed to the config owner), not in a per-route guard. */
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
/** L8 — an IST wall-clock "HH:MM". atIst reads the two halves with `h || 0`, so
 *  an unparseable cut-off/service time degrades to 00:00 — which closes ordering
 *  for a whole brand — instead of being rejected. Same regex the org-wide
 *  default on the very same settings tab already enforces (see food-defaults). */
const zClockTime = z.string().regex(/^\d{1,2}:\d{2}$/, "must be HH:MM");
/** L6 — the share channel is a Postgres enum; validating it as free text turned a
 *  typo into an opaque 500 at insert time instead of a 400. */
const zShareChannel = z.enum(foodMenuShareChannelEnum.enumValues);

function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

/**
 * L7 — escapes the LIKE metacharacters in a caller-supplied search term.
 *
 * Unescaped, `%` matches everything (a bare `?search=%` returned every ACTIVE
 * resident in scope, PII export included) and a legitimate `_` silently matched
 * a different row. Postgres' default LIKE escape is the backslash and the
 * pattern travels as a bind parameter, so prefixing is all this needs. Same
 * implementation as food.ts's escapeLike — kept local because food.ts imports
 * from this module (reconcileDispatchForOrder) and the reverse import would
 * close the cycle; see the note in the fix report about hoisting it to a lib.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The master-data / config tables whose mutations this file records (M17). */
type FoodConfigEntity =
  | "food_meal_config" | "food_meal_window" | "food_cutoff" | "food_system_config"
  | "food_kitchen" | "food_brand" | "property_brand" | "property_kitchen";

/**
 * Records one master-data / config mutation. The twin of food.ts's auditConfig
 * and deliberately the same shape — M17 is "no food mutation writes to
 * audit_log", and a fix that covers one router's config writes and not the
 * other's is not a fix.
 *
 * Fire-and-forget by design: an audit-log failure must never fail the mutation
 * it is recording, which is why writeAuditLog swallows its own errors and this
 * never awaits. Pass `before` on every UPDATE and DELETE — without the prior row
 * the entry says only that something changed.
 */
function auditConfig(
  req: any,
  action: "FOOD_CONFIG_CREATED" | "FOOD_CONFIG_UPDATED" | "FOOD_CONFIG_DELETED",
  entity: FoodConfigEntity,
  entityId: string,
  changes: { before?: unknown; after?: unknown },
): void {
  void writeAuditLog(req.user!.id, action, entity, entityId, changes).catch(() => {});
}

/**
 * Error-log context for the ORDER and DISPATCH mutation paths.
 *
 * `req.log.error(err)` records the stack and nothing that identifies the request,
 * so a 500 on "an order somewhere failed to dispatch" was unreproducible: no
 * actor, no property, no service day. This attaches the five fields that make it
 * answerable, in the shape the notify failures here already log
 * (`{ err, orderId }, "message"`). Everything is read defensively — it runs in a
 * catch, where the body may be the very thing that was malformed.
 */
function mutationLog(req: any, err: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const b: Record<string, unknown> = (req?.body && typeof req.body === "object") ? req.body : {};
  return {
    err,
    userId: req?.user?.id ?? null,
    role: req?.user?.role ?? null,
    propertyId: b["propertyId"] ?? req?.user?.propertyId ?? null,
    mealType: b["mealType"] ?? null,
    serviceDate: b["serviceDate"] ?? b["date"] ?? null,
    ...extra,
  };
}

/**
 * Postgres unique_violation. `names` narrows it to specific constraints/indexes;
 * an error carrying no constraint name (some driver wrappers drop it on the way
 * out) still matches, so a genuine duplicate can never fall through to a 500.
 */
function isUniqueViolation(err: unknown, ...names: string[]): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  if ((e?.code ?? e?.cause?.code) !== "23505") return false;
  if (!names.length) return true;
  const c = e?.constraint ?? e?.cause?.constraint;
  return !c || names.includes(c);
}

/**
 * Retries `fn` when it loses a race on one of the named MAX()+1 sequence
 * constraints, recomputing the number each attempt. Deliberately narrower than
 * lib/id.ts's withUniqueRetry, which matches on the error TEXT: drizzle rewrites
 * the message to "Failed query: …", so that test never fires here, and a blanket
 * retry would also re-run a genuine duplicate-order violation five times before
 * reporting it.
 */
async function runWithSeqRetry<T>(constraints: string[], fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isUniqueViolation(err, ...constraints)) throw err;
    }
  }
}

/**
 * H4 — property-scope guard for the CONFIG surfaces (meal windows, cut-offs).
 * These rows steer what every property on the brand may order and when, so a
 * kitchen-restricted caller must name a property they actually reach: a null
 * propertyId is the brand-wide row, the same escalation `assertKitchenAccess`
 * refuses for the brand-wide menu. Returns true when the request was refused,
 * having already written the 403 (mirrors food.ts's deniedKitchen, which cannot
 * throw past these handlers' try/catch → 500).
 */
async function deniedConfigScope(req: any, res: any, propertyId: string | null | undefined): Promise<boolean> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  if (ids === null) return false;
  if (!propertyId) {
    res.status(403).json({ success: false, error: "Pick one of your properties — you cannot edit the brand-wide setting" });
    return true;
  }
  if (!isAccessible(propertyId, ids)) {
    res.status(403).json({ success: false, error: "Property not accessible" });
    return true;
  }
  return false;
}

/**
 * H4 — org-wide-authority guard for the SINGLETON config surfaces.
 *
 * Unlike meal windows and cut-offs (property-dimensioned), `food_meal_config`
 * (meal_type UNIQUE, no scope column) and the `system_config` switches have NO
 * scope dimension the API could narrow on: one kitchen's F&B manager disabling
 * a meal — or a menu rule — disables it for every property in the organisation.
 * With nothing to narrow, the only honest gate is org-wide authority, the same
 * call deniedConfigScope makes for a null (brand-wide) propertyId. Mirrors
 * food.ts's deniedGlobalConfig, which guards the portion rules that sit on this
 * same settings tab. Returns true when the request was refused, having already
 * written the 403.
 */
async function deniedGlobalConfig(req: any, res: any, what: string): Promise<boolean> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  if (ids === null) return false;
  res.status(403).json({
    success: false,
    error: `${what} apply to every property in the organisation — only an org-wide administrator can change them`,
  });
  return true;
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
 * L2 — resolveCutoff for MANY (brand, property) pairs in one query.
 *
 * Same precedence, resolved in JS: the property's own row wins, else the newest
 * active brand-wide row, else the system default. Mirrors loadServiceTimeResolver
 * below; exists because /next-orders called resolveCutoff once per property.
 */
async function loadCutoffResolver(brands: string[]): Promise<(brand: string, propertyId: string) => string | null> {
  const fallback = await getDefaultCutoffTime();
  const uniq = [...new Set(brands)];
  const rows = uniq.length
    ? await db.select().from(foodCutoffsTable).where(and(
        inArray(foodCutoffsTable.brand, uniq),
        eq(foodCutoffsTable.isActive, true),
      )).orderBy(desc(foodCutoffsTable.updatedAt))
    : [];
  return (brand, propertyId) => {
    let global: string | undefined;
    for (const r of rows) {
      if (r.brand !== brand) continue;
      if (r.propertyId === propertyId) return r.cutoffTime;
      if (r.propertyId === null && global === undefined) global = r.cutoffTime;
    }
    return global ?? fallback;
  };
}

/**
 * L2 — run `fn` over `items` with at most `limit` in flight.
 *
 * Promise.all over a property list is unbounded fan-out: each callback here costs
 * ~10 queries, so a few hundred properties opened thousands of concurrent
 * statements against a pool sized in the tens — every one of them queued, and the
 * request timed out holding connections the rest of the app needed. Results stay
 * in input order, so callers read exactly like the Promise.all they replace.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Server-side enforcement of the order cut-off, shared by BOTH order-placement
 * endpoints (POST /food/orders in food.ts and POST /food/order-batches here) so
 * the cut-off can't be bypassed by calling the API directly. A single cut-off per
 * brand/property applies to all meals on the service day. Rejects when:
 *   1. the service day is already in the past,
 *   2. the resolved cut-off time for that service date has passed, or
 *   3. the service day is beyond the NEXT orderable day — orders are strictly
 *      for tomorrow (or the day after, once tomorrow's cut-off has passed,
 *      mirroring /next-orders). Having tomorrow fully ordered never unlocks
 *      ordering further ahead.
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
  const cutoffTime = await resolveCutoff(brand, propertyId);
  // 2) Once the resolved cut-off passes, ordering is closed. The cut-off deadline
  //    is anchored on the DAY BEFORE the service date: an order for tomorrow must
  //    be placed by today's cut-off time (atIst(serviceDate - 1 day, cutoffTime)).
  const prevDayYmd = addDaysYmd(serviceYmd, -1);
  const cutoffAt = cutoffTime ? atIst(prevDayYmd, cutoffTime) : null;
  if (cutoffAt && now > cutoffAt) {
    const [y, m, d] = serviceYmd.split("-");
    const label = `${d}/${m}/${y}`;
    return `Ordering for ${label} is closed — the ${cutoffTime} cut-off has passed.`;
  }
  // 3) No ordering AHEAD of the next orderable day: tomorrow, or the day after
  //    once tomorrow's cut-off (anchored today) has passed. This is the same
  //    resolution /next-orders serves the UI, enforced here so a crafted request
  //    can't pre-order future days.
  let nextOrderableYmd = addDaysYmd(todayYmd, 1);
  const tomorrowCutoffAt = cutoffTime ? atIst(todayYmd, cutoffTime) : null;
  if (tomorrowCutoffAt && now > tomorrowCutoffAt) {
    nextOrderableYmd = addDaysYmd(todayYmd, 2);
  }
  if (serviceYmd > nextOrderableYmd) {
    const [y, m, d] = nextOrderableYmd.split("-");
    return `Orders can only be placed for the next service day (${d}/${m}/${y}).`;
  }
  return null;
}

/** 20% ordering cap: the max RESIDENTS a property may order for a meal = 120% of
 *  its current occupancy (active residents). A property with 0 ACTIVE residents
 *  has cap 0 — you can't order resident meals for residents you don't have; staff
 *  are a separate, UNCAPPED population, so such a property orders staff-only. */
export async function residentsCapForProperty(
  propertyId: string,
): Promise<{ occupancy: number; cap: number }> {
  const [occRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(residentsTable)
    .where(and(eq(residentsTable.propertyId, propertyId), eq(residentsTable.status, "ACTIVE")));
  const occupancy = Number(occRow?.c ?? 0);
  return { occupancy, cap: occupancy > 0 ? Math.ceil(occupancy * 1.2) : 0 };
}

/** Expected delivery time = serviceDate@serviceTime + leadTime (delay baseline). */
async function expectedDeliveryAt(brand: string, mealType: string, serviceDate: Date, propertyId: string) {
  const w = await resolveWindow(brand, mealType, propertyId);
  if (!w) return null;
  const base = atTime(serviceDate, w.serviceTime);
  if (!base) return null;
  return new Date(base.getTime() + (w.leadTimeMinutes ?? 0) * 60000);
}

// The non-transactional nextSeq() that used to live here is gone: its only
// caller (the order batch) now allocates inside a transaction via nextSeqTx,
// which is the same max-based scheme reading through the transaction's snapshot.

/* ════════════════════════════════════════════════════════════════════════
 * Meal config & cut-off windows (Persona st.11, st.27)
 * ════════════════════════════════════════════════════════════════════════ */

foodOpsRouter.get("/meal-config", authenticate, authorize("FOOD_SETTINGS", "view"), async (_req, res) => {
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
    // L6: the path param is cast to the meal-type enum below, so an unknown value
    // used to reach Postgres as a bad enum literal and 500 — the 404 underneath
    // was unreachable. Membership is checked here so it answers, as intended.
    const mealType = req.params["mealType"] as string;
    if (!(MEAL_TYPES as readonly string[]).includes(mealType)) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // H4: food_meal_config is an org-wide singleton — `isEnabled:false` here takes
    // the meal off the ordering screen for every property on every brand, so a
    // kitchen-scoped FOOD_SETTINGS holder must not reach it.
    if (await deniedGlobalConfig(req, res, "Meal settings")) return;
    const b = req.body || {};
    // M17: read the prior row so the entry says what changed — "breakfast was
    // switched off network-wide" is not recoverable from the new row alone.
    const [before] = await db.select().from(foodMealConfigTable).where(eq(foodMealConfigTable.mealType, mealType as never));
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.displayLabel !== undefined) u["displayLabel"] = b.displayLabel;
    if (b.sortOrder !== undefined) u["sortOrder"] = Number(b.sortOrder);
    if (b.isEnabled !== undefined) u["isEnabled"] = !!b.isEnabled;
    const [row] = await db.update(foodMealConfigTable).set(u as never)
      .where(eq(foodMealConfigTable.mealType, mealType as never)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_meal_config", mealType, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/meal-windows", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
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
  cutoffTime: zClockTime.nullish(),
  serviceTime: zClockTime.nullish(),
  leadTimeMinutes: z.coerce.number().nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/meal-windows", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createMealWindowSchema, req, res)) return;
    const b = req.body || {};
    if (!b.brand || !b.mealType) { res.status(400).json({ success: false, error: "brand and mealType required" }); return; }
    // H4: a meal window drives the cut-off and service SLA for the properties it
    // covers, so it carries the same scope guard as the rotation writes.
    if (await deniedConfigScope(req, res, b.propertyId ?? null)) return;
    const [row] = await db.insert(foodMealWindowsTable).values({
      id: newId(), brand: b.brand, propertyId: b.propertyId ?? null, mealType: b.mealType,
      cutoffTime: b.cutoffTime ?? null, serviceTime: b.serviceTime ?? null,
      leadTimeMinutes: b.leadTimeMinutes != null ? Number(b.leadTimeMinutes) : 0,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_meal_window", row!.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    // uq_food_meal_windows_brand_meal_prop / _global — one window per brand+meal+property.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A meal window already exists for this brand/meal/property" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

const updateMealWindowSchema = z.object({
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  cutoffTime: zClockTime.nullish(),
  serviceTime: zClockTime.nullish(),
  isActive: z.boolean().optional(),
  propertyId: zId.nullish(),
  leadTimeMinutes: z.coerce.number().optional(),
}).passthrough();

foodOpsRouter.put("/meal-windows/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateMealWindowSchema, req, res)) return;
    const b = req.body || {};
    // H4: load first — BOTH the row's current propertyId and the requested one
    // must be in scope, or the update is itself the escalation (re-pointing a
    // window you own at a property you don't, or promoting it to brand-wide).
    const [before] = await db.select().from(foodMealWindowsTable).where(eq(foodMealWindowsTable.id, req.params["id"]!));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedConfigScope(req, res, before.propertyId)) return;
    if (b.propertyId !== undefined && await deniedConfigScope(req, res, b.propertyId ?? null)) return;
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "mealType", "cutoffTime", "serviceTime", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.propertyId !== undefined) u["propertyId"] = b.propertyId ?? null;
    if (b.leadTimeMinutes !== undefined) u["leadTimeMinutes"] = Number(b.leadTimeMinutes);
    const [row] = await db.update(foodMealWindowsTable).set(u as never).where(eq(foodMealWindowsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_meal_window", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A meal window already exists for this brand/meal/property" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

foodOpsRouter.delete("/meal-windows/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    // H4: same scope guard as the write above — a bare delete by path id let a
    // kitchen-restricted caller drop another property's (or the brand's) window.
    const [before] = await db.select().from(foodMealWindowsTable).where(eq(foodMealWindowsTable.id, req.params["id"]!));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedConfigScope(req, res, before.propertyId)) return;
    await db.delete(foodMealWindowsTable).where(eq(foodMealWindowsTable.id, req.params["id"]!));
    // M17: a hard delete leaves nothing behind, so `before` IS the record.
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_meal_window", before.id, { before });
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ── Single cut-off per brand (applies to all meals; property-overridable) ── */
foodOpsRouter.get("/cutoff-config", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
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
  cutoffTime: zClockTime,
  propertyId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.post("/cutoff-config", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createCutoffSchema, req, res)) return;
    const b = req.body || {};
    if (!b.brand || !b.cutoffTime) { res.status(400).json({ success: false, error: "brand and cutoffTime required" }); return; }
    const propertyId = b.propertyId ?? null;
    // H4: the cut-off decides when a property may still order at all, so it
    // carries the same scope guard as the rotation writes.
    if (await deniedConfigScope(req, res, propertyId)) return;
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_cutoff", row!.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    // idx_food_cutoffs_brand_prop / uq_food_cutoffs_brand_global — the DB backstop
    // behind the dedupe SELECT above (matched on the driver's SQLSTATE, not on the
    // error text, which drizzle rewrites).
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A cut-off already exists for this brand/property" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

const updateCutoffSchema = z.object({
  brand: zBrand.optional(),
  propertyId: zId.nullish(),
  cutoffTime: zClockTime.optional(),
  isActive: z.boolean().optional(),
}).passthrough();

foodOpsRouter.put("/cutoff-config/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateCutoffSchema, req, res)) return;
    const b = req.body || {};
    // H4: both the stored and the requested propertyId must be in scope (see the
    // meal-window PUT above for why the "before" row has to be loaded first).
    const [before] = await db.select().from(foodCutoffsTable).where(eq(foodCutoffsTable.id, req.params["id"]!));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedConfigScope(req, res, before.propertyId)) return;
    if (b.propertyId !== undefined && await deniedConfigScope(req, res, b.propertyId ?? null)) return;
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "propertyId", "cutoffTime", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(foodCutoffsTable).set(u as never).where(eq(foodCutoffsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_cutoff", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A cut-off already exists for this brand/property" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

foodOpsRouter.delete("/cutoff-config/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    // H4: same scope guard as the write above — deleting a property's cut-off
    // silently re-opens ordering for it on the brand-wide default.
    const [before] = await db.select().from(foodCutoffsTable).where(eq(foodCutoffsTable.id, req.params["id"]!));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedConfigScope(req, res, before.propertyId)) return;
    await db.delete(foodCutoffsTable).where(eq(foodCutoffsTable.id, req.params["id"]!));
    // M17: hard delete — `before` is the only surviving record of the cut-off.
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_cutoff", before.id, { before });
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Resolved cut-off info for placing orders on a given date (single cut-off, all meals). */
// H4: any-of — the order-placement screen needs this to know whether the window
// is still open, and the settings screen to preview what it just configured.
foodOpsRouter.get("/cutoffs", authenticate, authorizeAny(["FOOD_PLACE_ORDER", "FOOD_SETTINGS"], "view"), async (req, res) => {
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

/** Read the current global food defaults. Gated on the same module that owns the
 *  Food Settings page these two values are edited from (H4 — it was open to any
 *  authenticated user, food or not). */
foodOpsRouter.get("/system-config/food-defaults", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const defaultCutoff = await getDefaultCutoffTime();
    const rawWindow = await getSystemConfigValue<number>(FOOD_WASTE_WINDOW_KEY, 60);
    const wasteWindowMinutes = Number.isFinite(Number(rawWindow)) && Number(rawWindow) > 0 ? Number(rawWindow) : 60;
    res.json({ success: true, data: { defaultCutoff, wasteWindowMinutes } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Upsert the global food defaults. Top-tier admins only (org-wide setting). */
// Both fields optional; the handler hand-validates HH:MM / positive-number formats
// (keep these loose so those specific 400 messages are preserved).
const foodDefaultsSchema = z.object({
  defaultCutoff: z.union([z.string(), z.number()]).optional(),
  wasteWindowMinutes: z.union([z.string(), z.number()]).optional(),
}).passthrough();

foodOpsRouter.put("/system-config/food-defaults", authenticate, async (req, res) => {
  try {
    // Org-wide food defaults: top-tier admins only.
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — food administrators only" });
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
      // M17: these keys are org-wide singletons — the default cut-off decides
      // when EVERY property stops being able to order — so each one is audited
      // individually with the value it replaced.
      const [before] = await db.select().from(systemConfigTable).where(eq(systemConfigTable.key, u.key));
      await db.insert(systemConfigTable)
        .values({ id: newId(), key: u.key, value: u.value as never, description: u.description, updatedAt: new Date() })
        .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: u.value as never, updatedAt: new Date() } });
      auditConfig(req, before ? "FOOD_CONFIG_UPDATED" : "FOOD_CONFIG_CREATED", "food_system_config", u.key, { before: before?.value, after: u.value });
    }

    const defaultCutoff = await getDefaultCutoffTime();
    const rawWindow = await getSystemConfigValue<number>(FOOD_WASTE_WINDOW_KEY, 60);
    const wasteWindowMinutes = Number.isFinite(Number(rawWindow)) && Number(rawWindow) > 0 ? Number(rawWindow) : 60;
    res.json({ success: true, data: { defaultCutoff, wasteWindowMinutes } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Menu rule switches (Service Set → Menu Rules)
 * ────────────────────────────────────────────────────────────────────────
 * The two "Variety & safety rules" toggles. Unlike food-defaults above these
 * are gated on FOOD_SETTINGS rather than isSuperAdmin, so the people who edit
 * the composition rules on the same tab can edit these too — an F&B manager
 * owning the plate but not the rules that govern it would be an odd seam.
 *
 * Stored as raw JSON booleans; both default to TRUE when the row is absent, so
 * a fresh environment behaves as it did when the rules were hard-coded.
 * ════════════════════════════════════════════════════════════════════════ */

const menuRuleSettingsSchema = z.object({
  ingredientClashBlocks: z.boolean().optional(),
  flagRepeatsWithin3Days: z.boolean().optional(),
}).passthrough();

/** Read the menu rule switches. */
foodOpsRouter.get("/system-config/menu-rules", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        ingredientClashBlocks: await isIngredientClashRuleOn(),
        flagRepeatsWithin3Days: await isRepeatFlagRuleOn(),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Upsert the menu rule switches. */
foodOpsRouter.put("/system-config/menu-rules", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(menuRuleSettingsSchema, req, res)) return;
    // H4: same invariant as meal-config — these two switches live in system_config
    // under a single org-wide key, so turning the ingredient-clash block off is a
    // network-wide change. FOOD_SETTINGS stays the module gate (see the block note
    // above); org-wide authority is the scope gate on top of it.
    if (await deniedGlobalConfig(req, res, "Menu rules")) return;
    const b = req.body || {};
    const updates: Array<{ key: string; value: unknown; description: string }> = [];

    if (b.ingredientClashBlocks !== undefined) {
      updates.push({
        key: FOOD_RULE_INGREDIENT_CLASH_KEY,
        value: b.ingredientClashBlocks === true,
        description: "Block saving a rotation plate whose dishes share an ingredient.",
      });
    }
    if (b.flagRepeatsWithin3Days !== undefined) {
      updates.push({
        key: FOOD_RULE_REPEAT_FLAG_KEY,
        value: b.flagRepeatsWithin3Days === true,
        description: "Flag (never block) a dish already used for the same meal within 3 days.",
      });
    }
    if (!updates.length) { res.status(400).json({ success: false, error: "Nothing to update" }); return; }

    for (const u of updates) {
      // M17: same org-wide-singleton reasoning as food-defaults above — turning
      // the ingredient-clash block off is a network-wide safety change.
      const [before] = await db.select().from(systemConfigTable).where(eq(systemConfigTable.key, u.key));
      await db.insert(systemConfigTable)
        .values({ id: newId(), key: u.key, value: u.value as never, description: u.description, updatedAt: new Date() })
        .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: u.value as never, updatedAt: new Date() } });
      auditConfig(req, before ? "FOOD_CONFIG_UPDATED" : "FOOD_CONFIG_CREATED", "food_system_config", u.key, { before: before?.value, after: u.value });
    }

    // Re-read through the getters so the client always sees the coerced truth.
    res.json({
      success: true,
      data: {
        ingredientClashBlocks: await isIngredientClashRuleOn(),
        flagRepeatsWithin3Days: await isRepeatFlagRuleOn(),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Kitchens (Persona st.24)
 * ════════════════════════════════════════════════════════════════════════ */

/* H4/H8: the kitchen master carries contact names, phones and emails, so it is
 * no longer readable by every logged-in user. Any-of because one list legitimately
 * feeds several screens — Food Settings, the org tree, the dispatch board, the
 * kitchen home and the property form — and gating on FOOD_SETTINGS alone would
 * lock the shipping roles out of their own kitchen picker. */
const KITCHEN_MASTER_READERS = ["FOOD_SETTINGS", "FOOD_ORG", "FOOD_DISPATCH", "FOOD_KITCHEN_SUMMARY", "FOOD_DASHBOARD", "PROPERTIES"] as const;

/**
 * Who may see a kitchen's named contact (name/phone/email). Only the two modules
 * that ADMINISTER kitchens — every other reader gets the picker fields. Shared by
 * GET /kitchens, GET /hierarchy and GET /dispatches/:id so one rule governs every
 * surface that joins the kitchen row (H8).
 */
function mayReadKitchenContacts(req: any): boolean {
  const role = req.user!.role as UserRole;
  return can(role, "FOOD_SETTINGS", "view") || can(role, "FOOD_ORG", "view");
}

/* ── HIGH: per-entity authority over the kitchen & brand masters ────────────
 *
 * `kitchens` and `food_brands` are ORG-WIDE masters — neither carries a scope
 * column — yet their writes were gated on FOOD_SETTINGS alone. FOOD_SETTINGS is
 * held FULL (the VE alias IS full access) by FNB_MANAGER, whose live accounts
 * are kitchen-scoped 11 times out of 12. So one kitchen's manager could create,
 * rename, re-point or soft-delete ANY kitchen or brand in the organisation, and
 * `PUT /brands/:id {isActive:false}` was a network-wide config disable.
 *
 * Resolved per entity rather than with a blanket org-wide gate:
 *
 *   • EDIT a kitchen — still open to FOOD_SETTINGS holders, but only on a
 *     kitchen the caller is actually scoped to (deniedKitchenWrite below), and
 *     only for its OWN attributes. That is the capability a kitchen-scoped
 *     manager legitimately has, and it is kept.
 *   • CREATE / DELETE a kitchen, and every brand write — moved to FOOD_ORG, the
 *     module that already owns the org spine (see the FOOD_ORG block in
 *     permissions.ts: zones, cities, clusters, agencies and the scope grants).
 *     A kitchen is a node in that spine and a brand has no narrowing dimension
 *     at all, so "which kitchens exist" is the same class of decision.
 *
 * No reachable capability is removed: the ONLY caller of these six endpoints is
 * the Organization page, which is nav- AND page-gated on FOOD_ORG
 * (uniliv-admin/src/lib/permissions.ts moduleForPath + layout.tsx). FNB_MANAGER
 * has no FOOD_ORG cell, so it could never reach them through the product —
 * FOOD_SETTINGS was an API-only back door into a page that role cannot open.
 * (DELETE /kitchens has no UI caller at all.)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Kitchen columns only an ORG-WIDE caller may write.
 *
 * `isActive` is the network-wide enable/disable — soft-deleting a kitchen takes
 * out every property it serves. `cityId`/`clusterId` are the org spine that
 * resolveAccessibleKitchenIds and resolveAccessiblePropertyIds walk, so
 * re-pointing one silently changes who can reach which kitchens and orders.
 * Everything else (name, code, brand, address, contact) describes the kitchen
 * itself and stays with the manager who runs it.
 */
const ORG_SPINE_KITCHEN_FIELDS = ["isActive", "cityId", "clusterId"] as const;

/**
 * Per-entity guard for a kitchen-master write. Returns true when the request was
 * refused, having already written the 403 — mirrors food.ts's `deniedKitchen`,
 * which answers inline because assertKitchenAccess throws and these handlers'
 * catch would turn the throw into a 500.
 */
async function deniedKitchenWrite(req: any, res: any, kitchenId: string, body: Record<string, unknown>): Promise<boolean> {
  const allowed = await resolveAccessibleKitchenIds(req.user!);
  if (allowed === null) return false; // org-wide caller: unrestricted
  if (!allowed.includes(kitchenId)) {
    res.status(403).json({ success: false, error: "Outside your kitchen scope" });
    return true;
  }
  const spine = ORG_SPINE_KITCHEN_FIELDS.filter((k) => body[k] !== undefined);
  if (spine.length) {
    res.status(403).json({
      success: false,
      error: `${spine.join(", ")} ${spine.length > 1 ? "change" : "changes"} what the whole organisation sees — only an org-wide administrator can set ${spine.length > 1 ? "them" : "it"}`,
    });
    return true;
  }
  return false;
}

foodOpsRouter.get("/kitchens", authenticate, authorizeAny([...KITCHEN_MASTER_READERS], "view"), async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const conds = [] as any[];
    if (active !== undefined) conds.push(eq(kitchensTable.isActive, active === "true"));
    const rows = await db.select().from(kitchensTable).where(conds.length ? and(...conds) : undefined).orderBy(kitchensTable.name);
    // H8: the gate above admits five modules because five pages need the PICKER
    // (id/name/code/brand/geography). Only the two that ADMINISTER kitchens need
    // the named contact's phone and email, so everyone else gets the row without
    // them — the least-privilege half of the fix the gate alone doesn't give.
    const data = mayReadKitchenContacts(req) ? rows : rows.map(({ contactName, contactPhone, contactEmail, ...rest }) => rest);
    res.json({ success: true, data });
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

// HIGH: creating a kitchen adds a node to the org spine (and a new pincode
// catchment) — FOOD_ORG, like every other spine write. See the block above.
foodOpsRouter.post("/kitchens", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_kitchen", row!.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    // Same invariant as POST /brands: kitchens.code is unique and operator-typed,
    // so a collision is caller input and answers 409, not a generic 500.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "Kitchen code already exists" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
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

// HIGH: any-of so an org-wide FOOD_ORG administrator and a kitchen-scoped
// FOOD_SETTINGS manager both reach it — the narrowing is PER ENTITY, inside.
foodOpsRouter.put("/kitchens/:id", authenticate, authorizeAny(["FOOD_ORG", "FOOD_SETTINGS"], "edit"), async (req, res) => {
  try {
    if (!validateBody(updateKitchenSchema, req, res)) return;
    const b = req.body || {};
    // HIGH: a kitchen-restricted caller may edit ONLY a kitchen they are scoped
    // to, and only its own attributes — never the org-spine/activation columns.
    if (await deniedKitchenWrite(req, res, req.params["id"]!, b)) return;
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "code", "brand", "address", "city", "state", "pincode", "contactName", "contactPhone", "contactEmail", "cityId", "clusterId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    // M17: a kitchen's cityId/clusterId are the org spine scope resolution walks,
    // so an edit here silently changes who can see which properties' orders.
    const [before] = await db.select().from(kitchensTable).where(eq(kitchensTable.id, req.params["id"]!));
    const [row] = await db.update(kitchensTable).set(u as never).where(eq(kitchensTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_kitchen", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) {
    // `code` is editable here, so this PUT can collide exactly like the POST.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "Kitchen code already exists" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// HIGH: soft-deleting a kitchen takes out every property it serves — an org-wide
// act, so FOOD_ORG like the create above. See the block above.
foodOpsRouter.delete("/kitchens/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    // LOW: record the row that was ACTUALLY there, not a synthetic
    // `{ isActive: true }`. Every other delete in this file reads its prior row,
    // and the fabricated one asserted a state that may never have existed (a
    // second delete of an already-inactive kitchen logged before:true) — an
    // audit trail that invents its own evidence is worse than none.
    const [before] = await db.select().from(kitchensTable).where(eq(kitchensTable.id, req.params["id"]!));
    const [row] = await db.update(kitchensTable).set({ isActive: false, updatedAt: new Date() }).where(eq(kitchensTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_kitchen", row.id, { before, after: row });
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
 * and block submission. Any-of: the property form (PROPERTIES) is the caller, the
 * food config screens are the other legitimate reader.
 */
foodOpsRouter.get("/kitchen-by-pincode", authenticate, authorizeAny(["PROPERTIES", "FOOD_SETTINGS", "FOOD_ORG"], "view"), async (req, res) => {
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

// H4: same reader set as the kitchen master — the brand list seeds the org tree,
// the property form and every food config screen.
foodOpsRouter.get("/brands", authenticate, authorizeAny([...KITCHEN_MASTER_READERS], "view"), async (req, res) => {
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

// HIGH: food_brands has NO scope dimension — every row is network-wide, so there
// is nothing to narrow and org-wide authority is the only honest gate (the same
// call deniedGlobalConfig makes for the singleton settings). FOOD_ORG, which is
// also the module gating the only screen that calls this. See the block above.
foodOpsRouter.post("/brands", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createBrandSchema, req, res)) return;
    const b = req.body || {};
    if (!b.code || !b.name) { res.status(400).json({ success: false, error: "code and name required" }); return; }
    const code = String(b.code).trim().toUpperCase().replace(/\s+/g, "_");
    const [row] = await db.insert(foodBrandsTable).values({ id: newId(), code, name: b.name, isActive: b.isActive !== false, updatedAt: new Date() }).returning();
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_brand", row!.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    // INVARIANT: a duplicate the DB rejected answers 409 naming the collision,
    // never a 500. This site tested err.message for the word "unique", which can
    // NEVER fire — drizzle rewrites the message to "Failed query: …" and the pg
    // detail (code/constraint) survives only on err.cause, exactly as the note on
    // runWithSeqRetry above records. So every duplicate brand code answered
    // "Internal server error". isUniqueViolation reads the cause chain.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "Brand code already exists" }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

const updateBrandSchema = z.object({
  name: zText.optional(),
  isActive: z.boolean().optional(),
}).passthrough();

// HIGH: `isActive:false` here is a NETWORK-WIDE config disable — it takes the
// brand off every property's ordering screen at once. Org-wide only (FOOD_ORG).
foodOpsRouter.put("/brands/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateBrandSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.name !== undefined) u["name"] = b.name;
    if (b.isActive !== undefined) u["isActive"] = !!b.isActive;
    const [before] = await db.select().from(foodBrandsTable).where(eq(foodBrandsTable.id, req.params["id"]!));
    const [row] = await db.update(foodBrandsTable).set(u as never).where(eq(foodBrandsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_brand", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// HIGH: same network-wide reach as the PUT above — org-wide only (FOOD_ORG).
foodOpsRouter.delete("/brands/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    // LOW: the REAL prior row, not a synthetic `{ isActive: true }` — see the
    // matching note on DELETE /kitchens/:id.
    const [before] = await db.select().from(foodBrandsTable).where(eq(foodBrandsTable.id, req.params["id"]!));
    const [row] = await db.update(foodBrandsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(foodBrandsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_brand", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Full org tree: City → Kitchen → Property (with brand + active-guest counts). */
foodOpsRouter.get("/hierarchy", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    // H8: FOOD_DASHBOARD:view is held by property-bound roles too, so the tree is
    // scoped — it used to hand every caller the entire property master. It is
    // also a STRUCTURAL view: the kitchens carry no contact name/phone/email
    // here, which nothing in a tree needs and which /kitchens now guards.
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const cities = await db.select().from(citiesTable).orderBy(citiesTable.name);
    const kitchenRows = await db.select().from(kitchensTable).orderBy(kitchensTable.name);
    const kitchens = kitchenRows.map(({ contactName, contactPhone, contactEmail, ...rest }) => rest);
    const propScope = ids === null ? undefined : (ids.length ? inArray(propertiesTable.id, ids) : sql`false`);
    const props = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, brand: propertiesTable.brand,
      kitchenId: propertiesTable.kitchenId, city: propertiesTable.city, totalBeds: propertiesTable.totalBeds,
      active: sql<number>`(select count(*)::int from ${residentsTable} where ${residentsTable.propertyId}=${propertiesTable.id} and ${residentsTable.status}='ACTIVE')`,
    }).from(propertiesTable).where(propScope).orderBy(propertiesTable.name);

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
      // A scoped caller sees only the branches their properties hang off; an
      // org-wide caller keeps the full tree, empty branches included.
      if (ids !== null && !node.properties.length) continue;
      if (!k.cityId) { kitchensNoCity.push(node); continue; }
      const arr = kitchensByCity.get(k.cityId) ?? [];
      arr.push(node); kitchensByCity.set(k.cityId, arr);
    }
    const tree = cities
      .map((c) => ({ ...c, kitchens: kitchensByCity.get(c.id) ?? [] }))
      .filter((c) => ids === null || c.kitchens.length);
    res.json({ success: true, data: { cities: tree, kitchensNoCity, propertiesNoKitchen } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C5 — property → brand / kitchen assignment.
 *
 * These two writes are the ROOT of food scope: resolveAccessiblePropertyIds
 * expands a kitchen grant through properties.kitchenId, so re-pointing a
 * property is a scope-WIDENING act, not an ordinary settings edit. Both sides
 * are therefore checked — the property being moved must already be reachable,
 * and the kitchen it is moved to must be one the caller owns — otherwise a
 * single kitchen's manager can pull any property in the org under themselves and
 * read its orders on the very next request. Clearing the assignment is refused
 * for a restricted caller for the mirror reason: a property with no kitchen
 * resolves an empty menu and cannot order at all.
 * ────────────────────────────────────────────────────────────────────────── */

/** Loads the target property and 403s a caller who cannot already reach it. */
async function loadAssignableProperty(req: any, res: any): Promise<typeof propertiesTable.$inferSelect | null> {
  const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
  if (!prop) { res.status(404).json({ success: false, error: "Not found" }); return null; }
  const ids = await resolveAccessiblePropertyIds(req.user!);
  if (!isAccessible(prop.id, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return null; }
  return prop;
}

const assignBrandSchema = z.object({ brand: z.union([z.string().max(128), z.null()]).optional() });

foodOpsRouter.post("/properties/:id/assign-brand", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignBrandSchema, req, res)) return;
    const prop = await loadAssignableProperty(req, res);
    if (!prop) return;
    const brand = req.body?.brand ? String(req.body.brand) : null;
    // The column is plain nullable text with FK enforcement deferred to this
    // layer (schema/core.ts), so an unknown brand would be accepted silently and
    // leave the property with a (kitchen, brand) pair that has no rotation rows.
    if (brand && !(await isActiveBrand(brand))) {
      res.status(422).json({ success: false, error: "Unknown or inactive brand" }); return;
    }
    await db.update(propertiesTable).set({ brand, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
    // M17: only the column this endpoint owns — the entry has to read as "who
    // re-branded this property, and from what". Its twin assign-cluster (food.ts)
    // is instrumented the same way; all three assignment writes now agree.
    auditConfig(req, "FOOD_CONFIG_UPDATED", "property_brand", prop.id, { before: { brand: prop.brand }, after: { brand } });
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const assignKitchenSchema = z.object({ kitchenId: z.union([z.string().max(128), z.null()]).optional() });

foodOpsRouter.post("/properties/:id/assign-kitchen", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignKitchenSchema, req, res)) return;
    const prop = await loadAssignableProperty(req, res);
    if (!prop) return;
    const kitchenId = req.body?.kitchenId ? String(req.body.kitchenId) : null;
    if (kitchenId) {
      const [row] = await db.select({ id: kitchensTable.id }).from(kitchensTable)
        .where(and(eq(kitchensTable.id, kitchenId), eq(kitchensTable.isActive, true))).limit(1);
      if (!row) { res.status(422).json({ success: false, error: "Unknown or inactive kitchen" }); return; }
    }
    // The kitchen SIDE of the guard: a restricted caller may only move a property
    // between kitchens they already own, and may never strand it with none.
    const allowedKitchens = await resolveAccessibleKitchenIds(req.user!);
    if (allowedKitchens !== null) {
      if (!kitchenId) { res.status(403).json({ success: false, error: "Pick one of your kitchens — a property cannot be left without one" }); return; }
      if (!allowedKitchens.includes(kitchenId)) { res.status(403).json({ success: false, error: "Outside your kitchen scope" }); return; }
    }
    await db.update(propertiesTable).set({ kitchenId, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!));
    // M17: this is the scope-WIDENING write the block comment above describes —
    // re-pointing a property moves it between grantees, so it is exactly the
    // mutation an audit trail exists for.
    auditConfig(req, "FOOD_CONFIG_UPDATED", "property_kitchen", prop.id, { before: { kitchenId: prop.kitchenId }, after: { kitchenId } });
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
    // Conditional write (M1), matching the cancel path in food.ts. The status
    // check above ran against a row read in a separate statement, so a cancel
    // can commit between the two — and a blind UPDATE then puts the order back
    // to ACCEPTED while cancelledAt, cancelReason and the CANCELLED event stay
    // on it: a live order the lead was told was cancelled, cooked and dispatched.
    // Pinning the UPDATE to PLACED makes the transition atomic, and the prepared
    // backfill plus the event join it so a lost race leaves nothing behind.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(foodOrdersTable)
        .set({ status: "ACCEPTED", acceptedAt: now, acceptedById: req.user!.id, updatedAt: now })
        .where(and(eq(foodOrdersTable.id, order.id), eq(foodOrdersTable.status, "PLACED")))
        .returning();
      if (!row) throw new HandlerError(422, "Only PLACED orders can be accepted");
      // Backfill prepared quantities at accept time (moved here from the removed
      // /prepare step) so the dispatch board's editable send-quantities have a
      // starting value. Only fills rows not already set.
      await tx.update(foodOrderItemsTable)
        .set({ preparedQty: sql`${foodOrderItemsTable.orderedQty}`, updatedAt: now })
        .where(and(eq(foodOrderItemsTable.orderId, order.id), isNull(foodOrderItemsTable.preparedQty)));
      await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: order.id, status: "ACCEPTED", note: "Order accepted by kitchen", actorId: req.user!.id });
      return row;
    });
    await notifyForOrder(order, "ACCEPTED");
    res.json({ success: true, data: updated });
  } catch (err) {
    if (sendHandlerError(res, err)) return;
    req.log.error(mutationLog(req, err, { orderId: req.params["id"] }), "order accept failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

const rejectOrderSchema = z.object({ reason: zText.nullish() }).passthrough();

foodOpsRouter.post("/orders/:id/reject", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    if (!validateBody(rejectOrderSchema, req, res)) return;
    const order = await loadOrderForActor(req, res); if (!order) return;
    if (order.status !== "PLACED" && order.status !== "ACCEPTED") { res.status(422).json({ success: false, error: "Only PLACED/ACCEPTED orders can be rejected" }); return; }
    const reason = req.body?.reason ?? null;
    const now = new Date();
    // Conditional write (M1), same reasoning as accept above — and one hop worse
    // here: a dispatch committing between the read and a blind UPDATE left food
    // on a van with dispatchId set and the order marked REJECTED.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(foodOrdersTable)
        .set({ status: "REJECTED", rejectedAt: now, rejectionReason: reason, updatedAt: now })
        .where(and(eq(foodOrdersTable.id, order.id), inArray(foodOrdersTable.status, ["PLACED", "ACCEPTED"])))
        .returning();
      if (!row) throw new HandlerError(422, "Only PLACED/ACCEPTED orders can be rejected");
      await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: order.id, status: "REJECTED", note: reason ? `Rejected: ${reason}` : "Order rejected", actorId: req.user!.id });
      return row;
    });
    await notifyForOrder(order, "REJECTED", { reason });
    res.json({ success: true, data: updated });
  } catch (err) {
    if (sendHandlerError(res, err)) return;
    req.log.error(mutationLog(req, err, { orderId: req.params["id"] }), "order reject failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ════════════════════════════════════════════════════════════════════════
 * Dispatch trips (Persona st.24)
 *
 * ── LOCK ORDERING CONTRACT (read before adding any dispatch write) ──────
 *
 * INVARIANT: a transaction that locks BOTH a dispatch row and its order rows
 * takes them in this order, ALWAYS:
 *
 *      1. the food_dispatches row   (SELECT … FOR UPDATE on the trip id)
 *      2. its food_orders rows      (FOR UPDATE, ascending id when >1)
 *
 * Parent before children, children in id order. An UPDATE takes the same row
 * lock a `FOR UPDATE` does, so "locks" below means either.
 *
 * Why it is a contract and not a preference: B1 added the trip lock to
 * POST /dispatches/:id/cancel (trip → orders) while
 * PATCH /dispatches/:id/orders/:orderId already took the opposite order
 * (order → trip, via advanceDispatch). Two writers on the same trip then
 * deadlocked — Postgres kills one with 40P01 and the handler answers 500.
 *
 * Handlers that take BOTH locks, and the order they take them in:
 *   • POST   /dispatches/:id/cancel            trip → orders   ✓
 *   • PATCH  /dispatches/:id/status            trip → orders   ✓ (advanceDispatch
 *                                              runs before the linked-order loop)
 *   • PATCH  /dispatches/:id/orders/:orderId   trip → order    ✓ (the trip is
 *                                              locked up-front for this reason;
 *                                              it USED to lock the order first)
 *
 * Handlers that take only ONE side, and so cannot form a cycle:
 *   • reconcileDispatchForOrder — trip only; its order read is unlocked, and it
 *     runs AFTER the caller's transaction has committed (never nested).
 *   • createDispatchForOrders — orders only; the dispatch row it locks is one it
 *     INSERTed in the same transaction, so no other transaction can be holding
 *     or waiting on it. Its callers (POST /dispatches, food.ts dispatch/bulk
 *     dispatch) add no pre-existing trip lock.
 * ════════════════════════════════════════════════════════════════════════ */

/** A dispatch is accessible if at least one of its orders is in the caller's scope. */
async function isDispatchAccessible(dispatchId: string, ids: string[] | null): Promise<boolean> {
  if (ids === null) return true;
  if (!ids.length) return false;
  const orders = await db.select({ propertyId: foodOrdersTable.propertyId }).from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, dispatchId));
  return orders.some((o) => isAccessible(o.propertyId, ids));
}

/**
 * M22 — the trip-level check above is a REACHABILITY test, never a licence over
 * every stop on the trip: it passes as soon as ONE order is in scope. So each
 * order a request actually reads or writes takes its own property check, through
 * this condition (reads) or isAccessible (writes). Trips are single-kitchen by
 * construction today, which bounds the exposure; it stops being bounded the
 * moment anyone holds a PROPERTY-level grant on one property of a shared trip.
 */
function scopedOrdersOnDispatch(dispatchId: string, ids: string[] | null) {
  const onTrip = eq(foodOrdersTable.dispatchId, dispatchId);
  if (ids === null) return onTrip;
  return and(onTrip, ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
}

/**
 * A 4xx a handler wants to raise from INSIDE a db.transaction — the throw rolls
 * the transaction back, and the handler's own catch turns it into a real status
 * instead of the catch-all 500. Mirrors the { statusCode } convention the
 * app-level error handler honours for the service layer.
 */
class HandlerError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** Answer `err` when it is a HandlerError; false when it belongs to the catch-all. */
function sendHandlerError(res: any, err: unknown): boolean {
  if (err instanceof HandlerError) { res.status(err.statusCode).json({ success: false, error: err.message }); return true; }
  return false;
}

/**
 * M2 — the declared hops from `from` to `to`, or null when there are none.
 *
 * Trips are created LOADING (createDispatchForOrders) and the board finalises
 * them from the order list, so "every stop done" on a van whose departure was
 * never ticked is a legitimate LOADING → DELIVERED request. The single-hop check
 * dropped it silently — no transition, no event, no error — and the vehicle-busy
 * filter then held that van on a trip that could never complete. The intermediate
 * hops are walked explicitly (and each one audited) instead, so the timeline
 * still records IN_TRANSIT and a genuinely impossible request 422s.
 */
function dispatchPath(from: string, to: string): string[] | null {
  if (from === to) return [];
  const seen = new Set<string>([from]);
  const queue: Array<{ status: string; path: string[] }> = [{ status: from, path: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of DISPATCH_TRANSITIONS[cur.status] ?? []) {
      if (seen.has(next)) continue;
      const path = [...cur.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

/** tx-aware variant of nextSeq so the dispatch number is allocated inside the same transaction. */
async function nextSeqTx(tx: DbLike, prefix: string, column: any, table: any): Promise<string> {
  const [row] = await tx.select({ m: sql<string | null>`max(${column})` }).from(table).where(sql`${column} like ${prefix + "%"}`);
  const last = row?.m ? parseInt(String(row.m).slice(prefix.length), 10) : 0;
  return prefix + String((Number.isFinite(last) ? last : 0) + 1).padStart(6, "0");
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
 * M2 — pull a trip's status back into line with the orders on it.
 *
 * The trip and the order state machines are separate, and the CANONICAL receive
 * path — the unit lead confirming their own stop (POST /orders/:id/confirm-delivery,
 * and since C3 the only path an FNB dispatcher's "delivered" can take) — moves
 * only the order. With no reconciler the trip sat at LOADING/IN_TRANSIT forever,
 * `GET /dispatches/active-vehicles` kept reporting its van busy, and every later
 * trip booking that van 422'd. Same rules as the per-order toggle's inline
 * finalise below (terminal DELIVERED is never walked back to PARTIAL, cancelled
 * and rejected orders do not count) — that one stays inline because it also
 * returns the moved trip row in its response.
 *
 * Deliberately best-effort and OUTSIDE the caller's transaction: the delivery is
 * already recorded and correct, so a losable race on the trip row (409 from
 * advanceDispatch) must not roll it back. Never throws.
 */
export async function reconcileDispatchForOrder(dispatchId: string, actorId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [trip] = await tx.select().from(foodDispatchesTable)
        .where(eq(foodDispatchesTable.id, dispatchId)).for("update");
      // A trip already finalised DELIVERED is terminal, and a cancelled one is
      // not reconciled at all — same rule as the per-order toggle.
      if (!trip || trip.status === "DELIVERED" || trip.status === "CANCELLED") return;
      const linked = await tx.select({ status: foodOrdersTable.status }).from(foodOrdersTable)
        .where(eq(foodOrdersTable.dispatchId, dispatchId));
      const active = linked.filter((o) => o.status !== "CANCELLED" && o.status !== "REJECTED");
      if (!active.length) return;
      const delivered = active.filter((o) => o.status === "DELIVERED").length;
      if (!delivered) return;
      const allDelivered = delivered === active.length;
      const target = allDelivered ? "DELIVERED" : "PARTIAL";
      if (target === trip.status) return;
      await advanceDispatch(tx, dispatchId, trip.status, target,
        allDelivered ? "All orders delivered" : `Partial delivery (${delivered}/${active.length} delivered)`, actorId);
    });
  } catch (err) {
    logger.warn({ err, dispatchId }, "dispatch reconcile after delivery failed");
  }
}

/**
 * M2 — move a trip to `target` along the declared hops, writing one audit event
 * per hop. Returns the trip row after the last hop (or null when `target` is the
 * status it is already in, i.e. nothing to do). Throws 422 when the state machine
 * has no route — the case that used to be a silent no-op.
 */
async function advanceDispatch(
  tx: DbLike,
  dispatchId: string,
  from: string,
  target: string,
  note: string | null,
  actorId: string,
): Promise<typeof foodDispatchesTable.$inferSelect | null> {
  const path = dispatchPath(from, target);
  if (path === null) throw new HandlerError(422, `Cannot move from ${from} to ${target}`);
  const now = new Date();
  let current = from;
  let row: typeof foodDispatchesTable.$inferSelect | null = null;
  for (const next of path) {
    const [moved] = await tx.update(foodDispatchesTable).set({ status: next as never, updatedAt: now })
      .where(and(eq(foodDispatchesTable.id, dispatchId), eq(foodDispatchesTable.status, current as never))).returning();
    // The status predicate makes each hop conditional on the state it was
    // planned from, so a concurrent transition loses instead of being overwritten.
    if (!moved) throw new HandlerError(409, "This dispatch changed while you were working on it — reload and try again");
    await writeDispatchEvent(tx, dispatchId, next, next === target ? note : `Auto ${current} → ${next}`, actorId);
    current = next;
    row = moved;
  }
  return row;
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
  // Defense-in-depth: callers already guard, but this helper is the single point
  // that flips orders to DISPATCHED — refuse anything that isn't ACCEPTED so no
  // future caller can bypass PLACED→ACCEPTED→DISPATCHED.
  //
  // M3: the re-check is taken UNDER A ROW LOCK. Without it the check is a plain
  // read and two dispatchers racing the same order both saw ACCEPTED, both wrote
  // DISPATCHED, and the second trip's dispatchId won — leaving the first trip
  // holding its vehicle on a manifest whose orders had moved on.
  // Locked in id order so two trips whose selections overlap queue up instead of
  // grabbing each other's rows in opposite orders.
  const statusRows = await tx.select({ id: foodOrdersTable.id, status: foodOrdersTable.status })
    .from(foodOrdersTable).where(inArray(foodOrdersTable.id, opts.orderIds)).orderBy(foodOrdersTable.id).for("update");
  if (statusRows.some((r) => !canTransition(r.status, "DISPATCHED"))) {
    throw new HandlerError(422, "Cannot dispatch — every order must be ACCEPTED");
  }
  // L12: an agency may only carry food out of a kitchen it is contracted to serve.
  // POST /dispatches enforced this; quick-dispatch and bulk-dispatch (food.ts) call
  // straight in here and did not, so the same trip was legal or not depending on
  // which button made it. The invariant belongs to the helper that writes the link,
  // for the same reason the ACCEPTED re-check above does.
  if (opts.agencyId && opts.kitchenId) {
    const [link] = await tx.select({ id: agencyKitchensTable.id }).from(agencyKitchensTable)
      .where(and(eq(agencyKitchensTable.agencyId, opts.agencyId), eq(agencyKitchensTable.kitchenId, opts.kitchenId), eq(agencyKitchensTable.isActive, true)))
      .limit(1);
    if (!link) throw new HandlerError(422, "Agency does not serve this kitchen");
  }
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
    // M3: conditional on the status the plan above was made from. The lock makes
    // this unreachable in practice; it is the guarantee that the row this trip
    // claims is the row it validated, not whatever it became in between.
    const moved = await tx.update(foodOrdersTable).set({
      status: "DISPATCHED", dispatchId: trip!.id,
      ...(opts.kitchenId ? { kitchenId: opts.kitchenId } : {}),
      deliveryPartnerId: opts.agencyId ?? null, vehicleId: opts.vehicleId ?? null,
      dispatchedById: opts.actorId, dispatchedAt: now, dispatchStartedAt: now, updatedAt: now,
    }).where(and(eq(foodOrdersTable.id, orderId), eq(foodOrdersTable.status, "ACCEPTED"))).returning({ id: foodOrdersTable.id });
    if (!moved.length) throw new HandlerError(422, "Cannot dispatch — every order must be ACCEPTED");
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

/**
 * B2 — trip statuses that still hold their vehicle.
 *
 * PARTIAL is a RUNNING trip: the reconciler moves a trip there as soon as the
 * FIRST stop is confirmed (reconcileDispatchForOrder), so the van is still out
 * with the rest of the manifest aboard. Omitting it from the busy set dropped
 * that van off the picker and past both the fast check and the authoritative
 * in-transaction one, so it could be double-booked mid-run. One constant for all
 * three sites, because "is this vehicle free" must have exactly one answer.
 */
const ACTIVE_TRIP_STATUSES = ["LOADING", "IN_TRANSIT", "PARTIAL"] as const;

/* C6: vehicle IDs currently committed to an active dispatch (for the create form
 * to grey out busy vehicles). Declared BEFORE "/dispatches/:id" so Express does
 * not match "active-vehicles" as an :id. */
foodOpsRouter.get("/dispatches/active-vehicles", authenticate, authorize("FOOD_DISPATCH", "view"), async (req, res) => {
  try {
    const rows = await db.select({ vehicleId: foodDispatchesTable.vehicleId }).from(foodDispatchesTable)
      .where(and(isNotNull(foodDispatchesTable.vehicleId), inArray(foodDispatchesTable.status, [...ACTIVE_TRIP_STATUSES])));
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
    // M22: that payload is PII (address + unit-lead name/phone/email), so the
    // manifest is filtered to the stops the caller can actually reach — the
    // trip-level check above only proves ONE of them is theirs. Stops outside
    // their scope are counted, not shown, so the sheet never looks complete when
    // it isn't.
    const [linkedCount] = await db.select({ n: sql<number>`count(*)::int` })
      .from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id));
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
      .where(scopedOrdersOnDispatch(id, ids));
    // H8: the kitchen row is joined whole, so contactName/Phone/Email reached
    // every FOOD_DISPATCH:view holder — the exact principals GET /kitchens now
    // withholds them from, and the dispatch drawer renders them. Same projection,
    // same rule: only the modules that administer kitchens see the named contact.
    const kitchen = row.kitchen && !mayReadKitchenContacts(req)
      ? (({ contactName, contactPhone, contactEmail, ...rest }) => rest)(row.kitchen)
      : row.kitchen;
    res.json({ success: true, data: { ...row.d, kitchen, partnerName: row.partnerName, ordersOutOfScope: Math.max(0, Number(linkedCount?.n ?? 0) - orders.length), orders: orders.map((r) => ({
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
      // C6: a vehicle already out on an active trip cannot be re-used.
      // (Fast path only — the authoritative check is re-run under a lock inside
      // the transaction below; see M3 there.)
      const [busy] = await db.select({ id: foodDispatchesTable.id }).from(foodDispatchesTable)
        .where(and(eq(foodDispatchesTable.vehicleId, vehicleId), inArray(foodDispatchesTable.status, [...ACTIVE_TRIP_STATUSES])))
        .limit(1);
      if (busy) { res.status(422).json({ success: false, error: "Vehicle is already in use on an active dispatch" }); return; }
    }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    const orders = await db.select().from(foodOrdersTable).where(inArray(foodOrdersTable.id, orderIds));
    // Only ACCEPTED orders can be dispatched (ACCEPTED → DISPATCHED) — same
    // guard as every other dispatch path, so a never-accepted order can't jump
    // the queue via trip creation.
    const dispatchable = orders.filter((o) => isAccessible(o.propertyId, ids) && canTransition(o.status, "DISPATCHED"));
    if (!dispatchable.length) { res.status(422).json({ success: false, error: "No dispatchable orders in selection — orders must be ACCEPTED." }); return; }

    // C5: kitchen integrity, DERIVED from the orders (never trusted from the
    // client's kitchenId, which used to gate this whole block — an omitted
    // kitchenId then bypassed both checks). A van is one kitchen: the dispatchable
    // orders may resolve to at most one kitchen, and the agency must serve it.
    // Orders with no kitchen (kitchen-agnostic) impose no constraint.
    const orderKitchens = [...new Set(dispatchable.map((o) => o.kitchenId).filter((k): k is string => k != null))];
    if (orderKitchens.length > 1) {
      res.status(422).json({ success: false, error: "All dispatchable orders must share one kitchen" }); return;
    }
    // Effective kitchen = the orders' kitchen; fall back to the client hint only
    // when the orders carry none (so the trip still records a kitchen if given).
    const kitchenId = orderKitchens[0] ?? b.kitchenId ?? null;
    // (L12: createDispatchForOrders now re-runs this check for every caller. Kept
    // here as the fast path, so the refusal lands before the transaction opens.)
    if (kitchenId) {
      const [link] = await db.select({ id: agencyKitchensTable.id }).from(agencyKitchensTable)
        .where(and(eq(agencyKitchensTable.agencyId, agencyId), eq(agencyKitchensTable.kitchenId, kitchenId), eq(agencyKitchensTable.isActive, true)))
        .limit(1);
      if (!link) { res.status(422).json({ success: false, error: "Agency does not serve this kitchen" }); return; }
    }

    const now = new Date();
    const etaMinutes = b.etaMinutes != null ? Number(b.etaMinutes) : null;
    const estimatedArrivalAt = etaMinutes ? new Date(now.getTime() + etaMinutes * 60000) : (b.estimatedArrivalAt ? new Date(b.estimatedArrivalAt) : null);
    const departNow = !!b.departNow;

    // C3/C8: create through the shared helper so the trip starts in LOADING and
    // every order reliably carries dispatchId. notes/explicit-ETA (not covered by
    // the helper's etaMinutes path) are stamped in a follow-up update.
    let trip: typeof foodDispatchesTable.$inferSelect;
    try {
      trip = await db.transaction(async (tx) => {
        // M3: the busy check above ran outside this transaction and matches no
        // row when the van is free, so there was nothing for two concurrent
        // dispatchers to contend on — both passed, both created a trip, and the
        // loser's trip held the vehicle forever. Locking the VEHICLE row (which
        // does exist) serialises them: the second waits, then sees the trip the
        // first one created.
        if (vehicleId) {
          await tx.select({ id: agencyVehiclesTable.id }).from(agencyVehiclesTable)
            .where(eq(agencyVehiclesTable.id, vehicleId)).for("update");
          const [taken] = await tx.select({ id: foodDispatchesTable.id }).from(foodDispatchesTable)
            .where(and(eq(foodDispatchesTable.vehicleId, vehicleId), inArray(foodDispatchesTable.status, [...ACTIVE_TRIP_STATUSES])))
            .limit(1);
          if (taken) throw new HandlerError(422, "Vehicle is already in use on an active dispatch");
        }
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
    } catch (err) {
      if (sendHandlerError(res, err)) return;
      throw err;
    }

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
      // M1/B1: same rule as every other dispatch write — conditional on the status
      // this hop was planned from. The trip was created LOADING inside the
      // transaction above, but this write lands after the commit, so a cancel (or
      // a reconcile) racing it must win instead of being overwritten with
      // IN_TRANSIT. Zero rows = someone else moved it; the response reports the
      // trip as created and unmoved rather than lying about the departure.
      const [moved] = await db.update(foodDispatchesTable).set({ status: "IN_TRANSIT", updatedAt: new Date() })
        .where(and(eq(foodDispatchesTable.id, trip.id), eq(foodDispatchesTable.status, "LOADING"))).returning();
      if (moved) {
        await writeDispatchEvent(db, trip.id, "IN_TRANSIT", "Departed (LOADING → IN_TRANSIT)", req.user!.id);
        finalTrip = moved;
      }
    }

    res.status(201).json({ success: true, data: { ...finalTrip, dispatchedCount: dispatchable.length } });
  } catch (err) {
    req.log.error(mutationLog(req, err, { orderIds: req.body?.orderIds ?? null, agencyId: req.body?.agencyId ?? req.body?.deliveryPartnerId ?? null }), "dispatch create failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C3 — separation of duties on the dispatch → delivery boundary.
 *
 * The party that SHIPS must never be the party that CERTIFIES RECEIPT. The
 * matrix encodes it (FNB_* hold FOOD_DISPATCH:V·E with FOOD_CONFIRM_DELIVERY
 * VIEW), and the dispatch writes below now honour it: a dispatch-side caller may
 * advance the TRIP as far as it goes, but may only carry its ORDERS to DELIVERED
 * when they ALSO hold FOOD_CONFIRM_DELIVERY:edit. Otherwise the trip completes
 * and its orders stay DISPATCHED, waiting for the unit lead's confirm-delivery —
 * the only path that writes receivedQty and raises the variance complaint.
 *
 * Never inferred: receivedQty stays NULL on a trip-delivered order. "Delivered by
 * trip, count not yet taken" is a real and different state from "counted", and
 * /reports/variance reads the NULL rather than treating it as a total loss.
 * ────────────────────────────────────────────────────────────────────────── */

/** May this caller move an ORDER to DELIVERED? (Trip transitions are not gated by this.) */
function canConfirmDelivery(req: any): boolean {
  return can(req.user!.role as UserRole, "FOOD_CONFIRM_DELIVERY", "edit");
}

// status is left a bounded string (not enum) so the handler's own "Invalid status"
// message is preserved for unknown values.
const dispatchStatusSchema = z.object({ status: z.string().max(32), note: zText.nullish() }).passthrough();

foodOpsRouter.patch("/dispatches/:id/status", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(dispatchStatusSchema, req, res)) return;
    const target = req.body?.status as string;
    const note = (req.body?.note as string | null | undefined) ?? null;
    if (!Object.prototype.hasOwnProperty.call(DISPATCH_TRANSITIONS, target)) { res.status(400).json({ success: false, error: "Invalid status" }); return; }
    // L3: cancelling has to go through POST /dispatches/:id/cancel, which is the
    // only path that returns the trip's undelivered orders to the kitchen. Set
    // here it would strand them DISPATCHED against a CANCELLED trip. (The board
    // already routes its Cancel button there; this closes the API-level bypass,
    // which the multi-hop walk below would otherwise have made a single call.)
    if (target === "CANCELLED") {
      res.status(422).json({ success: false, error: "Use the cancel action — cancelling a trip must release its orders" }); return;
    }
    const id = req.params["id"]!;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!(await isDispatchAccessible(id, ids))) { res.status(403).json({ success: false, error: "Dispatch not accessible" }); return; }
    const [current] = await db.select().from(foodDispatchesTable).where(eq(foodDispatchesTable.id, id));
    if (!current) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const now = new Date();
    // C3: the trip may always complete; carrying its ORDERS to DELIVERED is a
    // receipt certification and needs the confirm-delivery grant on top of the
    // dispatch grant this route is mounted behind.
    const mayCertify = canConfirmDelivery(req);
    let result: { updated: typeof foodDispatchesTable.$inferSelect | null; delivered: typeof foodOrdersTable.$inferSelect[]; awaitingConfirmation: number; outOfScope: number };
    try {
      result = await db.transaction(async (tx) => {
        // C2: enforce the state machine — every hop is a declared one and every
        // hop is audited. M2: advanceDispatch WALKS the declared route rather
        // than demanding a single hop, so finalising a trip that was never ticked
        // out of LOADING works instead of failing, and a route that genuinely
        // does not exist raises 422 (not a silent no-op).
        const moved = await advanceDispatch(tx, id, current.status, target, note ?? `Status ${current.status} → ${target}`, req.user!.id);
        const updated = moved ?? current;
        // C2: reaching DELIVERED flips the linked (still-active) orders to DELIVERED
        // so the trip and its orders stay in sync — but only for a caller entitled
        // to certify receipt (C3).
        const delivered: typeof foodOrdersTable.$inferSelect[] = [];
        let awaitingConfirmation = 0;
        let outOfScope = 0;
        if (target === "DELIVERED" && current.status !== "DELIVERED") {
          // Only DISPATCHED orders can flip to DELIVERED, and doing so opens the
          // waste-logging window (same as unit-lead confirm) so leftovers can be
          // recorded on trip-delivered orders too.
          const wasteWindowMs = await getWasteEditWindowMs();
          // LOCK ORDERING CONTRACT: advanceDispatch above already took the trip
          // row; the per-order UPDATEs below take their row locks in the order
          // this read returns, so it is pinned ascending by id like every other
          // multi-order lock in this section.
          const linked = await tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id)).orderBy(foodOrdersTable.id);
          for (const o of linked) {
            if (!canTransition(o.status, "DELIVERED")) continue;
            // M22: certifying receipt for a property outside the caller's scope is
            // a write they could not make one at a time; the trip-level check does
            // not authorise it either.
            if (!isAccessible(o.propertyId, ids)) { outOfScope++; continue; }
            if (!mayCertify) { awaitingConfirmation++; continue; }
            const [row] = await tx.update(foodOrdersTable).set({ status: "DELIVERED", deliveredAt: o.deliveredAt ?? now, wasteEditableUntil: o.wasteEditableUntil ?? new Date(now.getTime() + wasteWindowMs), confirmedById: o.confirmedById ?? req.user!.id, updatedAt: now }).where(and(eq(foodOrdersTable.id, o.id), eq(foodOrdersTable.status, o.status))).returning();
            if (!row) continue; // raced by another actor — leave it to whoever won
            await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "DELIVERED", note: `Delivered with dispatch ${current.dispatchNumber}`, actorId: req.user!.id });
            delivered.push(row);
          }
          if (awaitingConfirmation) {
            await writeDispatchEvent(tx, id, target, `${awaitingConfirmation} order(s) left DISPATCHED — awaiting delivery confirmation by the receiving property`, req.user!.id);
          }
          if (outOfScope) {
            await writeDispatchEvent(tx, id, target, `${outOfScope} order(s) left DISPATCHED — outside the actor's property scope`, req.user!.id);
          }
        }
        return { updated, delivered, awaitingConfirmation, outOfScope };
      });
    } catch (err) {
      if (sendHandlerError(res, err)) return;
      throw err;
    }
    // M19: the unit lead was told when the food left; they must also be told when
    // it arrived — this path delivers orders without ever going through
    // confirm-delivery, which is where the DELIVERED notification used to live.
    // Best-effort and outside the transaction, like every other notify here.
    for (const o of result.delivered) {
      try {
        await notifyForOrder(o, "DELIVERED", { wasteWindowEndsAt: o.wasteEditableUntil });
      } catch (err) { req.log.error({ err, orderId: o.id }, "dispatch-delivered notify failed"); }
    }
    res.json({ success: true, data: { ...result.updated, ordersDelivered: result.delivered.length, ordersAwaitingConfirmation: result.awaitingConfirmation, ordersOutOfScope: result.outOfScope } });
  } catch (err) {
    req.log.error(mutationLog(req, err, { dispatchId: req.params["id"], targetStatus: req.body?.status ?? null }), "dispatch status update failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C4 — Per-order delivery toggle within a trip.
 * Marks a single order DELIVERED. When finalizing the trip
 * (markTripDelivered:true): if all linked orders are delivered the trip goes
 * DELIVERED, else it goes PARTIAL (audit note records the split).
 *
 * C3: `delivered` is one-way. The revert branch used to write DISPATCHED over a
 * DELIVERED order — a hop ORDER_NEXT forbids — while leaving wasteEditableUntil,
 * confirmedById, deliveryRemarks and every receivedQty in place, so re-confirming
 * minted a second TKT- variance complaint for the same shortfall, without bound.
 * A mis-delivery is corrected by cancelling the trip, not by rewinding an order.
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
    // M22: the trip check above passes on ANY in-scope stop; this write targets
    // one specific order, so that order's own property has to be in scope too.
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status === "CANCELLED" || order.status === "REJECTED") { res.status(422).json({ success: false, error: `Cannot change a ${order.status} order` }); return; }
    // C3: DELIVERED is terminal — the revert branch is gone (see the block note above).
    if (!delivered) { res.status(422).json({ success: false, error: "A delivery cannot be reverted — cancel the dispatch instead" }); return; }
    // C3: the state machine, which this handler alone used to skip. Without it a
    // DELIVERED order could be re-delivered indefinitely.
    if (!canTransition(order.status, "DELIVERED")) { res.status(422).json({ success: false, error: `Cannot move from ${order.status} to DELIVERED` }); return; }
    // C3: marking an order received is a receipt certification, not a shipping
    // action — the dispatch grant this route is mounted behind is not enough.
    if (!canConfirmDelivery(req)) {
      res.status(403).json({ success: false, error: "Forbidden — only the receiving property can confirm delivery" }); return;
    }

    // M2: a cancelled trip is finished — its stops were sent back to the kitchen,
    // so nothing on it can be received. (dispatchPath would have no route out of
    // CANCELLED either; this is the readable error rather than the generic one.)
    // Fast fail only — re-taken under the trip row lock inside the transaction.
    if (trip.status === "CANCELLED") { res.status(422).json({ success: false, error: "This dispatch was cancelled — its orders are back with the kitchen" }); return; }

    const now = new Date();
    // Marking delivered opens the waste-logging window (parity with confirm).
    const wasteWindowMs = await getWasteEditWindowMs();
    let result: { trip: typeof foodDispatchesTable.$inferSelect; order: typeof foodOrdersTable.$inferSelect };
    try {
      result = await db.transaction(async (tx) => {
        // LOCK ORDERING CONTRACT (see the dispatch section header): the TRIP is
        // locked first, then its order. This handler used to update the order
        // first and only reach the trip row inside advanceDispatch below — the
        // exact opposite of cancel/status, so two writers on one trip deadlocked
        // (40P01 → 500). Locking here also makes the trip status this handler
        // acts on the one it validated: `trip` was read outside the transaction.
        const [lockedTrip] = await tx.select().from(foodDispatchesTable)
          .where(eq(foodDispatchesTable.id, id)).for("update");
        if (!lockedTrip) throw new HandlerError(404, "Not found");
        if (lockedTrip.status === "CANCELLED") {
          throw new HandlerError(422, "This dispatch was cancelled — its orders are back with the kitchen");
        }
        const [updatedOrder] = await tx.update(foodOrdersTable).set({ status: "DELIVERED", deliveredAt: order.deliveredAt ?? now, wasteEditableUntil: order.wasteEditableUntil ?? new Date(now.getTime() + wasteWindowMs), confirmedById: order.confirmedById ?? req.user!.id, deliveryRemarks: remarks ?? order.deliveryRemarks ?? null, updatedAt: now })
          .where(and(eq(foodOrdersTable.id, orderId), eq(foodOrdersTable.status, order.status), eq(foodOrdersTable.dispatchId, id))).returning();
        // M1/M2: conditional on the status this handler validated, so a delivery
        // racing a cancel cannot overwrite it.
        if (!updatedOrder) throw new HandlerError(409, "This order changed while you were working on it — reload and try again");
        await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId, status: "DELIVERED", note: remarks ? `Delivered: ${remarks}` : `Delivered (dispatch ${lockedTrip.dispatchNumber})`, actorId: req.user!.id });

        let tripRow = lockedTrip;
        // C4: optionally finalize the trip based on per-order delivery state.
        if (markTripDelivered) {
          const linked = await tx.select({ status: foodOrdersTable.status }).from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id));
          const active = linked.filter((o) => o.status !== "CANCELLED" && o.status !== "REJECTED");
          const allDelivered = active.length > 0 && active.every((o) => o.status === "DELIVERED");
          const tripTarget = allDelivered ? "DELIVERED" : "PARTIAL";
          // M2: trips are created LOADING, and the one-hop check here meant that
          // ticking the last stop Done on a van that never left LOADING did
          // NOTHING — no transition, no event, no error — and then held that van
          // on the busy list forever. advanceDispatch walks the declared route
          // (LOADING → IN_TRANSIT → DELIVERED), auditing each hop.
          const deliveredCount = active.filter((o) => o.status === "DELIVERED").length;
          // A trip already finalised DELIVERED is terminal — it is never walked
          // back to PARTIAL because a stop nobody was entitled to certify is
          // still open (C3 leaves exactly that state behind).
          if (tripTarget !== lockedTrip.status && lockedTrip.status !== "DELIVERED") {
            const moved = await advanceDispatch(tx, id, lockedTrip.status, tripTarget,
              allDelivered ? "All orders delivered" : `Partial delivery (${deliveredCount}/${active.length} delivered)`, req.user!.id);
            if (moved) tripRow = moved;
          }
        }
        return { trip: tripRow, order: updatedOrder };
      });
    } catch (err) {
      if (sendHandlerError(res, err)) return;
      throw err;
    }
    // M19: Persona st.22 requires the unit lead to hear about delivered, and this
    // path never went through confirm-delivery, which is where that notification
    // lives. Best-effort, outside the transaction.
    try {
      await notifyForOrder(result.order, "DELIVERED", { wasteWindowEndsAt: result.order.wasteEditableUntil });
    } catch (err) { req.log.error({ err, orderId }, "dispatch-delivered notify failed"); }
    res.json({ success: true, data: result.trip });
  } catch (err) {
    req.log.error(mutationLog(req, err, { dispatchId: req.params["id"], orderId: req.params["orderId"] }), "dispatch order delivery failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * C7 — Cancel a dispatch. Reverts its linked orders DISPATCHED → ACCEPTED
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
    // Fast fail only — the authoritative status check is re-taken under the row
    // lock inside the transaction (B1 below), because this read is not serialised
    // against anything.
    if (!(DISPATCH_TRANSITIONS[trip.status] ?? []).includes("CANCELLED")) {
      res.status(422).json({ success: false, error: `Cannot move from ${trip.status} to CANCELLED` });
      return;
    }

    const now = new Date();
    let outcome: { reverted: typeof foodOrdersTable.$inferSelect[]; keptDelivered: number; trip: typeof foodDispatchesTable.$inferSelect };
    try {
      outcome = await db.transaction(async (tx) => {
        // B1: LOCK THE TRIP and re-read its status here. The status read above is
        // outside this transaction, and the row was never locked — only the orders
        // were — so a concurrent transition left every order reverted to ACCEPTED
        // while the trip stayed IN_TRANSIT holding its vehicle. A trip with no
        // orders left is also unreachable (isDispatchAccessible needs one in-scope
        // order), so no scoped role could clear it afterwards. Locked BEFORE the
        // orders so this handler and any other trip write queue on the same row.
        const [locked] = await tx.select().from(foodDispatchesTable)
          .where(eq(foodDispatchesTable.id, id)).for("update");
        if (!locked) throw new HandlerError(404, "Not found");
        if (!(DISPATCH_TRANSITIONS[locked.status] ?? []).includes("CANCELLED")) {
          throw new HandlerError(422, `Cannot move from ${locked.status} to CANCELLED`);
        }
        // LOCK ORDERING CONTRACT: the trip is already held above; its orders are
        // locked ascending by id so this handler and createDispatchForOrders
        // (which locks the same way) can never grab two order rows in opposite
        // orders — the second half of the same deadlock the trip lock closes.
        const linked = await tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.dispatchId, id)).orderBy(foodOrdersTable.id).for("update");
        const toRevert = linked.filter((o) => o.status === "DISPATCHED");
        // M22: the trip-level check passes on ANY one in-scope stop, and this
        // handler writes to EVERY dispatched order on the trip. Cancelling is
        // all-or-nothing — the trip status is shared, and cancelling around an
        // out-of-scope stop would strand it DISPATCHED against a CANCELLED trip,
        // the exact state PATCH /status refuses to create (see L3 there). So a
        // caller who cannot reach every order it would revert cannot cancel.
        const outOfScope = toRevert.filter((o) => !isAccessible(o.propertyId, ids));
        if (outOfScope.length) {
          throw new HandlerError(403, `${outOfScope.length} order(s) on this dispatch belong to properties outside your scope — cancelling would return them to the kitchen too`);
        }
        for (const o of toRevert) {
          // L3: DISPATCHED → ACCEPTED is a COMPENSATING rollback, not a lifecycle
          // hop — ORDER_NEXT deliberately does not declare it, so canTransition
          // cannot be the guard here. The status predicate is: only an order that
          // is still out on this trip is pulled back, so a delivery landing between
          // the read above and this write is never overwritten (it used to be, and
          // it took receivedQty's basis with it).
          const [rolled] = await tx.update(foodOrdersTable).set({
            status: "ACCEPTED", dispatchId: null, dispatchedAt: null, dispatchStartedAt: null,
            deliveryPartnerId: null, vehicleId: null, updatedAt: now,
          }).where(and(eq(foodOrdersTable.id, o.id), eq(foodOrdersTable.status, "DISPATCHED"), eq(foodOrdersTable.dispatchId, id))).returning();
          if (!rolled) continue;
          await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: o.id, status: "ACCEPTED", note: reason ? `Dispatch ${trip.dispatchNumber} cancelled: ${reason}` : `Dispatch ${trip.dispatchNumber} cancelled`, actorId: req.user!.id });
        }
        // L3: orders already DELIVERED keep this trip — it IS the trip that
        // delivered them, and their partner/vehicle are history, not staleness. But
        // "cancelled" then describes only the REST of the run, so the split is
        // recorded on the timeline and returned instead of being left for a reader
        // to infer from a manifest whose count still includes them.
        const delivered = linked.filter((o) => o.status === "DELIVERED").length;
        // B1: conditional on the status read UNDER THE LOCK above, and the zero-row
        // result is acted on. Without the .returning() check a lost race committed
        // the order reverts against a trip that never became CANCELLED — orderless,
        // still holding its vehicle, and answered 200 with the wrong status.
        const [cancelled] = await tx.update(foodDispatchesTable).set({ status: "CANCELLED", updatedAt: now })
          .where(and(eq(foodDispatchesTable.id, id), eq(foodDispatchesTable.status, locked.status as never))).returning();
        if (!cancelled) throw new HandlerError(409, "This dispatch changed while you were working on it — reload and try again");
        const split = `${toRevert.length} order(s) returned to the kitchen` + (delivered ? `, ${delivered} already delivered on this trip and left as delivered` : "");
        await writeDispatchEvent(tx, id, "CANCELLED", `${reason ? `Cancelled: ${reason}` : "Dispatch cancelled"} — ${split}`, req.user!.id);
        return { reverted: toRevert, keptDelivered: delivered, trip: cancelled };
      });
    } catch (err) {
      if (sendHandlerError(res, err)) return;
      throw err;
    }
    const { reverted, keptDelivered } = outcome;

    // Best-effort notify (outside the txn; failures must not roll back the cancel).
    // The revert-to-ACCEPTED has no order-lifecycle template, so notify directly.
    for (const o of reverted) {
      try {
        await notify({
          userId: o.unitLeadId,
          title: "Dispatch cancelled",
          body: `Order ${o.orderNumber} is back to accepted (awaiting dispatch)${reason ? `: ${reason}` : ""}.`,
          type: "FOOD_ORDER",
          entityType: "FOOD_ORDER",
          entityId: o.id,
        });
      } catch (err) { req.log.error({ err, orderId: o.id }, "dispatch-cancel notify failed"); }
    }

    // B1: the row this transaction actually wrote, not a re-read that could have
    // been moved again since (the old re-read was also what reported the wrong
    // status when the conditional UPDATE matched nothing).
    res.json({ success: true, data: { ...outcome.trip, revertedCount: reverted.length, deliveredCount: keptDelivered } });
  } catch (err) {
    req.log.error(mutationLog(req, err, { dispatchId: req.params["id"] }), "dispatch cancel failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
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
  // Per-meal headcount — attendance differs across meals, so each meal order
  // carries its own residentsCount. Falls back to the batch-level `persons`.
  residentsCount: z.coerce.number().nullish(),
  // Per-meal staff eating the SAME food. Total cooked-for = residents + staff.
  // Falls back to the batch-level `staffCount` (0 when unspecified).
  staffCount: z.coerce.number().nullish(),
  items: z.array(zBatchMealItem).optional(),
}).passthrough();
const orderBatchSchema = z.object({
  propertyId: zId,
  serviceDate: zDateLike,
  meals: z.array(zBatchMeal).optional(),
  persons: z.coerce.number().nullish(),
  residentsCount: z.coerce.number().nullish(),
  // Batch-level staff fallback for meals that omit their own staffCount.
  staffCount: z.coerce.number().nullish(),
  notes: zText.nullish(),
}).passthrough();

foodOpsRouter.post("/order-batches", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    if (!validateBody(orderBatchSchema, req, res)) return;
    const b = req.body || {};
    const { propertyId, serviceDate } = b;
    // Headcounts are clamped non-negative so a crafted negative can never be
    // stored (it would corrupt the residents+staff analytics sums) — mirrors the
    // edit endpoint's non-negative guard.
    const persons = Math.max(0, b.persons != null ? Number(b.persons) : (b.residentsCount != null ? Number(b.residentsCount) : 0));
    // Batch-level staff fallback (0 when unspecified) for meals that omit staffCount.
    const staffScalar = Math.max(0, b.staffCount != null ? Number(b.staffCount) : 0);
    type MealIn = { mealType: string; quantity?: number; residentsCount?: number; staffCount?: number; items?: Array<{ dishId: string; personsCount?: number; orderedQty: number; unit?: string }> };
    const meals: MealIn[] = Array.isArray(b.meals) ? b.meals : [];
    if (!propertyId || !serviceDate || !meals.length) {
      res.status(400).json({ success: false, error: "propertyId, serviceDate and at least one meal required" }); return;
    }
    const parsedSd = new Date(serviceDate);
    if (isNaN(parsedSd.getTime())) { res.status(400).json({ success: false, error: "Invalid serviceDate" }); return; }
    // H1 — normalise to the 00:00-IST instant of the service DAY, the same value
    // food.ts's parseServiceDate stores. Stored verbatim, the client's bare
    // `yyyy-MM-dd` became UTC midnight — 5h30m away from every other serviceDate
    // in the module — so uq_food_orders_property_meal_date could not see a batch
    // order and a legacy POST /orders order for the same property+meal+day as
    // duplicates. It is also the window the dedupe SELECT below already computes.
    const sd = ymdToIstDayStart(istDayYmd(parsedSd));
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

    // Dedupe guard — a property+meal+service-day already covered by a LIVE order
    // (anything not cancelled/rejected) cannot be ordered again. This is the
    // server-side backstop against duplicate orders; the UI also only ever offers
    // the meals that are still un-ordered for the day.
    const dayStart = ymdToIstDayStart(istDayYmd(sd));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const liveOrders = await db
      .select({ mealType: foodOrdersTable.mealType })
      .from(foodOrdersTable)
      .where(and(
        eq(foodOrdersTable.propertyId, propertyId),
        gte(foodOrdersTable.serviceDate, dayStart),
        lt(foodOrdersTable.serviceDate, dayEnd),
        notInArray(foodOrdersTable.status, ["CANCELLED", "REJECTED"]),
      ));
    const alreadyOrdered = new Set<string>(liveOrders.map((o) => o.mealType));
    const mealsToPlace = meals.filter(
      (m) => (MEAL_TYPES as readonly string[]).includes(m.mealType) && !alreadyOrdered.has(m.mealType),
    );
    if (!mealsToPlace.length) {
      res.status(409).json({ success: false, error: "An order for the selected meal(s) already exists for this date." });
      return;
    }

    // 20% ordering cap (validated up-front so we never insert a partial batch).
    // cap is 0 for a property with no ACTIVE residents → residents must be 0
    // (staff-only order); staff itself is never capped here.
    const { occupancy, cap: residentsCap } = await residentsCapForProperty(propertyId);
    for (const meal of mealsToPlace) {
      const r = Math.max(0, meal.residentsCount != null ? Number(meal.residentsCount) : persons);
      if (r > residentsCap) {
        res.status(422).json({ success: false, error: `Residents for ${meal.mealType} (${r}) exceed the ${residentsCap} limit — at most 120% of your ${occupancy} occupied residents. Add staff separately if needed.` });
        return;
      }
    }

    const now = new Date();

    /* H6 — PLAN first, WRITE second.
     *
     * Everything below this point that only READS (menu resolution, portion
     * rules, delivery windows) happens here, so the transaction that follows
     * holds nothing but inserts. Three things change from the old inline loop:
     *
     *  1. The UNIT is never taken from the body. Kitchen Summary keys its cook
     *     plan by dishId|unit with no conversion, so a valid-but-wrong enum
     *     ("KG" for a rule written in "G") reaches the kitchen as a 1000x error
     *     with nothing anywhere to catch it. The unit comes from the portion
     *     rule, else the dish, and is validated against the enum before it is
     *     cast — an unknown value used to throw mid-loop, AFTER the order row
     *     had committed, leaving a PLACED order with zero line items.
     *  2. The QUANTITY is derived server-side (personsCount x qtyPerResident)
     *     and the client's edit is accepted only within tolerance of it. The
     *     grid stays editable — that is the product — but orderedQty IS the
     *     kilograms the kitchen cooks, so it cannot be unbounded.
     *  3. Dropped dishes and skipped meals are REPORTED. They used to vanish
     *     into `continue`, and the response was a 201 either way.
     */
    const [prop] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    type PlannedItem = { dishId: string; personsCount: number; orderedQty: number; unit: string };
    type PlannedMeal = { mealType: string; residents: number; staff: number; items: PlannedItem[]; totalQty: number; expDelivery: Date | null };
    const planned: PlannedMeal[] = [];
    const skipped: string[] = [];

    for (const meal of mealsToPlace) {
      if (!(MEAL_TYPES as readonly string[]).includes(meal.mealType)) continue; // skip invalid meal types
      const menu = await resolveMenu(kitchenId, brand, meal.mealType, sd);
      const allowed = new Set(menu.map((m) => m.dishId));
      // This meal's headcount (per-meal), falling back to the batch scalar. Staff
      // eat the same food, so the per-dish personsCount + quantities are driven by
      // the TOTAL (residents + staff); the split is persisted on the order row.
      const mealResidents = Math.max(0, meal.residentsCount != null ? Number(meal.residentsCount) : persons);
      const mealStaff = Math.max(0, meal.staffCount != null ? Number(meal.staffCount) : staffScalar);
      const mealPersons = mealResidents + mealStaff;
      // Ceiling for a per-item headcount (see the check in the loop below).
      const personsCeiling = mealPersons > 0 ? mealPersons : residentsCap;

      // Per-item editing path, else legacy quantity path.
      let itemRows: PlannedItem[] = [];
      if (Array.isArray(meal.items) && meal.items.length) {
        // Portion rules for EVERY dish on the plate, not just the pinned ones:
        // the rule is what a client-edited quantity is now checked against, and
        // it is also the authority on the unit.
        const rulesByDish = await resolveRulesByDish(brand, meal.mealType, menu.map((m) => m.dishId));

        for (const it of meal.items) {
          const md = it.dishId ? menu.find((m) => m.dishId === it.dishId) : undefined;
          if (!it.dishId || !allowed.has(it.dishId) || !md) { skipped.push(`${meal.mealType}: a dish is no longer on the resolved menu`); continue; }
          const pinned = md.isQtyLocked && md.lockedPersons != null;
          const rule = rulesByDish.get(md.dishId);
          // No standing portion rule means nothing to derive or check against.
          // A pinned dish would otherwise fall back to the client's number and
          // honour the lock in name only; an unpinned one would be unbounded.
          if (!rule) { skipped.push(`${meal.mealType}: ${md.dishName} has no active portion rule`); continue; }
          const personsCount = pinned
            ? md.lockedPersons!
            : (it.personsCount != null ? Math.max(0, Number(it.personsCount)) : mealPersons);
          // The per-item headcount has to be bounded too, or it defeats the
          // quantity bound below by inflating what that bound is computed FROM.
          // Fewer people than the meal's headcount is normal (not everyone eats
          // the paneer); more than are eating the meal is not. When the meal
          // carries no headcount at all, the 20% residents cap stands in.
          if (!pinned && personsCount > personsCeiling) {
            res.status(422).json({
              success: false,
              error: `${md.dishName} for ${meal.mealType} is ordered for ${personsCount} people, more than the ${personsCeiling} eating that meal.`,
            });
            return;
          }
          const derivedQty = personsCount * rule.qty;
          const oq = pinned ? derivedQty : Number(it.orderedQty);
          if (!Number.isFinite(oq) || oq <= 0) { skipped.push(`${meal.mealType}: ${md.dishName} had no usable quantity`); continue; }
          // Upper bound on a client-edited quantity, mirroring the 20% headcount
          // cap above: at most 120% of what the standing rule derives for this
          // headcount. Ordering LESS is always legitimate.
          const ceiling = Math.round(derivedQty * ORDER_QTY_TOLERANCE * 1000) / 1000;
          if (!pinned && oq > ceiling) {
            res.status(422).json({
              success: false,
              error: `${md.dishName} for ${meal.mealType} (${oq}) exceeds the ${ceiling} limit — at most 120% of the ${derivedQty} the portion rule sets for ${personsCount} people.`,
            });
            return;
          }
          // The unit is the rule's, else the dish's — never the body's.
          const unit = rule.unit || md.unit;
          if (!(MEASUREMENT_UNITS as readonly string[]).includes(unit)) {
            res.status(422).json({ success: false, error: `${md.dishName} has an unknown unit "${unit}" — fix its portion rule before ordering.` });
            return;
          }
          itemRows.push({ dishId: it.dishId, personsCount, orderedQty: Math.round(oq * 1000) / 1000, unit });
        }
      } else if (meal.quantity != null) {
        // H6 — the legacy path is a headcount too: computeOrderItems multiplies
        // it by every portion rule, so an unbounded value here is an unbounded
        // cook instruction that bypassed the two bounds above entirely
        // ({meals:[{mealType:"LUNCH",quantity:100000}]} with no items[] told the
        // kitchen to cook 100,000 portions). Same 120% occupancy cap the
        // headcounts get, checked before it reaches the multiplier.
        const legacyQty = Number(meal.quantity);
        if (!Number.isInteger(legacyQty) || legacyQty < 0) {
          res.status(400).json({ success: false, error: `quantity for ${meal.mealType} must be a whole number of people` });
          return;
        }
        if (legacyQty > residentsCap) {
          res.status(422).json({ success: false, error: `Quantity for ${meal.mealType} (${legacyQty}) exceeds the ${residentsCap} limit — at most 120% of your ${occupancy} occupied residents.` });
          return;
        }
        const computed = await computeOrderItems(kitchenId, brand, meal.mealType, sd, legacyQty);
        // computeOrderItems has already pinned any locked dish, so carry its
        // personsCount through instead of stamping the meal headcount on every row.
        itemRows = computed.map((c) => ({ dishId: c.dishId, personsCount: c.personsCount, orderedQty: c.orderedQty, unit: c.unit }));
      }
      if (!itemRows.length) { skipped.push(`${meal.mealType}: nothing orderable on the resolved menu`); continue; }

      planned.push({
        mealType: meal.mealType,
        residents: mealPersons > 0 ? mealResidents : Math.min(itemRows[0]!.personsCount, residentsCap),
        staff: mealStaff,
        items: itemRows,
        totalQty: Math.round(itemRows.reduce((s, r) => s + r.orderedQty, 0) * 1000) / 1000,
        expDelivery: await expectedDeliveryAt(brand, meal.mealType, sd, propertyId),
      });
    }

    // H6: no 201-with-confetti for an empty batch. Nothing was written, and the
    // caller is told exactly which meals fell away and why.
    if (!planned.length) {
      res.status(422).json({ success: false, error: "No meals could be ordered.", details: skipped });
      return;
    }

    // H6: one transaction over batch + orders + items + events, so a bad row can
    // no longer leave a committed order with no line items behind it. The order
    // number is allocated with the tx-aware sequencer — nextOrderNumber() reads
    // through the top-level pool and would hand every order in this batch the
    // same number once the inserts are invisible outside the transaction.
    //
    // The BATCH-/ORD- numbers are MAX()+1 with no lock, so two concurrent
    // batches for DIFFERENT properties can pick the same one. That is a losable
    // race, not a duplicate order: retry the whole (so far uncommitted)
    // transaction, which recomputes both numbers. The property+meal+date
    // violation below is the opposite — it must never be retried.
    const RETRYABLE_SEQ = ["food_order_batches_batch_number_unique", "food_orders_order_number_unique"];
    let batch: typeof foodOrderBatchesTable.$inferSelect;
    let created: any[];
    try {
      ({ batch, created } = await runWithSeqRetry(RETRYABLE_SEQ, () => db.transaction(async (tx) => {
        const batchNumber = await nextSeqTx(tx, `BATCH-${now.getFullYear()}-`, foodOrderBatchesTable.batchNumber, foodOrderBatchesTable);
        const [batchRow] = await tx.insert(foodOrderBatchesTable).values({
          id: newId(), batchNumber, propertyId, unitLeadId: req.user!.id, brand,
          serviceDate: sd, residentsCount: persons, staffCount: staffScalar, notes: b.notes ?? null,
        }).returning();

        const out: any[] = [];
        for (const p of planned) {
          const orderNumber = await nextSeqTx(tx, `ORD-${now.getFullYear()}-`, foodOrdersTable.orderNumber, foodOrdersTable);
          const [order] = await tx.insert(foodOrdersTable).values({
            id: newId(), orderNumber, propertyId, brand, kitchenId, mealType: p.mealType as never,
            unitLeadId: req.user!.id,
            // residentsCount = residents ONLY (Approach A). Preserve the legacy
            // zero-guard (no headcount → first item's basis) but ONLY when the TOTAL
            // is 0 — never fold staff into residentsCount, which would double-count.
            // The up-front cap loop validates the residents FALLBACK, not this per-item
            // value, so clamp it to the cap too — otherwise a total-0 meal with an
            // unbounded item personsCount would silently bypass the 20% cap.
            residentsCount: p.residents,
            staffCount: p.staff,
            totalQuantity: String(p.totalQty), status: "PLACED", serviceDate: sd, batchId: batchRow!.id,
            expectedDeliveryAt: p.expDelivery, notes: b.notes ?? null, createdById: req.user!.id, updatedAt: now,
          }).returning();
          await tx.insert(foodOrderItemsTable).values(p.items.map((r) => ({
            id: newId(), orderId: order!.id, dishId: r.dishId, unit: r.unit as never,
            personsCount: r.personsCount, orderedQty: String(r.orderedQty), updatedAt: now,
          })));
          await tx.insert(foodOrderEventsTable).values({ id: newId(), orderId: order!.id, status: "PLACED", note: `Order placed (batch ${batchNumber})`, actorId: req.user!.id });
          out.push({ ...order, totalQuantity: p.totalQty });
        }
        return { batch: batchRow!, created: out };
      })));
    } catch (err) {
      // uq_food_orders_property_meal_date — the DB backstop behind the dedupe
      // SELECT above, which is a check-then-insert and loses a concurrent race.
      if (isUniqueViolation(err, "uq_food_orders_property_meal_date")) {
        res.status(409).json({ success: false, error: "An order for the selected meal(s) already exists for this date." });
        return;
      }
      throw err;
    }

    // Notifications are best-effort and live OUTSIDE the transaction — a notify
    // failure must never roll back an order that is already placed.
    for (const order of created) {
      try {
        await notifyOrderEvent("PLACED", { unitLeadId: req.user!.id, orderId: order.id, orderNumber: order.orderNumber, propertyName: prop?.name ?? null, mealType: order.mealType, brand });
      } catch (err) { req.log.error({ err, orderId: order.id }, "order-batch notify failed"); }
    }

    res.status(201).json({ success: true, data: { batch, orders: created, skipped } });
  } catch (err) {
    // mealType comes from the batch's meals[], not a scalar body field.
    req.log.error(mutationLog(req, err, { mealTypes: Array.isArray(req.body?.meals) ? req.body.meals.map((m: any) => m?.mealType ?? null) : null }), "order batch failed");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
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

// H4: gated like its sibling POST /menu/share (the share dialog is the caller);
// FOOD_SETTINGS is the other legitimate reader (menu preview from the config tab).
foodOpsRouter.get("/menu/full", authenticate, authorizeAny(["FOOD_PLACE_ORDER", "FOOD_SETTINGS"], "view"), async (req, res) => {
  try {
    const date = parseDate(req.query["date"]) ?? new Date();
    const propertyId = req.query["propertyId"] as string | undefined;
    let brand = (req.query["brand"] as string) || "";
    let kitchenId = (req.query["kitchenId"] as string) || "";
    if (propertyId) {
      // Resolving through a property leaks THAT property's brand/kitchen, so it
      // takes the same scope check /order-preview and /menu/share apply.
      if (!isAccessible(propertyId, await resolveAccessiblePropertyIds(req.user!))) {
        res.status(403).json({ success: false, error: "Property not accessible" }); return;
      }
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
  // L6: both are Postgres enums — validated as enums so a bad value 400s here
  // instead of throwing an opaque 500 out of the insert.
  channel: zShareChannel,
  recipients: z.array(z.string().max(256)).optional(),
  recipientType: z.string().max(32).nullish(),
  mealType: zMealType.nullish(),
  date: zDateLike.nullish(),
  /** Days the public link stays live (1..30); defaults to MENU_SHARE_TTL_DAYS. */
  expiresInDays: z.coerce.number().int().min(1).max(30).optional(),
}).passthrough();

/**
 * Default lifetime of a public `/m/<token>` link.
 *
 * A share token is an unauthenticated window onto a property's menu, and an
 * UNDATED share resolves against "today" every time it is opened — so with no
 * expiry it was a permanent live feed handed out in a WhatsApp message. A menu
 * share is a daily artefact; a week is generous for one. Rows created before
 * this (expiresAt null) keep their old unbounded behaviour rather than being
 * retro-killed — revoke is the path for those.
 */
const MENU_SHARE_TTL_DAYS = 7;

foodOpsRouter.post("/menu/share", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    if (!validateBody(menuShareSchema, req, res)) return;
    const b = req.body || {};
    if (!b.propertyId || !b.brand || !b.channel) { res.status(400).json({ success: false, error: "propertyId, brand, channel required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(b.propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    let recipients: string[] = Array.isArray(b.recipients) ? b.recipients : [];
    // Resolved active-guest rows (kept for dispatch below); empty for CUSTOM shares.
    // M21: `phone` is deliberately NOT selected — see the dispatch block below.
    let guestRows: { id: string; name: string; email: string }[] = [];
    if (b.recipientType === "GUESTS") {
      guestRows = await db.select({ id: residentsTable.id, name: residentsTable.name, email: residentsTable.email })
        .from(residentsTable).where(and(eq(residentsTable.propertyId, b.propertyId), eq(residentsTable.status, "ACTIVE")));
      recipients = guestRows.map((r) => r.id);
    }
    const shareToken = newId();
    const ttlDays = b.expiresInDays != null ? Number(b.expiresInDays) : MENU_SHARE_TTL_DAYS;
    const [row] = await db.insert(foodMenuSharesTable).values({
      id: newId(), sharedById: req.user!.id, propertyId: b.propertyId, brand: b.brand,
      mealType: b.mealType ?? null, menuDate: b.date ? new Date(b.date) : null, channel: b.channel,
      recipientType: b.recipientType ?? "CUSTOM", recipients, shareToken,
      // Every new token is bounded (see MENU_SHARE_TTL_DAYS).
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    }).returning();

    /* #15 — actually dispatch the public menu link to each resolved active guest.
     * LINK (copy-link) channels keep the prior no-dispatch behavior.
     *
     * M21 — two corrections to what this block can honestly claim:
     *
     *  1. It reports what it REACHED, not who it aimed at. Residents are not app
     *     users (userRoleEnum has no RESIDENT value and the only usersTable
     *     inserts are staff creation), and notify() resolves every contact from
     *     usersTable — so the audience is only ever the subset whose email
     *     matches a staff/app user. notifyAll returns that subset.
     *  2. The SMS/WHATSAPP branch is gone. `sms:` addresses the matched USER's
     *     phone, which on an email collision is a staff member's number, not the
     *     resident's — a share sent to the wrong person. There is no way to
     *     address a resident's own phone through notify today, so the link is
     *     delivered by email/bell only and the response says how many that was.
     */
    const channel = String(b.channel || "").toUpperCase();
    let reached: string[] = [];
    if (channel !== "LINK" && guestRows.length) {
      const shareUrl = `${APP_BASE_URL}/m/${shareToken}`;
      const propName = (await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, b.propertyId)))[0]?.name ?? null;
      const mealLabel = b.mealType ? ` ${String(b.mealType).toLowerCase()}` : "";
      const summary = `Here's today's${mealLabel} menu${propName ? ` for ${propName}` : ""}.`;
      // Map guest emails → app users so `notify` can resolve a deliverable contact.
      const emails = [...new Set(guestRows.map((g) => g.email).filter(Boolean))];
      const userByEmail = new Map<string, string>();
      if (emails.length) {
        const users = await db.select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable).where(inArray(usersTable.email, emails));
        for (const u of users) userByEmail.set(u.email, u.id);
      }
      const userIds = [...new Set(guestRows.map((g) => userByEmail.get(g.email)).filter((u): u is string => !!u))];
      if (userIds.length) {
        try {
          const fanout = await notifyAll(userIds, {
            title: "Today's menu is ready",
            body: `${summary} View it here: ${shareUrl}`,
            type: "FOOD_MENU_SHARE",
            link: shareUrl,
            entityType: "FOOD_MENU_SHARE",
            entityId: row!.id,
            email: { subject: "Today's menu", text: `${summary}\n\nView the full menu here:\n${shareUrl}` },
          });
          reached = fanout.reached;
        } catch (err) {
          req.log.error({ err, shareId: row!.id }, "menu-share dispatch failed");
        }
      }
    }

    res.status(201).json({
      success: true,
      // recipientCount is what was DELIVERED to; intendedCount is the audience the
      // share was aimed at. They differ by everyone with no app user behind them.
      data: { ...row, recipientCount: reached.length, intendedCount: recipients.length, unreachableCount: Math.max(0, recipients.length - reached.length) },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * Revoke a share token (withdraw the public link). Soft — the row stays for the
 * audit trail and the token simply stops resolving. Same gate and same property
 * scope as the share that created it: whoever may share a property's menu may
 * withdraw a share of it. Idempotent: re-revoking keeps the first instant.
 */
foodOpsRouter.post("/menu/shares/:id/revoke", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    const [share] = await db.select().from(foodMenuSharesTable).where(eq(foodMenuSharesTable.id, req.params["id"]!));
    if (!share) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(share.propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    if (share.revokedAt) { res.json({ success: true, data: share }); return; }
    const [row] = await db.update(foodMenuSharesTable).set({ revokedAt: new Date() })
      .where(eq(foodMenuSharesTable.id, share.id)).returning();
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** PUBLIC — renders a shared menu link (the `/m/:token` web page). No auth:
 *  anyone holding the share token can view that day's menu (read-only, no PII). */
foodOpsRouter.get("/menu/shared/:token", async (req, res) => {
  try {
    const token = req.params["token"];
    const [share] = await db.select().from(foodMenuSharesTable).where(eq(foodMenuSharesTable.shareToken, token));
    if (!share) { res.status(404).json({ success: false, error: "This menu link is invalid or has expired." }); return; }
    // A token is servable only while it is neither withdrawn nor past its expiry.
    // Both answer with the SAME 404 as an unknown token, so the public endpoint
    // never confirms that a given token once existed.
    if (share.revokedAt || (share.expiresAt && share.expiresAt.getTime() <= Date.now())) {
      res.status(404).json({ success: false, error: "This menu link is invalid or has expired." }); return;
    }
    // Undated shares still resolve against "today" — bounded now by the expiry above.
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

/* ── M6/M7 — the two conventions every food report below follows ──────────────
 *
 * STATUS (M6). A cancelled or rejected order is neither demand nor receipt, so
 * it enters no report. Beyond that: figures that describe DEMAND (ordered
 * quantity, people ordered for) count every LIVE order, because that is what was
 * asked of the kitchen; figures that describe RECEIPT (received, wasted) count
 * only DELIVERED orders, because nothing is received or wasted until it lands.
 * /analytics, /waste-analytics, /reports/variance and the exports are receipt-
 * side reports end to end and pin DELIVERED throughout; /home-analytics is the
 * one screen carrying both kinds, and it uses the two WHEREs side by side.
 * Previously three of them had no status predicate at all, so a cancelled order
 * still counted as ordered — two numbers labelled "ordered" on one screen, and a
 * waste percentage divided by the inflated one.
 *
 * UNIT (M7). `unit` is a per-LINE enum (KG, LITRE, PCS, PLATE…) with no
 * conversion anywhere in this codebase, so a sum across units is not a quantity —
 * and `variance = ordered − received` over such a sum is not a shortfall, which
 * is the signal these reports exist to produce. Every quantity grouping key
 * therefore carries `unit`, and no response emits a cross-unit total. Callers
 * render one row (or one series) per unit. The cook plan already keys by
 * dishId|unit for exactly this reason (food.ts).
 */
const LIVE_ORDERS = notInArray(foodOrdersTable.status, ["CANCELLED", "REJECTED"]);
const DELIVERED_ORDERS = eq(foodOrdersTable.status, "DELIVERED" as never);

/* ── M10 — the property a collection belongs to ───────────────────────────────
 *
 * Every collections figure joined payments → residents and filtered on
 * residents.propertyId — the resident's CURRENT property. Inter-property
 * transfer is a first-class flow, so one transfer silently re-attributed all of
 * that resident's past payments to the destination: both properties' revenue
 * history rewritten, and the destination's unit lead shown money taken at a
 * property they never had access to. payments.property_id is the snapshot taken
 * at payment time (the same one wallet_transactions has always kept). Every
 * query joining payments → residents must filter and group on THIS, not on
 * residents.propertyId.
 *
 * It is a plain column, not a coalesce over both tables: a two-table expression
 * cannot use an index, so the fallback would have made this the slowest query on
 * the dashboard at production volume. The column is NOT NULL and every insert
 * site stamps it; legacy rows are filled by
 * `pnpm --filter @workspace/scripts run backfill:payment-property`.
 */
const collectedAtProperty = paymentsTable.propertyId;

/** 00:00 IST on the 1st of the current IST month (the month-to-date collections anchor). */
function istCurrentMonthStart(): Date {
  return atIst(istMonthStartYmd(istDayYmd(new Date())), "00:00");
}

/* ── Report windows (M8) ──────────────────────────────────────────────────────
 *
 * serviceDate is stored as the 00:00-IST instant of the service DAY, so every
 * report window has to be expressed in IST calendar days or the answer depends
 * on the clock. Two failures this closes:
 *
 *  - the window used to be anchored on `new Date()` and stepped back in whole
 *    milliseconds, so which service day sat at the lower edge flipped at 18:30
 *    UTC and two runs on the same calendar day returned different totals;
 *  - the calendar branches below built their month/FY boundaries with the
 *    host-local Date constructor, which on a UTC container is 5:30 EARLY — the
 *    1st of every month fell outside its own month.
 *
 * Both ends are therefore snapped to IST days: `from` is 00:00 IST of the first
 * day, `to` is the last instant of the last day (00:00 IST of to+1, minus 1ms),
 * which keeps the existing `lte(serviceDate, to)` call sites correct while
 * including the whole final day and never reaching into the next one.
 */

/** The last instant belonging to IST calendar day `ymd` (i.e. 00:00 of ymd+1, −1ms). */
function istDayEnd(ymd: string): Date {
  return new Date(atIst(addDaysYmd(ymd, 1), "00:00").getTime() - 1);
}

/** 'yyyy-MM-01' of the IST month `monthDelta` months from the month `ymd` is in. */
function istMonthStartYmd(ymd: string, monthDelta = 0): string {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + monthDelta, 1)).toISOString().slice(0, 10);
}

function periodRange(period: string | undefined, q: Record<string, unknown>): { from: Date; to: Date } {
  const toYmd = istDayYmd(parseDate(q["to"]) ?? new Date());
  const days = period === "week" ? 7 : period === "quarter" ? 90 : period === "year" ? 365 : 30;
  const fromRaw = parseDate(q["from"]);
  // `days` counts the window INCLUSIVE of both ends (a "week" is 7 service days,
  // not 8) — same convention as wasteAnalyticsScope's default range.
  const fromYmd = fromRaw ? istDayYmd(fromRaw) : addDaysYmd(toYmd, -(days - 1));
  return { from: atIst(fromYmd, "00:00"), to: istDayEnd(toYmd) };
}

/* ── Fiscal-year helpers (India FY = Apr 1 → Mar 31), in IST ─────────────────── */

/** 1-based IST calendar month of an instant. */
function istMonth(date: Date): number {
  return Number(istDayYmd(date).slice(5, 7));
}

/** Fiscal year a date belongs to (Jan–Mar roll back to the previous FY label). */
function fiscalYear(date: Date): number {
  const [y, m] = istDayYmd(date).split("-").map(Number);
  return m! < 4 ? y! - 1 : y!;
}

/** Apr 1 (00:00 IST) of the FY that `date` falls in. */
function fyStart(date: Date): Date {
  return atIst(`${fiscalYear(date)}-04-01`, "00:00");
}

/** [start, end) for an FY quarter. Q1=Apr–Jun, Q2=Jul–Sep, Q3=Oct–Dec, Q4=Jan–Mar (next cal year). */
function fyQuarterRange(fyYear: number, quarter: 1 | 2 | 3 | 4): { from: Date; to: Date } {
  const startMonth = 3 + (quarter - 1) * 3; // Q1→3(Apr), Q2→6(Jul), Q3→9(Oct), Q4→12(Jan next yr)
  const fromYmd = new Date(Date.UTC(fyYear, startMonth, 1)).toISOString().slice(0, 10);
  const toYmd = new Date(Date.UTC(fyYear, startMonth + 3, 1)).toISOString().slice(0, 10);
  return { from: atIst(fromYmd, "00:00"), to: atIst(toYmd, "00:00") }; // exclusive end
}

/** FY-quarter index (1–4) the date falls in. */
function fyQuarterOf(date: Date): 1 | 2 | 3 | 4 {
  const m = istMonth(date);
  if (m >= 4 && m <= 6) return 1;
  if (m >= 7 && m <= 9) return 2;
  if (m >= 10 && m <= 12) return 3;
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
  // M8/B5: an explicit ?from/?to names an IST CALENDAR DAY, not an instant.
  // `new Date("2026-07-07")` is 00:00 UTC — ABOVE the 00:00-IST instant service
  // day 2026-07-07 is stored at — so a raw lower bound dropped the first day of
  // the window and a raw upper bound let the next day's 00:00 IST leak in. Both
  // ends are snapped here, once, so every period branch below inherits it (same
  // convention as periodRange and wasteAnalyticsScope).
  const fromRaw = parseDate(q["from"]);
  const toRaw = parseDate(q["to"]);
  const explicitFrom = fromRaw ? atIst(istDayYmd(fromRaw), "00:00") : undefined;
  const explicitTo = toRaw ? istDayEnd(istDayYmd(toRaw)) : undefined;
  const now = explicitTo ?? new Date();
  // Window ends are used with `lte`; calendar-bounded ends are exclusive, so step
  // back 1ms to keep adjacent periods from overlapping on the boundary midnight.
  const lastMs = (exclusiveEnd: Date) => new Date(exclusiveEnd.getTime() - 1);

  if (period === "fy") {
    // M8: FY boundaries are IST Apr-1 instants, derived from the FY label rather
    // than from the host-local fields of `from` (which is 18:30 the day before).
    const fy = explicitFrom ? fiscalYear(explicitFrom) : fiscalYear(now);
    const from = explicitFrom ?? fyStart(now);
    const to = explicitTo ?? lastMs(atIst(`${fy + 1}-04-01`, "00:00"));
    const prevFrom = atIst(`${fy - 1}-04-01`, "00:00");
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
    // M8: IST month boundaries. Built host-locally these landed 5:30 early on a
    // UTC host, which put the 1st of every month outside its own month.
    const anchorYmd = istDayYmd(explicitFrom ?? now);
    const from = explicitFrom ?? atIst(istMonthStartYmd(anchorYmd), "00:00");
    const to = explicitTo ?? lastMs(atIst(istMonthStartYmd(anchorYmd, 1), "00:00"));
    const prevFrom = atIst(istMonthStartYmd(anchorYmd, -1), "00:00");
    return { from, to, prevFrom, prevTo: lastMs(from), bucket: "day" };
  }
  // default: week — the trailing 7 IST service days ending on `to`'s day.
  const toYmd = istDayYmd(explicitTo ?? new Date());
  const to = explicitTo ?? istDayEnd(toYmd);
  const from = explicitFrom ?? atIst(addDaysYmd(toYmd, -6), "00:00");
  const span = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - span - 1), prevTo: new Date(from.getTime() - 1), bucket: "day" };
}

/* ── Waste percentage: two metrics, two names, never one label ────────────────
 * INVARIANT: no surface in this module emits a bare "waste %". Every waste
 * percentage — response field or export column header — names its denominator,
 * because the two denominators legitimately disagree on the same product.
 *
 *   wastePctOfReceived = wasted / receivedQty
 *     "Of the food that ACTUALLY ARRIVED, how much went in the bin."
 *     Kitchen / portioning efficiency. Owned by the cross-property waste
 *     analytics (/waste-analytics, /waste-analytics/export), which exists to
 *     rank properties and dishes on how well they consume what they are given.
 *
 *   wastePctOfOrdered = wasted / orderedQty
 *     "Of what the property ASKED FOR, how much went in the bin."
 *     Demand-forecast / over-ordering accuracy. Owned by /analytics,
 *     /home-analytics and the `report=waste` export.
 *
 * The ordered denominator is ALWAYS restricted to DELIVERED orders, matching
 * the numerator: an order still in flight has wasted nothing, so counting its
 * demand would only ever drag the number down as new orders are placed.
 *
 * Do NOT "unify" these. They differ exactly when received ≠ ordered — the
 * delivery variance this module exists to report — so collapsing them would
 * destroy one of the two signals rather than reconcile them. Label them apart.
 * The agreed UI/column labels are "Waste % (of received)" and
 * "Waste % (of ordered)"; nothing may render either as plain "Waste %".
 * ───────────────────────────────────────────────────────────────────────── */

/** wasted / received, guarded against /0; one-decimal percentage. See above. */
const wastePctOfReceived = (wasted: unknown, received: unknown) =>
  Number(received) > 0 ? Math.round((Number(wasted) / Number(received)) * 1000) / 10 : 0;
/** wasted / ordered (ordered restricted to DELIVERED), /0-guarded. See above. */
const wastePctOfOrdered = (wasted: unknown, ordered: unknown) =>
  Number(ordered) > 0 ? Math.round((Number(wasted) / Number(ordered)) * 1000) / 10 : 0;

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
    // M6: waste and delays are both receipt-side — an order that was cancelled,
    // rejected or is still in flight wasted nothing and was late for nobody.
    orderScope.push(DELIVERED_ORDERS);
    const where = and(...orderScope);

    // M8: bucket on the IST calendar day, like the sibling reports (a bare
    // to_char reads the UTC day and puts every service date on the day before).
    const day = sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const unit = foodOrderItemsTable.unit;

    // Wastage trend (sum wasted qty per day and unit — M7)
    const wastageTrend = await db.select({ date: day, unit, wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float` })
      .from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(day, unit).orderBy(day);

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
      // `where` is DELIVERED-only, so `ordered` here is already ordered-on-delivered.
      wastePctOfOrdered: wastePctOfOrdered(d.wasted, d.ordered),
    }));

    // Delays: delivered later than expectedDeliveryAt. (M8: IST day bucket.)
    const deliveredDay = sql<string>`to_char(${foodOrdersTable.deliveredAt} + interval '330 minutes', 'YYYY-MM-DD')`;
    const delivered = await db.select({
      date: deliveredDay,
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*)::int`,
    }).from(foodOrdersTable).where(and(where, isNotNull(foodOrdersTable.deliveredAt)))
      .groupBy(deliveredDay).orderBy(deliveredDay);

    const [delaySummary] = await db.select({
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*) filter (where ${foodOrdersTable.deliveredAt} is not null)::int`,
    }).from(foodOrdersTable).where(where);

    // M7: totals per unit. There is no unit-free "total wasted" to report.
    const wasteSummary = await db.select({
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(unit).orderBy(unit);

    res.json({
      success: true,
      data: {
        period: period ?? "month",
        range: { from, to },
        wastageTrend: wastageTrend.map((r) => ({ date: r.date, unit: r.unit, wasted: Math.round(Number(r.wasted) * 1000) / 1000 })),
        topWasteItems,
        delays: delivered.map((r) => ({ date: r.date, delayed: r.delayed, total: r.total })),
        summary: {
          byUnit: wasteSummary.map((r) => ({
            unit: r.unit,
            wasted: Math.round(Number(r.wasted) * 1000) / 1000,
            ordered: Math.round(Number(r.ordered) * 1000) / 1000,
            // Ordered basis (`where` is DELIVERED-only) — reproducible from the
            // `wasted`/`ordered` printed beside it.
            wastePctOfOrdered: wastePctOfOrdered(r.wasted, r.ordered),
          })),
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
 *   summary     — totals + wastePctOfReceived + ordersWithWaste count
 *   byProperty  — top properties by wasted qty (with property wastePctOfReceived)
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
// Waste percentages on this surface use `wastePctOfReceived` (declared with its
// counterpart above /analytics). This is the efficiency surface: the question is
// "of what arrived, how much was binned", not "of what was ordered".

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
    // M8: the bound is EXCLUSIVE (00:00 IST of to+1) and must be compared as
    // such. Compared with lte it matched serviceDate exactly on that instant —
    // and every serviceDate IS a 00:00-IST instant — so the whole to+1 service
    // day was pulled into every waste figure.
    lt(foodOrdersTable.serviceDate, toAtExclusive),
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
  // M6: every metric here is receipt-side (wasted / received), so the report is
  // DELIVERED-only. Without a status predicate a cancelled order's ordered
  // quantity inflated totalOrdered while contributing no waste.
  conds.push(DELIVERED_ORDERS);

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

    // ── Summary — totals across the filtered set, PER UNIT (M7) ──────────────
    const unit = foodOrderItemsTable.unit;
    const summaryRows = await db.select({
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(unit).orderBy(unit);

    // Orders that recorded any waste (distinct order ids with wasted > 0).
    const [withWasteRow] = await db.select({
      n: sql<number>`count(distinct ${foodOrdersTable.id})::int`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(where, sql`${foodOrderItemsTable.wastedQty} > 0`));

    // M7: every widget below carries `unit` in its grouping key, so a row is
    // "40 KG wasted at this property", never "52" of nothing in particular.
    //
    // The consequence M7 created: a flat top-50 over a per-unit grouping is not
    // a top-50 of anything the client can slice. The client renders the first 10
    // rows, and one heavy unit (PLATE, which every property orders) could fill
    // all 50, so the KG chart came back empty and "top 10 properties" showed
    // three. The cap is therefore taken PER UNIT — each unit contributes its own
    // ranked TOP_N and the client's slice(0,10) lands inside one unit's ranking.
    // Compensating on the client is impossible: the rows it would need were
    // never sent. `unit` is NOT NULL, so summaryRows above already enumerates
    // exactly the units in the filtered set (2-3 in practice) — one bounded,
    // indexed query each is both exact and cheaper than ranking 50 rows that
    // still might not contain the answer.
    const TOP_N_PER_UNIT = 10;
    const unitsPresent = summaryRows.map((r) => r.unit);

    // ── byProperty — top properties by wasted qty (with city/cluster labels) ──
    const byPropertyRows = (await Promise.all(unitsPresent.map((u) => db.select({
      propertyId: foodOrdersTable.propertyId,
      name: propertiesTable.name,
      city: citiesTable.name,
      cluster: clustersTable.name,
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
      .leftJoin(citiesTable, eq(clustersTable.cityId, citiesTable.id))
      .where(and(where, eq(unit, u)))
      .groupBy(foodOrdersTable.propertyId, propertiesTable.name, citiesTable.name, clustersTable.name, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(TOP_N_PER_UNIT)))).flat();

    // ── byDish — top dishes by wasted qty ────────────────────────────────────
    const byDishRows = (await Promise.all(unitsPresent.map((u) => db.select({
      dishId: foodOrderItemsTable.dishId,
      name: dishesTable.name,
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(and(where, eq(unit, u)))
      .groupBy(foodOrderItemsTable.dishId, dishesTable.name, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(TOP_N_PER_UNIT)))).flat();

    // ── byMealType — wasted qty per meal ─────────────────────────────────────
    const byMealRows = await db.select({
      mealType: foodOrdersTable.mealType,
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType, unit);

    // ── byMenu — wasted qty per brand (brand stands in for menu) ──────────────
    const byMenuRows = await db.select({
      brand: foodOrdersTable.brand,
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.brand, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));

    // ── trend — wasted qty per period (IST day or month) over the range ───────
    // serviceDate is a UTC timestamp; shift +5:30 before truncating so the bucket
    // boundaries land on IST calendar days/months (consistent with the rest of food-ops).
    const periodExpr = granularity === "month"
      ? sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM')`
      : sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const trendRows = await db.select({
      period: periodExpr,
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(periodExpr, unit).orderBy(periodExpr);

    res.json({
      success: true,
      data: {
        range: { from: fromYmd, to: toYmd },
        granularity,
        summary: {
          // M7: one total per unit — there is no meaningful sum across them.
          byUnit: summaryRows.map((r) => ({
            unit: r.unit,
            totalWasted: wr3(r.wasted),
            totalReceived: wr3(r.received),
            totalOrdered: wr3(r.ordered),
            wastePctOfReceived: wastePctOfReceived(r.wasted, r.received),
          })),
          ordersWithWaste: Number(withWasteRow?.n ?? 0),
        },
        byProperty: byPropertyRows.map((r) => ({
          propertyId: r.propertyId,
          name: r.name ?? "—",
          city: r.city ?? null,
          cluster: r.cluster ?? null,
          unit: r.unit,
          wastedQty: wr3(r.wasted),
          // Carried alongside so the percentage is reproducible from its own operands.
          receivedQty: wr3(r.received),
          wastePctOfReceived: wastePctOfReceived(r.wasted, r.received),
        })),
        byDish: byDishRows.map((r) => ({
          dishId: r.dishId,
          name: r.name ?? "—",
          unit: r.unit,
          wastedQty: wr3(r.wasted),
        })),
        // One entry per meal × unit, and a zero entry (unit null) for a meal with
        // nothing recorded, so all four meals stay on the chart.
        byMealType: MEAL_TYPES.flatMap((mt) => {
          const rows = byMealRows.filter((r) => r.mealType === mt);
          if (!rows.length) return [{ mealType: mt, unit: null as string | null, wastedQty: 0 }];
          return rows.map((r) => ({ mealType: mt, unit: r.unit as string | null, wastedQty: wr3(r.wasted) }));
        }),
        byMenu: byMenuRows.map((r) => ({
          brand: r.brand ?? "—",
          unit: r.unit,
          wastedQty: wr3(r.wasted),
        })),
        trend: trendRows.map((r) => ({
          period: r.period,
          unit: r.unit,
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
  // M7: the file mirrors the on-screen widget, so it carries the same Unit
  // column — a "Wasted" column summed across KG and PLATE is not a quantity.
  const unit = foodOrderItemsTable.unit;

  if (widget === "property") {
    const rows = await db.select({
      name: propertiesTable.name, city: citiesTable.name, cluster: clustersTable.name, unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(clustersTable, eq(propertiesTable.clusterId, clustersTable.id))
      .leftJoin(citiesTable, eq(clustersTable.cityId, citiesTable.id))
      .where(where)
      .groupBy(foodOrdersTable.propertyId, propertiesTable.name, citiesTable.name, clustersTable.name, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(EXPORT_ROW_CAP + 1);
    return {
      // The column names its denominator: this file and the `report=waste` file
      // both carried a column called "Waste %" computed two different ways.
      title: "Food Waste by Property",
      headers: ["Property", "City", "Cluster", "Unit", "Wasted", "Received", "Waste % (of received)"],
      rows: rows.map((r) => [r.name ?? "—", r.city ?? "", r.cluster ?? "", r.unit, wr3(r.wasted), wr3(r.received), `${wastePctOfReceived(r.wasted, r.received)}%`]),
      fileBase: "food-waste-by-property",
      dateRange,
    };
  }

  if (widget === "dish") {
    const rows = await db.select({
      name: dishesTable.name, unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(where).groupBy(dishesTable.name, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(EXPORT_ROW_CAP + 1);
    return {
      title: "Food Waste by Dish", headers: ["Dish", "Unit", "Wasted"],
      rows: rows.map((r) => [r.name ?? "—", r.unit, wr3(r.wasted)]),
      fileBase: "food-waste-by-dish",
      dateRange,
    };
  }

  if (widget === "mealtype") {
    const grouped = await db.select({
      mealType: foodOrdersTable.mealType, unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType, unit);
    return {
      title: "Food Waste by Meal", headers: ["Meal", "Unit", "Wasted"],
      rows: MEAL_TYPES.flatMap((mt) => {
        const mealRows = grouped.filter((r) => r.mealType === mt);
        if (!mealRows.length) return [[mt, "", 0] as (string | number | null)[]];
        return mealRows.map((r) => [mt, r.unit, wr3(r.wasted)] as (string | number | null)[]);
      }),
      fileBase: "food-waste-by-meal",
      dateRange,
    };
  }

  if (widget === "menu") {
    const rows = await db.select({
      brand: foodOrdersTable.brand, unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.brand, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`))
      .limit(EXPORT_ROW_CAP + 1);
    return {
      title: "Food Waste by Menu", headers: ["Menu (Brand)", "Unit", "Wasted"],
      rows: rows.map((r) => [r.brand ?? "—", r.unit, wr3(r.wasted)]),
      fileBase: "food-waste-by-menu",
      dateRange,
    };
  }

  // trend
  const periodExpr = granularity === "month"
    ? sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM')`
    : sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
  const rows = await db.select({
    period: periodExpr, unit,
    wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
  }).from(foodOrdersTable)
    .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
    .where(where).groupBy(periodExpr, unit).orderBy(periodExpr).limit(EXPORT_ROW_CAP + 1);
  return {
    title: `Food Waste Trend (${granularity === "month" ? "Monthly" : "Daily"})`,
    headers: ["Period", "Unit", "Wasted"],
    rows: rows.map((r) => [r.period, r.unit, wr3(r.wasted)]),
    fileBase: "food-waste-trend",
    dateRange,
  };
}

foodOpsRouter.get("/waste-analytics/export.:fmt", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
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
    // H11: the widget datasets are grouped, so their row count is a cardinality
    // (property × unit, dish × unit, day × unit) with no upper bound — each query
    // fetches cap + 1 so an over-cap extract is refused with the cap named rather
    // than rendered.
    if (t.rows.length > EXPORT_ROW_CAP) throw new ExportTooLargeError(EXPORT_ROW_CAP);
    const table = { title: t.title, headers: t.headers, rows: t.rows, dateRange: t.dateRange };
    const filename = `${t.fileBase}-${fileDateStamp()}.${fmt}`;

    if (fmt === "pdf" && t.rows.length > PDF_ROW_CAP) throw new ExportTooLargeError(PDF_ROW_CAP, "PDF");
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
  } catch (err) { if (sendExportTooLarge(res, err)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
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
    // M6: this screen carries both kinds of figure, so it carries both WHEREs.
    // `where` = every LIVE order (demand: people ordered for); `whereDelivered`
    // narrows to what actually landed (receipt: wasted, delays).
    orderScope.push(LIVE_ORDERS);
    const where = and(...orderScope);
    const whereDelivered = and(where, DELIVERED_ORDERS);
    // M8: IST calendar-day bucket (a bare to_char reads the UTC day, which for a
    // 00:00-IST serviceDate is the day before).
    const day = sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const unit = foodOrderItemsTable.unit;

    // ── People ordered for — bucketed by day (sum of residentsCount) ──────────
    const peopleRows = await db.select({ date: day, people: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount}), 0)::int` })
      .from(foodOrdersTable).where(where).groupBy(day).orderBy(day);
    const peopleOrderedTrend = peopleRows.map((r) => ({ date: r.date, people: Number(r.people) }));

    // ── People ordered for — grouped across properties ────────────────────────
    const peopleByPropRows = await db.select({
      propertyId: foodOrdersTable.propertyId, propertyName: propertiesTable.name,
      people: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount}), 0)::int`,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .where(where).groupBy(foodOrdersTable.propertyId, propertiesTable.name)
      .orderBy(desc(sql`sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount})`));
    const peopleByProperty = peopleByPropRows.map((r) => ({
      propertyId: r.propertyId, propertyName: r.propertyName ?? "—", people: Number(r.people),
    }));

    // ── People ordered for — current vs prior comparable window ───────────────
    const [curPeople] = await db.select({ total: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount}), 0)::int` })
      .from(foodOrdersTable).where(where);
    const prevScope = [gte(foodOrdersTable.serviceDate, prevFrom), lte(foodOrdersTable.serviceDate, prevTo), LIVE_ORDERS] as any[];
    if (ids !== null) prevScope.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
    if (propertyId) prevScope.push(eq(foodOrdersTable.propertyId, propertyId));
    const [prevPeople] = await db.select({ total: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount}), 0)::int` })
      .from(foodOrdersTable).where(and(...prevScope));
    // M8: label the window in IST — toISOString on a 00:00-IST instant prints the
    // previous calendar day, so the header said one thing and the bars another.
    const peopleComparison = {
      current: Number(curPeople?.total ?? 0),
      prior: Number(prevPeople?.total ?? 0),
      currentLabel: `${istDayYmd(from)} → ${istDayYmd(to)}`,
      priorLabel: `${istDayYmd(prevFrom)} → ${istDayYmd(prevTo)}`,
    };

    // ── Wastage trend (sum wasted qty per day and unit — M6/M7) ───────────────
    const wastageRows = await db.select({ date: day, unit, wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float` })
      .from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(whereDelivered).groupBy(day, unit).orderBy(day);
    const wastageTrend = wastageRows.map((r) => ({ date: r.date, unit: r.unit, wasted: Math.round(Number(r.wasted) * 1000) / 1000 }));

    // ── Top 20% items by wastage ──────────────────────────────────────────────
    const wasteByDish = await db.select({
      dishId: foodOrderItemsTable.dishId, dishName: dishesTable.name, unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(whereDelivered).groupBy(foodOrderItemsTable.dishId, dishesTable.name, unit)
      .orderBy(desc(sql`sum(${foodOrderItemsTable.wastedQty})`));
    const nonZero = wasteByDish.filter((d) => Number(d.wasted) > 0);
    const topCount = Math.max(1, Math.ceil(nonZero.length * 0.2));
    const topWasteItems = nonZero.slice(0, topCount).map((d) => ({
      dishId: d.dishId, dishName: d.dishName, unit: d.unit,
      wasted: Math.round(Number(d.wasted) * 1000) / 1000, ordered: Math.round(Number(d.ordered) * 1000) / 1000,
      // `whereDelivered`, so `ordered` is already ordered-on-delivered — same
      // basis as the identically-named field on /analytics.
      wastePctOfOrdered: wastePctOfOrdered(d.wasted, d.ordered),
    }));

    // ── Food-order delays per day (M8: IST day bucket) ────────────────────────
    const deliveredDay = sql<string>`to_char(${foodOrdersTable.deliveredAt} + interval '330 minutes', 'YYYY-MM-DD')`;
    const delivered = await db.select({
      date: deliveredDay,
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*)::int`,
    }).from(foodOrdersTable).where(and(whereDelivered, isNotNull(foodOrdersTable.deliveredAt)))
      .groupBy(deliveredDay).orderBy(deliveredDay);
    const orderDelays = delivered.map((r) => ({ date: r.date, delayed: r.delayed, total: r.total }));

    // ── Active-resident trend (cumulative active check-ins per day) ───────────
    const resScope = [eq(residentsTable.status, "ACTIVE"), isNotNull(residentsTable.checkInDate),
      lte(residentsTable.checkInDate, to)] as any[];
    if (ids !== null) resScope.push(ids.length ? inArray(residentsTable.propertyId, ids) : sql`false`);
    if (propertyId) resScope.push(eq(residentsTable.propertyId, propertyId));
    const resDay = sql<string>`to_char(${residentsTable.checkInDate} + interval '330 minutes', 'YYYY-MM-DD')`;
    const checkInRows = await db.select({ date: resDay, c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(...resScope)).groupBy(resDay).orderBy(resDay);
    // Build cumulative series clipped to [from, to]; the count at `from` is the
    // running total of everyone checked-in on/before `from`. (M8: the clip key is
    // the IST day, matching the bucket it is compared against.)
    let running = 0;
    const fromKey = istDayYmd(from);
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
    const monthStart = istCurrentMonthStart();
    const collScope = [eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)] as any[];
    if (ids !== null) collScope.push(ids.length ? inArray(collectedAtProperty, ids) : sql`false`);
    if (propertyId) collScope.push(eq(collectedAtProperty, propertyId));
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
    // M6/M7: `ordered` is the DEMAND on the live orders, `wasted` is what was
    // thrown away out of what actually landed — and both are per unit, so the
    // percentage divides two quantities of the same thing.
    const wasteSummary = await db.select({
      unit,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}) filter (where ${foodOrdersTable.status} = 'DELIVERED'), 0)::float`,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
      orderedDelivered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrdersTable.status} = 'DELIVERED'), 0)::float`,
    }).from(foodOrdersTable).innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(unit).orderBy(unit);
    const [delaySummary] = await db.select({
      delayed: sql<number>`count(*) filter (where ${foodOrdersTable.expectedDeliveryAt} is not null and ${foodOrdersTable.deliveredAt} > ${foodOrdersTable.expectedDeliveryAt})::int`,
      total: sql<number>`count(*) filter (where ${foodOrdersTable.deliveredAt} is not null)::int`,
    }).from(foodOrdersTable).where(whereDelivered);

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
          byUnit: wasteSummary.map((r) => ({
            unit: r.unit,
            totalWasted: Math.round(Number(r.wasted) * 1000) / 1000,
            // Demand across every LIVE order — the "people ordered for" figure.
            totalOrdered: Math.round(Number(r.ordered) * 1000) / 1000,
            // The percentage's actual denominator, shipped so the number is
            // reproducible: dividing by totalOrdered above would not give it,
            // because that includes orders still in flight (which have wasted
            // nothing, so the ratio would only ever fall as orders are placed).
            totalOrderedDelivered: Math.round(Number(r.orderedDelivered) * 1000) / 1000,
            wastePctOfOrdered: wastePctOfOrdered(r.wasted, r.orderedDelivered),
          })),
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

    // C3: an order delivered by the TRIP carries no receivedQty — nobody counted
    // it yet. Summing those lines as received = 0 against a full ordered quantity
    // invented a 100% shortfall against the kitchen. Only COUNTED lines enter the
    // ordered/received/variance figures; the rest are reported separately as
    // `unconfirmed` so the shortfall stays visible without being fabricated.
    // M7: (mealType, unit) is the grouping key. `variance = ordered − received`
    // over a sum of kilograms and plates is not a shortfall, and the shortfall is
    // the whole point of this report.
    const unit = foodOrderItemsTable.unit;
    const grouped = await db.select({
      mealType: foodOrdersTable.mealType,
      unit,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is not null), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      unconfirmed: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is null), 0)::float`,
      unconfirmedOrders: sql<number>`count(distinct ${foodOrderItemsTable.orderId}) filter (where ${foodOrderItemsTable.receivedQty} is null)::int`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType, unit).orderBy(unit);

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const line = (g: typeof grouped[number]) => {
      const ordered = r3(Number(g.ordered));
      const received = r3(Number(g.received));
      return {
        mealType: g.mealType, unit: g.unit as string | null,
        ordered, received, wasted: r3(Number(g.wasted)), variance: r3(ordered - received),
        unconfirmed: r3(Number(g.unconfirmed)), unconfirmedOrders: Number(g.unconfirmedOrders),
      };
    };
    // One row per meal × unit; a meal with nothing recorded keeps a zero row so
    // all four meals stay on the table.
    const rows = MEAL_TYPES.flatMap((mt) => {
      const mealRows = grouped.filter((g) => g.mealType === mt);
      if (!mealRows.length) return [{ mealType: mt, unit: null as string | null, ordered: 0, received: 0, wasted: 0, variance: 0, unconfirmed: 0, unconfirmedOrders: 0 }];
      return mealRows.map(line);
    });
    // Totals are per unit for the same reason. `unconfirmedOrders` is a count of
    // orders, not a quantity, so it does have one org-wide value — but it must be
    // counted distinctly, not summed across groups an order can appear in twice.
    const totalsByUnit = [...new Set(grouped.map((g) => g.unit))].map((u) => {
      const src = grouped.filter((g) => g.unit === u);
      return {
        unit: u,
        ordered: r3(src.reduce((t, g) => t + Number(g.ordered), 0)),
        received: r3(src.reduce((t, g) => t + Number(g.received), 0)),
        wasted: r3(src.reduce((t, g) => t + Number(g.wasted), 0)),
        variance: r3(src.reduce((t, g) => t + Number(g.ordered) - Number(g.received), 0)),
        unconfirmed: r3(src.reduce((t, g) => t + Number(g.unconfirmed), 0)),
      };
    });
    const [unconfirmedRow] = await db.select({
      n: sql<number>`count(distinct ${foodOrdersTable.id})::int`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(where, isNull(foodOrderItemsTable.receivedQty)));

    res.json({ success: true, data: { rows, totalsByUnit, unconfirmedOrders: Number(unconfirmedRow?.n ?? 0) } });
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
 * Gated on the report it labels (H4 — it was open to any authenticated user).
 */
foodOpsRouter.get("/settings/ontime-tolerance", authenticate, authorizeAny(["FOOD_REPORTS", "FOOD_SETTINGS"], "view"), async (req, res) => {
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
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" }); return;
    }
    if (!validateBody(ontimeToleranceSchema, req, res)) return;
    const n = Number((req.body || {}).minutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) {
      res.status(400).json({ success: false, error: "minutes must be an integer between 0 and 240" }); return;
    }
    // M17: org-wide SLA setting — widening the tolerance retroactively repaints
    // every on-time figure on the dashboard, so who changed it has to be on record.
    const [before] = await db.select().from(systemConfigTable).where(eq(systemConfigTable.key, FOOD_ONTIME_TOLERANCE_KEY));
    await db.insert(systemConfigTable)
      .values({ id: newId(), key: FOOD_ONTIME_TOLERANCE_KEY, value: n as never, description: "On-time delivery tolerance (minutes) past the meal's scheduled service time.", updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: n as never, updatedAt: new Date() } });
    auditConfig(req, before ? "FOOD_CONFIG_UPDATED" : "FOOD_CONFIG_CREATED", "food_system_config", FOOD_ONTIME_TOLERANCE_KEY, { before: before?.value, after: n });
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
    // C3: same uncounted-line exclusion as /reports/variance — the two reports
    // must agree on what "variance" means, or the daily chart contradicts the
    // summary table above it. M7: and the same (…, unit) grouping key, for the
    // same reason — one row per service day PER UNIT.
    const unit = foodOrderItemsTable.unit;
    const grouped = await db.select({
      date: day,
      unit,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is not null), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      unconfirmed: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is null), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(...conds)).groupBy(day, unit).orderBy(day);

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const rows = grouped.map((g) => {
      const ordered = r3(Number(g.ordered));
      const received = r3(Number(g.received));
      const wasted = r3(Number(g.wasted));
      return { date: g.date, unit: g.unit, ordered, received, variance: r3(ordered - received), wasted, unconfirmed: r3(Number(g.unconfirmed)) };
    });
    res.json({ success: true, data: { rows } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * Exports — orders & guests (Persona st.34, st.47)
 * ════════════════════════════════════════════════════════════════════════ */

/* ── Export bounds (H11) ─────────────────────────────────────────────────────
 *
 * `GET /reports/export.pdf` with no from/to used to select the ENTIRE
 * food_orders table (an org-wide caller gets no property predicate either) and
 * render every row to PDF inline — a synchronous per-cell layout loop on the
 * event loop, so one request stalls the whole process for every other user.
 *
 * Two bounds, both of which have to be here rather than on the sibling JSON
 * endpoint the last pass fixed: a default lower bound so "no filters" is a
 * window and not the whole table, and a hard row cap that answers 422 with the
 * cap named instead of trying and timing out. The cap is deliberately generous —
 * it is a runaway guard, not a page size. Anything past it is a data extract,
 * not a report, and wants a narrower window.
 * ───────────────────────────────────────────────────────────────────────────── */
const EXPORT_ROW_CAP = 20000;
/** Rows above this are not rendered to PDF — the layout loop is per-cell. */
const PDF_ROW_CAP = 5000;
/** Default window when the caller supplies no `from` (mirrors food.ts's reportConds). */
const REPORT_DEFAULT_WINDOW_DAYS = 90;

class ExportTooLargeError extends Error {
  constructor(readonly cap: number, readonly format?: string) {
    super(
      format
        ? `This export is too large to render as ${format} (over ${cap.toLocaleString("en-IN")} rows). Narrow the date range, or download it as CSV.`
        : `This export is too large (over ${cap.toLocaleString("en-IN")} rows). Narrow the date range or filter by property.`,
    );
  }
}

/**
 * B5 — the export window, in IST calendar days.
 *
 * serviceDate is stored at IST midnight, i.e. 18:30 UTC on the PREVIOUS day, so
 * a raw `new Date("2026-07-07")` lower bound (00:00 UTC) sits ABOVE the instant
 * service day 2026-07-07 is stored at: every export silently dropped the first
 * IST day of its range, a day the screen — which resolves its window through
 * periodRange — still showed. Both ends are therefore snapped to the IST day the
 * caller named: [00:00 IST of `from`, last ms of `to`], the same convention
 * periodRange and wasteAnalyticsScope use, with this surface's own 90-day
 * default when neither `period` nor `from` is given (inclusive of both ends,
 * like periodRange).
 *
 * LOW — this now genuinely mirrors periodRange, which the paragraph above always
 * claimed and the code did not. Two divergences are closed:
 *
 *   • `?period` was IGNORED, so exporting a "this week" report handed back 90
 *     days — a file that disagreed with the screen it was exported from.
 *   • the upper bound was left NULL when `?to` was absent, so the export reached
 *     into future-dated service days the screen's `to` bound excludes.
 *
 * Neither is a behaviour change for the product: food-reports.tsx always sends
 * an explicit `from` AND `to` and never sends `period` (buildExportParams over
 * `filters`), so only a hand-built request ever saw either divergence. The ONLY
 * remaining difference from periodRange is the no-period/no-from default window
 * (REPORT_DEFAULT_WINDOW_DAYS rather than periodRange's 30-day "month"), which
 * is deliberate and stated above.
 */
function exportWindow(q: Record<string, unknown>): { from: Date; to: Date; fromRaw?: Date; toRaw?: Date } {
  const period = q["period"] as string | undefined;
  const fromRaw = parseDate(q["from"]);
  const toRaw = parseDate(q["to"]);
  // Caller named a window (either way the screen names one) → periodRange IS the
  // answer, so call it rather than re-deriving it and drifting again.
  if (period || fromRaw) return { ...periodRange(period, q), fromRaw, toRaw };
  const toYmd = istDayYmd(toRaw ?? new Date());
  return {
    from: atIst(addDaysYmd(toYmd, -(REPORT_DEFAULT_WINDOW_DAYS - 1)), "00:00"),
    to: istDayEnd(toYmd),
    fromRaw, toRaw,
  };
}

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
  // B5: IST day bounds — see exportWindow. `fromRaw`/`toRaw` are kept only for
  // the human-readable header label.
  const { from: fromAt, to: toAt, fromRaw: from, toRaw: to } = exportWindow(req.query as Record<string, unknown>);
  const propertyId = req.query["propertyId"] as string | undefined;
  const brand = req.query["brand"] as string | undefined;
  if (status) conds.push(eq(foodOrdersTable.status, status as never));
  conds.push(gte(foodOrdersTable.serviceDate, fromAt));
  // LOW: exportWindow always bounds the upper end now (it mirrors periodRange),
  // so this is unconditional — a null `to` used to leave the export open-ended.
  conds.push(lte(foodOrdersTable.serviceDate, toAt));
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
  const rows = await db.select({ o: foodOrdersTable, propertyName: propertiesTable.name, unitLeadName: usersTable.name })
    .from(foodOrdersTable).leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
    .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(foodOrdersTable.serviceDate), desc(foodOrdersTable.id))
    .limit(EXPORT_ROW_CAP + 1);
  if (rows.length > EXPORT_ROW_CAP) throw new ExportTooLargeError(EXPORT_ROW_CAP);

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

  // M7: `total_quantity` is sum(orderedQty) over EVERY line of the order, and the
  // lines carry different units (KG, LITRE, PCS, PLATE) with no conversion
  // anywhere in this codebase — so the old scalar "Quantity" cell was kilograms
  // added to plates. The file now reports the quantity per unit, the same shape
  // every other export adopted when it grew a Unit column.
  const qtyByOrder = new Map<string, string>();
  if (rows.length) {
    const perUnit = await db.select({
      orderId: foodOrderItemsTable.orderId,
      unit: foodOrderItemsTable.unit,
      qty: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}), 0)::float`,
    }).from(foodOrderItemsTable)
      .where(inArray(foodOrderItemsTable.orderId, rows.map((r) => r.o.id)))
      .groupBy(foodOrderItemsTable.orderId, foodOrderItemsTable.unit)
      .orderBy(foodOrderItemsTable.unit);
    for (const p of perUnit) {
      const part = `${r3(Number(p.qty))} ${p.unit ?? ""}`.trim();
      const prior = qtyByOrder.get(p.orderId);
      qtyByOrder.set(p.orderId, prior ? `${prior} + ${part}` : part);
    }
  }

  const mapped = rows.map((r) => [
    r.o.orderNumber, r.propertyName ?? "", r.unitLeadName ?? "", r.o.brand, r.o.mealType,
    r.o.residentsCount, r.o.staffCount ?? 0, (r.o.residentsCount ?? 0) + (r.o.staffCount ?? 0),
    qtyByOrder.get(r.o.id) ?? "", r.o.status,
    fmtDate(r.o.serviceDate), fmtDateTime(r.o.deliveredAt),
  ]);
  return { rows: mapped, propertyName, dateRange };
}
const ORDER_HEADERS = ["Order ID", "Property", "Unit Lead", "Brand", "Meal", "Residents", "Staff", "Total", "Quantity (by unit)", "Status", "Service Date", "Delivered At"];

// H2/#11: this is the ONE handler behind every /reports/export URL. There used
// to be four literal `.csv/.pdf/.xls`/extensionless registrations sitting in
// front of the wildcard `/reports/export.:fmt`, which Express therefore never
// reached — the same "an extension variant quietly takes a different code path"
// shape that made H2 serve the wrong dataset. INVARIANT: one dataset, one
// handler; every path below delegates here and none of them owns any behaviour.
// `fmt` is a narrowed literal by the time it arrives, never the raw path
// segment — see the allowlist at the registration.
async function serveReportExport(req: any, res: any, fmt: "csv" | "pdf" | "xls"): Promise<void> {
  const report = String(req.query["report"] ?? "orders").toLowerCase();
  if (!EXPORT_REPORTS.has(report)) {
    res.status(400).json({ success: false, error: "report must be one of orders, variance, waste, ontime" }); return;
  }
  const t = await buildReportTable(report, req);
  const table = { title: t.title, headers: t.headers, rows: t.rows, propertyName: t.propertyName, dateRange: t.dateRange };
  // `orders` carries fileBase "food-orders", so this reproduces the historical
  // "food-orders-{property?}-{date}.{ext}" name without a second code path.
  const filename = reportFilename(t.fileBase, t.propertyName, fmt);
  if (fmt === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.send(toCsv(table));
  } else if (fmt === "pdf") {
    // H11: the PDF layout loop runs per cell, so it is the one encoder whose
    // cost is worth refusing rather than attempting. CSV of the same data is
    // always available and streams cheaply, so the 422 names it.
    if (table.rows.length > PDF_ROW_CAP) throw new ExportTooLargeError(PDF_ROW_CAP, "PDF");
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

/** Answer an over-cap export as an actionable 422; false when it is a real error. */
function sendExportTooLarge(res: any, err: unknown): boolean {
  if (err instanceof ExportTooLargeError) { res.status(422).json({ success: false, error: err.message }); return true; }
  return false;
}

/* ════════════════════════════════════════════════════════════════════════
 * Unified report export (O20) — GET /food/reports/export[.fmt]
 *
 * One endpoint serves every report widget. `?report=` selects which dataset to
 * render (orders | variance | waste | ontime); fmt (csv|pdf|xls) selects the
 * encoder. Scoping (resolveAccessiblePropertyIds + ?propertyId/?brand) and the
 * from/to filters mirror the per-report JSON endpoints, so an export reflects
 * exactly what the on-screen widget shows. `orders` reuses fetchOrdersForExport.
 *
 * #11: there are exactly TWO registrations and they are different PATHS, not
 * extension variants of one another — nothing here can shadow anything. Adding
 * a format is one entry in EXPORT_FORMATS; there is no literal route in front
 * of the wildcard that would silently keep serving the old set.
 * ════════════════════════════════════════════════════════════════════════ */

/** Allowlist of export extensions → the encoder literal. A `:fmt` that reached
 *  a filename or a Content-Type unvalidated is a header-injection shape, so the
 *  raw path segment is only ever used as a Map key: what leaves this table is
 *  one of three compile-time literals, never caller-controlled text. */
const EXPORT_FORMATS = new Map<string, "csv" | "pdf" | "xls">([
  ["csv", "csv"], ["pdf", "pdf"], ["xls", "xls"],
]);

/** Shared error tail for both registrations: over-cap → 422, anything else → 500. */
async function runReportExport(req: any, res: any, fmt: "csv" | "pdf" | "xls"): Promise<void> {
  try { await serveReportExport(req, res, fmt); }
  catch (err) { if (sendExportTooLarge(res, err)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
}

// The extensionless `/reports/export` is kept registered: it is the default-CSV
// URL external scripts and bookmarks were built against, and dropping it turned
// them into a bare 404 with no explanation.
foodOpsRouter.get("/reports/export", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  await runReportExport(req, res, "csv");
});

foodOpsRouter.get("/reports/export.:fmt", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  const fmt = EXPORT_FORMATS.get(String(req.params["fmt"] ?? "").toLowerCase());
  if (!fmt) {
    res.status(400).json({ success: false, error: "fmt must be csv, pdf or xls" }); return;
  }
  await runReportExport(req, res, fmt);
});

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Shared property/brand/date scope for the variance/waste/ontime export datasets. */
async function reportExportScope(req: any): Promise<{
  where: ReturnType<typeof and>; propertyName: string | null; dateRange: string | null; from?: Date; to?: Date;
}> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  // B5: same IST day bounds as the orders export and as the on-screen reports —
  // these files must cover exactly the service days the screen does.
  const { from: fromAt, to: toAt, fromRaw: from, toRaw: to } = exportWindow(req.query as Record<string, unknown>);
  const propertyId = req.query["propertyId"] as string | undefined;
  const brand = req.query["brand"] as string | undefined;
  const conds = [] as any[];
  if (ids !== null) conds.push(ids.length ? inArray(foodOrdersTable.propertyId, ids) : sql`false`);
  // Always bounded below (H11) — these three reports aggregate, so an unbounded
  // window does not blow up the ROW count, but it does scan the whole table.
  conds.push(gte(foodOrdersTable.serviceDate, fromAt));
  // LOW: exportWindow always bounds the upper end now (it mirrors periodRange),
  // so this is unconditional — a null `to` used to leave the export open-ended.
  conds.push(lte(foodOrdersTable.serviceDate, toAt));
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
    // M7: one line per meal × unit, and a Unit column, so the exported file says
    // the same thing as the on-screen table it mirrors.
    // C3: and the same UNCOUNTED-line rule. This scope is pinned to DELIVERED,
    // and a trip-delivered order carries receivedQty NULL on every line —
    // summing those as received = 0 against a full ordered quantity invented a
    // 100% shortfall against the kitchen in the downloaded file while the screen
    // reported them as unconfirmed. Only COUNTED lines enter ordered/received/
    // variance; the rest get their own column.
    const grouped = await db.select({
      mealType: foodOrdersTable.mealType,
      unit: foodOrderItemsTable.unit,
      ordered: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is not null), 0)::float`,
      received: sql<number>`coalesce(sum(${foodOrderItemsTable.receivedQty}), 0)::float`,
      wasted: sql<number>`coalesce(sum(${foodOrderItemsTable.wastedQty}), 0)::float`,
      unconfirmed: sql<number>`coalesce(sum(${foodOrderItemsTable.orderedQty}) filter (where ${foodOrderItemsTable.receivedQty} is null), 0)::float`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(where).groupBy(foodOrdersTable.mealType, foodOrderItemsTable.unit);
    const rows = MEAL_TYPES.flatMap((mt) => {
      const mealRows = grouped.filter((g) => g.mealType === mt);
      if (!mealRows.length) return [[mt, "", 0, 0, 0, 0, 0] as (string | number | null)[]];
      return mealRows.map((g) => {
        const ordered = r3(Number(g.ordered));
        const received = r3(Number(g.received));
        return [mt, g.unit, ordered, received, r3(ordered - received), r3(Number(g.wasted)), r3(Number(g.unconfirmed))] as (string | number | null)[];
      });
    });
    return {
      title: "Ordered vs Delivered Variance", headers: ["Meal", "Unit", "Ordered", "Received", "Variance", "Wasted", "Unconfirmed"],
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
      // reportExportScope pins DELIVERED, so `ordered` is ordered-on-delivered.
      return [d.dishName ?? "—", d.unit ?? "", ordered, wasted, `${wastePctOfOrdered(d.wasted, d.ordered)}%`];
    });
    return {
      // The column names its denominator — see the waste-percentage block above
      // /analytics. The waste-analytics file's column is "of received".
      title: "Top Waste Items", headers: ["Dish", "Unit", "Ordered", "Wasted", "Waste % (of ordered)"],
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

    // Up to 8 photos per property, served directly so cards don't call the
    // PROPERTIES-scoped /:id/photos route (which 403s every property beyond the
    // caller's own users.property_id). Order hero-first then lowest sort_order;
    // the first presigned URL per property is the hero (heroImageUrl === images[0]).
    const MAX_PHOTOS_PER_PROP = 8;
    const photoRows = await db
      .select({ propertyId: propertyPhotosTable.propertyId, storageKey: propertyPhotosTable.storageKey })
      .from(propertyPhotosTable)
      .where(inArray(propertyPhotosTable.propertyId, propIds))
      .orderBy(desc(propertyPhotosTable.isHero), asc(propertyPhotosTable.sortOrder));
    const photoKeysByProp = new Map<string, string[]>();
    for (const row of photoRows) {
      const keys = photoKeysByProp.get(row.propertyId) ?? [];
      if (keys.length < MAX_PHOTOS_PER_PROP) {
        keys.push(row.storageKey);
        photoKeysByProp.set(row.propertyId, keys);
      }
    }
    const imagesByProp = new Map<string, string[]>();
    const heroByProp = new Map<string, string | null>();
    for (const [pid, keys] of photoKeysByProp) {
      const urls: string[] = [];
      if (isStorageConfigured()) {
        for (const key of keys) {
          try {
            urls.push(await getObjectUrl(key));
          } catch {
            // Skip photos whose presign fails so one bad key doesn't drop the rest.
          }
        }
      }
      imagesByProp.set(pid, urls);
      heroByProp.set(pid, urls[0] ?? null);
    }

    const kitchens = await db.select({ id: kitchensTable.id, name: kitchensTable.name }).from(kitchensTable);
    const kitchenName = new Map(kitchens.map((k) => [k.id, k.name]));

    const guests = await db.select({ propertyId: residentsTable.propertyId, c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(inArray(residentsTable.propertyId, propIds), eq(residentsTable.status, "ACTIVE")))
      .groupBy(residentsTable.propertyId);
    const guestCount = new Map(guests.map((g) => [g.propertyId, g.c]));

    // M10: attribute each payment to the property it was COLLECTED at.
    const monthStart = istCurrentMonthStart();
    const revs = await db.select({ propertyId: collectedAtProperty, total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(inArray(collectedAtProperty, propIds), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)))
      .groupBy(collectedAtProperty);
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
        heroImageUrl: heroByProp.get(p.id) ?? null,
        images: imagesByProp.get(p.id) ?? [],
      };
    });
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * Next Orders board — for each accessible property, resolve the NEXT orderable
 * service day (tomorrow, or the day after if tomorrow's cut-off has passed), the
 * meals that have a menu that day, and which of them already have a LIVE order.
 * Powers the multi-property "Next Orders" command centre so a unit lead sees, in
 * one place, exactly which properties still need an order placed.
 */
foodOpsRouter.get("/next-orders", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const where = ids === null ? undefined : (ids.length ? inArray(propertiesTable.id, ids) : sql`false`);
    const props = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city,
      brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId,
    }).from(propertiesTable).where(where).orderBy(propertiesTable.name);
    if (!props.length) { res.json({ success: true, data: [] }); return; }
    const propIds = props.map((p) => p.id);

    // Active-guest headcount per property (seeds the builder's "Serving" count).
    const guests = await db.select({ propertyId: residentsTable.propertyId, c: sql<number>`count(*)::int` })
      .from(residentsTable).where(and(inArray(residentsTable.propertyId, propIds), eq(residentsTable.status, "ACTIVE")))
      .groupBy(residentsTable.propertyId);
    const guestCount = new Map(guests.map((g) => [g.propertyId, g.c]));

    // Enabled meal config — resolved once; gives per-meal display labels.
    const mealCfg = await db.select().from(foodMealConfigTable).where(eq(foodMealConfigTable.isEnabled, true)).orderBy(foodMealConfigTable.sortOrder);
    const labelByMeal = new Map(mealCfg.map((c) => [c.mealType, c.displayLabel]));

    const todayYmd = istDayYmd(new Date());
    const now = new Date();

    /* L2 — this board used to fan out over EVERY accessible property at once, each
     * callback issuing its own cut-off lookup, one resolveMenu per meal and an
     * orders select: ~10 concurrent queries per property, unbounded. The two
     * batchable reads are hoisted out (one cut-off query, one orders query for the
     * whole board), the menu resolutions are memoised — properties on the same
     * kitchen+brand share a plate, so the distinct work is per KITCHEN, not per
     * property — and what remains runs a few properties at a time. */
    const cutoffFor = await loadCutoffResolver(props.map((p) => p.brand).filter((b): b is string => !!b));

    // Live orders for the whole board in one query: a property's service day is
    // either tomorrow or the day after, so [tomorrow, today+3) covers every case
    // and each property filters its own day out of the map below.
    const boardStart = ymdToIstDayStart(addDaysYmd(todayYmd, 1));
    const boardEnd = ymdToIstDayStart(addDaysYmd(todayYmd, 3));
    const boardOrders = await db.select({
      propertyId: foodOrdersTable.propertyId, id: foodOrdersTable.id, orderNumber: foodOrdersTable.orderNumber,
      mealType: foodOrdersTable.mealType, status: foodOrdersTable.status, serviceDate: foodOrdersTable.serviceDate,
    }).from(foodOrdersTable).where(and(
      inArray(foodOrdersTable.propertyId, propIds),
      gte(foodOrdersTable.serviceDate, boardStart),
      lt(foodOrdersTable.serviceDate, boardEnd),
      notInArray(foodOrdersTable.status, ["CANCELLED", "REJECTED"]),
    ));
    const ordersByProp = new Map<string, typeof boardOrders>();
    for (const o of boardOrders) {
      const list = ordersByProp.get(o.propertyId) ?? [];
      list.push(o);
      ordersByProp.set(o.propertyId, list);
    }

    // One resolveMenu per distinct (kitchen, brand, meal, day) — shared by every
    // property that resolves to it, and by both workers when they race the key.
    const menuCache = new Map<string, Promise<unknown[]>>();
    const menuFor = (kitchenId: string, brand: string, mealType: string, sd: Date, ymd: string) => {
      const key = `${kitchenId}|${brand}|${mealType}|${ymd}`;
      let hit = menuCache.get(key);
      if (!hit) { hit = resolveMenu(kitchenId, brand, mealType, sd); menuCache.set(key, hit); }
      return hit;
    };

    const data = await mapLimit(props, 5, async (p) => {
      const { brand, kitchenId } = p;
      const configured = Boolean(brand && kitchenId);
      const activeGuests = guestCount.get(p.id) ?? 0;
      const base = { propertyId: p.id, name: p.name, city: p.city, brand, configured, activeGuests };
      if (!configured) {
        return { ...base, serviceDate: addDaysYmd(todayYmd, 1), cutoffTime: null, cutoffAt: null, isPastCutoff: false, availableMeals: [], orderedMeals: [], status: "NOT_CONFIGURED" as const };
      }

      // Resolve the next orderable IST day: tomorrow unless its (day-before-
      // anchored) cut-off has already passed, in which case the day after — whose
      // cut-off is a further day out and therefore still in the future.
      const cutoffTime = cutoffFor(brand!, p.id);
      let serviceYmd = addDaysYmd(todayYmd, 1);
      let cutoffAt = cutoffTime ? atIst(addDaysYmd(serviceYmd, -1), cutoffTime) : null;
      if (cutoffAt && now > cutoffAt) {
        serviceYmd = addDaysYmd(todayYmd, 2);
        cutoffAt = cutoffTime ? atIst(addDaysYmd(serviceYmd, -1), cutoffTime) : null;
      }
      const isPastCutoff = Boolean(cutoffAt && now > cutoffAt);
      const sd = ymdToIstDayStart(serviceYmd);
      const dayEnd = new Date(sd.getTime() + 24 * 60 * 60 * 1000);

      // Meals that have a resolvable menu for that day.
      const availableMeals: { mealType: string; label: string }[] = [];
      for (const c of mealCfg) {
        if (c.brand && c.brand !== brand) continue;
        const dishes = await menuFor(kitchenId!, brand!, c.mealType, sd, serviceYmd);
        if (dishes.length) availableMeals.push({ mealType: c.mealType, label: c.displayLabel });
      }

      // Live (non-cancelled/rejected) orders already on the books for that day —
      // this property's slice of the one board-wide read above.
      const existing = (ordersByProp.get(p.id) ?? []).filter(
        (o) => o.serviceDate >= sd && o.serviceDate < dayEnd,
      );
      const orderedMeals = existing.map((o) => ({
        mealType: o.mealType, orderId: o.id, orderNumber: o.orderNumber, status: o.status,
        label: labelByMeal.get(o.mealType) ?? o.mealType,
      }));
      const orderedSet = new Set<string>(orderedMeals.map((o) => o.mealType));

      let status: "NOT_ORDERED" | "PARTIAL" | "ORDERED" | "NO_MENU";
      if (!availableMeals.length) {
        status = orderedMeals.length ? "ORDERED" : "NO_MENU";
      } else if (orderedMeals.length === 0) {
        status = "NOT_ORDERED";
      } else {
        status = availableMeals.every((m) => orderedSet.has(m.mealType)) ? "ORDERED" : "PARTIAL";
      }

      return { ...base, serviceDate: serviceYmd, cutoffTime, cutoffAt: cutoffAt ? cutoffAt.toISOString() : null, isPastCutoff, availableMeals, orderedMeals, status };
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
    // M10: collections belong to the property they were taken at, not to wherever
    // the resident lives today.
    const monthStart = istCurrentMonthStart();
    const [rev] = await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(eq(collectedAtProperty, propertyId), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart)));
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
    // M9: the old form was `setMonth(getMonth() - 5)` with the day-of-month still
    // 31, so on the 29th–31st the rollover swallowed a month and the "6-month"
    // chart returned 5. Anchoring on the 1st of the IST month first makes the
    // month arithmetic exact on every day of every month.
    // M10: and the money is attributed to where it was collected.
    const since = atIst(istMonthStartYmd(istDayYmd(new Date()), -5), "00:00");
    const month = sql<string>`to_char(${paymentsTable.createdAt} + interval '330 minutes', 'YYYY-MM')`;
    const rows = await db.select({ month, total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)::float` })
      .from(paymentsTable).innerJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(and(eq(collectedAtProperty, propertyId), eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, since)))
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
    // L7: the term is a literal, not a pattern — see escapeLike. The KYC blind
    // index below matches on the RAW term because it is an exact HMAC lookup,
    // not a LIKE.
    const like = `%${escapeLike(search)}%`;
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
  // H11: same runaway guard as the report exports. An active-guest list has no
  // date dimension to bound it with, so the row cap IS the bound — an org-wide
  // caller with no ?propertyId selected every ACTIVE resident in the estate and
  // rendered them, inline, to PDF. Over the cap answers 422 naming the cap
  // (sendExportTooLarge) instead of stalling the event loop and then 500ing.
  const rows = await db.select({ r: residentsTable, propertyName: propertiesTable.name, roomNumber: roomsTable.number })
    .from(residentsTable).leftJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id))
    .leftJoin(roomsTable, eq(residentsTable.roomId, roomsTable.id)).where(where).orderBy(residentsTable.name)
    .limit(EXPORT_ROW_CAP + 1);
  if (rows.length > EXPORT_ROW_CAP) throw new ExportTooLargeError(EXPORT_ROW_CAP);
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

foodOpsRouter.get("/guests/export.csv", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    const csv = toCsv({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "csv")}`);
    res.send(csv);
  } catch (err) { if (sendExportTooLarge(res, err)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/guests/export.pdf", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    // H11: the PDF layout loop runs per cell — the one encoder worth refusing
    // rather than attempting. Same cap and same 422 as the report exports.
    if (out.rows.length > PDF_ROW_CAP) throw new ExportTooLargeError(PDF_ROW_CAP, "PDF");
    const pdf = await toPdf({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "pdf")}`);
    res.send(Buffer.from(pdf));
  } catch (err) { if (sendExportTooLarge(res, err)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodOpsRouter.get("/guests/export.xls", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  try {
    const out = await guestExportRows(req, res); if (!out) return;
    const xls = toXls({ title: "Active Guests", headers: GUEST_HEADERS, rows: out.rows, propertyName: out.propertyName });
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", `attachment; filename=${guestsFilename(out.propertyName, "xls")}`);
    res.send(xls);
  } catch (err) { if (sendExportTooLarge(res, err)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default foodOpsRouter;
