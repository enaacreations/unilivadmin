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
import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  foodOrdersTable,
  foodOrderItemsTable,
  foodOrderEventsTable,
  foodAdditionalOrderItemsTable,
  dishesTable,
  dishSideOptionsTable,
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
  mealTypeEnum,
  foodOrderStatusEnum,
  dishComponentEnum,
  measurementUnitEnum,
  agencyVehicleTypeEnum,
} from "@workspace/db";
import { and, eq, or, ilike, sql, desc, asc, gte, lte, lt, inArray, notInArray, isNull, isNotNull } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { canTransition } from "../lib/order-transitions.js";
import { z } from "zod";
import { authenticate, authorize as requireRoles } from "../middlewares/auth.js";
import { authorize, authorizeAny } from "../middlewares/authorize.js";
import { can, FOOD_MODULES, type UserRole } from "../lib/permissions.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import {
  resolveAccessiblePropertyIds,
  scopeOrdersCondition,
  resolveAccessibleKitchenIds,
  scopeRotationReadCondition,
  scopeRotationWriteCondition,
  assertKitchenAccess,
  assertMayRetireDish,
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
  isIngredientClashRuleOn,
  getWasteEditWindowMs,
  findPortionRuleUsage,
} from "../lib/food-service.js";
import { notifyOrderEvent } from "../lib/notification-service.js";
import {
  toCsv, toPdf, toMenuRotationPdf, fileDateStamp, sanitizeForFilename,
  type RotationExportRow,
} from "../lib/export-service.js";
// Shared order cut-off enforcement (single source of truth lives in food-ops.ts,
// alongside resolveCutoff()/atTime()) so /orders and /order-batches stay consistent.
import { checkOrderCutoff, createDispatchForOrders, reconcileDispatchForOrder, residentsCapForProperty, type TxClient } from "./food-ops.js";
import { ymdToIstDayStart, todayIstYmd, istParts } from "../lib/tz.js";
import { writeAuditLog } from "../lib/wallet-service.js";

export const foodRouter: Router = Router();

/** Resolves a property's display name for notification context. */
async function propertyName(propertyId: string): Promise<string | null> {
  const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  return p?.name ?? null;
}

/**
 * The values Postgres accepts on each enum-typed column, read off the enums
 * themselves so the two can never drift (L6). A param cast straight to an enum
 * with `as never` hands Postgres a value its type does not have, which comes
 * back as an opaque 500 instead of "that is not a meal type".
 */
const MEAL_TYPES = mealTypeEnum.enumValues;
const ORDER_STATUSES: readonly string[] = foodOrderStatusEnum.enumValues;
const DISH_COMPONENTS = dishComponentEnum.enumValues;
const MEASUREMENT_UNITS = measurementUnitEnum.enumValues;
const VEHICLE_TYPES = agencyVehicleTypeEnum.enumValues;
/**
 * The roles GET /food-users lists, i.e. the roles an admin can pick when granting
 * a food access scope.
 *
 * Invariant: every role whose food access is resolved from `user_scopes` MUST be
 * listed here, or its grant is unmakeable through the product. Scope resolution
 * is fail-closed — a non-org-wide role with no grant resolves to NO properties —
 * so KITCHEN_MANAGER's omission meant a kitchen manager who lost (or never got)
 * a grant lost the food module with no in-product repair, which is why
 * seed-food.ts has to hand-insert a CITY grant for exactly that role. The
 * endpoint below is a read-only listing behind FOOD_ORG:view, and POST /scopes
 * never consults this list, so widening it confers no capability of its own.
 */
const FOOD_USER_ROLES = [
  "UNIT_LEAD", "CLUSTER_MANAGER", "CITY_HEAD", "ZONAL_HEAD", "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT", "FNB_SUPERVISOR", "FNB_MANAGER", "FNB_ZONAL_HEAD",
  "KITCHEN_MANAGER",
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

/**
 * The two ends of a report window, read as IST CALENDAR days (M8).
 *
 * Every window below compares against `food_orders.service_date`, which is
 * stored at 00:00 IST — i.e. 18:30Z on the PREVIOUS day. A bare 'yyyy-MM-dd'
 * parsed as UTC midnight therefore sits ABOVE the day it names, so `from` silently
 * dropped the first service day of every range and `to` dropped the last: the
 * screens and the exports disagreed with each other about the same orders. A
 * value that already carries a time component is an absolute instant and passes
 * through untouched.
 */
function parseWindowStart(v: unknown): Date | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ymdToIstDayStart(s);
  return parseDate(s);
}

/** The window's INCLUSIVE upper bound: the last instant of that IST day. */
function parseWindowEnd(v: unknown): Date | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(ymdToIstDayStart(s).getTime() + 86400000 - 1);
  return parseDate(s);
}

/**
 * Start of the current Indian financial year (1 April) as an IST instant.
 *
 * Built from host-local `getMonth()`/`new Date(y, 3, 1)`, the boundary landed on
 * 31 March 18:30 IST on a UTC host — a whole evening of orders attributed to the
 * wrong FY, and the FY flipped a day early every year.
 */
function istFinancialYearStart(now: Date): Date {
  const p = istParts(now);
  const startYear = p.m >= 4 ? p.y : p.y - 1;
  return ymdToIstDayStart(`${startYear}-04-01`);
}

/** Postgres unique_violation — a duplicate the DB rejected; map it to the
 *  handler's own 4xx rather than letting it fall into a generic 500. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** The constraint a Postgres unique_violation names, so a handler can tell WHICH
 *  duplicate it hit (an order-number collision it retries vs a duplicate order it
 *  must report). */
function violatedConstraint(err: unknown): string | null {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ?? e?.cause?.constraint ?? null;
}

/**
 * Postgres check_violation, narrowed to a NAMED constraint.
 *
 * The sibling of isUniqueViolation for the CHECK constraints this module added
 * (non-negative headcounts and quantities). Deliberately name-matched rather
 * than matching bare 23514: a check violation is only a caller error on the
 * columns the caller supplies directly, and mapping every 23514 to a friendly
 * 4xx would convert a genuine bug — a computed quantity that came out negative —
 * into a message that reads like the user's fault and never gets investigated.
 * Anything not named here keeps falling through to fail()'s logged 500.
 */
function violatesCheck(err: unknown, ...names: string[]): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  if ((e?.code ?? e?.cause?.code) !== "23514") return false;
  const c = violatedConstraint(err);
  return c != null && names.includes(c);
}

/** True if the order's property is within the caller's accessible set (null = all). */
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

/**
 * The row `uq_food_orders_property_meal_date` protects: a LIVE order already
 * covering this (property, meal, service date). Mirrors that index's own
 * predicate exactly — CANCELLED and REJECTED are excluded so re-ordering a meal
 * after a cancellation is never reported as a duplicate.
 */
async function liveOrderExists(propertyId: string, mealType: string, serviceDate: Date): Promise<boolean> {
  const [row] = await db.select({ id: foodOrdersTable.id }).from(foodOrdersTable).where(and(
    eq(foodOrdersTable.propertyId, propertyId),
    eq(foodOrdersTable.mealType, mealType as never),
    eq(foodOrdersTable.serviceDate, serviceDate),
    notInArray(foodOrdersTable.status, ["CANCELLED", "REJECTED"]),
  )).limit(1);
  return !!row;
}

/**
 * Membership gate for a query param that lands on an enum column (L6). Mirrors
 * the inline check POST /orders already does on mealType — 400 naming the value
 * rather than the 500 Postgres raises on an unknown label. Returns false when
 * the request was refused, having already written the 400.
 */
function invalidEnumParam(
  res: Response, name: string, value: unknown, allowed: readonly string[],
): boolean {
  if (value === undefined || value === "") return false;
  if (allowed.includes(String(value))) return false;
  res.status(400).json({ success: false, error: `Invalid ${name}: ${String(value)}` });
  return true;
}

/**
 * Escapes the LIKE metacharacters in a caller-supplied search term (L7).
 *
 * Unescaped, `%` matches everything — `/orders/track?orderNumber=%` resolved an
 * arbitrary order org-wide — and a legitimate term containing `_` silently
 * matched a different row. Postgres' default LIKE escape is the backslash, and
 * the pattern travels as a bind parameter, so prefixing is all this needs.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * M17 — master-data / config audit trail
 *
 * Order-level history is already preserved in food_order_events, so this covers
 * the half that had NO record at all: the SETTINGS and ORG master data. Those
 * rows decide how many kilograms get ordered network-wide (per_resident_rules),
 * which property is fed by which kitchen and cluster (the assign-* endpoints),
 * what the kitchen is told to cook (dishes, rotation, composition rules) and who
 * can see any of it (user_scopes) — all of it changed with no record of the
 * actor or the value it replaced, and the hard deletes left nothing behind at
 * all. `before` is the whole point on a delete: it is the only reconstruction.
 *
 * `action` stays a three-value facet so the audit viewer's action filter remains
 * usable; the specific table is the `entity`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The audit_log `entity` for each food master-data / config table. */
type FoodConfigEntity =
  | "food_dish" | "food_ingredient" | "food_menu_rotation" | "food_per_resident_rule"
  | "food_composition_rule" | "food_delivery_partner" | "food_agency" | "food_agency_kitchens"
  | "food_agency_location" | "food_agency_vehicle" | "zone" | "city" | "cluster"
  | "property_cluster" | "user_scope";

/**
 * Records one master-data / config mutation. Fire-and-forget by design: an
 * audit-log failure must never fail the mutation it is recording, which is why
 * writeAuditLog swallows its own errors and this never awaits.
 *
 * Pass `before` on every UPDATE and DELETE — without the prior row the entry
 * says only that something changed, which on a hard delete is nothing at all.
 */
function auditConfig(
  req: Request,
  action: "FOOD_CONFIG_CREATED" | "FOOD_CONFIG_UPDATED" | "FOOD_CONFIG_DELETED",
  entity: FoodConfigEntity,
  entityId: string,
  changes: { before?: unknown; after?: unknown },
): void {
  void writeAuditLog(req.user!.id, action, entity, entityId, changes).catch(() => {});
}

/**
 * Thrown from inside a db.transaction to roll it back AND answer with a specific
 * 4xx. Needed because the lifecycle guards below now run inside the transaction
 * that writes (M1): a guard that fails there must not fall into the handler's
 * catch-all 500.
 */
class HandlerAbort extends Error {
  constructor(readonly statusCode: number, readonly body: { error: string; details?: unknown }) {
    super(body.error);
  }
}

/** Answers a HandlerAbort with its own status; returns false for anything else
 *  so the caller's existing 500 path still runs. */
function sendAbort(res: Response, err: unknown): boolean {
  if (!(err instanceof HandlerAbort)) return false;
  res.status(err.statusCode).json({ success: false, ...err.body });
  return true;
}

/**
 * The tail every handler in this file ends in.
 *
 * A domain error carrying `{ statusCode, details }` — the convention app.ts's
 * central handler is built for — used to be flattened to a generic 500 by those
 * local catches, which made the convention unreachable from this file and forced
 * each site to work around it inline (deniedKitchen below is exactly that
 * workaround, and its own comment names the problem). The one live example is
 * createDispatchForOrders' 422 "every order must be ACCEPTED", which the two
 * dispatch endpoints reported as "Internal server error".
 *
 * Re-throwing hands the error back to Express 5, which forwards a rejected async
 * handler to the central handler that already knows its shape. Anything without
 * a status stays the logged 500 it always was.
 */
function fail(req: Request, res: Response, err: unknown): void {
  if (sendAbort(res, err)) return;
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400) throw err;
  req.log.error(err);
  res.status(500).json({ success: false, error: "Internal server error" });
}

/**
 * Re-reads an order INSIDE a transaction, holding a row lock until it commits.
 *
 * Every lifecycle endpoint decides what it may do from the order's status. Read
 * outside the write's transaction, that status is a snapshot a concurrent actor
 * may already have invalidated — a cancel landing between a concurrent accept's
 * read and its write left a live ACCEPTED order carrying cancelledAt (M1). Both
 * actors are real: cancel accepts either FOOD_PLACE_ORDER:edit or
 * FOOD_KITCHEN_SUMMARY:edit. Callers MUST re-check the status on the row this
 * returns, not on the one they read before opening the transaction.
 *
 * Endpoints that write the status themselves use a conditional
 * `UPDATE … WHERE id = $1 AND status = $expected RETURNING *` instead; this
 * helper is for the ones that only read it (kitchen-items, waste, dispatch —
 * whose status write happens inside createDispatchForOrders).
 */
async function lockOrder(tx: TxClient, id: string): Promise<typeof foodOrdersTable.$inferSelect | null> {
  const [row] = await tx.select().from(foodOrdersTable).where(eq(foodOrdersTable.id, id)).for("update");
  return row ?? null;
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

    const to = parseWindowEnd(req.query["to"]) ?? new Date();
    const from = parseWindowStart(req.query["from"]) ?? new Date(to.getTime() - 30 * 86400000);
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
        // M6 — a LIVE order is one that was actually cooked. CANCELLED and
        // REJECTED are the two ways an order dies, and this widget excluded only
        // the first, so a rejected order still counted as an order placed. Same
        // predicate the reports use (reportConds / food-ops' LIVE_ORDERS), which
        // render beside this on the same screen and contradicted it.
        total: sql<number>`count(*) filter (where ${foodOrdersTable.status} not in ('CANCELLED', 'REJECTED'))::int`,
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
        // Same LIVE-order predicate as the current period (M6) — the two counts
        // are divided into each other, so a mismatch here is a bogus % change.
        total: sql<number>`count(*) filter (where ${foodOrdersTable.status} not in ('CANCELLED', 'REJECTED') and ${inWindow(foodOrdersTable.serviceDate)})::int`,
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
    const fyStart = istFinancialYearStart(now);
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

    // Waste pending: DELIVERED, the logging window still OPEN, with any item
    // missing wastedQty. wasteEditableUntil is the instant the window CLOSES
    // (M20), so "pending" is the set the lead can still act on — once it has
    // passed nothing can be logged and the order is no longer actionable.
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
  } catch (err) { fail(req, res, err); }
});

/**
 * Waste-pending rows for the dashboard table: DELIVERED orders still within the
 * waste-edit window that have at least one item missing wastedQty. Scoped to the
 * caller's accessible properties. Each row carries the absolute wasteEditableUntil
 * — the instant the window CLOSES — so the client can render a live "NN min left"
 * countdown against it.
 */
foodRouter.get("/waste-pending", authenticate, authorize("FOOD_DASHBOARD", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;

    const conds = [
      eq(foodOrdersTable.status, "DELIVERED"),
      // wasteEditableUntil is a CLOSING bound (M20): pending while it is still
      // in the future, i.e. while the lead can still log against the order.
      gte(foodOrdersTable.wasteEditableUntil, new Date()),
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
  } catch (err) { fail(req, res, err); }
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
    // IST calendar bounds — same invariant the serviceDate filter below spells out.
    const from = parseWindowStart(req.query["from"]);
    const to = parseWindowEnd(req.query["to"]);
    // Exact-match service-date filter (yyyy-MM-dd). serviceDate is a timestamp
    // anchored to IST day-start, so match the half-open IST day window.
    const serviceDate = req.query["serviceDate"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const search = req.query["search"] as string | undefined;

    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;

    // status accepts a single value or a CSV of statuses.
    let statuses = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : [];
    // Every value has to be a real status: one bad entry in the CSV reaches
    // Postgres as an unknown enum label and 500s the whole list (L6).
    const unknownStatus = statuses.find((s) => !ORDER_STATUSES.includes(s));
    if (unknownStatus) { res.status(400).json({ success: false, error: `Invalid status: ${unknownStatus}` }); return; }

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
    if (search) conds.push(ilike(foodOrdersTable.orderNumber, `%${escapeLike(search)}%`));
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
      // TOTAL sort key (M14). createdAt alone is not unique — POST /order-batches
      // inserts every order of a batch in one transaction, so they all take the
      // same now() default. LIMIT/OFFSET over a tied key has no defined tie order
      // between queries, so a client paging this list could get the same row on
      // two pages and never see another one: the boards' "accept everything"
      // action would then fire confetti over a set silently missing an order.
      .orderBy(desc(foodOrdersTable.createdAt), desc(foodOrdersTable.id))
      .limit(limit).offset(offset);

    const data = rows.map((r) => ({
      ...r.o,
      totalQuantity: r.o.totalQuantity != null ? Number(r.o.totalQuantity) : null,
      propertyName: r.propertyName,
      unitLeadName: r.unitLeadName,
      batchNumber: r.batchNumber,
    }));
    res.json({ success: true, data, meta: buildMeta(c.count, page, limit) });
  } catch (err) { fail(req, res, err); }
});

