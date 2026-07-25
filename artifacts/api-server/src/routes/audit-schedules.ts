/**
 * Audit & Inspection — scheduling & recurrence routes (FA-05, FRD-SCH-01..07).
 * CX audits are ad-hoc only and can never be scheduler-generated (C-3): any
 * attempt to schedule a CX-type template is rejected with 422.
 */
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditsTable,
  auditSchedulesTable,
  auditScheduleTargetsTable,
  auditTemplatesTable,
  auditTemplateVersionsTable,
  propertiesTable,
  roomsTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { appendAuditEvent } from "../lib/audit-events.js";
import { auditActor } from "../lib/audit-service.js";
import { enumerateOccurrences, isValidCron } from "../lib/audit-jobs.js";

const router: IRouter = Router();

const FREQUENCIES = [
  "EVERY_N_DAYS", "WEEKLY", "FORTNIGHTLY", "MONTHLY",
  "QUARTERLY", "HALF_YEARLY", "ANNUALLY", "CRON",
] as const;

const targetSchema = z.object({
  targetType: z.enum(["PROPERTY", "ROOM"]),
  propertyId: z.string().nullish(),
  roomId: z.string().nullish(),
});

const scheduleSchema = z.object({
  title: z.string().min(1).max(200),
  templateVersionId: z.string().min(1),
  frequency: z.enum(FREQUENCIES),
  intervalDays: z.number().int().min(1).max(6).nullish(),
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  cron: z.string().max(100).nullish(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "timeOfDay must be HH:mm"),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date().nullish(),
  reminderOffsetMinutes: z.number().int().min(0).max(600).nullish(),
  assigneeRule: z.union([
    z.object({ kind: z.literal("USER"), userId: z.string().min(1) }),
    z.object({ kind: z.literal("ROLE_AT_TARGET"), role: z.enum(["UNIT_LEAD", "CLUSTER_MANAGER"]) }),
  ]),
  subsetJson: z
    .object({ sectionIds: z.array(z.string()).optional(), questionIds: z.array(z.string()).optional() })
    .nullish(),
  targets: z.array(targetSchema).min(1),
});

async function validateScheduleInput(data: z.infer<typeof scheduleSchema>) {
  const [version] = await db
    .select()
    .from(auditTemplateVersionsTable)
    .where(eq(auditTemplateVersionsTable.id, data.templateVersionId));
  if (!version) throw httpError(404, "Template version not found");
  if (version.lifecycle !== "PUBLISHED") {
    throw httpError(422, "Schedules can only pin PUBLISHED template versions");
  }
  const [template] = await db
    .select()
    .from(auditTemplatesTable)
    .where(eq(auditTemplatesTable.id, version.templateId));
  if (!template) throw httpError(404, "Template not found");
  if (template.auditType === "CX") {
    // C-3: CX audits are ad-hoc "surprise" audits only — never scheduled.
    throw httpError(422, "CX audits are ad-hoc only and cannot be scheduled (ruling C-3)");
  }

  if (data.frequency === "CRON") {
    if (!data.cron || !isValidCron(data.cron)) throw httpError(422, "Invalid cron expression (5 fields)");
  }
  if (data.frequency === "EVERY_N_DAYS" && !data.intervalDays) {
    throw httpError(422, "intervalDays (1–6) required for EVERY_N_DAYS");
  }
  if (data.frequency !== "CRON" && data.windowEnd == null) {
    throw httpError(422, "windowEnd is required for recurring schedules");
  }
  if (data.windowEnd && data.windowEnd < data.windowStart) {
    throw httpError(422, "windowEnd must be after windowStart");
  }

  // Validate targets against the template's target type.
  const resolvedTargets: { targetType: "PROPERTY" | "ROOM"; propertyId: string; roomId: string | null }[] = [];
  for (const t of data.targets) {
    if (template.targetType === "ROOM") {
      if (!t.roomId) throw httpError(422, "This template audits rooms — every target needs a roomId");
      const [room] = await db
        .select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
        .from(roomsTable)
        .where(eq(roomsTable.id, t.roomId));
      if (!room) throw httpError(404, `Room ${t.roomId} not found`);
      resolvedTargets.push({ targetType: "ROOM", propertyId: room.propertyId, roomId: room.id });
    } else {
      if (!t.propertyId) throw httpError(422, "Every target needs a propertyId");
      const [prop] = await db
        .select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, t.propertyId));
      if (!prop) throw httpError(404, `Property ${t.propertyId} not found`);
      resolvedTargets.push({ targetType: "PROPERTY", propertyId: prop.id, roomId: null });
    }
  }

  return { version, template, resolvedTargets };
}

