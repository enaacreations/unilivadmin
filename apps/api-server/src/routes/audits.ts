/**
 * Audit & Inspection — audit register & work queues (FA-07) + detail (FA-08).
 * P1 scope: scoped register list, "My audits" queue, detail with Activity
 * events. State actions, execution grid, responses, evidence and submit land
 * in P3; one-off creation in P2/P3.
 *
 * Every list composes scopeAuditsCondition() so scoped-out rows are absent
 * everywhere including counts (FRD-ACC-05 AC).
 */
import express, { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditsTable,
  auditEventsTable,
  auditEvidenceTable,
  auditQuestionsTable,
  auditReportsTable,
  auditResponsesTable,
  auditReviewsTable,
  auditTemplatesTable,
  auditTemplateVersionsTable,
  auditPerformanceBandsTable,
  propertiesTable,
  roomsTable,
  usersTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize, authorizeAny } from "../middlewares/authorize.js";
import { httpError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { notify } from "../lib/notification-service.js";
import { appendAuditEvent, recordAuditEvent } from "../lib/audit-events.js";
import { applyAuditTransition, canTransition, AUDIT_TRANSITIONS, type AuditState } from "../lib/audit-state.js";
import {
  resolveAuditAccess,
  scopeAuditsCondition,
  canView,
  canConduct,
  visibleAuditTypes,
  conductableAuditTypes,
  conductablePropertyIds,
  type AuditType,
} from "../lib/audit-access.js";
import {
  auditActor,
  allocateNumber,
  assertLiveGeoCapture,
  findLiveProof,
  getAuditSetting,
  getAttachmentPolicy,
  computeSubmitBlockers,
  evidenceUrl,
  loadExecutionQuestions,
  parseDataUrl,
  storeEvidence,
  AUDIT_SETTING_DEFAULTS,
  LIVE_PROOF_MAX_AGE_MS,
} from "../lib/audit-service.js";
import { scoreAudit, resolveMultiplier, type RatingScaleSnapshot } from "../lib/audit-scoring.js";
import { resolveAssignee, type AssigneeRule } from "../lib/audit-jobs.js";

const router: IRouter = Router();

const ACTIVE_STATES = ["SCHEDULED", "IN_PROGRESS", "PAUSED", "REJECTED"] as const;
const COMPLETED_STATES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CLOSED"] as const;

/**
 * A SQL `IN (...)` list for a FILTER clause. Compared against `state::text` so
 * no pg-enum array cast is needed. Safe to interpolate: the inputs are the
 * compile-time constants above, never request data.
 */
const stateList = (states: readonly string[]) =>
  sql.raw(`(${states.map((s) => `'${s}'`).join(", ")})`);

/**
 * A day boundary for comparing against a `timestamp` column, built from LOCAL
 * date parts.
 *
 * `new Date("2026-08-08")` parses as UTC midnight, but node-postgres formats
 * Date values using the local offset and Postgres discards that offset for
 * `timestamp without time zone`. In a +05:30 deployment the bound therefore
 * arrived as 05:30, which sits ABOVE the 03:30 these columns store for a
 * 09:00 IST occurrence — so "audits scheduled today" returned nothing.
 * Building from local parts makes the literal the DB receives match the day
 * the user picked. See the timestamp convention note in the schema.
 */
function dayBound(iso: string, edge: "start" | "end"): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return edge === "start"
    ? new Date(y!, m! - 1, d!, 0, 0, 0, 0)
    : new Date(y!, m! - 1, d!, 23, 59, 59, 999);
}

async function enrich(rows: (typeof auditsTable.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const propertyIds = [...new Set(rows.map((r) => r.propertyId))];
  const assigneeIds = [...new Set(rows.map((r) => r.assigneeId).filter(Boolean))] as string[];
  const roomIds = [...new Set(rows.map((r) => r.roomId).filter(Boolean))] as string[];

  const props = propertyIds.length
    ? await db.select({ id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city }).from(propertiesTable).where(inArray(propertiesTable.id, propertyIds))
    : [];
  const users = assigneeIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable).where(inArray(usersTable.id, assigneeIds))
    : [];
  const rooms = roomIds.length
    ? await db.select({ id: roomsTable.id, number: roomsTable.number }).from(roomsTable).where(inArray(roomsTable.id, roomIds))
    : [];

  const propMap = new Map(props.map((p) => [p.id, p]));
  const userMap = new Map(users.map((u) => [u.id, u]));
  const roomMap = new Map(rooms.map((r) => [r.id, r]));

  return rows.map((r) => ({
    ...r,
    propertyName: propMap.get(r.propertyId)?.name ?? null,
    propertyCity: propMap.get(r.propertyId)?.city ?? null,
    roomNumber: r.roomId ? roomMap.get(r.roomId)?.number ?? null : null,
    assigneeName: r.assigneeId ? userMap.get(r.assigneeId)?.name ?? null : null,
    assigneeRole: r.assigneeId ? userMap.get(r.assigneeId)?.role ?? null : null,
  }));
}

