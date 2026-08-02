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
} from "@workspace/db";
import { eq, sql, ilike, and, gte, lte, desc, inArray } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

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
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.put("/:id", authenticate, authorize("RECIPES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["name", "category", "mealType", "ingredients", "method", "photoUrl", "allergens", "isVeg", "isActive"]);
    const [row] = await db.update(recipesTable).set({ ...body, updatedAt: new Date() }).where(eq(recipesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.delete("/:id", authenticate, authorize("RECIPES", "delete"), async (req, res) => {
  try {
    await db.delete(recipesTable).where(eq(recipesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// recipe feedback (rolling 4-week trend)
recipesRouter.get("/:id/feedback", authenticate, authorize("RECIPES", "view"), async (req, res) => {
  try {
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
    const rows = await db.select().from(recipeFeedbackTable)
      .where(and(eq(recipeFeedbackTable.recipeId, req.params["id"]!), gte(recipeFeedbackTable.createdAt, fourWeeksAgo)))
      .orderBy(desc(recipeFeedbackTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recipesRouter.post("/:id/feedback", authenticate, authorize("RECIPES", "edit"), async (req, res) => {
  try {
    const { propertyId, rating, comment, weekStart } = req.body;
    const [row] = await db.insert(recipeFeedbackTable).values({
      id: newId(),
      recipeId: req.params["id"]!,
      propertyId,
      rating,
      comment,
      weekStart: weekStart ? new Date(weekStart) : null,
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
    const where = propertyId ? eq(menuPlansTable.propertyId, propertyId) : undefined;
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
    const [row] = await db.insert(menuPlansTable).values({
      id: newId(),
      propertyId: body.propertyId,
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
    const body = pick(req.body, ["propertyId", "weekStart", "slots", "status"]) as Record<string, unknown>;
    if (body["weekStart"]) body["weekStart"] = new Date(body["weekStart"] as string);
    const [row] = await db.update(menuPlansTable).set({ ...body, updatedAt: new Date() }).where(eq(menuPlansTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

menuPlansRouter.post("/:id/publish", authenticate, authorize("MENU_PLANNING", "edit"), async (req, res) => {
  try {
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
    const [row] = await db.insert(menuPlansTable).values({
      id: newId(),
      propertyId: propertyId || src.propertyId,
      weekStart: new Date(weekStart),
      slots: src.slots,
      status: "DRAFT",
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// generate a procurement indent from menu × headcount
menuPlansRouter.post("/:id/generate-indent", authenticate, authorize("MENU_PLANNING", "edit"), async (req, res) => {
  try {
    const [plan] = await db.select().from(menuPlansTable).where(eq(menuPlansTable.id, req.params["id"]!));
    if (!plan) { res.status(404).json({ success: false, error: "Menu plan not found" }); return; }

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
    const items = Object.values(totals).map((t) => ({ name: t.name, unit: t.unit, quantity: Math.ceil(t.quantity * 10) / 10, estimatedCost: 0 }));

    // generate IND-XXXXX
    const [{ max }] = await db.select({ max: sql<string>`COALESCE(MAX(${indentsTable.indentNumber}), 'IND-01000')` }).from(indentsTable);
    const next = parseInt(String(max).replace("IND-", "")) + 1;
    const indentNumber = `IND-${String(next).padStart(5, "0")}`;

    const [indent] = await db.insert(indentsTable).values({
      id: newId(),
      indentNumber,
      propertyId: plan.propertyId,
      department: "KITCHEN",
      createdBy: req.user!.id,
      items,
      totalEstimatedValue: "0",
      status: "DRAFT",
      purpose: `Auto-generated from menu plan week ${plan.weekStart.toISOString().slice(0, 10)} × ${headcount} residents`,
      updatedAt: new Date(),
    }).returning();

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
    const conds = [];
    if (propertyId) conds.push(eq(dailyProductionTable.propertyId, propertyId));
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
    const conds = [gte(recipeFeedbackTable.createdAt, fourWeeksAgo)];
    if (propertyId) conds.push(eq(recipeFeedbackTable.propertyId, propertyId));
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
    const conds = [gte(dailyProductionTable.date, sixWeeksAgo)];
    if (propertyId) conds.push(eq(dailyProductionTable.propertyId, propertyId));
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
    const conds = [];
    if (propertyId) conds.push(eq(menuPlansTable.propertyId, propertyId));
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