const placeOrderSchema = z.object({
  propertyId: zId,
  mealType: zMealType,
  serviceDate: z.union([z.string(), z.number(), z.coerce.date()]),
  // Both are headcounts multiplied into kilograms downstream, so a fraction or a
  // negative is not a smaller order, it is a nonsense one. Unbounded, they used
  // to reach the NOT NULL integer column and surface as an opaque 500 (H1); the
  // upper bound is the 120% occupancy cap enforced in the handler.
  quantity: z.coerce.number().int().min(0),
  residentsCount: z.coerce.number().int().min(0).nullish(),
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
    // H1 — the 120% occupancy cap, which both sibling write paths enforce
    // (POST /order-batches, PUT /orders/:id) and this one did not. `quantity` is
    // the headcount computeOrderItems multiplies by each portion rule, so an
    // unbounded value here IS an unbounded cook instruction: 5000 on a 40-bed
    // property was accepted silently. cap is 0 for a property with no ACTIVE
    // residents, matching food-ops.
    const { occupancy, cap: residentsCap } = await residentsCapForProperty(propertyId);
    const capped = Math.max(residents, qty);
    if (capped > residentsCap) {
      res.status(422).json({ success: false, error: `Residents for ${mealType} (${capped}) exceed the ${residentsCap} limit — at most 120% of your ${occupancy} occupied residents.` });
      return;
    }
    const computed = await computeOrderItems(kitchenId, brand, mealType, sd, qty);
    // An order with no lines is not an order (M4). The `if (computed.length)`
    // guard this replaces let an unresolvable menu create a PLACED header with
    // ZERO items and return 201 — the kitchen is told to cook nothing and the
    // lead is told the order is in. An empty resolution means the rotation or
    // the portion rules for this kitchen are incomplete; say so instead.
    if (!computed.length) {
      res.status(422).json({ success: false, error: "No dishes resolve for this meal — check the menu rotation and per-resident portion rules for this kitchen." });
      return;
    }
    const expDelivery = await resolveExpectedDeliveryAt(brand, mealType, sd, propertyId);
    // total_quantity is the SUM OF ITEM ORDERED QUANTITIES, exactly as the schema
    // documents it and as POST /order-batches already writes it (M11). It used to
    // hold the headcount here, so the same column meant two different things and
    // an ordinary headcount edit silently changed the unit of the "Quantity"
    // column mid-lifecycle. The headcount lives in residentsCount/staffCount.
    const totalQty = Math.round(computed.reduce((s, it) => s + it.orderedQty, 0) * 1000) / 1000;

    // Insert order with order-number retry on unique violation. Header + items +
    // the PLACED event are ONE unit of work (M4): written as three unrelated
    // statements, a failure part-way left an order that no later step could
    // reconcile — a header with no lines, or lines with no audit trail.
    let order: typeof foodOrdersTable.$inferSelect | undefined;
    let items: typeof foodOrderItemsTable.$inferSelect[] = [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = await nextOrderNumber();
      try {
        const written = await db.transaction(async (tx) => {
          const [o] = await tx.insert(foodOrdersTable).values({
            id: newId(),
            orderNumber,
            propertyId,
            brand,
            kitchenId,
            mealType,
            unitLeadId: req.user!.id,
            residentsCount: residents,
            totalQuantity: String(totalQty),
            status: "PLACED",
            serviceDate: sd,
            expectedDeliveryAt: expDelivery,
            notes: notes ?? null,
            createdById: req.user!.id,
            updatedAt: new Date(),
          }).returning();
          const its = await tx.insert(foodOrderItemsTable).values(computed.map((it) => ({
            id: newId(),
            orderId: o!.id,
            dishId: it.dishId,
            unit: it.unit as never,
            // computeOrderItems already resolved this: the meal headcount, or a
            // quantity-locked dish's own pinned count. Using `residents` here would
            // throw that away and unpin the dish on insert.
            personsCount: it.personsCount,
            orderedQty: String(it.orderedQty),
            updatedAt: new Date(),
          }))).returning();
          await tx.insert(foodOrderEventsTable).values({
            id: newId(),
            orderId: o!.id,
            status: "PLACED",
            note: "Order placed",
            actorId: req.user!.id,
          });
          return { order: o!, items: its };
        });
        order = written.order;
        items = written.items;
        break;
      } catch (e) {
        lastErr = e;
        // Two different unique violations reach here and they mean opposite
        // things. uq_food_orders_property_meal_date is the DB backstop for
        // "this property already has this meal on this day" — retrying it five
        // times just returns the wrong error, so report the caller's 409.
        // Anything else unique is an order-number collision: retry.
        //
        // Some driver wrappers drop the constraint name on the way out (the case
        // food-ops' isUniqueViolation defends against by matching a nameless
        // 23505 too). Here the two meanings are opposite, so a nameless one is
        // resolved by asking the table which it was rather than being retried
        // into "Failed to generate order number" — a 500 on a plain duplicate.
        const constraint = violatedConstraint(e);
        if (constraint === "uq_food_orders_property_meal_date"
          || (constraint === null && isUniqueViolation(e) && await liveOrderExists(propertyId, mealType, sd))) {
          res.status(409).json({ success: false, error: "An order for this property, meal and service date already exists." });
          return;
        }
        if (!isUniqueViolation(e) && !String((e as Error)?.message || "").toLowerCase().includes("unique")) throw e;
      }
    }
    if (!order) { req.log.error(lastErr); res.status(500).json({ success: false, error: "Failed to generate order number" }); return; }

    await notifyOrderEvent("PLACED", {
      unitLeadId: order.unitLeadId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId),
      mealType: order.mealType,
      brand: order.brand,
    });

    res.status(201).json({ success: true, data: { ...order, totalQuantity: order.totalQuantity != null ? Number(order.totalQuantity) : null, items } });
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
    const results: Array<{ orderId: string; status: "DISPATCHED" | "SKIPPED" | "FORBIDDEN" | "NOT_FOUND" | "FAILED"; reason?: string }> = [];

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
      //
      // Each trip is its own transaction AND its own failure boundary (M4): one
      // order throwing used to escape the loop and discard the whole `results`
      // array, so a caller who dispatched twenty orders and hit a problem on the
      // fifth got a 500 and no record of the four trips that had already
      // committed. Report the failure against its order and carry on.
      try {
        await db.transaction(async (tx) => {
          // The status above came from a snapshot taken before the loop started;
          // an earlier iteration or another dispatcher may have moved this order
          // since. Re-check it under a row lock inside the trip's own
          // transaction (M1).
          const locked = await lockOrder(tx, oid);
          if (!locked || !canTransition(locked.status, "DISPATCHED")) {
            throw new HandlerAbort(422, { error: `Order is ${locked?.status ?? "no longer present"} (must be ACCEPTED)` });
          }
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
      } catch (e) {
        if (e instanceof HandlerAbort) { results.push({ orderId: oid, status: "SKIPPED", reason: e.body.error }); continue; }
        req.log.error(e, "bulk dispatch: order failed");
        results.push({ orderId: oid, status: "FAILED", reason: "Dispatch failed for this order" });
      }
    }
    res.json({ success: true, data: { results } });
  } catch (err) { fail(req, res, err); }
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

    // The scope predicate belongs IN the lookup (L7). Resolving org-wide first
    // and refusing afterwards made the 403-vs-404 pair an existence oracle, and
    // an unescaped `%` matched an arbitrary row to point it at. The term is now
    // a literal (escapeLike), the row is picked deterministically rather than by
    // whatever the planner returned first, and an out-of-scope order is simply
    // not found.
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);
    const [match] = await db.select({ id: foodOrdersTable.id, propertyId: foodOrdersTable.propertyId })
      .from(foodOrdersTable)
      .where(and(
        or(
          eq(foodOrdersTable.id, term),
          ilike(foodOrdersTable.orderNumber, escapeLike(term)),
        ),
        ...(scope ? [scope] : []),
      ))
      // Total sort key for the same reason as the list above: batch-mates share a
      // createdAt, so "the newest match" has to be deterministic.
      .orderBy(desc(foodOrdersTable.createdAt), desc(foodOrdersTable.id))
      .limit(1);
    if (!match) { res.status(404).json({ success: false, error: "No order found for that number." }); return; }

    // Defence in depth: the WHERE above already excludes anything out of scope,
    // so this can no longer fire — it stays as the guard it has always been.
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
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
  // Caller-supplied idempotency key (M18), minted once per dialog open. Optional
  // only so an older client still works — without one, two identical
  // submissions are two real top-ups, because nothing claimed otherwise.
  requestId: zId.optional(),
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
    const b = req.body as { sourcePropertyId: string; items: { dishId: string; qty: number }[]; requestId?: string };
    const [src] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.id, b.sourcePropertyId));
    if (!src) { res.status(400).json({ success: false, error: "Unknown source property" }); return; }
    // Canonical unit comes from the dish (never trust the client for it).
    const dishRows = await db.select({ id: dishesTable.id, unit: dishesTable.unit })
      .from(dishesTable).where(inArray(dishesTable.id, b.items.map((it) => it.dishId)));
    const unitOf = new Map(dishRows.map((d) => [d.id, d.unit]));
    if (b.items.some((it) => !unitOf.has(it.dishId))) {
      res.status(400).json({ success: false, error: "Unknown dish" }); return;
    }
    const lines = b.items.filter((it) => it.qty > 0);
    if (!lines.length) { res.status(400).json({ success: false, error: "At least one item with a positive quantity is required" }); return; }

    // Idempotency (M18). This handler used to mint a fresh requestId on every
    // call, so a resubmitted top-up was indistinguishable from a second one and
    // double-counted food that never arrived twice — and the waste cap below
    // reads these rows. The key is now EXPLICIT: the dialog mints a requestId per
    // open and sends it, so a replay is decided by identity, not by resemblance.
    //
    // The content heuristic that stood in for it is gone: it could not tell a
    // resubmission from two genuine identical top-ups minutes apart, and
    // swallowing the second one left the waste cap short of what actually landed
    // while the dialog still said "logged". A caller that sends no requestId gets
    // a fresh one — two identical submissions are then two real top-ups, which is
    // the safe reading when nobody claimed they were the same request.
    const requestId = b.requestId ?? newId();
    const now = new Date();
    // The rows and their audit event commit together: a top-up that is invisible
    // on the order timeline is unauditable, which is the whole of M18. Excluding
    // it from KITCHEN variance stays deliberate (see the block comment above) —
    // this only records that it happened, and who did it.
    const inserted = await db.transaction(async (tx) => {
      // onConflictDoNothing against uq_food_additional_request_dish: this is the
      // DB half of the guard, and it is what makes a double-clicked dialog (two
      // requests carrying the same key, neither having committed when the other
      // reads) land once instead of twice.
      const rows = await tx.insert(foodAdditionalOrderItemsTable).values(
        lines.map((it) => ({
          id: newId(), orderId: id, requestId, sourcePropertyId: b.sourcePropertyId,
          dishId: it.dishId, unit: unitOf.get(it.dishId)!, qty: String(it.qty),
          createdById: req.user!.id, createdAt: now,
        })),
      ).onConflictDoNothing().returning({ id: foodAdditionalOrderItemsTable.id });
      // Zero rows means every line was already recorded under this key — a
      // replay. No second event, or the timeline grows an entry per retry.
      if (!rows.length) return 0;
      const [srcName] = await tx.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, b.sourcePropertyId));
      // The count is what LANDED (rows), not what was submitted (lines): a
      // PARTIAL replay — some lines already recorded under this key, some new —
      // inserts only the new ones, so quoting `lines.length` put a number on the
      // timeline that no set of rows in the table adds up to.
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "DELIVERED",
        note: `Additional food logged from ${srcName?.name ?? b.sourcePropertyId} (${rows.length} dish${rows.length === 1 ? "" : "es"})`,
        actorId: req.user!.id,
      });
      return rows.length;
    });
    res.json({ success: true, data: { requestId, duplicate: inserted === 0 } });
  } catch (err) { fail(req, res, err); }
});

