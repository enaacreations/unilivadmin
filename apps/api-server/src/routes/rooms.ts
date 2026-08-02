import { Router } from "express";
import { db } from "@workspace/db";
import { roomsTable, residentsTable } from "@workspace/db";
import { eq, sql, and, inArray } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

/** Writable room columns (server manages id/createdAt/updatedAt). */
const ROOM_FIELDS = ["propertyId", "number", "floor", "wing", "type", "capacity", "status"] as const;

const router = Router();

router.get("/", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;

    const where = propertyId ? eq(roomsTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(roomsTable).where(where);
    const rows = await db.select().from(roomsTable).where(where).limit(limit).offset(offset).orderBy(roomsTable.number);

    const roomIds = rows.map((r) => r.id);
    const occRows = roomIds.length
      ? await db
          .select({ roomId: residentsTable.roomId, count: sql<number>`count(*)::int` })
          .from(residentsTable)
          .where(and(inArray(residentsTable.roomId, roomIds), eq(residentsTable.status, "ACTIVE")))
          .groupBy(residentsTable.roomId)
      : [];
    const occByRoom = new Map(occRows.map((o) => [o.roomId, o.count]));
    const withOccupancy = rows.map((r) => ({ ...r, occupancy: occByRoom.get(r.id) || 0 }));

    res.json({ success: true, data: withOccupancy, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("PROPERTIES", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ROOM_FIELDS);
    const [row] = await db.insert(roomsTable).values({ ...body, id: newId(), updatedAt: new Date() }).returning();
    res.status(201).json({ success: true, data: { ...row, occupancy: 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(roomsTable).where(eq(roomsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [occ] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.roomId, row.id), eq(residentsTable.status, "ACTIVE")));
    res.json({ success: true, data: { ...row, occupancy: occ.count || 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("PROPERTIES", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(roomsTable).set({ ...pick(req.body, ROOM_FIELDS), updatedAt: new Date() }).where(eq(roomsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [occ] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.roomId, row.id), eq(residentsTable.status, "ACTIVE")));
    res.json({ success: true, data: { ...row, occupancy: occ.count || 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("PROPERTIES", "delete"), async (req, res) => {
  try {
    await db.delete(roomsTable).where(eq(roomsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