/** Register (FRD-REG-01/02/03): server pagination, segments, filters. */
router.get(
  "/",
  authenticate,
  authorize("AUDIT_REGISTER", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;
    const access = await resolveAuditAccess(req.user!);

    const conditions = [];
    const scope = scopeAuditsCondition(access);
    if (scope) conditions.push(scope);

    const segment = q["segment"];
    if (segment === "active") conditions.push(inArray(auditsTable.state, [...ACTIVE_STATES]));
    if (segment === "completed") conditions.push(inArray(auditsTable.state, [...COMPLETED_STATES]));
    if (q["state"]) {
      const states = q["state"].split(",").filter(Boolean);
      if (states.length) conditions.push(inArray(auditsTable.state, states as never[]));
    }
    if (q["auditType"]) conditions.push(eq(auditsTable.auditType, q["auditType"] as AuditType));
    if (q["propertyId"]) conditions.push(eq(auditsTable.propertyId, q["propertyId"]));
    if (q["assigneeId"]) conditions.push(eq(auditsTable.assigneeId, q["assigneeId"]));
    // Accept the usual truthy spellings — a silently-ignored "overdue=1"
    // returns the unfiltered set, which reads as "nothing is overdue".
    if (["true", "1", "yes"].includes(String(q["overdue"] ?? "").toLowerCase())) {
      conditions.push(eq(auditsTable.isOverdue, true));
    }
    if (q["q"]) {
      const like = "%" + q["q"] + "%";
      conditions.push(
        sql`(${auditsTable.ticketNo} ILIKE ${like} OR ${auditsTable.title} ILIKE ${like})`,
      );
    }
    /* Filter the date the register actually SHOWS. The column is "Scheduled"
       and the pickers sit beside it, but this ranged over createdAt — so
       narrowing to a day when audits are scheduled returned nothing, because
       those rows were created weeks earlier. */
    if (q["from"]) conditions.push(sql`${auditsTable.scheduledFor} >= ${dayBound(q["from"], "start")}`);
    if (q["to"]) conditions.push(sql`${auditsTable.scheduledFor} <= ${dayBound(q["to"], "end")}`);
    const where = conditions.length ? and(...conditions) : undefined;

    const sortCol = q["sort"] === "dueAt" ? auditsTable.dueAt : auditsTable.createdAt;
    const order = q["dir"] === "asc" ? asc(sortCol) : desc(sortCol);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditsTable)
      .where(where);
    const rows = await db
      .select()
      .from(auditsTable)
      .where(where)
      .orderBy(order)
      .limit(limit)
      .offset(offset);

    res.json({
      success: true,
      data: await enrich(rows),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

/** Audit types the caller may see — drives type pickers and dashboard tabs. */
router.get(
  "/visible-types",
  authenticate,
  authorize("AUDIT_REGISTER", "view"),
  async (req, res) => {
    const access = await resolveAuditAccess(req.user!);
    res.json({ success: true, data: visibleAuditTypes(access) });
  },
);

/**
 * One-off / ad-hoc audit creation (FRD-SCH-01). This is the ONLY path for CX
 * audits — they are ad-hoc "surprise" audits, never scheduler-generated (C-3).
 * The caller must have conduct access (AUDITOR/ADMin grant, or global admin)
 * for the audit's type at the target property.
 */
const oneOffSchema = z.object({
  templateVersionId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  targetType: z.enum(["PROPERTY", "ROOM"]),
  propertyId: z.string().nullish(),
  roomId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeRule: z.enum(["UNIT_LEAD", "CLUSTER_MANAGER", "CITY_HEAD", "ZONAL_HEAD"]).nullish(),
  scheduledFor: z.coerce.date().nullish(),
  dueAt: z.coerce.date().nullish(),
  reminderOffsetMinutes: z.number().int().min(0).max(600).nullish(),
  subsetJson: z
    .object({ sectionIds: z.array(z.string()).optional(), questionIds: z.array(z.string()).optional() })
    .nullish(),
});

router.post(
  "/",
  authenticate,
  authorize("AUDIT_EXECUTION", "create"),
  async (req, res) => {
    const parsed = oneOffSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid audit", parsed.error.flatten());
    const data = parsed.data;

    // Resolve the requested version, then upgrade to the template's LATEST
    // published version (product decision 2026-07-24: an audit carries a
    // snapshot of the latest template content at creation, whether the caller
    // pinned an older version id or not).
    const [picked] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, data.templateVersionId));
    if (!picked) throw httpError(404, "Template version not found");
    const [version] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(
        and(
          eq(auditTemplateVersionsTable.templateId, picked.templateId),
          eq(auditTemplateVersionsTable.lifecycle, "PUBLISHED"),
        ),
      )
      .orderBy(desc(auditTemplateVersionsTable.versionNo))
      .limit(1);
    if (!version) throw httpError(422, "Audits can only run a PUBLISHED template version");
    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, version.templateId));
    if (!template) throw httpError(404, "Template not found");

    // Resolve + validate the target, deriving the parent property for scoping.
    let propertyId: string;
    let roomId: string | null = null;
    if (template.targetType === "ROOM") {
      if (!data.roomId) throw httpError(422, "This template audits rooms — roomId is required");
      const [room] = await db
        .select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
        .from(roomsTable)
        .where(eq(roomsTable.id, data.roomId));
      if (!room) throw httpError(404, "Room not found");
      propertyId = room.propertyId;
      roomId = room.id;
    } else {
      if (!data.propertyId) throw httpError(422, "propertyId is required");
      const [prop] = await db
        .select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, data.propertyId));
      if (!prop) throw httpError(404, "Property not found");
      propertyId = prop.id;
    }

    // Conduct-access gate (FRD-ACC-05): the caller must be allowed to conduct
    // this audit type at this property. CX flows through here for the CX team.
    const access = await resolveAuditAccess(req.user!);
    if (!canConduct(access, template.auditType as AuditType, propertyId)) {
      await recordAuditEvent({
        entityType: "AUDIT",
        entityId: "new",
        actorId: req.user!.id,
        actorRole: req.user!.role,
        kind: "DENIED_ATTEMPT",
        reason: `Attempt to create ${template.auditType} audit at ${propertyId} without conduct access`,
      });
      throw httpError(403, `You cannot conduct ${template.auditType} audits at this property`);
    }

    // Resolve the assignee: explicit user, a role-at-target rule, or the creator.
    let assigneeId: string | null = data.assigneeId ?? null;
    if (!assigneeId && data.assigneeRule) {
      const rule: AssigneeRule = { kind: "ROLE_AT_TARGET", role: data.assigneeRule };
      assigneeId = await resolveAssignee(rule, propertyId);
    }
    if (!assigneeId) assigneeId = req.user!.id; // self-assign ad-hoc audits by default
    const [assignee] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, assigneeId));
    if (!assignee) throw httpError(404, "Assignee not found");

    const now = new Date();
    const scheduledFor = data.scheduledFor ?? now;
    // Ad-hoc audits are actionable immediately: SCHEDULED (not DRAFT/Upcoming).
    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const ticketNo = await allocateNumber(tx, "AUDIT");
      const [audit] = await tx
        .insert(auditsTable)
        .values({
          id: newId(),
          ticketNo,
          auditType: template.auditType,
          templateVersionId: version.id,
          scheduleId: null,
          occurrenceKey: null,
          targetType: template.targetType,
          propertyId,
          roomId,
          title: data.title,
          description: data.description ?? null,
          state: "SCHEDULED",
          assigneeId,
          scheduledFor,
          dueAt: data.dueAt ?? scheduledFor,
          reminderOffsetMinutes: data.reminderOffsetMinutes ?? null,
          subsetJson: data.subsetJson ?? null,
          reviewRequired: true, // PRD §8.5: every submitted audit is reviewed
          createdBy: actor.id,
        })
        .returning();
      await appendAuditEvent(tx, {
        entityType: "AUDIT",
        entityId: audit!.id,
        auditId: audit!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "SCHEDULED",
        reason: `Ad-hoc ${template.auditType} audit created`,
      });
      return audit!;
    });

    // Notify the assignee if it isn't the creator.
    if (created.assigneeId && created.assigneeId !== actor.id) {
      await notify({
        userId: created.assigneeId,
        title: `Audit assigned: ${created.ticketNo}`,
        body: `${created.title} — ${template.auditType} audit`,
        type: "AUDIT",
        link: `/audits/${created.id}`,
        entityType: "AUDIT",
        entityId: created.id,
      });
    }

    res.status(201).json({ success: true, data: created });
  },
);