// Flat property list (id / name / city) for the Additional Food source picker.
// Any food user who can receive an order may read it — names only, not sensitive.
foodRouter.get("/property-options", authenticate, authorize("FOOD_CONFIRM_DELIVERY", "view"), async (req, res) => {
  try {
    const rows = await db.select({ id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city })
      .from(propertiesTable).orderBy(propertiesTable.city, propertiesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
});

// Edit an order. The ONLY editable input is the people count (`residentsCount`) —
// the number of residents the meal is being prepared for, which is the per-person
// basis that drives every item's quantity. Item quantities / totalQuantity supplied
// by the client are IGNORED; the existing lines are rescaled SERVER-SIDE from the
// new headcount, so the order stays internally consistent. Unlike place-order this
// does NOT re-resolve the menu — the dish set is fixed once the order exists (see
// the recompute block below). `notes` is also editable. Allowed while PLACED /
// ACCEPTED / DISPATCHED (never once CANCELLED / DELIVERED / REJECTED) — but the
// people counts specifically are frozen once the kitchen accepts (see below).
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

    const wantsCountEdit = b.residentsCount != null || b.staffCount != null;

    // orderedQty is the commitment the kitchen was given at accept, and nothing
    // downstream re-reads it from the kitchen's side: preparedQty is backfilled
    // once, at accept, and the rescale loop below never touches it. So moving the
    // ordered basis afterwards rewrites the yardstick the delivery is measured
    // against (M5) — editing UP fires the shortfall detector against an inflated
    // basis and auto-files a HIGH-priority complaint against a kitchen that
    // delivered exactly what it was asked for. Counts are therefore editable only
    // while the order is still PLACED. What genuinely changed after accept belongs
    // in preparedQty (PATCH /orders/:id/kitchen-items) or, post-delivery, in
    // Additional Food. `notes` stays editable for the whole window above.
    if (wantsCountEdit && order.status !== "PLACED") {
      res.status(422).json({
        success: false,
        error: `People counts can only be changed while the order is still Placed (it is ${order.status}). Ask the kitchen to adjust send quantities, or log Additional Food after delivery.`,
      });
      return;
    }

    // The ordering cut-off closes the unit lead's editing window, so re-run it on
    // EVERY edit that changes quantities (M5). It used to be scoped to
    // `order.status === "PLACED"`, which meant a later status skipped the check
    // entirely; with counts now PLACED-only this is belt-and-braces, and it stays
    // correct if the status gate above is ever widened.
    if (wantsCountEdit) {
      const cutoffError = await checkOrderCutoff(order.brand, order.propertyId, order.serviceDate);
      if (cutoffError) { res.status(422).json({ success: false, error: `This order can no longer be edited — ${cutoffError}` }); return; }
    }

    // People count drives item quantities. Staff eat the same food, so the basis
    // that scales every item is the TOTAL (residents + staff); the residents/staff
    // split is persisted separately (Approach A). Each count defaults to the order's
    // current value when the client omits it, so a residents-only (or staff-only)
    // edit leaves the other untouched. Items recompute only when the TOTAL changes.
    // residents_count is NOT NULL; there is deliberately no totalQuantity fallback
    // here any more — that column now carries the item quantity sum (M11), not a
    // headcount, so falling back to it would rescale the order against kilograms.
    const prevResidents = Number(order.residentsCount);
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
        // totalQuantity is NOT the headcount (M11) — it follows the items and is
        // recomputed from them after the rescale below.
      }
      if (people !== prevPeople) recompute = true;
    }
    if (b.notes !== undefined) update["notes"] = b.notes ?? null;

    // Header + item rescale + the totalQuantity that summarises them are ONE unit
    // of work (M4): committed separately, a failure mid-rescale left an order
    // whose header said one headcount and whose lines said another.
    const updated = await db.transaction(async (tx) => {
      // Conditional write (M1): `order` was read outside this transaction, so its
      // status is a snapshot. Pinning the UPDATE to that status means a concurrent
      // accept/reject/cancel makes this edit match zero rows instead of silently
      // applying to an order in a state that forbids it.
      const [row] = await tx.update(foodOrdersTable)
        .set(update as Partial<typeof foodOrdersTable.$inferInsert>)
        .where(and(eq(foodOrdersTable.id, id), eq(foodOrdersTable.status, order.status)))
        .returning();
      if (!row) throw new HandlerAbort(422, { error: "This order changed while you were editing it — reload and try again." });
      if (!recompute) return row;

      // Rescale the items this order ALREADY has — never re-resolve the menu.
      //
      // This path used to delete every row and rebuild from computeOrderItems,
      // i.e. from the CURRENT rotation. That made a headcount tweak silently
      // re-sync a placed order to whatever Service Set had changed since (dishes
      // appearing and disappearing under the kitchen), discard the unit lead's
      // per-dish person overrides, and wipe preparedQty / receivedQty /
      // wastedQty. An order is a commitment: only the quantities move.
      //
      // Each line keeps its own per-person rate (orderedQty ÷ personsCount), so
      // a line ordered at a non-default rate stays at that rate. Lines whose
      // personsCount was deliberately set away from the order-wide headcount are
      // left alone — that override is a statement about a dish, not about the
      // headcount, and it survives until someone edits it directly.
      const existing = await tx.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
      // A quantity-locked dish is pinned to its own count and must never be
      // rescaled. The personsCount check below is NOT enough on its own: when a
      // dish's lockedPersons happens to equal prevPeople, that guard passes and
      // the pin would be silently rewritten to the new headcount.
      const lockedDishIds = new Set(
        existing.length
          ? (await tx.select({ id: dishesTable.id }).from(dishesTable).where(and(
              inArray(dishesTable.id, existing.map((it) => it.dishId)),
              eq(dishesTable.isQtyLocked, true),
            ))).map((r) => r.id)
          : [],
      );
      for (const it of existing) {
        if (lockedDishIds.has(it.dishId)) continue;
        if (it.personsCount !== prevPeople) continue;
        const prevQty = Number(it.orderedQty ?? 0);
        const rate = it.personsCount > 0 ? prevQty / it.personsCount : 0;
        await tx.update(foodOrderItemsTable).set({
          personsCount: people,
          orderedQty: String(Math.round(rate * people * 1000) / 1000),
          updatedAt: new Date(),
        }).where(eq(foodOrderItemsTable.id, it.id));
      }

      // total_quantity = sum of item ordered quantities (M11), re-derived from the
      // lines we just wrote rather than assigned from the headcount.
      const [agg] = await tx.select({ total: sql<string | null>`sum(${foodOrderItemsTable.orderedQty})` })
        .from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
      const [withTotal] = await tx.update(foodOrdersTable)
        .set({ totalQuantity: agg?.total ?? null, updatedAt: new Date() })
        .where(eq(foodOrdersTable.id, id)).returning();
      return withTotal!;
    });

    res.json({ success: true, data: { ...updated, totalQuantity: updated.totalQuantity != null ? Number(updated.totalQuantity) : null } });
  } catch (err) {
    fail(req, res, err);
  }
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
    // Conditional write (M1). The status check above ran against a row read in a
    // separate statement, so a concurrent accept/dispatch could land between the
    // two and this blind UPDATE would stamp cancelledAt + cancelReason onto a live
    // order that the kitchen then cooks and sends. Pinning the UPDATE to the
    // pre-dispatch statuses makes the transition atomic: zero rows back means
    // somebody else moved it first.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(foodOrdersTable).set({
        status: "CANCELLED", cancelledAt: now, cancelReason: reason, updatedAt: now,
      }).where(and(
        eq(foodOrdersTable.id, id),
        inArray(foodOrdersTable.status, ["PLACED", "ACCEPTED"]),
      )).returning();
      if (!row) throw new HandlerAbort(422, { error: "Only orders that are not yet dispatched can be cancelled" });
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "CANCELLED", note: reason ? `Cancelled: ${reason}` : "Order cancelled", actorId: req.user!.id,
      });
      return row;
    });
    await notifyOrderEvent("CANCELLED", {
      unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand, reason,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    fail(req, res, err);
  }
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
  } catch (err) { fail(req, res, err); }
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
    const reason = (req.body as { reason: string }).reason.trim();
    // Quantities + the mandatory reason are ONE unit of work (M4). Written as a
    // loop followed by a separate insert, the accountability record this endpoint
    // exists to produce was the LAST statement — i.e. the one most likely to be
    // skipped, leaving adjusted quantities nobody signed for.
    await db.transaction(async (tx) => {
      // Re-read under a row lock (M1): "still ACCEPTED" was true when we read the
      // order in a separate statement, which is not the same as true when we
      // write. A concurrent dispatch would otherwise let the kitchen rewrite send
      // quantities for food already on the van.
      const locked = await lockOrder(tx, id);
      if (!locked || locked.status !== "ACCEPTED") {
        throw new HandlerAbort(422, { error: `Send quantities can only be adjusted while the order is Accepted (it is ${locked?.status ?? "no longer present"}).` });
      }
      // Reason FIRST, so the trail cannot outlive its own explanation.
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: locked.status,
        note: `Send quantities adjusted (${items.length} item${items.length === 1 ? "" : "s"}) — ${reason}`,
        actorId: req.user!.id,
      });
      for (const it of items) {
        await tx.update(foodOrderItemsTable)
          .set({ preparedQty: String(it.preparedQty), updatedAt: now })
          .where(eq(foodOrderItemsTable.id, it.id));
      }
      await tx.update(foodOrdersTable).set({ updatedAt: now }).where(eq(foodOrdersTable.id, id));
    });
    res.json({ success: true, data: { updated: items.length } });
  } catch (err) {
    fail(req, res, err);
  }
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
      // Conditional write (M1) + one unit of work with its event (M4): the status
      // predicate means a concurrent cancel/dispatch makes this match zero rows
      // rather than stamping a delivery partner onto an order that has moved on.
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(foodOrdersTable).set({
          dispatchStartedAt: order.dispatchStartedAt ?? now,
          deliveryPartnerId: b.deliveryPartnerId ?? order.deliveryPartnerId ?? null,
          updatedAt: now,
        }).where(and(eq(foodOrdersTable.id, id), eq(foodOrdersTable.status, "ACCEPTED"))).returning();
        if (!row) throw new HandlerAbort(422, { error: "Cannot start dispatch — this order is no longer ACCEPTED." });
        await tx.insert(foodOrderEventsTable).values({
          id: newId(), orderId: id, status: row.status, note: "Dispatch preparation started", actorId: req.user!.id,
        });
        return row;
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
      // The status was read in a separate statement above; re-check it here under
      // a row lock (M1) so a concurrent cancel cannot be overwritten by this
      // dispatch. createDispatchForOrders writes the status itself, so the lock
      // (not a conditional UPDATE) is what serialises this transition.
      const locked = await lockOrder(tx, id);
      if (!locked || !canTransition(locked.status, "DISPATCHED")) {
        throw new HandlerAbort(422, { error: `Cannot dispatch — order is ${locked?.status ?? "no longer present"}. It must be ACCEPTED.` });
      }
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
  } catch (err) {
    fail(req, res, err);
  }
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
      // The ceiling is what could physically have arrived, i.e. the LARGER of
      // ordered and prepared — the kitchen is allowed to cook more than ordered
      // (preparedQty has no upper bound) and the receive UI prefills/caps from
      // prepared. Capping at ordered alone (H7) made every over-prepared
      // delivery unsubmittable and pushed the lead into under-reporting, which
      // then minted a shortfall complaint for food that arrived in surplus.
      // Surplus is recorded as-is and surfaces in the variance report; the
      // shortfall logic below still measures against ordered.
      const cap = Math.max(Number(it.orderedQty), Number(it.preparedQty ?? 0));
      if (!Number.isFinite(rq) || rq < 0 || rq > cap) {
        res.status(400).json({ success: false, error: `receivedQty for ${inp.itemId} must be between 0 and ${cap}` });
        return;
      }
    }

    const now = new Date();
    const wasteWindowMs = await getWasteEditWindowMs();

    // Detect any shortfall (receivedQty < orderedQty) to auto-raise a FOOD
    // complaint (O5). We compute it from the submitted received quantities;
    // items not submitted are treated as fully received (no shortfall). A
    // surplus (received > ordered) is not a shortfall and raises nothing.
    // Quantities are numeric(12,3), so compare with a tolerance: a float
    // artefact must not raise a complaint against a delivery that came in full.
    const QTY_EPS = 1e-6;
    const receivedById = new Map(items.map((i) => [i.itemId, Number(i.receivedQty)]));
    type Short = { name: string; ordered: number; received: number; short: number; pct: number };
    const shortfalls: Short[] = [];
    for (const it of orderItems) {
      if (!receivedById.has(it.id)) continue;
      const ordered = Number(it.orderedQty);
      const received = receivedById.get(it.id)!;
      if (received < ordered - QTY_EPS) {
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
      // Conditional write (M1): the DISPATCHED check above ran against a row read
      // outside this transaction. Pinning the UPDATE to that status means two
      // concurrent confirms cannot both succeed, and a concurrent un-tick on the
      // dispatch board cannot be silently overwritten.
      const [upd] = await tx.update(foodOrdersTable).set({
        status: "DELIVERED",
        deliveredAt: now,
        // The wastage window CLOSES at this instant (M20) — logging is open from
        // delivery until here, which is what the DELIVERED notification promises.
        wasteEditableUntil: new Date(now.getTime() + wasteWindowMs),
        confirmedById: req.user!.id,
        deliveryRemarks: b.remarks ?? null,
        updatedAt: now,
      }).where(and(eq(foodOrdersTable.id, id), eq(foodOrdersTable.status, "DISPATCHED"))).returning();
      if (!upd) throw new HandlerAbort(422, { error: "Only DISPATCHED orders can be confirmed" });
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "DELIVERED", note: "Delivery confirmed", actorId: req.user!.id,
      });

      // O5 — auto-create a property-scoped FOOD complaint on ANY shortfall, in
      // the SAME transaction so delivery + complaint commit/rollback together.
      //
      // At most ONE auto-complaint per order, ever. An order can re-enter
      // DISPATCHED (the dispatch board un-ticks a delivered order), and without
      // this guard each re-confirm minted a fresh TKT- for the same shortfall.
      // The lookup runs inside the transaction so two concurrent confirms
      // cannot both see "none yet".
      const [priorVariance] = shortfalls.length === 0 ? [] : await tx.select({ id: complaintsTable.id })
        .from(complaintsTable)
        .where(and(eq(complaintsTable.orderId, order.id), eq(complaintsTable.subCategory, "DELIVERY_VARIANCE")))
        .limit(1);
      if (shortfalls.length > 0 && !priorVariance) {
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

    // M2 — the trip and the order state machines drift apart without this. When
    // the unit leads confirm every stop themselves (the canonical receive path,
    // and since C3 the only one an FNB dispatcher's mark-delivered can take), the
    // trip stayed LOADING/IN_TRANSIT forever and held its van on the busy list,
    // 422-ing every later trip that tried to book it. Best-effort and after the
    // commit: the delivery is already recorded, so a lost race on the trip row
    // must not undo it.
    if (order.dispatchId) await reconcileDispatchForOrder(order.dispatchId, req.user!.id);

    await notifyOrderEvent("DELIVERED", {
      unitLeadId: order.unitLeadId, orderId: order.id, orderNumber: order.orderNumber,
      propertyName: await propertyName(order.propertyId), mealType: order.mealType, brand: order.brand,
      // The wastage window CLOSES at wasteEditableUntil; naming the instant keeps
      // the message and the server's own 422 bound describing the same deadline.
      wasteWindowEndsAt: updated?.wasteEditableUntil ?? null,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    fail(req, res, err);
  }
});

/** Per-dish changes spelled out in the waste audit note before it summarises. */
const WASTE_NOTE_MAX_ITEMS = 8;

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
    // Wastage is logged WITHIN one hour of delivery: the window OPENS at delivery
    // and CLOSES at wasteEditableUntil (= deliveredAt + the configured window).
    // The column name always read as a closing bound; the check did not — it
    // rejected everything BEFORE that instant and nothing after, the exact
    // inverse (M20), so the DELIVERED notification ("please record any wastage
    // within 1 hour") walked the unit lead straight into a guaranteed 422.
    // Persona-Unit-Lead.md:91 is the spec. Orders delivered before the stamp
    // existed fall back to deliveredAt + the window rather than being locked out.
    const wasteDeadline = order.wasteEditableUntil
      ?? (order.deliveredAt ? new Date(order.deliveredAt.getTime() + await getWasteEditWindowMs()) : null);
    if (wasteDeadline && new Date() > wasteDeadline) {
      res.status(422).json({ success: false, error: "The wastage window for this order has closed — it can only be logged within the hour after delivery" });
      return;
    }

    const items: Array<{ itemId: string; wastedQty: number }> = Array.isArray(b.items) ? b.items : [];
    const orderItems = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    const itemById = new Map(orderItems.map((it) => [it.id, it]));
    // Top-ups sourced from another property are real food on the same plates and
    // can be wasted like any other, so they raise the cap (M18) — without this a
    // lead who logged Additional Food cannot record wasting it.
    const addlByDish = new Map<string, number>();
    for (const r of await db.select({ dishId: foodAdditionalOrderItemsTable.dishId, qty: foodAdditionalOrderItemsTable.qty })
      .from(foodAdditionalOrderItemsTable).where(eq(foodAdditionalOrderItemsTable.orderId, id))) {
      addlByDish.set(r.dishId, (addlByDish.get(r.dishId) ?? 0) + Number(r.qty));
    }
    for (const inp of items) {
      const it = itemById.get(inp.itemId);
      if (!it) { res.status(400).json({ success: false, error: `Unknown itemId ${inp.itemId}` }); return; }
      const wq = Number(inp.wastedQty);
      // Cap against RECEIVED qty (the proof-of-delivery amount); fall back to
      // orderedQty ONLY when delivery wasn't confirmed (receivedQty genuinely
      // null), then add any additional food logged against the same dish.
      const base = it.receivedQty == null ? Number(it.orderedQty) : Number(it.receivedQty);
      const cap = Math.round((base + (addlByDish.get(it.dishId) ?? 0)) * 1000) / 1000;
      if (!Number.isFinite(wq) || wq < 0 || wq > cap) {
        res.status(400).json({ success: false, error: `wastedQty for ${inp.itemId} cannot exceed what was received, including additional food (${cap})` });
        return;
      }
    }

    const now = new Date();
    // Dish names for the audit note (master data, so a read outside the
    // transaction is fine).
    const dishNameById = new Map(items.length
      ? (await db.select({ id: dishesTable.id, name: dishesTable.name }).from(dishesTable)
          .where(inArray(dishesTable.id, [...new Set(orderItems.map((it) => it.dishId))])))
          .map((d) => [d.id, d.name] as const)
      : []);
    // Quantities + the audit event commit together (M4), and the order is
    // re-checked under a row lock (M1) — the DELIVERED status above came from a
    // read outside this transaction.
    await db.transaction(async (tx) => {
      const locked = await lockOrder(tx, id);
      if (!locked || locked.status !== "DELIVERED") {
        throw new HandlerAbort(422, { error: "Waste can only be recorded for DELIVERED orders" });
      }
      // The write is an unconditional overwrite and stays one — a lead correcting
      // a mistyped figure inside the window is legitimate. What was missing is
      // the trail: "Waste recorded" said nothing about WHAT was recorded or what
      // it replaced, so a rewrite was indistinguishable from a first entry and
      // the overwritten figure was gone for good (L4). Prior values are read
      // under the same lock as the write, so the note describes this write.
      const prior = new Map(
        (await tx.select({ id: foodOrderItemsTable.id, wastedQty: foodOrderItemsTable.wastedQty })
          .from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id)))
          .map((r) => [r.id, r.wastedQty] as const),
      );
      const changes: string[] = [];
      let isRevision = false;
      for (const inp of items) {
        const next = Number(inp.wastedQty);
        const beforeRaw = prior.get(inp.itemId);
        const before = beforeRaw == null ? null : Number(beforeRaw);
        await tx.update(foodOrderItemsTable).set({ wastedQty: String(next), updatedAt: now }).where(eq(foodOrderItemsTable.id, inp.itemId));
        if (before === next) continue;
        if (before != null) isRevision = true;
        const it = itemById.get(inp.itemId)!;
        changes.push(`${dishNameById.get(it.dishId) ?? it.dishId} ${before ?? "—"} → ${next} ${it.unit}`);
      }
      // Bounded: an order can carry a dozen dishes and the note is a log line.
      const shown = changes.slice(0, WASTE_NOTE_MAX_ITEMS);
      const more = changes.length - shown.length;
      const note = changes.length
        ? `Waste ${isRevision ? "revised" : "recorded"}: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`
        : "Waste recorded (no change)";
      await tx.insert(foodOrderEventsTable).values({
        id: newId(), orderId: id, status: "DELIVERED", note, actorId: req.user!.id,
      });
    });
    const refreshed = await db.select().from(foodOrderItemsTable).where(eq(foodOrderItemsTable.orderId, id));
    res.json({ success: true, data: { items: refreshed.map((it) => ({ ...it, wastedQty: it.wastedQty != null ? Number(it.wastedQty) : null })) } });
  } catch (err) {
    fail(req, res, err);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Kitchen Summary
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hard cap on the order-item rows the cook plan will aggregate (H11). The
 * endpoint is deliberately unpaginated — it is a plan, not a list — and `date`
 * is optional, so an org-wide caller omitting it (a script, a bookmark) scans
 * every PLACED/ACCEPTED order ever placed joined against all of
 * food_order_items. Past the cap we aggregate the most recent rows and say so
 * rather than silently reporting a partial plan as if it were whole.
 */
const KITCHEN_SUMMARY_ROW_CAP = 20000;

foodRouter.get("/kitchen-summary", authenticate, authorize("FOOD_KITCHEN_SUMMARY", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);

    const dateRaw = req.query["date"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const clusterId = req.query["clusterId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;

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
      .where(and(...conds))
      // Newest first so the cap keeps the service days the kitchen is cooking now
      // rather than an arbitrary slice of history (H11).
      .orderBy(desc(foodOrdersTable.serviceDate))
      .limit(KITCHEN_SUMMARY_ROW_CAP + 1);

    const truncated = rows.length > KITCHEN_SUMMARY_ROW_CAP;
    if (truncated) rows.length = KITCHEN_SUMMARY_ROW_CAP;

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
      // Explicit truncation signal (H11): the totals below are a SUBSET when this
      // is true. Narrow the request with ?date / ?propertyId to get a whole plan.
      truncated,
      rowCap: KITCHEN_SUMMARY_ROW_CAP,
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
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Reports
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lookback applied when a report request supplies no `from` (H11). `from`/`to`
 *  were added ONLY when present, so an org-wide caller omitting both scanned the
 *  entire food_orders table. The UI always sends a 30-day window, so this bounds
 *  scripts and bookmarks without changing any screen. */
const REPORT_DEFAULT_WINDOW_DAYS = 90;

function reportConds(
  scope: ReturnType<typeof eq> | undefined,
  q: Record<string, unknown>,
  /** A status census counts every status, including the ones demand excludes. */
  opts: { allStatuses?: boolean } = {},
) {
  const conds = [] as ReturnType<typeof eq>[];
  if (scope) conds.push(scope);
  const status = q["status"] as string | undefined;
  // IST calendar bounds (M8) — service_date is stored at 00:00 IST, so a UTC
  // reading of 'yyyy-MM-dd' clipped the first and last day off every report.
  const from = parseWindowStart(q["from"]);
  const to = parseWindowEnd(q["to"]);
  const propertyId = q["propertyId"] as string | undefined;
  const brand = q["brand"] as string | undefined;
  // M6: demand reporting counts LIVE orders. A cancelled or rejected order was
  // never cooked, so counting it inflates "orders placed" and "people ordered
  // for" — and this endpoint renders on the same screen as /food/analytics,
  // which already excludes them, so the two contradicted each other. An explicit
  // ?status is a deliberate census of that status and wins.
  if (status) conds.push(eq(foodOrdersTable.status, status as never));
  else if (!opts.allStatuses) conds.push(notInArray(foodOrdersTable.status, ["CANCELLED", "REJECTED"]));
  // Always bounded below, defaulting back from `to` (or now) when `from` is absent.
  conds.push(gte(foodOrdersTable.serviceDate, from
    ?? new Date((to ?? new Date()).getTime() - REPORT_DEFAULT_WINDOW_DAYS * 86400000)));
  if (to) conds.push(lte(foodOrdersTable.serviceDate, to));
  if (propertyId) conds.push(eq(foodOrdersTable.propertyId, propertyId));
  if (brand) conds.push(eq(foodOrdersTable.brand, brand as never));
  return conds.length ? and(...conds) : undefined;
}

foodRouter.get("/reports", authenticate, authorize("FOOD_REPORTS", "view"), async (req, res) => {
  try {
    // reportConds casts `status` onto the enum column; check it here, where a
    // response can still be written (L6).
    if (invalidEnumParam(res, "status", req.query["status"], ORDER_STATUSES)) return;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const scope = scopeOrdersCondition(ids);
    const where = reportConds(scope, req.query as Record<string, unknown>);
    // The status census is the one widget on this screen that must see every
    // status — "3 cancelled" is the answer it exists to give (M6).
    const whereAllStatuses = reportConds(scope, req.query as Record<string, unknown>, { allStatuses: true });

    // M8: serviceDate is stored as the 00:00-IST instant, i.e. 18:30 UTC of the
    // PREVIOUS calendar day, so a bare to_char labels every bucket a day early.
    // Same shift the sibling charts on this screen use (food-ops /analytics).
    const day = sql<string>`to_char(${foodOrdersTable.serviceDate} + interval '330 minutes', 'YYYY-MM-DD')`;

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
      .from(foodOrdersTable).where(whereAllStatuses).groupBy(foodOrdersTable.status);

    res.json({
      success: true,
      data: {
        ordersPerDay: ordersPerDay.map((r) => ({ date: r.date, count: r.count })),
        mealTypeDistribution: mealTypeDistribution.map((r) => ({ mealType: r.mealType, count: r.count })),
        residentTrend: residentTrend.map((r) => ({ date: r.date, residents: r.residents })),
        statusBreakdown: statusBreakdown.map((r) => ({ status: r.status, count: r.count })),
      },
    });
  } catch (err) { fail(req, res, err); }
});

// Report exports (/reports/export.csv|pdf|xls) deliberately live in food-ops.ts.
//
// NOTE: foodRouter is mounted BEFORE foodOpsRouter at the same /food base
// (routes/index.ts), so anything registered here shadows the same path in
// food-ops.ts. This file used to register .csv and .pdf against an orders-only
// handler, which shadowed food-ops' serveReportExport() — the one pipeline that
// dispatches on `?report=` — so Variance/Waste/On-time downloaded the ORDERS
// dataset under a report-specific filename (H2). The invariant: ONE export
// pipeline serves every report × every format, and it is food-ops'.
// Do not re-register /reports/export* here. food-ops carries the same
// requireRoles("SUPER_ADMIN","OPS_EXCELLENCE") gate on all three formats, so
// removing these did not weaken authz.

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Lookups
 * ──────────────────────────────────────────────────────────────────────────── */

// H8 — this is the most-called food endpoint (14 frontend call sites) and it
// used to be `authenticate` only: any logged-in account, including roles with no
// food grant at all, got the whole property master plus every agency's vehicle
// numbers and service locations. It feeds every food screen, so the gate is the
// union of the food modules rather than any single one, and the property list is
// narrowed to the caller's scope — an unscoped roster is exactly what let C5's
// attacker enumerate property ids to re-point at their own kitchen.
foodRouter.get("/lookups", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const accessible = await resolveAccessiblePropertyIds(req.user!);
    const allProperties = await db.select({
      id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city,
      brand: propertiesTable.brand, kitchenId: propertiesTable.kitchenId, clusterId: propertiesTable.clusterId,
    }).from(propertiesTable).orderBy(propertiesTable.city, propertiesTable.name);
    const properties = accessible === null
      ? allProperties
      : allProperties.filter((p) => isAccessible(p.id, accessible));
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
    const myKitchenIds = accessible === null
      ? null
      : [...new Set(properties.filter((p) => p.kitchenId).map((p) => p.kitchenId!))];
    res.json({
      success: true,
      // deliveryPartners kept as an alias of agencies {id,name} for back-compat.
      data: { properties, agencies, deliveryPartners: agencyRows, brands, mealTypes: MEAL_TYPES, myKitchenIds },
    });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Dishes
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/dishes", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const component = req.query["component"] as string | undefined;
    const search = req.query["search"] as string | undefined;
    const active = req.query["active"] as string | undefined;
    const brand = req.query["brand"] as string | undefined;
    if (invalidEnumParam(res, "component", component, DISH_COMPONENTS)) return;
    const conds = [] as ReturnType<typeof eq>[];
    if (component) conds.push(eq(dishesTable.component, component as never));
    if (search) conds.push(ilike(dishesTable.name, `%${escapeLike(search)}%`));
    if (active !== undefined) conds.push(eq(dishesTable.isActive, active === "true"));
    if (brand) conds.push(sql`${dishesTable.brands} @> ARRAY[${brand}]::text[]`);
    const where = conds.length ? and(...conds) : undefined;
    const sort = req.query["sort"] as string | undefined;
    const orderCol = sort === "newest" ? desc(dishesTable.createdAt) : asc(dishesTable.name);
    const rows = await db.select().from(dishesTable).where(where).orderBy(orderCol);
    // Attach configured side-dish options in ONE query (not per row) so the
    // dish list can render the "comes with sides" state without an N+1.
    const opts = rows.length
      ? await db.select({ dishId: dishSideOptionsTable.dishId, sideDishId: dishSideOptionsTable.sideDishId })
          .from(dishSideOptionsTable)
          .where(inArray(dishSideOptionsTable.dishId, rows.map((r) => r.id)))
          .orderBy(asc(dishSideOptionsTable.sortOrder))
      : [];
    const byDish = new Map<string, string[]>();
    for (const o of opts) byDish.set(o.dishId, [...(byDish.get(o.dishId) ?? []), o.sideDishId]);
    // Ingredients ride along on the LIST too — one batched join, same shape the
    // detail endpoint returns. The plate composer greys out every candidate that
    // would clash ("shares Aloo") as you type, so the whole catalogue's
    // ingredients have to be answerable locally; per-dish fetches can't do it.
    const ings = rows.length
      ? await db.select({
          id: dishIngredientsTable.id, dishId: dishIngredientsTable.dishId,
          ingredientId: dishIngredientsTable.ingredientId, ingredientName: ingredientsTable.name,
          quantity: dishIngredientsTable.quantity, unit: dishIngredientsTable.unit,
        }).from(dishIngredientsTable)
          .leftJoin(ingredientsTable, eq(dishIngredientsTable.ingredientId, ingredientsTable.id))
          .where(inArray(dishIngredientsTable.dishId, rows.map((r) => r.id)))
      : [];
    const ingByDish = new Map<string, { id: string; ingredientId: string; ingredientName: string | null; quantity: string | null; unit: string | null }[]>();
    for (const { dishId, ...g } of ings) ingByDish.set(dishId, [...(ingByDish.get(dishId) ?? []), g]);
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        sideDishIds: byDish.get(r.id) ?? [],
        ingredients: ingByDish.get(r.id) ?? [],
      })),
    });
  } catch (err) { fail(req, res, err); }
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

