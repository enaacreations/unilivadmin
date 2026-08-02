import { Router } from "express";
import { db } from "@workspace/db";
import {
  leadsTable,
  leadActivitiesTable,
  propertyLeadsTable,
  propertiesTable,
  residentsTable,
  usersTable,
} from "@workspace/db";
import { eq, sql, ilike, or, and, gte, lte, desc, inArray } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { csvEsc } from "../lib/export-service.js";

export const leadsRouter: Router = Router();

async function logActivity(leadId: string, type: string, note?: string, meta?: unknown, userId?: string) {
  await db.insert(leadActivitiesTable).values({
    id: newId(),
    leadId,
    type,
    note: note || null,
    meta: meta as object | null,
    createdBy: userId || null,
  });
}

async function enrichLead(l: typeof leadsTable.$inferSelect) {
  let propertyName: string | null = null;
  let assignedToName: string | null = null;
  if (l.propertyId) {
    const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, l.propertyId));
    propertyName = p?.name || null;
  }
  if (l.assignedTo) {
    const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, l.assignedTo));
    assignedToName = u?.name || null;
  }
  return {
    ...l,
    budgetMin: l.budgetMin ? Number(l.budgetMin) : null,
    budgetMax: l.budgetMax ? Number(l.budgetMax) : null,
    propertyName,
    assignedToName,
  };
}