/** List schedules with template + target counts. */
router.get(
  "/",
  authenticate,
  authorize("AUDIT_SCHEDULES", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const status = (req.query["status"] as string | undefined)?.toUpperCase();

    const where = status ? eq(auditSchedulesTable.status, status) : undefined;
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditSchedulesTable)
      .where(where);
    const rows = await db
      .select({
        schedule: auditSchedulesTable,
        versionNo: auditTemplateVersionsTable.versionNo,
        templateId: auditTemplateVersionsTable.templateId,
        templateName: auditTemplatesTable.name,
      })
      .from(auditSchedulesTable)
      .leftJoin(
        auditTemplateVersionsTable,
        eq(auditTemplateVersionsTable.id, auditSchedulesTable.templateVersionId),
      )
      .leftJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
      .where(where)
      .orderBy(desc(auditSchedulesTable.createdAt))
      .limit(limit)
      .offset(offset);

    const scheduleIds = rows.map((r) => r.schedule.id);
    const targetCounts = scheduleIds.length
      ? await db
          .select({
            scheduleId: auditScheduleTargetsTable.scheduleId,
            count: sql<number>`count(*)::int`,
          })
          .from(auditScheduleTargetsTable)
          .where(inArray(auditScheduleTargetsTable.scheduleId, scheduleIds))
          .groupBy(auditScheduleTargetsTable.scheduleId)
      : [];
    const auditCounts = scheduleIds.length
      ? await db
          .select({ scheduleId: auditsTable.scheduleId, count: sql<number>`count(*)::int` })
          .from(auditsTable)
          .where(inArray(auditsTable.scheduleId, scheduleIds))
          .groupBy(auditsTable.scheduleId)
      : [];
    const targetMap = new Map(targetCounts.map((t) => [t.scheduleId, t.count]));
    const auditMap = new Map(auditCounts.map((a) => [a.scheduleId, a.count]));

    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.schedule,
        templateName: r.templateName,
        templateVersionNo: r.versionNo,
        templateId: r.templateId,
        targetCount: targetMap.get(r.schedule.id) ?? 0,
        auditsGenerated: auditMap.get(r.schedule.id) ?? 0,
      })),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

/** Create a recurring schedule (FRD-SCH-01/02/03). */
router.post(
  "/",
  authenticate,
  authorize("AUDIT_SCHEDULES", "create"),
  async (req, res) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid schedule", parsed.error.flatten());
    const { template, resolvedTargets } = await validateScheduleInput(parsed.data);

    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const [schedule] = await tx
        .insert(auditSchedulesTable)
        .values({
          id: newId(),
          title: parsed.data.title,
          templateVersionId: parsed.data.templateVersionId,
          auditType: template.auditType,
          frequency: parsed.data.frequency,
          intervalDays: parsed.data.intervalDays ?? null,
          dayOfWeek: parsed.data.dayOfWeek ?? null,
          cron: parsed.data.cron ?? null,
          timeOfDay: parsed.data.timeOfDay,
          windowStart: parsed.data.windowStart,
          windowEnd: parsed.data.windowEnd ?? null,
          reminderOffsetMinutes: parsed.data.reminderOffsetMinutes ?? null,
          assigneeRule: parsed.data.assigneeRule,
          subsetJson: parsed.data.subsetJson ?? null,
          createdBy: actor.id,
        })
        .returning();
      for (const t of resolvedTargets) {
        await tx.insert(auditScheduleTargetsTable).values({
          id: newId(),
          scheduleId: schedule!.id,
          targetType: t.targetType,
          propertyId: t.propertyId,
          roomId: t.roomId,
        });
      }
      await appendAuditEvent(tx, {
        entityType: "SCHEDULE",
        entityId: schedule!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "ACTIVE",
        reason: "Schedule created",
        afterJson: { title: schedule!.title, frequency: schedule!.frequency, targets: resolvedTargets.length },
      });
      return schedule!;
    });
    res.status(201).json({ success: true, data: created });
  },
);