/**
 * Replace a dish's side-dish options from a list of dish ids.
 *
 * Self-pairing is dropped (a dish can't be its own side) and duplicates are
 * collapsed, so the unique (dish_id, side_dish_id) index can't be violated by
 * a sloppy payload.
 */
async function replaceDishSideOptions(dishId: string, sideDishIds: unknown): Promise<string[]> {
  await db.delete(dishSideOptionsTable).where(eq(dishSideOptionsTable.dishId, dishId));
  const ids = Array.isArray(sideDishIds) ? sideDishIds : [];
  const unique = [...new Set(ids.filter((s): s is string => typeof s === "string" && !!s && s !== dishId))];
  if (!unique.length) return unique;
  await db.insert(dishSideOptionsTable).values(unique.map((sideDishId, i) => ({
    id: newId(), dishId, sideDishId, sortOrder: i, updatedAt: new Date(),
  })));
  return unique;
}

/**
 * Drops rotation rows serving a side that is no longer an option on its parent dish.
 *
 * A chosen side lives in the rotation as an ordinary row tagged with
 * `parentRotationId` (see PUT /menu-rotation/slot), and NOTHING on the ordering
 * path reads dish_side_options — resolveMenu joins dishes only. So un-pairing a
 * side on the dish master would otherwise leave every already-composed plate
 * still serving it, and the unit lead would keep ordering it forever.
 *
 * Removals cascade; additions deliberately do NOT. The plate composer picks a
 * subset of the available sides per plate, so auto-adding a newly-paired side to
 * existing plates would overwrite a deliberate choice rather than honour one.
 *
 * Scoped to `kitchenIds` (null = org-wide) for the same reason every other
 * rotation write is: the dish master is shared, so editing one dish's sides was
 * deleting rotation rows in EVERY kitchen — a kitchen-scoped editor rewriting
 * plates they cannot even read. Kitchen-restricted callers now prune only their
 * own kitchens' plates (and brand-level rows, whose kitchenId is null, are left
 * to org-wide callers — this is a DELETE, so it takes the strict WRITE condition,
 * not the read one the rotation board and its export use).
 *
 * Returns the number of rotation rows removed.
 */
async function pruneRotationSidesForDish(
  dishId: string, keepSideIds: string[], kitchenIds: string[] | null,
): Promise<number> {
  const scope = scopeRotationWriteCondition(kitchenIds);
  const parents = await db.select({ id: foodMenuRotationTable.id })
    .from(foodMenuRotationTable)
    .where(and(eq(foodMenuRotationTable.dishId, dishId), ...(scope ? [scope] : [])));
  if (!parents.length) return 0;
  const removed = await db.delete(foodMenuRotationTable).where(and(
    inArray(foodMenuRotationTable.parentRotationId, parents.map((p) => p.id)),
    ...(keepSideIds.length ? [notInArray(foodMenuRotationTable.dishId, keepSideIds)] : []),
  )).returning({ id: foodMenuRotationTable.id });
  return removed.length;
}

/** Loads a dish's configured side options, joined to the side dish's name/component. */
async function loadDishSideOptions(dishId: string) {
  return db.select({
    id: dishSideOptionsTable.id,
    sideDishId: dishSideOptionsTable.sideDishId,
    sideDishName: dishesTable.name,
    component: dishesTable.component,
    unit: dishesTable.unit,
    sortOrder: dishSideOptionsTable.sortOrder,
  }).from(dishSideOptionsTable)
    .leftJoin(dishesTable, eq(dishSideOptionsTable.sideDishId, dishesTable.id))
    .where(eq(dishSideOptionsTable.dishId, dishId))
    .orderBy(asc(dishSideOptionsTable.sortOrder));
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
  // Enum column; "" stays accepted because replaceDishIngredients reads it as
  // "no unit" and writes NULL.
  unit: z.union([z.enum(MEASUREMENT_UNITS), z.literal("")]).nullish(),
}).passthrough();

/**
 * Keeps the two quantity-lock columns consistent at the ONE write path that
 * sets them, so every read site can trust `isQtyLocked` on its own:
 *   flag off → `lockedPersons` forced to NULL
 *   flag on  → `lockedPersons` forced to 0
 *
 * The count is no longer caller-supplied: Service Set offers a bare toggle, and
 * locking a dish pins it at nobody. A `lockedPersons` in the body is therefore
 * ignored rather than rejected, so an older client that still sends a count
 * gets the new behaviour instead of a 400.
 *
 * Returns null when the body said nothing about the lock, so an update leaves
 * both columns alone.
 */
function normalizeQtyLock(
  b: Record<string, any>,
): { isQtyLocked: boolean; lockedPersons: number | null } | null {
  if (b.isQtyLocked === undefined && b.lockedPersons === undefined) return null;
  if (b.isQtyLocked !== true) return { isQtyLocked: false, lockedPersons: null };
  return { isQtyLocked: true, lockedPersons: 0 };
}

const createDishSchema = z.object({
  name: zText,
  // component/unit land on enum columns — bound them to the enum's own values so
  // a typo is a 400 naming the accepted set, not a Postgres 500 (L6).
  component: z.enum(DISH_COMPONENTS),
  unit: z.enum(MEASUREMENT_UNITS),
  brands: z.array(z.string().max(128)).optional(),
  preparations: z.array(z.string().max(128)).optional(),
  photoUrl: z.string().max(2048).nullish(),
  isActive: z.boolean().optional(),
  /** Pin this dish's people count at order time — see dishesTable.isQtyLocked.
   *  normalizeQtyLock derives the count, so this only has to admit what an old
   *  client might still send. */
  isQtyLocked: z.boolean().optional(),
  lockedPersons: z.coerce.number().int().min(0).nullish(),
  ingredients: z.array(zIngredient).optional(),
  /** Dishes that may be served alongside this one (see dish_side_options). */
  sideDishIds: z.array(zId).optional(),
}).passthrough();

