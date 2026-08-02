import { Router } from "express";
import {
  db,
  billingCyclesTable,
  billingRunsTable,
  reminderRulesTable,
  reminderLogsTable,
  bankImportsTable,
  bankStatementLinesTable,
  expenseCategoriesTable,
  expensesTable,
  expenseEventsTable,
  residentsTable,
  ledgerEntriesTable,
  paymentsTable,
  propertiesTable,
  communicationLogsTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";
import { logger } from "../lib/logger.js";
import { badRequest, httpError } from "../lib/authz.js";
import { notify } from "../lib/notification-service.js";

export const financeRouter: Router = Router();

// ───────────────────────────────────────────────────────
// Billing cycles
// ───────────────────────────────────────────────────────
financeRouter.get("/billing-cycles", authenticate, authorize("BILLING_CYCLES", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(billingCyclesTable).orderBy(desc(billingCyclesTable.createdAt));
    const enriched = await Promise.all(rows.map(async (r) => {
      let propertyName: string | null = null;
      if (r.propertyId) {
        const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, r.propertyId));
        propertyName = p?.name || null;
      }
      return { ...r, propertyName };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/billing-cycles", authenticate, authorize("BILLING_CYCLES", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(billingCyclesTable).values({
      id: newId(),
      name: b.name,
      propertyId: b.propertyId || null,
      cadence: b.cadence || "MONTHLY",
      dayOfMonth: b.dayOfMonth ?? 1,
      customDays: b.customDays ?? null,
      ledgerType: b.ledgerType || "RENT",
      descriptionTemplate: b.descriptionTemplate || "Rent for {{month}}",
      isActive: b.isActive ?? true,
      createdBy: req.user?.id,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.put("/billing-cycles/:id", authenticate, authorize("BILLING_CYCLES", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "propertyId", "cadence", "dayOfMonth", "customDays", "ledgerType", "descriptionTemplate", "isActive"]) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    const [row] = await db.update(billingCyclesTable).set(updates as never).where(eq(billingCyclesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.delete("/billing-cycles/:id", authenticate, authorize("BILLING_CYCLES", "delete"), async (req, res) => {
  try {
    await db.delete(billingCyclesTable).where(eq(billingCyclesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.get("/billing-runs", authenticate, authorize("BILLING_CYCLES", "view"), async (req, res) => {
  try {
    const cycleId = req.query["cycleId"] as string | undefined;
    const where = cycleId ? eq(billingRunsTable.cycleId, cycleId) : undefined;
    const rows = await db.select().from(billingRunsTable).where(where as never).orderBy(desc(billingRunsTable.createdAt)).limit(100);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/billing-cycles/:id/run", authenticate, authorize("BILLING_CYCLES", "create"), async (req, res) => {
  try {
    const [cycle] = await db.select().from(billingCyclesTable).where(eq(billingCyclesTable.id, req.params["id"]!));
    if (!cycle) { res.status(404).json({ success: false, error: "Cycle not found" }); return; }
    const result = await runBillingCycle(cycle, req.user?.id || "MANUAL");
    res.json({ success: true, data: result });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Compute the period label, due date, and idempotency reference tag for the
// current run, based on the cycle's cadence. The reference tag's granularity
// (per-month / per-week / per-day) controls how we dedupe runs.
function computePeriod(cycle: typeof billingCyclesTable.$inferSelect, now: Date) {
  if (cycle.cadence === "WEEKLY") {
    // Iso-week: dueDate = Sunday of this week, period label "Week of YYYY-MM-DD"
    const dow = now.getDay(); // 0=Sun
    const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((dow + 6) % 7));
    const due = new Date(monday); due.setDate(monday.getDate() + 6); // Sunday
    const isoWeekKey = `${monday.getFullYear()}-W${String(getIsoWeek(monday)).padStart(2, "0")}`;
    return {
      periodLabel: `Week of ${monday.toISOString().slice(0, 10)}`,
      dueDate: due,
      refTag: `AUTO:${cycle.id}:${isoWeekKey}`,
    };
  }
  if (cycle.cadence === "CUSTOM_DAYS") {
    const interval = Math.max(1, cycle.customDays || 30);
    const due = new Date(now); due.setHours(0, 0, 0, 0); due.setDate(due.getDate() + interval);
    return {
      periodLabel: `Cycle ending ${due.toISOString().slice(0, 10)}`,
      dueDate: due,
      refTag: `AUTO:${cycle.id}:CUSTOM:${now.toISOString().slice(0, 10)}`,
    };
  }
  // Default: MONTHLY
  return {
    periodLabel: `${now.toLocaleString("en-US", { month: "long" })} ${now.getFullYear()}`,
    dueDate: new Date(now.getFullYear(), now.getMonth(), cycle.dayOfMonth || 5),
    refTag: `AUTO:${cycle.id}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  };
}

function getIsoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// Run a single cycle and persist a run row. Idempotent per (resident, period).
async function runBillingCycle(cycle: typeof billingCyclesTable.$inferSelect, triggeredBy: string) {
  const now = new Date();
  const { periodLabel, dueDate, refTag } = computePeriod(cycle, now);

  const conds = [eq(residentsTable.status, "ACTIVE")];
  if (cycle.propertyId) conds.push(eq(residentsTable.propertyId, cycle.propertyId));
  const eligible = await db.select().from(residentsTable).where(and(...conds));

  const errors: Array<{ residentId: string; reason: string }> = [];
  let success = 0, failed = 0, skipped = 0;

  const description = (cycle.descriptionTemplate || "Rent for {{month}}").replace("{{month}}", periodLabel);

  for (const r of eligible) {
    try {
      if (!r.monthlyRent || Number(r.monthlyRent) <= 0) {
        skipped++; errors.push({ residentId: r.id, reason: "No monthly rent set" }); continue;
      }
      // Idempotency check
      const existing = await db.select({ id: ledgerEntriesTable.id }).from(ledgerEntriesTable)
        .where(and(eq(ledgerEntriesTable.residentId, r.id), eq(ledgerEntriesTable.reference, refTag))).limit(1);
      if (existing.length > 0) { skipped++; continue; }

      await db.insert(ledgerEntriesTable).values({
        id: newId(),
        residentId: r.id,
        type: cycle.ledgerType as "RENT",
        amount: r.monthlyRent.toString(),
        description,
        dueDate,
        isPaid: false,
        reference: refTag,
        createdBy: triggeredBy === "MANUAL" ? null : triggeredBy === "SCHEDULER" ? null : triggeredBy,
        updatedAt: new Date(),
      });
      success++;
    } catch (e) {
      failed++; errors.push({ residentId: r.id, reason: (e as Error).message });
    }
  }

  const [run] = await db.insert(billingRunsTable).values({
    id: newId(),
    cycleId: cycle.id,
    triggeredBy,
    periodLabel,
    successCount: success,
    failedCount: failed,
    skippedCount: skipped,
    totalEligible: eligible.length,
    errors,
    notes: triggeredBy === "SCHEDULER" ? "Auto-triggered by scheduler" : "Manually triggered",
  }).returning();
  await db.update(billingCyclesTable).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(billingCyclesTable.id, cycle.id));
  return run;
}

// ───────────────────────────────────────────────────────
// Reminder rules
// ───────────────────────────────────────────────────────
financeRouter.get("/reminder-rules", authenticate, authorize("REMINDERS", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(reminderRulesTable).orderBy(reminderRulesTable.offsetDays);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/reminder-rules", authenticate, authorize("REMINDERS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.templateBody) { res.status(400).json({ success: false, error: "name and templateBody required" }); return; }
    const [row] = await db.insert(reminderRulesTable).values({
      id: newId(),
      name: b.name,
      offsetDays: b.offsetDays ?? 0,
      channel: b.channel || "EMAIL",
      templateSubject: b.templateSubject || null,
      templateBody: b.templateBody,
      isActive: b.isActive ?? true,
      createdBy: req.user?.id,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.put("/reminder-rules/:id", authenticate, authorize("REMINDERS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "offsetDays", "channel", "templateSubject", "templateBody", "isActive"]) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    const [row] = await db.update(reminderRulesTable).set(updates as never).where(eq(reminderRulesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.delete("/reminder-rules/:id", authenticate, authorize("REMINDERS", "delete"), async (req, res) => {
  try {
    await db.delete(reminderRulesTable).where(eq(reminderRulesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.get("/reminder-logs", authenticate, authorize("REMINDERS", "view"), async (req, res) => {
  try {
    const residentId = req.query["residentId"] as string | undefined;
    const where = residentId ? eq(reminderLogsTable.residentId, residentId) : undefined;
    const rows = await db.select().from(reminderLogsTable).where(where as never).orderBy(desc(reminderLogsTable.createdAt)).limit(200);
    // Enrich with resident name
    const enriched = await Promise.all(rows.map(async (r) => {
      const [res2] = await db.select({ name: residentsTable.name }).from(residentsTable).where(eq(residentsTable.id, r.residentId));
      return { ...r, residentName: res2?.name || null };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/reminder-rules/:id/run", authenticate, authorize("REMINDERS", "create"), async (req, res) => {
  try {
    const [rule] = await db.select().from(reminderRulesTable).where(eq(reminderRulesTable.id, req.params["id"]!));
    if (!rule) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const sent = await runReminderRule(rule, req.user?.id || "MANUAL");
    res.json({ success: true, data: { sent } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Manually re-send a reminder for a specific ledger entry.
financeRouter.post("/reminders/send", authenticate, authorize("REMINDERS", "create"), async (req, res) => {
  try {
    const { ruleId, ledgerEntryId } = req.body || {};
    if (!ruleId || !ledgerEntryId) { res.status(400).json({ success: false, error: "ruleId & ledgerEntryId required" }); return; }
    const [rule] = await db.select().from(reminderRulesTable).where(eq(reminderRulesTable.id, ruleId));
    const [entry] = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.id, ledgerEntryId));
    if (!rule || !entry) { res.status(404).json({ success: false, error: "Rule or entry not found" }); return; }
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, entry.residentId));
    if (!resident) { res.status(404).json({ success: false, error: "Resident not found" }); return; }
    const log = await sendReminder(rule, entry, resident, req.user?.id || "MANUAL");
    res.json({ success: true, data: log });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

function fillTemplate(text: string, vars: Record<string, string | number>) {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ""));
}

async function sendReminder(
  rule: typeof reminderRulesTable.$inferSelect,
  entry: typeof ledgerEntriesTable.$inferSelect,
  resident: typeof residentsTable.$inferSelect,
  triggeredBy: string,
) {
  const dueDateStr = entry.dueDate ? new Date(entry.dueDate).toLocaleDateString("en-IN") : "—";
  const vars = {
    name: resident.name,
    amount: `₹${Number(entry.amount).toLocaleString("en-IN")}`,
    dueDate: dueDateStr,
    description: entry.description,
  };
  const subject = rule.templateSubject ? fillTemplate(rule.templateSubject, vars) : null;
  const body = fillTemplate(rule.templateBody, vars);

  let status: "SENT" | "FAILED" = "SENT";
  let error: string | null = null;

  try {
    if (rule.channel === "INAPP") {
      // Resolve resident → user account by email for in-app notification.
      const linkedUser = resident.email
        ? await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, resident.email)).limit(1)
        : [];
      if (linkedUser.length > 0 && linkedUser[0]) {
        await db.insert(notificationsTable).values({
          id: newId(),
          userId: linkedUser[0].id,
          title: subject || "Rent reminder",
          body,
          type: "RENT_REMINDER",
          link: `/residents/${resident.id}`,
          isRead: false,
        });
      } else {
        // No linked user — fallback to communication log so the message isn't lost
        await db.insert(communicationLogsTable).values({
          id: newId(),
          channel: "INAPP",
          subject,
          body,
          recipientCount: 1,
          recipientFilter: { residentId: resident.id, ruleId: rule.id, fallback: "no_user_account" },
          sentBy: triggeredBy === "MANUAL" || triggeredBy === "SCHEDULER" ? null : triggeredBy,
        });
      }
    } else {
      // EMAIL / SMS — dispatch through the notify engine (enqueueAndSend → SES/SMTP/Twilio).
      // Resolve resident → user account by email; notify() resolves the actual email/phone from
      // the user row and routes the requested channel.
      const linkedUser = resident.email
        ? await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, resident.email)).limit(1)
        : [];
      if (linkedUser.length > 0 && linkedUser[0]) {
        await notify({
          userId: linkedUser[0].id,
          title: subject || "Rent reminder",
          body,
          type: "RENT_REMINDER",
          link: `/residents/${resident.id}`,
          entityType: "LEDGER_ENTRY",
          entityId: entry.id,
          skipInApp: true,
          ...(rule.channel === "EMAIL" ? { email: { subject: subject || "Rent reminder", text: body } } : {}),
          ...(rule.channel === "SMS" ? { sms: body } : {}),
        });
      } else {
        // No linked user account → no email/phone to dispatch to. Record the attempt in
        // communication_logs and mark the reminder FAILED so bookkeeping reflects non-delivery.
        await db.insert(communicationLogsTable).values({
          id: newId(),
          channel: rule.channel,
          subject,
          body,
          recipientCount: 1,
          recipientFilter: { residentId: resident.id, ruleId: rule.id, ledgerEntryId: entry.id, fallback: "no_user_account" },
          sentBy: triggeredBy === "MANUAL" || triggeredBy === "SCHEDULER" ? null : triggeredBy,
        });
        status = "FAILED";
        error = "No linked user account for resident — no email/phone to dispatch to";
      }
    }
  } catch (e) {
    status = "FAILED";
    error = (e as Error).message;
    logger.error({ err: e, ruleId: rule.id, entryId: entry.id }, "Reminder dispatch failed");
  }

  const [log] = await db.insert(reminderLogsTable).values({
    id: newId(),
    ruleId: rule.id,
    ruleName: rule.name,
    residentId: resident.id,
    ledgerEntryId: entry.id,
    channel: rule.channel,
    subject,
    body,
    status,
    triggeredBy: error ? `${triggeredBy} | err: ${error.slice(0, 200)}` : triggeredBy,
  }).returning();
  return log;
}

async function runReminderRule(rule: typeof reminderRulesTable.$inferSelect, triggeredBy: string) {
  if (!rule.isActive) return 0;
  // Find unpaid ledger entries whose dueDate falls on (today - offsetDays).
  // offsetDays<0 means rule fires BEFORE due (so dueDate is in the future).
  // offsetDays>0 means rule fires AFTER due (so dueDate is in the past).
  const dueDay = new Date();
  dueDay.setHours(0, 0, 0, 0);
  dueDay.setDate(dueDay.getDate() - rule.offsetDays);
  const dueEnd = new Date(dueDay);
  dueEnd.setHours(23, 59, 59, 999);

  const entries = await db.select().from(ledgerEntriesTable).where(and(
    eq(ledgerEntriesTable.isPaid, false),
    gte(ledgerEntriesTable.dueDate, dueDay),
    lte(ledgerEntriesTable.dueDate, dueEnd),
  ));

  let sent = 0;
  for (const entry of entries) {
    // Idempotent per (rule, entry) — only one log per rule per entry
    const existing = await db.select({ id: reminderLogsTable.id }).from(reminderLogsTable)
      .where(and(eq(reminderLogsTable.ruleId, rule.id), eq(reminderLogsTable.ledgerEntryId, entry.id))).limit(1);
    if (existing.length > 0) continue;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, entry.residentId));
    if (!resident) continue;
    try {
      await sendReminder(rule, entry, resident, triggeredBy);
      sent++;
    } catch (e) {
      logger.error({ err: e, ruleId: rule.id, entryId: entry.id }, "Reminder send failed");
    }
  }
  return sent;
}

// ───────────────────────────────────────────────────────
// Bank reconciliation
// ───────────────────────────────────────────────────────
financeRouter.get("/bank-imports", authenticate, authorize("BANKING", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(bankImportsTable).orderBy(desc(bankImportsTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/bank-imports", authenticate, authorize("BANKING", "create"), async (req, res) => {
  try {
    const { fileName, accountLabel, csv } = req.body || {};
    if (!fileName || !csv) { res.status(400).json({ success: false, error: "fileName and csv required" }); return; }
    // Parse CSV
    const lines = parseCsv(csv);
    const [imp] = await db.insert(bankImportsTable).values({
      id: newId(),
      fileName,
      accountLabel: accountLabel || null,
      totalLines: lines.length,
      uploadedBy: req.user?.id,
    }).returning();

    let inserted = 0;
    for (const ln of lines) {
      const id = newId();
      await db.insert(bankStatementLinesTable).values({
        id,
        importId: imp.id,
        txnDate: ln.date,
        description: ln.description,
        reference: ln.reference,
        amount: ln.amount.toString(),
        direction: ln.direction,
        status: "UNMATCHED",
      });
      // Suggest match for credits only
      if (ln.direction === "CREDIT") {
        const sug = await suggestMatch(ln.amount, ln.reference, ln.description, ln.date);
        if (sug) {
          await db.update(bankStatementLinesTable).set({
            status: "SUGGESTED",
            matchedResidentId: sug.residentId,
            matchedLedgerEntryId: sug.ledgerEntryId,
            suggestionPayload: sug,
          }).where(eq(bankStatementLinesTable.id, id));
        }
      }
      inserted++;
    }
    res.status(201).json({ success: true, data: { ...imp, inserted } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.get("/bank-imports/:id/lines", authenticate, authorize("BANKING", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(bankStatementLinesTable).where(eq(bankStatementLinesTable.importId, req.params["id"]!)).orderBy(bankStatementLinesTable.txnDate);
    const enriched = await Promise.all(rows.map(async (r) => {
      let residentName: string | null = null;
      if (r.matchedResidentId) {
        const [res2] = await db.select({ name: residentsTable.name }).from(residentsTable).where(eq(residentsTable.id, r.matchedResidentId));
        residentName = res2?.name || null;
      }
      return { ...r, amount: Number(r.amount), residentName };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/bank-lines/:id/confirm", authenticate, authorize("BANKING", "create"), async (req, res) => {
  try {
    const { residentId, ledgerEntryId } = req.body || {};
    const [line] = await db.select().from(bankStatementLinesTable).where(eq(bankStatementLinesTable.id, req.params["id"]!));
    if (!line) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Idempotency guard: already-matched lines must not be reconciled twice
    if (line.status === "MATCHED" || line.matchedPaymentId) {
      res.status(409).json({ success: false, error: "Bank line already reconciled", data: { paymentId: line.matchedPaymentId } });
      return;
    }
    const useResident = residentId || line.matchedResidentId;
    const preselectedEntry: string | null = ledgerEntryId || line.matchedLedgerEntryId || null;
    if (!useResident) { res.status(400).json({ success: false, error: "residentId required" }); return; }

    // Wrap payment-insert + ledger-update + import-counter update in one transaction.
    // The chosen ledger entry is locked FOR UPDATE and re-verified unpaid inside the tx so two
    // bank lines confirmed concurrently can't both pay the same entry (idempotent double-pay guard).
    const pay = await db.transaction(async (tx) => {
      // Resolve the ledger entry to settle. Lock the candidate row(s) FOR UPDATE so the isPaid
      // re-check below sees a consistent, serialized view.
      let useEntry: string | null = null;
      if (preselectedEntry) {
        const [entry] = await tx.select().from(ledgerEntriesTable)
          .where(eq(ledgerEntriesTable.id, preselectedEntry)).for("update");
        if (!entry) throw badRequest("Ledger entry not found");
        if (entry.isPaid) throw httpError(409, "Ledger entry already paid");
        useEntry = entry.id;
      } else {
        // Fallback: lock this resident's unpaid entries, then pick the amount match (preferred)
        // else the oldest unpaid entry — all under the row locks.
        const unpaid = await tx.select().from(ledgerEntriesTable)
          .where(and(eq(ledgerEntriesTable.residentId, useResident), eq(ledgerEntriesTable.isPaid, false)))
          .orderBy(ledgerEntriesTable.createdAt).for("update");
        const match = unpaid.find((e) => Math.abs(Number(e.amount) - Number(line.amount)) < 0.01) || unpaid[0];
        if (match) useEntry = match.id;
      }

      // Create payment & mark ledger paid
      const [payment] = await tx.insert(paymentsTable).values({
        id: newId(),
        residentId: useResident,
        amount: line.amount.toString(),
        mode: "BANK_TRANSFER",
        status: "SUCCESS",
        reference: line.reference || `BANK:${line.id}`,
        notes: `Reconciled from import line: ${line.description}`,
        updatedAt: new Date(),
      }).returning();

      if (useEntry) {
        // Guarded update: only flips an entry that is still unpaid. The row is locked above, so a
        // zero-rowcount here means a concurrent confirm already paid it — abort idempotently.
        const updated = await tx.update(ledgerEntriesTable)
          .set({ isPaid: true, paidOn: line.txnDate, updatedAt: new Date() })
          .where(and(eq(ledgerEntriesTable.id, useEntry), eq(ledgerEntriesTable.isPaid, false)))
          .returning({ id: ledgerEntriesTable.id });
        if (updated.length === 0) throw httpError(409, "Ledger entry already paid");
      }

      await tx.update(bankStatementLinesTable).set({
        status: "MATCHED",
        matchedResidentId: useResident,
        matchedLedgerEntryId: useEntry || null,
        matchedPaymentId: payment!.id,
        reconciledAt: new Date(),
        reconciledBy: req.user?.id,
      }).where(eq(bankStatementLinesTable.id, line.id));

      // Update import counter and flip to RECONCILED when fully matched
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(bankStatementLinesTable)
        .where(and(eq(bankStatementLinesTable.importId, line.importId), eq(bankStatementLinesTable.status, "MATCHED")));
      const [imp] = await tx.select({ totalLines: bankImportsTable.totalLines }).from(bankImportsTable).where(eq(bankImportsTable.id, line.importId));
      const importUpdates: Record<string, unknown> = { matchedLines: count };
      if (imp && count >= imp.totalLines) importUpdates["status"] = "RECONCILED";
      await tx.update(bankImportsTable).set(importUpdates as never).where(eq(bankImportsTable.id, line.importId));

      return payment!;
    });

    res.json({ success: true, data: { paymentId: pay.id } });
  } catch (err: any) {
    if (err?.statusCode === 409) { res.status(409).json({ success: false, error: err.message }); return; }
    if (err?.statusCode === 400) { res.status(400).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

financeRouter.post("/bank-lines/:id/ignore", authenticate, authorize("BANKING", "edit"), async (req, res) => {
  try {
    await db.update(bankStatementLinesTable).set({ status: "IGNORED" }).where(eq(bankStatementLinesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

function parseCsv(csv: string): Array<{ date: Date; description: string; reference: string | null; amount: number; direction: "CREDIT" | "DEBIT" }> {
  const rows = csv.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (rows.length === 0) return [];
  const header = rows[0]!.toLowerCase().split(",").map((h) => h.trim().replace(/"/g, ""));
  const idxDate = header.findIndex((h) => h.includes("date"));
  const idxDesc = header.findIndex((h) => h.includes("desc") || h.includes("narration") || h.includes("particular"));
  const idxRef = header.findIndex((h) => h.includes("ref") || h.includes("utr") || h.includes("txn"));
  const idxCredit = header.findIndex((h) => h === "credit" || h.includes("deposit") || h.includes("credit_amount"));
  const idxDebit = header.findIndex((h) => h === "debit" || h.includes("withdraw") || h.includes("debit_amount"));
  const idxAmount = header.findIndex((h) => h === "amount");

  const out: Array<{ date: Date; description: string; reference: string | null; amount: number; direction: "CREDIT" | "DEBIT" }> = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvLine(rows[i]!);
    if (cells.length < 2) continue;
    const dateStr = (cells[idxDate >= 0 ? idxDate : 0] || "").trim();
    const description = (cells[idxDesc >= 0 ? idxDesc : 1] || "").trim();
    const reference = idxRef >= 0 ? (cells[idxRef] || "").trim() || null : null;
    let amount = 0;
    let direction: "CREDIT" | "DEBIT" = "CREDIT";
    if (idxCredit >= 0 || idxDebit >= 0) {
      const credit = idxCredit >= 0 ? parseFloat((cells[idxCredit] || "0").replace(/,/g, "")) : 0;
      const debit = idxDebit >= 0 ? parseFloat((cells[idxDebit] || "0").replace(/,/g, "")) : 0;
      if (credit > 0) { amount = credit; direction = "CREDIT"; }
      else if (debit > 0) { amount = debit; direction = "DEBIT"; }
    } else if (idxAmount >= 0) {
      const v = parseFloat((cells[idxAmount] || "0").replace(/,/g, ""));
      amount = Math.abs(v);
      direction = v >= 0 ? "CREDIT" : "DEBIT";
    }
    if (!amount || isNaN(amount)) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    out.push({ date: d, description, reference, amount, direction });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

async function suggestMatch(amount: number, reference: string | null, description: string, date: Date) {
  // Strategy: find unpaid ledger entries with same amount (±1 rupee), within 30-day due window.
  const windowStart = new Date(date); windowStart.setDate(windowStart.getDate() - 45);
  const windowEnd = new Date(date); windowEnd.setDate(windowEnd.getDate() + 15);
  const candidates = await db.select({
    id: ledgerEntriesTable.id, residentId: ledgerEntriesTable.residentId, amount: ledgerEntriesTable.amount, dueDate: ledgerEntriesTable.dueDate,
    residentName: residentsTable.name,
  }).from(ledgerEntriesTable)
    .innerJoin(residentsTable, eq(residentsTable.id, ledgerEntriesTable.residentId))
    .where(and(
      eq(ledgerEntriesTable.isPaid, false),
      sql`${ledgerEntriesTable.amount}::numeric BETWEEN ${amount - 1} AND ${amount + 1}`,
      or(isNull(ledgerEntriesTable.dueDate), and(gte(ledgerEntriesTable.dueDate, windowStart), lte(ledgerEntriesTable.dueDate, windowEnd))),
    ));
  if (candidates.length === 0) return null;
  // Prefer match where reference or description contains resident name token
  const refLower = `${reference || ""} ${description || ""}`.toLowerCase();
  let best = candidates[0]!;
  let bestScore = 0;
  for (const c of candidates) {
    let score = 1;
    const tokens = c.residentName.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    for (const t of tokens) if (refLower.includes(t)) score += 5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return {
    residentId: best.residentId,
    ledgerEntryId: best.id,
    residentName: best.residentName,
    confidence: bestScore >= 6 ? "HIGH" : "LOW",
    score: bestScore,
  };
}

// ───────────────────────────────────────────────────────
// Expense management
// ───────────────────────────────────────────────────────
financeRouter.get("/expense-categories", authenticate, authorize("EXPENSES", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(expenseCategoriesTable).orderBy(expenseCategoriesTable.name);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/expense-categories", authenticate, authorize("EXPENSES", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) { res.status(400).json({ success: false, error: "name required" }); return; }
    const [row] = await db.insert(expenseCategoriesTable).values({
      id: newId(), name: b.name, description: b.description || null, isActive: b.isActive ?? true,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.delete("/expense-categories/:id", authenticate, authorize("EXPENSES", "delete"), async (req, res) => {
  try {
    await db.delete(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.get("/expenses", authenticate, authorize("EXPENSES", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const categoryId = req.query["categoryId"] as string | undefined;
    const search = req.query["search"] as string | undefined;
    const conds = [];
    if (propertyId) conds.push(eq(expensesTable.propertyId, propertyId));
    if (status) conds.push(eq(expensesTable.status, status));
    if (categoryId) conds.push(eq(expensesTable.categoryId, categoryId));
    if (search) conds.push(or(ilike(expensesTable.vendor, `%${search}%`), ilike(expensesTable.description, `%${search}%`))!);
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(expensesTable).where(where as never).orderBy(desc(expensesTable.expenseDate)).limit(500);
    const enriched = await Promise.all(rows.map(async (r) => {
      let propertyName: string | null = null;
      let categoryName: string | null = null;
      if (r.propertyId) {
        const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, r.propertyId));
        propertyName = p?.name || null;
      }
      if (r.categoryId) {
        const [c] = await db.select({ name: expenseCategoriesTable.name }).from(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, r.categoryId));
        categoryName = c?.name || null;
      }
      return { ...r, amount: Number(r.amount), propertyName, categoryName };
    }));
    // Totals by status
    const totals = enriched.reduce((acc, e) => {
      acc.total += e.amount;
      acc[e.status] = (acc[e.status] || 0) + e.amount;
      return acc;
    }, { total: 0 } as Record<string, number>);
    res.json({ success: true, data: enriched, meta: { totals } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/expenses", authenticate, authorize("EXPENSES", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.amount || !b.expenseDate) { res.status(400).json({ success: false, error: "amount and expenseDate required" }); return; }
    const [row] = await db.insert(expensesTable).values({
      id: newId(),
      categoryId: b.categoryId || null,
      propertyId: b.propertyId || null,
      vendor: b.vendor || null,
      amount: b.amount.toString(),
      expenseDate: new Date(b.expenseDate),
      description: b.description || null,
      reference: b.reference || null,
      attachment: b.attachment || null,
      status: "SUBMITTED",
      submittedBy: req.user?.id,
      updatedAt: new Date(),
    }).returning();
    await db.insert(expenseEventsTable).values({
      id: newId(), expenseId: row.id, type: "CREATED", actorId: req.user?.id, actorName: req.user?.email,
    });
    res.status(201).json({ success: true, data: { ...row, amount: Number(row.amount) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.put("/expenses/:id", authenticate, authorize("EXPENSES", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["categoryId", "propertyId", "vendor", "description", "reference", "attachment"]) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    if (b.amount !== undefined) updates["amount"] = b.amount.toString();
    if (b.expenseDate) updates["expenseDate"] = new Date(b.expenseDate);
    const [row] = await db.update(expensesTable).set(updates as never).where(eq(expensesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await db.insert(expenseEventsTable).values({
      id: newId(), expenseId: row.id, type: "UPDATED", actorId: req.user?.id, actorName: req.user?.email,
    });
    res.json({ success: true, data: { ...row, amount: Number(row.amount) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.post("/expenses/:id/transition", authenticate, authorize("EXPENSES", "edit"), async (req, res) => {
  try {
    const { action, note } = req.body || {};
    const valid = ["APPROVED", "REJECTED", "PAID"];
    if (!valid.includes(action)) { res.status(400).json({ success: false, error: "Invalid action" }); return; }
    const [current] = await db.select().from(expensesTable).where(eq(expensesTable.id, req.params["id"]!));
    if (!current) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const allowed: Record<string, string[]> = {
      SUBMITTED: ["APPROVED", "REJECTED"],
      APPROVED: ["PAID", "REJECTED"],
      REJECTED: [],
      PAID: [],
    };
    if (!allowed[current.status]?.includes(action)) {
      res.status(409).json({ success: false, error: `Cannot transition from ${current.status} to ${action}` });
      return;
    }
    const updates: Record<string, unknown> = { status: action, updatedAt: new Date() };
    if (action === "REJECTED") updates["rejectionReason"] = note || null;
    if (action === "APPROVED" || action === "REJECTED") {
      updates["reviewedBy"] = req.user?.id;
      updates["reviewedAt"] = new Date();
    }
    if (action === "PAID") updates["paidAt"] = new Date();
    const [row] = await db.update(expensesTable).set(updates as never).where(eq(expensesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    await db.insert(expenseEventsTable).values({
      id: newId(), expenseId: row.id, type: action, actorId: req.user?.id, actorName: req.user?.email, note: note || null,
    });
    res.json({ success: true, data: { ...row, amount: Number(row.amount) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.delete("/expenses/:id", authenticate, authorize("EXPENSES", "delete"), async (req, res) => {
  try {
    await db.delete(expensesTable).where(eq(expensesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

financeRouter.get("/expenses/:id/events", authenticate, authorize("EXPENSES", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(expenseEventsTable).where(eq(expenseEventsTable.expenseId, req.params["id"]!)).orderBy(desc(expenseEventsTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// ───────────────────────────────────────────────────────
// Schedulers (called from index.ts)
// ───────────────────────────────────────────────────────
export async function runDueBillingCycles() {
  try {
    const now = new Date();
    const today = now.getDate();
    const cycles = await db.select().from(billingCyclesTable).where(eq(billingCyclesTable.isActive, true));
    for (const c of cycles) {
      let due = false;
      if (c.cadence === "MONTHLY") {
        // Catch-up: due once today >= dayOfMonth AND not yet run this calendar month
        const dom = c.dayOfMonth || 5;
        const ranThisMonth = c.lastRunAt
          && new Date(c.lastRunAt).getFullYear() === now.getFullYear()
          && new Date(c.lastRunAt).getMonth() === now.getMonth();
        if (today >= dom && !ranThisMonth) due = true;
      } else if (c.cadence === "WEEKLY") {
        // Catch-up: due once a new ISO week has started since last run (or never run)
        const startOfWeek = new Date(now); startOfWeek.setHours(0, 0, 0, 0);
        startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
        if (!c.lastRunAt || new Date(c.lastRunAt).getTime() < startOfWeek.getTime()) due = true;
      } else if (c.cadence === "CUSTOM_DAYS") {
        // Run when at least `customDays` have elapsed since last run
        const interval = Math.max(1, c.customDays || 30);
        if (!c.lastRunAt) {
          due = true;
        } else {
          const elapsed = Math.floor((now.getTime() - new Date(c.lastRunAt).getTime()) / 86400000);
          if (elapsed >= interval) due = true;
        }
      }
      // Avoid double-run within same day
      if (due && c.lastRunAt) {
        const last = new Date(c.lastRunAt);
        if (last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate()) due = false;
      }
      if (due) {
        try { await runBillingCycle(c, "SCHEDULER"); }
        catch (e) { logger.error({ err: e, cycleId: c.id }, "Billing cycle run failed"); }
      }
    }
  } catch (err) { logger.error({ err }, "runDueBillingCycles failed"); }
}

export async function runDueReminders() {
  try {
    const rules = await db.select().from(reminderRulesTable).where(eq(reminderRulesTable.isActive, true));
    for (const r of rules) {
      try { await runReminderRule(r, "SCHEDULER"); }
      catch (e) { logger.error({ err: e, ruleId: r.id }, "Reminder rule run failed"); }
    }
  } catch (err) { logger.error({ err }, "runDueReminders failed"); }
}

// Surface a touch-up: enriched ledger summary used by exec dashboard
financeRouter.get("/finance-summary", authenticate, authorize("LEDGER", "view"), async (_req, res) => {
  try {
    const [expense] = await db.select({ sum: sql<number>`COALESCE(SUM(amount::numeric),0)::float` }).from(expensesTable).where(eq(expensesTable.status, "PAID"));
    const [pending] = await db.select({ sum: sql<number>`COALESCE(SUM(amount::numeric),0)::float` }).from(expensesTable).where(eq(expensesTable.status, "SUBMITTED"));
    const [reminderTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(reminderLogsTable);
    res.json({ success: true, data: { paidExpenses: expense.sum, pendingExpenses: pending.sum, reminderTotal: reminderTotal.count } });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Reminder count for a single resident (used by resident detail page)
financeRouter.get("/residents/:id/reminder-count", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(reminderLogsTable).where(eq(reminderLogsTable.residentId, req.params["id"]!));
    res.json({ success: true, data: { count: row?.count ?? 0 } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