/** Schedule detail with targets. */
router.get(
  "/:id",
  authenticate,
  authorize("AUDIT_SCHEDULES", "view"),
  async (req, res) => {
    const [schedule] = await db
      .select()
      .from(auditSchedulesTable)
      .where(eq(auditSchedulesTable.id, req.params["id"] as string));
    if (!schedule) throw httpError(404, "Schedule not found");
    const targets = await db
      .select({
        target: auditScheduleTargetsTable,
        propertyName: propertiesTable.name,
        roomNumber: roomsTable.number,
      })
      .from(auditScheduleTargetsTable)
      .leftJoin(propertiesTable, eq(propertiesTable.id, auditScheduleTargetsTable.propertyId))
      .leftJoin(roomsTable, eq(roomsTable.id, auditScheduleTargetsTable.roomId))
      .where(eq(auditScheduleTargetsTable.scheduleId, schedule.id));
    res.json({
      success: true,
      data: {
        ...schedule,
        targets: targets.map((t) => ({ ...t.target, propertyName: t.propertyName, roomNumber: t.roomNumber })),
      },
    });
  },
);

/**
 * Edit a schedule — affects FUTURE occurrences only (FRD-SCH-06): un-started
 * future DRAFT occurrences are removed and the watermark rewinds to now so the
 * materializer regenerates them from the new definition.
 */
router.patch(
  "/:id",
  authenticate,
  authorize("AUDIT_SCHEDULES", "edit"),
  async (req, res) => {
    const [existing] = await db
      .select()
      .from(auditSchedulesTable)
      .where(eq(auditSchedulesTable.id, req.params["id"] as string));
    if (!existing) throw httpError(404, "Schedule not found");
    if (existing.status === "ENDED") throw httpError(409, "Schedule has ended");

    const parsed = scheduleSchema.safeParse({
      ...req.body,
      templateVersionId: req.body.templateVersionId ?? existing.templateVersionId,
      title: req.body.title ?? existing.title,
      frequency: req.body.frequency ?? existing.frequency,
      timeOfDay: req.body.timeOfDay ?? existing.timeOfDay,
      windowStart: req.body.windowStart ?? existing.windowStart,
      windowEnd: req.body.windowEnd ?? existing.windowEnd,
      assigneeRule: req.body.assigneeRule ?? existing.assigneeRule,
      targets: req.body.targets ?? [{ targetType: "PROPERTY", propertyId: "placeholder" }],
      intervalDays: req.body.intervalDays ?? existing.intervalDays,
      dayOfWeek: req.body.dayOfWeek ?? existing.dayOfWeek,
      cron: req.body.cron ?? existing.cron,
      reminderOffsetMinutes: req.body.reminderOffsetMinutes ?? existing.reminderOffsetMinutes,
      subsetJson: req.body.subsetJson ?? existing.subsetJson,
    });
    if (!parsed.success) throw httpError(400, "Invalid schedule", parsed.error.flatten());

    const replaceTargets = Array.isArray(req.body.targets);
    const { resolvedTargets } = replaceTargets
      ? await validateScheduleInput(parsed.data)
      : { resolvedTargets: null as never };

    const actor = auditActor(req);
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditSchedulesTable)
        .set({
          title: parsed.data.title,
          frequency: parsed.data.frequency,
          intervalDays: parsed.data.intervalDays ?? null,
          dayOfWeek: parsed.data.dayOfWeek ?? null,
          cron: parsed.data.cron ?? null,
          timeOfDay: parsed.data.timeOfDay,
          windowStart: parsed.data.windowStart,
          windowEnd: parsed.data.windowEnd ?? null,
          reminderOffsetMinutes: parsed.data.reminderOffsetMinutes ?? null,
          assigneeRule: parsed.data.assigneeRule,
          subsetJson: parsed.data.subsetJson ?? null,
          // Rewind so future occurrences regenerate from the new definition.
          lastMaterializedAt: now,
          updatedAt: now,
        })
        .where(eq(auditSchedulesTable.id, existing.id))
        .returning();

      if (replaceTargets && resolvedTargets) {
        await tx
          .delete(auditScheduleTargetsTable)
          .where(eq(auditScheduleTargetsTable.scheduleId, existing.id));
        for (const t of resolvedTargets) {
          await tx.insert(auditScheduleTargetsTable).values({
            id: newId(),
            scheduleId: existing.id,
            targetType: t.targetType,
            propertyId: t.propertyId,
            roomId: t.roomId,
          });
        }
      }

      // Future-only effects: drop not-yet-live occurrences of the old shape.
      await tx
        .delete(auditsTable)
        .where(
          and(
            eq(auditsTable.scheduleId, existing.id),
            eq(auditsTable.state, "DRAFT"),
            gte(auditsTable.scheduledFor, now),
          ),
        );

      await appendAuditEvent(tx, {
        entityType: "SCHEDULE",
        entityId: existing.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "CONFIG_CHANGE",
        beforeJson: existing,
        afterJson: row,
        reason: "Schedule edited (future occurrences only)",
      });
      return row!;
    });
    res.json({ success: true, data: updated });
  },
);