/**
 * Read helpers backing the create-audit form (FRD-SCH-01). These are gated on
 * AUDIT_EXECUTION so a conductor (e.g. the CX team) who has no template/property
 * module permission can still pick what to audit — the results are filtered to
 * exactly what the caller may conduct (resolveAuditAccess), so this exposes
 * nothing beyond their conduct scope.
 */
router.get(
  "/conductable-templates",
  authenticate,
  authorize("AUDIT_EXECUTION", "create"),
  async (req, res) => {
    const access = await resolveAuditAccess(req.user!);
    const types = conductableAuditTypes(access);
    if (types.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    // Latest PUBLISHED version per template, for the caller's conductable types.
    const templates = await db
      .select()
      .from(auditTemplatesTable)
      .where(and(inArray(auditTemplatesTable.auditType, types), isNull(auditTemplatesTable.archivedAt)));
    const data = [];
    for (const t of templates) {
      const [latest] = await db
        .select({ id: auditTemplateVersionsTable.id, versionNo: auditTemplateVersionsTable.versionNo })
        .from(auditTemplateVersionsTable)
        .where(and(eq(auditTemplateVersionsTable.templateId, t.id), eq(auditTemplateVersionsTable.lifecycle, "PUBLISHED")))
        .orderBy(desc(auditTemplateVersionsTable.versionNo))
        .limit(1);
      if (!latest) continue; // no published version → not runnable
      data.push({
        id: t.id,
        name: t.name,
        auditType: t.auditType,
        targetType: t.targetType,
        category: t.category,
        latestVersionId: latest.id,
        latestVersionNo: latest.versionNo,
      });
    }
    res.json({ success: true, data });
  },
);

/** Properties where the caller may conduct the given audit type. */
router.get(
  "/target-properties",
  authenticate,
  authorize("AUDIT_EXECUTION", "create"),
  async (req, res) => {
    const auditType = String(req.query["auditType"] ?? "") as AuditType;
    if (!(["UL", "CM", "CX"] as string[]).includes(auditType)) {
      throw httpError(400, "auditType query param required (UL|CM|CX)");
    }
    const access = await resolveAuditAccess(req.user!);
    const allowed = conductablePropertyIds(access, auditType);
    if (allowed !== null && allowed.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const rows = await db
      .select({ id: propertiesTable.id, name: propertiesTable.name, city: propertiesTable.city })
      .from(propertiesTable)
      .where(
        allowed === null
          ? eq(propertiesTable.status, "ACTIVE")
          : and(eq(propertiesTable.status, "ACTIVE"), inArray(propertiesTable.id, allowed)),
      )
      .orderBy(propertiesTable.name);
    res.json({ success: true, data: rows });
  },
);

/**
 * Version content (sections + questions) for the create-form subset picker,
 * accessible to conductors of the version's audit type. Read-only, minimal.
 */
router.get(
  "/template-version/:vid",
  authenticate,
  authorize("AUDIT_EXECUTION", "create"),
  async (req, res) => {
    const [version] = await db
      .select({ id: auditTemplateVersionsTable.id, versionNo: auditTemplateVersionsTable.versionNo, templateId: auditTemplateVersionsTable.templateId })
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, req.params["vid"] as string));
    if (!version) throw httpError(404, "Version not found");
    const [template] = await db
      .select({ auditType: auditTemplatesTable.auditType, name: auditTemplatesTable.name })
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, version.templateId));
    const access = await resolveAuditAccess(req.user!);
    if (!conductableAuditTypes(access).includes((template?.auditType ?? "") as AuditType)) {
      throw httpError(403, "You cannot conduct this audit type");
    }
    const { sections, questions } = await loadExecutionQuestions(version.id, null, "none");
    res.json({
      success: true,
      data: {
        id: version.id,
        versionNo: version.versionNo,
        templateName: template?.name ?? null,
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          questions: questions
            .filter((q) => q.sectionId === s.id)
            .map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, weight: q.weight })),
        })),
      },
    });
  },
);

/** Rooms of a property the caller may conduct at (for ROOM-target templates). */
router.get(
  "/target-rooms",
  authenticate,
  authorize("AUDIT_EXECUTION", "create"),
  async (req, res) => {
    const propertyId = String(req.query["propertyId"] ?? "");
    const auditType = String(req.query["auditType"] ?? "UL") as AuditType;
    if (!propertyId) throw httpError(400, "propertyId query param required");
    const access = await resolveAuditAccess(req.user!);
    if (!canConduct(access, auditType, propertyId)) {
      throw httpError(403, "You cannot conduct at this property");
    }
    const rows = await db
      .select({ id: roomsTable.id, number: roomsTable.number, floor: roomsTable.floor })
      .from(roomsTable)
      .where(eq(roomsTable.propertyId, propertyId))
      .orderBy(roomsTable.number);
    res.json({ success: true, data: rows });
  },
);

/**
 * "My audits" queue (FRD-REG-05): the assignee's own work, by due date.
 *
 * `segment` drives the Pending / Completed / All tabs:
 *   pending   — actionable now: SCHEDULED, IN_PROGRESS, PAUSED, REJECTED (rework)
 *   completed — SUBMITTED, UNDER_REVIEW, APPROVED, CLOSED
 *   all       — both of the above
 *
 * DRAFT is deliberately in none of them. The materializer pre-creates
 * occurrences up to `lookahead_days` ahead as DRAFT, and counting work that is
 * not yet due would inflate every "N left".
 *
 * `meta.counts` is aggregated in SQL rather than derived from `data`, so the
 * per-type cards stay correct past the row limit and a type the auditor holds
 * but has nothing pending on still renders its "0 left" card.
 */
