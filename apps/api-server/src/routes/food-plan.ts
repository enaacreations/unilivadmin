/**
 * Shared pre-placement order plan — HTTP routes.
 *
 * The plan is the agreed set of numbers for one property + service day, shared
 * by everyone who can place that property's order. It replaces the per-USER
 * draft in food_order_drafts, which gave each editor a private copy of the same
 * day's order: a unit lead and an ops-excellence admin never saw each other's
 * numbers, and whoever placed first silently won.
 *
 * One row per editable cell (a meal's headcount, or one dish's people count),
 * so two people adjusting different dishes never overwrite one another.
 *
 * Locking: a FOOD_ORDER_LOCK holder (SUPER_ADMIN / OPS_EXCELLENCE) pins a cell.
 * Pinned cells are rejected here for everyone else AND re-applied at placement
 * in food-ops.ts — a disabled stepper is a hint, the 403 is the control.
 *
 * serviceDate is a bare 'yyyy-MM-dd' IST calendar day anchored to 00:00 IST,
 * exactly like food_orders.service_date, so upsert/lookup equality is exact.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  foodOrderPlanMealsTable,
  foodOrderPlanDishesTable,
  usersTable,
} from "@workspace/db";
import { and, eq, lt, inArray } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { can, type UserRole } from "../lib/permissions.js";
import { newId } from "../lib/id.js";
import { resolveAccessiblePropertyIds } from "../lib/food-service.js";
import { ymdToIstDayStart, todayIstYmd } from "../lib/tz.js";

const foodPlanRouter: IRouter = Router();

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
type MealType = (typeof MEAL_TYPES)[number];

const zId = z.string().min(1).max(128);
const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "serviceDate must be yyyy-MM-dd");
const zMealType = z.enum(MEAL_TYPES);
/** Headcounts are people, so non-negative integers with a sane ceiling. */
const zCount = z.coerce.number().int().min(0).max(100000);
const zLockNote = z.string().max(280).nullish();

/** Mirror of food.ts: validate req.body, 400 with field details on failure. */
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

/** True if the property is within the caller's accessible set (null = all). */
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

/** Can this caller pin a cell (and edit one that is already pinned)? */
function canLock(role: UserRole | undefined): boolean {
  return can(role, "FOOD_ORDER_LOCK", "edit");
}

/**
 * Drops plan rows for past IST service days. Locks are day-scoped by design, so
 * a forgotten lock can never silently constrain a later order. Opportunistic —
 * runs on write, no cron needed.
 */
async function sweepStalePlans(): Promise<void> {
  const cutoff = ymdToIstDayStart(todayIstYmd());
  await db.delete(foodOrderPlanMealsTable).where(lt(foodOrderPlanMealsTable.serviceDate, cutoff));
  await db.delete(foodOrderPlanDishesTable).where(lt(foodOrderPlanDishesTable.serviceDate, cutoff));
}

/** Reads the whole plan for one property + day, with lock attribution resolved. */
async function readPlan(propertyId: string, serviceDate: Date) {
  const [meals, dishes] = await Promise.all([
    db.select().from(foodOrderPlanMealsTable).where(and(
      eq(foodOrderPlanMealsTable.propertyId, propertyId),
      eq(foodOrderPlanMealsTable.serviceDate, serviceDate),
    )),
    db.select().from(foodOrderPlanDishesTable).where(and(
      eq(foodOrderPlanDishesTable.propertyId, propertyId),
      eq(foodOrderPlanDishesTable.serviceDate, serviceDate),
    )),
  ]);

  // Resolve locker names in one round trip so the unit lead's row can say who
  // set the number rather than just that it is fixed.
  const lockerIds = [...new Set(
    [...meals, ...dishes].map((r) => r.lockedByUserId).filter((v): v is string => !!v),
  )];
  const lockers = lockerIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable).where(inArray(usersTable.id, lockerIds))
    : [];
  const nameById = new Map(lockers.map((u) => [u.id, u.name]));
  const lockInfo = (r: { isLocked: boolean; lockNote: string | null; lockedByUserId: string | null; lockedAt: Date | null }) => ({
    isLocked: r.isLocked,
    lockNote: r.lockNote,
    lockedByUserId: r.lockedByUserId,
    lockedByName: r.lockedByUserId ? nameById.get(r.lockedByUserId) ?? null : null,
    lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
  });

  return {
    meals: meals.map((r) => ({
      mealType: r.mealType, residents: r.residents, staff: r.staff,
      updatedAt: r.updatedAt.toISOString(), ...lockInfo(r),
    })),
    dishes: dishes.map((r) => ({
      mealType: r.mealType, dishId: r.dishId, persons: r.persons,
      updatedAt: r.updatedAt.toISOString(), ...lockInfo(r),
    })),
  };
}