for (const action of ["pause", "resume", "end"] as const) {
  router.post(
    `/:id/${action}`,
    authenticate,
    authorize("AUDIT_SCHEDULES", "edit"),
    async (req, res) => {
      const [existing] = await db
        .select()
        .from(auditSchedulesTable)
        .where(eq(auditSchedulesTable.id, req.params["id"] as string));
      if (!existing) throw httpError(404, "Schedule not found");
      if (existing.status === "ENDED") throw httpError(409, "Schedule has ended");
      const next = action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : "ENDED";
      if (action === "resume" && existing.status !== "PAUSED") {
        throw httpError(409, "Only paused schedules can resume");
      }

      const actor = auditActor(req);
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(auditSchedulesTable)
          .set({
            status: next,
            // Resuming skips the paused gap rather than backfilling it.
            ...(action === "resume" ? { lastMaterializedAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(auditSchedulesTable.id, existing.id))
          .returning();
        await appendAuditEvent(tx, {
          entityType: "SCHEDULE",
          entityId: existing.id,
          actorId: actor.id,
          actorRole: actor.role,
          kind: "STATE_CHANGE",
          fromState: existing.status,
          toState: next,
          reason: `Schedule ${action}d`,
        });
        return row!;
      });
      res.json({ success: true, data: updated });
    },
  );
}

/**
 * Calendar (FRD-SCH-05): materialized audits in range + projected occurrences
 * beyond the materialization horizon, so planners see the full pipeline.
 */
router.get(
  "/view/calendar",
  authenticate,
  authorize("AUDIT_SCHEDULES", "view"),
  async (req, res) => {
    const from = req.query["from"] ? new Date(req.query["from"] as string) : new Date();
    const to = req.query["to"]
      ? new Date(req.query["to"] as string)
      : new Date(from.getTime() + 31 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      throw httpError(400, "Invalid from/to range");
    }

    const audits = await db
      .select({
        id: auditsTable.id,
        ticketNo: auditsTable.ticketNo,
        title: auditsTable.title,
        state: auditsTable.state,
        isOverdue: auditsTable.isOverdue,
        auditType: auditsTable.auditType,
        scheduledFor: auditsTable.scheduledFor,
        propertyId: auditsTable.propertyId,
        propertyName: propertiesTable.name,
        assigneeId: auditsTable.assigneeId,
        scheduleId: auditsTable.scheduleId,
      })
      .from(auditsTable)
      .leftJoin(propertiesTable, eq(propertiesTable.id, auditsTable.propertyId))
      .where(and(gte(auditsTable.scheduledFor, from), lte(auditsTable.scheduledFor, to)))
      .orderBy(asc(auditsTable.scheduledFor))
      .limit(2000);

    // Project occurrences past each schedule's watermark (not yet materialized).
    const schedules = await db
      .select()
      .from(auditSchedulesTable)
      .where(eq(auditSchedulesTable.status, "ACTIVE"));
    const projected: {
      scheduleId: string;
      title: string;
      auditType: string;
      occurrence: Date;
      targetCount: number;
    }[] = [];
    for (const s of schedules) {
      const watermark = s.lastMaterializedAt ?? new Date(s.windowStart.getTime() - 1);
      const start = watermark > from ? watermark : from;
      if (start >= to) continue;
      const occurrences = enumerateOccurrences(s, start, to);
      if (occurrences.length === 0) continue;
      const [tc] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditScheduleTargetsTable)
        .where(eq(auditScheduleTargetsTable.scheduleId, s.id));
      for (const occurrence of occurrences) {
        projected.push({
          scheduleId: s.id,
          title: s.title,
          auditType: s.auditType,
          occurrence,
          targetCount: tc?.count ?? 0,
        });
      }
    }

    res.json({ success: true, data: { audits, projected } });
  },
);

export { router as auditSchedulesRouter };
