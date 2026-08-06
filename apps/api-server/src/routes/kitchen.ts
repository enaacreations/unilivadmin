import { Router } from "express";
import { db } from "@workspace/db";
import {
  recipesTable,
  menuPlansTable,
  dailyProductionTable,
  recipeFeedbackTable,
  propertiesTable,
  residentsTable,
  indentsTable,
  rateContractsTable,
} from "@workspace/db";
import { eq, sql, ilike, and, gte, lte, desc, inArray } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId, withUniqueRetry } from "../lib/id.js";
import { resolveAccessiblePropertyIds } from "../lib/food-service.js";
import { writeAuditLog } from "../lib/wallet-service.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Property scoping
 *
 * Recipes themselves are org-wide masters (no property_id), but every other
 * table this file touches — menu_plans, daily_production, recipe_feedback and
 * the indents it mints — is property-bound. `authorize()` is a role/module gate
 * only and performs no tenant check, and `scopedPropertyId` cannot help here
 * because KITCHEN_MANAGER and FNB_MANAGER are both ORG_WIDE_ROLES, so the food
 * module's own resolver is the one source of truth for "which properties may
 * this caller touch".
 * ──────────────────────────────────────────────────────────────────────────── */

/** True if a row's property is within the caller's accessible set (null = all). */
function isAccessible(propertyId: string, ids: string[] | null): boolean {
  return ids === null || ids.includes(propertyId);
}

/**
 * Restricts a property-bound table to the caller's accessible properties.
 * Same convention as scopeOrdersCondition: null = unrestricted, and an EMPTY
 * array matches nothing rather than everything — a role with no resolvable
 * scope must see zero rows, never the whole org.
 */
function scopePropertyCondition(column: AnyColumn, ids: string[] | null) {
  if (ids === null) return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}

/**
 * M17 — records one recipe master-data mutation.
 *
 * `recipes` is an ORG-WIDE master: it has no property column and no kitchen
 * column, so unlike every other table in this file there is nothing to scope on
 * — a recipe written here is a recipe the whole network cooks from. That is a
 * deliberate product decision, not a gap (permissions.ts: "recipe and menu
 * management belongs to F&B managers"), and RECIPES is a module a kitchen-scoped
 * FNB_MANAGER genuinely reaches through /recipes, so the authority stays.
 *
 * What was missing is the other half: an org-wide write with no tenant boundary
 * and no record of who made it. Deliberately the same shape as food-ops.ts's
 * `auditConfig` — fire-and-forget, because an audit-log failure must never fail
 * the mutation it records, and `before` on every UPDATE and DELETE, because
 * without the prior row the entry says only that something changed.
 */
function auditRecipe(
  req: any,
  action: "FOOD_CONFIG_CREATED" | "FOOD_CONFIG_UPDATED" | "FOOD_CONFIG_DELETED",
  entityId: string,
  changes: { before?: unknown; after?: unknown },
): void {
  void writeAuditLog(req.user!.id, action, "recipe", entityId, changes).catch(() => {});
}

export const recipesRouter: Router = Router();