router.get(
  "/my",
  authenticate,
  authorize("AUDIT_EXECUTION", "view"),
  async (req, res) => {
    const segment = String(req.query["segment"] ?? "pending").toLowerCase();
    if (!["pending", "completed", "all"].includes(segment)) {
      throw httpError(400, "segment must be pending, completed or all");
    }
    const mine = eq(auditsTable.assigneeId, req.user!.id);
    const states =
      segment === "pending"
        ? [...ACTIVE_STATES]
        : segment === "completed"
          ? [...COMPLETED_STATES]
          : [...ACTIVE_STATES, ...COMPLETED_STATES];

    const rows = await db
      .select()
      .from(auditsTable)
      .where(and(mine, inArray(auditsTable.state, states)))
      .orderBy(asc(auditsTable.dueAt))
      .limit(200);

    const counts = await db
      .select({
        auditType: auditsTable.auditType,
        pending: sql<number>`count(*) filter (where ${auditsTable.state}::text in ${stateList(ACTIVE_STATES)})::int`,
        completed: sql<number>`count(*) filter (where ${auditsTable.state}::text in ${stateList(COMPLETED_STATES)})::int`,
      })
      .from(auditsTable)
      .where(mine)
      .groupBy(auditsTable.auditType);

    res.json({
      success: true,
      data: await enrich(rows),
      // Drop types whose whole history is DRAFT — nothing to show a card for yet.
      meta: { counts: counts.filter((c) => c.pending + c.completed > 0) },
    });
  },
);

/** Audit detail (FRD-EXE-01, Details tab data). */
router.get(
  "/:id",
  authenticate,
  authorize("AUDIT_REGISTER", "view"),
  async (req, res) => {
    const [audit] = await db
      .select()
      .from(auditsTable)
      .where(eq(auditsTable.id, req.params["id"] as string));
    if (!audit) throw httpError(404, "Audit not found");

    const access = await resolveAuditAccess(req.user!);
    const isAssignee = audit.assigneeId === req.user!.id;
    if (!isAssignee && !canView(access, audit.auditType as AuditType, audit.propertyId)) {
      throw httpError(403, "Outside your audit access scope");
    }

    const [enriched] = await enrich([audit]);
    const [version] = await db
      .select({
        id: auditTemplateVersionsTable.id,
        versionNo: auditTemplateVersionsTable.versionNo,
        templateId: auditTemplateVersionsTable.templateId,
      })
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, audit.templateVersionId));
    const [template] = version
      ? await db
          .select({ id: auditTemplatesTable.id, name: auditTemplatesTable.name })
          .from(auditTemplatesTable)
          .where(eq(auditTemplatesTable.id, version.templateId))
      : [];

    // Presence proof for reviewers (Ops Excellence): the start & end selfies as
    // stamped on the audit. Audits that ran before the start gate shipped carry
    // no startEvidenceId and simply report null.
    const proofIds = [audit.startEvidenceId, audit.submissionEvidenceId].filter(
      (x): x is string => !!x,
    );
    const proofRows = proofIds.length
      ? await db.select().from(auditEvidenceTable).where(inArray(auditEvidenceTable.id, proofIds))
      : [];
    const resolveProof = async (evidenceId: string | null) => {
      const row = evidenceId ? proofRows.find((e) => e.id === evidenceId) : undefined;
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        url: await evidenceUrl(row.storageKey),
        thumbUrl: row.thumbStorageKey ? await evidenceUrl(row.thumbStorageKey) : null,
        mime: row.mime,
        geoLat: row.geoLat,
        geoLng: row.geoLng,
        geoAccuracyM: row.geoAccuracyM,
        capturedAt: row.capturedAt,
        isLiveCapture: row.isLiveCapture,
        createdAt: row.createdAt,
      };
    };

    res.json({
      success: true,
      data: {
        ...enriched,
        templateVersion: version
          ? { ...version, templateName: template?.name ?? null }
          : null,
        startProof: await resolveProof(audit.startEvidenceId),
        endProof: await resolveProof(audit.submissionEvidenceId),
      },
    });
  },
);

/** Activity tab (FRD-TRL-02): human-readable per-audit event timeline. */
router.get(
  "/:id/events",
  authenticate,
  authorize("AUDIT_REGISTER", "view"),
  async (req, res) => {
    const auditId = req.params["id"] as string;
    const [audit] = await db
      .select({ id: auditsTable.id, auditType: auditsTable.auditType, propertyId: auditsTable.propertyId, assigneeId: auditsTable.assigneeId })
      .from(auditsTable)
      .where(eq(auditsTable.id, auditId));
    if (!audit) throw httpError(404, "Audit not found");

    const access = await resolveAuditAccess(req.user!);
    if (audit.assigneeId !== req.user!.id && !canView(access, audit.auditType as AuditType, audit.propertyId)) {
      throw httpError(403, "Outside your audit access scope");
    }

    const events = await db
      .select({ event: auditEventsTable, actorName: usersTable.name })
      .from(auditEventsTable)
      .leftJoin(usersTable, eq(usersTable.id, auditEventsTable.actorId))
      .where(eq(auditEventsTable.auditId, auditId))
      .orderBy(desc(auditEventsTable.seq))
      .limit(500);

    res.json({
      success: true,
      data: events.map((e) => ({
        ...e.event,
        actorName: e.actorName ?? (e.event.actorId ? null : "System"),
      })),
    });
  },
);

/* ── Shared loaders & guards ───────────────────────────────────────────────── */

async function loadAudit(id: string) {
  const [audit] = await db.select().from(auditsTable).where(eq(auditsTable.id, id));
  if (!audit) throw httpError(404, "Audit not found");
  return audit;
}

function assertAssignee(audit: { assigneeId: string | null }, userId: string) {
  if (audit.assigneeId !== userId) {
    throw httpError(403, "Only the accountable assignee may perform this action");
  }
}

/** Version scale snapshot (published versions always carry one). */
function scaleSnapshotOf(version: { ratingScaleSnapshot: unknown }): RatingScaleSnapshot | null {
  return (version.ratingScaleSnapshot as RatingScaleSnapshot | null) ?? null;
}

/**
 * `postSet` lands extra columns in the SAME transaction as the transition —
 * used by /start to stamp the presence proof so the state change and its
 * evidence pointer can never diverge.
 */
