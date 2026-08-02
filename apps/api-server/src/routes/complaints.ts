import { Router } from "express";
import { db } from "@workspace/db";
import { complaintsTable, escalationsTable, residentsTable, propertiesTable, complaintEventsTable } from "@workspace/db";
import { eq, sql, ilike, or, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, scopedPropertyId } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId, withUniqueRetry } from "../lib/id.js";

const router = Router();

async function nextTicketNo(): Promise<string> {
  const [r] = await db.select({ max: sql<string | null>`MAX(${complaintsTable.ticketNo})` }).from(complaintsTable);
  const last = r?.max || "TKT-01000";
  const n = parseInt(last.replace(/[^0-9]/g, ""), 10) || 1000;
  return `TKT-${String(n + 1).padStart(5, "0")}`;
}

async function enrichComplaint(c: typeof complaintsTable.$inferSelect) {
  let residentName: string | null = null;
  let propertyName: string | null = null;
  if (c.residentId) {
    const [r] = await db.select({ name: residentsTable.name }).from(residentsTable).where(eq(residentsTable.id, c.residentId));
    residentName = r?.name || null;
  }
  if (c.propertyId) {
    const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, c.propertyId));
    propertyName = p?.name || null;
  }
  return { ...c, residentName, propertyName };
}

router.get("/", authenticate, authorize("COMPLAINTS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const priority = req.query["priority"] as string | undefined;
    const search = req.query["search"] as string | undefined;

    const conditions = [];
    // Best-effort property scoping for property-bound roles (WARDEN/UNIT_LEAD);
    // a no-op for org-wide roles so it never restricts admins.
    const scope = scopedPropertyId(req);
    if (scope) conditions.push(eq(complaintsTable.propertyId, scope));
    if (propertyId) conditions.push(eq(complaintsTable.propertyId, propertyId));
    if (status) conditions.push(eq(complaintsTable.status, status as "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | "REOPENED"));
    if (category) conditions.push(eq(complaintsTable.category, category as "ELECTRICAL" | "PLUMBING" | "INTERNET" | "HOUSEKEEPING" | "SECURITY" | "FOOD" | "LAUNDRY" | "OTHER"));
    if (priority) conditions.push(eq(complaintsTable.priority, priority as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"));
    if (search) conditions.push(or(ilike(complaintsTable.title, `%${search}%`), ilike(complaintsTable.ticketNo, `%${search}%`))!);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(where);
    const rows = await db.select().from(complaintsTable).where(where).limit(limit).offset(offset).orderBy(complaintsTable.createdAt);

    const enriched = await Promise.all(rows.map(enrichComplaint));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("COMPLAINTS", "create"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "propertyId", "residentId", "category", "subCategory",
      "title", "description", "priority", "assignedTo", "slaHours",
    ]) as Record<string, any>;
    // A property-scoped caller can only create complaints for their own property.
    const scope = scopedPropertyId(req);
    if (scope) body.propertyId = scope;
    else if (!body.propertyId) { res.status(400).json({ success: false, error: "propertyId is required" }); return; }
    const slaDeadline = new Date(Date.now() + (body.slaHours || 24) * 60 * 60 * 1000);
    const row = await withUniqueRetry(async () => {
      const [r] = await db.insert(complaintsTable).values({
        id: newId(),
        propertyId: body.propertyId,
        residentId: body.residentId,
        ticketNo: await nextTicketNo(),
        category: body.category,
        subCategory: body.subCategory,
        title: body.title,
        description: body.description,
        priority: body.priority || "MEDIUM",
        assignedTo: body.assignedTo,
        slaHours: body.slaHours || 24,
        slaDeadline,
        updatedAt: new Date(),
      }).returning();
      return r;
    });
    res.status(201).json({ success: true, data: await enrichComplaint(row) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("COMPLAINTS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const scope = scopedPropertyId(req);
    if (scope && row.propertyId !== scope) { res.status(403).json({ success: false, error: "Outside your property scope" }); return; }
    res.json({ success: true, data: await enrichComplaint(row) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("COMPLAINTS", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["status", "priority", "assignedTo", "resolutionNote", "rating"]) as Record<string, any>;
    const id = req.params["id"]!;
    const [existing] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const scope = scopedPropertyId(req);
    if (scope && existing.propertyId !== scope) { res.status(403).json({ success: false, error: "Outside your property scope" }); return; }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) updateData["status"] = body.status;
    if (body.priority) updateData["priority"] = body.priority;
    if (body.assignedTo !== undefined) updateData["assignedTo"] = body.assignedTo;
    if (body.resolutionNote) updateData["resolutionNote"] = body.resolutionNote;
    if (body.rating !== undefined) updateData["rating"] = body.rating;
    if (body.status === "RESOLVED") updateData["resolvedAt"] = new Date();

    const [row] = await db.update(complaintsTable).set(updateData as Partial<typeof complaintsTable.$inferInsert>).where(eq(complaintsTable.id, id)).returning();

    // Record timeline events
    const actor = req.user?.id;
    if (body.status && body.status !== existing.status) {
      await db.insert(complaintEventsTable).values({ id: newId(), complaintId: id, type: "STATUS_CHANGE", fromValue: existing.status, toValue: body.status, actorId: actor });
    }
    if (body.assignedTo !== undefined && body.assignedTo !== existing.assignedTo) {
      await db.insert(complaintEventsTable).values({ id: newId(), complaintId: id, type: "ASSIGNMENT", fromValue: existing.assignedTo, toValue: body.assignedTo, actorId: actor });
    }
    if (body.resolutionNote) {
      await db.insert(complaintEventsTable).values({ id: newId(), complaintId: id, type: "RESOLUTION", note: body.resolutionNote, actorId: actor });
    }

    res.json({ success: true, data: await enrichComplaint(row!) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Timeline
router.get("/:id/timeline", authenticate, authorize("COMPLAINTS", "view"), async (req, res) => {
  try {
    const scope = scopedPropertyId(req);
    if (scope) {
      const [parent] = await db.select({ propertyId: complaintsTable.propertyId }).from(complaintsTable).where(eq(complaintsTable.id, req.params["id"]!));
      if (!parent) { res.status(404).json({ success: false, error: "Not found" }); return; }
      if (parent.propertyId !== scope) { res.status(403).json({ success: false, error: "Outside your property scope" }); return; }
    }
    const events = await db.select().from(complaintEventsTable).where(eq(complaintEventsTable.complaintId, req.params["id"]!)).orderBy(complaintEventsTable.createdAt);
    const escalations = await db.select().from(escalationsTable).where(eq(escalationsTable.complaintId, req.params["id"]!)).orderBy(escalationsTable.createdAt);
    res.json({ success: true, data: { events, escalations } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Stats / Analytics
router.get("/stats/overview", authenticate, authorize("COMPLAINTS", "view"), async (req, res) => {
  try {
    // Property-scoped roles (WARDEN/UNIT_LEAD) see only their own property's stats.
    const scope = scopedPropertyId(req);
    const propertyId = scope ?? (req.query["propertyId"] as string | undefined);
    const all = propertyId
      ? await db.select().from(complaintsTable).where(eq(complaintsTable.propertyId, propertyId))
      : await db.select().from(complaintsTable);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const open = all.filter(c => !["RESOLVED", "CLOSED"].includes(c.status)).length;
    const breached = all.filter(c => c.slaBreach && !["RESOLVED", "CLOSED"].includes(c.status)).length;
    const resolvedToday = all.filter(c => c.resolvedAt && new Date(c.resolvedAt) >= today).length;
    const resolvedAll = all.filter(c => c.resolvedAt);
    const avgHours = resolvedAll.length > 0
      ? resolvedAll.reduce((sum, c) => sum + (new Date(c.resolvedAt!).getTime() - new Date(c.createdAt).getTime()) / 3600000, 0) / resolvedAll.length
      : 0;

    // by category (this month)
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const thisMonth = all.filter(c => new Date(c.createdAt) >= monthStart);
    const byCategory: Record<string, number> = {};
    for (const c of thisMonth) byCategory[c.category] = (byCategory[c.category] || 0) + 1;

    // last 6 months trend
    const trend: { month: string; count: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i); d.setDate(1); d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setMonth(next.getMonth() + 1);
      const count = all.filter(c => { const t = new Date(c.createdAt); return t >= d && t < next; }).length;
      trend.push({ month: d.toLocaleString("en-US", { month: "short" }), count });
    }

    // SLA compliance
    const closed = all.filter(c => ["RESOLVED", "CLOSED"].includes(c.status));
    const onTime = closed.filter(c => !c.slaBreach).length;
    const breachClosed = closed.length - onTime;

    // Heatmap: 7 days x categories
    const cats = ["ELECTRICAL","PLUMBING","HOUSEKEEPING","INTERNET","SECURITY","FOOD","LAUNDRY","OTHER"];
    const heatmap: { day: string; date: string; counts: Record<string, number> }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const counts: Record<string, number> = {};
      for (const cat of cats) counts[cat] = 0;
      for (const c of all) {
        const t = new Date(c.createdAt);
        if (t >= d && t < next) counts[c.category] = (counts[c.category] || 0) + 1;
      }
      heatmap.push({ day: d.toLocaleString("en-US", { weekday: "short" }), date: d.toISOString().slice(0, 10), counts });
    }

    res.json({ success: true, data: {
      open, breached, resolvedToday, avgHours: Number(avgHours.toFixed(1)),
      byCategory, trend, slaCompliance: { onTime, breach: breachClosed }, heatmap, categories: cats,
    } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// ── Escalations — dedicated router mounted at /escalations ──
// Previously /escalations re-mounted the complaints router, so POST /escalations
// resolved to the create-complaint handler and 500'd every time. This dedicated
// router serves escalation create/list correctly.
export const escalationsRouter: Router = Router();

escalationsRouter.get("/", authenticate, authorize("COMPLAINTS", "view"), async (req, res) => {
  try {
    const complaintId = req.query["complaintId"] as string | undefined;
    const scope = scopedPropertyId(req);
    if (scope && complaintId) {
      // A property-scoped caller may only read escalations of complaints in their property.
      const [parent] = await db.select({ propertyId: complaintsTable.propertyId }).from(complaintsTable).where(eq(complaintsTable.id, complaintId));
      if (!parent || parent.propertyId !== scope) { res.status(403).json({ success: false, error: "Outside your property scope" }); return; }
    }
    const conditions = [];
    if (complaintId) conditions.push(eq(escalationsTable.complaintId, complaintId));
    if (scope) {
      // Restrict to escalations whose parent complaint is in the caller's property.
      conditions.push(sql`${escalationsTable.complaintId} IN (SELECT ${complaintsTable.id} FROM ${complaintsTable} WHERE ${complaintsTable.propertyId} = ${scope})`);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db.select().from(escalationsTable).where(where).orderBy(escalationsTable.createdAt);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

escalationsRouter.post("/", authenticate, authorize("COMPLAINTS", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["complaintId", "level", "escalatedTo", "reason"]) as Record<string, any>;
    if (!body.complaintId) { res.status(400).json({ success: false, error: "complaintId is required" }); return; }
    // Verify the parent complaint exists and is within the caller's property scope.
    const [parent] = await db.select({ propertyId: complaintsTable.propertyId }).from(complaintsTable).where(eq(complaintsTable.id, body.complaintId));
    if (!parent) { res.status(404).json({ success: false, error: "Complaint not found" }); return; }
    const scope = scopedPropertyId(req);
    if (scope && parent.propertyId !== scope) { res.status(403).json({ success: false, error: "Outside your property scope" }); return; }
    const [row] = await db.insert(escalationsTable).values({
      id: newId(),
      complaintId: body.complaintId,
      level: body.level || 1,
      escalatedTo: body.escalatedTo,
      reason: body.reason,
    }).returning();
    await db.insert(complaintEventsTable).values({
      id: newId(), complaintId: body.complaintId, type: "ESCALATION", toValue: body.escalatedTo, note: body.reason, actorId: req.user?.id,
    });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// SLA background check
export async function runSlaCheck(): Promise<void> {
  const now = new Date();
  const open = await db.select().from(complaintsTable).where(
    and(
      sql`${complaintsTable.status} NOT IN ('RESOLVED','CLOSED')`,
      eq(complaintsTable.slaBreach, false),
      sql`${complaintsTable.slaDeadline} < ${now}`,
    )
  );
  for (const c of open) {
    await db.update(complaintsTable).set({ slaBreach: true, updatedAt: now }).where(eq(complaintsTable.id, c.id));
    await db.insert(complaintEventsTable).values({ id: newId(), complaintId: c.id, type: "SLA_BREACH", note: `SLA deadline ${c.slaDeadline?.toISOString()} passed` });
  }
}

export default router;
