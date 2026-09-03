import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  residentsTable, usersTable, roomsTable,
  dishesTable, ingredientsTable, dishIngredientsTable, foodBrandsTable,
  dishSideOptionsTable, foodMenuRotationTable, kitchensTable,
  PREPARATIONS,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { assertCanAssignRole, assertPropertyAccess, scopedPropertyId } from "../lib/authz.js";
import {
  dishRowSchema, ingredientRowSchema, menuRowSchema, normalizeToken, splitList,
} from "../lib/bulk-food-rows.js";
import {
  assertKitchenAccess, collectDishIds, dishesMissingPortionRule,
  ingredientClashError, resolveCompositionRule,
} from "../lib/food-service.js";
import { newId } from "../lib/id.js";
import { isKycGateEnabled } from "./kyc-esign.js";

const router = Router();

/** Render typed authz errors (e.g. assertPropertyAccess -> 403) with their
 *  intended status instead of letting the generic catch mask them as 500. */
function sendAuthzError(err: unknown, res: import("express").Response): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") {
    const message = (err as { message?: string }).message || "Forbidden";
    res.status(status).json({ success: false, error: message });
    return true;
  }
  return false;
}

// ── Row schemas (mirror the single-create handlers) ─────────────────────────
// Errors are reported with a 0-BASED `index` into the submitted `rows` array.

const dateLike = z.union([z.string(), z.number(), z.coerce.date()]);

/** Mirrors POST /api/residents required + optional fields. roomNo is a
 *  human-readable room number resolved to a roomId within the property. */
const residentRowSchema = z.object({
  name: z.string().min(1, "name is required"),
  email: z.string().min(1, "email is required"),
  phone: z.string().min(1, "phone is required"),
  propertyId: z.string().min(1, "propertyId is required"),
  roomId: z.string().nullish(),
  roomNo: z.union([z.string(), z.number()]).nullish(),
  dob: dateLike.nullish(),
  gender: z.string().nullish(),
  college: z.string().nullish(),
  course: z.string().nullish(),
  parentName: z.string().nullish(),
  parentPhone: z.string().nullish(),
  parentEmail: z.string().nullish(),
  dietaryPref: z.array(z.string()).nullish(),
  allergies: z.array(z.string()).nullish(),
  checkInDate: dateLike.nullish(),
  checkOutDate: dateLike.nullish(),
  planType: z.string().nullish(),
  monthlyRent: z.coerce.number().nullish(),
  securityDeposit: z.coerce.number().nullish(),
  status: z.enum(["ACTIVE", "CHECKED_OUT", "NOTICE_PERIOD"]).nullish(),
});

/** Mirrors POST /api/users. propertyId is required when role is a
 *  property-bound role (UNIT_LEAD / WARDEN). */
const userRowSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    email: z.string().min(1, "email is required"),
    role: z.string().min(1, "role is required"),
    propertyId: z.string().nullish(),
    username: z.string().nullish(),
    designation: z.string().nullish(),
    phone: z.string().nullish(),
    password: z.string().nullish(),
    isActive: z.coerce.boolean().nullish(),
  })
  .refine(
    (r) => !(["UNIT_LEAD", "WARDEN"].includes(r.role) && !r.propertyId),
    { message: "propertyId is required for UNIT_LEAD/WARDEN", path: ["propertyId"] },
  );

type RowError = { index: number; message: string };

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue ? issue.message : "Invalid row";
}

const TEMP_PASSWORD = "TempPass@123";

