import { Router } from "express";
import { db } from "@workspace/db";
import { propertiesTable, residentsTable } from "@workspace/db";
import { eq, sql, ilike, or } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

const router = Router();

router.get("/", authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;

    const where = search ? or(ilike(propertiesTable.name, `%${search}%`), ilike(propertiesTable.city, `%${search}%`)) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(propertiesTable).where(where);
    const rows = await db.select().from(propertiesTable).where(where).limit(limit).offset(offset).orderBy(propertiesTable.createdAt);

    const occupiedMap: Record<string, number> = {};
    await Promise.all(
      rows.map(async (row) => {
        const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));
        occupiedMap[row.id] = r.count || 0;
      })
    );

    res.json({
      success: true,
      data: rows.map(p => ({ ...p, occupiedBeds: occupiedMap[p.id] || 0 })),
      meta: buildMeta(countResult.count, page, limit),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.insert(propertiesTable).values({
      id: newId(),
      name: body.name,
      address: body.address,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      lat: body.lat,
      lng: body.lng,
      totalBeds: body.totalBeds,
      status: body.status || "ACTIVE",
      portfolioType: body.portfolioType || "CO_LIVING",
      portfolioAttributes: body.portfolioAttributes || {},
      wardenId: body.wardenId,
      phone: body.phone,
      email: body.email,
      amenities: body.amenities || [],
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, occupiedBeds: 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, async (req, res) => {
  try {
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));
    res.json({ success: true, data: { ...row, occupiedBeds: r.count || 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.update(propertiesTable).set({ ...body, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));
    res.json({ success: true, data: { ...row, occupiedBeds: r.count || 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, async (req, res) => {
  try {
    await db.delete(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
