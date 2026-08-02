/**
 * Audit & Inspection — scheduled jobs (FA-05 materialization, FRD-NTF-02).
 *
 * Registered in src/index.ts under RUN_SCHEDULERS like the complaints SLA job.
 * All actions run as the system actor (P6): events carry actorId = null.
 *
 * Idempotency (FRD-SCH-04 AC / NFR-04): audits carry a unique occurrenceKey
 * `${scheduleId}:${occurrenceISO}:${targetId}` inserted with
 * onConflictDoNothing, and every schedule keeps a lastMaterializedAt watermark
 * — retries and missed windows can never duplicate, and restarts catch up
 * because enumeration resumes from the watermark.
 */
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  auditsTable,
  auditSchedulesTable,
  auditScheduleTargetsTable,
  auditTemplateVersionsTable,
  auditTemplatesTable,
  clustersTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger.js";
import { newId } from "./id.js";
import { notify } from "./notification-service.js";
import { appendAuditEvent } from "./audit-events.js";
import { applyAuditTransition } from "./audit-state.js";
import {
  allocateNumber,
  getAuditSetting,
  maybeAutoCloseAudit,
  AUDIT_SETTING_DEFAULTS,
} from "./audit-service.js";

/* ── Occurrence enumeration ────────────────────────────────────────────────── */

export interface ScheduleLike {
  id: string;
  frequency: string;
  intervalDays: number | null;
  dayOfWeek: number | null;
  cron: string | null;
  timeOfDay: string;
  windowStart: Date;
  windowEnd: Date | null;
}

function atTimeOfDay(day: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h ?? 9, m ?? 0, 0, 0);
  return d;
}

/** Minimal 5-field cron matcher: minute hour dom month dow (* , - / lists). */
export function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      if (rangePart!.includes("-")) {
        const [a, b] = rangePart!.split("-").map(Number);
        lo = a!;
        hi = b!;
      } else {
        lo = hi = Number(rangePart);
      }
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  return (
    cronFieldMatches(minute!, date.getMinutes(), 0, 59) &&
    cronFieldMatches(hour!, date.getHours(), 0, 23) &&
    cronFieldMatches(dom!, date.getDate(), 1, 31) &&
    cronFieldMatches(month!, date.getMonth() + 1, 1, 12) &&
    cronFieldMatches(dow!, date.getDay(), 0, 6)
  );
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((f) => /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/.test(f))
  );
}

/**
 * All occurrence datetimes with fromExclusive < t <= toInclusive, respecting
 * the schedule window. Times are in server-local time, which the deployment
 * pins to the org timezone (NFR-07).
 */
export function enumerateOccurrences(
  schedule: ScheduleLike,
  fromExclusive: Date,
  toInclusive: Date,
): Date[] {
  const windowEnd = schedule.windowEnd;
  const hardEnd = windowEnd && windowEnd < toInclusive ? windowEnd : toInclusive;
  if (schedule.windowStart > hardEnd) return [];

  const out: Date[] = [];
  const push = (d: Date) => {
    if (d > fromExclusive && d <= hardEnd && d >= schedule.windowStart) out.push(d);
  };

  if (schedule.frequency === "CRON" && schedule.cron) {
    // Scan minute-by-minute — bounded by the look-ahead window (days), so at
    // most ~10k iterations per week of horizon.
    const cursor = new Date(Math.max(schedule.windowStart.getTime(), fromExclusive.getTime()));
    cursor.setSeconds(0, 0);
    for (let t = cursor.getTime(); t <= hardEnd.getTime(); t += 60_000) {
      const d = new Date(t);
      if (cronMatches(schedule.cron, d)) push(d);
    }
    return out;
  }

  const first = atTimeOfDay(schedule.windowStart, schedule.timeOfDay);
  const stepDays =
    schedule.frequency === "EVERY_N_DAYS"
      ? Math.min(Math.max(schedule.intervalDays ?? 1, 1), 6)
      : schedule.frequency === "WEEKLY"
        ? 7
        : schedule.frequency === "FORTNIGHTLY"
          ? 14
          : null;
  const stepMonths =
    schedule.frequency === "MONTHLY"
      ? 1
      : schedule.frequency === "QUARTERLY"
        ? 3
        : schedule.frequency === "HALF_YEARLY"
          ? 6
          : schedule.frequency === "ANNUALLY"
            ? 12
            : null;

  if (stepDays != null) {
    let d = new Date(first);
    if (schedule.frequency === "WEEKLY" && schedule.dayOfWeek != null) {
      // Align to the configured day-of-week at/after windowStart.
      while (d.getDay() !== schedule.dayOfWeek) d = new Date(d.getTime() + 86_400_000);
      d = atTimeOfDay(d, schedule.timeOfDay);
    }
    for (; d <= hardEnd; d = atTimeOfDay(new Date(d.getTime() + stepDays * 86_400_000), schedule.timeOfDay)) {
      push(d);
    }
    return out;
  }

  if (stepMonths != null) {
    const anchorDay = first.getDate();
    let cursor = new Date(first);
    while (cursor <= hardEnd) {
      push(cursor);
      const next = new Date(cursor);
      next.setDate(1); // avoid month-length rollover (31 Jan + 1mo)
      next.setMonth(next.getMonth() + stepMonths);
      const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(anchorDay, daysInMonth));
      cursor = atTimeOfDay(next, schedule.timeOfDay);
    }
    return out;
  }

  return out;
}