/** Parses the ?propertyId=&serviceDate= pair; 400s on failure. */
function parsePlanKey(req: { query: Record<string, unknown> }, res: {
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

foodPlanRouter.get("/order-plan", authenticate, authorize("FOOD_PLACE_ORDER", "view"), async (req, res) => {
  try {
    const key = parsePlanKey(req, res);
    if (!key) return;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(key.propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" });
      return;
    }
    const plan = await readPlan(key.propertyId, key.serviceDate);
    res.json({ success: true, data: { ...plan, canLock: canLock(req.user!.role as UserRole) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const patchPlanSchema = z.object({
  propertyId: zId,
  serviceDate: zYmd,
  meals: z.array(z.object({
    mealType: zMealType,
    residents: zCount.optional(),
    staff: zCount.optional(),
    /** Only honoured for FOOD_ORDER_LOCK holders; 403 otherwise. */
    lock: z.boolean().optional(),
    lockNote: zLockNote,
  })).optional(),
  dishes: z.array(z.object({
    mealType: zMealType,
    dishId: zId,
    persons: zCount.optional(),
    lock: z.boolean().optional(),
    lockNote: zLockNote,
  })).optional(),
}).passthrough();

foodPlanRouter.patch("/order-plan", authenticate, authorize("FOOD_PLACE_ORDER", "create"), async (req, res) => {
  try {
    if (!validateBody(patchPlanSchema, req, res)) return;
    const body = req.body as z.infer<typeof patchPlanSchema>;
    const mealCells = body.meals ?? [];
    const dishCells = body.dishes ?? [];
    const sd = ymdToIstDayStart(body.serviceDate);

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(body.propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" });
      return;
    }

    const mayLock = canLock(req.user!.role as UserRole);
    if (!mayLock && [...mealCells, ...dishCells].some((c) => c.lock !== undefined)) {
      res.status(403).json({ success: false, error: "You can't lock order quantities" });
      return;
    }

    // Reject the WHOLE request if any target cell is already locked and the
    // caller can't lock — a partial write would leave the client showing a
    // number the server never accepted.
    if (!mayLock) {
      const current = await readPlan(body.propertyId, sd);
      const lockedMeals = new Set(current.meals.filter((m) => m.isLocked).map((m) => m.mealType));
      const lockedDishes = new Set(
        current.dishes.filter((d) => d.isLocked).map((d) => `${d.mealType}:${d.dishId}`),
      );
      const blocked = [
        ...mealCells.filter((c) => lockedMeals.has(c.mealType)).map((c) => c.mealType),
        ...dishCells.filter((c) => lockedDishes.has(`${c.mealType}:${c.dishId}`))
          .map((c) => `${c.mealType}:${c.dishId}`),
      ];
      if (blocked.length) {
        res.status(403).json({
          success: false,
          error: "Some quantities were locked by ops excellence",
          details: { locked: blocked },
        });
        return;
      }
    }

    const now = new Date();
    const uid = req.user!.id;
    /** Lock columns only move when the caller explicitly passes `lock`. */
    const lockPatch = (c: { lock?: boolean; lockNote?: string | null }) =>
      c.lock === undefined ? {} : c.lock
        ? { isLocked: true, lockNote: c.lockNote ?? null, lockedByUserId: uid, lockedAt: now }
        : { isLocked: false, lockNote: null, lockedByUserId: null, lockedAt: null };

    for (const c of mealCells) {
      await db.insert(foodOrderPlanMealsTable).values({
        id: newId(),
        propertyId: body.propertyId,
        serviceDate: sd,
        mealType: c.mealType,
        residents: c.residents ?? 0,
        staff: c.staff ?? 0,
        updatedByUserId: uid,
        updatedAt: now,
        ...lockPatch(c),
      }).onConflictDoUpdate({
        target: [
          foodOrderPlanMealsTable.propertyId,
          foodOrderPlanMealsTable.serviceDate,
          foodOrderPlanMealsTable.mealType,
        ],
        set: {
          ...(c.residents !== undefined ? { residents: c.residents } : {}),
          ...(c.staff !== undefined ? { staff: c.staff } : {}),
          updatedByUserId: uid,
          updatedAt: now,
          ...lockPatch(c),
        },
      });
    }

    for (const c of dishCells) {
      await db.insert(foodOrderPlanDishesTable).values({
        id: newId(),
        propertyId: body.propertyId,
        serviceDate: sd,
        mealType: c.mealType,
        dishId: c.dishId,
        persons: c.persons ?? 0,
        updatedByUserId: uid,
        updatedAt: now,
        ...lockPatch(c),
      }).onConflictDoUpdate({
        target: [
          foodOrderPlanDishesTable.propertyId,
          foodOrderPlanDishesTable.serviceDate,
          foodOrderPlanDishesTable.mealType,
          foodOrderPlanDishesTable.dishId,
        ],
        set: {
          ...(c.persons !== undefined ? { persons: c.persons } : {}),
          updatedByUserId: uid,
          updatedAt: now,
          ...lockPatch(c),
        },
      });
    }

    await sweepStalePlans();

    // Return the refreshed plan so the client re-syncs against the server's
    // truth rather than trusting its own optimistic state.
    const plan = await readPlan(body.propertyId, sd);
    res.json({ success: true, data: { ...plan, canLock: mayLock } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

const unlockSchema = z.object({
  propertyId: zId,
  serviceDate: zYmd,
  /** Omit both to clear every lock on the day. */
  mealType: zMealType.optional(),
  dishId: zId.optional(),
}).passthrough();

foodPlanRouter.delete("/order-plan/locks", authenticate, authorize("FOOD_ORDER_LOCK", "edit"), async (req, res) => {
  try {
    if (!validateBody(unlockSchema, req, res)) return;
    const body = req.body as z.infer<typeof unlockSchema>;
    const sd = ymdToIstDayStart(body.serviceDate);

    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(body.propertyId, ids)) {
      res.status(403).json({ success: false, error: "Property not accessible" });
      return;
    }

    const cleared = { isLocked: false, lockNote: null, lockedByUserId: null, lockedAt: null };

    // A dishId narrows to that one dish; a bare mealType clears the meal's
    // headcount and every dish in it; neither clears the whole day.
    if (!body.dishId) {
      await db.update(foodOrderPlanMealsTable).set(cleared).where(and(
        eq(foodOrderPlanMealsTable.propertyId, body.propertyId),
        eq(foodOrderPlanMealsTable.serviceDate, sd),
        ...(body.mealType ? [eq(foodOrderPlanMealsTable.mealType, body.mealType)] : []),
      ));
    }
    await db.update(foodOrderPlanDishesTable).set(cleared).where(and(
      eq(foodOrderPlanDishesTable.propertyId, body.propertyId),
      eq(foodOrderPlanDishesTable.serviceDate, sd),
      ...(body.mealType ? [eq(foodOrderPlanDishesTable.mealType, body.mealType)] : []),
      ...(body.dishId ? [eq(foodOrderPlanDishesTable.dishId, body.dishId)] : []),
    ));

    const plan = await readPlan(body.propertyId, sd);
    res.json({ success: true, data: { ...plan, canLock: true } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default foodPlanRouter;
export { readPlan, type MealType };
