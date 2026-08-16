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
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  auditsTable,
  auditSchedulesTable,
  auditScheduleTargetsTable,
  auditTemplateVersionsTable,
  auditTemplatesTable,
  citiesTable,
  clustersTable,
  propertiesTable,
  userScopesTable,
  usersTable,
  type RecurrenceRule,
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
import { enumerateFromRule, legacyToRule } from "./audit-recurrence.js";
import { resolveScheduleTargets } from "./audit-scope.js";

// Cron helpers moved to audit-recurrence.ts; re-exported so existing importers
// (and the schedule routes) keep working against one implementation.
export {
  cronFieldMatches,
  cronMatches,
  isValidCron,
  atTimeOfDay,
} from "./audit-recurrence.js";

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
  /** Null on rows written before the rule model — mapped from the columns above. */
  recurrenceJson?: RecurrenceRule | null;
}

/**
 * All occurrence datetimes with fromExclusive < t <= toInclusive.
 *
 * The recurrence rule is the source of truth; pre-rule rows are mapped from
 * their legacy cadence columns so their occurrences do not shift. Times are
 * server-local, which the deployment pins to the org timezone (NFR-07).
 */
export function enumerateOccurrences(
  schedule: ScheduleLike,
  fromExclusive: Date,
  toInclusive: Date,
): Date[] {
  const rule = schedule.recurrenceJson ?? legacyToRule(schedule);
  // Legacy rows are bounded by windowEnd; a rule carries its own end condition,
  // and windowEnd is only a denormalised date for those — clamping on it would
  // clip occurrences on the final day.
  const windowEnd = schedule.recurrenceJson ? null : schedule.windowEnd;
  const hardEnd = windowEnd && windowEnd < toInclusive ? windowEnd : toInclusive;
  return enumerateFromRule(rule, schedule.timeOfDay, schedule.windowStart, fromExclusive, hardEnd);
}

/* ── Assignee resolution (FRD-ASG-02) ──────────────────────────────────────── */

export interface AssigneeRule {
  kind: "USER" | "ROLE_AT_TARGET";
  userId?: string;
  /** Any rung of the escalation chain — see ESCALATION_CHAIN below. */
  role?: EscalationRole;
}

/**
 * Who a role resolves to at a property, one rung at a time.
 *
 * UNIT_LEAD reads users.propertyId; CLUSTER_MANAGER reads the cluster's owner;
 * CITY_HEAD and ZONAL_HEAD read the `user_scopes` grants the org hierarchy uses.
 */