/* ── Assignee resolution (FRD-ASG-02) ──────────────────────────────────────── */

export interface AssigneeRule {
  kind: "USER" | "ROLE_AT_TARGET";
  userId?: string;
  role?: "UNIT_LEAD" | "CLUSTER_MANAGER";
}

/** Resolve the accountable assignee for a target at materialization time. */
export async function resolveAssignee(
  rule: AssigneeRule,
  propertyId: string,
): Promise<string | null> {
  if (rule.kind === "USER") return rule.userId ?? null;
  if (rule.role === "UNIT_LEAD") {
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.role, "UNIT_LEAD"),
          eq(usersTable.propertyId, propertyId),
          eq(usersTable.isActive, true),
        ),
      )
      .limit(1);
    return user?.id ?? null;
  }
  if (rule.role === "CLUSTER_MANAGER") {
    const [prop] = await db
      .select({ clusterId: propertiesTable.clusterId })
      .from(propertiesTable)
      .where(eq(propertiesTable.id, propertyId));
    if (!prop?.clusterId) return null;
    const [cluster] = await db
      .select({ managerId: clustersTable.managerId })
      .from(clustersTable)
      .where(eq(clustersTable.id, prop.clusterId));
    return cluster?.managerId ?? null;
  }
  return null;
}

/* ── Materializer (FRD-SCH-04) ─────────────────────────────────────────────── */

export async function runAuditMaterializer(): Promise<void> {
  const lookaheadDays = await getAuditSetting(
    "lookahead_days",
    AUDIT_SETTING_DEFAULTS.lookahead_days,
  );
  const now = new Date();
  const horizon = new Date(now.getTime() + Number(lookaheadDays) * 86_400_000);

  const schedules = await db
    .select()
    .from(auditSchedulesTable)
    .where(and(eq(auditSchedulesTable.status, "ACTIVE"), lte(auditSchedulesTable.windowStart, horizon)));

  for (const schedule of schedules) {
    try {
      await materializeSchedule(schedule, now, horizon);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, "audit materializer failed for schedule");
    }
  }

  await flipDueDrafts(now);
}