foodRouter.post("/dishes", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createDishSchema, req, res)) return;
    const b = req.body || {};
    if (!b.name || !b.component || !b.unit) { res.status(400).json({ success: false, error: "name, component, unit required" }); return; }
    const lock = normalizeQtyLock(b);
    const [row] = await db.insert(dishesTable).values({
      id: newId(),
      name: b.name,
      component: b.component,
      unit: b.unit,
      brands: Array.isArray(b.brands) ? b.brands : [],
      preparations: sanitizePreparations(b.preparations),
      photoUrl: b.photoUrl ?? null,
      isQtyLocked: lock?.isQtyLocked ?? false,
      lockedPersons: lock?.lockedPersons ?? null,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    if (b.ingredients !== undefined) await replaceDishIngredients(row.id, b.ingredients);
    if (b.sideDishIds !== undefined) await replaceDishSideOptions(row.id, b.sideDishIds);
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_dish", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

// Same gate as its list sibling (H8) — the by-id read was the one left behind.
foodRouter.get("/dishes/:id", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(dishesTable).where(eq(dishesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ingredients = await loadDishIngredients(row.id);
    const sideOptions = await loadDishSideOptions(row.id);
    res.json({
      success: true,
      data: { ...row, ingredients, sideOptions, sideDishIds: sideOptions.map((s) => s.sideDishId) },
    });
  } catch (err) { fail(req, res, err); }
});

const updateDishSchema = z.object({
  name: zText.optional(),
  component: z.enum(DISH_COMPONENTS).optional(),
  unit: z.enum(MEASUREMENT_UNITS).optional(),
  brands: z.array(z.string().max(128)).optional(),
  preparations: z.array(z.string().max(128)).optional(),
  photoUrl: z.string().max(2048).nullish(),
  isActive: z.boolean().optional(),
  /** Pin this dish's people count at order time — see dishesTable.isQtyLocked.
   *  normalizeQtyLock derives the count, so this only has to admit what an old
   *  client might still send. */
  isQtyLocked: z.boolean().optional(),
  lockedPersons: z.coerce.number().int().min(0).nullish(),
  ingredients: z.array(zIngredient).optional(),
  /** Dishes that may be served alongside this one (see dish_side_options). */
  sideDishIds: z.array(zId).optional(),
}).passthrough();

foodRouter.put("/dishes/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateDishSchema, req, res)) return;
    const b = req.body || {};
    const lock = normalizeQtyLock(b);
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "component", "unit", "brands", "photoUrl", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    // The two lock columns move together and deliberately bypass the whitelist
    // above — a column left out of that array silently no-ops on every update.
    if (lock) {
      u["isQtyLocked"] = lock.isQtyLocked;
      u["lockedPersons"] = lock.lockedPersons;
    }
    if (b.preparations !== undefined) u["preparations"] = sanitizePreparations(b.preparations);
    const [before] = await db.select().from(dishesTable).where(eq(dishesTable.id, req.params["id"]!));
    // Retiring a dish is an ORG-WIDE withdrawal, not an attribute edit: `dishes`
    // has no kitchen column and resolveMenu joins it on isActive, so isActive
    // riding in on the whitelist above let one kitchen's manager clear the dish
    // off every kitchen's plate. Attribute edits stay open to them (assertMay-
    // RetireDish), which keeps the dish they are allowed to CREATE correctable.
    if (before?.isActive && u["isActive"] === false) await assertMayRetireDish(req.user!, before.id);
    const [row] = await db.update(dishesTable).set(u as Partial<typeof dishesTable.$inferInsert>).where(eq(dishesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_dish", row.id, { before, after: row });
    if (b.ingredients !== undefined) await replaceDishIngredients(row.id, b.ingredients);
    // Un-pairing a side has to reach the composed plates too, or the rotation
    // keeps serving an accompaniment this dish no longer has.
    let rotationSidesRemoved = 0;
    if (b.sideDishIds !== undefined) {
      const kept = await replaceDishSideOptions(row.id, b.sideDishIds);
      rotationSidesRemoved = await pruneRotationSidesForDish(row.id, kept, await resolveAccessibleKitchenIds(req.user!));
    }
    res.json({ success: true, data: row, meta: { rotationSidesRemoved } });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/dishes/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [before] = await db.select().from(dishesTable).where(eq(dishesTable.id, req.params["id"]!));
    // Same invariant as PUT above — this soft-delete IS the isActive=false write,
    // so guarding one without the other would just move the network-wide
    // withdrawal to the sibling verb.
    if (before?.isActive) await assertMayRetireDish(req.user!, before.id);
    const [row] = await db.update(dishesTable).set({ isActive: false, updatedAt: new Date() }).where(eq(dishesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_dish", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Ingredients
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/ingredients", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const search = req.query["search"] as string | undefined;
    const active = req.query["active"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (search) conds.push(ilike(ingredientsTable.name, `%${escapeLike(search)}%`));
    if (active !== undefined) conds.push(eq(ingredientsTable.isActive, active === "true"));
    const rows = await db.select().from(ingredientsTable).where(conds.length ? and(...conds) : undefined).orderBy(ingredientsTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
});

const createIngredientSchema = z.object({
  name: zText,
  unit: z.enum(MEASUREMENT_UNITS),
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_ingredient", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

const updateIngredientSchema = z.object({
  name: zText.optional(),
  unit: z.enum(MEASUREMENT_UNITS).optional(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/ingredients/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateIngredientSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "unit", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [before] = await db.select().from(ingredientsTable).where(eq(ingredientsTable.id, req.params["id"]!));
    const [row] = await db.update(ingredientsTable).set(u as never).where(eq(ingredientsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_ingredient", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/ingredients/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [before] = await db.select().from(ingredientsTable).where(eq(ingredientsTable.id, req.params["id"]!));
    const [row] = await db.update(ingredientsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(ingredientsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_ingredient", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Menu rotation
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/menu-rotation/resolve", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
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
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
    // H8: ?kitchenId is caller-supplied, so it is scoped exactly as the sibling
    // /menu-rotation READ is — otherwise this route reads any kitchen's menu 50
    // lines above the one that refuses to. Only when a kitchen was actually
    // resolved: deniedKitchen refuses a NULL id (that is the brand-wide row a
    // kitchen-bound caller may not WRITE), but resolveMenu already returns [] for
    // one, so refusing the read would turn "this property has no kitchen" into a
    // 403 on the ordering screen.
    if (kitchenId && await deniedKitchen(req, res, kitchenId)) return;
    const dishes = await resolveMenu(kitchenId ?? null, brand, mealType, date);
    res.json({ success: true, data: dishes });
  } catch (err) { fail(req, res, err); }
});

/**
 * Kitchen-scope guard for the rotation write handlers. Returns true when the
 * request was refused, having already written the 403.
 *
 * It answers inline rather than letting assertKitchenAccess' httpError escape.
 * That began as a workaround for the local catch → 500 that swallowed it; fail()
 * now re-throws a domain error to the central handler, so the workaround is no
 * longer load-bearing — it stays because the boolean return is what the call
 * sites branch on, and answering here keeps the refusal next to its guard.
 */
async function deniedKitchen(
  req: Request,
  res: Response,
  kitchenId: string | null | undefined,
): Promise<boolean> {
  try {
    await assertKitchenAccess(req.user!, kitchenId);
    return false;
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    res.status(e.statusCode ?? 403).json({
      success: false,
      error: e.message ?? "Outside your kitchen scope",
    });
    return true;
  }
}

// Gated on FOOD_SETTINGS (the Food Settings page is the only caller) and scoped
// to the caller's kitchens — without the scope filter, omitting ?kitchenId
// returned every kitchen's menu to anyone logged in.
foodRouter.get("/menu-rotation", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
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
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
    if (mealType) conds.push(eq(foodMenuRotationTable.mealType, mealType as never));
    // READ condition: the board must show the brand-wide templates (kitchenId
    // NULL) as well as the caller's own rows. With the write condition here a
    // kitchen-scoped F&B manager saw an empty board — on the dev DB all 385
    // rotation rows are brand-wide.
    const scope = scopeRotationReadCondition(await resolveAccessibleKitchenIds(req.user!));
    const where = conds.length || scope ? and(...conds, ...(scope ? [scope] : [])) : undefined;
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
  } catch (err) { fail(req, res, err); }
});

const ROTATION_HEADERS = ["Kitchen", "Brand", "Week", "Day", "Meal", "Dish", "Slot", "Order"];

/**
 * Runaway guards for the rotation export, mirroring food-ops' EXPORT_ROW_CAP /
 * PDF_ROW_CAP (H11). Generous on purpose — they bound a render, they are not a
 * page size.
 */
const ROTATION_EXPORT_ROW_CAP = 20000;
/** Rows above this are not rendered to PDF — the layout loop is per-cell. */
const ROTATION_PDF_ROW_CAP = 5000;

/**
 * Resolves menu-rotation export rows + metadata (kitchen name used as the
 * "property"-equivalent label, plus a filename hint built from brand/kitchen).
 */
async function fetchRotationForExport(req: any): Promise<{
  rows: (string | number | null | undefined)[][];
  /** The same result set unflattened. The PDF renders a day×meal calendar and
   *  needs the numeric day and week to place a cell, which the display rows have
   *  already turned into "Monday"/"W1". CSV and XLS keep using `rows`. */
  raw: RotationExportRow[];
  kitchenName: string | null;
  brand: string | null;
}> {
  const brand = req.query["brand"] as string | undefined;
  const kitchenId = req.query["kitchenId"] as string | undefined;
  const rotationWeek = req.query["rotationWeek"] as string | undefined;
  const dayOfWeek = req.query["dayOfWeek"] as string | undefined;
  const mealType = req.query["mealType"] as string | undefined;
  // No `res` down here, so the enum check (L6) travels as a HandlerAbort — both
  // export handlers end in fail(), which answers it with its own 400.
  if (mealType && !(MEAL_TYPES as readonly string[]).includes(mealType)) {
    throw new HandlerAbort(400, { error: `Invalid mealType: ${mealType}` });
  }
  const conds = [] as ReturnType<typeof eq>[];
  if (brand) conds.push(eq(foodMenuRotationTable.brand, brand as never));
  if (kitchenId) conds.push(eq(foodMenuRotationTable.kitchenId, kitchenId));
  if (rotationWeek) conds.push(eq(foodMenuRotationTable.rotationWeek, Number(rotationWeek)));
  if (dayOfWeek) conds.push(eq(foodMenuRotationTable.dayOfWeek, Number(dayOfWeek)));
  if (mealType) conds.push(eq(foodMenuRotationTable.mealType, mealType as never));
  // Same kitchen scoping as the list — an export must never widen it, and must
  // not narrow it either, or the file disagrees with the board it was taken from.
  const scope = scopeRotationReadCondition(await resolveAccessibleKitchenIds(req.user!));
  const where = conds.length || scope ? and(...conds, ...(scope ? [scope] : [])) : undefined;
  const rows = await db.select({
    kitchenName: kitchensTable.name, brand: foodMenuRotationTable.brand,
    rotationWeek: foodMenuRotationTable.rotationWeek, dayOfWeek: foodMenuRotationTable.dayOfWeek,
    mealType: foodMenuRotationTable.mealType, dishName: dishesTable.name,
    slotLabel: foodMenuRotationTable.slotLabel, sortOrder: foodMenuRotationTable.sortOrder,
  }).from(foodMenuRotationTable)
    .leftJoin(dishesTable, eq(foodMenuRotationTable.dishId, dishesTable.id))
    .leftJoin(kitchensTable, eq(foodMenuRotationTable.kitchenId, kitchensTable.id))
    .where(where)
    .orderBy(kitchensTable.name, foodMenuRotationTable.brand, foodMenuRotationTable.rotationWeek, foodMenuRotationTable.dayOfWeek, foodMenuRotationTable.sortOrder)
    // H11 — bounded like the report exports. With every filter omitted this
    // selects the whole rotation table for an org-wide caller and renders it
    // inline; the PDF layout loop is per-cell and runs on the event loop, so an
    // unbounded render stalls the process for every other request.
    .limit(ROTATION_EXPORT_ROW_CAP + 1);
  if (rows.length > ROTATION_EXPORT_ROW_CAP) {
    throw new HandlerAbort(422, {
      error: `This export is too large (over ${ROTATION_EXPORT_ROW_CAP.toLocaleString("en-IN")} rows). Filter by kitchen, brand or week.`,
    });
  }
  const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const mapped = rows.map((r) => [
    r.kitchenName ?? "—", r.brand, `W${r.rotationWeek}`, DAYS[r.dayOfWeek] ?? r.dayOfWeek,
    r.mealType, r.dishName ?? "—", r.slotLabel ?? "", r.sortOrder,
  ]);
  const kitchenNames = new Set(rows.map((r) => r.kitchenName ?? "").filter(Boolean));
  const kitchenName = kitchenId && kitchenNames.size ? [...kitchenNames][0] : (kitchenNames.size === 1 ? [...kitchenNames][0] : null);
  return { rows: mapped, raw: rows, kitchenName, brand: brand ?? null };
}

function rotationFilename(kitchenName: string | null, brand: string | null, ext: string): string {
  const parts = ["menu-rotation"];
  if (brand) parts.push(sanitizeForFilename(brand));
  if (kitchenName) parts.push(sanitizeForFilename(kitchenName));
  parts.push(fileDateStamp());
  return `${parts.join("-")}.${ext}`;
}

// Export the current menu rotation (honours the same filters as the list) as CSV.
foodRouter.get("/menu-rotation/export.csv", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const { rows, kitchenName, brand } = await fetchRotationForExport(req);
    const csv = toCsv({ title: "Menu Rotation", headers: ROTATION_HEADERS, rows, propertyName: kitchenName });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${rotationFilename(kitchenName, brand, "csv")}`);
    res.send(csv);
  } catch (err) { fail(req, res, err); }
});

// Export the current menu rotation as PDF — a week-per-page day x meal calendar
// (toMenuRotationPdf), not the flat one-row-per-dish table the CSV uses. The
// table form repeated the kitchen, brand, week and day on all ~450 lines of a
// single cycle, so "what do we cook on Tuesday" meant reading the whole file.
foodRouter.get("/menu-rotation/export.pdf", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const { rows, raw, kitchenName, brand } = await fetchRotationForExport(req);
    // Tighter than the CSV cap: the calendar lays out every cell (H11).
    if (rows.length > ROTATION_PDF_ROW_CAP) {
      throw new HandlerAbort(422, {
        error: `This export is too large to render as PDF (over ${ROTATION_PDF_ROW_CAP.toLocaleString("en-IN")} rows). Narrow the filters, or download it as CSV.`,
      });
    }
    const pdf = await toMenuRotationPdf(raw);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${rotationFilename(kitchenName, brand, "pdf")}`);
    res.send(Buffer.from(pdf));
  } catch (err) { fail(req, res, err); }
});

/**
 * A rotation cell's own coordinates, bounded (L12).
 *
 * dayOfWeek is ISO 1–7 and rotationWeek a 1-based index into the cycle, but both
 * were accepted as any number: `dayOfWeek: 9` wrote a row resolveMenu can never
 * select (a dish that shows in Settings and is never cooked), and an out-of-band
 * rotationWeek silently lengthened the cycle for every meal in that cell, so the
 * plate went missing on the weeks the phase landed on it. The week ceiling is a
 * sanity bound, not a product rule — a cycle longer than a year is a typo.
 */
const ROTATION_WEEK_MAX = 52;
const zDayOfWeek = z.coerce.number().int().min(1).max(7);
const zRotationWeek = z.coerce.number().int().min(1).max(ROTATION_WEEK_MAX);
/**
 * A seasonal-window bound. Was any string, so `effectiveFrom: "next monday"`
 * reached `new Date(...)` as an Invalid Date and 500'd on insert. "" keeps its
 * existing meaning (the handlers read it as "no window").
 */
const zEffectiveDate = z.union([z.literal(""), z.coerce.date()]).nullish();

const createRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  mealType: zMealType,
  dishId: zId,
  dayOfWeek: zDayOfWeek,
  rotationWeek: zRotationWeek.nullish(),
  slotLabel: z.string().max(256).nullish(),
  sortOrder: z.coerce.number().nullish(),
  effectiveFrom: zEffectiveDate,
  effectiveTo: zEffectiveDate,
  isActive: z.boolean().optional(),
}).passthrough();

/**
 * uq_rotation_slot_dish / uq_rotation_slot_dish_global: a dish may appear at
 * most ONCE in a resolved menu cell. The commonest way to hit it is two mains
 * that each pair the SAME side dish — a configuration that was always
 * double-cooking that side, silently. The DB now refuses it; these routes have
 * to report it as the caller's mistake instead of a 500.
 */
const ROTATION_DUPLICATE_ERROR =
  "That dish is already on this plate — a dish can only appear once in a menu slot (check the sides chosen on the other items).";

/**
 * Side-dish rows for a cell, with the "cooked once per slot" invariant applied
 * rather than reported.
 *
 * Sides are stored as ordinary rotation rows in the same cell as their parent,
 * differing only by parentRotationId — which uq_rotation_slot_dish deliberately
 * ignores. So two mains each pairing the SAME side (both curries with Rice) used
 * to write two identical rows and now hits the constraint, failing the whole
 * save for a menu shape the plate editor still offers. Refusing it would remove
 * that shape from the product; collapsing it keeps the shape AND the invariant —
 * the side is cooked once, attached to the first main that asked for it. A side
 * that duplicates a MAIN on the plate is dropped for the same reason.
 */
type RotationInsert = typeof foodMenuRotationTable.$inferInsert;
function dedupeSideRows<P extends { id: string; sortOrder: number | null }>(
  items: Array<{ dishId: string; sideDishIds?: (string | null | undefined)[] | null }>,
  parents: P[],
  base: Omit<RotationInsert, "id" | "dishId">,
  now: Date,
): RotationInsert[] {
  const seen = new Set(items.map((it) => it.dishId));
  const rows: RotationInsert[] = [];
  items.forEach((it, i) => {
    (it.sideDishIds ?? []).filter(Boolean).forEach((sideDishId, j) => {
      const id = String(sideDishId);
      if (seen.has(id)) return;
      seen.add(id);
      rows.push({
        id: newId(), ...base,
        dishId: id, slotLabel: null,
        sortOrder: (parents[i]?.sortOrder ?? i) * 100 + j + 1,
        parentRotationId: parents[i]!.id, isActive: true, updatedAt: now,
      });
    });
  });
  return rows;
}

foodRouter.post("/menu-rotation", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createRotationSchema, req, res)) return;
    const b = req.body || {};
    if (!b.kitchenId || !b.brand || !b.mealType || !b.dishId || b.dayOfWeek == null) {
      res.status(400).json({ success: false, error: "kitchenId, brand, mealType, dishId, dayOfWeek required" }); return;
    }
    if (await deniedKitchen(req, res, b.kitchenId)) return;
    // Single-row add: the clash is against the plate this dish is JOINING, so
    // merge the cell's existing dishes in before checking.
    const cellDishes = await db.select({ dishId: foodMenuRotationTable.dishId })
      .from(foodMenuRotationTable)
      .where(and(
        eq(foodMenuRotationTable.kitchenId, b.kitchenId),
        eq(foodMenuRotationTable.brand, b.brand as never),
        eq(foodMenuRotationTable.rotationWeek, b.rotationWeek != null ? Number(b.rotationWeek) : 1),
        eq(foodMenuRotationTable.dayOfWeek, Number(b.dayOfWeek)),
        eq(foodMenuRotationTable.mealType, b.mealType as never),
      ));
    const addClash = await ingredientClashError([...new Set([...cellDishes.map((r) => r.dishId), b.dishId])]);
    if (addClash) { res.status(422).json({ success: false, ...addClash }); return; }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_menu_rotation", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(422).json({ success: false, error: ROTATION_DUPLICATE_ERROR }); return; }
    fail(req, res, err);
  }
});

/** Bulk-add menu items for one kitchen+brand+week+day+meal (multi-dish builder). */
const zRotationItem = z.object({
  dishId: zId,
  slotLabel: z.string().max(256).nullish(),
  sortOrder: z.coerce.number().nullish(),
  /**
   * Side dishes chosen to accompany this item, from the options configured on
   * the dish master. Each becomes its own rotation row with parentRotationId
   * pointing at this item.
   */
  sideDishIds: z.array(zId).optional(),
}).passthrough();

/**
 * A rotation row whose dish has no per-resident portion rule for this (brand,
 * mealType) is silently skipped by computeOrderItems — it shows on the menu but
 * never reaches the kitchen. Reject the save instead.
 *
 * This covers mains as well as sides. It used to check sides only, on the
 * reasoning that mains go through the deliberate builder flow and all carried
 * rules; but a main can now be created straight from the Dishes grid without
 * ever opening the portion editor, so an unpriced main is just as reachable —
 * and a silently-uncooked main is the worse failure. Returns offending names.
 */
async function dishesMissingPortionRule(
  brand: string, mealType: string, dishIds: string[],
): Promise<string[]> {
  const unique = [...new Set(dishIds.filter(Boolean))];
  if (!unique.length) return [];
  const rules = await db.select({ dishId: perResidentRuleTable.dishId })
    .from(perResidentRuleTable)
    .where(and(
      eq(perResidentRuleTable.brand, brand as never),
      eq(perResidentRuleTable.mealType, mealType as never),
      eq(perResidentRuleTable.isActive, true),
      inArray(perResidentRuleTable.dishId, unique),
    ));
  const priced = new Set(rules.map((r) => r.dishId));
  const missing = unique.filter((id) => !priced.has(id));
  if (!missing.length) return [];
  const named = await db.select({ name: dishesTable.name })
    .from(dishesTable).where(inArray(dishesTable.id, missing));
  return named.map((n) => n.name);
}

/** Every dish a slot payload would put on the menu — the items and their sides. */
const collectDishIds = (items: Array<{ dishId: string; sideDishIds?: string[] }>): string[] =>
  [...new Set(items.flatMap((it) => [it.dishId, ...(it.sideDishIds ?? [])]).filter(Boolean))];

/**
 * A side may only be one of the parent dish's CONFIGURED options
 * (dish_side_options). Nothing enforced that (L12): the plate composer offers
 * the configured list, but the API accepted any dish as a side of any other, so
 * the pairing shown in Settings and the pairing the kitchen cooks could differ —
 * and PUT /dishes' side prune then deleted those rotation rows as unrecognised,
 * silently dropping the dish from the plate on the next dish edit.
 *
 * Returns human-readable "<side> with <dish>" labels for the offending pairs.
 */
async function invalidSidePairs(
  items: Array<{ dishId: string; sideDishIds?: string[] }>,
): Promise<string[]> {
  const pairs = items.flatMap((it) =>
    (it.sideDishIds ?? []).filter(Boolean).map((sideDishId) => ({ dishId: it.dishId, sideDishId })),
  ).filter((p) => p.dishId);
  if (!pairs.length) return [];
  const parentIds = [...new Set(pairs.map((p) => p.dishId))];
  const configured = await db.select({ dishId: dishSideOptionsTable.dishId, sideDishId: dishSideOptionsTable.sideDishId })
    .from(dishSideOptionsTable)
    .where(inArray(dishSideOptionsTable.dishId, parentIds));
  const allowed = new Set(configured.map((c) => `${c.dishId}|${c.sideDishId}`));
  const bad = pairs.filter((p) => !allowed.has(`${p.dishId}|${p.sideDishId}`));
  if (!bad.length) return [];
  const nameById = new Map(
    (await db.select({ id: dishesTable.id, name: dishesTable.name })
      .from(dishesTable)
      .where(inArray(dishesTable.id, [...new Set(bad.flatMap((p) => [p.dishId, p.sideDishId]))])))
      .map((d) => [d.id, d.name] as const),
  );
  return bad.map((p) => `${nameById.get(p.sideDishId) ?? p.sideDishId} with ${nameById.get(p.dishId) ?? p.dishId}`);
}

/**
 * The shared-ingredient rule, enforced where it actually matters.
 *
 * `detectSharedIngredients` has existed since the rule engine was written, but
 * was wired only into GET /menu/validate — a read-only endpoint the admin client
 * never calls. The real block lived in the plate composer's disabled save button,
 * so "duplicate the week" (28 direct slot writes) and any API caller sailed past
 * a rule the UI advertised as always enforced. This closes that.
 *
 * Returns a 422 payload to send, or null when the plate is acceptable — either
 * because nothing clashes or because the rule is switched off in Service Set.
 */
async function ingredientClashError(
  dishIds: string[],
): Promise<{ error: string; details: Record<string, unknown> } | null> {
  if (dishIds.length < 2) return null;
  if (!(await isIngredientClashRuleOn())) return null;
  const shared = await detectSharedIngredients(dishIds);
  if (!shared.length) return null;
  const names = shared.map((s) => s.name).join(", ");
  return {
    error: `Two or more dishes on this plate share an ingredient (${names}). Swap one of them, or turn off the shared-ingredient rule under Menu Rules.`,
    details: { sharedIngredients: shared },
  };
}

/**
 * The audit identity of a menu CELL — the coordinates resolveMenu selects on.
 * The cell-level writes (bulk add, slot replace) rewrite a set of rows whose ids
 * change on every save, so the row id is not a stable thing to audit against.
 */
const rotationCellKey = (c: { kitchenId: string; brand: string; rotationWeek: number; dayOfWeek: number; mealType: string }): string =>
  `${c.kitchenId}|${c.brand}|W${c.rotationWeek}|D${c.dayOfWeek}|${c.mealType}`;

const bulkRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  mealType: zMealType,
  dayOfWeek: zDayOfWeek,
  rotationWeek: zRotationWeek.nullish(),
  items: z.array(zRotationItem).optional(),
}).passthrough();