// ── POST /api/bulk/:resource ────────────────────────────────────────────────
// resource ∈ { residents, users, dishes, ingredients }.
// Body: { rows: [...], dryRun?: boolean }.
//   dryRun === true  -> validate only, never write: { total, valid, invalid, errors }
//   dryRun falsey    -> write, in one of two modes:
//
// residents/users are ALL-OR-NOTHING: any invalid row => 422 and nothing is
// inserted. dishes/ingredients are PARTIAL — invalid rows are skipped and the
// valid ones still land ({ inserted, updated, skipped, errors }), because the
// dry-run response the preview renders already named every bad row and why. The
// dry-run flags which mode applies with `partial: true`, so the dialog knows
// whether it may offer a commit while errors are on screen.
router.post(
  "/:resource",
  authenticate,
  (req, res, next) => {
    const resource = req.params["resource"];
    if (resource === "residents") return authorize("RESIDENTS", "create")(req, res, next);
    if (resource === "users") return authorize("USERS", "create")(req, res, next);
    // The catalogue tabs are gated separately from the rest of Service Set.
    if (resource === "dishes" || resource === "ingredients") {
      return authorize("FOOD_CATALOGUE", "create")(req, res, next);
    }
    // A menu import REPLACES the slots it names — an edit, not a create.
    if (resource === "menu") return authorize("FOOD_SETTINGS", "edit")(req, res, next);
    res.status(404).json({ success: false, error: "Unknown bulk resource" });
  },
  async (req, res) => {
    try {
      const resource = req.params["resource"];
      const body = req.body ?? {};
      const rows: unknown = body.rows;
      const dryRun = body.dryRun === true;
      if (!Array.isArray(rows)) {
        res.status(400).json({ success: false, error: "rows must be an array" });
        return;
      }
      const total = rows.length;

      if (resource === "residents") {
        await handleResidents(req, res, rows, dryRun, total);
        return;
      }
      if (resource === "ingredients") {
        await handleIngredients(res, rows, dryRun, total);
        return;
      }
      if (resource === "dishes") {
        await handleDishes(res, rows, dryRun, total);
        return;
      }
      if (resource === "menu") {
        await handleMenu(req, res, rows, dryRun, total);
        return;
      }
      // resource === "users"
      await handleUsers(req, res, rows, dryRun, total);
    } catch (err) {
      if (sendAuthzError(err, res)) return;
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ── Residents ───────────────────────────────────────────────────────────────
async function handleResidents(
  req: import("express").Request,
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const scope = scopedPropertyId(req);
  const kycGate = await isKycGateEnabled();

  type Prepared = z.infer<typeof residentRowSchema>;
  const errors: RowError[] = [];
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i++) {
    const parsed = residentRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;
    // Property scoping mirrors POST /api/residents: a scoped caller's rows are
    // forced to their own propertyId; reject any row aimed at another property.
    if (scope) {
      if (row.propertyId && row.propertyId !== scope) {
        errors.push({ index: i, message: "Outside your property scope" });
        continue;
      }
      row.propertyId = scope;
    } else {
      try {
        assertPropertyAccess(req, row.propertyId);
      } catch (err) {
        errors.push({ index: i, message: (err as { message?: string }).message || "Outside your property scope" });
        continue;
      }
    }
    // Mirror the KYC activation gate from the single-create handler.
    const requestedStatus = row.status || "ACTIVE";
    if (requestedStatus === "ACTIVE" && kycGate) {
      errors.push({
        index: i,
        message: "KYC gate is enabled: create with status NOTICE_PERIOD or CHECKED_OUT, then complete KYC + e-sign before activating",
      });
      continue;
    }
    prepared.push(row);
  }

  if (dryRun) {
    res.json({
      success: true,
      data: { total, valid: prepared.length, invalid: errors.length, errors },
    });
    return;
  }

  if (errors.length > 0) {
    res.status(422).json({ success: true, data: { total, inserted: 0, errors } });
    return;
  }

  // All rows valid: insert atomically. roomNo (when given without roomId) is
  // resolved to a roomId by number within the resident's property.
  const roomCache = new Map<string, string | null>();
  async function resolveRoomId(
    tx: typeof db,
    propertyId: string,
    roomId: string | null | undefined,
    roomNo: string | number | null | undefined,
  ): Promise<string | null | undefined> {
    if (roomId) return roomId;
    if (roomNo == null || roomNo === "") return undefined;
    const key = `${propertyId}:${roomNo}`;
    if (roomCache.has(key)) return roomCache.get(key)!;
    const [room] = await tx
      .select({ id: roomsTable.id })
      .from(roomsTable)
      .where(and(eq(roomsTable.propertyId, propertyId), eq(roomsTable.number, String(roomNo))));
    const resolved = room?.id ?? null;
    roomCache.set(key, resolved);
    return resolved ?? undefined;
  }

  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const row of prepared) {
      const resolvedRoomId = await resolveRoomId(tx as unknown as typeof db, row.propertyId, row.roomId, row.roomNo);
      await tx.insert(residentsTable).values({
        id: newId(),
        propertyId: row.propertyId,
        roomId: resolvedRoomId ?? undefined,
        name: row.name,
        email: row.email,
        phone: row.phone,
        dob: row.dob ? new Date(row.dob) : undefined,
        gender: row.gender ?? undefined,
        college: row.college ?? undefined,
        course: row.course ?? undefined,
        parentName: row.parentName ?? undefined,
        parentPhone: row.parentPhone ?? undefined,
        parentEmail: row.parentEmail ?? undefined,
        dietaryPref: row.dietaryPref ?? [],
        allergies: row.allergies ?? [],
        checkInDate: row.checkInDate ? new Date(row.checkInDate) : undefined,
        checkOutDate: row.checkOutDate ? new Date(row.checkOutDate) : undefined,
        planType: row.planType ?? undefined,
        monthlyRent: row.monthlyRent != null ? row.monthlyRent.toString() : undefined,
        securityDeposit: row.securityDeposit != null ? row.securityDeposit.toString() : undefined,
        status: row.status || "ACTIVE",
        updatedAt: new Date(),
      });
      inserted++;
    }
  });

  res.json({ success: true, data: { total, inserted, errors: [] } });
}

