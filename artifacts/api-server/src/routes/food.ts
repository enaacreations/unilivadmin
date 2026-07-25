/**
 * Food Ordering & Kitchen Operations — HTTP routes.
 *
 * Mounts the full order lifecycle (place → prepare → dispatch → confirm →
 * waste), the kitchen aggregation summary, dashboard/reports, and the Settings
 * master-data CRUD. Shared business logic lives in lib/food-service.ts.
 *
 * Scoping: list/aggregate screens are restricted to the caller's accessible
 * property ids (null = all); mutations re-check the order's property against
 * that set and 403 when out of scope.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  foodOrdersTable,
  foodOrderItemsTable,
  foodOrderEventsTable,
  foodAdditionalOrderItemsTable,
  dishesTable,
  ingredientsTable,
  dishIngredientsTable,
  menuCompositionRuleTable,
  menuCompositionSlotTable,
  PREPARATIONS,
  foodMenuRotationTable,
  perResidentRuleTable,
  deliveryPartnersTable,
  agenciesTable,
  agencyLocationsTable,
  agencyVehiclesTable,
  zonesTable,
  citiesTable,
  clustersTable,
  userScopesTable,
  propertiesTable,
  usersTable,
  kitchensTable,
  foodDispatchesTable,
  foodBrandsTable,
  complaintsTable,
  agencyKitchensTable,
  foodOrderDraftsTable,
  foodOrderBatchesTable,
} from "@workspace/db";
import { and, eq, or, ilike, sql, desc, asc, gte, lte, lt, inArray, isNull, isNotNull } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { canTransition } from "../lib/order-transitions.js";
import { z } from "zod";
import { authenticate, authorize as requireRoles } from "../middlewares/auth.js";
import { authorize, authorizeAny } from "../middlewares/authorize.js";
import { can, type UserRole } from "../lib/permissions.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import {
  resolveAccessiblePropertyIds,
  scopeOrdersCondition,
  resolveMenu,
  computeOrderItems,
  nextOrderNumber,
  convertForDisplay,
  resolveExpectedDeliveryAt,
  getPropertyFoodConfig,
  resolveCompositionRule,
  validateMenuAgainstRule,
  loadDishesForValidation,
  autoFillMenu,
  detectSharedIngredients,
  buildCompositionVerdict,
  getWasteEditWindowMs,
} from "../lib/food-service.js";
import { notifyOrderEvent } from "../lib/notification-service.js";
import { toCsv, toPdf, fmtDate, fmtDateTime, fileDateStamp, sanitizeForFilename } from "../lib/export-service.js";
// Shared order cut-off enforcement (single source of truth lives in food-ops.ts,
// alongside resolveCutoff()/atTime()) so /orders and /order-batches stay consistent.
import { checkOrderCutoff, createDispatchForOrders, residentsCapForProperty } from "./food-ops.js";
import { ymdToIstDayStart, todayIstYmd } from "../lib/tz.js";

export const foodRouter: Router = Router();

/** Resolves a property's display name for notification context. */
async function propertyName(propertyId: string): Promise<string | null> {
  const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  return p?.name ?? null;
}

const BRANDS = ["UNILIV", "HUDDLE"] as const;
const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
const FOOD_USER_ROLES = [
  "UNIT_LEAD", "CLUSTER_MANAGER", "CITY_HEAD", "ZONAL_HEAD", "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT", "FNB_SUPERVISOR", "FNB_MANAGER", "FNB_ZONAL_HEAD",
] as const;

/** Parses a date query param; returns undefined for blank/invalid. */
function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Parses an order serviceDate as an IST CALENDAR date. A bare 'yyyy-MM-dd' is
 * anchored to 00:00 IST on that day (NOT host-local / UTC midnight) so the stored
 * serviceDate and the cut-off compare both reflect the intended IST day; values
 * that already carry a time component are passed through unchanged. Returns
 * undefined for blank/invalid input.
 */
function parseServiceDate(v: unknown): Date | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ymdToIstDayStart(s);
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

/** True if the order's property is within the caller's accessible set (null = all). */
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request-body validation (WS6)
 *
 * Additive zod gates on the mutating handlers below. Each gate runs BEFORE the
 * handler's existing body-reading code and only rejects malformed/missing-required
 * requests with a 400 — a currently-valid request still parses and flows through
 * the unchanged `req.body`/`b` logic. Schemas stay deliberately permissive
 * (free-text bounded, ids bounded, enums mirrored only where already hand-checked)
 * so we never reject a request the handler would previously have accepted.
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

// Reusable primitives.
const zId = z.string().min(1).max(128);
const zText = z.string().max(1000);
// Optional contact fields — treat "" as absent, otherwise enforce shape.
const zEmail = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().email("Enter a valid email address").max(256).nullish(),
);
const zPhone = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().max(32)
    .refine((s) => /^\+?[0-9\s\-()]+$/.test(s), "Phone may only contain digits, spaces and + - ( )")
    .refine((s) => { const d = s.replace(/\D/g, ""); return d.length >= 10 && d.length <= 15; }, "Enter a valid phone number (10–15 digits)")
    .nullish(),
);
const zMealType = z.enum(MEAL_TYPES);
// Free-form brand string (the brand master is admin-managed; handlers accept any
// configured code, so we only bound length rather than enum-restrict).
const zBrand = z.string().min(1).max(128);

/* ────────────────────────────────────────────────────────────────────────────
 * Dashboard
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/dashboard", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);

    const to = parseDate(req.query["to"]) ?? new Date();
    const from = parseDate(req.query["from"]) ?? new Date(to.getTime() - 30 * 86400000);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;

    const windowMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - windowMs);
    const prevTo = from;

    const baseConds = (lo: Date, hi: Date) => {
      const conds = [gte(foodOrdersTable.serviceDate, lo), lte(foodOrdersTable.serviceDate, hi)];
      if (scope) conds.push(scope);
      if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
      if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
      return and(...conds);
    };

    const aggFor = async (lo: Date, hi: Date) => {
      const [row] = await db.select({
        total: sql<number>`count(*) filter (where ${foodOrdersTable.status} <> 'CANCELLED')::int`,
        // "Active" = PLACED only (not ACCEPTED/DISPATCHED/etc.).
        active: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'PLACED')::int`,
        // "Awaiting Confirmation" = DISPATCHED (display-only top stat).
        awaitingConfirmation: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'DISPATCHED')::int`,
      }).from(foodOrdersTable).where(baseConds(lo, hi));
      return {
        total: row?.total ?? 0,
        active: row?.active ?? 0,
        awaitingConfirmation: row?.awaitingConfirmation ?? 0,
      };
    };

    // Prior-period status counts must be like-for-like: orders placed in the
    // prior window have almost always progressed past PLACED/DISPATCHED by now,
    // so counting by *current* status would make change-vs-prior meaningless.
    // Instead count each status by the transition timestamp that lands in the
    // prior window (PLACED→createdAt, DISPATCHED→dispatchedAt, DELIVERED→deliveredAt),
    // mirroring the eventual current-period counts.
    const prevAggFor = async (lo: Date, hi: Date) => {
      const baseScope = [] as ReturnType<typeof eq>[];
      if (scope) baseScope.push(scope);
      if (propertyId) baseScope.push(eq(foodOrdersTable.propertyId, propertyId));
      if (brand) baseScope.push(eq(foodOrdersTable.brand, brand as never));
      const scopeWhere = baseScope.length ? and(...baseScope) : undefined;
      const inWindow = (col: AnyColumn) =>
        sql`${col} >= ${lo} and ${col} <= ${hi}`;
      const [row] = await db.select({
        total: sql<number>`count(*) filter (where ${foodOrdersTable.status} <> 'CANCELLED' and ${inWindow(foodOrdersTable.serviceDate)})::int`,
        active: sql<number>`count(*) filter (where ${inWindow(foodOrdersTable.createdAt)})::int`,
        awaitingConfirmation: sql<number>`count(*) filter (where ${foodOrdersTable.dispatchedAt} is not null and ${inWindow(foodOrdersTable.dispatchedAt)})::int`,
      }).from(foodOrdersTable).where(scopeWhere);
      return {
        total: row?.total ?? 0,
        active: row?.active ?? 0,
        awaitingConfirmation: row?.awaitingConfirmation ?? 0,
      };
    };

    const cur = await aggFor(from, to);
    const prev = await prevAggFor(prevFrom, prevTo);
    const pct = (c: number, p: number) => (p === 0 ? (c > 0 ? 100 : 0) : Math.round(((c - p) / p) * 1000) / 10);

    // Variance: orders with a kg ordered-vs-received variance (>=1 item whose
    // receivedQty IS NOT NULL and receivedQty <> orderedQty), counted by the
    // order's deliveredAt within each period window. FY = current Apr–Mar.
    const varScope = [] as ReturnType<typeof eq>[];
    if (scope) varScope.push(scope);
    if (propertyId) varScope.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) varScope.push(eq(foodOrdersTable.brand, brand as never));
    const now = new Date();
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1, 0, 0, 0, 0);
    const varianceFrom = (months: number) => new Date(now.getTime() - months * 30 * 86400000);
    const varianceCount = async (lo: Date) => {
      const conds = [
        isNotNull(foodOrdersTable.deliveredAt),
        gte(foodOrdersTable.deliveredAt, lo),
        lte(foodOrdersTable.deliveredAt, now),
        isNotNull(foodOrderItemsTable.receivedQty),
        sql`${foodOrderItemsTable.receivedQty} <> ${foodOrderItemsTable.orderedQty}`,
        ...varScope,
      ];
      const [row] = await db.select({ c: sql<number>`count(distinct ${foodOrdersTable.id})::int` })
        .from(foodOrdersTable)
        .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
        .where(and(...conds));
      return row?.c ?? 0;
    };
    const variance = {
      m1: await varianceCount(varianceFrom(1)),
      m3: await varianceCount(varianceFrom(3)),
      m6: await varianceCount(varianceFrom(6)),
      fy: await varianceCount(fyStart),
    };

    // Pending actions (current scope, not time-bounded).
    const pendConds = [] as ReturnType<typeof eq>[];
    if (scope) pendConds.push(scope);
    if (propertyId) pendConds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) pendConds.push(eq(foodOrdersTable.brand, brand as never));
    const pendWhere = pendConds.length ? and(...pendConds) : undefined;

    const [pendRow] = await db.select({
      awaitingDispatch: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'ACCEPTED')::int`,
    }).from(foodOrdersTable).where(pendWhere);

    // Waste pending: DELIVERED, window has OPENED (cool-down elapsed), with
    // any item missing wastedQty.
    const wasteConds = [
      eq(foodOrdersTable.status, "DELIVERED"),
      lte(foodOrdersTable.wasteEditableUntil, new Date()),
      isNull(foodOrderItemsTable.wastedQty),
    ];
    if (scope) wasteConds.push(scope);
    if (propertyId) wasteConds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) wasteConds.push(eq(foodOrdersTable.brand, brand as never));
    const [wasteRow] = await db.select({
      c: sql<number>`count(distinct ${foodOrdersTable.id})::int`,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .where(and(...wasteConds));

    res.json({
      success: true,
      data: {
        kpis: {
          totalOrders: { value: cur.total, changePct: pct(cur.total, prev.total) },
          active: { value: cur.active, changePct: pct(cur.active, prev.active) },
          awaitingConfirmation: { value: cur.awaitingConfirmation, changePct: pct(cur.awaitingConfirmation, prev.awaitingConfirmation) },
          variance,
        },
        pendingActions: {
          awaitingDispatch: pendRow?.awaitingDispatch ?? 0,
          wastePending: wasteRow?.c ?? 0,
        },
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * Waste-pending rows for the dashboard table: DELIVERED orders still within the
 * waste-edit window that have at least one item missing wastedQty. Scoped to the
 * caller's accessible properties. Each row carries the absolute wasteEditableUntil
 * so the client can render a live "NN min left" countdown.
 */