foodRouter.post("/menu-rotation/bulk", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(bulkRotationSchema, req, res)) return;
    const b = req.body || {};
    const items: Array<{ dishId: string; slotLabel?: string; sortOrder?: number; sideDishIds?: string[] }> = Array.isArray(b.items) ? b.items : [];
    if (!b.kitchenId || !b.brand || !b.mealType || b.dayOfWeek == null || !items.length) {
      res.status(400).json({ success: false, error: "kitchenId, brand, mealType, dayOfWeek and at least one item required" }); return;
    }
    if (await deniedKitchen(req, res, b.kitchenId)) return;
    const unpriced = await dishesMissingPortionRule(b.brand, b.mealType, collectDishIds(items));
    if (unpriced.length) {
      res.status(400).json({
        success: false,
        error: `No portion rule for ${String(b.mealType).toLowerCase()} — the kitchen would never be told to cook: ${unpriced.join(", ")}. Set a portion per resident on the dish first.`,
        details: { dishes: unpriced },
      });
      return;
    }
    const bulkSides = await invalidSidePairs(items);
    if (bulkSides.length) {
      res.status(400).json({
        success: false,
        error: `Not a configured side: ${bulkSides.join(", ")}. Pair them on the dish first (Dishes → side options).`,
        details: { pairs: bulkSides },
      });
      return;
    }
    const bulkClash = await ingredientClashError(collectDishIds(items));
    if (bulkClash) { res.status(422).json({ success: false, ...bulkClash }); return; }
    const now = new Date();
    const base = {
      kitchenId: b.kitchenId,
      brand: b.brand,
      rotationWeek: b.rotationWeek != null ? Number(b.rotationWeek) : 1,
      dayOfWeek: Number(b.dayOfWeek),
      mealType: b.mealType,
    };
    const valid = items.filter((it) => it.dishId);
    if (!valid.length) { res.status(400).json({ success: false, error: "No valid items" }); return; }
    const rows = await db.transaction(async (tx) => {
      const parents = await tx.insert(foodMenuRotationTable).values(valid.map((it, i) => ({
        id: newId(), ...base,
        dishId: it.dishId,
        slotLabel: it.slotLabel ?? null,
        sortOrder: it.sortOrder != null ? Number(it.sortOrder) : i,
        isActive: true,
        updatedAt: now,
      }))).returning();
      const sideValues = dedupeSideRows(valid, parents, base, now);
      if (!sideValues.length) return parents;
      const sides = await tx.insert(foodMenuRotationTable).values(sideValues).returning();
      return [...parents, ...sides];
    });
    // A bulk add writes a whole menu CELL, so the audit entity is that cell key
    // rather than any one row id — the same coordinates resolveMenu selects on.
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_menu_rotation", rotationCellKey(base), { after: rows });
    res.status(201).json({ success: true, data: rows });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(422).json({ success: false, error: ROTATION_DUPLICATE_ERROR }); return; }
    fail(req, res, err);
  }
});

// Replace ALL dishes of one menu slot (kitchen+brand+week+day+meal) — the EDIT path.
const slotRotationSchema = z.object({
  kitchenId: zId,
  brand: zBrand,
  rotationWeek: zRotationWeek,
  dayOfWeek: zDayOfWeek,
  mealType: zMealType,
  items: z.array(zRotationItem).optional(),
}).passthrough();

foodRouter.put("/menu-rotation/slot", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(slotRotationSchema, req, res)) return;
    const b = req.body || {};
    const { kitchenId, brand, rotationWeek, dayOfWeek, mealType } = b;
    const items: Array<{ dishId: string; slotLabel?: string | null; sortOrder?: number; sideDishIds?: string[] }> = Array.isArray(b.items) ? b.items : [];
    if (!kitchenId || !brand || !mealType || rotationWeek == null || dayOfWeek == null) {
      res.status(400).json({ success: false, error: "kitchenId, brand, rotationWeek, dayOfWeek, mealType required" }); return;
    }
    if (await deniedKitchen(req, res, kitchenId)) return;
    // Rules before rotation: with no composition rule there is nothing to build
    // the plate against, so dishes may not be added. Clearing stays allowed —
    // rotation rows that predate the rule must never become unremovable.
    if (items.some((it) => it.dishId)) {
      const rule = await resolveCompositionRule(brand, mealType, kitchenId ?? null);
      if (!rule?.slots.length) {
        res.status(422).json({
          success: false,
          error: `No menu rule for ${mealType.toLowerCase()} — define the plate under Menu Rules before building this rotation.`,
          details: { brand, mealType },
        });
        return;
      }
    }
    const unpriced = await dishesMissingPortionRule(brand, mealType, collectDishIds(items));
    if (unpriced.length) {
      res.status(400).json({
        success: false,
        error: `No portion rule for ${mealType.toLowerCase()} — the kitchen would never be told to cook: ${unpriced.join(", ")}. Set a portion per resident on the dish first.`,
        details: { dishes: unpriced },
      });
      return;
    }
    const badSides = await invalidSidePairs(items);
    if (badSides.length) {
      res.status(400).json({
        success: false,
        error: `Not a configured side: ${badSides.join(", ")}. Pair them on the dish first (Dishes → side options).`,
        details: { pairs: badSides },
      });
      return;
    }
    // The plate arrives wholesale here, so the clash is checkable in one shot.
    const clash = await ingredientClashError(collectDishIds(items));
    if (clash) { res.status(422).json({ success: false, ...clash }); return; }
    const slotWhere = and(
      eq(foodMenuRotationTable.kitchenId, kitchenId),
      eq(foodMenuRotationTable.brand, brand as never),
      eq(foodMenuRotationTable.rotationWeek, Number(rotationWeek)),
      eq(foodMenuRotationTable.dayOfWeek, Number(dayOfWeek)),
      eq(foodMenuRotationTable.mealType, mealType as never),
    );
    const now = new Date();
    // The rows this replace destroys, kept for the audit entry (M17) — a slot
    // save is a delete-then-insert, so without them the prior plate is gone.
    let slotBefore: typeof foodMenuRotationTable.$inferSelect[] = [];
    const rows = await db.transaction(async (tx) => {
      // Preserve each existing dish's seasonal window across the replace.
      const existing = await tx.select().from(foodMenuRotationTable).where(slotWhere);
      slotBefore = existing;
      const effByDish = new Map(existing.map((e) => [e.dishId, { effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo }]));
      await tx.delete(foodMenuRotationTable).where(slotWhere);
      const valid = items.filter((it) => it.dishId);
      if (!valid.length) return [];
      // Parents first — the side rows need their ids for parentRotationId.
      const parents = await tx.insert(foodMenuRotationTable).values(valid.map((it, i) => ({
        id: newId(), kitchenId, brand, rotationWeek: Number(rotationWeek), dayOfWeek: Number(dayOfWeek), mealType,
        dishId: it.dishId, slotLabel: it.slotLabel ?? null, sortOrder: it.sortOrder != null ? Number(it.sortOrder) : i,
        effectiveFrom: effByDish.get(it.dishId)?.effectiveFrom ?? null, effectiveTo: effByDish.get(it.dishId)?.effectiveTo ?? null,
        isActive: true, updatedAt: now,
      }))).returning();
      // Chosen side dishes become ordinary rows tagged with their parent, so
      // every downstream consumer (resolveMenu → order items → dispatch) sees
      // them as normal dishes with no special handling.
      const sideValues = dedupeSideRows(
        valid, parents,
        { kitchenId, brand, rotationWeek: Number(rotationWeek), dayOfWeek: Number(dayOfWeek), mealType },
        now,
      );
      if (!sideValues.length) return parents;
      const sides = await tx.insert(foodMenuRotationTable).values(sideValues).returning();
      return [...parents, ...sides];
    });
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_menu_rotation",
      rotationCellKey({ kitchenId, brand, rotationWeek: Number(rotationWeek), dayOfWeek: Number(dayOfWeek), mealType }),
      { before: slotBefore, after: rows });
    res.json({ success: true, data: rows });
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(422).json({ success: false, error: ROTATION_DUPLICATE_ERROR }); return; }
    fail(req, res, err);
  }
});

// Validate the chosen dishes against the composition rule + flag shared ingredients.
foodRouter.get("/menu-rotation/validate", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = (req.query["kitchenId"] as string) || null;
    const raw = req.query["dishIds"] ?? req.query["dishId"];
    const dishIds = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
    // Side dishes are EXEMPT from composition-slot counting: a Bhature chosen
    // to accompany Chole must not consume the meal's "1 BREAD" slot. They are
    // still checked for shared ingredients, which applies to the whole plate.
    const sideRaw = req.query["sideDishIds"];
    const sideDishIds = new Set(
      (Array.isArray(sideRaw) ? sideRaw.map(String) : String(sideRaw ?? "").split(","))
        .map((s) => s.trim()).filter(Boolean),
    );
    if (!brand || !mealType) { res.status(400).json({ success: false, error: "brand, mealType required" }); return; }
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
    // H8: caller-supplied kitchenId, scoped like every other rotation read.
    // Null means the brand-wide composition rule, which every kitchen resolves
    // against — a legitimate read, so only a NAMED kitchen is scope-checked.
    if (kitchenId && await deniedKitchen(req, res, kitchenId)) return;
    const rule = await resolveCompositionRule(brand, mealType, kitchenId);
    const countedIds = dishIds.filter((id) => !sideDishIds.has(id));
    const dishes = await loadDishesForValidation(countedIds);
    const validation = validateMenuAgainstRule(rule, dishes);
    const sharedIngredients = await detectSharedIngredients([...new Set([...dishIds, ...sideDishIds])]);
    // Flat machine-readable verdict so the frontend can HARD-BLOCK a selection
    // ({ ok, violations:[{type,message,dishIds}] }) without re-deriving from slots.
    const verdict = buildCompositionVerdict(validation, sharedIngredients);
    res.json({ success: true, data: { ...validation, sharedIngredients, ok: verdict.ok, violations: verdict.violations } });
  } catch (err) { fail(req, res, err); }
});

// Suggested dishes to satisfy the composition rule for a (kitchen, brand, meal).
foodRouter.get("/menu-rotation/auto-fill", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = (req.query["kitchenId"] as string) || null;
    if (!brand || !mealType) { res.status(400).json({ success: false, error: "brand, mealType required" }); return; }
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
    // H8: caller-supplied kitchenId, scoped like every other rotation read.
    // Null means the brand-wide composition rule, which every kitchen resolves
    // against — a legitimate read, so only a NAMED kitchen is scope-checked.
    if (kitchenId && await deniedKitchen(req, res, kitchenId)) return;
    // Same gate as the slot write — there is no plate to fill without a rule.
    const rule = await resolveCompositionRule(brand, mealType, kitchenId);
    if (!rule?.slots.length) {
      res.status(422).json({
        success: false,
        error: `No menu rule for ${mealType.toLowerCase()} — define the plate under Menu Rules first.`,
        details: { brand, mealType },
      });
      return;
    }
    const items = await autoFillMenu(brand, mealType, kitchenId);
    res.json({ success: true, data: items });
  } catch (err) { fail(req, res, err); }
});