recipesRouter.get("/", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const mealType = req.query["mealType"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const conds = [];
    if (search) conds.push(ilike(recipesTable.name, `%${search}%`));
    if (mealType) conds.push(eq(recipesTable.mealType, mealType));
    if (category) conds.push(eq(recipesTable.category, category));
    const where = conds.length ? and(...conds) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(recipesTable).where(where);
    const rows = await db.select().from(recipesTable).where(where).limit(limit).offset(offset).orderBy(recipesTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.get("/:id", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(recipesTable).where(eq(recipesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.post("/", authenticate, authorize("RECIPES", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["name", "category", "mealType", "ingredients", "method", "photoUrl", "allergens", "isVeg", "isActive"]);
    const [row] = await db.insert(recipesTable).values({
      id: newId(),
      name: body.name,
      category: body.category,
      mealType: body.mealType,
      ingredients: body.ingredients || [],
      method: body.method,
      photoUrl: body.photoUrl,
      allergens: body.allergens || [],
      isVeg: body.isVeg !== false,
      isActive: body.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    // M17: org-wide master write — see auditRecipe.
    auditRecipe(req, "FOOD_CONFIG_CREATED", row!.id, { after: row });
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.put("/:id", authenticate, authorize("RECIPES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["name", "category", "mealType", "ingredients", "method", "photoUrl", "allergens", "isVeg", "isActive"]);
    // M17: the real prior row, read before the write — `isActive:false` here
    // retires a recipe for the whole network, so "what did it look like before"
    // is the only thing that makes the entry answerable.
    const [before] = await db.select().from(recipesTable).where(eq(recipesTable.id, req.params["id"]!));
    const [row] = await db.update(recipesTable).set({ ...body, updatedAt: new Date() }).where(eq(recipesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    auditRecipe(req, "FOOD_CONFIG_UPDATED", row.id, { before, after: row });
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.delete("/:id", authenticate, authorize("RECIPES", "delete"), async (req, res) => {
  try {
    // M17: this is a HARD delete of an org-wide master — the row is gone, so the
    // audit entry is the only surviving copy. Read it first. (The response shape
    // is unchanged: a delete of an id that is not there still answers 200, and
    // simply has nothing to record.)
    const [before] = await db.delete(recipesTable).where(eq(recipesTable.id, req.params["id"]!)).returning();
    if (before) auditRecipe(req, "FOOD_CONFIG_DELETED", before.id, { before });
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// recipe feedback (rolling 4-week trend)
recipesRouter.get("/:id/feedback", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const ids = await resolveAccessiblePropertyIds(req.user!);
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
    const conds = [eq(recipeFeedbackTable.recipeId, req.params["id"]!), gte(recipeFeedbackTable.createdAt, fourWeeksAgo)];
    // Feedback carries a property; a caller only sees their own properties' ratings.
    const scope = scopePropertyCondition(recipeFeedbackTable.propertyId, ids);
    if (scope) conds.push(scope);
    const rows = await db.select().from(recipeFeedbackTable)
      .where(and(...conds))
      .orderBy(desc(recipeFeedbackTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Rating is a NOT NULL 1..5 on a table the analytics average over; the handler
// used to insert req.body verbatim, so any string/out-of-range value landed.
const feedbackSchema = z.object({
  propertyId: z.string().min(1).max(128),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(1000).nullish(),
  weekStart: z.coerce.date().nullish(),
});

recipesRouter.post("/:id/feedback", authenticate, authorize("RECIPES", "edit"), async (req, res) => {
  try {
    const p = feedbackSchema.safeParse(req.body);
    if (!p.success) { res.status(400).json({ success: false, error: "Invalid request", details: p.error.flatten() }); return; }
    const { propertyId, rating, comment, weekStart } = p.data;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const [row] = await db.insert(recipeFeedbackTable).values({
      id: newId(),
      recipeId: req.params["id"]!,
      propertyId,
      rating,
      comment: comment ?? null,
      weekStart: weekStart ?? null,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =====================================================
export const menuPlansRouter: Router = Router();

menuPlansRouter.get("/", authenticate, authorize("MENU_PLANNING", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (propertyId && !isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    // Scope is ANDed in, not used as a fallback: omitting ?propertyId must narrow
    // to the caller's properties, never widen to every property in the org.
    const conds = [];
    if (propertyId) conds.push(eq(menuPlansTable.propertyId, propertyId));
    const scope = scopePropertyCondition(menuPlansTable.propertyId, ids);
    if (scope) conds.push(scope);
    const where = conds.length ? and(...conds) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(menuPlansTable).where(where);
    const rows = await db.select().from(menuPlansTable).where(where).limit(limit).offset(offset).orderBy(desc(menuPlansTable.weekStart));
    res.json({ success: true, data: rows, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// fetch by property + weekStart (find or null)
menuPlansRouter.get("/by-week", authenticate, authorize("MENU_PLANNING", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string;
    const weekStart = req.query["weekStart"] as string;
    if (!propertyId || !weekStart) { res.status(400).json({ success: false, error: "propertyId and weekStart required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const ws = new Date(weekStart);
    const we = new Date(ws.getTime() + 86400000);
    const [row] = await db.select().from(menuPlansTable).where(and(
      eq(menuPlansTable.propertyId, propertyId),
      gte(menuPlansTable.weekStart, ws),
      lte(menuPlansTable.weekStart, we),
    ));
    res.json({ success: true, data: row || null });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

menuPlansRouter.post("/", authenticate, authorize("MENU_PLANNING", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["propertyId", "weekStart", "slots", "status"]);
    const propertyId = body.propertyId as string | undefined;
    if (!propertyId) { res.status(400).json({ success: false, error: "propertyId required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const [row] = await db.insert(menuPlansTable).values({
      id: newId(),
      propertyId,
      weekStart: new Date(body.weekStart as string),
      slots: body.slots || {},
      status: body.status || "DRAFT",
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

menuPlansRouter.put("/:id", authenticate, authorize("MENU_PLANNING", "edit"), async (req, res) => {
  try {
    // propertyId is deliberately NOT in the allow-list: an edit may change the
    // week's menu, never move the plan to a property the caller was checked against.
    const body = pick(req.body, ["weekStart", "slots", "status"]) as Record<string, unknown>;
    if (body["weekStart"]) body["weekStart"] = new Date(body["weekStart"] as string);
    const [plan] = await db.select().from(menuPlansTable).where(eq(menuPlansTable.id, req.params["id"]!));
    if (!plan) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(plan.propertyId, ids)) { res.status(403).json({ success: false, error: "Menu plan not accessible" }); return; }
    const [row] = await db.update(menuPlansTable).set({ ...body, updatedAt: new Date() }).where(eq(menuPlansTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

menuPlansRouter.post("/:id/publish", authenticate, authorize("MENU_PLANNING", "edit"), async (req, res) => {
  try {
    // Load-then-check: publishing keys on the path id alone, so the plan's own
    // property is the only thing that says whether this caller may publish it.
    const [plan] = await db.select().from(menuPlansTable).where(eq(menuPlansTable.id, req.params["id"]!));
    if (!plan) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(plan.propertyId, ids)) { res.status(403).json({ success: false, error: "Menu plan not accessible" }); return; }
    const [row] = await db.update(menuPlansTable).set({ status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() }).where(eq(menuPlansTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// copy a previous week's plan into a new draft for given (propertyId, newWeekStart)
menuPlansRouter.post("/copy", authenticate, authorize("MENU_PLANNING", "create"), async (req, res) => {
  try {
    const { sourcePlanId, propertyId, weekStart } = req.body;
    const [src] = await db.select().from(menuPlansTable).where(eq(menuPlansTable.id, sourcePlanId));
    if (!src) { res.status(404).json({ success: false, error: "Source plan not found" }); return; }
    // A copy is both a read of the source and a write to the target, so both ends
    // have to be in scope — otherwise the source is a cross-tenant menu leak.
    const targetPropertyId = (propertyId as string | undefined) || src.propertyId;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(src.propertyId, ids)) { res.status(403).json({ success: false, error: "Source plan not accessible" }); return; }
    if (!isAccessible(targetPropertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const [row] = await db.insert(menuPlansTable).values({
      id: newId(),
      propertyId: targetPropertyId,
      weekStart: new Date(weekStart),
      slots: src.slots,
      status: "DRAFT",
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * Estimated unit price for a generated indent line when no live rate contract
 * covers the item. Neither the recipe ingredient list nor the ingredient master
 * carries a price, so this zero is deliberate and visible (the line reads ₹0 for
 * procurement to fill in) rather than a silent default that quietly values a
 * whole indent — and any value-based approval on it — at nothing.
 */
const NO_RATE_CONTRACT_PRICE = 0;

/**
 * Next IND-XXXXX. Same MAX()+1 rule as POST /indents (procurement.ts) so both
 * writers stay on one sequence; indent_number is UNIQUE, so it must be recomputed
 * inside withUniqueRetry on every attempt.
 */
async function nextIndentNumber(): Promise<string> {
  const [row] = await db.select({ max: sql<string>`MAX(${indentsTable.indentNumber})` }).from(indentsTable);
  const next = row?.max ? parseInt(row.max.replace(/\D/g, ""), 10) + 1 : 1001;
  return `IND-${String(next).padStart(5, "0")}`;
}

/**
 * Currently-valid rate-contract prices, keyed "name|unit" and "name" (the
 * unit-less fallback), lowercased. The most recently agreed contract wins — the
 * ordering runs through createdAt and id as well, because several contracts for
 * the same item routinely share a validFrom and the price a generated indent
 * carries must not depend on row order.
 */
async function currentRates(): Promise<Map<string, number>> {
  const now = new Date();
  const rows = await db.select({ itemName: rateContractsTable.itemName, unit: rateContractsTable.unit, rate: rateContractsTable.rate })
    .from(rateContractsTable)
    .where(and(lte(rateContractsTable.validFrom, now), gte(rateContractsTable.validTo, now)))
    .orderBy(rateContractsTable.validFrom, rateContractsTable.createdAt, rateContractsTable.id);
  const map = new Map<string, number>();
  for (const r of rows) {
    const rate = Number(r.rate);
    if (!Number.isFinite(rate)) continue;
    const name = r.itemName.trim().toLowerCase();
    map.set(`${name}|${r.unit.trim().toLowerCase()}`, rate);
    map.set(name, rate);
  }
  return map;
}

// generate a procurement indent from menu × headcount.
// Gated on MENU_PLANNING:edit AND INDENTS:create — the two authorize() calls chain,
// so planning a menu never on its own mints a procurement document. KITCHEN_MANAGER
// and FNB_MANAGER both hold INDENTS create-only (permissions.ts) precisely so that
// minting one is a NAMED grant rather than a side effect of MENU_PLANNING:edit.
// If this ever 403s a role that should raise indents, widen the matrix — not this gate.
menuPlansRouter.post("/:id/generate-indent", authenticate, authorize("MENU_PLANNING", "edit"), authorize("INDENTS", "create"), async (req, res) => {
  try {
    const [plan] = await db.select().from(menuPlansTable).where(eq(menuPlansTable.id, req.params["id"]!));
    if (!plan) { res.status(404).json({ success: false, error: "Menu plan not found" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(plan.propertyId, ids)) { res.status(403).json({ success: false, error: "Menu plan not accessible" }); return; }

    // determine headcount: explicit body.headcount > active residents in property
    let headcount: number = req.body?.headcount;
    if (!headcount) {
      const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.propertyId, plan.propertyId), eq(residentsTable.status, "ACTIVE")));
      headcount = r?.count || 0;
    }
    if (!headcount) { res.status(400).json({ success: false, error: "Headcount is zero — pass body.headcount" }); return; }

    // collect ingredients from all recipes mentioned in slots
    const slots = (plan.slots || {}) as Record<string, string>;
    const slotRecipeIds = Object.values(slots).filter(Boolean) as string[];
    const uniqueIds = Array.from(new Set(slotRecipeIds));
    if (!uniqueIds.length) { res.status(400).json({ success: false, error: "Menu plan has no recipes" }); return; }
    const recipes = await db.select().from(recipesTable).where(inArray(recipesTable.id, uniqueIds));
    const recipeById = new Map(recipes.map((r) => [r.id, r]));

    // accumulate ingredient totals — count each occurrence in slots so a recipe used 3 times = 3x
    const totals: Record<string, { name: string; unit: string; quantity: number }> = {};
    for (const rid of slotRecipeIds) {
      const r = recipeById.get(rid);
      if (!r) continue;
      for (const ing of (r.ingredients || []) as Array<Record<string, unknown>>) {
        const name = String(ing["name"] || "");
        const unit = String(ing["unit"] || "");
        const qty = Number(ing["quantity"] || 0);
        if (!name) continue;
        const key = `${name.toLowerCase()}|${unit}`;
        if (!totals[key]) totals[key] = { name, unit, quantity: 0 };
        totals[key].quantity += qty * headcount;
      }
    }
    // Emit the shape procurement actually reads — { itemName, specification,
    // quantity, unit, estUnitPrice }. The old { name, estimatedCost } keys were
    // never read by POST/PUT /indents or the indent UI, so every generated line
    // arrived blank and every total was ₹0, all the way into the PO.
    const rates = await currentRates();
    const items = Object.values(totals).map((t) => {
      const name = t.name.trim().toLowerCase();
      const rate = rates.get(`${name}|${t.unit.trim().toLowerCase()}`) ?? rates.get(name) ?? NO_RATE_CONTRACT_PRICE;
      return {
        itemName: t.name,
        specification: "",
        quantity: Math.ceil(t.quantity * 10) / 10,
        unit: t.unit,
        estUnitPrice: rate,
      };
    });
    // Same reduce as POST /indents, so an untouched generated indent already
    // totals what procurement would recompute on the first edit.
    const total = items.reduce((s, it) => s + it.quantity * it.estUnitPrice, 0);
    const purpose = `Auto-generated from menu plan week ${plan.weekStart.toISOString().slice(0, 10)} × ${headcount} residents`;

    // Idempotent per (plan week, headcount): the UI button has no disable-after-success,
    // so a second click must return the existing draft rather than mint a duplicate.
    const [existing] = await db.select().from(indentsTable).where(and(
      eq(indentsTable.propertyId, plan.propertyId),
      eq(indentsTable.department, "KITCHEN"),
      eq(indentsTable.status, "DRAFT"),
      eq(indentsTable.purpose, purpose),
    ));
    if (existing) { res.json({ success: true, data: existing }); return; }

    // indent_number is UNIQUE and generated MAX()+1, so concurrent generation
    // collides; recompute inside the retry exactly as POST /indents does.
    const indent = await withUniqueRetry(async () => {
      const [r] = await db.insert(indentsTable).values({
        id: newId(),
        indentNumber: await nextIndentNumber(),
        propertyId: plan.propertyId,
        department: "KITCHEN",
        createdBy: req.user!.id,
        items,
        totalEstimatedValue: String(total),
        status: "DRAFT",
        purpose,
        updatedAt: new Date(),
      }).returning();
      return r;
    });

    res.status(201).json({ success: true, data: indent });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =====================================================
// Daily production
export const productionRouter: Router = Router();

productionRouter.get("/", authenticate, authorize("MENU_PLANNING", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const date = req.query["date"] as string | undefined;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (propertyId && !isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const conds = [];
    if (propertyId) conds.push(eq(dailyProductionTable.propertyId, propertyId));
    // Unfiltered means "all of MY properties", not "all properties".
    const scope = scopePropertyCondition(dailyProductionTable.propertyId, ids);
    if (scope) conds.push(scope);
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const e = new Date(d.getTime() + 86400000);
      conds.push(gte(dailyProductionTable.date, d));
      conds.push(lte(dailyProductionTable.date, e));
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(dailyProductionTable).where(where).orderBy(desc(dailyProductionTable.date)).limit(50);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// upsert today's record for a property
productionRouter.post("/", authenticate, authorize("MENU_PLANNING", "edit"), async (req, res) => {
  try {
    const { propertyId, date, dispatches, wastage, receivings } = req.body;
    if (!propertyId) { res.status(400).json({ success: false, error: "propertyId required" }); return; }
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (!isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const d = new Date(date || Date.now());
    d.setHours(0, 0, 0, 0);
    const e = new Date(d.getTime() + 86400000);
    const [existing] = await db.select().from(dailyProductionTable).where(and(
      eq(dailyProductionTable.propertyId, propertyId),
      gte(dailyProductionTable.date, d),
      lte(dailyProductionTable.date, e),
    ));
    if (existing) {
      const [row] = await db.update(dailyProductionTable).set({
        dispatches: dispatches ?? existing.dispatches,
        wastage: wastage ?? existing.wastage,
        receivings: receivings ?? existing.receivings,
        updatedAt: new Date(),
      }).where(eq(dailyProductionTable.id, existing.id)).returning();
      res.json({ success: true, data: row });
      return;
    }
    const [row] = await db.insert(dailyProductionTable).values({
      id: newId(),
      propertyId,
      date: d,
      dispatches: dispatches || [],
      wastage: wastage || [],
      receivings: receivings || [],
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =====================================================
// Kitchen analytics
export const kitchenAnalyticsRouter: Router = Router();

kitchenAnalyticsRouter.get("/feedback-trends", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (propertyId && !isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const conds = [gte(recipeFeedbackTable.createdAt, fourWeeksAgo)];
    if (propertyId) conds.push(eq(recipeFeedbackTable.propertyId, propertyId));
    // Analytics aggregate rows, so an unscoped query leaks other tenants' figures
    // just as surely as a list would.
    const scope = scopePropertyCondition(recipeFeedbackTable.propertyId, ids);
    if (scope) conds.push(scope);
    const rows = await db.select({
      recipeId: recipeFeedbackTable.recipeId,
      avgRating: sql<number>`AVG(${recipeFeedbackTable.rating})::float`,
      count: sql<number>`count(*)::int`,
    }).from(recipeFeedbackTable).where(and(...conds)).groupBy(recipeFeedbackTable.recipeId);
    const enriched = await Promise.all(rows.map(async (r) => {
      const [rc] = await db.select({ name: recipesTable.name }).from(recipesTable).where(eq(recipesTable.id, r.recipeId));
      return { recipeId: r.recipeId, recipeName: rc?.name || "Unknown", avgRating: Number(r.avgRating || 0), feedbackCount: r.count };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

kitchenAnalyticsRouter.get("/wastage-trends", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const sixWeeksAgo = new Date(Date.now() - 42 * 86400000);
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (propertyId && !isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const conds = [gte(dailyProductionTable.date, sixWeeksAgo)];
    if (propertyId) conds.push(eq(dailyProductionTable.propertyId, propertyId));
    const scope = scopePropertyCondition(dailyProductionTable.propertyId, ids);
    if (scope) conds.push(scope);
    const rows = await db.select().from(dailyProductionTable).where(and(...conds));
    // bucket by ISO week
    const buckets: Record<string, number> = {};
    for (const r of rows) {
      const w = new Date(r.date);
      const day = w.getDay();
      const monday = new Date(w);
      monday.setDate(w.getDate() - ((day + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      const key = monday.toISOString().slice(0, 10);
      const total = ((r.wastage || []) as Array<Record<string, unknown>>).reduce((s, w0) => s + Number(w0["quantity"] || 0), 0);
      buckets[key] = (buckets[key] || 0) + total;
    }
    const data = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, kg]) => ({ weekStart, kg: Math.round(kg * 100) / 100 }));
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

kitchenAnalyticsRouter.get("/menu-diversity", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const ids = await resolveAccessiblePropertyIds(req.user!);
    if (propertyId && !isAccessible(propertyId, ids)) { res.status(403).json({ success: false, error: "Property not accessible" }); return; }
    const conds = [];
    if (propertyId) conds.push(eq(menuPlansTable.propertyId, propertyId));
    const scope = scopePropertyCondition(menuPlansTable.propertyId, ids);
    if (scope) conds.push(scope);
    const plans = await db.select().from(menuPlansTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(menuPlansTable.weekStart)).limit(4);
    const recipeIds = new Set<string>();
    for (const p of plans) for (const r of Object.values((p.slots || {}) as Record<string, string>)) if (r) recipeIds.add(r);
    if (!recipeIds.size) { res.json({ success: true, data: { veg: 0, nonVeg: 0, special: 0, total: 0 } }); return; }
    const recipes = await db.select().from(recipesTable).where(sql`${recipesTable.id} = ANY(${Array.from(recipeIds)})`);
    let veg = 0, nonVeg = 0, special = 0;
    for (const r of recipes) {
      if ((r.allergens || []).length > 0) special++;
      if (r.isVeg) veg++; else nonVeg++;
    }
    res.json({ success: true, data: { veg, nonVeg, special, total: recipes.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

void propertiesTable;