// ── Users ────────────────────────────────────────────────────────────────────
async function handleUsers(
  req: import("express").Request,
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const callerRole = req.user!.role;

  type Prepared = z.infer<typeof userRowSchema>;
  const errors: RowError[] = [];
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i++) {
    const parsed = userRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;
    // Mirror the single-create role-rank guard (anti privilege-escalation).
    try {
      assertCanAssignRole(callerRole, row.role);
    } catch (err) {
      errors.push({ index: i, message: (err as { message?: string }).message || "Forbidden role assignment" });
      continue;
    }
    prepared.push(row);
  }

  if (dryRun) {
    res.json({
      success: true,
      data: { total, valid: prepared.length, invalid: errors.length, errors },
    });
    return;
  }

  if (errors.length > 0) {
    res.status(422).json({ success: true, data: { total, inserted: 0, errors } });
    return;
  }

  // Pre-hash passwords (bcrypt is async) before opening the transaction.
  const withHashes = await Promise.all(
    prepared.map(async (row) => ({
      row,
      passwordHash: await bcrypt.hash(row.password || TEMP_PASSWORD, 12),
    })),
  );

  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const { row, passwordHash } of withHashes) {
      await tx.insert(usersTable).values({
        id: newId(),
        name: row.name,
        email: row.email,
        username: row.username ?? undefined,
        designation: row.designation ?? undefined,
        phone: row.phone ?? undefined,
        role: row.role as typeof usersTable.$inferInsert.role,
        propertyId: row.propertyId ?? undefined,
        isActive: row.isActive ?? undefined,
        passwordHash,
        updatedAt: new Date(),
      });
      inserted++;
    }
  });

  res.json({ success: true, data: { total, inserted, errors: [] } });
}