const updateRotationSchema = z.object({
  kitchenId: zId.optional(),
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  dishId: zId.optional(),
  slotLabel: z.string().max(256).nullish(),
  isActive: z.boolean().optional(),
  rotationWeek: zRotationWeek.optional(),
  dayOfWeek: zDayOfWeek.optional(),
  sortOrder: z.coerce.number().optional(),
  effectiveFrom: zEffectiveDate,
  effectiveTo: zEffectiveDate,
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

    // Moving a row to another cell, or swapping its dish, can create a clash in
    // the DESTINATION plate — so resolve that cell from current + pending values
    // and check the row against its future neighbours before writing.
    const [before] = await db.select().from(foodMenuRotationTable).where(eq(foodMenuRotationTable.id, req.params["id"]!));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const dest = {
      kitchenId: (u["kitchenId"] ?? before.kitchenId) as string,
      brand: (u["brand"] ?? before.brand) as string,
      rotationWeek: (u["rotationWeek"] ?? before.rotationWeek) as number,
      dayOfWeek: (u["dayOfWeek"] ?? before.dayOfWeek) as number,
      mealType: (u["mealType"] ?? before.mealType) as string,
      dishId: (u["dishId"] ?? before.dishId) as string,
    };
    // Both ends: you must own the row you are editing AND the cell you move it
    // into, or a move becomes a way to write into someone else's kitchen.
    if (await deniedKitchen(req, res, before.kitchenId)) return;
    if (await deniedKitchen(req, res, dest.kitchenId)) return;

    // The same two gates POST /menu-rotation/bulk and PUT /menu-rotation/slot
    // enforce, which this sibling skipped entirely (L12) — so the one write path
    // that MOVES a row could land a dish in a cell with no composition rule, or
    // swap in a dish with no portion rule that the kitchen is never told to cook.
    // Only a write that actually re-plates (new cell or new dish) is checked: a
    // sortOrder/label tweak on a row that predates the rules must stay editable,
    // exactly as clearing a slot does.
    const rePlates = (["kitchenId", "brand", "mealType", "dishId", "rotationWeek", "dayOfWeek"] as const)
      .some((k) => u[k] !== undefined && u[k] !== before[k]);
    if (rePlates) {
      const rule = await resolveCompositionRule(dest.brand, dest.mealType, dest.kitchenId ?? null);
      if (!rule?.slots.length) {
        res.status(422).json({
          success: false,
          error: `No menu rule for ${dest.mealType.toLowerCase()} — define the plate under Menu Rules before building this rotation.`,
          details: { brand: dest.brand, mealType: dest.mealType },
        });
        return;
      }
      const unpriced = await dishesMissingPortionRule(dest.brand, dest.mealType, [dest.dishId]);
      if (unpriced.length) {
        res.status(400).json({
          success: false,
          error: `No portion rule for ${dest.mealType.toLowerCase()} — the kitchen would never be told to cook: ${unpriced.join(", ")}. Set a portion per resident on the dish first.`,
          details: { dishes: unpriced },
        });
        return;
      }
    }
    const neighbours = await db.select({ id: foodMenuRotationTable.id, dishId: foodMenuRotationTable.dishId })
      .from(foodMenuRotationTable)
      .where(and(
        eq(foodMenuRotationTable.kitchenId, dest.kitchenId),
        eq(foodMenuRotationTable.brand, dest.brand as never),
        eq(foodMenuRotationTable.rotationWeek, dest.rotationWeek),
        eq(foodMenuRotationTable.dayOfWeek, dest.dayOfWeek),
        eq(foodMenuRotationTable.mealType, dest.mealType as never),
      ));
    const moveClash = await ingredientClashError([
      ...new Set([...neighbours.filter((n) => n.id !== before.id).map((n) => n.dishId), dest.dishId]),
    ]);
    if (moveClash) { res.status(422).json({ success: false, ...moveClash }); return; }

    const [row] = await db.update(foodMenuRotationTable).set(u as Partial<typeof foodMenuRotationTable.$inferInsert>).where(eq(foodMenuRotationTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_menu_rotation", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) {
    // uq_rotation_slot_dish is the DB backstop for the clash check above, and
    // this is the one write path that MOVES a row into another cell — i.e. the
    // one most likely to hit it. Its three siblings all map it; without this,
    // dragging a dish onto a plate that already carries it returned an opaque 500.
    if (isUniqueViolation(err)) { res.status(422).json({ success: false, error: ROTATION_DUPLICATE_ERROR }); return; }
    fail(req, res, err);
  }
});

foodRouter.delete("/menu-rotation/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    // Whole row, not just kitchenId: this is a HARD delete, so the audit entry
    // is the only surviving copy of what was on the plate (M17).
    const [before] = await db.select().from(foodMenuRotationTable).where(eq(foodMenuRotationTable.id, req.params["id"]!));
    if (!before) { res.json({ success: true }); return; } // already gone — stay idempotent
    if (await deniedKitchen(req, res, before.kitchenId)) return;
    await db.delete(foodMenuRotationTable).where(eq(foodMenuRotationTable.id, req.params["id"]!));
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_menu_rotation", before.id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Per-resident rules
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * H4 — scope guard for the per-resident portion rules.
 *
 * Unlike meal windows and cut-offs (property-dimensioned) or composition rules
 * and rotation (kitchen-dimensioned), this table has NO scope dimension the API
 * can write: every row the API creates is `propertyId: null`, i.e. brand-wide.
 * `qtyPerResident` is the multiplier `computeOrderItems` turns into kilograms,
 * so one edit changes what every kitchen on the brand cooks for every property.
 * With nothing to narrow on, the only honest gate is org-wide authority — the
 * same call `deniedConfigScope` makes for a null (brand-wide) propertyId.
 * Returns true when the request was refused, having already written the 403.
 */
async function deniedGlobalConfig(req: Request, res: Response): Promise<boolean> {
  const ids = await resolveAccessiblePropertyIds(req.user!);
  if (ids === null) return false;
  res.status(403).json({
    success: false,
    error: "Portion rules apply to every property on the brand — only an org-wide administrator can change them",
  });
  return true;
}

/**
 * M12 — refuse to strand a dish that is still on a live rotation slot.
 *
 * Removing the portion rule does NOT take the dish off the menu: it makes
 * computeOrderItems skip it in silence, so every future order drops a dish the
 * plate keeps advertising and the kitchen is never told to cook. Three writes
 * reach that state — DELETE, `isActive: false`, and re-keying the rule out of
 * its cell — so the check lives here and all three call it. The rotation WRITE
 * path already refuses to create the same state (dishesMissingPortionRule).
 *
 * `details` carries the actionable half: apiFetch surfaces it as the toast
 * description, so the dish drawer can say what to remove first.
 * Returns true when the request was refused, having already written the 409.
 */
async function refusePortionRuleInUse(
  res: Response,
  rule: { brand: string; mealType: string; dishId: string },
): Promise<boolean> {
  const usage = await findPortionRuleUsage(rule.brand, rule.mealType, rule.dishId);
  if (!usage) return false;
  const slots = `${usage.rotationCount} menu rotation slot${usage.rotationCount === 1 ? "" : "s"}`;
  const kitchens = usage.kitchenIds.length
    ? ` (${usage.kitchenIds.length} kitchen${usage.kitchenIds.length === 1 ? "" : "s"} affected)`
    : "";
  res.status(409).json({
    success: false,
    error: `${usage.dishName} is still on ${slots} for ${rule.mealType}`,
    details: `Remove ${usage.dishName} from those rotation slots first — while the portion rule is gone and the dish is still on the plate, every future ${rule.mealType} order silently drops it${kitchens}.`,
  });
  return true;
}

foodRouter.get("/rules", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const dishId = req.query["dishId"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
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
  } catch (err) { fail(req, res, err); }
});

const createRuleSchema = z.object({
  brand: zBrand,
  mealType: zMealType,
  dishId: zId,
  // Bounded like every other quantity in this file (preparedQty, the order
  // headcounts): per_resident_rules_qty_non_negative now REJECTS a negative, so
  // unbounded this reached the CHECK and came back as an opaque 500. A negative
  // portion is not a smaller order, it is a nonsense one — and Infinity would
  // land in the numeric column as the literal "Infinity".
  qtyPerResident: z.coerce.number().min(0).finite(),
  unit: z.enum(MEASUREMENT_UNITS),
  isActive: z.boolean().optional(),
}).passthrough();

/** The 422 both /rules writers answer when the CHECK rejects a negative portion.
 *  Shares one wording so the dish drawer treats create and edit identically. */
const RULE_QTY_NEGATIVE_ERROR = "Portion per resident cannot be negative.";

foodRouter.post("/rules", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    if (!validateBody(createRuleSchema, req, res)) return;
    const b = req.body || {};
    if (!b.brand || !b.mealType || !b.dishId || b.qtyPerResident == null || !b.unit) {
      res.status(400).json({ success: false, error: "brand, mealType, dishId, qtyPerResident, unit required" }); return;
    }
    if (await deniedGlobalConfig(req, res)) return;
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
    // qtyPerResident is the multiplier computeOrderItems turns into kilograms for
    // every property on the brand — the single most consequential config row here.
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_per_resident_rule", row.id, { after: row });
    res.status(201).json({ success: true, data: { ...row, qtyPerResident: Number(row.qtyPerResident) } });
  } catch (err) {
    // uq_per_resident_rule / _global is the DB backstop for the dedupe SELECT
    // above; report the same 409 rather than a 500.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A rule already exists for this brand, meal and dish" }); return; }
    // …and the CHECK is the backstop for the schema bound above. The value is
    // wholly caller-supplied, so a violation is the caller's to fix, not a bug.
    if (violatesCheck(err, "per_resident_rules_qty_non_negative")) { res.status(422).json({ success: false, error: RULE_QTY_NEGATIVE_ERROR }); return; }
    fail(req, res, err);
  }
});

const updateRuleSchema = z.object({
  brand: zBrand.optional(),
  mealType: zMealType.optional(),
  dishId: zId.optional(),
  unit: z.enum(MEASUREMENT_UNITS).optional(),
  isActive: z.boolean().optional(),
  // Same bound as createRuleSchema — the edit path writes the same column and
  // the same CHECK, and it is the one the dish drawer actually calls.
  qtyPerResident: z.coerce.number().min(0).finite().optional(),
}).passthrough();

foodRouter.put("/rules/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateRuleSchema, req, res)) return;
    const b = req.body || {};
    if (await deniedGlobalConfig(req, res)) return;
    const id = req.params["id"]!;
    const [before] = await db.select().from(perResidentRuleTable).where(eq(perResidentRuleTable.id, id));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // M12 — same end state as DELETE, reached two other ways. Deactivating the
    // rule, or RE-KEYING it (moving brand/mealType/dishId), both leave the dish
    // on the plate with no portion rule behind it, so computeOrderItems drops it
    // in silence. Check the ORIGINAL key: that is the cell the plate reads.
    const rekeyed =
      (b.brand !== undefined && b.brand !== before.brand) ||
      (b.mealType !== undefined && b.mealType !== before.mealType) ||
      (b.dishId !== undefined && b.dishId !== before.dishId);
    if (b.isActive === false || rekeyed) {
      if (await refusePortionRuleInUse(res, before)) return;
    }
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["brand", "mealType", "dishId", "unit", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.qtyPerResident !== undefined) u["qtyPerResident"] = String(b.qtyPerResident);
    const [row] = await db.update(perResidentRuleTable).set(u as Partial<typeof perResidentRuleTable.$inferInsert>).where(eq(perResidentRuleTable.id, id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_per_resident_rule", row.id, { before, after: row });
    res.json({ success: true, data: { ...row, qtyPerResident: Number(row.qtyPerResident) } });
  } catch (err) {
    // PUT has no duplicate pre-check of its own (POST does), so this mapping is
    // the only thing standing between a re-keyed rule and a 500.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "A rule already exists for this brand, meal and dish" }); return; }
    if (violatesCheck(err, "per_resident_rules_qty_non_negative")) { res.status(422).json({ success: false, error: RULE_QTY_NEGATIVE_ERROR }); return; }
    fail(req, res, err);
  }
});

foodRouter.delete("/rules/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    if (await deniedGlobalConfig(req, res)) return;
    const [rule] = await db.select().from(perResidentRuleTable).where(eq(perResidentRuleTable.id, id));
    if (!rule) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Clearing the portion field in the dish drawer fires this delete — a routine
    // UI action, so the M12 guard has to live on the server, not in the dialog.
    if (await refusePortionRuleInUse(res, rule)) return;
    await db.delete(perResidentRuleTable).where(eq(perResidentRuleTable.id, id));
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_per_resident_rule", id, { before: rule });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
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

foodRouter.get("/composition-rules", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const brand = req.query["brand"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const kitchenId = req.query["kitchenId"] as string | undefined;
    const conds = [] as ReturnType<typeof eq>[];
    if (invalidEnumParam(res, "mealType", mealType, MEAL_TYPES)) return;
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
  } catch (err) { fail(req, res, err); }
});

// Slots consumed by slotValues(): all fields loose (coerced/defaulted in code).
const zCompositionSlot = z.object({
  slotLabel: z.string().max(256).nullish(),
  // Enum column; slotValues() reads "" as "any component" and writes NULL.
  component: z.union([z.enum(DISH_COMPONENTS), z.literal("")]).nullish(),
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
    // Same kitchen-scope invariant as the rotation writes (H4): a composition
    // rule drives resolveCompositionRule, i.e. the shape of the plate every
    // kitchen on that brand may build. A null kitchenId is the BRAND-WIDE rule,
    // so a kitchen-bound caller may not mint one.
    if (await deniedKitchen(req, res, b.kitchenId || null)) return;
    const result = await db.transaction(async (tx) => {
      const [rule] = await tx.insert(menuCompositionRuleTable).values({
        id: newId(), brand: b.brand, mealType: b.mealType, kitchenId: b.kitchenId || null,
        name: b.name ?? null, isActive: b.isActive !== false, updatedAt: new Date(),
      }).returning();
      const sv = slotValues(rule!.id, b.slots);
      const slots = sv.length ? await tx.insert(menuCompositionSlotTable).values(sv).returning() : [];
      return { ...rule, slots };
    });
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_composition_rule", result.id!, { after: result });
    res.status(201).json({ success: true, data: result });
  } catch (err) { fail(req, res, err); }
});