async function holderOfRole(role: EscalationRole, propertyId: string): Promise<string | null> {
  if (role === "UNIT_LEAD") {
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
      // Deterministic pick when a property has more than one — nothing in the
      // schema forbids it, and an arbitrary winner makes assignment unstable.
      .orderBy(asc(usersTable.id))
      .limit(1);
    return user?.id ?? null;
  }

  const [prop] = await db
    .select({ clusterId: propertiesTable.clusterId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  if (!prop?.clusterId) return null;

  if (role === "CLUSTER_MANAGER") {
    const [cluster] = await db
      .select({ managerId: clustersTable.managerId })
      .from(clustersTable)
      .where(eq(clustersTable.id, prop.clusterId));
    return cluster?.managerId ?? null;
  }

  const [cluster] = await db
    .select({ cityId: clustersTable.cityId })
    .from(clustersTable)
    .where(eq(clustersTable.id, prop.clusterId));
  if (!cluster?.cityId) return null;

  if (role === "CITY_HEAD") {
    const [row] = await db
      .select({ id: usersTable.id })
      .from(userScopesTable)
      .innerJoin(usersTable, eq(usersTable.id, userScopesTable.userId))
      .where(
        and(
          eq(userScopesTable.cityId, cluster.cityId),
          eq(userScopesTable.isActive, true),
          eq(usersTable.role, "CITY_HEAD"),
          eq(usersTable.isActive, true),
        ),
      )
      .orderBy(asc(usersTable.id))
      .limit(1);
    return row?.id ?? null;
  }

  // ZONAL_HEAD — the city's zone.
  const [city] = await db
    .select({ zoneId: citiesTable.zoneId })
    .from(citiesTable)
    .where(eq(citiesTable.id, cluster.cityId));
  if (!city?.zoneId) return null;
  const [row] = await db
    .select({ id: usersTable.id })
    .from(userScopesTable)
    .innerJoin(usersTable, eq(usersTable.id, userScopesTable.userId))
    .where(
      and(
        eq(userScopesTable.zoneId, city.zoneId),
        eq(userScopesTable.isActive, true),
        eq(usersTable.role, "ZONAL_HEAD"),
        eq(usersTable.isActive, true),
      ),
    )
    .orderBy(asc(usersTable.id))
    .limit(1);
  return row?.id ?? null;
}

export type EscalationRole = "UNIT_LEAD" | "CLUSTER_MANAGER" | "CITY_HEAD" | "ZONAL_HEAD";

/** Escalation order — each rung falls back to the next one up. */
const ESCALATION_CHAIN: EscalationRole[] = ["UNIT_LEAD", "CLUSTER_MANAGER", "CITY_HEAD", "ZONAL_HEAD"];

export interface AssigneeResolution {
  userId: string | null;
  /** The role that actually produced the assignee, if any. */
  role: EscalationRole | null;
  /** True when the configured role had no holder and we walked up the chain. */
  escalated: boolean;
}

/**
 * Resolve the accountable assignee, escalating up the org hierarchy when the
 * configured role has no holder at that property.
 *
 * An unresolvable assignee used to be written as NULL with no warning and no
 * event: the audit got a ticket number, went overdue, and appeared in nobody's
 * queue — every notify call is guarded on assigneeId. Escalating keeps the work
 * owned by someone; the caller records the fallback on the audit trail.
 */
export async function resolveAssigneeDetailed(
  rule: AssigneeRule,
  propertyId: string,
): Promise<AssigneeResolution> {
  if (rule.kind === "USER") {
    return { userId: rule.userId ?? null, role: null, escalated: false };
  }
  const start = ESCALATION_CHAIN.indexOf((rule.role ?? "UNIT_LEAD") as EscalationRole);
  const chain = start >= 0 ? ESCALATION_CHAIN.slice(start) : ESCALATION_CHAIN;
  for (const [i, role] of chain.entries()) {
    const userId = await holderOfRole(role, propertyId);
    if (userId) return { userId, role, escalated: i > 0 };
  }
  return { userId: null, role: null, escalated: false };
}

/** Resolve the accountable assignee for a target at materialization time. */
export async function resolveAssignee(
  rule: AssigneeRule,
  propertyId: string,
): Promise<string | null> {
  return (await resolveAssigneeDetailed(rule, propertyId)).userId;
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

  /* Scope is resolved HERE, on every materialization run — not read from a
     snapshot taken when the schedule was created. A property added to a cluster
     (or a room added to a property) is therefore audited from its next
     occurrence, with no edit to the schedule. Pre-scope schedules fall back to
     their stored target rows, so their behaviour is unchanged. */
  const targets = await resolveScheduleTargets(
    schedule,
    (template?.targetType as "PROPERTY" | "ROOM") ?? "PROPERTY",
  );
  if (targets.length === 0) {
    logger.warn(
      { scheduleId: schedule.id, scope: schedule.scopeJson },
      "audit schedule resolved to zero targets — nothing generated this run",
    );
  }

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
      /* Escalates up the org chain when the configured role has no holder here.
         An unassigned audit is invisible: every notify call is guarded on
         assigneeId, and /audits/my filters on it — so it would go overdue in
         nobody's queue. Both the fallback and the give-up are recorded. */
      const resolution = await resolveAssigneeDetailed(rule, propertyId);
      const assigneeId = resolution.userId;
      if (resolution.escalated) {
        logger.info(
          { scheduleId: schedule.id, propertyId, from: rule.role, to: resolution.role },
          "audit assignee escalated — configured role had no holder at this property",
        );
      } else if (!assigneeId) {
        logger.warn(
          { scheduleId: schedule.id, propertyId, role: rule.role },
          "audit has no assignee — nobody in the escalation chain covers this property",
        );
      }
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

