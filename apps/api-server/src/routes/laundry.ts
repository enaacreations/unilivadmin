import { Router } from "express";
import { db } from "@workspace/db";
import { laundryBatchesTable, residentsTable, propertiesTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, scopedPropertyId, assertPropertyAccess } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

const router = Router();

// Next batch number derived from the DB so it survives server restarts
// (an in-memory counter reset to 1000 each restart and collided with the
// unique batch_no constraint). Combined with the insert retry in POST /.
async function nextBatchNo(): Promise<string> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${laundryBatchesTable.batchNo})` })
    .from(laundryBatchesTable);
  let n = 1000;
  if (row?.max) {
    const parsed = parseInt(String(row.max).replace(/\D/g, ""), 10);
    if (!Number.isNaN(parsed)) n = parsed;
  }
  return `LB-${String(n + 1).padStart(5, "0")}`;
}

async function enrichBatch(b: typeof laundryBatchesTable.$inferSelect) {
  const [r] = await db.select({ name: residentsTable.name, phone: residentsTable.phone }).from(residentsTable).where(eq(residentsTable.id, b.residentId));
  const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, b.propertyId));
  const totalItems = Object.values(b.items || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  return { ...b, residentName: r?.name || null, residentPhone: r?.phone || null, propertyName: p?.name || null, totalItems };
}

router.get("/", authenticate, authorize("LAUNDRY", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(laundryBatchesTable.propertyId, propertyId));
    const scope = scopedPropertyId(req);
    if (scope) conditions.push(eq(laundryBatchesTable.propertyId, scope));
    if (status) conditions.push(eq(laundryBatchesTable.status, status as "RECEIVED" | "IN_WASH" | "READY" | "PICKED_UP" | "DAMAGED"));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryBatchesTable).where(where);
    const rows = await db.select().from(laundryBatchesTable).where(where).limit(limit).offset(offset).orderBy(laundryBatchesTable.createdAt);
    const enriched = await Promise.all(rows.map(enrichBatch));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.post("/", authenticate, authorize("LAUNDRY", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["residentId", "dropDate", "commitTatDays", "items", "specialInstructions", "damageNote", "status"]) as {
      residentId?: string;
      dropDate?: string;
      commitTatDays?: number;
      items?: Record<string, number>;
      specialInstructions?: string;
      damageNote?: string;
      status?: "RECEIVED" | "IN_WASH" | "READY" | "PICKED_UP" | "DAMAGED";
    };
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, body.residentId!));
    if (!resident) { res.status(400).json({ success: false, error: "Resident not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);
    const rid = newId();
    let row!: typeof laundryBatchesTable.$inferSelect;
    for (let attempt = 0; ; attempt++) {
      try {
        [row] = await db.insert(laundryBatchesTable).values({
          id: rid,
          batchNo: await nextBatchNo(),
          residentId: body.residentId!,
          propertyId: resident.propertyId,
          dropDate: body.dropDate ? new Date(body.dropDate) : new Date(),
          commitTatDays: body.commitTatDays || 2,
          items: body.items || {},
          specialInstructions: body.specialInstructions,
          damageNote: body.damageNote,
          status: body.status || "RECEIVED",
          createdBy: req.user?.id,
          updatedAt: new Date(),
        }).returning();
        break;
      } catch (e: any) {
        if (attempt < 5 && /unique|duplicate/i.test(String(e?.message || e))) continue;
        throw e;
      }
    }
    res.status(201).json({ success: true, data: await enrichBatch(row) });
  } catch (err: any) {
    if (err?.statusCode) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("LAUNDRY", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(laundryBatchesTable).where(eq(laundryBatchesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, row.propertyId);
    res.json({ success: true, data: await enrichBatch(row) });
  } catch (err: any) {
    if (err?.statusCode) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("LAUNDRY", "edit"), async (req, res) => {
  try {
    const [existing] = await db.select().from(laundryBatchesTable).where(eq(laundryBatchesTable.id, req.params["id"]!));
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, existing.propertyId);
    const body = pick(req.body, ["status", "items", "specialInstructions", "damageNote", "commitTatDays"]) as Record<string, unknown>;
    const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body["status"] === "PICKED_UP") updateData["pickedUpAt"] = new Date();
    const [row] = await db.update(laundryBatchesTable).set(updateData as Partial<typeof laundryBatchesTable.$inferInsert>).where(eq(laundryBatchesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichBatch(row) });
  } catch (err: any) {
    if (err?.statusCode) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("LAUNDRY", "delete"), async (req, res) => {
  try {
    const [existing] = await db.select().from(laundryBatchesTable).where(eq(laundryBatchesTable.id, req.params["id"]!));
    if (!existing) { res.json({ success: true, message: "Deleted" }); return; }
    assertPropertyAccess(req, existing.propertyId);
    await db.delete(laundryBatchesTable).where(eq(laundryBatchesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err: any) {
    if (err?.statusCode) { res.status(err.statusCode).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