// ── Ingredients ──────────────────────────────────────────────────────────────
// Org-wide master data: no property scoping, and FOOD_SETTINGS/create is the
// only gate (mirrors POST /api/food/ingredients).
//
// Matched on NAME, which is therefore the one field a sheet can't change — a
// renamed row reads as a new ingredient. Rename in the drawer instead.
async function handleIngredients(
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  type Prepared = z.infer<typeof ingredientRowSchema> & { existingId: string | null; index: number };
  const errors: RowError[] = [];
  const prepared: Prepared[] = [];

  const existingByName = new Map(
    (await db.select({ id: ingredientsTable.id, name: ingredientsTable.name }).from(ingredientsTable))
      .map((r) => [r.name.trim().toLowerCase(), r.id] as const),
  );
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const parsed = ingredientRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;
    const key = row.name.toLowerCase();
    // One file can't hold two rows for the same ingredient — which of them wins
    // would be an accident of ordering.
    if (seen.has(key)) {
      errors.push({ index: i, message: `"${row.name}" appears more than once in this file` });
      continue;
    }
    seen.add(key);
    prepared.push({ ...row, existingId: existingByName.get(key) ?? null, index: i });
  }

  if (dryRun) {
    res.json({
      success: true,
      data: {
        total,
        valid: prepared.length,
        invalid: errors.length,
        errors,
        updates: prepared.filter((p) => p.existingId).map((p) => p.index),
        partial: true,
      },
    });
    return;
  }

  // Invalid rows are SKIPPED, not fatal — the dry-run preview named each one and
  // why before the user committed. The valid rows still share one transaction,
  // so a failure mid-write can't leave half of them applied.
  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const row of prepared) {
      if (row.existingId) {
        // A blank cell means "leave this as it is", so an edited export only
        // changes the columns it actually filled in.
        await tx.update(ingredientsTable)
          .set({
            unit: row.unit,
            ...(row.isActive === undefined ? {} : { isActive: row.isActive }),
            updatedAt: new Date(),
          })
          .where(eq(ingredientsTable.id, row.existingId));
        updated++;
        continue;
      }
      await tx.insert(ingredientsTable).values({
        id: newId(),
        name: row.name,
        unit: row.unit,
        isActive: row.isActive ?? true,
        updatedAt: new Date(),
      });
      inserted++;
    }
  });

  res.json({ success: true, data: { total, inserted, updated, skipped: errors.length, errors } });
}