async function transitionOrLogDenial(
  audit: typeof auditsTable.$inferSelect,
  to: AuditState,
  actor: { id: string | null; role?: string | null },
  reason: string | null,
  geo?: { lat: number; lng: number } | null,
  postSet?: Partial<typeof auditsTable.$inferInsert>,
): Promise<void> {
  if (!canTransition(AUDIT_TRANSITIONS, audit.state as AuditState, to)) {
    // FRD-EXE-03 AC: the denied attempt itself is security-logged.
    await recordAuditEvent({
      entityType: "AUDIT",
      entityId: audit.id,
      auditId: audit.id,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      kind: "DENIED_ATTEMPT",
      fromState: audit.state,
      toState: to,
      reason: "Illegal transition attempt",
    });
    throw httpError(409, "ILLEGAL_TRANSITION", {
      from: audit.state,
      to,
      allowed: AUDIT_TRANSITIONS[audit.state as AuditState],
    });
  }
  await db.transaction(async (tx) => {
    await applyAuditTransition(tx, audit, to, { actor, reason, geo: geo ?? null });
    if (postSet && Object.keys(postSet).length > 0) {
      await tx.update(auditsTable).set(postSet).where(eq(auditsTable.id, audit.id));
    }
  });
}

/* ── State actions (FRD-EXE-03, FRD-EXE-14) ────────────────────────────────── */

/**
 * Start gate: an audit only enters IN_PROGRESS behind a live, GPS-tagged start
 * selfie captured minutes ago (same rules as the end selfie, D-9). Freshness is
 * what makes rework re-prove presence — a proof from the earlier attempt is
 * already stale. Existing IN_PROGRESS audits never come through here, so
 * nothing running is retroactively blocked.
 */
router.post(
  "/:id/start",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    assertAssignee(audit, req.user!.id);

    const proof = await findLiveProof(audit.id, "START_PROOF", LIVE_PROOF_MAX_AGE_MS);
    if (!proof) {
      throw httpError(422, "START_PHOTO_REQUIRED", {
        reason: "Capture the live geotagged start photo before starting this audit",
      });
    }

    // FRD-EXE-14: start location/time come from the validated capture itself,
    // never from a coordinate the client could send independently of the photo.
    const geo = { lat: proof.geoLat!, lng: proof.geoLng! };
    await transitionOrLogDenial(audit, "IN_PROGRESS", auditActor(req), "Started", geo, {
      startedAt: new Date(),
      startGeoLat: geo.lat,
      startGeoLng: geo.lng,
      startEvidenceId: proof.id,
    });
    res.json({ success: true, data: await loadAudit(audit.id) });
  },
);

/**
 * Reassign an audit (FRD-ASG-04/05).
 *
 * `assigneeId` previously had exactly two writers — ad-hoc create and the
 * materializer — and was mutable nowhere, so a leaver's open audits were stuck
 * on them permanently and an audit the escalation chain could not place stayed
 * orphaned. Accepts a single id or a batch, so a handover is one call.
 *
 * Only before submission: once an audit is SUBMITTED the answers and the
 * on-site proof belong to whoever actually did the work, and moving the row
 * would misattribute them.
 */
const REASSIGNABLE_STATES = ["DRAFT", "SCHEDULED", "IN_PROGRESS", "PAUSED", "REJECTED"];

