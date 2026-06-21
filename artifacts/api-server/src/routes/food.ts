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
  dishesTable,
  rawMaterialsTable,
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
} from "@workspace/db";
import { and, eq, or, ilike, sql, desc, asc, gte, lte, inArray, isNull } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
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
} from "../lib/food-service.js";
import { notifyOrderEvent } from "../lib/notification-service.js";
import { toXls } from "../lib/export-service.js";
// Shared order cut-off enforcement (single source of truth lives in food-ops.ts,
// alongside resolveCutoff()/atTime()) so /orders and /order-batches stay consistent.
import { checkOrderCutoff } from "./food-ops.js";

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

/** True if the order's property is within the caller's accessible set (null = all). */
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

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
        ordered: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'PLACED')::int`,
        dispatched: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'DISPATCHED')::int`,
        delivered: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'DELIVERED')::int`,
      }).from(foodOrdersTable).where(baseConds(lo, hi));
      return {
        total: row?.total ?? 0,
        ordered: row?.ordered ?? 0,
        dispatched: row?.dispatched ?? 0,
        delivered: row?.delivered ?? 0,
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
        ordered: sql<number>`count(*) filter (where ${inWindow(foodOrdersTable.createdAt)})::int`,
        dispatched: sql<number>`count(*) filter (where ${foodOrdersTable.dispatchedAt} is not null and ${inWindow(foodOrdersTable.dispatchedAt)})::int`,
        delivered: sql<number>`count(*) filter (where ${foodOrdersTable.deliveredAt} is not null and ${inWindow(foodOrdersTable.deliveredAt)})::int`,
      }).from(foodOrdersTable).where(scopeWhere);
      return {
        total: row?.total ?? 0,
        ordered: row?.ordered ?? 0,
        dispatched: row?.dispatched ?? 0,
        delivered: row?.delivered ?? 0,
      };
    };

    const cur = await aggFor(from, to);
    const prev = await prevAggFor(prevFrom, prevTo);
    const pct = (c: number, p: number) => (p === 0 ? (c > 0 ? 100 : 0) : Math.round(((c - p) / p) * 1000) / 10);

    // Pending actions (current scope, not time-bounded).
    const pendConds = [] as ReturnType<typeof eq>[];
    if (scope) pendConds.push(scope);
    if (propertyId) pendConds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (brand) pendConds.push(eq(foodOrdersTable.brand, brand as never));
    const pendWhere = pendConds.length ? and(...pendConds) : undefined;

    const [pendRow] = await db.select({
      awaitingDispatch: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'PREPARING')::int`,
      awaitingConfirmation: sql<number>`count(*) filter (where ${foodOrdersTable.status} = 'DISPATCHED')::int`,
    }).from(foodOrdersTable).where(pendWhere);

    // Waste pending: DELIVERED, still within edit window, with any item missing wastedQty.
    const wasteConds = [
      eq(foodOrdersTable.status, "DELIVERED"),
      gte(foodOrdersTable.wasteEditableUntil, new Date()),
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
          ordered: { value: cur.ordered, changePct: pct(cur.ordered, prev.ordered) },
          dispatched: { value: cur.dispatched, changePct: pct(cur.dispatched, prev.dispatched) },
          delivered: { value: cur.delivered, changePct: pct(cur.delivered, prev.delivered) },
        },
        pendingActions: {
          awaitingDispatch: pendRow?.awaitingDispatch ?? 0,
          awaitingConfirmation: pendRow?.awaitingConfirmation ?? 0,
          wastePending: wasteRow?.c ?? 0,
        },
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Orders
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/orders", authenticate, authorize("FOOD_ALL_ORDERS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);

    const status = req.query["status"] as string | undefined;
    const from = parseDate(req.query["from"]);
    const to = parseDate(req.query["to"]);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const search = req.query["search"] as string | undefined;

    const conds = [] as ReturnType<typeof eq>[];
    if (scope) conds.push(scope);
    if (status) conds.push(eq(foodOrdersTable.status, status as never));
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
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .where(where)
      .orderBy(desc(foodOrdersTable.createdAt))
      .limit(limit).offset(offset);

    const data = rows.map((r) => ({
      ...r.o,
      totalQuantity: r.o.totalQuantity != null ? Number(r.o.totalQuantity) : null,
      propertyName: r.propertyName,
      unitLeadName: r.unitLeadName,
    }));
    res.json({ success: true, data, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/orders", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    const { propertyId, mealType, serviceDate, quantity, residentsCount, notes } = b;
    if (!propertyId || !mealType || !serviceDate || quantity == null) {
      res.status(400).json({ success: false, error: "propertyId, mealType, serviceDate, quantity required" });
      return;
    }
    if (!(MEAL_TYPES as readonly string[]).includes(mealType)) { res.status(400).json({ success: false, error: `Invalid mealType: ${mealType}` }); return; }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) { res.status(400).json({ success: false, error: "quantity must be a positive number" }); return; }
    const sd = new Date(serviceDate);
    if (isNaN(sd.getTime())) { res.status(400).json({ success: false, error: "Invalid serviceDate" }); return; }

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

// Static routes BEFORE param routes.
foodRouter.post("/orders/dispatch/bulk", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const orderIds: string[] = Array.isArray(b.orderIds) ? b.orderIds : [];
    const deliveryPartnerId = b.deliveryPartnerId as string | undefined;
    if (!orderIds.length) { res.status(400).json({ success: false, error: "orderIds required" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    const orders = await db.select().from(foodOrdersTable).where(inArray(foodOrdersTable.id, orderIds));
    const byId = new Map(orders.map((o) => [o.id, o]));
    const now = new Date();
    const results: Array<{ orderId: string; status: "DISPATCHED" | "SKIPPED" | "FORBIDDEN" | "NOT_FOUND"; reason?: string }> = [];

    for (const oid of orderIds) {
      const o = byId.get(oid);
      if (!o) { results.push({ orderId: oid, status: "NOT_FOUND" }); continue; }
      if (!isAccessible(o.propertyId, ids)) { results.push({ orderId: oid, status: "FORBIDDEN" }); continue; }
      if (o.status === "DELIVERED" || o.status === "CANCELLED" || o.status === "DISPATCHED") {
        results.push({ orderId: oid, status: "SKIPPED", reason: `Order is ${o.status}` });
        continue;
      }
      await db.update(foodOrdersTable).set({
        status: "DISPATCHED",
        dispatchedAt: now,
        dispatchStartedAt: o.dispatchStartedAt ?? now,
        deliveryPartnerId: deliveryPartnerId ?? o.deliveryPartnerId ?? null,
        dispatchedById: req.user!.id,
        updatedAt: now,
      }).where(eq(foodOrdersTable.id, oid));
      await db.insert(foodOrderEventsTable).values({
        id: newId(), orderId: oid, status: "DISPATCHED", note: "Order dispatched", actorId: req.user!.id,
      });
      results.push({ orderId: oid, status: "DISPATCHED" });
    }
    res.json({ success: true, data: { results } });
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
    }).from(foodOrdersTable)
      .leftJoin(propertiesTable, eq(foodOrdersTable.propertyId, propertiesTable.id))
      .leftJoin(usersTable, eq(foodOrdersTable.unitLeadId, usersTable.id))
      .leftJoin(agenciesTable, eq(foodOrdersTable.deliveryPartnerId, agenciesTable.id))
      .leftJoin(kitchensTable, eq(foodOrdersTable.kitchenId, kitchensTable.id))
      .leftJoin(foodDispatchesTable, eq(foodOrdersTable.dispatchId, foodDispatchesTable.id))
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

foodRouter.put("/orders/:id", authenticate, authorize("FOOD_PLACE_ORDER", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "PLACED" && order.status !== "PREPARING") {
      res.status(422).json({ success: false, error: "Order can only be edited while PLACED or PREPARING" });
      return;
    }

    const b = req.body || {};
    const update: Record<string, unknown> = { updatedAt: new Date() };
    let recompute = false;

    const quantity = b.quantity != null ? Number(b.quantity) : Number(order.totalQuantity);
    if (b.quantity != null) {
      if (!Number.isFinite(quantity) || quantity <= 0) { res.status(400).json({ success: false, error: "quantity must be a positive number" }); return; }
      update["totalQuantity"] = String(quantity);
      recompute = true;
    }
    if (b.residentsCount != null) update["residentsCount"] = Number(b.residentsCount);
    if (b.notes !== undefined) update["notes"] = b.notes ?? null;

    const mealType = b.mealType ?? order.mealType;
    if (b.mealType !== undefined && b.mealType !== order.mealType) { update["mealType"] = b.mealType; recompute = true; }
    const brand = b.brand ?? order.brand;
    if (b.brand !== undefined && b.brand !== order.brand) { update["brand"] = b.brand; recompute = true; }
    let serviceDate = order.serviceDate;
    if (b.serviceDate !== undefined) {
      const sd = new Date(b.serviceDate);
      if (isNaN(sd.getTime())) { res.status(400).json({ success: false, error: "Invalid serviceDate" }); return; }
      if (sd.getTime() !== order.serviceDate.getTime()) { update["serviceDate"] = sd; recompute = true; }
      serviceDate = sd;
    }

    const [updated] = await db.update(foodOrdersTable).set(update as Partial<typeof foodOrdersTable.$inferInsert>).where(eq(foodOrdersTable.id, id)).returning();

    if (recompute) {
      const computed = await computeOrderItems(order.kitchenId, brand, mealType, serviceDate, quantity);
      await db.delete(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
      if (computed.length) {
        await db.insert(foodOrderItemsTable).values(computed.map((it) => ({
          id: newId(),
          orderId: id,
          dishId: it.dishId,
          unit: it.unit as never,
          orderedQty: String(it.orderedQty),
          updatedAt: new Date(),
        })));
      }
    }

    res.json({ success: true, data: { ...updated, totalQuantity: updated.totalQuantity != null ? Number(updated.totalQuantity) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/orders/:id/cancel", authenticate, authorize("FOOD_PLACE_ORDER", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "PLACED" && order.status !== "PREPARING") {
      res.status(422).json({ success: false, error: "Only PLACED or PREPARING orders can be cancelled" });
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

foodRouter.post("/orders/:id/prepare", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "PLACED") { res.status(422).json({ success: false, error: "Only PLACED orders can be marked PREPARING" }); return; }

    const now = new Date();
    const [updated] = await db.update(foodOrdersTable).set({ status: "PREPARING", preparingAt: now, updatedAt: now }).where(eq(foodOrdersTable.id, id)).returning();
    await db.update(foodOrderItemsTable)
      .set({ preparedQty: sql`${foodOrderItemsTable.orderedQty}`, updatedAt: now })
      .where(and(eq(foodOrderItemsTable.orderId, id), isNull(foodOrderItemsTable.preparedQty)));
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: "PREPARING", note: "Marked preparing", actorId: req.user!.id,
    });
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/orders/:id/dispatch", authenticate, authorize("FOOD_DISPATCH", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const b = req.body || {};
    const action = (b.action as string | undefined) || "dispatch";
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }

    const now = new Date();
    if (action === "start") {
      if (order.status === "DISPATCHED" || order.status === "DELIVERED" || order.status === "CANCELLED") {
        res.status(422).json({ success: false, error: `Cannot start dispatch for an order that is ${order.status}` });
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
    if (order.status === "DELIVERED" || order.status === "CANCELLED" || order.status === "DISPATCHED") {
      res.status(422).json({ success: false, error: `Cannot dispatch an order that is ${order.status}` });
      return;
    }
    const [updated] = await db.update(foodOrdersTable).set({
      status: "DISPATCHED",
      dispatchedAt: now,
      dispatchStartedAt: order.dispatchStartedAt ?? now,
      deliveryPartnerId: b.deliveryPartnerId,
      dispatchedById: req.user!.id,
      updatedAt: now,
    }).where(eq(foodOrdersTable.id, id)).returning();
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: "DISPATCHED", note: "Order dispatched", actorId: req.user!.id,
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

foodRouter.post("/orders/:id/confirm-delivery", authenticate, authorize("FOOD_CONFIRM_DELIVERY", "edit"), async (req, res) => {
  try {
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
    for (const inp of items) {
      await db.update(foodOrderItemsTable).set({ receivedQty: String(Number(inp.receivedQty)), updatedAt: now }).where(eq(foodOrderItemsTable.id, inp.itemId));
    }
    const [updated] = await db.update(foodOrdersTable).set({
      status: "DELIVERED",
      deliveredAt: now,
      wasteEditableUntil: new Date(now.getTime() + 3600000),
      confirmedById: req.user!.id,
      deliveryRemarks: b.remarks ?? null,
      updatedAt: now,
    }).where(eq(foodOrdersTable.id, id)).returning();
    await db.insert(foodOrderEventsTable).values({
      id: newId(), orderId: id, status: "DELIVERED", note: "Delivery confirmed", actorId: req.user!.id,
    });
    await notifyOrderEvent("DELIVERED", {
      unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand,
    });
    res.json({ success: true, data: updated });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/orders/:id/waste", authenticate, authorize("FOOD_WASTE_TRACKING", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const b = req.body || {};
    const [order] = await db.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id));
    if (!order) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(order.propertyId, ids)) { res.status(403).json({ success: false, error: "Order not accessible" }); return; }
    if (order.status !== "DELIVERED") { res.status(422).json({ success: false, error: "Waste can only be recorded for DELIVERED orders" }); return; }
    if (!order.wasteEditableUntil || new Date() > order.wasteEditableUntil) {
      res.status(422).json({ success: false, error: "Waste edit window closed" });
      return;
    }

    const items: Array<{ itemId: string; wastedQty: number }> = Array.isArray(b.items) ? b.items : [];
    const orderItems = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    const itemById = new Map(orderItems.map((it) => [it.id, it]));
    for (const inp of items) {
      const it = itemById.get(inp.itemId);
      if (!it) { res.status(400).json({ success: false, error: `Unknown itemId ${inp.itemId}` }); return; }
      const wq = Number(inp.wastedQty);
      if (!Number.isFinite(wq) || wq < 0 || wq > Number(it.orderedQty)) {
        res.status(400).json({ success: false, error: `wastedQty for ${inp.itemId} must be between 0 and ${it.orderedQty}` });
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

    const date = parseDate(req.query["date"]);
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const clusterId = req.query["clusterId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;

    const conds = [inArray(foodOrdersTable.status, ["PLACED", "PREPARING"])];
    if (scope) conds.push(scope);
    if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
    if (mealType) conds.push(eq(foodOrdersTable.mealType, mealType as never));
    if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
    if (date) {
      const lo = new Date(date); lo.setHours(0, 0, 0, 0);
      const hi = new Date(lo.getTime() + 86400000);
      conds.push(gte(foodOrdersTable.serviceDate, lo));
      conds.push(lte(foodOrdersTable.serviceDate, hi));
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

    const residentTrend = await db.select({ date: day, residents: sql<number>`coalesce(sum(${foodOrdersTable.residentsCount}), 0)::int` })
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

foodRouter.get("/reports/export", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
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

    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Order ID", "Property", "Unit Lead", "Brand", "Meal", "Residents", "Quantity", "Status", "Service Date", "Delivered At"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        esc(r.o.orderNumber),
        esc(r.propertyName),
        esc(r.unitLeadName),
        esc(r.o.brand),
        esc(r.o.mealType),
        esc(r.o.residentsCount),
        esc(r.o.totalQuantity != null ? Number(r.o.totalQuantity) : ""),
        esc(r.o.status),
        esc(r.o.serviceDate ? new Date(r.o.serviceDate).toISOString().slice(0, 10) : ""),
        esc(r.o.deliveredAt ? new Date(r.o.deliveredAt).toISOString() : ""),
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=food-orders.csv");
    res.send(lines.join("\n"));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Lookups
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/lookups", authenticate, async (req, res) => {
  try {
    const properties = await db.select({
      id: propertiesTable.id, name: propertiesTable.name,
      brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId, clusterId: propertiesTable.clusterId,
    }).from(propertiesTable).orderBy(propertiesTable.name);
    // Agencies (with their active vehicles) for the dispatch dropdowns.
    const agencyRows = await db.select({ id: agenciesTable.id, name: agenciesTable.name })
      .from(agenciesTable).where(eq(agenciesTable.isActive, true)).orderBy(agenciesTable.name);
    const vehicleRows = await db.select({ id: agencyVehiclesTable.id, agencyId: agencyVehiclesTable.agencyId, vehicleNumber: agencyVehiclesTable.vehicleNumber, vehicleType: agencyVehiclesTable.vehicleType, locationId: agencyVehiclesTable.locationId })
      .from(agencyVehiclesTable).where(eq(agencyVehiclesTable.isActive, true));
    const vByA = new Map<string, any[]>(); for (const v of vehicleRows) { const a = vByA.get(v.agencyId) ?? []; a.push(v); vByA.set(v.agencyId, a); }
    const agencies = agencyRows.map((a) => ({ ...a, vehicles: vByA.get(a.id) ?? [] }));
    const brands = await db.select({ code: foodBrandsTable.code, name: foodBrandsTable.name })
      .from(foodBrandsTable).where(eq(foodBrandsTable.isActive, true)).orderBy(foodBrandsTable.name);
    res.json({
      success: true,
      // deliveryPartners kept as an alias of agencies {id,name} for back-compat.
      data: { properties, agencies, deliveryPartners: agencyRows, brands, mealTypes: MEAL_TYPES },
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

/** Replace a dish's ingredient rows from a [{rawMaterialId, quantity?, unit?}] list. */
async function replaceDishIngredients(dishId: string, ingredients: unknown): Promise<void> {
  await db.delete(dishIngredientsTable).where(eq(dishIngredientsTable.dishId, dishId));
  const valid = (Array.isArray(ingredients) ? ingredients : []).filter((it) => it && it.rawMaterialId);
  if (!valid.length) return;
  await db.insert(dishIngredientsTable).values(valid.map((it) => ({
    id: newId(), dishId, rawMaterialId: it.rawMaterialId,
    quantity: it.quantity != null && it.quantity !== "" ? String(it.quantity) : null,
    unit: it.unit != null && it.unit !== "" ? it.unit : null, updatedAt: new Date(),
  })));
}

/** Loads a dish's ingredients joined to raw-material names. */
async function loadDishIngredients(dishId: string) {
  return db.select({
    id: dishIngredientsTable.id, rawMaterialId: dishIngredientsTable.rawMaterialId,
    rawMaterialName: rawMaterialsTable.name, quantity: dishIngredientsTable.quantity, unit: dishIngredientsTable.unit,
  }).from(dishIngredientsTable)
    .leftJoin(rawMaterialsTable, eq(dishIngredientsTable.rawMaterialId, rawMaterialsTable.id))
    .where(eq(dishIngredientsTable.dishId, dishId));
}

foodRouter.post("/dishes", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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

foodRouter.put("/dishes/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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
 * Master data — Raw materials (ingredients)
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/raw-materials", authenticate, async (req, res) => {
  try {
    const search = req.query["search"] as string | undefined;
    const active = req.query["active"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (search) conds.push(ilike(rawMaterialsTable.name, `%${search}%`));
    if (active !== undefined) conds.push(eq(rawMaterialsTable.isActive, active === "true"));
    const rows = await db.select().from(rawMaterialsTable).where(conds.length ? and(...conds) : undefined).orderBy(rawMaterialsTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/raw-materials", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.unit) { res.status(400).json({ success: false, error: "name and unit required" }); return; }
    const [row] = await db.insert(rawMaterialsTable).values({
      id: newId(), name: b.name, unit: b.unit, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/raw-materials/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "unit", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(rawMaterialsTable).set(u as never).where(eq(rawMaterialsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.delete("/raw-materials/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [row] = await db.update(rawMaterialsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(rawMaterialsTable.id, req.params["id"]!)).returning();
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

// Export the current menu rotation (honours the same filters as the list) as .xls.
foodRouter.get("/menu-rotation/export.xlsx", authenticate, async (req, res) => {
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
    const xls = toXls({
      title: "Menu Rotation",
      headers: ["Kitchen", "Brand", "Week", "Day", "Meal", "Dish", "Slot", "Order"],
      rows: rows.map((r) => [r.kitchenName ?? "—", r.brand, `W${r.rotationWeek}`, DAYS[r.dayOfWeek] ?? r.dayOfWeek, r.mealType, r.dishName ?? "—", r.slotLabel ?? "", r.sortOrder]),
    });
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", "attachment; filename=menu-rotation.xls");
    res.send(xls);
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/menu-rotation", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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
foodRouter.post("/menu-rotation/bulk", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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
foodRouter.put("/menu-rotation/slot", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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
    res.json({ success: true, data: { ...validation, sharedIngredients } });
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

foodRouter.put("/menu-rotation/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/rules", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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

foodRouter.put("/rules/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/composition-rules", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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

foodRouter.put("/composition-rules/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/delivery-partners", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
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

foodRouter.put("/delivery-partners/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
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
    const where = active !== undefined ? eq(agenciesTable.isActive, active === "true") : undefined;
    const agencies = await db.select().from(agenciesTable).where(where).orderBy(agenciesTable.name);
    const ids = agencies.map((a) => a.id);
    const vehicles = ids.length ? await db.select().from(agencyVehiclesTable).where(inArray(agencyVehiclesTable.agencyId, ids)) : [];
    const locations = ids.length ? await db.select().from(agencyLocationsTable).where(inArray(agencyLocationsTable.agencyId, ids)) : [];
    const vByA = new Map<string, any[]>(); for (const v of vehicles) { const a = vByA.get(v.agencyId) ?? []; a.push(v); vByA.set(v.agencyId, a); }
    const lByA = new Map<string, any[]>(); for (const l of locations) { const a = lByA.get(l.agencyId) ?? []; a.push(l); lByA.set(l.agencyId, a); }
    res.json({ success: true, data: agencies.map((a) => ({ ...a, vehicles: vByA.get(a.id) ?? [], locations: lByA.get(a.id) ?? [] })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.post("/agencies", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(agenciesTable).values({
      id: newId(), name: b.name, phone: b.phone ?? null, contactName: b.contactName ?? null, email: b.email ?? null,
      isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/agencies/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

// Nested locations (flat update/delete paths to avoid :id collisions)
foodRouter.post("/agencies/:id/locations", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
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

foodRouter.put("/agency-locations/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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
foodRouter.post("/agencies/:id/vehicles", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.vehicleNumber) { res.status(400).json({ success: false, error: "vehicleNumber required" }); return; }
    const [row] = await db.insert(agencyVehiclesTable).values({
      id: newId(), agencyId: req.params["id"]!, locationId: b.locationId ?? null,
      vehicleNumber: b.vehicleNumber, vehicleType: b.vehicleType ?? "VAN", isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/agency-vehicles/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/zones", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(zonesTable).values({
      id: newId(), name: b.name, code: b.code ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/zones/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/cities", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(citiesTable).values({
      id: newId(), name: b.name, zoneId: b.zoneId ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/cities/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/clusters", authenticate, authorize("FOOD_ORG", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.cityId) { res.status(400).json({ success: false, error: "name, cityId required" }); return; }
    const [row] = await db.insert(clustersTable).values({
      id: newId(), name: b.name, cityId: b.cityId, managerId: b.managerId ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

foodRouter.put("/clusters/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/properties/:id/assign-cluster", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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

foodRouter.post("/scopes", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
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