// ── Dishes ───────────────────────────────────────────────────────────────────
// Matched on NAME + COURSE, so those two are what a sheet can't change — edit
// either and the row reads as a new dish. Side options aren't in the template
// and are never touched by an import.
async function handleDishes(
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const errors: RowError[] = [];
  const prepared: Array<
    typeof dishesTable.$inferInsert & { ingredientIds: string[] | null; existingId: string | null; index: number }
  > = [];

  // Three lookups read once for the whole batch: brand codes and ingredient
  // names are resolved per row, and existing dishes decide insert vs update.
  const [brandRows, ingredientRows, dishRows] = await Promise.all([
    db.select({ code: foodBrandsTable.code }).from(foodBrandsTable).where(eq(foodBrandsTable.isActive, true)),
    db.select({ id: ingredientsTable.id, name: ingredientsTable.name }).from(ingredientsTable),
    db.select({ id: dishesTable.id, name: dishesTable.name, component: dishesTable.component }).from(dishesTable),
  ]);
  const brandByCode = new Map(brandRows.map((b) => [b.code.toLowerCase(), b.code]));
  const allBrandCodes = brandRows.map((b) => b.code);
  const ingredientByName = new Map(ingredientRows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  // A dish is identified by name + course: two rows both called "Rice" are the
  // same dish only if they are the same course.
  const dishKey = (name: string, component: string) => `${name.trim().toLowerCase()}|${component}`;
  const existingById = new Map(dishRows.map((d) => [dishKey(d.name, d.component), d.id] as const));
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const parsed = dishRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;

    const brands: string[] = [];
    const unknownBrands: string[] = [];
    for (const cell of splitList(row.brands)) {
      const code = brandByCode.get(cell.toLowerCase());
      if (code) brands.push(code);
      else unknownBrands.push(cell);
    }
    if (unknownBrands.length) {
      errors.push({ index: i, message: `unknown brand(s): ${unknownBrands.join(", ")}` });
      continue;
    }

    const preparations = splitList(row.preparations).map(normalizeToken);
    const badPreps = preparations.filter((p) => !(PREPARATIONS as readonly string[]).includes(p));
    if (badPreps.length) {
      errors.push({
        index: i,
        message: `preparation must be one of ${PREPARATIONS.join(", ")} (got ${badPreps.join(", ")})`,
      });
      continue;
    }

    // Ingredients are given by name — an id would mean nothing to whoever fills
    // in the sheet. An unknown name is an error rather than a silent drop:
    // importing a dish minus half its ingredients breaks the clash check.
    const ingredientCells = splitList(row.ingredients);
    const ingredientIds: string[] = [];
    const unknownIngredients: string[] = [];
    for (const cell of ingredientCells) {
      const id = ingredientByName.get(cell.toLowerCase());
      if (!id) unknownIngredients.push(cell);
      else if (!ingredientIds.includes(id)) ingredientIds.push(id);
    }
    if (unknownIngredients.length) {
      errors.push({
        index: i,
        message: `unknown ingredient(s): ${unknownIngredients.join(", ")} — add them under Ingredients first`,
      });
      continue;
    }

    const key = dishKey(row.name, row.component);
    // One file can't hold two rows for the same dish — which of them wins would
    // be an accident of ordering.
    if (seen.has(key)) {
      errors.push({ index: i, message: `"${row.name}" appears more than once in this file` });
      continue;
    }
    seen.add(key);
    const existingId = existingById.get(key) ?? null;

    prepared.push({
      id: existingId ?? newId(),
      name: row.name,
      component: row.component,
      unit: row.unit,
      // A dish with no brand, or no preparation tag, is invisible to every plate
      // composer (both are filtered on). On a new dish, blank cells therefore
      // fall back to what the drawer defaults a new dish to rather than to an
      // empty list; on an existing one they leave the current list alone.
      brands: brands.length ? [...new Set(brands)] : existingId ? [] : allBrandCodes,
      preparations: preparations.length ? [...new Set(preparations)] : existingId ? [] : ["VEG"],
      photoUrl: row.photoUrl ?? null,
      // Left as the raw optional so a blank cell stays distinguishable from an
      // explicit false; the insert and update branches each resolve it.
      isQtyLocked: row.isQtyLocked,
      isActive: row.isActive,
      updatedAt: new Date(),
      // null (blank cell on an update) means "leave the ingredient list alone";
      // an empty array would mean "this dish has none".
      ingredientIds: existingId && !ingredientCells.length ? null : ingredientIds,
      existingId,
      index: i,
    });
  }

  if (dryRun) {
    res.json({
      success: true,
      data: {
        total,
        valid: prepared.length,
        invalid: errors.length,
        errors,
        updates: prepared.filter((p) => p.existingId).map((p) => p.index),
        partial: true,
      },
    });
    return;
  }

  // Invalid rows are SKIPPED, not fatal — the dry-run preview named each one and
  // why before the user committed. The valid rows still share one transaction,
  // so a failure mid-write can't leave half of them applied.
  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const { ingredientIds, existingId, index: _index, ...dish } of prepared) {
      if (existingId) {
        // A blank cell means "leave this as it is", so an edited export only
        // changes the columns it actually filled in. Side options are absent
        // from the sheet entirely and survive untouched.
        await tx.update(dishesTable)
          .set({
            unit: dish.unit,
            ...(dish.brands?.length ? { brands: dish.brands } : {}),
            ...(dish.preparations?.length ? { preparations: dish.preparations } : {}),
            ...(dish.photoUrl == null ? {} : { photoUrl: dish.photoUrl }),
            // The two lock columns move together — see normalizeQtyLock in
            // routes/food.ts, the other write path that sets them.
            ...(dish.isQtyLocked === undefined
              ? {}
              : { isQtyLocked: dish.isQtyLocked, lockedPersons: dish.isQtyLocked ? 0 : null }),
            ...(dish.isActive === undefined ? {} : { isActive: dish.isActive }),
            updatedAt: new Date(),
          })
          .where(eq(dishesTable.id, existingId));
        updated++;
      } else {
        await tx.insert(dishesTable).values({
          ...dish,
          isQtyLocked: dish.isQtyLocked ?? false,
          lockedPersons: dish.isQtyLocked ? 0 : null,
          isActive: dish.isActive ?? true,
        });
        inserted++;
      }

      if (ingredientIds) {
        // Replace rather than append: the sheet's list is the whole list.
        if (existingId) {
          await tx.delete(dishIngredientsTable).where(eq(dishIngredientsTable.dishId, existingId));
        }
        if (ingredientIds.length) {
          await tx.insert(dishIngredientsTable).values(
            ingredientIds.map((ingredientId) => ({
              id: newId(),
              dishId: dish.id,
              ingredientId,
              updatedAt: new Date(),
            })),
          );
        }
      }
    }
  });

  res.json({ success: true, data: { total, inserted, updated, skipped: errors.length, errors } });
}