router.post(
  "/reassign",
  authenticate,
  authorize("AUDIT_SCHEDULES", "edit"),
  async (req, res) => {
    const parsed = z
      .object({
        auditIds: z.array(z.string().min(1)).min(1).max(200),
        assigneeId: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid reassignment", parsed.error.flatten());

    const [assignee] = await db
      .select({ id: usersTable.id, name: usersTable.name, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, parsed.data.assigneeId));
    if (!assignee) throw httpError(404, "Assignee not found");
    if (!assignee.isActive) throw httpError(422, "That user is deactivated");

    const audits = await db
      .select()
      .from(auditsTable)
      .where(inArray(auditsTable.id, parsed.data.auditIds));
    if (audits.length === 0) throw httpError(404, "No matching audits");

    const blocked = audits.filter((a) => !REASSIGNABLE_STATES.includes(a.state));
    if (blocked.length > 0) {
      throw httpError(409, "Submitted audits cannot be reassigned", {
        tickets: blocked.map((a) => a.ticketNo),
      });
    }

    const actor = auditActor(req);
    const reason = parsed.data.reason?.trim() || "Reassigned";
    await db.transaction(async (tx) => {
      for (const audit of audits) {
        if (audit.assigneeId === assignee.id) continue;
        await tx
          .update(auditsTable)
          .set({ assigneeId: assignee.id, updatedAt: new Date() })
          .where(eq(auditsTable.id, audit.id));
        await appendAuditEvent(tx, {
          entityType: "AUDIT",
          entityId: audit.id,
          auditId: audit.id,
          actorId: actor.id,
          actorRole: actor.role,
          // First writer of this event kind — it existed with none.
          kind: "ASSIGNMENT",
          beforeJson: { assigneeId: audit.assigneeId },
          afterJson: { assigneeId: assignee.id },
          reason,
        });
      }
    });

    for (const audit of audits) {
      if (audit.assigneeId === assignee.id) continue;
      await notify({
        userId: assignee.id,
        title: `Audit ${audit.ticketNo} assigned to you`,
        body: reason.slice(0, 180),
        type: "AUDIT",
        link: `/audits/${audit.id}`,
        entityType: "AUDIT",
        entityId: audit.id,
      });
    }

    res.json({ success: true, data: { reassigned: audits.length, assigneeId: assignee.id } });
  },
);

/** Title edits while Pending only (FRD-ASG-03). */
router.patch(
  "/:id",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    const body: Record<string, unknown> = {};
    if (typeof req.body?.title === "string" && req.body.title.trim()) body["title"] = req.body.title.trim();
    if (Object.keys(body).length === 0) throw httpError(400, "Nothing to update");
    if (!["DRAFT", "SCHEDULED"].includes(audit.state)) {
      throw httpError(409, "Title is editable while Pending only (FRD-ASG-03)");
    }
    const [row] = await db
      .update(auditsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(auditsTable.id, audit.id))
      .returning();
    res.json({ success: true, data: row });
  },
);

/* ── Execution grid (FRD-EXE-04) ───────────────────────────────────────────── */

router.get(
  "/:id/run",
  authenticate,
  // Read of the execution grid — powers the runner (conductors) AND the
  // read-only scorecard/answers on the audit-detail + review pages. Coarse gate
  // mirrors the detail route (AUDIT_REGISTER) so oversight roles that can view
  // an audit can also see its answers; the canView() check below does the real
  // per-audit-type/property scoping. Conducting mutations stay AUDIT_EXECUTION.
  authorizeAny(["AUDIT_REGISTER", "AUDIT_EXECUTION", "AUDIT_REPORTS", "AUDIT_DASHBOARD"], "view"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    const access = await resolveAuditAccess(req.user!);
    if (audit.assigneeId !== req.user!.id && !canView(access, audit.auditType as AuditType, audit.propertyId)) {
      throw httpError(403, "Outside your audit access scope");
    }
    const [version] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, audit.templateVersionId));
    if (!version) throw httpError(500, "Template version missing");

    const { sections, questions } = await loadExecutionQuestions(
      audit.templateVersionId,
      audit.subsetJson,
      audit.id,
    );
    const responses = await db
      .select()
      .from(auditResponsesTable)
      .where(eq(auditResponsesTable.auditId, audit.id));
    const evidence = await db
      .select()
      .from(auditEvidenceTable)
      .where(eq(auditEvidenceTable.auditId, audit.id));

    const policies = {
      response: await getAttachmentPolicy("RESPONSE"),
      audit: await getAttachmentPolicy("AUDIT"),
      submission: await getAttachmentPolicy("SUBMISSION"),
    };

    const evidenceWithUrls = await Promise.all(
      evidence.map(async (e) => ({
        ...e,
        url: await evidenceUrl(e.storageKey),
        thumbUrl: e.thumbStorageKey ? await evidenceUrl(e.thumbStorageKey) : null,
      })),
    );

    /* The start screen names the unit/property being audited (FRD-EXE-14), and
       a rework needs the reviewer's reason in front of the auditor — not buried
       in an Activity tab. This was the one audit read path that skipped
       enrich(), so propertyName/roomNumber arrived undefined and the UI that
       renders them silently showed nothing. */
    const [enriched] = await enrich([audit]);
    const [rejection] =
      audit.state === "REJECTED"
        ? await db
            .select({ comments: auditReviewsTable.comments, createdAt: auditReviewsTable.createdAt })
            .from(auditReviewsTable)
            .where(and(eq(auditReviewsTable.auditId, audit.id), eq(auditReviewsTable.verdict, "REJECTED")))
            .orderBy(desc(auditReviewsTable.createdAt))
            .limit(1)
        : [];

    res.json({
      success: true,
      data: {
        audit: { ...(enriched ?? audit), rejectionReason: rejection?.comments ?? null },
        version: {
          id: version.id,
          versionNo: version.versionNo,
          passThresholdPct: version.passThresholdPct,
          reviewRequired: true, // PRD §8.5: every submitted audit is reviewed
        },
        scaleSnapshot: scaleSnapshotOf(version),
        sections: sections.map((s) => ({
          ...s,
          questions: questions.filter((q) => q.sectionId === s.id),
        })),
        responses,
        evidence: evidenceWithUrls,
        policies,
      },
    });
  },
);

/* ── Answering (FRD-EXE-05/07/09) ──────────────────────────────────────────── */

const answerSchema = z.object({
  answerJson: z.unknown().nullish(),
  isNa: z.boolean().optional(),
  notes: z.string().max(4000).nullish(),
});

async function assertAnswerable(audit: typeof auditsTable.$inferSelect, userId: string) {
  assertAssignee(audit, userId);
  if (audit.state !== "IN_PROGRESS") {
    // Frozen post-submit (FRD-EXE-12) or not yet started.
    throw httpError(409, "Answers are editable while the audit is In Progress only", { state: audit.state });
  }
}

router.put(
  "/:id/responses/:questionId",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    await assertAnswerable(audit, req.user!.id);
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid answer", parsed.error.flatten());

    const questionId = req.params["questionId"] as string;
    const [question] = await db
      .select()
      .from(auditQuestionsTable)
      .where(eq(auditQuestionsTable.id, questionId));
    if (!question) throw httpError(404, "Question not found");
    if (question.auditId && question.auditId !== audit.id) {
      throw httpError(403, "Question belongs to a different audit");
    }

    const [version] = await db
      .select({ ratingScaleSnapshot: auditTemplateVersionsTable.ratingScaleSnapshot })
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, audit.templateVersionId));
    const snapshot = scaleSnapshotOf(version ?? { ratingScaleSnapshot: null });

    const resolved = resolveMultiplier(
      {
        id: question.id,
        sectionId: question.sectionId,
        type: question.type,
        weight: question.weight,
        mandatory: question.mandatory,
        optionsJson: question.optionsJson as never,
        numericMin: question.numericMin != null ? Number(question.numericMin) : null,
        numericMax: question.numericMax != null ? Number(question.numericMax) : null,
      },
      parsed.data.answerJson,
      snapshot,
    );

    const now = new Date();
    const [row] = await db
      .insert(auditResponsesTable)
      .values({
        id: newId(),
        auditId: audit.id,
        questionId,
        answerJson: parsed.data.answerJson ?? null,
        isNa: parsed.data.isNa ?? resolved.isNa,
        multiplierPct: resolved.multiplierPct != null ? String(resolved.multiplierPct) : null,
        notes: parsed.data.notes ?? null,
        answeredBy: req.user!.id,
        answeredAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [auditResponsesTable.auditId, auditResponsesTable.questionId],
        set: {
          answerJson: parsed.data.answerJson ?? null,
          isNa: parsed.data.isNa ?? resolved.isNa,
          multiplierPct: resolved.multiplierPct != null ? String(resolved.multiplierPct) : null,
          ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
          answeredBy: req.user!.id,
          answeredAt: now,
          updatedAt: now,
        },
      })
      .returning();

    res.json({ success: true, data: row });
  },
);

/* ── Evidence (FRD-EXE-06/13) ──────────────────────────────────────────────── */
// parseDataUrl / storeEvidence / evidenceUrl live in ../lib/audit-service.js

const evidenceJson = express.json({ limit: "40mb" });

