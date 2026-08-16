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
  citiesTable,
  clustersTable,
  propertiesTable,
  roomsTable,
  zonesTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { appendAuditEvent } from "../lib/audit-events.js";
import { auditActor } from "../lib/audit-service.js";
import { enumerateOccurrences, isValidCron } from "../lib/audit-jobs.js";
import { describeScope, resolveScheduleTargets, resolveScope, validateScope } from "../lib/audit-scope.js";
import {
  addExdate,
  dateOnly,
  endRuleBefore,
  legacyToRule,
  removeExdate,
  ruleToLegacy,
  ruleToWindowEnd,
  validateRule,
} from "../lib/audit-recurrence.js";

const router: IRouter = Router();

const FREQUENCIES = [
  "EVERY_N_DAYS", "WEEKLY", "FORTNIGHTLY", "MONTHLY",
  "QUARTERLY", "HALF_YEARLY", "ANNUALLY", "CRON", "NONE",
] as const;

const targetSchema = z.object({
  targetType: z.enum(["PROPERTY", "ROOM"]),
  propertyId: z.string().nullish(),
  roomId: z.string().nullish(),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar-style recurrence rule. Shape-checked here; the cross-field rules
 * (a weekly rule needs a weekday, cron cannot end after N) live in
 * `validateRule` so the engine and the API can never disagree.
 */
const recurrenceSchema = z.object({
  freq: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY", "CRON"]),
  interval: z.number().int().min(1).max(365).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
  byMonthDay: z.number().int().min(-1).max(31).nullish(),
  bySetPos: z.number().int().min(-1).max(4).nullish(),
  byMonth: z.number().int().min(1).max(12).nullish(),
  cron: z.string().max(100).nullish(),
  end: z.union([
    z.object({ kind: z.literal("NEVER") }),
    z.object({ kind: z.literal("ON"), date: z.string().regex(ISO_DATE) }),
    z.object({ kind: z.literal("AFTER"), count: z.number().int().min(1).max(1000) }),
  ]),
  exdates: z.array(z.string().regex(ISO_DATE)).optional(),
});

/**
 * Hierarchical scope. Re-resolved at every occurrence, so the estate changing
 * is picked up automatically — see lib/audit-scope.ts.
 */
const scopeSchema = z.object({
  level: z.enum(["ORG", "ZONE", "CITY", "CLUSTER", "PROPERTY", "ROOM"]),
  ids: z.array(z.string().min(1)).default([]),
});

/**
 * ROLE_AT_TARGET names a persona, not a person: whoever holds that role at each
 * target property conducts the audit, resolved fresh at every occurrence. The
 * four roles are the ones `resolveAssigneeDetailed` can resolve — and they are
 * also its escalation chain, so an unfilled role falls upward rather than
 * orphaning the audit.
 */
const ASSIGNABLE_ROLES = ["UNIT_LEAD", "CLUSTER_MANAGER", "CITY_HEAD", "ZONAL_HEAD"] as const;

const assigneeRuleSchema = z.union([
  z.object({ kind: z.literal("USER"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("ROLE_AT_TARGET"), role: z.enum(ASSIGNABLE_ROLES) }),
]);

const scheduleSchema = z.object({
  title: z.string().min(1).max(200),
  templateVersionId: z.string().min(1),
  /** Optional once `recurrence` is supplied — it is derived from the rule. */
  frequency: z.enum(FREQUENCIES).optional(),
  recurrence: recurrenceSchema.optional(),
  // Was capped at 6, which made "every 10 days" unrepresentable.
  intervalDays: z.number().int().min(1).max(365).nullish(),
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  cron: z.string().max(100).nullish(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "timeOfDay must be HH:mm"),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date().nullish(),
  reminderOffsetMinutes: z.number().int().min(0).max(600).nullish(),
  assigneeRule: assigneeRuleSchema,
  subsetJson: z
    .object({ sectionIds: z.array(z.string()).optional(), questionIds: z.array(z.string()).optional() })
    .nullish(),
  /** Legacy explicit targets. Optional once `scope` is supplied. */
  targets: z.array(targetSchema).min(1).optional(),
  scope: scopeSchema.optional(),
});

/**
 * `validateTargets` is off for a PATCH that does not replace scope — the caller
 * passes a placeholder target to satisfy the shared schema's `.min(1)`, and
 * resolving it would 404.
 */
async function validateScheduleInput(
  data: z.infer<typeof scheduleSchema>,
  { validateTargets = true }: { validateTargets?: boolean } = {},
) {
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

  // The recurrence rule is authoritative. A body without one is a legacy
  // caller, so its cadence columns are mapped to an equivalent rule and the
  // old mandatory-windowEnd contract still applies to it.
  if (data.recurrence) {
    if (data.recurrence.freq === "CRON" && !isValidCron(data.recurrence.cron ?? "")) {
      throw httpError(422, "Invalid cron expression (5 fields)");
    }
  } else {
    if (!data.frequency) throw httpError(422, "A recurrence rule or a frequency is required");
    if (data.frequency === "CRON") {
      if (!data.cron || !isValidCron(data.cron)) throw httpError(422, "Invalid cron expression (5 fields)");
    }
    if (data.frequency === "EVERY_N_DAYS" && !data.intervalDays) {
      throw httpError(422, "intervalDays required for EVERY_N_DAYS");
    }
    if (data.frequency !== "CRON" && data.frequency !== "NONE" && data.windowEnd == null) {
      throw httpError(422, "windowEnd is required for recurring schedules");
    }
  }
  if (data.windowEnd && data.windowEnd < data.windowStart) {
    throw httpError(422, "windowEnd must be after windowStart");
  }

  const rule =
    data.recurrence ??
    legacyToRule({
      frequency: data.frequency!,
      intervalDays: data.intervalDays ?? null,
      dayOfWeek: data.dayOfWeek ?? null,
      cron: data.cron ?? null,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd ?? null,
    });
  const problem = validateRule(rule);
  if (problem) throw httpError(422, problem);

  const ruleEnd = ruleToWindowEnd(rule);
  if (ruleEnd && ruleEnd < data.windowStart) {
    throw httpError(422, "The recurrence ends before it starts");
  }

  if (data.scope) {
    const scopeProblem = validateScope(data.scope);
    if (scopeProblem) throw httpError(422, scopeProblem);
    // A ROOM-level scope on a property template would silently audit the whole
    // property instead of the chosen rooms — reject it rather than surprise.
    if (data.scope.level === "ROOM" && template.targetType !== "ROOM") {
      throw httpError(422, "This template audits properties — scope it at property level or above");
    }
  } else if (validateTargets && !data.targets?.length) {
    throw httpError(422, "A scope or at least one target is required");
  }

  // Validate targets against the template's target type.
  const resolvedTargets: { targetType: "PROPERTY" | "ROOM"; propertyId: string; roomId: string | null }[] = [];
  for (const t of validateTargets ? (data.targets ?? []) : []) {
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

  return { version, template, resolvedTargets, rule };
}

/**
 * The row columns a rule implies. `frequency` is NOT NULL and older readers
 * still derive their label from it, so it is kept in sync rather than dropped.
 * With an explicit rule the end condition wins; a legacy body keeps its own
 * windowEnd so nothing about its behaviour shifts.
 */
function recurrenceColumns(
  rule: ReturnType<typeof legacyToRule>,
  explicitRule: boolean,
  legacyWindowEnd: Date | null,
) {
  const legacy = ruleToLegacy(rule);
  return {
    frequency: legacy.frequency as (typeof FREQUENCIES)[number],
    intervalDays: legacy.intervalDays,
    dayOfWeek: legacy.dayOfWeek,
    cron: legacy.cron,
    recurrenceJson: rule,
    windowEnd: explicitRule ? ruleToWindowEnd(rule) : legacyWindowEnd,
  };
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
        // Scope-based schedules have no stored rows — the UI shows the rule.
        targetCount: targetMap.get(r.schedule.id) ?? 0,
        scopeLabel: r.schedule.scopeJson ? describeScope(r.schedule.scopeJson) : null,
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
    const { template, resolvedTargets, rule } = await validateScheduleInput(parsed.data);

    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const [schedule] = await tx
        .insert(auditSchedulesTable)
        .values({
          id: newId(),
          title: parsed.data.title,
          templateVersionId: parsed.data.templateVersionId,
          auditType: template.auditType,
          ...recurrenceColumns(rule, !!parsed.data.recurrence, parsed.data.windowEnd ?? null),
          scopeJson: parsed.data.scope ?? null,
          timeOfDay: parsed.data.timeOfDay,
          windowStart: parsed.data.windowStart,
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

/**
 * Options for the scope picker, one level at a time.
 *
 * The hierarchy already has list endpoints under /food/*, but they are gated on
 * FOOD_ORG — a permission no audit persona holds — so scheduling gets its own
 * read behind AUDIT_SCHEDULES.
 */
router.get(
  "/view/scope-options",
  authenticate,
  authorize("AUDIT_SCHEDULES", "view"),
  async (req, res) => {
    const level = String(req.query["level"] ?? "").toUpperCase();
    const propertyId = req.query["propertyId"] as string | undefined;

    if (level === "ZONE") {
      const rows = await db
        .select({ id: zonesTable.id, name: zonesTable.name })
        .from(zonesTable)
        .where(eq(zonesTable.isActive, true))
        .orderBy(asc(zonesTable.name));
      return res.json({ success: true, data: rows });
    }
    if (level === "CITY") {
      const rows = await db
        .select({ id: citiesTable.id, name: citiesTable.name, sublabel: zonesTable.name })
        .from(citiesTable)
        .leftJoin(zonesTable, eq(zonesTable.id, citiesTable.zoneId))
        .where(eq(citiesTable.isActive, true))
        .orderBy(asc(citiesTable.name));
      return res.json({ success: true, data: rows });
    }
    if (level === "CLUSTER") {
      const rows = await db
        .select({ id: clustersTable.id, name: clustersTable.name, sublabel: citiesTable.name })
        .from(clustersTable)
        .leftJoin(citiesTable, eq(citiesTable.id, clustersTable.cityId))
        .where(eq(clustersTable.isActive, true))
        .orderBy(asc(clustersTable.name));
      return res.json({ success: true, data: rows });
    }
    if (level === "PROPERTY") {
      const rows = await db
        .select({ id: propertiesTable.id, name: propertiesTable.name, sublabel: propertiesTable.city })
        .from(propertiesTable)
        .orderBy(asc(propertiesTable.name));
      return res.json({ success: true, data: rows });
    }
    if (level === "ROOM") {
      if (!propertyId) throw httpError(400, "propertyId is required for room-level scope options");
      const rows = await db
        .select({ id: roomsTable.id, name: roomsTable.number, sublabel: propertiesTable.name })
        .from(roomsTable)
        .leftJoin(propertiesTable, eq(propertiesTable.id, roomsTable.propertyId))
        .where(eq(roomsTable.propertyId, propertyId))
        .orderBy(asc(roomsTable.number));
      return res.json({ success: true, data: rows });
    }
    // ORG needs no options — it means everything.
    return res.json({ success: true, data: [] });
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
    /**
     * The row stores only `templateVersionId`; the editor needs the template it
     * belongs to in order to preselect it (and, through its targetType, to
     * render the target picker at all). The list endpoint joins for this — the
     * detail one has to as well, or editing a schedule opens with no template.
     */
    const [version] = await db
      .select({
        templateId: auditTemplateVersionsTable.templateId,
        versionNo: auditTemplateVersionsTable.versionNo,
        templateName: auditTemplatesTable.name,
        // Needed to resolve a scope: the template's grain decides whether the
        // rule expands to properties or to their rooms.
        targetType: auditTemplatesTable.targetType,
      })
      .from(auditTemplateVersionsTable)
      .leftJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
      .where(eq(auditTemplateVersionsTable.id, schedule.templateVersionId));
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
        // Resolved live, so the editor shows what the scope covers right now
        // rather than what it covered when the schedule was created.
        resolvedTargetCount: schedule.scopeJson
          ? (await resolveScope(schedule.scopeJson, (version?.targetType as "PROPERTY" | "ROOM") ?? "PROPERTY")).length
          : targets.length,
        templateId: version?.templateId ?? null,
        templateName: version?.templateName ?? null,
        templateVersionNo: version?.versionNo ?? null,
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
      recurrence: req.body.recurrence ?? existing.recurrenceJson ?? undefined,
      scope: req.body.scope ?? existing.scopeJson ?? undefined,
    });
    if (!parsed.success) throw httpError(400, "Invalid schedule", parsed.error.flatten());

    const replaceTargets = Array.isArray(req.body.targets);
    const { resolvedTargets, rule } = await validateScheduleInput(parsed.data, {
      validateTargets: replaceTargets,
    });

    const actor = auditActor(req);
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditSchedulesTable)
        .set({
          title: parsed.data.title,
          ...recurrenceColumns(rule, !!parsed.data.recurrence, parsed.data.windowEnd ?? null),
          scopeJson: parsed.data.scope ?? null,
          timeOfDay: parsed.data.timeOfDay,
          windowStart: parsed.data.windowStart,
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

/** The rule a schedule runs on — stored, or mapped from its legacy columns. */
function ruleOf(schedule: typeof auditSchedulesTable.$inferSelect) {
  return schedule.recurrenceJson ?? legacyToRule(schedule);
}

/**
 * Drop not-yet-live occurrences on a given local date. Only DRAFT rows go —
 * once an occurrence has flipped to SCHEDULED it is somebody's assigned work,
 * and silently deleting it would erase an audit from their queue.
 */
async function deleteDraftOccurrencesOn(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scheduleId: string,
  dateKey: string,
) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dayStart = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59, 999));
  await tx
    .delete(auditsTable)
    .where(
      and(
        eq(auditsTable.scheduleId, scheduleId),
        eq(auditsTable.state, "DRAFT"),
        gte(auditsTable.scheduledFor, dayStart),
        lte(auditsTable.scheduledFor, dayEnd),
      ),
    );
}

const occurrenceSchema = z.object({
  date: z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
});

/**
 * Skip / restore one occurrence — the calendar's "delete this event".
 *
 * The skip is stored as an exclusion date on the rule rather than by deleting
 * rows, so it survives the materializer regenerating the window.
 */
for (const action of ["skip", "restore"] as const) {
  router.post(
    `/:id/occurrences/${action}`,
    authenticate,
    authorize("AUDIT_SCHEDULES", "edit"),
    async (req, res) => {
      const parsed = occurrenceSchema.safeParse(req.body);
      if (!parsed.success) throw httpError(400, "Invalid occurrence", parsed.error.flatten());
      const [existing] = await db
        .select()
        .from(auditSchedulesTable)
        .where(eq(auditSchedulesTable.id, req.params["id"] as string));
      if (!existing) throw httpError(404, "Schedule not found");
      if (existing.status === "ENDED") throw httpError(409, "Schedule has ended");

      const { date } = parsed.data;
      const next =
        action === "skip"
          ? addExdate(ruleOf(existing), date)
          : removeExdate(ruleOf(existing), date);

      const actor = auditActor(req);
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(auditSchedulesTable)
          .set({
            recurrenceJson: next,
            // Rewind so the materializer re-derives this window from the new rule.
            lastMaterializedAt: now,
            updatedAt: now,
          })
          .where(eq(auditSchedulesTable.id, existing.id))
          .returning();
        if (action === "skip") await deleteDraftOccurrencesOn(tx, existing.id, date);
        await appendAuditEvent(tx, {
          entityType: "SCHEDULE",
          entityId: existing.id,
          actorId: actor.id,
          actorRole: actor.role,
          kind: "CONFIG_CHANGE",
          beforeJson: { exdates: ruleOf(existing).exdates ?? [] },
          afterJson: { exdates: next.exdates ?? [] },
          reason: action === "skip" ? `Occurrence ${date} skipped` : `Occurrence ${date} restored`,
        });
        return row!;
      });
      res.json({ success: true, data: updated });
    },
  );
}

const splitSchema = z.object({
  fromDate: z.string().regex(ISO_DATE, "fromDate must be YYYY-MM-DD"),
  recurrence: recurrenceSchema,
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  assigneeRule: assigneeRuleSchema.optional(),
  reminderOffsetMinutes: z.number().int().min(0).max(600).nullish(),
});

/**
 * "This and following" (calendar semantics): truncate this schedule to end the
 * day before `fromDate`, and start a successor carrying the new rule from that
 * date. Targets, template pin and subset are copied so the programme continues
 * against the same scope.
 *
 * A split is two schedules by design — the history of what was already
 * generated stays attached to the original, which the audit trail depends on.
 */
router.post(
  "/:id/split",
  authenticate,
  authorize("AUDIT_SCHEDULES", "edit"),
  async (req, res) => {
    const parsed = splitSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid split", parsed.error.flatten());
    const [existing] = await db
      .select()
      .from(auditSchedulesTable)
      .where(eq(auditSchedulesTable.id, req.params["id"] as string));
    if (!existing) throw httpError(404, "Schedule not found");
    if (existing.status === "ENDED") throw httpError(409, "Schedule has ended");

    const problem = validateRule(parsed.data.recurrence);
    if (problem) throw httpError(422, problem);

    const splitAt = dateOnly(parsed.data.fromDate)!;
    if (splitAt <= existing.windowStart) {
      throw httpError(422, "Split date must be after the schedule starts — edit the schedule instead");
    }

    const head = endRuleBefore(ruleOf(existing), parsed.data.fromDate);
    const tail = parsed.data.recurrence;
    const targets = await db
      .select()
      .from(auditScheduleTargetsTable)
      .where(eq(auditScheduleTargetsTable.scheduleId, existing.id));

    const actor = auditActor(req);
    const now = new Date();
    const created = await db.transaction(async (tx) => {
      await tx
        .update(auditSchedulesTable)
        .set({
          recurrenceJson: head,
          windowEnd: ruleToWindowEnd(head),
          lastMaterializedAt: now,
          updatedAt: now,
        })
        .where(eq(auditSchedulesTable.id, existing.id));

      // Un-started occurrences from the split date on belong to the successor.
      await tx
        .delete(auditsTable)
        .where(
          and(
            eq(auditsTable.scheduleId, existing.id),
            eq(auditsTable.state, "DRAFT"),
            gte(auditsTable.scheduledFor, splitAt),
          ),
        );

      const [successor] = await tx
        .insert(auditSchedulesTable)
        .values({
          id: newId(),
          title: existing.title,
          templateVersionId: existing.templateVersionId,
          auditType: existing.auditType,
          ...recurrenceColumns(tail, true, null),
          timeOfDay: parsed.data.timeOfDay ?? existing.timeOfDay,
          windowStart: splitAt,
          reminderOffsetMinutes:
            parsed.data.reminderOffsetMinutes !== undefined
              ? parsed.data.reminderOffsetMinutes
              : existing.reminderOffsetMinutes,
          assigneeRule: parsed.data.assigneeRule ?? existing.assigneeRule,
          subsetJson: existing.subsetJson,
          createdBy: actor.id,
        })
        .returning();

      for (const t of targets) {
        await tx.insert(auditScheduleTargetsTable).values({
          id: newId(),
          scheduleId: successor!.id,
          targetType: t.targetType,
          propertyId: t.propertyId,
          roomId: t.roomId,
        });
      }

      await appendAuditEvent(tx, {
        entityType: "SCHEDULE",
        entityId: existing.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "CONFIG_CHANGE",
        beforeJson: { recurrence: ruleOf(existing) },
        afterJson: { recurrence: head, successorId: successor!.id },
        reason: `Split at ${parsed.data.fromDate} — this and following`,
      });
      await appendAuditEvent(tx, {
        entityType: "SCHEDULE",
        entityId: successor!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "ACTIVE",
        reason: `Continues ${existing.id} from ${parsed.data.fromDate}`,
        afterJson: { recurrence: tail, targets: targets.length },
      });
      return successor!;
    });
    res.status(201).json({ success: true, data: created });
  },
);

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
    // Skipped occurrences are absent from `projected` by construction, so the
    // calendar needs them separately to render (and offer to restore) them.
    const skipped: { scheduleId: string; title: string; date: string }[] = [];
    for (const s of schedules) {
      for (const date of ruleOf(s).exdates ?? []) {
        const at = new Date(`${date}T12:00:00`);
        if (at >= from && at <= to) skipped.push({ scheduleId: s.id, title: s.title, date });
      }
      const watermark = s.lastMaterializedAt ?? new Date(s.windowStart.getTime() - 1);
      const start = watermark > from ? watermark : from;
      if (start >= to) continue;
      const occurrences = enumerateOccurrences(s, start, to);
      if (occurrences.length === 0) continue;
      /* Scope-based schedules keep no target rows — counting them would render
         every projected occurrence as "×0". Resolve the rule instead. */
      const [tv] = await db
        .select({ targetType: auditTemplatesTable.targetType })
        .from(auditTemplateVersionsTable)
        .leftJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
        .where(eq(auditTemplateVersionsTable.id, s.templateVersionId));
      const resolvedCount = (
        await resolveScheduleTargets(s, (tv?.targetType as "PROPERTY" | "ROOM") ?? "PROPERTY")
      ).length;
      for (const occurrence of occurrences) {
        projected.push({
          scheduleId: s.id,
          title: s.title,
          auditType: s.auditType,
          occurrence,
          targetCount: resolvedCount,
        });
      }
    }

    res.json({ success: true, data: { audits, projected, skipped } });
  },
);

export { router as auditSchedulesRouter };