// ── Menu rotation ────────────────────────────────────────────────────────────
/**
 * One row per dish; rows are grouped back into (kitchen, brand, week, day, meal)
 * slots and each named slot is REPLACED wholesale — the same write the plate
 * composer performs (PUT /food/menu-rotation/slot). Slots the file does not
 * name are untouched.
 *
 * Wholesale is not a choice: a slot is a plate validated as a unit (its
 * composition rule, its portion rules, its shared-ingredient check), so it
 * cannot be merged row by row. That is also why a single bad row skips its
 * WHOLE slot rather than just itself — importing the remainder would silently
 * serve a plate the user never described.
 */
async function handleMenu(
  req: import("express").Request,
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const errors: RowError[] = [];
  /** A parsed row that has cleared everything checkable without its slot-mates. */
  type Line = {
    index: number; kitchenId: string; brand: string; week: number; day: number;
    meal: string; dishId: string; slotLabel: string | null; sideIds: string[];
  };
  const lines: Line[] = [];
  /** index -> slot key, recorded as soon as the slot is identifiable. A row whose
   *  kitchen/brand/day/meal is itself unreadable names no slot, so it can only
   *  fail on its own account. */
  const rowSlot = new Map<number, string>();

  const [kitchenRows, brandRows, dishRows, sideRows] = await Promise.all([
    db.select({ id: kitchensTable.id, name: kitchensTable.name, code: kitchensTable.code }).from(kitchensTable),
    db.select({ code: foodBrandsTable.code }).from(foodBrandsTable).where(eq(foodBrandsTable.isActive, true)),
    db.select({ id: dishesTable.id, name: dishesTable.name }).from(dishesTable).where(eq(dishesTable.isActive, true)),
    db.select({ dishId: dishSideOptionsTable.dishId, sideDishId: dishSideOptionsTable.sideDishId }).from(dishSideOptionsTable),
  ]);

  // Kitchens are named or coded in the sheet; both resolve.
  const kitchenByKey = new Map<string, string>();
  for (const k of kitchenRows) {
    kitchenByKey.set(k.name.trim().toLowerCase(), k.id);
    kitchenByKey.set(k.code.trim().toLowerCase(), k.id);
  }
  const brandByCode = new Map(brandRows.map((b) => [b.code.toLowerCase(), b.code]));
  // A name can belong to more than one dish (same name, different course), and
  // the sheet gives only a name — so an ambiguous one is an error, not a guess.
  const dishIdsByName = new Map<string, string[]>();
  for (const d of dishRows) {
    const k = d.name.trim().toLowerCase();
    dishIdsByName.set(k, [...(dishIdsByName.get(k) ?? []), d.id]);
  }
  const sideOptions = new Map<string, Set<string>>();
  for (const s of sideRows) {
    if (!sideOptions.has(s.dishId)) sideOptions.set(s.dishId, new Set());
    sideOptions.get(s.dishId)!.add(s.sideDishId);
  }

  /** Resolve one dish name to its id, or push the reason it can't be. */
  const resolveDish = (name: string, index: number, what: string): string | null => {
    const ids = dishIdsByName.get(name.toLowerCase());
    if (!ids?.length) {
      errors.push({ index, message: `unknown ${what}: ${name} — add it under Dishes first` });
      return null;
    }
    if (ids.length > 1) {
      errors.push({ index, message: `more than one dish is called "${name}" — rename one, or build this slot in the composer` });
      return null;
    }
    return ids[0]!;
  };

  for (let i = 0; i < rows.length; i++) {
    const parsed = menuRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;

    const kitchenId = kitchenByKey.get(row.kitchen.toLowerCase());
    if (!kitchenId) {
      errors.push({ index: i, message: `unknown kitchen: ${row.kitchen}` });
      continue;
    }
    const brand = brandByCode.get(row.brand.toLowerCase());
    if (!brand) {
      errors.push({ index: i, message: `unknown brand: ${row.brand}` });
      continue;
    }
    rowSlot.set(i, `${kitchenId}|${brand}|${row.week}|${row.day}|${row.meal}`);

    const dishId = resolveDish(row.dish, i, "dish");
    if (!dishId) continue;

    // A side must be one the dish is actually paired with: rotation sides are
    // pruned against dish_side_options whenever the dish is next saved, so an
    // unpaired one here would quietly disappear later.
    const sideIds: string[] = [];
    let sideFailed = false;
    for (const cell of splitList(row.sides)) {
      const sideId = resolveDish(cell, i, "side dish");
      if (!sideId) { sideFailed = true; break; }
      if (!sideOptions.get(dishId)?.has(sideId)) {
        errors.push({ index: i, message: `"${cell}" is not a side option of "${row.dish}" — pair them on the dish first` });
        sideFailed = true;
        break;
      }
      if (!sideIds.includes(sideId)) sideIds.push(sideId);
    }
    if (sideFailed) continue;

    lines.push({
      index: i, kitchenId, brand, week: row.week, day: row.day, meal: row.meal,
      dishId, slotLabel: row.slotLabel?.trim() || null, sideIds,
    });
  }

  // ── group into slots ──────────────────────────────────────────────────────
  const slots = new Map<string, Line[]>();
  for (const l of lines) {
    const key = rowSlot.get(l.index)!;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key)!.push(l);
  }

  // A row that failed above poisons its whole slot: the slot is written
  // wholesale, so importing the rest would serve a plate the file never
  // described. Its surviving slot-mates are told why they are being left out.
  const poisoned = new Set<string>();
  for (const e of errors) {
    const key = rowSlot.get(e.index);
    if (key) poisoned.add(key);
  }
  for (const key of poisoned) {
    for (const l of slots.get(key) ?? []) {
      errors.push({ index: l.index, message: "another row of this meal has an error — the whole meal is left unchanged" });
    }
  }

  // ── slot-level guards: exactly what PUT /menu-rotation/slot enforces ───────
  type Slot = { key: string; lines: Line[] };
  const writable: Slot[] = [];
  const kitchenChecked = new Map<string, string | null>(); // id -> failure message

  for (const [key, group] of slots) {
    if (poisoned.has(key)) continue;
    const first = group[0]!;
    const fail = (message: string) => {
      for (const l of group) errors.push({ index: l.index, message });
    };

    if (!kitchenChecked.has(first.kitchenId)) {
      try {
        await assertKitchenAccess(req.user!, first.kitchenId);
        kitchenChecked.set(first.kitchenId, null);
      } catch (err) {
        kitchenChecked.set(first.kitchenId, (err as { message?: string }).message || "Outside your kitchen scope");
      }
    }
    const scopeErr = kitchenChecked.get(first.kitchenId);
    if (scopeErr) { fail(scopeErr); continue; }

    const rule = await resolveCompositionRule(first.brand, first.meal, first.kitchenId);
    if (!rule?.slots.length) {
      fail(`no menu rule for ${first.meal.toLowerCase()} — define the plate under Menu Rules first`);
      continue;
    }

    const items = group.map((l) => ({ dishId: l.dishId, sideDishIds: l.sideIds }));
    const unpriced = await dishesMissingPortionRule(first.brand, first.meal, collectDishIds(items));
    if (unpriced.length) {
      fail(`no portion rule for ${first.meal.toLowerCase()}: ${unpriced.join(", ")} — set a portion per resident on the dish first`);
      continue;
    }

    const clash = await ingredientClashError(collectDishIds(items));
    if (clash) { fail(clash.error); continue; }

    writable.push({ key, lines: group });
  }

  errors.sort((a, b) => a.index - b.index);
  const writableRows = writable.reduce((n, s) => n + s.lines.length, 0);

  if (dryRun) {
    res.json({
      success: true,
      data: {
        total,
        valid: writableRows,
        invalid: errors.length,
        errors,
        // Every menu row rewrites its slot, so none of them is ever an "insert"
        // in the sense the preview means — they all replace what is there.
        updates: writable.flatMap((s) => s.lines.map((l) => l.index)),
        partial: true,
      },
    });
    return;
  }

  let updated = 0;
  await db.transaction(async (tx) => {
    for (const slot of writable) {
      const first = slot.lines[0]!;
      const where = and(
        eq(foodMenuRotationTable.kitchenId, first.kitchenId),
        eq(foodMenuRotationTable.brand, first.brand),
        eq(foodMenuRotationTable.rotationWeek, first.week),
        eq(foodMenuRotationTable.dayOfWeek, first.day),
        eq(foodMenuRotationTable.mealType, first.meal as never),
      );
      // Preserve each dish's seasonal window across the replace, as the slot
      // endpoint does — an import must not silently clear effectiveFrom/To.
      const existing = await tx.select({
        dishId: foodMenuRotationTable.dishId,
        effectiveFrom: foodMenuRotationTable.effectiveFrom,
        effectiveTo: foodMenuRotationTable.effectiveTo,
      }).from(foodMenuRotationTable).where(where);
      const effByDish = new Map(existing.map((e) => [e.dishId, e]));
      await tx.delete(foodMenuRotationTable).where(where);

      const now = new Date();
      const base = {
        kitchenId: first.kitchenId, brand: first.brand, rotationWeek: first.week,
        dayOfWeek: first.day, mealType: first.meal as never,
      };
      const parents = await tx.insert(foodMenuRotationTable).values(
        slot.lines.map((l, i) => ({
          id: newId(), ...base,
          dishId: l.dishId, slotLabel: l.slotLabel, sortOrder: i,
          effectiveFrom: effByDish.get(l.dishId)?.effectiveFrom ?? null,
          effectiveTo: effByDish.get(l.dishId)?.effectiveTo ?? null,
          isActive: true, updatedAt: now,
        })),
      ).returning();

      // Sides become ordinary rows tagged with their parent — the same shape the
      // composer writes, so every downstream consumer needs no special case.
      const sideValues = slot.lines.flatMap((l, i) =>
        l.sideIds.map((sideDishId, j) => ({
          id: newId(), ...base,
          dishId: sideDishId, slotLabel: null,
          sortOrder: (parents[i]?.sortOrder ?? i) * 100 + j + 1,
          parentRotationId: parents[i]!.id, isActive: true, updatedAt: now,
        })),
      );
      if (sideValues.length) await tx.insert(foodMenuRotationTable).values(sideValues);
      updated += slot.lines.length;
    }
  });

  res.json({
    success: true,
    data: { total, inserted: 0, updated, skipped: errors.length, errors },
  });
}

export default router;