const updateCompositionRuleSchema = z.object({
  // The handler converts "" → null for these, so accept blank strings too.
  // mealType is the exception: it is a NOT NULL enum column, so neither "" nor
  // any other free string could ever have succeeded — 400 instead of 500 (L6).
  brand: z.string().max(128).optional(),
  mealType: zMealType.optional(),
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
    // Both ends of the move are checked (H4): the STORED kitchen, so a rule you
    // do not own cannot be edited, and the REQUESTED one, so it cannot be handed
    // to a kitchen you do not own — or promoted brand-wide, which `"" → null`
    // below would otherwise do silently.
    const [before] = await db.select()
      .from(menuCompositionRuleTable).where(eq(menuCompositionRuleTable.id, id));
    if (!before) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedKitchen(req, res, before.kitchenId)) return;
    if (b.kitchenId !== undefined && await deniedKitchen(req, res, b.kitchenId === "" ? null : b.kitchenId)) return;
    // The prior plate shape: the slots below are replaced wholesale, so this is
    // the only copy of what they were (M17).
    const beforeSlots = await db.select().from(menuCompositionSlotTable)
      .where(eq(menuCompositionSlotTable.ruleId, id)).orderBy(menuCompositionSlotTable.sortOrder);
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
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_composition_rule", id, { before: { ...before, slots: beforeSlots }, after: result });
    res.json({ success: true, data: result });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/composition-rules/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    // Load-then-check, as the sibling writes do (H4). A blind DELETE let a
    // kitchen-bound caller remove the brand-wide rule every other kitchen builds
    // its plate from. The whole row (and its slots) is read, not just kitchenId:
    // this is a hard delete, so the audit entry is the only copy left (M17).
    const [rule] = await db.select()
      .from(menuCompositionRuleTable).where(eq(menuCompositionRuleTable.id, id));
    if (!rule) { res.status(404).json({ success: false, error: "Not found" }); return; }
    if (await deniedKitchen(req, res, rule.kitchenId)) return;
    const ruleSlots = await db.select().from(menuCompositionSlotTable)
      .where(eq(menuCompositionSlotTable.ruleId, id)).orderBy(menuCompositionSlotTable.sortOrder);
    await db.delete(menuCompositionRuleTable).where(eq(menuCompositionRuleTable.id, id));
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_composition_rule", id, { before: { ...rule, slots: ruleSlots } });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Delivery partners
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Who may see a driver's phone and vehicle number. Mirrors the kitchen-contact
 * rule in food-ops' GET /kitchens: the modules that ADMINISTER the fleet, plus
 * the one that actually books a van onto a trip.
 */
function mayReadPartnerContacts(req: Request): boolean {
  const role = req.user!.role as UserRole;
  return can(role, "FOOD_SETTINGS", "view") || can(role, "FOOD_ORG", "view") || can(role, "FOOD_DISPATCH", "view");
}

// H8 — same shape as GET /kitchens: the gate admits every food module because
// the dispatch pickers need the PARTNER (id/name/active), but a driver's phone
// and vehicle number are contact PII that only the two administrative modules
// need. `authenticate` alone published the whole fleet register to any account
// with a login.
foodRouter.get("/delivery-partners", authenticate, authorizeAny(FOOD_MODULES, "view"), async (req, res) => {
  try {
    const active = req.query["active"] as string | undefined;
    const where = active !== undefined ? eq(deliveryPartnersTable.isActive, active === "true") : undefined;
    const rows = await db.select().from(deliveryPartnersTable).where(where).orderBy(deliveryPartnersTable.name);
    const data = mayReadPartnerContacts(req) ? rows : rows.map(({ phone, vehicleNumber, ...rest }) => rest);
    res.json({ success: true, data });
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_delivery_partner", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(deliveryPartnersTable).where(eq(deliveryPartnersTable.id, req.params["id"]!));
    const [row] = await db.update(deliveryPartnersTable).set(u as Partial<typeof deliveryPartnersTable.$inferInsert>).where(eq(deliveryPartnersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_delivery_partner", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/delivery-partners/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const [before] = await db.select().from(deliveryPartnersTable).where(eq(deliveryPartnersTable.id, req.params["id"]!));
    const [row] = await db.update(deliveryPartnersTable).set({ isActive: false, updatedAt: new Date() }).where(eq(deliveryPartnersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_delivery_partner", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    if (search) conds.push(ilike(agenciesTable.name, `%${escapeLike(search)}%`));
    if (vehicleSearch) {
      conds.push(sql`exists (select 1 from ${agencyVehiclesTable} where ${agencyVehiclesTable.agencyId} = ${agenciesTable.id} and ${ilike(agencyVehiclesTable.vehicleNumber, `%${escapeLike(vehicleSearch)}%`)})`);
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
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_agency", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(agenciesTable).where(eq(agenciesTable.id, req.params["id"]!));
    const [row] = await db.update(agenciesTable).set(u as never).where(eq(agenciesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_agency", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/agencies/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    const [before] = await db.select().from(agenciesTable).where(eq(agenciesTable.id, req.params["id"]!));
    const [row] = await db.update(agenciesTable).set({ isActive: false, updatedAt: new Date() }).where(eq(agenciesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "food_agency", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
    // The links this replace wipes, for the audit entry (M17) — which agencies
    // may serve a kitchen decides who can be booked onto its trips.
    const beforeLinks = await db.select({ kitchenId: agencyKitchensTable.kitchenId })
      .from(agencyKitchensTable).where(eq(agencyKitchensTable.agencyId, agencyId));
    await db.transaction(async (tx) => {
      await tx.delete(agencyKitchensTable).where(eq(agencyKitchensTable.agencyId, agencyId));
      if (kitchenIds.length) {
        await tx.insert(agencyKitchensTable).values(kitchenIds.map((kitchenId) => ({
          id: newId(), agencyId, kitchenId, isActive: true,
        })));
      }
    });
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_agency_kitchens", agencyId, {
      before: { kitchenIds: beforeLinks.map((l) => l.kitchenId) }, after: { kitchenIds },
    });
    res.json({ success: true, data: { agencyId, kitchenIds } });
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_agency_location", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(agencyLocationsTable).where(eq(agencyLocationsTable.id, req.params["id"]!));
    const [row] = await db.update(agencyLocationsTable).set(u as never).where(eq(agencyLocationsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_agency_location", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/agency-locations/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    // Hard delete — read the row first or nothing survives it (M17).
    const [before] = await db.select().from(agencyLocationsTable).where(eq(agencyLocationsTable.id, req.params["id"]!));
    await db.delete(agencyLocationsTable).where(eq(agencyLocationsTable.id, req.params["id"]!));
    if (before) auditConfig(req, "FOOD_CONFIG_DELETED", "food_agency_location", before.id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

// Nested vehicles
const createAgencyVehicleSchema = z.object({
  vehicleNumber: z.string().min(1).max(64),
  // Enum column (L6); nullish because the handler defaults a missing type to VAN.
  vehicleType: z.enum(VEHICLE_TYPES).nullish(),
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "food_agency_vehicle", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

const updateAgencyVehicleSchema = z.object({
  vehicleNumber: z.string().max(64).optional(),
  vehicleType: z.enum(VEHICLE_TYPES).nullish(),
  locationId: zId.nullish(),
  isActive: z.boolean().optional(),
}).passthrough();

foodRouter.put("/agency-vehicles/:id", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(updateAgencyVehicleSchema, req, res)) return;
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["vehicleNumber", "vehicleType", "locationId", "isActive"]) if (b[k] !== undefined) u[k] = b[k];
    const [before] = await db.select().from(agencyVehiclesTable).where(eq(agencyVehiclesTable.id, req.params["id"]!));
    const [row] = await db.update(agencyVehiclesTable).set(u as never).where(eq(agencyVehiclesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "food_agency_vehicle", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/agency-vehicles/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    // Hard delete — read the row first or nothing survives it (M17).
    const [before] = await db.select().from(agencyVehiclesTable).where(eq(agencyVehiclesTable.id, req.params["id"]!));
    await db.delete(agencyVehiclesTable).where(eq(agencyVehiclesTable.id, req.params["id"]!));
    if (before) auditConfig(req, "FOOD_CONFIG_DELETED", "food_agency_vehicle", before.id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — Geographic hierarchy
 * ──────────────────────────────────────────────────────────────────────────── */

/** count(*) for a geo node's dependants, as one scalar. */
async function countGeoRefs(q: Promise<{ c: number }[]>): Promise<number> {
  const [row] = await q;
  return row?.c ?? 0;
}

/**
 * Refuses a geo hard-delete that would strand what hangs off it.
 *
 * Zone → City → Cluster → Property is the spine resolveAccessiblePropertyIds
 * walks, and the links that matter most are NOT enforced by the database:
 * `properties.cluster_id` and `kitchens.city_id`/`cluster_id` carry no FK at all
 * (the deliberate core↔food decoupling), so a delete silently detached every
 * property underneath and stripped its CITY/ZONE grantees with no error
 * anywhere — while the links that DO have an FK (cities.zone_id, clusters.city_id,
 * user_scopes.*) came back as an opaque 500. Say what is still attached instead,
 * the way refusePortionRuleInUse does for portion rules.
 *
 * `details` carries the actionable half: apiFetch renders it as the toast body.
 */
function refuseGeoDelete(res: Response, label: string, parts: string[]): void {
  res.status(409).json({
    success: false,
    error: `This ${label} is still in use — ${parts.join(", ")}`,
    details: `Reassign them first. Deleting a ${label} detaches everything under it from the org spine, and every user who reaches those properties through it silently loses access.`,
  });
}

foodRouter.get("/zones", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(zonesTable).orderBy(zonesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "zone", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(zonesTable).where(eq(zonesTable.id, req.params["id"]!));
    const [row] = await db.update(zonesTable).set(u as Partial<typeof zonesTable.$inferInsert>).where(eq(zonesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "zone", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/zones/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    // Grants are counted regardless of isActive: a soft-revoked row still holds
    // the FK, so it is still what makes the delete fail.
    const cities = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(citiesTable).where(eq(citiesTable.zoneId, id)));
    const grants = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(userScopesTable).where(eq(userScopesTable.zoneId, id)));
    const parts: string[] = [];
    if (cities) parts.push(`${cities} ${cities === 1 ? "city" : "cities"}`);
    if (grants) parts.push(`${grants} access grant${grants === 1 ? "" : "s"}`);
    if (parts.length) { refuseGeoDelete(res, "zone", parts); return; }
    const [before] = await db.select().from(zonesTable).where(eq(zonesTable.id, id));
    await db.delete(zonesTable).where(eq(zonesTable.id, id));
    if (before) auditConfig(req, "FOOD_CONFIG_DELETED", "zone", id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

foodRouter.get("/cities", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const zoneId = req.query["zoneId"] as string | undefined;
    const where = zoneId ? eq(citiesTable.zoneId, zoneId) : undefined;
    const rows = await db.select().from(citiesTable).where(where).orderBy(citiesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "city", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(citiesTable).where(eq(citiesTable.id, req.params["id"]!));
    const [row] = await db.update(citiesTable).set(u as Partial<typeof citiesTable.$inferInsert>).where(eq(citiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "city", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/cities/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const clusters = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(clustersTable).where(eq(clustersTable.cityId, id)));
    // kitchens.city_id carries no FK, so this is the link that used to break silently.
    const kitchens = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(kitchensTable).where(eq(kitchensTable.cityId, id)));
    const grants = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(userScopesTable).where(eq(userScopesTable.cityId, id)));
    const parts: string[] = [];
    if (clusters) parts.push(`${clusters} cluster${clusters === 1 ? "" : "s"}`);
    if (kitchens) parts.push(`${kitchens} kitchen${kitchens === 1 ? "" : "s"}`);
    if (grants) parts.push(`${grants} access grant${grants === 1 ? "" : "s"}`);
    if (parts.length) { refuseGeoDelete(res, "city", parts); return; }
    const [before] = await db.select().from(citiesTable).where(eq(citiesTable.id, id));
    await db.delete(citiesTable).where(eq(citiesTable.id, id));
    if (before) auditConfig(req, "FOOD_CONFIG_DELETED", "city", id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

foodRouter.get("/clusters", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const cityId = req.query["cityId"] as string | undefined;
    const where = cityId ? eq(clustersTable.cityId, cityId) : undefined;
    const rows = await db.select().from(clustersTable).where(where).orderBy(clustersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
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
    auditConfig(req, "FOOD_CONFIG_CREATED", "cluster", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
    const [before] = await db.select().from(clustersTable).where(eq(clustersTable.id, req.params["id"]!));
    const [row] = await db.update(clustersTable).set(u as Partial<typeof clustersTable.$inferInsert>).where(eq(clustersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_UPDATED", "cluster", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

foodRouter.delete("/clusters/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    // properties.cluster_id has no FK — this is the count that was silently
    // detaching properties from the org spine on every cluster delete.
    const props = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(propertiesTable).where(eq(propertiesTable.clusterId, id)));
    const kitchens = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(kitchensTable).where(eq(kitchensTable.clusterId, id)));
    const grants = await countGeoRefs(db.select({ c: sql<number>`count(*)::int` }).from(userScopesTable).where(eq(userScopesTable.clusterId, id)));
    const parts: string[] = [];
    if (props) parts.push(`${props} propert${props === 1 ? "y" : "ies"}`);
    if (kitchens) parts.push(`${kitchens} kitchen${kitchens === 1 ? "" : "s"}`);
    if (grants) parts.push(`${grants} access grant${grants === 1 ? "" : "s"}`);
    if (parts.length) { refuseGeoDelete(res, "cluster", parts); return; }
    const [before] = await db.select().from(clustersTable).where(eq(clustersTable.id, id));
    await db.delete(clustersTable).where(eq(clustersTable.id, id));
    if (before) auditConfig(req, "FOOD_CONFIG_DELETED", "cluster", id, { before });
    res.json({ success: true });
  } catch (err) { fail(req, res, err); }
});

/**
 * True when `clusterId` is OUTSIDE a scope-restricted caller's reach, having
 * already written the 403 (C5).
 *
 * `properties.clusterId` is a scope ROOT, so the org spine this walks is the one
 * resolveAccessiblePropertyIds walks to decide who sees the property afterwards:
 * a direct CLUSTER grant, a CITY grant on the cluster's city, or a ZONE grant on
 * that city's zone. Call it only for a restricted caller (accessible property ids
 * !== null); an org-wide role has no scope rows to match and is not being gated.
 */
async function deniedClusterScope(req: Request, res: Response, clusterId: string): Promise<boolean> {
  const scopes = await db.select({
    scopeLevel: userScopesTable.scopeLevel,
    zoneId: userScopesTable.zoneId,
    cityId: userScopesTable.cityId,
    clusterId: userScopesTable.clusterId,
  }).from(userScopesTable)
    .where(and(eq(userScopesTable.userId, req.user!.id), eq(userScopesTable.isActive, true)));
  if (scopes.some((s) => s.scopeLevel === "CLUSTER" && s.clusterId === clusterId)) return false;
  const [cluster] = await db.select({ cityId: clustersTable.cityId })
    .from(clustersTable).where(eq(clustersTable.id, clusterId));
  if (cluster) {
    const cityIds = new Set(scopes.filter((s) => s.scopeLevel === "CITY" && s.cityId).map((s) => s.cityId!));
    const zoneIds = scopes.filter((s) => s.scopeLevel === "ZONE" && s.zoneId).map((s) => s.zoneId!);
    if (zoneIds.length) {
      const rows = await db.select({ id: citiesTable.id }).from(citiesTable).where(inArray(citiesTable.zoneId, zoneIds));
      rows.forEach((c) => cityIds.add(c.id));
    }
    if (cityIds.has(cluster.cityId)) return false;
  }
  res.status(403).json({ success: false, error: "Outside your cluster scope" });
  return true;
}

// No `.passthrough()`: this body has exactly one meaningful field and it re-points
// a scope ROOT, so an unrecognised key here is a client that thinks it is saying
// something the server will honour (C5). Its twin, assign-kitchen, is closed too.
const assignClusterSchema = z.object({ clusterId: zId.nullish() }).strict();

foodRouter.post("/properties/:id/assign-cluster", authenticate, authorize("FOOD_ORG", "edit"), async (req, res) => {
  try {
    if (!validateBody(assignClusterSchema, req, res)) return;
    const clusterId = req.body?.clusterId ? String(req.body.clusterId) : null;
    // Invariant: properties.clusterId is a scope ROOT, not a reporting tag —
    // resolveAccessiblePropertyIds walks zone → city → cluster → this column, so
    // re-pointing it at a nonexistent/inactive cluster (or clearing it) silently
    // strips every CITY/ZONE/CLUSTER-scoped user of that property, with no error
    // anywhere. Same treatment as its twin, assign-kitchen: the caller must own
    // the property, the target must be live, and it may not be stranded.
    const [prop] = await db.select({ id: propertiesTable.id, clusterId: propertiesTable.clusterId })
      .from(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
    if (!prop) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(prop.id, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    if (clusterId) {
      if (!(await scopeTargetIsLive("CLUSTER", clusterId))) {
        res.status(422).json({ success: false, error: `clusterId ${clusterId} does not exist or is not active` });
        return;
      }
      // The DESTINATION half of the guard (C5). Owning the property is only one
      // end of the move: without this, a scoped caller could push a property into
      // any cluster in the org, handing it to that cluster's grantees and taking
      // it off their own screen — the property-side twin of "re-point a property
      // to my kitchen", and the reason assign-kitchen checks both ends.
      if (ids !== null && await deniedClusterScope(req, res, clusterId)) return;
    } else if (ids !== null) {
      res.status(403).json({ success: false, error: "Pick a cluster — a property cannot be left outside the org spine" });
      return;
    }
    const [row] = await db.update(propertiesTable).set({ clusterId, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Only the column this endpoint owns — the rest of the property row is not
    // what changed, and the audit entry has to read as "who moved this, and from
    // where" (M17).
    auditConfig(req, "FOOD_CONFIG_UPDATED", "property_cluster", row.id, {
      before: { clusterId: prop.clusterId }, after: { clusterId },
    });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Master data — User scopes
 * ──────────────────────────────────────────────────────────────────────────── */

foodRouter.get("/scopes", authenticate, authorize("FOOD_ORG", "view"), async (req, res) => {
  try {
    const userId = req.query["userId"] as string | undefined;
    // Revocation is soft (isActive), so the default listing must show LIVE
    // grants only — a revoked row rendered beside active ones reads as access
    // the user no longer has. ?includeRevoked=true returns the full history.
    const conds = [] as ReturnType<typeof eq>[];
    if (userId) conds.push(eq(userScopesTable.userId, userId));
    if (req.query["includeRevoked"] !== "true") conds.push(eq(userScopesTable.isActive, true));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(userScopesTable).where(where).orderBy(desc(userScopesTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { fail(req, res, err); }
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

/**
 * The geo column each scope level narrows on. All five levels now resolve in
 * food-service.ts, across BOTH live spines (city → kitchen → properties.kitchenId
 * and zone → city → cluster → properties.clusterId), so ZONE and CLUSTER are no
 * longer second-class levels to be tolerated — they are grants that confer real
 * read and write authority and must be validated like the rest.
 */
const SCOPE_GEO_FIELD = {
  ZONE: "zoneId",
  CITY: "cityId",
  KITCHEN: "kitchenId",
  CLUSTER: "clusterId",
  PROPERTY: "propertyId",
} as const;
type GeoScopeLevel = keyof typeof SCOPE_GEO_FIELD;

/**
 * True when the master row a scope level points at exists and is live. A grant
 * anchored to a missing or deactivated row resolves to nothing while looking
 * perfectly healthy in the scopes list — the same silent lockout as a null geo
 * id, and indistinguishable from "no orders today" in support.
 */
async function scopeTargetIsLive(level: GeoScopeLevel, id: string): Promise<boolean> {
  switch (level) {
    case "ZONE": { const [r] = await db.select({ isActive: zonesTable.isActive }).from(zonesTable).where(eq(zonesTable.id, id)); return r?.isActive === true; }
    case "CITY": { const [r] = await db.select({ isActive: citiesTable.isActive }).from(citiesTable).where(eq(citiesTable.id, id)); return r?.isActive === true; }
    case "KITCHEN": { const [r] = await db.select({ isActive: kitchensTable.isActive }).from(kitchensTable).where(eq(kitchensTable.id, id)); return r?.isActive === true; }
    case "CLUSTER": { const [r] = await db.select({ isActive: clustersTable.isActive }).from(clustersTable).where(eq(clustersTable.id, id)); return r?.isActive === true; }
    // Properties carry a lifecycle `status`, not an isActive flag, and a property
    // that is still onboarding is a legitimate grant target — existence is the
    // whole test here.
    case "PROPERTY": { const [r] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.id, id)); return !!r; }
  }
}

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
    const level = String(b.scopeLevel);
    if (level !== "GLOBAL" && !(level in SCOPE_GEO_FIELD)) {
      res.status(400).json({ success: false, error: `Invalid scopeLevel ${b.scopeLevel}` });
      return;
    }
    // The grantee has to exist; the FK would otherwise surface as a 500.
    const [grantee] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, b.userId));
    if (!grantee) { res.status(404).json({ success: false, error: "User not found" }); return; }

    const geoIdByLevel: Record<string, string | undefined> = {
      ZONE: b.zoneId,
      CITY: b.cityId,
      KITCHEN: b.kitchenId,
      CLUSTER: b.clusterId,
      PROPERTY: b.propertyId,
    };
    // Invariant: a stored grant carries EXACTLY ONE geo id, the one its level
    // narrows on, and that id points at a live master row. Rows that break it
    // (null id for the level, or ids left over from other levels) resolve to
    // nothing and are indistinguishable from a deliberate lockout — they are the
    // malformed rows the resolver has to defend against, so they never get
    // written in the first place. Ids belonging to other levels are dropped
    // rather than persisted, which also keeps the uq_user_scopes_grant_* indexes
    // meaningful (six paired partials, one per level — see schema/food.ts).
    let geoId: string | null = null;
    if (level !== "GLOBAL") {
      const geoLevel = level as GeoScopeLevel;
      const field = SCOPE_GEO_FIELD[geoLevel];
      geoId = geoIdByLevel[geoLevel] ?? null;
      if (!geoId) { res.status(400).json({ success: false, error: `${field} required for ${level} scope` }); return; }
      if (!(await scopeTargetIsLive(geoLevel, geoId))) {
        res.status(422).json({ success: false, error: `${field} ${geoId} does not exist or is not active` });
        return;
      }
    }
    const geo = {
      zoneId: level === "ZONE" ? geoId : null,
      cityId: level === "CITY" ? geoId : null,
      kitchenId: level === "KITCHEN" ? geoId : null,
      clusterId: level === "CLUSTER" ? geoId : null,
      propertyId: level === "PROPERTY" ? geoId : null,
    };

    // Re-granting a revoked scope REACTIVATES the original row. The
    // uq_user_scopes_grant_* indexes are keyed on (user, level, geo) and ignore
    // isActive, so a second insert would 23505 and an admin would have no way to
    // restore a grant they revoked.
    const siblings = await db.select().from(userScopesTable)
      .where(and(eq(userScopesTable.userId, b.userId), eq(userScopesTable.scopeLevel, level as never)));
    const existing = siblings.find((s) =>
      s.zoneId === geo.zoneId && s.cityId === geo.cityId && s.kitchenId === geo.kitchenId &&
      s.clusterId === geo.clusterId && s.propertyId === geo.propertyId);
    if (existing) {
      if (existing.isActive) { res.status(409).json({ success: false, error: "This user already holds that scope" }); return; }
      const [row] = await db.update(userScopesTable).set({ isActive: true }).where(eq(userScopesTable.id, existing.id)).returning();
      // Reinstating a revoked grant is an access change like any other (M17).
      auditConfig(req, "FOOD_CONFIG_UPDATED", "user_scope", existing.id, { before: existing, after: row });
      res.json({ success: true, data: row });
      return;
    }

    const [row] = await db.insert(userScopesTable).values({
      id: newId(),
      userId: b.userId,
      scopeLevel: level as never,
      ...geo,
    }).returning();
    // This is the access-control plane: who granted what, to whom, and when is
    // the entry support has to be able to read back (M17).
    auditConfig(req, "FOOD_CONFIG_CREATED", "user_scope", row.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    // Concurrent grant of the same (user, level, geo) — the DB backstop for the
    // duplicate check above.
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, error: "This user already holds that scope" }); return; }
    fail(req, res, err);
  }
});

foodRouter.delete("/scopes/:id", authenticate, authorize("FOOD_ORG", "delete"), async (req, res) => {
  try {
    // Soft revoke. A hard DELETE left "never configured" and "deliberately
    // revoked" indistinguishable, with no record of who lost what; the resolver
    // reads isActive, so flipping the flag is what actually withdraws the grant.
    // Idempotent — revoking an already-revoked row is a 200 no-op.
    const [before] = await db.select().from(userScopesTable).where(eq(userScopesTable.id, req.params["id"]!));
    const [row] = await db.update(userScopesTable).set({ isActive: false })
      .where(eq(userScopesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditConfig(req, "FOOD_CONFIG_DELETED", "user_scope", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { fail(req, res, err); }
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
  } catch (err) { fail(req, res, err); }
});

export default foodRouter;
