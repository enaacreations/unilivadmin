import { Router } from "express";
import { db } from "@workspace/db";
import { roomsTable, residentsTable } from "@workspace/db";
import { eq, sql, and, inArray } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import {
  pick,
  scopedPropertyId,
  effectivePropertyFilter,
  assertPropertyAccess,
  sendAuthzError,
} from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";

/** Writable room columns (server manages id/createdAt/updatedAt). */
const ROOM_FIELDS = ["propertyId", "number", "floor", "wing", "type", "capacity", "status"] as const;

const router = Router();

/** Occupancy for a set of rooms, as a roomId → active-resident-count map. */
async function occupancyFor(roomIds: string[]): Promise<Map<string | null, number>> {
  if (!roomIds.length) return new Map();
  const rows = await db
    .select({ roomId: residentsTable.roomId, count: sql<number>`count(*)::int` })
    .from(residentsTable)
    .where(and(inArray(residentsTable.roomId, roomIds), eq(residentsTable.status, "ACTIVE")))
    .groupBy(residentsTable.roomId);
  return new Map(rows.map((o) => [o.roomId, o.count]));
}

/**
 * Load a room and refuse it if it sits outside a scoped caller's property.
 * Returns null after answering 404 — so a warden probing another property's
 * room ids gets the same 404 as a nonexistent one and learns nothing from the
 * difference. (The write paths below assert separately, which is where a 403 is
 * the honest answer: the caller already knows the row exists.)
 */
async function loadRoomInScope(req: import("express").Request, id: string) {
  const [row] = await db.select().from(roomsTable).where(eq(roomsTable.id, id));
  if (!row) return null;
  const scope = scopedPropertyId(req);
  if (scope && row.propertyId !== scope) return null;
  return row;
}

router.get("/", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    // Folds the caller's own scope into the optional ?propertyId filter. The old
    // form (`propertyId ? eq(...) : undefined`) returned EVERY property's rooms
    // whenever the caller simply omitted the filter.
    const propertyId = effectivePropertyFilter(req, req.query["propertyId"] as string | undefined);

    const where = propertyId ? eq(roomsTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(roomsTable).where(where);
    const rows = await db.select().from(roomsTable).where(where).limit(limit).offset(offset).orderBy(roomsTable.number);

    const occByRoom = await occupancyFor(rows.map((r) => r.id));
    const withOccupancy = rows.map((r) => ({ ...r, occupancy: occByRoom.get(r.id) || 0 }));

    res.json({ success: true, data: withOccupancy, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("PROPERTIES", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ROOM_FIELDS);
    // Same shape as the resident create path: a scoped caller creates only into
    // their own property, and an org-wide caller must name one they may reach.
    // Previously this accepted whatever propertyId the body carried.
    const scope = scopedPropertyId(req);
    if (scope) body.propertyId = scope;
    if (!body.propertyId) { res.status(400).json({ success: false, error: "propertyId is required" }); return; }
    assertPropertyAccess(req, body.propertyId);

    const [row] = await db.insert(roomsTable).values({ ...body, id: newId(), updatedAt: new Date() }).returning();
    res.status(201).json({ success: true, data: { ...row, occupancy: 0 } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const row = await loadRoomInScope(req, req.params["id"]!);
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [occ] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.roomId, row.id), eq(residentsTable.status, "ACTIVE")));
    res.json({ success: true, data: { ...row, occupancy: occ.count || 0 } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("PROPERTIES", "edit"), async (req, res) => {
  try {
    const existing = await loadRoomInScope(req, req.params["id"]!);
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const body = pick(req.body, ROOM_FIELDS);
    // Block a scoped caller from moving a room OUT of their property — without
    // this, edit rights on a room you can see become write access to one you can't.
    if (body.propertyId !== undefined && body.propertyId !== existing.propertyId) {
      assertPropertyAccess(req, body.propertyId);
    }

    const [row] = await db.update(roomsTable).set({ ...body, updatedAt: new Date() }).where(eq(roomsTable.id, existing.id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // PRD §29 names "Room status changed" explicitly. Only recorded when the
    // status actually moved — an edit to the capacity is not a status change,
    // and a trail that says otherwise is noise that hides the real ones.
    if (body.status !== undefined && body.status !== existing.status) {
      recordActivity(activityCtx(req), {
        event: "ROOM_STATUS_CHANGED",
        entityId: row.id,
        entityLabel: `Room ${row.number}`,
        propertyId: row.propertyId,
        fromState: existing.status,
        toState: row.status,
        before: { status: existing.status },
        after: { status: row.status },
      });
    }
    const [occ] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.roomId, row.id), eq(residentsTable.status, "ACTIVE")));
    res.json({ success: true, data: { ...row, occupancy: occ.count || 0 } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("PROPERTIES", "delete"), async (req, res) => {
  try {
    const existing = await loadRoomInScope(req, req.params["id"]!);
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await db.delete(roomsTable).where(eq(roomsTable.id, existing.id));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