async function materializeSchedule(
  schedule: typeof auditSchedulesTable.$inferSelect,
  now: Date,
  horizon: Date,
): Promise<void> {
  const fromExclusive = schedule.lastMaterializedAt ?? new Date(schedule.windowStart.getTime() - 1);
  const occurrences = enumerateOccurrences(schedule, fromExclusive, horizon);
  if (occurrences.length === 0) {
    await db
      .update(auditSchedulesTable)
      .set({ lastMaterializedAt: horizon, updatedAt: now })
      .where(eq(auditSchedulesTable.id, schedule.id));
    return;
  }

  const targets = await db
    .select()
    .from(auditScheduleTargetsTable)
    .where(eq(auditScheduleTargetsTable.scheduleId, schedule.id));

  const [version] = await db
    .select({
      id: auditTemplateVersionsTable.id,
      templateId: auditTemplateVersionsTable.templateId,
    })
    .from(auditTemplateVersionsTable)
    .where(eq(auditTemplateVersionsTable.id, schedule.templateVersionId));
  if (!version) return;
  const [template] = await db
    .select({ targetType: auditTemplatesTable.targetType })
    .from(auditTemplatesTable)
    .where(eq(auditTemplatesTable.id, version.templateId));

  // Generated audits carry a snapshot of the LATEST published template content
  // (product decision 2026-07-24): resolve the template's newest PUBLISHED
  // version at materialization time rather than the one pinned when the
  // schedule was created. Falls back to the pinned version if none is
  // published (e.g. it was archived) so generation never silently stops.
  const [latestPublished] = await db
    .select({ id: auditTemplateVersionsTable.id })
    .from(auditTemplateVersionsTable)
    .where(
      and(
        eq(auditTemplateVersionsTable.templateId, version.templateId),
        eq(auditTemplateVersionsTable.lifecycle, "PUBLISHED"),
      ),
    )
    .orderBy(desc(auditTemplateVersionsTable.versionNo))
    .limit(1);
  const generateVersionId = latestPublished?.id ?? schedule.templateVersionId;

  const rule = schedule.assigneeRule as AssigneeRule;

  for (const occurrence of occurrences) {
    for (const target of targets) {
      const propertyId = target.propertyId;
      if (!propertyId) continue;
      const targetId = target.roomId ?? propertyId;
      const occurrenceKey = `${schedule.id}:${occurrence.toISOString()}:${targetId}`;
      const assigneeId = await resolveAssignee(rule, propertyId);
      const state = occurrence <= now ? "SCHEDULED" : "DRAFT";

      await db.transaction(async (tx) => {
        const ticketNo = await allocateNumber(tx, "AUDIT");
        const inserted = await tx
          .insert(auditsTable)
          .values({
            id: newId(),
            ticketNo,
            auditType: schedule.auditType,
            templateVersionId: generateVersionId,
            scheduleId: schedule.id,
            occurrenceKey,
            targetType: template?.targetType ?? target.targetType,
            propertyId,
            roomId: target.roomId ?? null,
            title: schedule.title,
            state,
            assigneeId,
            scheduledFor: occurrence,
            dueAt: occurrence,
            reminderOffsetMinutes: schedule.reminderOffsetMinutes ?? null,
            subsetJson: schedule.subsetJson ?? null,
            reviewRequired: true, // PRD §8.5: every submitted audit is reviewed
            createdBy: null, // system actor
          })
          .onConflictDoNothing({ target: auditsTable.occurrenceKey })
          .returning({ id: auditsTable.id, ticketNo: auditsTable.ticketNo });

        const audit = inserted[0];
        if (!audit) return; // occurrence already materialized (idempotent retry)

        await appendAuditEvent(tx, {
          entityType: "AUDIT",
          entityId: audit.id,
          auditId: audit.id,
          actorId: null,
          actorRole: "SYSTEM",
          kind: "STATE_CHANGE",
          toState: state,
          reason: `Materialized from schedule ${schedule.title}`,
        });
      });
    }
  }

  await db
    .update(auditSchedulesTable)
    .set({ lastMaterializedAt: horizon, updatedAt: now })
    .where(eq(auditSchedulesTable.id, schedule.id));
}

/** Flip Upcoming (DRAFT) occurrences to SCHEDULED once their time arrives. */
async function flipDueDrafts(now: Date): Promise<void> {
  const due = await db
    .select()
    .from(auditsTable)
    .where(and(eq(auditsTable.state, "DRAFT"), lte(auditsTable.scheduledFor, now)))
    .limit(500);

  for (const audit of due) {
    try {
      await db.transaction(async (tx) => {
        await applyAuditTransition(tx, audit, "SCHEDULED", {
          actor: { id: null, role: "SYSTEM" },
          reason: "Occurrence due",
        });
      });
      if (audit.assigneeId) {
        await notify({
          userId: audit.assigneeId,
          title: `Audit assigned: ${audit.ticketNo}`,
          body: `${audit.title} is scheduled for ${audit.scheduledFor?.toLocaleString("en-IN") ?? "now"}.`,
          type: "AUDIT",
          link: `/audits/${audit.id}`,
          entityType: "AUDIT",
          entityId: audit.id,
        });
      }
    } catch (err) {
      logger.error({ err, auditId: audit.id }, "failed to flip draft audit to scheduled");
    }
  }
}