router.post(
  "/:id/evidence",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  evidenceJson,
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    assertAssignee(audit, req.user!.id);

    const kind = String(req.body?.kind ?? "RESPONSE").toUpperCase();
    if (!["AUDIT", "RESPONSE", "START_PROOF", "SUBMISSION_PROOF"].includes(kind)) {
      throw httpError(400, "kind must be AUDIT | RESPONSE | START_PROOF | SUBMISSION_PROOF");
    }
    // The start selfie is taken BEFORE the audit moves to In Progress, so it
    // has its own open-state set; everything else stays in-run only.
    const openStates = kind === "START_PROOF" ? ["SCHEDULED", "REJECTED"] : ["IN_PROGRESS", "PAUSED"];
    if (!openStates.includes(audit.state)) {
      throw httpError(
        409,
        kind === "START_PROOF"
          ? "The start photo is captured before the audit begins"
          : "Evidence can be attached while the audit is open only",
      );
    }

    const parsedFile = parseDataUrl(req.body?.dataUrl);
    if (!parsedFile) throw httpError(400, "dataUrl must be a base64 image/pdf data URL");

    const policyLevel = kind === "SUBMISSION_PROOF" || kind === "START_PROOF" ? "SUBMISSION" : kind;
    const policy = await getAttachmentPolicy(policyLevel);
    if (!policy.allowedMime.includes(parsedFile.contentType)) {
      throw httpError(422, `File type ${parsedFile.contentType} not allowed for ${policyLevel}`, { allowed: policy.allowedMime });
    }
    if (parsedFile.buffer.length > policy.maxSizeMb * 1024 * 1024) {
      throw httpError(422, `File exceeds the ${policy.maxSizeMb}MB limit for ${policyLevel}`);
    }

    const responseId = req.body?.responseId ? String(req.body.responseId) : null;
    // Count against the policy scope: per response row, or per audit level.
    const countWhere =
      kind === "RESPONSE" && responseId
        ? and(eq(auditEvidenceTable.auditId, audit.id), eq(auditEvidenceTable.responseId, responseId))
        : and(eq(auditEvidenceTable.auditId, audit.id), eq(auditEvidenceTable.kind, kind as never));
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvidenceTable)
      .where(countWhere);
    if ((countRow?.count ?? 0) >= policy.maxFiles) {
      throw httpError(422, `Attachment limit reached (${policy.maxFiles} for ${policyLevel})`, { maxFiles: policy.maxFiles });
    }

    const geo = req.body?.geo as { lat?: number; lng?: number; accuracyM?: number } | undefined;
    const isLiveCapture = req.body?.isLiveCapture === true;
    // D-9 / FRD-EXE-13: both presence selfies pass the same live+GPS+fresh gate.
    if (kind === "START_PROOF") {
      assertLiveGeoCapture("START_PHOTO_REQUIRED", "The start photo", {
        isLiveCapture,
        geo,
        capturedAt: req.body?.capturedAt,
      });
    }
    if (kind === "SUBMISSION_PROOF") {
      assertLiveGeoCapture("LIVE_PHOTO_REQUIRED", "The end photo", {
        isLiveCapture,
        geo,
        capturedAt: req.body?.capturedAt,
      });
    }

    const evidenceId = newId();
    const key = `audit-evidence/${audit.id}/${evidenceId}.${parsedFile.ext}`;
    const storageKey = await storeEvidence(key, parsedFile.buffer, parsedFile.contentType);

    let thumbStorageKey: string | null = null;
    const thumb = parseDataUrl(req.body?.thumbDataUrl);
    if (thumb && thumb.buffer.length <= 512 * 1024) {
      thumbStorageKey = await storeEvidence(
        `audit-evidence/${audit.id}/${evidenceId}.thumb.${thumb.ext}`,
        thumb.buffer,
        thumb.contentType,
      );
    }

    const [row] = await db
      .insert(auditEvidenceTable)
      .values({
        id: evidenceId,
        auditId: audit.id,
        kind: kind as never,
        responseId,
        storageKey,
        thumbStorageKey,
        mime: parsedFile.contentType,
        sizeBytes: parsedFile.buffer.length,
        originalName: (req.body?.originalName as string) ?? null,
        geoLat: typeof geo?.lat === "number" ? geo.lat : null,
        geoLng: typeof geo?.lng === "number" ? geo.lng : null,
        geoAccuracyM: typeof geo?.accuracyM === "number" ? String(geo.accuracyM) : null,
        capturedAt: req.body?.capturedAt ? new Date(String(req.body.capturedAt)) : null,
        isLiveCapture,
        uploadedBy: req.user!.id,
      })
      .returning();

    res.status(201).json({
      success: true,
      data: { ...row, url: await evidenceUrl(row!.storageKey), thumbUrl: row!.thumbStorageKey ? await evidenceUrl(row!.thumbStorageKey) : null },
    });
  },
);

router.delete(
  "/:id/evidence/:eid",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    assertAssignee(audit, req.user!.id);
    if (!["IN_PROGRESS", "PAUSED"].includes(audit.state)) {
      throw httpError(409, "Evidence is frozen after submission");
    }
    const [row] = await db
      .delete(auditEvidenceTable)
      .where(and(eq(auditEvidenceTable.id, req.params["eid"] as string), eq(auditEvidenceTable.auditId, audit.id)))
      .returning();
    if (!row) throw httpError(404, "Evidence not found");
    res.json({ success: true });
  },
);

/* ── Submission gate & atomic submit (FRD-EXE-11/12/13/14) ─────────────────── */

router.get(
  "/:id/submit-check",
  authenticate,
  authorize("AUDIT_EXECUTION", "view"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    assertAssignee(audit, req.user!.id);
    const blockers = await computeSubmitBlockers(audit);
    res.json({ success: true, data: { blockers, canSubmit: blockers.length === 0 } });
  },
);

