import { Router } from "express";
import { db } from "@workspace/db";
import { messageTemplatesTable, communicationLogsTable, residentsTable, ledgerEntriesTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, scopedPropertyId } from "../lib/authz.js";
import { notify } from "../lib/notification-service.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

export const templatesRouter = Router();

templatesRouter.get("/", authenticate, authorize("COMMUNICATIONS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(messageTemplatesTable);
    const rows = await db.select().from(messageTemplatesTable).limit(limit).offset(offset).orderBy(messageTemplatesTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

templatesRouter.post("/", authenticate, authorize("COMMUNICATIONS", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["name", "channel", "body", "variables"]);
    const [row] = await db.insert(messageTemplatesTable).values({
      id: newId(),
      name: body.name,
      channel: body.channel,
      body: body.body,
      variables: body.variables || [],
      createdBy: req.user?.id,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

templatesRouter.put("/:id", authenticate, authorize("COMMUNICATIONS", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["name", "channel", "body", "variables"]);
    const [row] = await db.update(messageTemplatesTable).set({
      name: body.name, channel: body.channel, body: body.body, variables: body.variables || [], updatedAt: new Date(),
    }).where(eq(messageTemplatesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

templatesRouter.delete("/:id", authenticate, authorize("COMMUNICATIONS", "delete"), async (req, res) => {
  try {
    await db.delete(messageTemplatesTable).where(eq(messageTemplatesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export const commsRouter = Router();

commsRouter.get("/logs", authenticate, authorize("COMMUNICATIONS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(communicationLogsTable);
    const rows = await db.select().from(communicationLogsTable).limit(limit).offset(offset).orderBy(communicationLogsTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

commsRouter.post("/bulk-send", authenticate, authorize("COMMUNICATIONS", "create"), async (req, res) => {
  try {
    const { channel, body, subject, propertyId, status } = req.body;
    const conditions = [];
    // Property-bound roles (WARDEN/UNIT_LEAD) can only broadcast within their own
    // property; org-wide roles are unrestricted (scope is null → no-op).
    const scope = scopedPropertyId(req);
    if (scope) conditions.push(eq(residentsTable.propertyId, scope));
    if (propertyId) conditions.push(eq(residentsTable.propertyId, propertyId));
    if (status === "ACTIVE" || status === "NOTICE_PERIOD" || status === "CHECKED_OUT") {
      conditions.push(eq(residentsTable.status, status));
    }
    let recipients: { id: string; name: string; phone: string; email: string }[] = [];
    if (status === "OVERDUE") {
      // residents with unpaid ledger entries past due (still bounded by any property scope)
      const overdueConditions = [
        eq(ledgerEntriesTable.isPaid, false),
        sql`${ledgerEntriesTable.dueDate} < NOW()`,
      ];
      if (scope) overdueConditions.push(eq(residentsTable.propertyId, scope));
      if (propertyId) overdueConditions.push(eq(residentsTable.propertyId, propertyId));
      const overdueRows = await db.select({
        id: residentsTable.id, name: residentsTable.name, phone: residentsTable.phone, email: residentsTable.email,
      }).from(residentsTable).innerJoin(ledgerEntriesTable, eq(ledgerEntriesTable.residentId, residentsTable.id))
        .where(and(...overdueConditions));
      const seen = new Set<string>();
      recipients = overdueRows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
    } else {
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      recipients = await db.select({
        id: residentsTable.id, name: residentsTable.name, phone: residentsTable.phone, email: residentsTable.email,
      }).from(residentsTable).where(where);
    }

    const resolvedChannel = String(channel || "SMS").toUpperCase();
    // Actually dispatch: enqueue one notify() per recipient through the shared
    // notification engine (durable outbox + pluggable transport). Best-effort —
    // notify() never throws, and the audit log row below is still written.
    await Promise.all(
      recipients.map((r) =>
        notify({
          userId: r.id,
          title: subject || "Message from Uniliv",
          body,
          type: "BULK_COMMS",
          entityType: "COMMUNICATION",
          skipInApp: true,
          ...(resolvedChannel === "EMAIL"
            ? { email: { subject: subject || "Message from Uniliv", text: body } }
            : { sms: body }),
        }),
      ),
    );

    // Audit log row (kept): records the broadcast + resolved recipient count.
    const [log] = await db.insert(communicationLogsTable).values({
      id: newId(),
      channel: channel || "SMS",
      subject: subject || null,
      body,
      recipientCount: recipients.length,
      recipientFilter: { propertyId: propertyId || null, status: status || null },
      sentBy: req.user?.id,
    }).returning();
    res.json({ success: true, data: { log, recipients: recipients.slice(0, 3), totalRecipients: recipients.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

function mergeTpl(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

commsRouter.post("/preview", authenticate, authorize("COMMUNICATIONS", "view"), async (req, res) => {
  try {
    const { propertyId, status, body: bodyTpl = "", subject: subjectTpl = "" } = req.body;
    const conditions = [];
    const scope = scopedPropertyId(req);
    if (scope) conditions.push(eq(residentsTable.propertyId, scope));
    if (propertyId) conditions.push(eq(residentsTable.propertyId, propertyId));
    if (status === "ACTIVE" || status === "NOTICE_PERIOD" || status === "CHECKED_OUT") {
      conditions.push(eq(residentsTable.status, status));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const recipients = await db.select({
      id: residentsTable.id, name: residentsTable.name, phone: residentsTable.phone, email: residentsTable.email,
    }).from(residentsTable).where(where).limit(3);
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(where);

    const sample = await Promise.all(recipients.map(async (r) => {
      const outstanding = await db.select({
        amount: ledgerEntriesTable.amount,
        dueDate: ledgerEntriesTable.dueDate,
      }).from(ledgerEntriesTable)
        .where(and(eq(ledgerEntriesTable.residentId, r.id), eq(ledgerEntriesTable.isPaid, false)))
        .orderBy(ledgerEntriesTable.dueDate)
        .limit(1);

      const totalAmount = outstanding.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      const nearestDue = outstanding[0]?.dueDate;

      const vars: Record<string, string> = {
        name: r.name,
        amount: totalAmount > 0 ? `₹${totalAmount.toLocaleString("en-IN")}` : "₹0",
        dueDate: nearestDue
          ? new Date(nearestDue).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
          : "N/A",
      };

      return {
        to: r.phone || r.email,
        name: r.name,
        body: mergeTpl(bodyTpl, vars),
        ...(subjectTpl ? { subject: mergeTpl(subjectTpl, vars) } : {}),
      };
    }));

    res.json({ success: true, data: { sample, total: countResult?.count || 0 } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