/* ── Pre-occurrence reminders (FRD-NTF-02) ─────────────────────────────────── */

export async function runAuditReminders(): Promise<void> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(auditsTable)
    .where(
      and(
        eq(auditsTable.state, "SCHEDULED"),
        isNull(auditsTable.reminderSentAt),
        sql`${auditsTable.reminderOffsetMinutes} IS NOT NULL`,
        sql`${auditsTable.scheduledFor} - (${auditsTable.reminderOffsetMinutes} * interval '1 minute') <= ${now}`,
      ),
    )
    .limit(200);

  for (const audit of candidates) {
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(auditsTable)
          .set({ reminderSentAt: now, updatedAt: now })
          .where(eq(auditsTable.id, audit.id));
        await appendAuditEvent(tx, {
          entityType: "AUDIT",
          entityId: audit.id,
          auditId: audit.id,
          actorId: null,
          actorRole: "SYSTEM",
          kind: "REMINDER",
          reason: `Pre-occurrence reminder (${audit.reminderOffsetMinutes} min before)`,
        });
      });
      if (audit.assigneeId) {
        await notify({
          userId: audit.assigneeId,
          title: `Reminder: ${audit.ticketNo} due soon`,
          body: `${audit.title} is scheduled for ${audit.scheduledFor?.toLocaleString("en-IN") ?? "soon"}.`,
          type: "AUDIT",
          link: `/audits/${audit.id}`,
          entityType: "AUDIT",
          entityId: audit.id,
        });
      }
    } catch (err) {
      logger.error({ err, auditId: audit.id }, "audit reminder failed");
    }
  }
}

/* ── Audit auto-close safety net (PRD §10: Review → Close) ─────────────────── */

/**
 * Close APPROVED audits. The synchronous path (right after approval) normally
 * gets there first; this job is the catch-up for missed cases and enforces the
 * `auto_close_days` setting (0 = close as soon as approved).
 */
export async function runAuditAutoClose(): Promise<void> {
  const autoCloseDays = Number(
    await getAuditSetting("auto_close_days", AUDIT_SETTING_DEFAULTS.auto_close_days),
  );
  const now = Date.now();
  const approved = await db
    .select()
    .from(auditsTable)
    .where(eq(auditsTable.state, "APPROVED"))
    .limit(500);

  for (const audit of approved) {
    try {
      if (autoCloseDays > 0) {
        const approvedAtMs = (audit.approvedAt ?? audit.updatedAt).getTime();
        if (now < approvedAtMs + autoCloseDays * 86_400_000) continue;
      }
      await maybeAutoCloseAudit(audit.id, { id: null, role: "SYSTEM" });
    } catch (err) {
      logger.error({ err, auditId: audit.id }, "audit auto-close failed");
    }
  }
}

/* ── Overdue flagging (spec §4.1 derived flag) ─────────────────────────────── */

export async function runAuditOverdueCheck(): Promise<void> {
  const now = new Date();
  const overdue = await db
    .select()
    .from(auditsTable)
    .where(
      and(
        inArray(auditsTable.state, ["SCHEDULED", "IN_PROGRESS", "PAUSED"]),
        eq(auditsTable.isOverdue, false),
        sql`${auditsTable.dueAt} < ${now}`,
      ),
    )
    .limit(500);

  for (const audit of overdue) {
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(auditsTable)
          .set({ isOverdue: true, updatedAt: now })
          .where(eq(auditsTable.id, audit.id));
        await appendAuditEvent(tx, {
          entityType: "AUDIT",
          entityId: audit.id,
          auditId: audit.id,
          actorId: null,
          actorRole: "SYSTEM",
          kind: "STATE_CHANGE",
          fromState: audit.state,
          toState: audit.state,
          reason: "Overdue flag set (past due date)",
        });
      });
      if (audit.assigneeId) {
        await notify({
          userId: audit.assigneeId,
          title: `Overdue: ${audit.ticketNo}`,
          body: `${audit.title} passed its due date and is now flagged overdue.`,
          type: "AUDIT",
          link: `/audits/${audit.id}`,
          entityType: "AUDIT",
          entityId: audit.id,
        });
      }
    } catch (err) {
      logger.error({ err, auditId: audit.id }, "audit overdue flagging failed");
    }
  }
}