router.post(
  "/:id/submit",
  authenticate,
  authorize("AUDIT_EXECUTION", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    assertAssignee(audit, req.user!.id);
    if (audit.state !== "IN_PROGRESS") {
      throw httpError(409, "ILLEGAL_TRANSITION", { from: audit.state, to: "SUBMITTED" });
    }

    const blockers = await computeSubmitBlockers(audit);
    if (blockers.length > 0) {
      const code = blockers.some((b) => b.kind === "LIVE_PHOTO_REQUIRED") && blockers.length === 1
        ? "LIVE_PHOTO_REQUIRED"
        : "SUBMISSION_BLOCKED";
      throw httpError(422, code, { blockers });
    }

    const [version] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, audit.templateVersionId));
    if (!version) throw httpError(500, "Template version missing");
    const snapshot = scaleSnapshotOf(version);

    const { questions } = await loadExecutionQuestions(audit.templateVersionId, audit.subsetJson, audit.id);
    const responses = await db
      .select()
      .from(auditResponsesTable)
      .where(eq(auditResponsesTable.auditId, audit.id));
    const naCountsAgainst = await getAuditSetting("na_counts_against", AUDIT_SETTING_DEFAULTS.na_counts_against);
    const bands = await db.select().from(auditPerformanceBandsTable).orderBy(asc(auditPerformanceBandsTable.orderIndex));

    const result = scoreAudit({
      questions: questions.map((q) => ({
        id: q.id,
        sectionId: q.sectionId,
        type: q.type,
        weight: q.weight,
        mandatory: q.mandatory,
        optionsJson: q.optionsJson as never,
        numericMin: q.numericMin != null ? Number(q.numericMin) : null,
        numericMax: q.numericMax != null ? Number(q.numericMax) : null,
      })),
      answers: responses.map((r) => ({ questionId: r.questionId, answerJson: r.isNa ? naAnswerFor(questions.find((q) => q.id === r.questionId)?.type) : r.answerJson })),
      scaleSnapshot: snapshot,
      naCountsAgainst: Boolean(naCountsAgainst),
      passThresholdPct: version.passThresholdPct != null ? Number(version.passThresholdPct) : null,
      criticalFailGate: version.criticalFailGate,
      hasCriticalNc: false,
      bands: bands.map((b) => ({ label: b.label, minPct: Number(b.minPct), maxPct: Number(b.maxPct) })),
    });

    const now = new Date();
    const geo =
      req.body?.geo && typeof req.body.geo.lat === "number" && typeof req.body.geo.lng === "number"
        ? { lat: req.body.geo.lat as number, lng: req.body.geo.lng as number }
        : null;
    // PRD §8.5/§10: every submit routes to review — no auto-approve path.
    const targetState: AuditState = "SUBMITTED";
    const actor = auditActor(req);

    // Latest valid end selfie, stamped onto the audit (FRD-EXE-13). The submit
    // gate above already guarantees one exists.
    const proof = await findLiveProof(audit.id, "SUBMISSION_PROOF");

    const updated = await db.transaction(async (tx) => {
      // Freeze responses with computed line scores (FRD-EXE-12).
      const lineByQ = new Map(result.lines.map((l) => [l.questionId, l]));
      for (const r of responses) {
        const line = lineByQ.get(r.questionId);
        const question = questions.find((q) => q.id === r.questionId);
        await tx
          .update(auditResponsesTable)
          .set({
            weight: question ? String(question.weight) : null,
            multiplierPct: line?.multiplierPct != null ? String(line.multiplierPct) : r.multiplierPct,
            earnedScore: line?.earned != null ? String(line.earned) : null,
            maxScore: line?.max != null ? String(line.max) : null,
            updatedAt: now,
          })
          .where(eq(auditResponsesTable.id, r.id));
      }

      const durationSeconds = audit.startedAt ? Math.max(0, Math.round((now.getTime() - audit.startedAt.getTime()) / 1000)) : null;
      const [row] = await tx
        .update(auditsTable)
        .set({
          state: targetState,
          submittedAt: now,
          // Prefer the selfie's own (server-validated) coordinates so the end
          // location always matches the photo the reviewer sees.
          submitGeoLat: proof?.geoLat ?? geo?.lat ?? null,
          submitGeoLng: proof?.geoLng ?? geo?.lng ?? null,
          durationSeconds,
          submissionEvidenceId: proof?.id ?? null,
          maxScore: String(result.overall.maxRaw),
          earnedScore: String(result.overall.earnedRaw),
          scorePct: result.overall.pct != null ? String(result.overall.pct) : null,
          result: result.result,
          scoreBand: result.band,
          isOverdue: false,
          updatedAt: now,
        })
        .where(eq(auditsTable.id, audit.id))
        .returning();

      await appendAuditEvent(tx, {
        entityType: "AUDIT",
        entityId: audit.id,
        auditId: audit.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "SCORE_FREEZE",
        afterJson: {
          earned: result.overall.earnedRaw,
          max: result.overall.maxRaw,
          pct: result.overall.pct,
          result: result.result,
          band: result.band,
        },
        reason: "Responses frozen and score computed at submission (D-3: no overrides)",
      });
      await appendAuditEvent(tx, {
        entityType: "AUDIT",
        entityId: audit.id,
        auditId: audit.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        fromState: "IN_PROGRESS",
        toState: targetState,
        reason: "Submitted for review",
      });

      // Queue the report row. Every submission (first, post-reject rework,
      // post-reopen) produces the NEXT revision; prior revisions stay
      // immutable and downloadable (FRD-REV-06).
      const [maxRev] = await tx
        .select({ max: sql<number>`coalesce(max(${auditReportsTable.revision}), 0)` })
        .from(auditReportsTable)
        .where(eq(auditReportsTable.auditId, audit.id));
      const reportNo = await allocateNumber(tx, "REPORT");
      await tx.insert(auditReportsTable).values({
        id: newId(),
        reportNo,
        auditId: audit.id,
        revision: (maxRev?.max ?? 0) + 1,
        status: "PENDING",
      });

      return row!;
    });

    // Notify after commit: reviewers (OE, D-11) — every submit goes to review.
    const reviewers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(inArray(usersTable.role, ["OPS_EXCELLENCE"]), eq(usersTable.isActive, true)));
    for (const reviewer of reviewers) {
      await notify({
        userId: reviewer.id,
        title: `Audit ${audit.ticketNo} submitted for review`,
        body: `${audit.title} — score ${result.overall.pct != null ? Math.round(result.overall.pct * 100) / 100 + "%" : "n/a"}`,
        type: "AUDIT",
        link: `/audits/review/${audit.id}`,
        entityType: "AUDIT",
        entityId: audit.id,
      });
    }

    res.json({ success: true, data: { audit: updated, score: result.overall, result: result.result, band: result.band } });
  },
);

/** N/A answers were stored with isNa=true; rebuild a type-correct N/A payload. */
function naAnswerFor(type: string | undefined): unknown {
  if (type === "YES_NO_NA") return { value: "NA" };
  if (type === "RATING") return { optionId: "audit-opt-na" };
  return null;
}

export { router as auditsRouter };