leadsRouter.get("/", authenticate, authorize("SALES_LEADS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const stage = req.query["stage"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const source = req.query["source"] as string | undefined;
    const assignedTo = req.query["assignedTo"] as string | undefined;
    const dateFrom = req.query["dateFrom"] as string | undefined;
    const dateTo = req.query["dateTo"] as string | undefined;
    const conditions = [];
    if (stage) conditions.push(eq(leadsTable.stage, stage as "NEW"));
    if (propertyId) conditions.push(eq(leadsTable.propertyId, propertyId));
    if (source) conditions.push(eq(leadsTable.source, source as "WEBSITE"));
    if (assignedTo) conditions.push(eq(leadsTable.assignedTo, assignedTo));
    if (dateFrom) conditions.push(gte(leadsTable.createdAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(leadsTable.createdAt, new Date(dateTo)));
    if (search) conditions.push(or(ilike(leadsTable.name, `%${search}%`), ilike(leadsTable.phone, `%${search}%`))!);
    const where = conditions.length ? and(...conditions) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(where);
    const rows = await db.select().from(leadsTable).where(where).limit(limit).offset(offset).orderBy(desc(leadsTable.createdAt));
    const enriched = await Promise.all(rows.map(enrichLead));
    res.json({ success: true, data: enriched, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.get("/stats", authenticate, authorize("SALES_LEADS", "view"), async (req, res) => {
  try {
    const assignedTo = req.query["assignedTo"] as string | undefined;
    const where = assignedTo ? eq(leadsTable.assignedTo, assignedTo) : undefined;
    const stages = ["NEW", "CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATING", "CONVERTED", "LOST"] as const;
    const counts: Record<string, number> = {};
    for (const s of stages) {
      const cond = where ? and(eq(leadsTable.stage, s), where) : eq(leadsTable.stage, s);
      const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(cond);
      counts[s] = c.count;
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const conversionRate = total ? Math.round((counts["CONVERTED"] / total) * 1000) / 10 : 0;

    // by source
    const bySource = await db.select({
      source: leadsTable.source,
      count: sql<number>`count(*)::int`,
    }).from(leadsTable).where(where).groupBy(leadsTable.source);

    // per-staff performance
    const allUsers = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
    const performance = await Promise.all(allUsers.map(async (u) => {
      const [a] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(eq(leadsTable.assignedTo, u.id));
      const [conv] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(and(eq(leadsTable.assignedTo, u.id), eq(leadsTable.stage, "CONVERTED")));
      const assigned = a.count, converted = conv.count;
      return { userId: u.id, name: u.name, assigned, converted, conversionRate: assigned ? Math.round((converted / assigned) * 1000) / 10 : 0 };
    }));

    res.json({ success: true, data: { stageCounts: counts, total, conversionRate, bySource, performance: performance.filter((p) => p.assigned > 0) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.get("/export-csv", authenticate, authorize("SALES_LEADS", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt));
    const header = ["Name", "Phone", "Email", "Source", "Stage", "Property", "Created"];
    const lines = [header.map(csvEsc).join(",")];
    for (const l of rows) {
      lines.push([l.name, l.phone, l.email || "", l.source, l.stage, l.propertyId || "", l.createdAt.toISOString().slice(0, 10)].map(csvEsc).join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/", authenticate, authorize("SALES_LEADS", "create"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "name", "phone", "email", "source", "propertyId", "stage", "assignedTo",
      "budgetMin", "budgetMax", "moveInDate", "visitDate", "followUpAt", "notes",
    ]) as Record<string, any>;
    const [row] = await db.insert(leadsTable).values({
      id: newId(),
      name: body.name,
      phone: body.phone,
      email: body.email,
      source: body.source,
      propertyId: body.propertyId,
      stage: body.stage || "NEW",
      assignedTo: body.assignedTo,
      budgetMin: body.budgetMin?.toString(),
      budgetMax: body.budgetMax?.toString(),
      moveInDate: body.moveInDate ? new Date(body.moveInDate) : null,
      visitDate: body.visitDate ? new Date(body.visitDate) : null,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
      notes: body.notes,
      updatedAt: new Date(),
    }).returning();
    await logActivity(row.id, "STAGE_CHANGE", `Lead created (${row.stage})`, undefined, req.user?.id);
    res.status(201).json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.get("/:id", authenticate, authorize("SALES_LEADS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.put("/:id", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [prev] = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
    if (!prev) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const body = pick(req.body, [
      "name", "phone", "email", "source", "propertyId", "stage", "assignedTo",
      "budgetMin", "budgetMax", "moveInDate", "visitDate", "followUpAt", "followUpNote",
      "notes", "lostReason",
    ]) as Record<string, any>;
    if (body.stage === "CONVERTED" && prev.stage !== "CONVERTED") {
      res.status(400).json({ success: false, error: "Use POST /leads/:id/convert to move a lead to CONVERTED" });
      return;
    }
    if (body.visitDate) body.visitDate = new Date(body.visitDate);
    if (body.followUpAt) body.followUpAt = new Date(body.followUpAt);
    if (body.moveInDate) body.moveInDate = new Date(body.moveInDate);
    if (body.budgetMin !== undefined) body.budgetMin = body.budgetMin?.toString();
    if (body.budgetMax !== undefined) body.budgetMax = body.budgetMax?.toString();
    const [row] = await db.update(leadsTable).set({ ...body, updatedAt: new Date() }).where(eq(leadsTable.id, id)).returning();
    if (body.stage && body.stage !== prev.stage) await logActivity(id, "STAGE_CHANGE", `${prev.stage} → ${body.stage}`, undefined, req.user?.id);
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.delete("/:id", authenticate, authorize("SALES_LEADS", "delete"), async (req, res) => {
  try {
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.leadId, req.params["id"]!));
    await db.delete(leadsTable).where(eq(leadsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// activities
leadsRouter.get("/:id/activities", authenticate, authorize("SALES_LEADS", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(leadActivitiesTable).where(eq(leadActivitiesTable.leadId, req.params["id"]!)).orderBy(desc(leadActivitiesTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/:id/activities", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const { type, note, meta } = req.body;
    const [row] = await db.insert(leadActivitiesTable).values({
      id: newId(), leadId: req.params["id"]!, type: type || "NOTE", note, meta, createdBy: req.user?.id || null,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// schedule visit
leadsRouter.post("/:id/schedule-visit", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const { visitDate } = req.body;
    if (!visitDate) { res.status(400).json({ success: false, error: "visitDate required" }); return; }
    const [row] = await db.update(leadsTable).set({ visitDate: new Date(visitDate), stage: "VISIT_SCHEDULED", updatedAt: new Date() }).where(eq(leadsTable.id, id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await logActivity(id, "VISIT_SCHEDULED", `Visit scheduled for ${new Date(visitDate).toLocaleString()}`, { visitDate }, req.user?.id);
    // SMS stub — no Twilio creds wired. Do NOT log the raw phone number (PII):
    // the pino redaction list does not cover application fields, so a phone here
    // would land in plaintext in centralized logs. Log only the leadId.
    req.log.info({ leadId: id }, "[SMS stub] visit confirmation would be sent");
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/:id/visit-outcome", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const { outcome, feedback, lostReason } = req.body;
    const update: Record<string, unknown> = { visitDone: true, visitOutcome: outcome, visitFeedback: feedback, updatedAt: new Date() };
    if (outcome === "NO") { update["stage"] = "LOST"; update["lostReason"] = lostReason; }
    else update["stage"] = "VISIT_DONE";
    const [row] = await db.update(leadsTable).set(update).where(eq(leadsTable.id, id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await logActivity(id, "VISIT_OUTCOME", `Visit outcome: ${outcome}${feedback ? ` — ${feedback}` : ""}`, { outcome, feedback, lostReason }, req.user?.id);
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/:id/follow-up", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const { followUpAt, followUpNote } = req.body;
    const [row] = await db.update(leadsTable).set({ followUpAt: new Date(followUpAt), followUpNote, updatedAt: new Date() }).where(eq(leadsTable.id, id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await logActivity(id, "FOLLOWUP_SET", `Follow-up set for ${new Date(followUpAt).toLocaleString()}${followUpNote ? ` — ${followUpNote}` : ""}`, undefined, req.user?.id);
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/:id/mark-lost", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const { lostReason } = req.body;
    if (!lostReason) { res.status(400).json({ success: false, error: "lostReason required" }); return; }
    const [row] = await db.update(leadsTable).set({ stage: "LOST", lostReason, updatedAt: new Date() }).where(eq(leadsTable.id, id)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await logActivity(id, "STAGE_CHANGE", `Lost — ${lostReason}`, { lostReason }, req.user?.id);
    res.json({ success: true, data: await enrichLead(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

leadsRouter.post("/:id/convert", authenticate, authorize("SALES_LEADS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
    if (!lead) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const body = req.body || {};
    const propertyId = body.propertyId || lead.propertyId;
    const email = body.email || lead.email;
    if (!propertyId) { res.status(400).json({ success: false, error: "propertyId is required to convert" }); return; }
    if (!email) { res.status(400).json({ success: false, error: "email is required to convert" }); return; }
    const resident = await db.transaction(async (tx) => {
      const [r] = await tx.insert(residentsTable).values({
        id: newId(),
        name: lead.name,
        phone: lead.phone,
        email,
        propertyId,
        roomId: body.roomId,
        planType: body.planType || "MONTHLY",
        monthlyRent: body.monthlyRent?.toString() || "0",
        securityDeposit: (body.securityDeposit ?? body.depositAmount)?.toString() || "0",
        checkInDate: body.checkInDate ? new Date(body.checkInDate) : new Date(),
        status: "ACTIVE",
        updatedAt: new Date(),
      }).returning();
      await tx.update(leadsTable).set({ stage: "CONVERTED", convertedAt: new Date(), residentId: r.id, updatedAt: new Date() }).where(eq(leadsTable.id, id));
      await tx.insert(leadActivitiesTable).values({
        id: newId(),
        leadId: id,
        type: "STAGE_CHANGE",
        note: `Converted to resident ${r.name}`,
        meta: { residentId: r.id },
        createdBy: req.user?.id || null,
      });
      return r;
    });
    res.json({ success: true, data: { lead: id, residentId: resident.id, resident } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =====================================================
export const propertyLeadsRouter: Router = Router();

propertyLeadsRouter.get("/", authenticate, authorize("PROPERTY_LEADS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const stage = req.query["stage"] as string | undefined;
    const conditions = [];
    if (stage) conditions.push(eq(propertyLeadsTable.stage, stage));
    if (search) conditions.push(or(ilike(propertyLeadsTable.name, `%${search}%`), ilike(propertyLeadsTable.city, `%${search}%`))!);
    const where = conditions.length ? and(...conditions) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(propertyLeadsTable).where(where);
    const rows = await db.select().from(propertyLeadsTable).where(where).limit(limit).offset(offset).orderBy(desc(propertyLeadsTable.createdAt));
    res.json({ success: true, data: rows.map((r) => ({ ...r, askingRent: r.askingRent ? Number(r.askingRent) : null })), meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

propertyLeadsRouter.post("/", authenticate, authorize("PROPERTY_LEADS", "create"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "name", "address", "city", "lat", "lng", "ownerName", "ownerPhone",
      "totalArea", "askingRent", "bedCount", "stage", "viabilityData",
      "documents", "photos", "notes",
    ]) as Record<string, any>;
    const [row] = await db.insert(propertyLeadsTable).values({
      id: newId(),
      name: body.name,
      address: body.address,
      city: body.city,
      lat: body.lat,
      lng: body.lng,
      ownerName: body.ownerName,
      ownerPhone: body.ownerPhone,
      totalArea: body.totalArea,
      askingRent: body.askingRent?.toString(),
      bedCount: body.bedCount,
      stage: body.stage || "SCOUTING",
      viabilityData: body.viabilityData,
      documents: body.documents || [],
      photos: body.photos || [],
      notes: body.notes,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, askingRent: row.askingRent ? Number(row.askingRent) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

propertyLeadsRouter.get("/:id", authenticate, authorize("PROPERTY_LEADS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(propertyLeadsTable).where(eq(propertyLeadsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, askingRent: row.askingRent ? Number(row.askingRent) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

propertyLeadsRouter.put("/:id", authenticate, authorize("PROPERTY_LEADS", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "name", "address", "city", "lat", "lng", "ownerName", "ownerPhone",
      "totalArea", "askingRent", "bedCount", "stage", "viabilityData",
      "documents", "photos", "notes",
    ]) as Record<string, any>;
    if (body.askingRent !== undefined) body.askingRent = body.askingRent?.toString();
    const [row] = await db.update(propertyLeadsTable).set({ ...body, updatedAt: new Date() }).where(eq(propertyLeadsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, askingRent: row.askingRent ? Number(row.askingRent) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

propertyLeadsRouter.delete("/:id", authenticate, authorize("PROPERTY_LEADS", "delete"), async (req, res) => {
  try {
    await db.delete(propertyLeadsTable).where(eq(propertyLeadsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

void inArray;