foodRouter.get("/waste-pending", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;

    const conds = [
      eq(foodOrdersTable.status, "DELIVERED"),
      // Cool-down semantics: pending once the window has OPENED.
      lte(foodOrdersTable.wasteEditableUntil, new Date()),
      isNull(foodOrderItemsTable.wastedQty),
    ];
    if (scope) conds.push(scope);
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));

    const rows = await db.select({
      orderId: foodOrdersTable.id,
      orderNumber: foodOrdersTable.orderNumber,
      propertyName: propertiesTable.name,
      mealType: foodOrdersTable.mealType,
      deliveredAt: foodOrdersTable.deliveredAt,
      wasteEditableUntil: foodOrdersTable.wasteEditableUntil,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .where(and(...conds))
      .groupBy(
        foodOrdersTable.id,
        foodOrdersTable.orderNumber,
        propertiesTable.name,
        foodOrdersTable.mealType,
        foodOrdersTable.deliveredAt,
        foodOrdersTable.wasteEditableUntil,
      )
      .orderBy(asc(foodOrdersTable.wasteEditableUntil))
      .limit(100);

    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Orders
 * ──────────────────────────────────────────────────────────────────────────── */

// Shared order-list: the All Orders page (FOOD_ALL_ORDERS), the Dispatch queue
// (FOOD_DISPATCH) and the Kitchen board's open-orders panel (FOOD_KITCHEN_SUMMARY)
// all read from here. Gate on any of those so operational roles (F&B managers,
// who have no "All Orders" page) can still load the orders they act on.
//
// Two limits keep operational access from becoming full order-ledger access:
//   • property scope — resolveAccessiblePropertyIds below (note: F&B roles are in
//     the broad-fallback set, so an UNSCOPED F&B user still sees all properties —
//     scope only narrows once they have scope rows / a home property); and
//   • status — callers WITHOUT FOOD_ALL_ORDERS are clamped to the live pipeline
//     (PLACED/ACCEPTED/DISPATCHED) and never see terminal history
//     (DELIVERED/CANCELLED/REJECTED), which stays FOOD_ALL_ORDERS-only. That
//     mirrors the sibling /orders/:id and /orders/track restrictions.
const OPERATIONAL_ORDER_STATUSES = ["PLACED", "ACCEPTED", "DISPATCHED"];
foodRouter.get("/orders", authenticate, authorizeAny(["FOOD_ALL_ORDERS", "FOOD_DISPATCH", "FOOD_KITCHEN_SUMMARY"], "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);

    const status = req.query["status"] as string | undefined;
    const from = parseDate(req.query["from"]);
    const to = parseDate(req.query["to"]);
    // Exact-match service-date filter (yyyy-MM-dd). serviceDate is a timestamp
    // anchored to IST day-start, so match the half-open IST day window.
    const serviceDate = req.query["serviceDate"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const search = req.query["search"] as string | undefined;

    // status accepts a single value or a CSV of statuses.
    let statuses = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : [];

    // Clamp non-FOOD_ALL_ORDERS callers to the operational pipeline: intersect an
    // explicit status filter with the allowlist, or default to it when none given.
    // If the caller asked ONLY for restricted statuses, the intersection is empty
    // → return nothing rather than silently widening to the whole pipeline.
    if (!can(req.user!.role as UserRole, "FOOD_ALL_ORDERS", "view")) {
      const requested = statuses.length ? statuses : OPERATIONAL_ORDER_STATUSES;
      statuses = requested.filter((s) => OPERATIONAL_ORDER_STATUSES.includes(s));
      if (statuses.length === 0) {
        res.json({ success: true, data: [], meta: buildMeta(0, page, limit) });
        return;
      }
    }

    const conds = [] as ReturnType<typeof eq>[];
    if (scope) conds.push(scope);
    if (statuses.length === 1) conds.push(eq(foodOrdersTable.status, statuses[0] as never));
    else if (statuses.length > 1) conds.push(inArray(foodOrdersTable.status, statuses as never[]));
    if (serviceDate && /^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      const dayStart = ymdToIstDayStart(serviceDate);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      conds.push(gte(foodOrdersTable.serviceDate, dayStart));
      conds.push(lt(foodOrdersTable.serviceDate, dayEnd));
    }
    if (from) conds.push(gte(foodOrdersTable.serviceDate, from));
    if (to) conds.push(lte(foodOrdersTable.serviceDate, to));
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
    if (mealType) conds.push(eq(foodOrdersTable.mealType, mealType as never));
    if (search) conds.push(ilike(foodOrdersTable.orderNumber, `%${search}%`));
    const where = conds.length ? and(...conds) : undefined;

    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(foodOrdersTable).where(where);
    const rows = await db.select({
      o: foodOrdersTable,
      propertyName: propertiesTable.name,
      unitLeadName: usersTable.name,
      batchNumber: foodOrderBatchesTable.batchNumber,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .leftJoin(foodOrderBatchesTable, eq(foodOrdersTable.batchId, foodOrderBatchesTable.id))
      .where(where)
      .orderBy(desc(foodOrdersTable.createdAt))
      .limit(limit).offset(offset);

    const data = rows.map((r) => ({
      ...r.o,
      totalQuantity: r.o.totalQuantity != null ? Number(r.o.totalQuantity) : null,
      propertyName: r.propertyName,
      unitLeadName: r.unitLeadName,
      batchNumber: r.batchNumber,
    }));
    res.json({ success: true, data, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const placeOrderSchema = z.object({
  propertyId: zId,
  mealType: zMealType,
  serviceDate: z.union([z.string(), z.number(), z.coerce.date()]),
  quantity: z.coerce.number(),
  residentsCount: z.coerce.number().nullish(),
  notes: zText.nullish(),
}).passthrough();

foodRouter.post("/orders", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    if (!validateBody(placeOrderSchema, req, res)) return;
    const b = req.body || {};
    const { propertyId, mealType, serviceDate, quantity, residentsCount, notes } = b;
    if (!propertyId || !mealType || !serviceDate || quantity == null) {
      res.status(400).json({ success: false, error: "propertyId, mealType, serviceDate, quantity required" });
      return;
    }
    if (!(MEAL_TYPES as readonly string[]).includes(mealType)) { res.status(400).json({ success: false, error: `Invalid mealType: ${mealType}` }); return; }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) { res.status(400).json({ success: false, error: "quantity must be a positive number" }); return; }
    // serviceDate is an IST calendar date; anchor a bare 'yyyy-MM-dd' to IST so
    // the cut-off compare (in checkOrderCutoff) is correct regardless of host tz.
    const sd = parseServiceDate(serviceDate);
    if (!sd) { res.status(400).json({ success: false, error: "Invalid serviceDate" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }

    // Brand + kitchen are inherited from the property.
    const { brand, kitchenId } = await getPropertyFoodConfig(propertyId);
    if (!brand || !kitchenId) { res.status(422).json({ success: false, error: "This property is not configured for ordering (missing brand or kitchen)." }); return; }

    // Enforce the order cut-off server-side (past date / past cut-off → 422).
    const cutoffError = await checkOrderCutoff(brand, propertyId, sd);
    if (cutoffError) { res.status(422).json({ success: false, error: cutoffError }); return; }

    const residents = residentsCount != null ? Number(residentsCount) : qty;
    const computed = await computeOrderItems(kitchenId, brand, mealType, sd, qty);
    const expDelivery = await resolveExpectedDeliveryAt(brand, mealType, sd, propertyId);

    // Insert order with order-number retry on unique violation.
    let order: typeof foodOrdersTable.$inferSelect | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = await nextOrderNumber();
      try {
        [order] = await db.insert(foodOrdersTable).values({
          id: newId(),
          orderNumber,
          propertyId,
          brand,
          kitchenId,
          mealType,
          unitLeadId: req.user!.id,
          residentsCount: residents,
          totalQuantity: String(qty),
          status: "PLACED",
          serviceDate: sd,
          expectedDeliveryAt: expDelivery,
          notes: notes ?? null,
          createdById: req.user!.id,
          updatedAt: new Date(),
        }).returning();
        break;
      } catch (e) {
        lastErr = e;
        if (!String((e as Error)?.message || "").toLowerCase().includes("unique")) throw e;
      }
    }
    if (!order) { req.log.error(lastErr); res.status(500).json({ success: false, error: "Failed to generate order number" }); return; }

    let items: typeof foodOrderItemsTable.$inferSelect[] = [];
    if (computed.length) {
      items = await db.insert(foodOrderItemsTable).values(computed.map((it) => ({
        id: newId(),
        orderId: order!.id,
        dishId: it.dishId,
        unit: it.unit as never,
        personsCount: residents,
        orderedQty: String(it.orderedQty),
        updatedAt: new Date(),
      }))).returning();
    }

    await db.insert(foodOrderEventsTable).values({
      id: newId(),
      orderId: order.id,
      status: "PLACED",
      note: "Order placed",
      actorId: req.user!.id,
    });

    await notifyOrderEvent("PLACED", {
      unitLeadId: order.unitLeadId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId),
      mealType: order.mealType,
      brand: order.brand,
    });

    res.status(201).json({ success: true, data: { ...order, totalQuantity: order.totalQuantity != null ? Number(order.totalQuantity) : null, items } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Order drafts (server-side, per USER)
 *
 * Persists a unit lead's in-progress Place-Order form so drafts survive
 * browser/device switches. Keyed (userId, propertyId, serviceDate) — always
 * scoped to the AUTHENTICATED user; the payload is opaque frontend state
 * (size-capped, never interpreted server-side). serviceDate is a bare
 * 'yyyy-MM-dd' IST calendar day, anchored to 00:00 IST exactly like
 * food_orders.service_date so upsert/lookup equality is exact.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Max serialized draft payload size (bytes of JSON text). */
const DRAFT_PAYLOAD_MAX_BYTES = 64 * 1024;

const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "serviceDate must be yyyy-MM-dd");

const putDraftSchema = z.object({
  propertyId: zId,
  serviceDate: zYmd,
  payload: z.unknown(),
}).passthrough();

/** Parses the ?propertyId=&serviceDate= pair shared by GET/DELETE; 400s on failure. */
function parseDraftKey(req: { query: Record<string, unknown> }, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): { propertyId: string; serviceDate: Date } | null {
  const propertyId = req.query["propertyId"];
  const sdRaw = req.query["serviceDate"];
  if (typeof propertyId !== "string" || !propertyId) {
    res.status(400).json({ success: false, error: "propertyId required" });
    return null;
  }
  if (typeof sdRaw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sdRaw)) {
    res.status(400).json({ success: false, error: "serviceDate must be yyyy-MM-dd" });
    return null;
  }
  return { propertyId, serviceDate: ymdToIstDayStart(sdRaw) };
}

foodRouter.get("/order-draft", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    const key = parseDraftKey(req, res);
    if (!key) return;
    const [row] = await db.select({
      payload: foodOrderDraftsTable.payload,
      updatedAt: foodOrderDraftsTable.updatedAt,
    }).from(foodOrderDraftsTable).where(and(
      eq(foodOrderDraftsTable.userId, req.user!.id),
      eq(foodOrderDraftsTable.propertyId, key.propertyId),
      eq(foodOrderDraftsTable.serviceDate, key.serviceDate),
    ));
    res.json({
      success: true,
      data: row ? { payload: row.payload, updatedAt: row.updatedAt.toISOString() } : null,
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/order-draft", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    if (!validateBody(putDraftSchema, req, res)) return;
    const { propertyId, serviceDate, payload } = req.body as {
      propertyId: string; serviceDate: string; payload: unknown;
    };
    if (payload === undefined) { res.status(400).json({ success: false, error: "payload required" }); return; }
    // Cap the stored draft size (opaque jsonb — bound it so drafts can't balloon).
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > DRAFT_PAYLOAD_MAX_BYTES) {
      res.status(413).json({ success: false, error: "payload too large (max 64KB)" });
      return;
    }
    const sd = ymdToIstDayStart(serviceDate);

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }

    const now = new Date();
    const [row] = await db.insert(foodOrderDraftsTable).values({
      id: newId(),
      userId: req.user!.id,
      propertyId,
      serviceDate: sd,
      payload,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [foodOrderDraftsTable.userId, foodOrderDraftsTable.propertyId, foodOrderDraftsTable.serviceDate],
      set: { payload, updatedAt: now },
    }).returning({ updatedAt: foodOrderDraftsTable.updatedAt });

    // Opportunistic sweep: drop this user's drafts for past IST service days so
    // stale drafts don't pile up (no cron needed; runs on every save).
    await db.delete(foodOrderDraftsTable).where(and(
      eq(foodOrderDraftsTable.userId, req.user!.id),
      lt(foodOrderDraftsTable.serviceDate, ymdToIstDayStart(todayIstYmd())),
    ));

    res.json({ success: true, data: { updatedAt: row!.updatedAt.toISOString() } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Called after a successful order placement to clear the saved draft.
foodRouter.delete("/order-draft", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    const key = parseDraftKey(req, res);
    if (!key) return;
    await db.delete(foodOrderDraftsTable).where(and(
      eq(foodOrderDraftsTable.userId, req.user!.id),
      eq(foodOrderDraftsTable.propertyId, key.propertyId),
      eq(foodOrderDraftsTable.serviceDate, key.serviceDate),
    ));
    res.json({ success: true, data: null });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Static routes BEFORE param routes.
const dispatchBulkSchema = z.object({
  orderIds: z.array(zId).optional(),
  deliveryPartnerId: zId.nullish(),
}).passthrough();

foodRouter.post("/orders/dispatch/bulk", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(dispatchBulkSchema, req, res)) return;
    const b = req.body || {};
    const orderIds: string[] = Array.isArray(b.orderIds) ? b.orderIds : [];
    const deliveryPartnerId = b.deliveryPartnerId as string | undefined;
    if (!orderIds.length) { res.status(400).json({ success: false, error: "orderIds required" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    const orders = await db.select().from(foodOrdersTable).where(inArray(foodOrdersTable.id, orderIds));
    const byId = new Map(orders.map((o) => [o.id, o]));
    const results: Array<{ orderId: string; status: "DISPATCHED" | "SKIPPED" | "FORBIDDEN" | "NOT_FOUND"; reason?: string }> = [];

    for (const oid of orderIds) {
      const o = byId.get(oid);
      if (!o) { results.push({ orderId: oid, status: "NOT_FOUND" }); continue; }
      if (!isAccessible(o.propertyId, ids)) { results.push({ orderId: oid, status: "FORBIDDEN" }); continue; }
      if (!canTransition(o.status, "DISPATCHED")) {
        results.push({ orderId: oid, status: "SKIPPED", reason: `Order is ${o.status} (must be ACCEPTED)` });
        continue;
      }
      // C8: route through the shared helper so every dispatched order gets a
      // dispatch row (status LOADING) + dispatchId + a dispatch audit event.
      // Each order may carry its own delivery partner / kitchen, so we create one
      // single-order trip per order — preserving the per-order result reporting.
      await db.transaction(async (tx) => {
        await createDispatchForOrders(tx, {
          orderIds: [oid],
          agencyId: deliveryPartnerId ?? o.deliveryPartnerId ?? null,
          kitchenId: o.kitchenId ?? null,
          actorId: req.user!.id,
        });
        await tx.insert(foodOrderEventsTable).values({
          id: newId(), orderId: oid, status: "DISPATCHED", note: "Order dispatched", actorId: req.user!.id,
        });
      });
      results.push({ orderId: oid, status: "DISPATCHED" });
    }
    res.json({ success: true, data: { results } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * Standalone order-tracking lookup (WS9). Resolve an order by its human order
 * number (e.g. ORD-2026-000001) OR raw id, returning the same detail payload as
 * GET /orders/:id. Scoped to the caller's accessible properties, so a user can
 * only track orders in properties they can see. Used by the /food/track page.
 */
foodRouter.get("/orders/track", authenticate, authorize("FOOD_ALL_ORDERS", "view"), async (req, res) => {
  try {
    const orderNumber = String(req.query["orderNumber"] ?? "").trim();
    const rawId = String(req.query["id"] ?? "").trim();
    const term = orderNumber || rawId;
    if (!term) { res.status(400).json({ success: false, error: "orderNumber or id required" }); return; }

    const [match] = await db.select({ id: foodOrdersTable.id, propertyId: foodOrdersTable.propertyId })
      .from(foodOrdersTable)
      .where(or(
        eq(foodOrdersTable.id, term),
        ilike(foodOrdersTable.orderNumber, term),
      ))
      .limit(1);
    if (!match) { res.status(404).json({ success: false, error: "No order found for that number." }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(match.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }

    const [row] = await db.select({
      o: foodOrdersTable,
      propertyName: propertiesTable.name,
      unitLeadName: usersTable.name,
      deliveryPartnerName: agenciesTable.name,
      kitchen: kitchensTable,
      dispatch: foodDispatchesTable,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .leftJoin(agenciesTable, eq(foodOrdersTable.deliveryPartnerId, agenciesTable.id))
      .leftJoin(kitchensTable, eq(foodOrdersTable.kitchenId, kitchensTable.id))
      .leftJoin(foodDispatchesTable, eq(foodOrdersTable.dispatchId, foodDispatchesTable.id))
      .where(eq(foodOrdersTable.id, match.id));

    const items = await db.select({
      it: foodOrderItemsTable,
      dishName: dishesTable.name,
      component: dishesTable.component,
    }).from(foodOrderItemsTable)
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(eq(foodOrderItemsTable.orderId, match.id));

    const events = await db.select().from(foodOrderEventsTable)
      .where(eq(foodOrderEventsTable.orderId, match.id))
      .orderBy(asc(foodOrderEventsTable.createdAt));

    res.json({
      success: true,
      data: {
        ...row!.o,
        totalQuantity: row!.o.totalQuantity != null ? Number(row!.o.totalQuantity) : null,
        propertyName: row!.propertyName,
        unitLeadName: row!.unitLeadName,
        deliveryPartnerName: row!.deliveryPartnerName,
        kitchen: row!.kitchen ?? null,
        dispatch: row!.dispatch ?? null,
        items: items.map((r) => ({
          ...r.it,
          dishName: r.dishName,
          component: r.component,
          orderedQty: r.it.orderedQty != null ? Number(r.it.orderedQty) : null,
          preparedQty: r.it.preparedQty != null ? Number(r.it.preparedQty) : null,
          receivedQty: r.it.receivedQty != null ? Number(r.it.receivedQty) : null,
          wastedQty: r.it.wastedQty != null ? Number(r.it.wastedQty) : null,
        })),
        events,
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.get("/orders/:id", authenticate, authorize("FOOD_ALL_ORDERS", "view"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [row] = await db.select({
      o: foodOrdersTable,
      propertyName: propertiesTable.name,
      unitLeadName: usersTable.name,
      deliveryPartnerName: agenciesTable.name,
      kitchen: kitchensTable,
      dispatch: foodDispatchesTable,
      batchNumber: foodOrderBatchesTable.batchNumber,
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .leftJoin(agenciesTable, eq(foodOrdersTable.deliveryPartnerId, agenciesTable.id))
      .leftJoin(kitchensTable, eq(foodOrdersTable.kitchenId, kitchensTable.id))
      .leftJoin(foodDispatchesTable, eq(foodOrdersTable.dispatchId, foodDispatchesTable.id))
      .leftJoin(foodOrderBatchesTable, eq(foodOrdersTable.batchId, foodOrderBatchesTable.id))
      .where(eq(foodOrdersTable.id, id));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(row.o.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }

    const items = await db.select({
      it: foodOrderItemsTable,
      dishName: dishesTable.name,
      component: dishesTable.component,
    }).from(foodOrderItemsTable)
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(eq(foodOrderItemsTable.orderId, id));

    const events = await db.select().from(foodOrderEventsTable)
      .where(eq(foodOrderEventsTable.orderId, id))
      .orderBy(asc(foodOrderEventsTable.createdAt));

    // Additional Food — top-up sourced from other properties after receipt,
    // grouped into "additional orders" by requestId (one source property each).
    const addlRows = await db.select({
      a: foodAdditionalOrderItemsTable,
      dishName: dishesTable.name,
      sourcePropertyName: propertiesTable.name,
    }).from(foodAdditionalOrderItemsTable)
      .leftJoin(dishesTable, eq(foodAdditionalOrderItemsTable.dishId, dishesTable.id))
      .leftJoin(propertiesTable, eq(foodAdditionalOrderItemsTable.sourcePropertyId, propertiesTable.id))
      .where(eq(foodAdditionalOrderItemsTable.orderId, id))
      .orderBy(asc(foodAdditionalOrderItemsTable.createdAt));
    const additionalFood: Array<{
      requestId: string; sourcePropertyId: string; sourcePropertyName: string | null; createdAt: Date;
      items: Array<{ dishId: string; dishName: string | null; qty: number; unit: string }>;
    }> = [];
    const addlByReq = new Map<string, number>();
    for (const r of addlRows) {
      let idx = addlByReq.get(r.a.requestId);
      if (idx == null) {
        idx = additionalFood.length;
        addlByReq.set(r.a.requestId, idx);
        additionalFood.push({
          requestId: r.a.requestId, sourcePropertyId: r.a.sourcePropertyId,
          sourcePropertyName: r.sourcePropertyName, createdAt: r.a.createdAt, items: [],
        });
      }
      additionalFood[idx]!.items.push({
        dishId: r.a.dishId, dishName: r.dishName, qty: Number(r.a.qty), unit: r.a.unit,
      });
    }

    res.json({
      success: true,
      data: {
        ...row.o,
        totalQuantity: row.o.totalQuantity != null ? Number(row.o.totalQuantity) : null,
        propertyName: row.propertyName,
        unitLeadName: row.unitLeadName,
        deliveryPartnerName: row.deliveryPartnerName,
        kitchen: row.kitchen ?? null,
        dispatch: row.dispatch ?? null,
        batchNumber: row.batchNumber,
        items: items.map((r) => ({
          ...r.it,
          dishName: r.dishName,
          component: r.component,
          orderedQty: r.it.orderedQty != null ? Number(r.it.orderedQty) : null,
          preparedQty: r.it.preparedQty != null ? Number(r.it.preparedQty) : null,
          receivedQty: r.it.receivedQty != null ? Number(r.it.receivedQty) : null,
          wastedQty: r.it.wastedQty != null ? Number(r.it.wastedQty) : null,
        })),
        events,
        additionalFood,
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Additional Food — a LOG of top-up food sourced from ANOTHER property AFTER an
// order is received (the real coordination is offline). It is NOT an order: no
// lifecycle, no cap, no approval, no notification. Each submission is one
// "additional order" (a shared requestId) with one source property and one row
// per dish (qty > 0). The received view sums received + these per dish.
const additionalFoodSchema = z.object({
  sourcePropertyId: zId,
  items: z.array(z.object({
    dishId: zId,
    qty: z.coerce.number().positive().finite(),
  })).min(1),
}).passthrough();

foodRouter.post("/orders/:id/additional-food", authenticate, authorize("FOOD_CONFIRM_DELIVERY", "edit"), async (req, res) => {
  try {
    if (!validateBody(additionalFoodSchema, req, res)) return;
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "DELIVERED") {
      res.status(422).json({ success: false, error: "Additional food can only be logged after the order is received." });
      return;
    }
    const b = req.body as { sourcePropertyId: string; items: { dishId: string; qty: number }[] };
    const [src] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.id, b.sourcePropertyId));
    if (!src) { res.status(400).json({ success: false, error: "Unknown source property" }); return; }
    // Canonical unit comes from the dish (never trust the client for it).
    const dishRows = await db.select({ id: dishesTable.id, unit: dishesTable.unit })
      .from(dishesTable).where(inArray(dishesTable.id, b.items.map((it) => it.dishId)));
    const unitOf = new Map(dishRows.map((d) => [d.id, d.unit]));
    if (b.items.some((it) => !unitOf.has(it.dishId))) {
      res.status(400).json({ success: false, error: "Unknown dish" }); return;
    }
    const requestId = newId();
    const now = new Date();
    await db.insert(foodAdditionalOrderItemsTable).values(
      b.items.filter((it) => it.qty > 0).map((it) => ({
        id: newId(), orderId: id, requestId, sourcePropertyId: b.sourcePropertyId,
        dishId: it.dishId, unit: unitOf.get(it.dishId)!, qty: String(it.qty),
        createdById: req.user!.id, createdAt: now,
      })),
    );
    res.json({ success: true, data: { requestId } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Flat property list (id / name / city) for the Additional Food source picker.
// Any food user who can receive an order may read it — names only, not sensitive.
foodRouter.get("/property-options", authenticate, authorize("FOOD_CONFIRM_DELIVERY", "view"), async (req, res) => {
  try {
    const rows = await db.select({ id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city })
      .from(propertiesTable).orderBy(propertiesTable.city, propertiesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Edit an order. The ONLY editable input is the people count (`residentsCount`) —
// the number of residents the meal is being prepared for, which is the per-person
// basis that drives every item's quantity. Item quantities / totalQuantity supplied
// by the client are IGNORED; we recompute them SERVER-SIDE via computeOrderItems,
// exactly like place-order, so the order stays internally consistent. `notes` is
// also editable. Allowed while PLACED / ACCEPTED / DISPATCHED (never once
// CANCELLED / DELIVERED / REJECTED).
const updateOrderSchema = z.object({
  residentsCount: z.coerce.number().nullish(),
  // Staff eating the same meal. Items are recomputed on the TOTAL (residents +
  // staff); both counts persist separately (Approach A). Omitting either leaves
  // the order's current value for that count untouched.
  staffCount: z.coerce.number().nullish(),
  notes: zText.nullish(),
}).passthrough();

foodRouter.put("/orders/:id", authenticate, authorize("FOOD_PLACE_ORDER", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateOrderSchema, req, res)) return;
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "PLACED" && order.status !== "ACCEPTED" && order.status !== "DISPATCHED") {
      res.status(422).json({ success: false, error: "Order can only be edited while PLACED, ACCEPTED or DISPATCHED" });
      return;
    }

    const b = req.body || {};
    const update: Record<string, unknown> = { updatedAt: new Date() };

    // No headcount edits to a still-PLACED order once the ordering cut-off has
    // passed — the unit lead's editing window closes at the cut-off. Orders the
    // kitchen has already ACCEPTED/DISPATCHED are corrected through the
    // post-dispatch recompute path below (fewer residents showed up, etc.), which
    // is deliberately NOT gated on the cut-off; otherwise that path is dead since
    // dispatch always happens after the cut-off.
    if ((b.residentsCount != null || b.staffCount != null) && order.status === "PLACED") {
      const cutoffError = await checkOrderCutoff(order.brand, order.propertyId, order.serviceDate);
      if (cutoffError) { res.status(422).json({ success: false, error: `This order can no longer be edited — ${cutoffError}` }); return; }
    }

    // People count drives item quantities. Staff eat the same food, so the basis
    // that scales every item is the TOTAL (residents + staff); the residents/staff
    // split is persisted separately (Approach A). Each count defaults to the order's
    // current value when the client omits it, so a residents-only (or staff-only)
    // edit leaves the other untouched. Items recompute only when the TOTAL changes.
    const prevResidents = order.residentsCount != null ? Number(order.residentsCount) : Number(order.totalQuantity);
    const prevStaff = order.staffCount != null ? Number(order.staffCount) : 0;
    const prevPeople = prevResidents + prevStaff;
    let residents = prevResidents;
    let staff = prevStaff;
    let recompute = false;
    if (b.residentsCount != null) {
      residents = Number(b.residentsCount);
      if (!Number.isFinite(residents) || residents < 0) { res.status(400).json({ success: false, error: "residentsCount must be a non-negative number" }); return; }
      if (residents !== prevResidents) {
        const { occupancy, cap } = await residentsCapForProperty(order.propertyId);
        if (residents > cap) { res.status(422).json({ success: false, error: `Residents (${residents}) exceed the ${cap} limit — at most 120% of your ${occupancy} occupied residents.` }); return; }
      }
    }
    if (b.staffCount != null) {
      staff = Number(b.staffCount);
      if (!Number.isFinite(staff) || staff < 0) { res.status(400).json({ success: false, error: "staffCount must be a non-negative number" }); return; }
    }
    const people = residents + staff;
    if (b.residentsCount != null || b.staffCount != null) {
      if (!Number.isFinite(people) || people <= 0) { res.status(400).json({ success: false, error: "residents + staff must be a positive number" }); return; }
      if (residents !== prevResidents || staff !== prevStaff) {
        update["residentsCount"] = residents;
        update["staffCount"] = staff;
        update["totalQuantity"] = String(people);
      }
      if (people !== prevPeople) recompute = true;
    }
    if (b.notes !== undefined) update["notes"] = b.notes ?? null;

    const [updated] = await db.update(foodOrdersTable).set(update as Partial<typeof foodOrdersTable.$inferInsert>).where(eq(foodOrdersTable.id, id)).returning();

    if (recompute) {
      // Recompute items server-side from the new people count, mirroring place-order.
      const computed = await computeOrderItems(order.kitchenId, order.brand, order.mealType, order.serviceDate, people);
      await db.delete(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
      if (computed.length) {
        await db.insert(foodOrderItemsTable).values(computed.map((it) => ({
          id: newId(),
          orderId: id,
          dishId: it.dishId,
          unit: it.unit as never,
          personsCount: people,
          orderedQty: String(it.orderedQty),
          updatedAt: new Date(),
        })));
      }
    }

    // Editing an already-DISPATCHED order is sensitive: the kitchen/driver are already
    // committed. Record an audit/timeline event and best-effort notify so the change is
    // traceable. Neither must ever fail the edit.
    if (order.status === "DISPATCHED" && recompute) {
      try {
        await db.insert(foodOrderEventsTable).values({
          id: newId(), orderId: id, status: "DISPATCHED",
          note: `People count changed after dispatch: ${prevPeople} → ${people} (items recomputed)`,
          actorId: req.user!.id,
        });
      } catch (e) { req.log.error(e, "failed to write post-dispatch edit audit event"); }
      req.log.warn({ orderId: id, orderNumber: order.orderNumber, prevPeople, people, actorId: req.user!.id }, "order edited after dispatch");
      try {
        const items = await db.select({ name: dishesTable.name, qty: foodOrderItemsTable.orderedQty, unit: foodOrderItemsTable.unit })
          .from(foodOrderItemsTable).leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id)).where(eq(foodOrderItemsTable.orderId, id));
        await notifyOrderEvent("DISPATCHED", {
          unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
          propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand,
          items: items.map((it) => ({ name: it.name ?? "Item", qty: Number(it.qty ?? 0), unit: it.unit })),
        });
      } catch (e) { req.log.error(e, "failed to notify kitchen/dispatch of post-dispatch edit"); }
    }

    res.json({ success: true, data: { ...updated, totalQuantity: updated.totalQuantity != null ? Number(updated.totalQuantity) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Cancel is allowed for the ordering side (UNIT_LEAD via FOOD_PLACE_ORDER) AND the
// kitchen side (FnB via FOOD_KITCHEN_SUMMARY) — FnB is intentionally NOT granted
// FOOD_PLACE_ORDER, so we gate inline on either edit permission rather than a single
// authorize() call. Cancel is only valid while the order is still pre-dispatch.
const cancelOrderSchema = z.object({ reason: zText.nullish() }).passthrough();

foodRouter.post("/orders/:id/cancel", authenticate, async (req, res) => {
  try {
    if (!validateBody(cancelOrderSchema, req, res)) return;
    const role = req.user?.role as UserRole | undefined;
    const canCancel = can(role, "FOOD_PLACE_ORDER", "edit") || can(role, "FOOD_KITCHEN_SUMMARY", "edit");
    if (!canCancel) { res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" }); return; }
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    // Cancel allowed only while pre-dispatch (PLACED, ACCEPTED).
    if (order.status === "DISPATCHED" || order.status === "DELIVERED" || order.status === "CANCELLED" || order.status === "REJECTED") {
      res.status(422).json({ success: false, error: "Only orders that are not yet dispatched can be cancelled" });
      return;
    }
    const reason = req.body?.reason ?? null;
    const now = new Date();
    const [updated] = await db.update(foodOrdersTable).set({
      status: "CANCELLED", cancelledAt: now, cancelReason: reason, updatedAt: now,
    }).where(eq(foodOrdersTable.id, id)).returning();
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: "CANCELLED", note: reason ? `Cancelled: ${reason}` : "Order cancelled", actorId: req.user!.id,
    });
    await notifyOrderEvent("CANCELLED", {
      unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand, reason,
    });
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Kitchen items — the per-dish quantities the kitchen actually sends.
 *
 * GET returns each item's ordered vs prepared figures for the pre-dispatch
 * review (Kitchen Home); PATCH lets the kitchen adjust prepared amounts while
 * the order is ACCEPTED (i.e. after accept, before the van leaves).
 * preparedQty is the figure the unit lead's receive step compares against.
 * Deliberately gated on FOOD_KITCHEN_SUMMARY (not FOOD_ALL_ORDERS): it exposes
 * only kitchen-relevant fields, no order history or tracking.
 * ──────────────────────────────────────────────────────────────────────────── */
foodRouter.get("/orders/:id/kitchen-items", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "view"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    const rows = await db.select({ it: foodOrderItemsTable, dishName: dishesTable.name })
      .from(foodOrderItemsTable)
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .where(eq(foodOrderItemsTable.orderId, id));
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.it.id,
        dishId: r.it.dishId,
        dishName: r.dishName,
        unit: r.it.unit,
        orderedQty: r.it.orderedQty != null ? Number(r.it.orderedQty) : null,
        preparedQty: r.it.preparedQty != null ? Number(r.it.preparedQty) : null,
      })),
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const kitchenItemsSchema = z.object({
  items: z.array(z.object({
    id: zId,
    preparedQty: z.coerce.number().min(0).finite(),
  })).min(1),
  // A reason is mandatory for any dispatch-time quantity change — logged to the
  // order event trail so every adjustment is accountable.
  reason: z.string().trim().min(1, "A reason is required for a quantity change"),
}).passthrough();

foodRouter.patch("/orders/:id/kitchen-items", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    if (!validateBody(kitchenItemsSchema, req, res)) return;
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    // Send amounts are only adjustable while the food is still in the kitchen.
    if (order.status !== "ACCEPTED") {
      res.status(422).json({ success: false, error: `Send quantities can only be adjusted while the order is Accepted (it is ${order.status}).` });
      return;
    }
    const items = (req.body as { items: { id: string; preparedQty: number }[] }).items;
    const own = await db.select({ id: foodOrderItemsTable.id })
      .from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    const ownIds = new Set(own.map((r) => r.id));
    if (items.some((it) => !ownIds.has(it.id))) {
      res.status(422).json({ success: false, error: "Item does not belong to this order" });
      return;
    }
    const now = new Date();
    for (const it of items) {
      await db.update(foodOrderItemsTable)
        .set({ preparedQty: String(it.preparedQty), updatedAt: now })
        .where(eq(foodOrderItemsTable.id, it.id));
    }
    await db.update(foodOrdersTable).set({ updatedAt: now }).where(eq(foodOrdersTable.id, id));
    // Log the mandatory reason on the order event trail (order stays ACCEPTED).
    const reason = (req.body as { reason: string }).reason.trim();
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: order.status,
      note: `Send quantities adjusted (${items.length} item${items.length === 1 ? "" : "s"}) — ${reason}`,
      actorId: req.user!.id,
    });
    res.json({ success: true, data: { updated: items.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const dispatchOrderSchema = z.object({
  action: z.enum(["start", "dispatch"]).optional(),
  deliveryPartnerId: zId.nullish(),
}).passthrough();

foodRouter.post("/orders/:id/dispatch", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    if (!validateBody(dispatchOrderSchema, req, res)) return;
    const id = req.params["id"]!;
    const b = req.body || {};
    const action = (b.action as string | undefined) || "dispatch";
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }

    const now = new Date();
    if (action === "start") {
      if (order.status !== "ACCEPTED") {
        res.status(422).json({ success: false, error: `Cannot start dispatch — order is ${order.status}. It must be ACCEPTED.` });
        return;
      }
      const [updated] = await db.update(foodOrdersTable).set({
        dispatchStartedAt: order.dispatchStartedAt ?? now,
        deliveryPartnerId: b.deliveryPartnerId ?? order.deliveryPartnerId ?? null,
        updatedAt: now,
      }).where(eq(foodOrdersTable.id, id)).returning();
      await db.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: order.status, note: "Dispatch preparation started", actorId: req.user!.id,
      });
      res.json({ success: true, data: updated });
      return;
    }

    if (!b.deliveryPartnerId) { res.status(400).json({ success: false, error: "deliveryPartnerId required" }); return; }
    if (!canTransition(order.status, "DISPATCHED")) {
      res.status(422).json({ success: false, error: `Cannot dispatch — order is ${order.status}. It must be ACCEPTED.` });
      return;
    }
    // C8: route through the shared helper so the order reliably carries a
    // dispatchId + a dispatch row (status LOADING) + a dispatch audit event.
    // The helper updates the order row; we re-select it for the response shape.
    const [updated] = await db.transaction(async (tx) => {
      await createDispatchForOrders(tx, {
        orderIds: [id],
        agencyId: b.deliveryPartnerId,
        kitchenId: order.kitchenId ?? null,
        actorId: req.user!.id,
      });
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "DISPATCHED", note: "Order dispatched", actorId: req.user!.id,
      });
      return tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    });
    {
      const dispItems = await db.select({ name: dishesTable.name, qty: foodOrderItemsTable.preparedQty, ordered: foodOrderItemsTable.orderedQty, unit: foodOrderItemsTable.unit })
        .from(foodOrderItemsTable).leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id)).where(eq(foodOrderItemsTable.orderId, id));
      const [dp] = await db.select({ name: agenciesTable.name }).from(agenciesTable).where(eq(agenciesTable.id, b.deliveryPartnerId));
      await notifyOrderEvent("DISPATCHED", {
        unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
        propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand,
        driverName: dp?.name ?? null,
        items: dispItems.map((it) => ({ name: it.name ?? "Item", qty: Number(it.qty ?? it.ordered ?? 0), unit: it.unit })),
      });
    }
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const confirmDeliverySchema = z.object({
  items: z.array(z.object({
    itemId: zId,
    receivedQty: z.coerce.number(),
  }).passthrough()).optional(),
  remarks: zText.nullish(),
}).passthrough();

foodRouter.post("/orders/:id/confirm-delivery", authenticate, authorize("FOOD_CONFIRM_DELIVERY", "edit"), async (req, res) => {
  try {
    if (!validateBody(confirmDeliverySchema, req, res)) return;
    const id = req.params["id"]!;
    const b = req.body || {};
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "DISPATCHED") { res.status(422).json({ success: false, error: "Only DISPATCHED orders can be confirmed" }); return; }

    const items: Array<{ itemId: string; receivedQty: number }> = Array.isArray(b.items) ? b.items : [];
    const orderItems = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    const itemById = new Map(orderItems.map((it) => [it.id, it]));
    for (const inp of items) {
      const it = itemById.get(inp.itemId);
      if (!it) { res.status(400).json({ success: false, error: `Unknown itemId ${inp.itemId}` }); return; }
      const rq = Number(inp.receivedQty);
      if (!Number.isFinite(rq) || rq < 0 || rq > Number(it.orderedQty)) {
        res.status(400).json({ success: false, error: `receivedQty for ${inp.itemId} must be between 0 and ${it.orderedQty}` });
        return;
      }
    }

    const now = new Date();
    const wasteWindowMs = await getWasteEditWindowMs();

    // Detect any shortfall (receivedQty < orderedQty) to auto-raise a FOOD
    // complaint (O5). We compute it from the submitted received quantities;
    // items not submitted are treated as fully received (no shortfall).
    const receivedById = new Map(items.map((i) => [i.itemId, Number(i.receivedQty)]));
    type Short = { name: string; ordered: number; received: number; short: number; pct: number };
    const shortfalls: Short[] = [];
    for (const it of orderItems) {
      if (!receivedById.has(it.id)) continue;
      const ordered = Number(it.orderedQty);
      const received = receivedById.get(it.id)!;
      if (received < ordered) {
        const [dish] = await db.select({ name: dishesTable.name }).from(dishesTable).where(eq(dishesTable.id, it.dishId));
        const shortQty = ordered - received;
        shortfalls.push({
          name: dish?.name || "item",
          ordered, received, short: shortQty,
          pct: ordered > 0 ? (shortQty / ordered) * 100 : 0,
        });
      }
    }

    const { updated } = await db.transaction(async (tx) => {
      for (const inp of items) {
        await tx.update(foodOrderItemsTable).set({ receivedQty: String(Number(inp.receivedQty)), updatedAt: now }).where(eq(foodOrderItemsTable.id, inp.itemId));
      }
      const [upd] = await tx.update(foodOrdersTable).set({
        status: "DELIVERED",
        deliveredAt: now,
        wasteEditableUntil: new Date(now.getTime() + wasteWindowMs),
        confirmedById: req.user!.id,
        deliveryRemarks: b.remarks ?? null,
        updatedAt: now,
      }).where(eq(foodOrdersTable.id, id)).returning();
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "DELIVERED", note: "Delivery confirmed", actorId: req.user!.id,
      });

      // O5 — auto-create a property-scoped FOOD complaint on ANY shortfall, in
      // the SAME transaction so delivery + complaint commit/rollback together.
      if (shortfalls.length > 0) {
        // Mirror the complaints module's ticket numbering (TKT-NNNNN) and its
        // FOOD-category SLA default (slaHours = 24).
        const [maxRow] = await tx.select({ max: sql<string | null>`MAX(${complaintsTable.ticketNo})` }).from(complaintsTable);
        const last = maxRow?.max || "TKT-01000";
        const n = parseInt(last.replace(/[^0-9]/g, ""), 10) || 1000;
        const ticketNo = `TKT-${String(n + 1).padStart(5, "0")}`;
        const slaHours = 24;
        const worst = [...shortfalls].sort((a, b2) => b2.pct - a.pct)[0]!;
        const priority = worst.pct >= 50 ? "HIGH" : worst.pct >= 20 ? "MEDIUM" : "LOW";
        const itemSummary = shortfalls
          .map((s) => `${s.name} (short ${s.short} of ${s.ordered}, ${s.pct.toFixed(0)}%)`)
          .join("; ");
        const title = `Delivery shortfall on order ${order.orderNumber}`;
        const description =
          `Auto-raised on delivery confirmation for order ${order.orderNumber} ` +
          `(${order.mealType}, ${order.brand}). ${shortfalls.length} item(s) received short: ${itemSummary}.`;
        await tx.insert(complaintsTable).values({
          id: newId(),
          propertyId: order.propertyId,
          residentId: null, // property/food-level complaint, not resident-bound
          orderId: order.id,
          ticketNo,
          category: "FOOD",
          subCategory: "DELIVERY_VARIANCE",
          title,
          description,
          status: "OPEN",
          priority,
          slaHours,
          slaDeadline: new Date(now.getTime() + slaHours * 60 * 60 * 1000),
          updatedAt: now,
        });
        await tx.insert(foodOrderEventsTable).values({
          id: newId(), orderId: id, status: "DELIVERED",
          note: `Variance complaint ${ticketNo} auto-created`, actorId: req.user!.id,
        });
      }

      return { updated: upd };
    });

    await notifyOrderEvent("DELIVERED", {
      unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand,
    });
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const wasteSchema = z.object({
  items: z.array(z.object({
    itemId: zId,
    wastedQty: z.coerce.number(),
  }).passthrough()).optional(),
}).passthrough();

foodRouter.post("/orders/:id/waste", authenticate, authorize("FOOD_WASTE_TRACKING", "edit"), async (req, res) => {
  try {
    if (!validateBody(wasteSchema, req, res)) return;
    const id = req.params["id"]!;
    const b = req.body || {};
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "DELIVERED") { res.status(422).json({ success: false, error: "Waste can only be recorded for DELIVERED orders" }); return; }
    // Cool-down semantics (13-Jul): wasteEditableUntil marks when logging
    // OPENS (delivered + wasteWindowMinutes) — the meal must be over before
    // leftovers can be counted. No upper bound for now; the window duration
    // will be tuned later.
    if (!order.wasteEditableUntil || new Date() < order.wasteEditableUntil) {
      res.status(422).json({ success: false, error: "Waste can be logged once the meal is over — the window hasn't opened yet" });
      return;
    }

    const items: Array<{ itemId: string; wastedQty: number }> = Array.isArray(b.items) ? b.items : [];
    const orderItems = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    const itemById = new Map(orderItems.map((it) => [it.id, it]));
    for (const inp of items) {
      const it = itemById.get(inp.itemId);
      if (!it) { res.status(400).json({ success: false, error: `Unknown itemId ${inp.itemId}` }); return; }
      const wq = Number(inp.wastedQty);
      // Cap against RECEIVED qty (the proof-of-delivery amount); fall back to
      // orderedQty when delivery wasn't confirmed (receivedQty null/undefined).
      const cap = it.receivedQty == null ? Number(it.orderedQty) : Number(it.receivedQty);
      if (!Number.isFinite(wq) || wq < 0 || wq > cap) {
        res.status(400).json({ success: false, error: `wastedQty for ${inp.itemId} cannot exceed received (${cap})` });
        return;
      }
    }

    const now = new Date();
    for (const inp of items) {
      await db.update(foodOrderItemsTable).set({ wastedQty: String(Number(inp.wastedQty)), updatedAt: now }).where(eq(foodOrderItemsTable.id, inp.itemId));
    }
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: "DELIVERED", note: "Waste recorded", actorId: req.user!.id,
    });
    const refreshed = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    res.json({ success: true, data: { items: refreshed.map((it) => ({ ...it, wastedQty: it.wastedQty != null ? Number(it.wastedQty) : null })) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Kitchen Summary
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/kitchen-summary", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);

    const dateRaw = req.query["date"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const clusterId = req.query["clusterId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;

    // The cook plan covers every order the kitchen still has to cook: freshly
    // placed and accepted (pre-dispatch). Once dispatched it leaves the plan.
    const conds = [inArray(foodOrdersTable.status, ["PLACED", "ACCEPTED"])];
    if (scope) conds.push(scope);
    if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
    if (mealType) conds.push(eq(foodOrdersTable.mealType, mealType as never));
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    // `date` is an IST calendar day, filtered with the same half-open IST
    // window as GET /orders. The old host-local setHours + inclusive `lte`
    // window drifted on non-IST hosts (whole plan a day off on UTC) and its
    // upper bound landed exactly on the next IST day-start, pulling tomorrow's
    // orders into today's plan.
    if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      const lo = ymdToIstDayStart(dateRaw);
      const hi = new Date(lo.getTime() + 86400000);
      conds.push(gte(foodOrdersTable.serviceDate, lo));
      conds.push(lt(foodOrdersTable.serviceDate, hi));
    }
    if (clusterId) conds.push(eq(propertiesTable.clusterId, clusterId));

    const rows = await db.select({
      mealType: foodOrdersTable.mealType,
      dishId: foodOrderItemsTable.dishId,
      dishName: dishesTable.name,
      component: dishesTable.component,
      unit: foodOrderItemsTable.unit,
      orderedQty: foodOrderItemsTable.orderedQty,
      propertyId: foodOrdersTable.propertyId,
      propertyName: propertiesTable.name,
    }).from(foodOrdersTable)
      .innerJoin(foodOrderItemsTable, eq(foodOrderItemsTable.orderId, foodOrdersTable.id))
      .leftJoin(dishesTable, eq(foodOrderItemsTable.dishId, dishesTable.id))
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .where(and(...conds));

    // Group by mealType → dishId, accumulating totals + per-property breakdown.
    type DishAgg = {
      dishId: string; dishName: string | null; component: string | null; unit: string;
      totalQty: number; byProperty: Map<string, { propertyId: string; propertyName: string | null; qty: number }>;
    };
    const meals = new Map<string, Map<string, DishAgg>>();
    for (const r of rows) {
      if (!meals.has(r.mealType)) meals.set(r.mealType, new Map());
      const dishes = meals.get(r.mealType)!;
      // Key by (dishId, unit): the same dish may legitimately resolve to
      // different units across properties, and mixing them would yield a
      // meaningless total and wrong unit conversion.
      const key = r.dishId + "|" + r.unit;
      if (!dishes.has(key)) {
        dishes.set(key, { dishId: r.dishId, dishName: r.dishName, component: r.component, unit: r.unit, totalQty: 0, byProperty: new Map() });
      }
      const agg = dishes.get(key)!;
      const q = Number(r.orderedQty);
      agg.totalQty += q;
      const bp = agg.byProperty.get(r.propertyId) ?? { propertyId: r.propertyId, propertyName: r.propertyName, qty: 0 };
      bp.qty += q;
      agg.byProperty.set(r.propertyId, bp);
    }

    const data = {
      meals: [...meals.entries()].map(([mt, dishes]) => ({
        mealType: mt,
        dishes: [...dishes.values()].map((d) => {
          const disp = convertForDisplay(d.totalQty, d.unit);
          return {
            dishId: d.dishId,
            dishName: d.dishName,
            component: d.component,
            unit: d.unit,
            totalQty: Math.round(d.totalQty * 1000) / 1000,
            displayQty: disp.qty,
            displayUnit: disp.unit,
            byProperty: [...d.byProperty.values()].map((p) => ({ ...p, qty: Math.round(p.qty * 1000) / 1000 })),
          };
        }),
      })),
    };
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Reports
 * ──────────────────────────────────────────────────────────────────────────── */

function reportConds(scope: ReturnType<typeof eq> | undefined, q: Record<string, unknown>) {
  const conds = [] as ReturnType<typeof eq>[];
  if (scope) conds.push(scope);
  const status = q["status"] as string | undefined;
  const from = parseDate(q["from"]);
  const to = parseDate(q["to"]);
  const propertyId = q["propertyId"] as string | undefined;
  const brand = q["brand"] as string | undefined;
  if (status) conds.push(eq(foodOrdersTable.status, status as never));
  if (from) conds.push(gte(foodOrdersTable.serviceDate, from));
  if (to) conds.push(lte(foodOrdersTable.serviceDate, to));
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
  return conds.length ? and(...conds) : undefined;
}

foodRouter.get("/reports", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);
    const where = reportConds(scope, req.query as Record<string, unknown>);

    const day = sql<string>`to_char(${foodOrdersTable.serviceDate}, 'YYYY-MM-DD')`;

    const ordersPerDay = await db.select({ date: day, count: sql<number>`count(*)::int` })
      .from(foodOrdersTable).where(where).groupBy(day).orderBy(day);

    const mealTypeDistribution = await db.select({ mealType: foodOrdersTable.mealType, count: sql<number>`count(*)::int` })
      .from(foodOrdersTable).where(where).groupBy(foodOrdersTable.mealType);

    // People ordered for = residents + staff (staff eat the same food). Summing
    // the total keeps this trend consistent with the operational headcount and
    // avoids a silent drop the day staff capture ships.
    const residentTrend = await db.select({ date: day, residents: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount} + ${foodOrdersTable.staffCount}), 0)::int` })
      .from(foodOrdersTable).where(where).groupBy(day).orderBy(day);

    const statusBreakdown = await db.select({ status: foodOrdersTable.status, count: sql<number>`count(*)::int` })
      .from(foodOrdersTable).where(where).groupBy(foodOrdersTable.status);

    res.json({
      success: true,
      data: {
        ordersPerDay: ordersPerDay.map((r) => ({ date: r.date, count: r.count })),
        mealTypeDistribution: mealTypeDistribution.map((r) => ({ mealType: r.mealType, count: r.count })),
        residentTrend: residentTrend.map((r) => ({ date: r.date, residents: r.residents })),
        statusBreakdown: statusBreakdown.map((r) => ({ status: r.status, count: r.count })),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const REPORT_ORDER_HEADERS = ["Order ID", "Property", "Unit Lead", "Brand", "Meal", "Residents", "Staff", "Total", "Quantity", "Status", "Service Date", "Delivered At"];

/**
 * Resolves filtered order rows for the reports export + metadata (property name,
 * date-range) used in the file header/filename. propertyName is set only when a
 * single property is in scope; otherwise null (generic multi-property export).
 */
async function fetchReportOrdersForExport(req: any): Promise<{
  rows: (string | number | null | undefined)[][];
  propertyName: string | null;
  dateRange: string | null;
}> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  const scope = scopeOrdersCondition(ids);
  const where = reportConds(scope, req.query as Record<string, unknown>);

  const rows = await db.select({
    o: foodOrdersTable,
    propertyName: propertiesTable.name,
    unitLeadName: usersTable.name,
  }).from(foodOrdersTable)
    .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
    .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
    .where(where)
    .orderBy(desc(foodOrdersTable.serviceDate));

  const explicitProperty = req.query["propertyId"] as string | undefined;
  let propertyName: string | null = null;
  if (explicitProperty) {
    propertyName = rows.find((r) => r.propertyName)?.propertyName ?? null;
  } else {
    const names = new Set(rows.map((r) => r.propertyName ?? "").filter(Boolean));
    if (names.size === 1) propertyName = [...names][0];
  }
  const from = parseDate(req.query["from"]); const to = parseDate(req.query["to"]);
  const dateRange = from || to ? `${from ? fmtDate(from) : "…"} → ${to ? fmtDate(to) : "…"}` : null;

  const mapped = rows.map((r) => [
    r.o.orderNumber, r.propertyName ?? "", r.unitLeadName ?? "", r.o.brand, r.o.mealType,
    r.o.residentsCount, r.o.staffCount ?? 0, (r.o.residentsCount ?? 0) + (r.o.staffCount ?? 0),
    r.o.totalQuantity != null ? Number(r.o.totalQuantity) : "", r.o.status,
    fmtDate(r.o.serviceDate), fmtDateTime(r.o.deliveredAt),
  ]);
  return { rows: mapped, propertyName, dateRange };
}

function reportOrdersFilename(propertyName: string | null, ext: string): string {
  const prop = propertyName ? `-${sanitizeForFilename(propertyName)}` : "";
  return `food-orders${prop}-${fileDateStamp()}.${ext}`;
}

// CSV report export. /reports/export kept as an alias of /reports/export.csv
// for backward compatibility with existing clients.
async function reportsCsvHandler(req: any, res: any) {
  try {
    const { rows, propertyName, dateRange } = await fetchReportOrdersForExport(req);
    const csv = toCsv({ title: "Food Orders Report", headers: REPORT_ORDER_HEADERS, rows, propertyName, dateRange });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${reportOrdersFilename(propertyName, "csv")}`);
    res.send(csv);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
}
// Data download/export is restricted to Super Admin (Data Team role TBD).
// NOTE: foodRouter is mounted BEFORE foodOpsRouter at the same /food base
// (routes/index.ts), so these routes shadow the same paths in food-ops.ts —
// the guard MUST live here on every extension variant, not only the alias.
foodRouter.get("/reports/export", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), reportsCsvHandler);
foodRouter.get("/reports/export.csv", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), reportsCsvHandler);

foodRouter.get("/reports/export.pdf", authenticate, requireRoles("SUPER_ADMIN", "OPS_EXCELLENCE"), async (req, res) => {
  try {
    const { rows, propertyName, dateRange } = await fetchReportOrdersForExport(req);
    const pdf = await toPdf({ title: "Food Orders Report", headers: REPORT_ORDER_HEADERS, rows, propertyName, dateRange });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${reportOrdersFilename(propertyName, "pdf")}`);
    res.send(Buffer.from(pdf));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Lookups
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/lookups", authenticate, async (req, res) => {
  try {
    const properties = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city,
      brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId, clusterId: propertiesTable.clusterId,
    }).from(propertiesTable).orderBy(propertiesTable.city, propertiesTable.name);
    // Agencies (with their active vehicles) for the dispatch dropdowns.
    const agencyRows = await db.select({ id: agenciesTable.id, name: agenciesTable.name })
      .from(agenciesTable).where(eq(agenciesTable.isActive, true)).orderBy(agenciesTable.name);
    const vehicleRows = await db.select({ id: agencyVehiclesTable.id, agencyId: agencyVehiclesTable.agencyId, vehicleNumber: agencyVehiclesTable.vehicleNumber, vehicleType: agencyVehiclesTable.vehicleType, locationId: agencyVehiclesTable.locationId })
      .from(agencyVehiclesTable).where(eq(agencyVehiclesTable.isActive, true));
    const vByA = new Map<string, any[]>(); for (const v of vehicleRows) { const a = vByA.get(v.agencyId) ?? []; a.push(v); vByA.set(v.agencyId, a); }
    // B1: active service locations per agency (parallel to vehicles), so the
    // dispatch UI can pick a drop/service location.
    const locationRows = await db.select({ id: agencyLocationsTable.id, agencyId: agencyLocationsTable.agencyId, name: agencyLocationsTable.name, city: agencyLocationsTable.city, state: agencyLocationsTable.state, pincode: agencyLocationsTable.pincode })
      .from(agencyLocationsTable).where(eq(agencyLocationsTable.isActive, true));
    const lByA = new Map<string, any[]>(); for (const l of locationRows) { const a = lByA.get(l.agencyId) ?? []; a.push(l); lByA.set(l.agencyId, a); }
    // B3: linked kitchen ids per agency (active links) so the dispatch UI can
    // filter agencies by the order's kitchen.
    const linkRows = await db.select({ agencyId: agencyKitchensTable.agencyId, kitchenId: agencyKitchensTable.kitchenId })
      .from(agencyKitchensTable).where(eq(agencyKitchensTable.isActive, true));
    const kByA = new Map<string, string[]>(); for (const k of linkRows) { const a = kByA.get(k.agencyId) ?? []; a.push(k.kitchenId); kByA.set(k.agencyId, a); }
    const agencies = agencyRows.map((a) => ({ ...a, vehicles: vByA.get(a.id) ?? [], locations: lByA.get(a.id) ?? [], kitchenIds: kByA.get(a.id) ?? [] }));
    const brands = await db.select({ code: foodBrandsTable.code, name: foodBrandsTable.name })
      .from(foodBrandsTable).where(eq(foodBrandsTable.isActive, true)).orderBy(foodBrandsTable.name);
    // Which kitchens the caller actually runs (null = all — admins/heads).
    // F&B manager logins are kitchen-scoped (one login per kitchen), so
    // Kitchen Home can show "your kitchen" identity in the header.
    const accessible = await resolveAccessiblePropertyIds(req.user!);
    const accessibleSet = accessible === null ? null : new Set(accessible);
    const myKitchenIds = accessibleSet === null
      ? null
      : [...new Set(properties.filter((p) => accessibleSet.has(p.id) && p.kitchenId).map((p) => p.kitchenId!))];
    res.json({
      success: true,
      // deliveryPartners kept as an alias of agencies {id,name} for back-compat.
      data: { properties, agencies, deliveryPartners: agencyRows, brands, mealTypes: MEAL_TYPES, myKitchenIds },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Dishes
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/dishes", authenticate, async (req, res) => {
  try {
    const component = req.query["component"] as string | undefined;
    const search = req.query["search"] as string | undefined;
    const active = req.query["active"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (component) conds.push(eq(dishesTable.component, component as never));
    if (search) conds.push(ilike(dishesTable.name, `%${search}%`));
    if (active !== undefined) conds.push(eq(dishesTable.isActive, active === "true"));
    if (brand) conds.push(sql`${dishesTable.brands} @> ARRAY[${brand}]::text[]`);
    const where = conds.length ? and(...conds) : undefined;
    const sort = req.query["sort"] as string | undefined;
    const orderCol = sort === "newest" ? desc(dishesTable.createdAt) : asc(dishesTable.name);
    const rows = await db.select().from(dishesTable).where(where).orderBy(orderCol);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const sanitizePreparations = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && (PREPARATIONS as readonly string[]).includes(p)) : [];

/** Replace a dish's ingredient rows from a [{ingredientId, quantity?, unit?}] list. */
async function replaceDishIngredients(dishId: string, ingredients: unknown): Promise<void> {
  await db.delete(dishIngredientsTable).where(eq(dishIngredientsTable.dishId, dishId));
  const valid = (Array.isArray(ingredients) ? ingredients : []).filter((it) => it && it.ingredientId);
  if (!valid.length) return;
  await db.insert(dishIngredientsTable).values(valid.map((it) => ({
    id: newId(), dishId, ingredientId: it.ingredientId,
    quantity: it.quantity != null && it.quantity !== "" ? String(it.quantity) : null,
    unit: it.unit != null && it.unit !== "" ? it.unit : null, updatedAt: new Date(),
  })));
}

/** Loads a dish's ingredients joined to ingredient names. */
async function loadDishIngredients(dishId: string) {
  return db.select({
    id: dishIngredientsTable.id, ingredientId: dishIngredientsTable.ingredientId,
    ingredientName: ingredientsTable.name, quantity: dishIngredientsTable.quantity, unit: dishIngredientsTable.unit,
  }).from(dishIngredientsTable)
    .leftJoin(ingredientsTable, eq(dishIngredientsTable.ingredientId, ingredientsTable.id))
    .where(eq(dishIngredientsTable.dishId, dishId));
}

// Ingredient rows accepted by replaceDishIngredients (ingredientId required; qty/unit loose).
const zIngredient = z.object({
  ingredientId: zId,
  quantity: z.union([z.string(), z.number()]).nullish(),
  unit: z.string().max(64).nullish(),
}).passthrough();

const createDishSchema = z.object({
  name: zText,
  component: z.string().min(1).max(128),
  unit: z.string().min(1).max(64),
  brands: z.array(z.string().max(128)).optional(),
  preparations: z.array(z.string().max(128)).optional(),
  photoUrl: z.string().max(2048).nullish(),
  isActive: z.boolean().optional(),
  ingredients: z.array(zIngredient).optional(),
}).passthrough();

foodRouter.post("/dishes", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createDishSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name || !b.component || !b.unit) { res.status(400).json({ success: false, error: "name, component, unit required" }); return; }
    const [row] = await db.insert(dishesTable).values({
      id: newId(),
      name: b.name,
      component: b.component,
      unit: b.unit,
      brands: Array.isArray(b.brands) ? b.brands : [],
      preparations: sanitizePreparations(b.preparations),
      photoUrl: b.photoUrl ?? null,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    if (b.ingredients !== undefined) await replaceDishIngredients(row.id, b.ingredients);
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.get("/dishes/:id", authenticate, async (req, res) => {
  try {
    const [row] = await db.select().from(dishesTable).where(eq(dishesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ingredients = await loadDishIngredients(row.id);
    res.json({ success: true, data: { ...row, ingredients } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateDishSchema = z.object({
  name: zText.optional(),
  component: z.string().max(128).optional(),
  unit: z.string().max(64).optional(),
  brands: z.array(z.string().max(128)).optional(),
  preparations: z.array(z.string().max(128)).optional(),
  photoUrl: z.string().max(2048).nullish(),
  isActive: z.boolean().optional(),
  ingredients: z.array(zIngredient).optional(),
}).passthrough();

foodRouter.put("/dishes/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateDishSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "component", "unit", "brands", "photoUrl", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.preparations !== undefined) u["preparations"] = sanitizePreparations(b.preparations);
    const [row] = await db.update(dishesTable).set(u as Partial<typeof dishesTable.$inferInsert>).where(eq(dishesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (b.ingredients !== undefined) await replaceDishIngredients(row.id, b.ingredients);
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/dishes/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(dishesTable).set({ isActive: false, updatedAt: new Date() }).where(eq(dishesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Ingredients
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/ingredients", authenticate, async (req, res) => {
  try {
    const search = req.query["search"] as string | undefined;
    const active = req.query["active"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (search) conds.push(ilike(ingredientsTable.name, `%${search}%`));
    if (active !== undefined) conds.push(eq(ingredientsTable.isActive, active === "true"));
    const rows = await db.select().from(ingredientsTable).where(conds.length ? and(...conds) : undefined).orderBy(ingredientsTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createIngredientSchema = z.object({
  name: zText,
  unit: z.string().min(1).max(64),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/ingredients", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createIngredientSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name || !b.unit) { res.status(400).json({ success: false, error: "name and unit required" }); return; }
    const [row] = await db.insert(ingredientsTable).values({
      id: newId(), name: b.name, unit: b.unit, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateIngredientSchema = z.object({
  name: zText.optional(),
  unit: z.string().max(64).optional(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/ingredients/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateIngredientSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "unit", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(ingredientsTable).set(u as never).where(eq(ingredientsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/ingredients/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(ingredientsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(ingredientsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Menu rotation
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/menu-rotation/resolve", authenticate, async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    let brand = req.query["brand"] as string | undefined;
    let kitchenId = req.query["kitchenId"] as string | undefined;
    if (propertyId) {
      const cfg = await getPropertyFoodConfig(propertyId);
      brand = brand || cfg.brand || undefined;
      kitchenId = kitchenId || cfg.kitchenId || undefined;
    }
    const mealType = req.query["mealType"] as string | undefined;
    const date = parseDate(req.query["date"]);
    if (!brand || !mealType || !date) { res.status(400).json({ success: false, error: "brand, mealType, date required" }); return; }
    const dishes = await resolveMenu(kitchenId ?? null, brand, mealType, date);
    res.json({ success: true, data: dishes });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.get("/menu-rotation", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const kitchenId = req.query["kitchenId"] as string | undefined;
    const rotationWeek = req.query["rotationWeek"] as string | undefined;
    const dayOfWeek = req.query["dayOfWeek"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (brand) conds.push(eq(foodMenuRotationTable.brand, brand as never));
    if (kitchenId) conds.push(eq(foodMenuRotationTable.kitchenId, kitchenId));
    if (rotationWeek) conds.push(eq(foodMenuRotationTable.rotationWeek, Number(rotationWeek)));
    if (dayOfWeek) conds.push(eq(foodMenuRotationTable.dayOfWeek, Number(dayOfWeek)));
    if (mealType) conds.push(eq(foodMenuRotationTable.mealType, mealType as never));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      r: foodMenuRotationTable,
      dishName: dishesTable.name,
      component: dishesTable.component,
      dishUnit: dishesTable.unit,
      kitchenName: kitchensTable.name,
    }).from(foodMenuRotationTable)
      .leftJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
      .leftJoin(kitchensTable, eq(foodMenuRotationTable.kitchenId, kitchensTable.id))
      .where(where)
      .orderBy(foodMenuRotationTable.rotationWeek, foodMenuRotationTable.dayOfWeek, foodMenuRotationTable.sortOrder);
    res.json({ success: true, data: rows.map((r) => ({ ...r.r, dishName: r.dishName, component: r.component, dishUnit: r.dishUnit, kitchenName: r.kitchenName })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const ROTATION_HEADERS = ["Kitchen", "Brand", "Week", "Day", "Meal", "Dish", "Slot", "Order"];

/**
 * Resolves menu-rotation export rows + metadata (kitchen name used as the
 * "property"-equivalent label, plus a filename hint built from brand/kitchen).
 */
async function fetchRotationForExport(req: any): Promise<{
  rows: (string | number | null | undefined)[][];
  kitchenName: string | null;
  brand: string | null;
}> {
  const brand = req.query["brand"] as string | undefined;
  const kitchenId = req.query["kitchenId"] as string | undefined;
  const rotationWeek = req.query["rotationWeek"] as string | undefined;
  const dayOfWeek = req.query["dayOfWeek"] as string | undefined;
  const mealType = req.query["mealType"] as string | undefined;
  const conds = [] as ReturnType<typeof eq>[];
  if (brand) conds.push(eq(foodMenuRotationTable.brand, brand as never));
  if (kitchenId) conds.push(eq(foodMenuRotationTable.kitchenId, kitchenId));
  if (rotationWeek) conds.push(eq(foodMenuRotationTable.rotationWeek, Number(rotationWeek)));
  if (dayOfWeek) conds.push(eq(foodMenuRotationTable.dayOfWeek, Number(dayOfWeek)));
  if (mealType) conds.push(eq(foodMenuRotationTable.mealType, mealType as never));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select({
    kitchenName: kitchensTable.name, brand: foodMenuRotationTable.brand,
    rotationWeek: foodMenuRotationTable.rotationWeek, dayOfWeek: foodMenuRotationTable.dayOfWeek,
    mealType: foodMenuRotationTable.mealType, dishName: dishesTable.name,
    slotLabel: foodMenuRotationTable.slotLabel, sortOrder: foodMenuRotationTable.sortOrder,
  }).from(foodMenuRotationTable)
    .leftJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .leftJoin(kitchensTable, eq(foodMenuRotationTable.kitchenId, kitchensTable.id))
    .where(where)
    .orderBy(kitchensTable.name, foodMenuRotationTable.brand, foodMenuRotationTable.rotationWeek, foodMenuRotationTable.dayOfWeek, foodMenuRotationTable.sortOrder);
  const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const mapped = rows.map((r) => [
    r.kitchenName ?? "—", r.brand, `W${r.rotationWeek}`, DAYS[r.dayOfWeek] ?? r.dayOfWeek,
    r.mealType, r.dishName ?? "—", r.slotLabel ?? "", r.sortOrder,
  ]);
  const kitchenNames = new Set(rows.map((r) => r.kitchenName ?? "").filter(Boolean));
  const kitchenName = kitchenId && kitchenNames.size ? [...kitchenNames][0] : (kitchenNames.size === 1 ? [...kitchenNames][0] : null);
  return { rows: mapped, kitchenName, brand: brand ?? null };
}

function rotationFilename(kitchenName: string | null, brand: string | null, ext: string): string {
  const parts = ["menu-rotation"];
  if (brand) parts.push(sanitizeForFilename(brand));
  if (kitchenName) parts.push(sanitizeForFilename(kitchenName));
  parts.push(fileDateStamp());
  return `${parts.join("-")}.${ext}`;
}

// Export the current menu rotation (honours the same filters as the list) as CSV.
foodRouter.get("/menu-rotation/export.csv", authenticate, async (req, res) => {
  try {
    const { rows, kitchenName, brand } = await fetchRotationForExport(req);
    const csv = toCsv({ title: "Menu Rotation", headers: ROTATION_HEADERS, rows, propertyName: kitchenName });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${rotationFilename(kitchenName, brand, "csv")}`);
    res.send(csv);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Export the current menu rotation as PDF.
foodRouter.get("/menu-rotation/export.pdf", authenticate, async (req, res) => {
  try {
    const { rows, kitchenName, brand } = await fetchRotationForExport(req);
    const pdf = await toPdf({ title: "Menu Rotation", headers: ROTATION_HEADERS, rows, propertyName: kitchenName });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${rotationFilename(kitchenName, brand, "pdf")}`);
    res.send(Buffer.from(pdf));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  mealType: zMealType,
  dishId: zId,
  dayOfWeek: z.coerce.number(),
  rotationWeek: z.coerce.number().nullish(),
  slotLabel: z.string().max(256).nullish(),
  sortOrder: z.coerce.number().nullish(),
  effectiveFrom: z.union([z.string(), z.number(), z.coerce.date()]).nullish(),
  effectiveTo: z.union([z.string(), z.number(), z.coerce.date()]).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/menu-rotation", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createRotationSchema, req, res)) return;
    const b = req.body || {};
    if (!b.kitchenId || !b.brand || !b.mealType || !b.dishId || b.dayOfWeek == null) {
      res.status(400).json({ success: false, error: "kitchenId, brand, mealType, dishId, dayOfWeek required" }); return;
    }
    const [row] = await db.insert(foodMenuRotationTable).values({
      id: newId(),
      kitchenId: b.kitchenId,
      brand: b.brand,
      rotationWeek: b.rotationWeek != null ? Number(b.rotationWeek) : 1,
      dayOfWeek: Number(b.dayOfWeek),
      mealType: b.mealType,
      dishId: b.dishId,
      slotLabel: b.slotLabel ?? null,
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : 0,
      effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : null,
      effectiveTo: b.effectiveTo ? new Date(b.effectiveTo) : null,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/** Bulk-add menu items for one kitchen+brand+week+day+meal (multi-dish builder). */
const zRotationItem = z.object({
  dishId: zId,
  slotLabel: z.string().max(256).nullish(),
  sortOrder: z.coerce.number().nullish(),
}).passthrough();

const bulkRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  mealType: zMealType,
  dayOfWeek: z.coerce.number(),
  rotationWeek: z.coerce.number().nullish(),
  items: z.array(zRotationItem).optional(),
}).passthrough();

foodRouter.post("/menu-rotation/bulk", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(bulkRotationSchema, req, res)) return;
    const b = req.body || {};
    const items: Array<{ dishId: string; slotLabel?: string; sortOrder?: number }> = Array.isArray(b.items) ? b.items : [];
    if (!b.kitchenId || !b.brand || !b.mealType || b.dayOfWeek == null || !items.length) {
      res.status(400).json({ success: false, error: "kitchenId, brand, mealType, dayOfWeek and at least one item required" }); return;
    }
    const now = new Date();
    const values = items
      .filter((it) => it.dishId)
      .map((it, i) => ({
        id: newId(),
        kitchenId: b.kitchenId,
        brand: b.brand,
        rotationWeek: b.rotationWeek != null ? Number(b.rotationWeek) : 1,
        dayOfWeek: Number(b.dayOfWeek),
        mealType: b.mealType,
        dishId: it.dishId,
        slotLabel: it.slotLabel ?? null,
        sortOrder: it.sortOrder != null ? Number(it.sortOrder) : i,
        isActive: true,
        updatedAt: now,
      }));
    if (!values.length) { res.status(400).json({ success: false, error: "No valid items" }); return; }
    const rows = await db.insert(foodMenuRotationTable).values(values).returning();
    res.status(201).json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Replace ALL dishes of one menu slot (kitchen+brand+week+day+meal) — the EDIT path.
const slotRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  rotationWeek: z.coerce.number(),
  dayOfWeek: z.coerce.number(),
  mealType: zMealType,
  items: z.array(zRotationItem).optional(),
}).passthrough();

foodRouter.put("/menu-rotation/slot", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(slotRotationSchema, req, res)) return;
    const b = req.body || {};
    const { kitchenId, brand, rotationWeek, dayOfWeek, mealType } = b;
    const items: Array<{ dishId: string; slotLabel?: string | null; sortOrder?: number }> = Array.isArray(b.items) ? b.items : [];
    if (!kitchenId || !brand || !mealType || rotationWeek == null || dayOfWeek == null) {
      res.status(400).json({ success: false, error: "kitchenId, brand, rotationWeek, dayOfWeek, mealType required" }); return;
    }
    const slotWhere = and(
      eq(foodMenuRotationTable.kitchenId, kitchenId),
      eq(foodMenuRotationTable.brand, brand as never),
      eq(foodMenuRotationTable.rotationWeek, Number(rotationWeek)),
      eq(foodMenuRotationTable.dayOfWeek, Number(dayOfWeek)),
      eq(foodMenuRotationTable.mealType, mealType as never),
    );
    const now = new Date();
    const rows = await db.transaction(async (tx) => {
      // Preserve each existing dish's seasonal window across the replace.
      const existing = await tx.select({ dishId: foodMenuRotationTable.dishId, effectiveFrom: foodMenuRotationTable.effectiveFrom, effectiveTo: foodMenuRotationTable.effectiveTo })
        .from(foodMenuRotationTable).where(slotWhere);
      const effByDish = new Map(existing.map((e) => [e.dishId, { effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo }]));
      await tx.delete(foodMenuRotationTable).where(slotWhere);
      const valid = items.filter((it) => it.dishId);
      if (!valid.length) return [];
      return tx.insert(foodMenuRotationTable).values(valid.map((it, i) => ({
        id: newId(), kitchenId, brand, rotationWeek: Number(rotationWeek), dayOfWeek: Number(dayOfWeek), mealType,
        dishId: it.dishId, slotLabel: it.slotLabel ?? null, sortOrder: it.sortOrder != null ? Number(it.sortOrder) : i,
        effectiveFrom: effByDish.get(it.dishId)?.effectiveFrom ?? null, effectiveTo: effByDish.get(it.dishId)?.effectiveTo ?? null,
        isActive: true, updatedAt: now,
      }))).returning();
    });
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Validate the chosen dishes against the composition rule + flag shared ingredients.
foodRouter.get("/menu-rotation/validate", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = (req.query["kitchenId"] as string) || null;
    const raw = req.query["dishIds"] ?? req.query["dishId"];
    const dishIds = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
    if (!brand || !mealType) { res.status(400).json({ success: false, error: "brand, mealType required" }); return; }
    const rule = await resolveCompositionRule(brand, mealType, kitchenId);
    const dishes = await loadDishesForValidation(dishIds);
    const validation = validateMenuAgainstRule(rule, dishes);
    const sharedIngredients = await detectSharedIngredients(dishIds);
    // Flat machine-readable verdict so the frontend can HARD-BLOCK a selection
    // ({ ok, violations:[{type,message,dishIds}] }) without re-deriving from slots.
    const verdict = buildCompositionVerdict(validation, sharedIngredients);
    res.json({ success: true, data: { ...validation, sharedIngredients, ok: verdict.ok, violations: verdict.violations } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Suggested dishes to satisfy the composition rule for a (kitchen, brand, meal).
foodRouter.get("/menu-rotation/auto-fill", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = (req.query["kitchenId"] as string) || null;
    if (!brand || !mealType) { res.status(400).json({ success: false, error: "brand, mealType required" }); return; }
    const items = await autoFillMenu(brand, mealType, kitchenId);
    res.json({ success: true, data: items });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateRotationSchema = z.object({
  kitchenId: zId.optional(),
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  dishId: zId.optional(),
  slotLabel: z.string().max(256).nullish(),
  isActive: z.boolean().optional(),
  rotationWeek: z.coerce.number().optional(),
  dayOfWeek: z.coerce.number().optional(),
  sortOrder: z.coerce.number().optional(),
  effectiveFrom: z.union([z.string(), z.number(), z.coerce.date()]).nullish(),
  effectiveTo: z.union([z.string(), z.number(), z.coerce.date()]).nullish(),
}).passthrough();

foodRouter.put("/menu-rotation/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateRotationSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["kitchenId", "brand", "mealType", "dishId", "slotLabel", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.rotationWeek !== undefined) u["rotationWeek"] = Number(b.rotationWeek);
    if (b.dayOfWeek !== undefined) u["dayOfWeek"] = Number(b.dayOfWeek);
    if (b.sortOrder !== undefined) u["sortOrder"] = Number(b.sortOrder);
    if (b.effectiveFrom !== undefined) u["effectiveFrom"] = b.effectiveFrom ? new Date(b.effectiveFrom) : null;
    if (b.effectiveTo !== undefined) u["effectiveTo"] = b.effectiveTo ? new Date(b.effectiveTo) : null;
    const [row] = await db.update(foodMenuRotationTable).set(u as Partial<typeof foodMenuRotationTable.$inferInsert>).where(eq(foodMenuRotationTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/menu-rotation/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    await db.delete(foodMenuRotationTable).where(eq(foodMenuRotationTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Per-resident rules
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/rules", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const dishId = req.query["dishId"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (brand) conds.push(eq(perResidentRuleTable.brand, brand as never));
    if (mealType) conds.push(eq(perResidentRuleTable.mealType, mealType as never));
    if (dishId) conds.push(eq(perResidentRuleTable.dishId, dishId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      r: perResidentRuleTable,
      dishName: dishesTable.name,
    }).from(perResidentRuleTable)
      .leftJoin(dishesTable, eq(perResidentRuleTable.dishId, dishesTable.id))
      .where(where);
    res.json({ success: true, data: rows.map((r) => ({ ...r.r, dishName: r.dishName, qtyPerResident: Number(r.r.qtyPerResident) })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createRuleSchema = z.object({
  brand: zBrand,
  mealType: zMealType,
  dishId: zId,
  qtyPerResident: z.coerce.number(),
  unit: z.string().min(1).max(64),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/rules", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createRuleSchema, req, res)) return;
    const b = req.body || {};
    if (!b.brand || !b.mealType || !b.dishId || b.qtyPerResident == null || !b.unit) {
      res.status(400).json({ success: false, error: "brand, mealType, dishId, qtyPerResident, unit required" }); return;
    }
    // Rules are global per (brand, mealType, dishId) — reject duplicates.
    const dup = await db.select({ id: perResidentRuleTable.id }).from(perResidentRuleTable).where(and(
      eq(perResidentRuleTable.brand, b.brand as never), eq(perResidentRuleTable.mealType, b.mealType as never), eq(perResidentRuleTable.dishId, b.dishId),
    ));
    if (dup.length) { res.status(409).json({ success: false, error: "A rule already exists for this brand, meal and dish" }); return; }
    const [row] = await db.insert(perResidentRuleTable).values({
      id: newId(),
      brand: b.brand,
      mealType: b.mealType,
      dishId: b.dishId,
      propertyId: null,
      qtyPerResident: String(b.qtyPerResident),
      unit: b.unit,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, qtyPerResident: Number(row.qtyPerResident) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateRuleSchema = z.object({
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  dishId: zId.optional(),
  unit: z.string().max(64).optional(),
  isActive: z.boolean().optional(),
  qtyPerResident: z.coerce.number().optional(),
}).passthrough();

foodRouter.put("/rules/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateRuleSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "mealType", "dishId", "unit", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.qtyPerResident !== undefined) u["qtyPerResident"] = String(b.qtyPerResident);
    const [row] = await db.update(perResidentRuleTable).set(u as Partial<typeof perResidentRuleTable.$inferInsert>).where(eq(perResidentRuleTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, qtyPerResident: Number(row.qtyPerResident) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/rules/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    await db.delete(perResidentRuleTable).where(eq(perResidentRuleTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Menu composition rules (the menu structure engine)
 * ──────────────────────────────────────────────────────────────────────────── */

const slotValues = (ruleId: string, slots: any[]) =>
  (Array.isArray(slots) ? slots : []).map((s, i) => ({
    id: newId(), ruleId,
    slotLabel: s.slotLabel ?? null,
    component: s.component || null,
    preparation: s.preparation || null,
    minCount: s.minCount != null ? Number(s.minCount) : 1,
    maxCount: s.maxCount != null && s.maxCount !== "" ? Number(s.maxCount) : null,
    sortOrder: s.sortOrder != null ? Number(s.sortOrder) : i,
    updatedAt: new Date(),
  }));

foodRouter.get("/composition-rules", authenticate, async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = req.query["kitchenId"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (brand) conds.push(eq(menuCompositionRuleTable.brand, brand as never));
    if (mealType) conds.push(eq(menuCompositionRuleTable.mealType, mealType as never));
    if (kitchenId) conds.push(eq(menuCompositionRuleTable.kitchenId, kitchenId));
    const rules = await db.select().from(menuCompositionRuleTable).where(conds.length ? and(...conds) : undefined)
      .orderBy(menuCompositionRuleTable.brand, menuCompositionRuleTable.mealType);
    const ids = rules.map((r) => r.id);
    const slots = ids.length ? await db.select().from(menuCompositionSlotTable).where(inArray(menuCompositionSlotTable.ruleId, ids)).orderBy(menuCompositionSlotTable.sortOrder) : [];
    const byRule = new Map<string, any[]>();
    for (const s of slots) { const a = byRule.get(s.ruleId) ?? []; a.push(s); byRule.set(s.ruleId, a); }
    res.json({ success: true, data: rules.map((r) => ({ ...r, slots: byRule.get(r.id) ?? [] })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Slots consumed by slotValues(): all fields loose (coerced/defaulted in code).
const zCompositionSlot = z.object({
  slotLabel: z.string().max(256).nullish(),
  component: z.string().max(128).nullish(),
  preparation: z.string().max(128).nullish(),
  minCount: z.union([z.coerce.number(), z.literal("")]).nullish(),
  maxCount: z.union([z.coerce.number(), z.literal("")]).nullish(),
  sortOrder: z.union([z.coerce.number(), z.literal("")]).nullish(),
}).passthrough();

const createCompositionRuleSchema = z.object({
  brand: zBrand,
  mealType: zMealType,
  kitchenId: z.string().max(128).nullish(),
  name: z.string().max(256).nullish(),
  isActive: z.boolean().optional(),
  slots: z.array(zCompositionSlot).optional(),
}).passthrough();

foodRouter.post("/composition-rules", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createCompositionRuleSchema, req, res)) return;
    const b = req.body || {};
    if (!b.brand || !b.mealType) { res.status(400).json({ success: false, error: "brand and mealType required" }); return; }
    const result = await db.transaction(async (tx) => {
      const [rule] = await tx.insert(menuCompositionRuleTable).values({
        id: newId(), brand: b.brand, mealType: b.mealType, kitchenId: b.kitchenId || null,
        name: b.name ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
      }).returning();
      const sv = slotValues(rule!.id, b.slots);
      const slots = sv.length ? await tx.insert(menuCompositionSlotTable).values(sv).returning() : [];
      return { ...rule, slots };
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateCompositionRuleSchema = z.object({
  // The handler converts "" → null for these, so accept blank strings too;
  // mealType is therefore left a bounded string here (not enum) to preserve that.
  brand: z.string().max(128).optional(),
  mealType: z.string().max(64).optional(),
  kitchenId: z.string().max(128).optional(),
  name: z.string().max(256).optional(),
  isActive: z.boolean().optional(),
  slots: z.array(zCompositionSlot).optional(),
}).passthrough();

foodRouter.put("/composition-rules/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateCompositionRuleSchema, req, res)) return;
    const b = req.body || {};
    const id = req.params["id"]!;
    const result = await db.transaction(async (tx) => {
      const u: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ["brand", "mealType", "kitchenId", "name", "isActive"]) if (b[k] !== undefined) u[k] = b[k] === "" ? null : b[k];
      const [rule] = await tx.update(menuCompositionRuleTable).set(u as never).where(eq(menuCompositionRuleTable.id, id)).returning();
      if (!rule) return null;
      if (b.slots !== undefined) {
        await tx.delete(menuCompositionSlotTable).where(eq(menuCompositionSlotTable.ruleId, id));
        const sv = slotValues(id, b.slots);
        if (sv.length) await tx.insert(menuCompositionSlotTable).values(sv);
      }
      const slots = await tx.select().from(menuCompositionSlotTable).where(eq(menuCompositionSlotTable.ruleId, id)).orderBy(menuCompositionSlotTable.sortOrder);
      return { ...rule, slots };
    });
    if (!result) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: result });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/composition-rules/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    await db.delete(menuCompositionRuleTable).where(eq(menuCompositionRuleTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Delivery partners
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/delivery-partners", authenticate, async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const where = active !== undefined ? eq(deliveryPartnersTable.isActive, active === "true") : undefined;
    const rows = await db.select().from(deliveryPartnersTable).where(where).orderBy(deliveryPartnersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createDeliveryPartnerSchema = z.object({
  name: zText,
  phone: z.string().max(32).nullish(),
  vehicleNumber: z.string().max(64).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/delivery-partners", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createDeliveryPartnerSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(deliveryPartnersTable).values({
      id: newId(),
      name: b.name,
      phone: b.phone ?? null,
      vehicleNumber: b.vehicleNumber ?? null,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateDeliveryPartnerSchema = z.object({
  name: zText.optional(),
  phone: z.string().max(32).nullish(),
  vehicleNumber: z.string().max(64).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/delivery-partners/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateDeliveryPartnerSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "phone", "vehicleNumber", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(deliveryPartnersTable).set(u as Partial<typeof deliveryPartnersTable.$inferInsert>).where(eq(deliveryPartnersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/delivery-partners/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(deliveryPartnersTable).set({ isActive: false, updatedAt: new Date() }).where(eq(deliveryPartnersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Delivery agencies (→ locations + vehicles)
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/agencies", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const search = (req.query["search"] as string | undefined)?.trim();
    const vehicleSearch = (req.query["vehicleSearch"] as string | undefined)?.trim();
    // B2: filter by agency name (ilike) and/or by owning a vehicle whose number
    // matches (ilike). vehicleSearch resolves to a set of agency ids via an
    // EXISTS-style subquery so an agency surfaces if ANY of its vehicles match.
    const conds = [] as ReturnType<typeof eq>[];
    if (active !== undefined) conds.push(eq(agenciesTable.isActive, active === "true"));
    if (search) conds.push(ilike(agenciesTable.name, `%${search}%`));
    if (vehicleSearch) {
      conds.push(sql`exists (select 1 from ${agencyVehiclesTable} where ${agencyVehiclesTable.agencyId} = ${agenciesTable.id} and ${ilike(agencyVehiclesTable.vehicleNumber, `%${vehicleSearch}%`)})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const agencies = await db.select().from(agenciesTable).where(where).orderBy(agenciesTable.name);
    const ids = agencies.map((a) => a.id);
    const vehicles = ids.length ? await db.select().from(agencyVehiclesTable).where(inArray(agencyVehiclesTable.agencyId, ids)) : [];
    const locations = ids.length ? await db.select().from(agencyLocationsTable).where(inArray(agencyLocationsTable.agencyId, ids)) : [];
    const links = ids.length ? await db.select({ agencyId: agencyKitchensTable.agencyId, kitchenId: agencyKitchensTable.kitchenId }).from(agencyKitchensTable).where(and(inArray(agencyKitchensTable.agencyId, ids), eq(agencyKitchensTable.isActive, true))) : [];
    const vByA = new Map<string, any[]>(); for (const v of vehicles) { const a = vByA.get(v.agencyId) ?? []; a.push(v); vByA.set(v.agencyId, a); }
    const lByA = new Map<string, any[]>(); for (const l of locations) { const a = lByA.get(l.agencyId) ?? []; a.push(l); lByA.set(l.agencyId, a); }
    const kByA = new Map<string, string[]>(); for (const k of links) { const a = kByA.get(k.agencyId) ?? []; a.push(k.kitchenId); kByA.set(k.agencyId, a); }
    res.json({ success: true, data: agencies.map((a) => ({ ...a, vehicles: vByA.get(a.id) ?? [], locations: lByA.get(a.id) ?? [], kitchenIds: kByA.get(a.id) ?? [] })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createAgencySchema = z.object({
  name: zText,
  phone: zPhone,
  contactName: z.string().max(256).nullish(),
  email: zEmail,
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/agencies", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createAgencySchema, req, res)) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(agenciesTable).values({
      id: newId(), name: b.name, phone: b.phone ?? null, contactName: b.contactName ?? null, email: b.email ?? null,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateAgencySchema = z.object({
  name: zText.optional(),
  phone: zPhone,
  contactName: z.string().max(256).nullish(),
  email: zEmail,
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/agencies/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateAgencySchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "phone", "contactName", "email", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(agenciesTable).set(u as never).where(eq(agenciesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/agencies/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(agenciesTable).set({ isActive: false, updatedAt: new Date() }).where(eq(agenciesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * B3 — Agency ↔ kitchen junction (agency_kitchens). Drives which agencies the
 * dispatch UI offers for a given kitchen. Reads gated on FOOD_ORG view, writes
 * on FOOD_ORG edit.
 * ──────────────────────────────────────────────────────────────────────────── */

// Linked (active) kitchens for an agency, joined to kitchen name/code.
foodRouter.get("/agencies/:id/kitchens", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const rows = await db.select({
      id: kitchensTable.id, name: kitchensTable.name, code: kitchensTable.code,
      linkId: agencyKitchensTable.id, linkedAt: agencyKitchensTable.createdAt,
    }).from(agencyKitchensTable)
      .innerJoin(kitchensTable, eq(agencyKitchensTable.kitchenId, kitchensTable.id))
      .where(and(eq(agencyKitchensTable.agencyId, req.params["id"]!), eq(agencyKitchensTable.isActive, true)))
      .orderBy(kitchensTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Replace-set the agency's linked kitchens. Wipes existing links then inserts the
// provided ids active, so the unique (agencyId,kitchenId) index never collides.
const setAgencyKitchensSchema = z.object({ kitchenIds: z.array(zId) }).passthrough();

foodRouter.put("/agencies/:id/kitchens", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(setAgencyKitchensSchema, req, res)) return;
    const agencyId = req.params["id"]!;
    const [agency] = await db.select({ id: agenciesTable.id }).from(agenciesTable).where(eq(agenciesTable.id, agencyId));
    if (!agency) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // De-dupe the requested ids so a repeated kitchenId can't violate the unique index.
    const kitchenIds = Array.from(new Set((req.body?.kitchenIds as string[]) ?? []));
    await db.transaction(async (tx) => {
      await tx.delete(agencyKitchensTable).where(eq(agencyKitchensTable.agencyId, agencyId));
      if (kitchenIds.length) {
        await tx.insert(agencyKitchensTable).values(kitchenIds.map((kitchenId) => ({
          id: newId(), agencyId, kitchenId, isActive: true,
        })));
      }
    });
    res.json({ success: true, data: { agencyId, kitchenIds } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Reverse lookup — active agencies linked to a kitchen, joined to agency name.
foodRouter.get("/kitchens/:id/agencies", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const rows = await db.select({
      id: agenciesTable.id, name: agenciesTable.name, isActive: agenciesTable.isActive,
      linkId: agencyKitchensTable.id, linkedAt: agencyKitchensTable.createdAt,
    }).from(agencyKitchensTable)
      .innerJoin(agenciesTable, eq(agencyKitchensTable.agencyId, agenciesTable.id))
      .where(and(eq(agencyKitchensTable.kitchenId, req.params["id"]!), eq(agencyKitchensTable.isActive, true)))
      .orderBy(agenciesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Nested locations (flat update/delete paths to avoid :id collisions)
const createAgencyLocationSchema = z.object({
  name: zText,
  address: z.string().max(1000).nullish(),
  city: z.string().max(256).nullish(),
  state: z.string().max(256).nullish(),
  pincode: z.string().max(16).nullish(),
  contactName: z.string().max(256).nullish(),
  contactPhone: z.string().max(32).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/agencies/:id/locations", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createAgencyLocationSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(agencyLocationsTable).values({
      id: newId(), agencyId: req.params["id"]!, name: b.name, address: b.address ?? null, city: b.city ?? null,
      state: b.state ?? null, pincode: b.pincode ?? null, contactName: b.contactName ?? null, contactPhone: b.contactPhone ?? null,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateAgencyLocationSchema = z.object({
  name: zText.optional(),
  address: z.string().max(1000).nullish(),
  city: z.string().max(256).nullish(),
  state: z.string().max(256).nullish(),
  pincode: z.string().max(16).nullish(),
  contactName: z.string().max(256).nullish(),
  contactPhone: z.string().max(32).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/agency-locations/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateAgencyLocationSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "address", "city", "state", "pincode", "contactName", "contactPhone", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(agencyLocationsTable).set(u as never).where(eq(agencyLocationsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/agency-locations/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(agencyLocationsTable).where(eq(agencyLocationsTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Nested vehicles
const createAgencyVehicleSchema = z.object({
  vehicleNumber: z.string().min(1).max(64),
  vehicleType: z.string().max(64).nullish(),
  locationId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/agencies/:id/vehicles", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createAgencyVehicleSchema, req, res)) return;
    const b = req.body || {};
    if (!b.vehicleNumber) { res.status(400).json({ success: false, error: "vehicleNumber required" }); return; }
    const [row] = await db.insert(agencyVehiclesTable).values({
      id: newId(), agencyId: req.params["id"]!, locationId: b.locationId ?? null,
      vehicleNumber: b.vehicleNumber, vehicleType: b.vehicleType ?? "VAN", isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateAgencyVehicleSchema = z.object({
  vehicleNumber: z.string().max(64).optional(),
  vehicleType: z.string().max(64).nullish(),
  locationId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/agency-vehicles/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateAgencyVehicleSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["vehicleNumber", "vehicleType", "locationId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(agencyVehiclesTable).set(u as never).where(eq(agencyVehiclesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/agency-vehicles/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(agencyVehiclesTable).where(eq(agencyVehiclesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Geographic hierarchy
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/zones", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(zonesTable).orderBy(zonesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createZoneSchema = z.object({
  name: zText,
  code: z.string().max(64).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/zones", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createZoneSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(zonesTable).values({
      id: newId(), name: b.name, code: b.code ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateZoneSchema = z.object({
  name: zText.optional(),
  code: z.string().max(64).nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/zones/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateZoneSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "code", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(zonesTable).set(u as Partial<typeof zonesTable.$inferInsert>).where(eq(zonesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/zones/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(zonesTable).where(eq(zonesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.get("/cities", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const zoneId = req.query["zoneId"] as string | undefined;
    const where = zoneId ? eq(citiesTable.zoneId, zoneId) : undefined;
    const rows = await db.select().from(citiesTable).where(where).orderBy(citiesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createCitySchema = z.object({
  name: zText,
  zoneId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/cities", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createCitySchema, req, res)) return;
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(citiesTable).values({
      id: newId(), name: b.name, zoneId: b.zoneId ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateCitySchema = z.object({
  name: zText.optional(),
  zoneId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/cities/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateCitySchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "zoneId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(citiesTable).set(u as Partial<typeof citiesTable.$inferInsert>).where(eq(citiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/cities/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(citiesTable).where(eq(citiesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.get("/clusters", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const cityId = req.query["cityId"] as string | undefined;
    const where = cityId ? eq(clustersTable.cityId, cityId) : undefined;
    const rows = await db.select().from(clustersTable).where(where).orderBy(clustersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const createClusterSchema = z.object({
  name: zText,
  cityId: zId,
  managerId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.post("/clusters", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    if (!validateBody(createClusterSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name || !b.cityId) { res.status(400).json({ success: false, error: "name, cityId required" }); return; }
    const [row] = await db.insert(clustersTable).values({
      id: newId(), name: b.name, cityId: b.cityId, managerId: b.managerId ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const updateClusterSchema = z.object({
  name: zText.optional(),
  cityId: zId.optional(),
  managerId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/clusters/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateClusterSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "cityId", "managerId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(clustersTable).set(u as Partial<typeof clustersTable.$inferInsert>).where(eq(clustersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/clusters/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(clustersTable).where(eq(clustersTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const assignClusterSchema = z.object({ clusterId: zId.nullish() }).passthrough();

foodRouter.post("/properties/:id/assign-cluster", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignClusterSchema, req, res)) return;
    const clusterId = req.body?.clusterId ?? null;
    const [row] = await db.update(propertiesTable).set({ clusterId, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — User scopes
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/scopes", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const userId = req.query["userId"] as string | undefined;
    const where = userId ? eq(userScopesTable.userId, userId) : undefined;
    const rows = await db.select().from(userScopesTable).where(where).orderBy(desc(userScopesTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// scopeLevel is kept a bounded string (not enum) so the handler's own
// "Invalid scopeLevel" / per-level-id checks still produce their specific messages.
const createScopeSchema = z.object({
  userId: zId,
  scopeLevel: z.string().min(1).max(32),
  zoneId: zId.nullish(),
  cityId: zId.nullish(),
  kitchenId: zId.nullish(),
  clusterId: zId.nullish(),
  propertyId: zId.nullish(),
}).passthrough();

foodRouter.post("/scopes", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(createScopeSchema, req, res)) return;
    const b = req.body || {};
    if (!b.userId || !b.scopeLevel) { res.status(400).json({ success: false, error: "userId, scopeLevel required" }); return; }
    // This is the org's access-control plane: forbid granting a scope to yourself
    // (no self-escalation), and restrict minting GLOBAL access to the two
    // genuinely org-wide roles. Respond inline (not throw) so the route's local
    // catch can't downgrade the 403 to a generic 500.
    if (b.userId === req.user!.id) { res.status(403).json({ success: false, error: "Cannot grant an access scope to yourself" }); return; }
    if (b.scopeLevel === "GLOBAL" && req.user!.role !== "SUPER_ADMIN" && req.user!.role !== "OPS_EXCELLENCE") {
      res.status(403).json({ success: false, error: "Only SUPER_ADMIN or OPS_EXCELLENCE may grant a GLOBAL scope" });
      return;
    }
    const geoIdByLevel: Record<string, string | undefined> = {
      ZONE: b.zoneId,
      CITY: b.cityId,
      KITCHEN: b.kitchenId,
      CLUSTER: b.clusterId,
      PROPERTY: b.propertyId,
    };
    if (b.scopeLevel !== "GLOBAL" && !geoIdByLevel[b.scopeLevel]) {
      const field = { ZONE: "zoneId", CITY: "cityId", KITCHEN: "kitchenId", CLUSTER: "clusterId", PROPERTY: "propertyId" }[b.scopeLevel as string];
      res.status(400).json({ success: false, error: field ? `${field} required for ${b.scopeLevel} scope` : `Invalid scopeLevel ${b.scopeLevel}` });
      return;
    }
    const [row] = await db.insert(userScopesTable).values({
      id: newId(),
      userId: b.userId,
      scopeLevel: b.scopeLevel,
      zoneId: b.zoneId ?? null,
      cityId: b.cityId ?? null,
      kitchenId: b.kitchenId ?? null,
      clusterId: b.clusterId ?? null,
      propertyId: b.propertyId ?? null,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/scopes/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    await db.delete(userScopesTable).where(eq(userScopesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Food users
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/food-users", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const rows = await db.select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      propertyId: usersTable.propertyId,
    }).from(usersTable)
      .where(inArray(usersTable.role, FOOD_USER_ROLES as unknown as string[] as never[]))
      .orderBy(usersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default foodRouter;
