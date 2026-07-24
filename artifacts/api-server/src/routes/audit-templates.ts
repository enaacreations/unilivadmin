/**
 * Audit & Inspection — template library & authoring routes (FA-02/03/04).
 * P1 scope: library register, template create (with v1 draft), detail with
 * version history. Builder mutations, bank, publish flow, clone, where-used,
 * diff, import/export and preview land in P2.
 */
import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditTemplatesTable,
  auditTemplateVersionsTable,
  auditSectionsTable,
  auditQuestionsTable,
  auditQuestionBankItemsTable,
  auditRatingScalesTable,
  auditRatingOptionsTable,
  auditPerformanceBandsTable,
  auditSchedulesTable,
  auditsTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError, pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { appendAuditEvent, canonicalJson, type DbLike } from "../lib/audit-events.js";
import { auditActor, getAuditSetting, AUDIT_SETTING_DEFAULTS } from "../lib/audit-service.js";
import { assertTransition, TEMPLATE_VERSION_TRANSITIONS, type TemplateVersionLifecycle } from "../lib/audit-state.js";
import { scoreAudit, NON_SCORED_TYPES, type RatingScaleSnapshot } from "../lib/audit-scoring.js";

const router: IRouter = Router();

const QUESTION_TYPES = [
  "YES_NO_NA", "PASS_FAIL", "RATING", "SINGLE_CHOICE", "MULTI_CHOICE",
  "NUMERIC", "TEXT", "PHOTO", "SIGNATURE", "DATE", "INSTRUCTION",
] as const;
const EVIDENCE_RULES = ["NONE", "OPTIONAL", "REQUIRED_ON_FAIL", "ALWAYS_REQUIRED"] as const;

/* ── Shared helpers ────────────────────────────────────────────────────────── */

async function loadVersion(vid: string) {
  const [version] = await db
    .select()
    .from(auditTemplateVersionsTable)
    .where(eq(auditTemplateVersionsTable.id, vid));
  if (!version) throw httpError(404, "Version not found");
  return version;
}

function assertDraftVersion(version: { lifecycle: string; id: string }) {
  if (version.lifecycle !== "DRAFT") {
    throw httpError(409, "Published versions are immutable — edits fork the next draft (FRD-TLB-03)", {
      lifecycle: version.lifecycle,
    });
  }
}

async function loadVersionContent(versionId: string) {
  const sections = await db
    .select()
    .from(auditSectionsTable)
    .where(eq(auditSectionsTable.templateVersionId, versionId))
    .orderBy(asc(auditSectionsTable.orderIndex));
  const sectionIds = sections.map((s) => s.id);
  const questions = sectionIds.length
    ? await db
        .select()
        .from(auditQuestionsTable)
        .where(and(inArray(auditQuestionsTable.sectionId, sectionIds), isNull(auditQuestionsTable.auditId)))
        .orderBy(asc(auditQuestionsTable.orderIndex))
    : [];
  return { sections, questions };
}

/**
 * Build the rating-scale snapshot for a version: the single scale referenced
 * by its RATING questions, or the first active scale as the default. Two
 * scales in one version is rejected (one scale per version keeps scores
 * comparable — same spirit as D-7).
 */
async function buildScaleSnapshot(
  questions: (typeof auditQuestionsTable.$inferSelect)[],
): Promise<RatingScaleSnapshot | null> {
  const scaleIds = [
    ...new Set(
      questions.filter((q) => q.type === "RATING" && q.ratingScaleId).map((q) => q.ratingScaleId as string),
    ),
  ];
  if (scaleIds.length > 1) {
    throw httpError(422, "A version may reference only one rating scale", { scaleIds });
  }
  let scaleId = scaleIds[0];
  if (!scaleId) {
    const [defaultScale] = await db
      .select()
      .from(auditRatingScalesTable)
      .where(eq(auditRatingScalesTable.active, true))
      .limit(1);
    if (!defaultScale) {
      if (questions.some((q) => q.type === "RATING")) {
        throw httpError(422, "No active rating scale configured (FR-AD-02)");
      }
      return null;
    }
    scaleId = defaultScale.id;
  }
  const [scale] = await db
    .select()
    .from(auditRatingScalesTable)
    .where(eq(auditRatingScalesTable.id, scaleId));
  if (!scale) throw httpError(422, "Referenced rating scale no longer exists");
  const options = await db
    .select()
    .from(auditRatingOptionsTable)
    .where(eq(auditRatingOptionsTable.scaleId, scaleId))
    .orderBy(asc(auditRatingOptionsTable.orderIndex));
  return {
    scaleId: scale.id,
    name: scale.name,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      multiplierPct: Number(o.multiplierPct),
      isExcludedNa: o.isExcludedNa,
      color: o.color,
      orderIndex: o.orderIndex,
    })) as RatingScaleSnapshot["options"],
  };
}

/** sha256 over canonicalized content + scale snapshot + result settings (FRD-TLB-03). */
function computeContentHash(
  content: Awaited<ReturnType<typeof loadVersionContent>>,
  snapshot: RatingScaleSnapshot | null,
  settings: { passThresholdPct: unknown; criticalFailGate: boolean; reviewRequired: boolean },
): string {
  const payload = {
    settings,
    ratingScaleSnapshot: snapshot,
    sections: content.sections.map((s) => ({
      title: s.title,
      description: s.description,
      audience: s.audience,
      orderIndex: s.orderIndex,
      questions: content.questions
        .filter((q) => q.sectionId === s.id)
        .map((q) => ({
          prompt: q.prompt,
          helpText: q.helpText,
          type: q.type,
          weight: q.weight,
          mandatory: q.mandatory,
          evidenceRule: q.evidenceRule,
          optionsJson: q.optionsJson ?? null,
          numericUnit: q.numericUnit,
          numericMin: q.numericMin,
          numericMax: q.numericMax,
          autoNcJson: q.autoNcJson ?? null,
          orderIndex: q.orderIndex,
        })),
    })),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Copy one version's content rows into another version (fork/clone). */
async function copyVersionContent(tx: DbLike, fromVersionId: string, toVersionId: string): Promise<void> {
  const sections = await tx
    .select()
    .from(auditSectionsTable)
    .where(eq(auditSectionsTable.templateVersionId, fromVersionId))
    .orderBy(asc(auditSectionsTable.orderIndex));
  for (const section of sections) {
    const newSectionId = newId();
    await tx.insert(auditSectionsTable).values({
      id: newSectionId,
      templateVersionId: toVersionId,
      title: section.title,
      description: section.description,
      orderIndex: section.orderIndex,
      audience: section.audience,
    });
    const questions = await tx
      .select()
      .from(auditQuestionsTable)
      .where(and(eq(auditQuestionsTable.sectionId, section.id), isNull(auditQuestionsTable.auditId)))
      .orderBy(asc(auditQuestionsTable.orderIndex));
    for (const q of questions) {
      await tx.insert(auditQuestionsTable).values({
        id: newId(),
        sectionId: newSectionId,
        prompt: q.prompt,
        helpText: q.helpText,
        type: q.type,
        weight: q.weight,
        mandatory: q.mandatory,
        evidenceRule: q.evidenceRule,
        ratingScaleId: q.ratingScaleId,
        optionsJson: q.optionsJson,
        numericUnit: q.numericUnit,
        numericMin: q.numericMin,
        numericMax: q.numericMax,
        autoNcJson: q.autoNcJson,
        bankItemId: q.bankItemId, // copy-on-insert provenance survives forks
        orderIndex: q.orderIndex,
      });
    }
  }
}

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  auditType: z.enum(["UL", "CM", "CX"]),
  targetType: z.enum(["PROPERTY", "ROOM"]),
  category: z.string().max(100).nullish(),
  description: z.string().max(2000).nullish(),
});

/** Library register (FRD-TLB-01): latest version, lifecycle, usage counts. */
router.get(
  "/",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (q["auditType"]) conditions.push(eq(auditTemplatesTable.auditType, q["auditType"] as never));
    if (!q["includeArchived"]) conditions.push(isNull(auditTemplatesTable.archivedAt));
    if (q["q"]) conditions.push(sql`${auditTemplatesTable.name} ILIKE ${"%" + q["q"] + "%"}`);
    const where = conditions.length ? and(...conditions) : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditTemplatesTable)
      .where(where);

    const templates = await db
      .select()
      .from(auditTemplatesTable)
      .where(where)
      .orderBy(desc(auditTemplatesTable.updatedAt))
      .limit(limit)
      .offset(offset);

    const data = await Promise.all(
      templates.map(async (t) => {
        const [latest] = await db
          .select()
          .from(auditTemplateVersionsTable)
          .where(eq(auditTemplateVersionsTable.templateId, t.id))
          .orderBy(desc(auditTemplateVersionsTable.versionNo))
          .limit(1);
        const [schedules] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditSchedulesTable)
          .where(and(eq(auditSchedulesTable.templateVersionId, latest?.id ?? ""), eq(auditSchedulesTable.status, "ACTIVE")));
        const [audits] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditsTable)
          .where(
            sql`${auditsTable.templateVersionId} IN (SELECT id FROM audit_template_versions WHERE template_id = ${t.id})`,
          );
        return {
          ...t,
          latestVersionNo: latest?.versionNo ?? null,
          latestVersionId: latest?.id ?? null,
          lifecycle: latest?.lifecycle ?? null,
          activeSchedules: schedules?.count ?? 0,
          auditsGenerated: audits?.count ?? 0,
        };
      }),
    );

    res.json({ success: true, data, meta: buildMeta(countRow?.count ?? 0, page, limit) });
  },
);

/** Create a template with an empty v1 draft. */
router.post(
  "/",
  authenticate,
  authorize("AUDIT_TEMPLATES", "create"),
  async (req, res) => {
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid template", parsed.error.flatten());

    const actor = auditActor(req);
    const result = await db.transaction(async (tx) => {
      const [template] = await tx
        .insert(auditTemplatesTable)
        .values({
          id: newId(),
          name: parsed.data.name,
          auditType: parsed.data.auditType,
          targetType: parsed.data.targetType,
          category: parsed.data.category ?? null,
          description: parsed.data.description ?? null,
          createdBy: actor.id,
        })
        .returning();
      const [version] = await tx
        .insert(auditTemplateVersionsTable)
        .values({
          id: newId(),
          templateId: template!.id,
          versionNo: 1,
          lifecycle: "DRAFT",
          createdBy: actor.id,
        })
        .returning();
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE",
        entityId: template!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "DRAFT",
        reason: "Template created",
        afterJson: { name: template!.name, auditType: template!.auditType },
      });
      return { template: template!, version: version! };
    });
    res.status(201).json({ success: true, data: { ...result.template, versions: [result.version] } });
  },
);

/** Template detail: metadata + full version history (FRD-TLB-02). */
router.get(
  "/:id",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, req.params["id"] as string));
    if (!template) throw httpError(404, "Template not found");

    const versions = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.templateId, template.id))
      .orderBy(desc(auditTemplateVersionsTable.versionNo));

    res.json({ success: true, data: { ...template, versions } });
  },
);

/** Update template metadata + access scope (FR-TM-09); type is fixed. */
router.patch(
  "/:id",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const [existing] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, req.params["id"] as string));
    if (!existing) throw httpError(404, "Template not found");

    const body = pick(req.body, ["name", "category", "description", "accessScopeJson"]);
    if (Object.keys(body).length === 0) throw httpError(400, "Nothing to update");

    const actor = auditActor(req);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditTemplatesTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(auditTemplatesTable.id, existing.id))
        .returning();
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE",
        entityId: existing.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "CONFIG_CHANGE",
        beforeJson: { name: existing.name, category: existing.category, description: existing.description },
        afterJson: body,
        reason: "Template metadata updated",
      });
      return row!;
    });
    res.json({ success: true, data: updated });
  },
);

/** Read one version with full content (read-only view of any version). */
router.get(
  "/versions/:vid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const [version] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, req.params["vid"] as string));
    if (!version) throw httpError(404, "Version not found");

    const sections = await db
      .select()
      .from(auditSectionsTable)
      .where(eq(auditSectionsTable.templateVersionId, version.id))
      .orderBy(auditSectionsTable.orderIndex);
    const sectionIds = sections.map((s) => s.id);
    const questions = sectionIds.length
      ? await db
          .select()
          .from(auditQuestionsTable)
          .where(
            and(
              inArray(auditQuestionsTable.sectionId, sectionIds),
              isNull(auditQuestionsTable.auditId), // version content only, not ad-hoc
            ),
          )
          .orderBy(auditQuestionsTable.orderIndex)
      : [];

    res.json({
      success: true,
      data: {
        ...version,
        sections: sections.map((s) => ({
          ...s,
          questions: questions.filter((qq) => qq.sectionId === s.id),
        })),
      },
    });
  },
);

/* ── Version forking, clone & archive (FRD-TLB-03/06) ──────────────────────── */

/** Fork the next draft version, copying content from a source version. */
router.post(
  "/:id/versions",
  authenticate,
  authorize("AUDIT_TEMPLATES", "create"),
  async (req, res) => {
    const templateId = req.params["id"] as string;
    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, templateId));
    if (!template) throw httpError(404, "Template not found");

    const versions = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.templateId, templateId))
      .orderBy(desc(auditTemplateVersionsTable.versionNo));
    if (versions.some((v) => v.lifecycle === "DRAFT" || v.lifecycle === "PENDING_APPROVAL")) {
      throw httpError(409, "A draft version already exists — publish or archive it first");
    }
    const source = req.body?.fromVersionId
      ? versions.find((v) => v.id === req.body.fromVersionId)
      : versions[0];
    if (!source) throw httpError(404, "Source version not found");

    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(auditTemplateVersionsTable)
        .values({
          id: newId(),
          templateId,
          versionNo: (versions[0]?.versionNo ?? 0) + 1,
          lifecycle: "DRAFT",
          passThresholdPct: source.passThresholdPct,
          criticalFailGate: source.criticalFailGate,
          reviewRequired: source.reviewRequired,
          createdBy: actor.id,
        })
        .returning();
      await copyVersionContent(tx, source.id, version!.id);
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE_VERSION",
        entityId: version!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "DRAFT",
        reason: `Draft v${version!.versionNo} forked from v${source.versionNo}`,
      });
      return version!;
    });
    res.status(201).json({ success: true, data: created });
  },
);

/** Clone a template as a new template with a v1 draft (FRD-TLB-06). */
router.post(
  "/:id/clone",
  authenticate,
  authorize("AUDIT_TEMPLATES", "create"),
  async (req, res) => {
    const templateId = req.params["id"] as string;
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw httpError(400, "name required for the cloned template");

    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, templateId));
    if (!template) throw httpError(404, "Template not found");
    const [source] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.templateId, templateId))
      .orderBy(desc(auditTemplateVersionsTable.versionNo))
      .limit(1);
    if (!source) throw httpError(404, "Template has no versions");

    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const [clone] = await tx
        .insert(auditTemplatesTable)
        .values({
          id: newId(),
          name,
          auditType: template.auditType,
          targetType: template.targetType,
          category: template.category,
          description: template.description,
          createdBy: actor.id,
        })
        .returning();
      const [version] = await tx
        .insert(auditTemplateVersionsTable)
        .values({
          id: newId(),
          templateId: clone!.id,
          versionNo: 1,
          lifecycle: "DRAFT",
          passThresholdPct: source.passThresholdPct,
          criticalFailGate: source.criticalFailGate,
          reviewRequired: source.reviewRequired,
          createdBy: actor.id,
        })
        .returning();
      await copyVersionContent(tx, source.id, version!.id);
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE",
        entityId: clone!.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: "DRAFT",
        reason: `Cloned from "${template.name}" v${source.versionNo}`,
      });
      return { ...clone!, versionId: version!.id };
    });
    res.status(201).json({ success: true, data: created });
  },
);

/** Archive/restore a template. Hard delete is prohibited (FR-TM-10). */
router.post(
  "/:id/archive",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const templateId = req.params["id"] as string;
    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, templateId));
    if (!template) throw httpError(404, "Template not found");
    const restore = req.body?.restore === true;

    const actor = auditActor(req);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditTemplatesTable)
        .set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() })
        .where(eq(auditTemplatesTable.id, templateId))
        .returning();
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE",
        entityId: templateId,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        toState: restore ? "ACTIVE" : "ARCHIVED",
        reason: restore ? "Template restored" : "Template archived (delete is prohibited once instantiated)",
      });
      return row!;
    });
    res.json({ success: true, data: updated });
  },
);

/* ── Version lifecycle: settings, approval, publish, deprecate (§5.7) ──────── */

/** Edit version settings — DRAFT only (weights & content lock at publish, D-6). */
router.patch(
  "/versions/:vid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    assertDraftVersion(version);
    const body = pick(req.body, ["passThresholdPct", "criticalFailGate", "reviewRequired", "changelogNote"]);
    if (Object.keys(body).length === 0) throw httpError(400, "Nothing to update");
    if (body.passThresholdPct != null) {
      const v = Number(body.passThresholdPct);
      if (Number.isNaN(v) || v < 0 || v > 100) throw httpError(422, "passThresholdPct must be 0–100");
      body.passThresholdPct = String(v);
    }
    const [row] = await db
      .update(auditTemplateVersionsTable)
      .set(body)
      .where(eq(auditTemplateVersionsTable.id, version.id))
      .returning();
    res.json({ success: true, data: row });
  },
);

/** Submit a draft for co-approval (FR-TM-04, when the org setting is on). */
router.post(
  "/versions/:vid/submit-approval",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    assertTransition(TEMPLATE_VERSION_TRANSITIONS, version.lifecycle as TemplateVersionLifecycle, "PENDING_APPROVAL", "TEMPLATE_VERSION");
    const actor = auditActor(req);
    const [row] = await db
      .update(auditTemplateVersionsTable)
      .set({ lifecycle: "PENDING_APPROVAL", submittedBy: actor.id, submittedAt: new Date() })
      .where(eq(auditTemplateVersionsTable.id, version.id))
      .returning();
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE_VERSION",
        entityId: version.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        fromState: version.lifecycle,
        toState: "PENDING_APPROVAL",
        reason: "Submitted for publish approval",
      });
    });
    res.json({ success: true, data: row });
  },
);

/** Bounce a pending version back to draft (co-approver rejects). */
router.post(
  "/versions/:vid/reject-approval",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    assertTransition(TEMPLATE_VERSION_TRANSITIONS, version.lifecycle as TemplateVersionLifecycle, "DRAFT", "TEMPLATE_VERSION");
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw httpError(422, "reason required");
    const actor = auditActor(req);
    const [row] = await db
      .update(auditTemplateVersionsTable)
      .set({ lifecycle: "DRAFT" })
      .where(eq(auditTemplateVersionsTable.id, version.id))
      .returning();
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE_VERSION",
        entityId: version.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        fromState: "PENDING_APPROVAL",
        toState: "DRAFT",
        reason,
      });
    });
    res.json({ success: true, data: row });
  },
);

/**
 * Publish (FRD-TLB-02/03): mandatory changelog note; content validation;
 * freezes content + rating-scale snapshot; stamps a verifiable contentHash.
 * With co-approval on, only a PENDING_APPROVAL version publishes and the
 * approver must differ from the submitter.
 */
router.post(
  "/versions/:vid/publish",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    assertTransition(TEMPLATE_VERSION_TRANSITIONS, version.lifecycle as TemplateVersionLifecycle, "PUBLISHED", "TEMPLATE_VERSION");

    const changelogNote = String(req.body?.changelogNote ?? version.changelogNote ?? "").trim();
    if (!changelogNote) throw httpError(422, "changelogNote is required to publish (FRD-TLB-02)");

    const actor = auditActor(req);
    const coApproval = await getAuditSetting(
      "publish_co_approval_required",
      AUDIT_SETTING_DEFAULTS.publish_co_approval_required,
    );
    if (coApproval) {
      if (version.lifecycle !== "PENDING_APPROVAL") {
        throw httpError(409, "Co-approval is enabled — submit the draft for approval first (FR-TM-04)");
      }
      if (version.submittedBy && version.submittedBy === actor.id) {
        throw httpError(403, "Co-approval requires a second person — the submitter cannot publish");
      }
    }

    const content = await loadVersionContent(version.id);
    if (content.sections.length === 0) throw httpError(422, "Cannot publish an empty template");
    const emptySections = content.sections.filter(
      (s) => !content.questions.some((q) => q.sectionId === s.id),
    );
    if (emptySections.length > 0) {
      throw httpError(422, "Every section needs at least one question", {
        sections: emptySections.map((s) => s.title),
      });
    }
    const weightless = content.questions.filter(
      (q) => !NON_SCORED_TYPES.has(q.type) && q.weight <= 0,
    );
    if (weightless.length > 0) {
      throw httpError(422, "Scored questions need weight > 0", {
        questions: weightless.map((q) => ({ id: q.id, prompt: q.prompt.slice(0, 80) })),
      });
    }
    // Choice questions must offer ≥2 labelled options, else they render as
    // empty/unanswerable controls and silently drop from scoring at conduct.
    const badChoice = content.questions.filter((q) => {
      if (q.type !== "SINGLE_CHOICE" && q.type !== "MULTI_CHOICE") return false;
      const opts = Array.isArray(q.optionsJson) ? q.optionsJson : [];
      const labelled = opts.filter(
        (o) => o && typeof o === "object" && String((o as { label?: unknown }).label ?? "").trim(),
      );
      return labelled.length < 2;
    });
    if (badChoice.length > 0) {
      throw httpError(422, "Choice questions need at least 2 labelled answer options", {
        questions: badChoice.map((q) => ({ id: q.id, prompt: q.prompt.slice(0, 80) })),
      });
    }

    const snapshot = await buildScaleSnapshot(content.questions);
    const contentHash = computeContentHash(content, snapshot, {
      passThresholdPct: version.passThresholdPct,
      criticalFailGate: version.criticalFailGate,
      reviewRequired: version.reviewRequired,
    });

    const published = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditTemplateVersionsTable)
        .set({
          lifecycle: "PUBLISHED",
          changelogNote,
          ratingScaleSnapshot: snapshot,
          contentHash,
          publishedBy: actor.id,
          approvedBy: coApproval ? actor.id : null,
          publishedAt: new Date(),
        })
        .where(eq(auditTemplateVersionsTable.id, version.id))
        .returning();
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE_VERSION",
        entityId: version.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "STATE_CHANGE",
        fromState: version.lifecycle,
        toState: "PUBLISHED",
        reason: changelogNote,
        afterJson: { contentHash, versionNo: version.versionNo },
      });
      return row!;
    });
    res.json({ success: true, data: published });
  },
);

for (const action of ["deprecate", "archive"] as const) {
  router.post(
    `/versions/:vid/${action}`,
    authenticate,
    authorize("AUDIT_TEMPLATES", "edit"),
    async (req, res) => {
      const version = await loadVersion(req.params["vid"] as string);
      const to = action === "deprecate" ? "DEPRECATED" : "ARCHIVED";
      assertTransition(TEMPLATE_VERSION_TRANSITIONS, version.lifecycle as TemplateVersionLifecycle, to, "TEMPLATE_VERSION");
      const actor = auditActor(req);
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(auditTemplateVersionsTable)
          .set(action === "deprecate" ? { lifecycle: to, deprecatedAt: new Date() } : { lifecycle: to, archivedAt: new Date() })
          .where(eq(auditTemplateVersionsTable.id, version.id))
          .returning();
        await appendAuditEvent(tx, {
          entityType: "TEMPLATE_VERSION",
          entityId: version.id,
          actorId: actor.id,
          actorRole: actor.role,
          kind: "STATE_CHANGE",
          fromState: version.lifecycle,
          toState: to,
          reason: (req.body?.reason as string) ?? null,
        });
        return row!;
      });
      res.json({ success: true, data: updated });
    },
  );
}

/* ── Where-used, migration & diff (FR-TM-03/06) ────────────────────────────── */

router.get(
  "/versions/:vid/where-used",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    const schedules = await db
      .select({
        id: auditSchedulesTable.id,
        title: auditSchedulesTable.title,
        status: auditSchedulesTable.status,
        frequency: auditSchedulesTable.frequency,
      })
      .from(auditSchedulesTable)
      .where(eq(auditSchedulesTable.templateVersionId, version.id));
    const [openAudits] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditsTable)
      .where(
        and(
          eq(auditsTable.templateVersionId, version.id),
          notInArray(auditsTable.state, ["CLOSED", "CANCELLED"]),
        ),
      );
    const [totalAudits] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditsTable)
      .where(eq(auditsTable.templateVersionId, version.id));
    res.json({
      success: true,
      data: { schedules, openAudits: openAudits?.count ?? 0, totalAudits: totalAudits?.count ?? 0 },
    });
  },
);

/** One-click schedule migration to a newer version; open audits keep theirs. */
router.post(
  "/versions/:vid/migrate-schedules",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const fromVersion = await loadVersion(req.params["vid"] as string);
    const toVersion = await loadVersion(String(req.body?.toVersionId ?? ""));
    if (toVersion.templateId !== fromVersion.templateId) {
      throw httpError(422, "Target version belongs to a different template");
    }
    if (toVersion.lifecycle !== "PUBLISHED") {
      throw httpError(422, "Schedules can only migrate to a PUBLISHED version");
    }

    const actor = auditActor(req);
    const now = new Date();
    const migrated = await db.transaction(async (tx) => {
      const schedules = await tx
        .select()
        .from(auditSchedulesTable)
        .where(eq(auditSchedulesTable.templateVersionId, fromVersion.id));
      for (const schedule of schedules) {
        await tx
          .update(auditSchedulesTable)
          .set({ templateVersionId: toVersion.id, lastMaterializedAt: now, updatedAt: now })
          .where(eq(auditSchedulesTable.id, schedule.id));
        // Future-only: regenerate not-yet-live occurrences on the new version.
        await tx
          .delete(auditsTable)
          .where(
            and(
              eq(auditsTable.scheduleId, schedule.id),
              eq(auditsTable.state, "DRAFT"),
              gte(auditsTable.scheduledFor, now),
            ),
          );
        await appendAuditEvent(tx, {
          entityType: "SCHEDULE",
          entityId: schedule.id,
          actorId: actor.id,
          actorRole: actor.role,
          kind: "CONFIG_CHANGE",
          beforeJson: { templateVersionId: fromVersion.id, versionNo: fromVersion.versionNo },
          afterJson: { templateVersionId: toVersion.id, versionNo: toVersion.versionNo },
          reason: "Schedule migrated to newer template version (open audits untouched)",
        });
      }
      return schedules.length;
    });
    res.json({ success: true, data: { migrated } });
  },
);

/** Annotated diff between two versions of the same template (FR-TM-03). */
router.get(
  "/versions/:vid/diff/:otherVid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const a = await loadVersion(req.params["vid"] as string);
    const b = await loadVersion(req.params["otherVid"] as string);
    if (a.templateId !== b.templateId) throw httpError(422, "Versions belong to different templates");

    const [contentA, contentB] = await Promise.all([loadVersionContent(a.id), loadVersionContent(b.id)]);
    const sectionTitlesA = new Set(contentA.sections.map((s) => s.title));
    const sectionTitlesB = new Set(contentB.sections.map((s) => s.title));

    const keyOf = (q: { prompt: string }, sections: typeof contentA.sections, sectionId: string) =>
      `${sections.find((s) => s.id === sectionId)?.title ?? ""}::${q.prompt}`;
    const mapA = new Map(contentA.questions.map((q) => [keyOf(q, contentA.sections, q.sectionId), q]));
    const mapB = new Map(contentB.questions.map((q) => [keyOf(q, contentB.sections, q.sectionId), q]));

    const added = [...mapB.keys()].filter((k) => !mapA.has(k));
    const removed = [...mapA.keys()].filter((k) => !mapB.has(k));
    const changed = [...mapB.keys()]
      .filter((k) => mapA.has(k))
      .map((k) => {
        const qa = mapA.get(k)!;
        const qb = mapB.get(k)!;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const field of ["weight", "type", "mandatory", "evidenceRule"] as const) {
          if (JSON.stringify(qa[field]) !== JSON.stringify(qb[field])) {
            changes[field] = { from: qa[field], to: qb[field] };
          }
        }
        if (JSON.stringify(qa.autoNcJson ?? null) !== JSON.stringify(qb.autoNcJson ?? null)) {
          changes["autoNcRule"] = { from: qa.autoNcJson ?? null, to: qb.autoNcJson ?? null };
        }
        return Object.keys(changes).length ? { question: k, changes } : null;
      })
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        from: { versionNo: a.versionNo, lifecycle: a.lifecycle },
        to: { versionNo: b.versionNo, lifecycle: b.lifecycle },
        sectionsAdded: [...sectionTitlesB].filter((t) => !sectionTitlesA.has(t)),
        sectionsRemoved: [...sectionTitlesA].filter((t) => !sectionTitlesB.has(t)),
        questionsAdded: added,
        questionsRemoved: removed,
        questionsChanged: changed,
      },
    });
  },
);

/* ── Import / export / sandbox preview (FR-TM-07/08) ───────────────────────── */

/** A choice answer option. multiplierPct is bounded 0–100 server-side — the
 *  server is the scoring authority; the UI clamp alone is not enough (an
 *  out-of-range value inflates or corrupts the audit score). */
const choiceOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(200),
  multiplierPct: z.number().min(0).max(100),
});

const importQuestionSchema = z.object({
  prompt: z.string().min(1).max(500),
  helpText: z.string().max(1000).nullish(),
  type: z.enum(QUESTION_TYPES).default("RATING"),
  weight: z.number().int().min(0).default(0),
  mandatory: z.boolean().optional(),
  evidenceRule: z.enum(EVIDENCE_RULES).optional(),
  numericUnit: z.string().max(20).nullish(),
  numericMin: z.number().nullish(),
  numericMax: z.number().nullish(),
  optionsJson: z.array(choiceOptionSchema).nullish(),
  autoNcJson: z.unknown().nullish(),
  bankItemId: z.string().nullish(),
});
const importSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(1000).nullish(),
        audience: z.string().max(50).nullish(),
        questions: z.array(importQuestionSchema).min(1),
      }),
    )
    .min(1),
});

/** All-or-nothing content import into a DRAFT version (replaces content). */
router.post(
  "/versions/:vid/import",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    assertDraftVersion(version);

    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      const report = parsed.error.issues.map((iss) => ({
        path: iss.path.join("."),
        error: iss.message,
      }));
      res.status(422).json({ success: false, error: "Validation failed — nothing imported", details: report });
      return;
    }

    const actor = auditActor(req);
    const counts = await db.transaction(async (tx) => {
      // Replace existing content.
      const oldSections = await tx
        .select({ id: auditSectionsTable.id })
        .from(auditSectionsTable)
        .where(eq(auditSectionsTable.templateVersionId, version.id));
      if (oldSections.length) {
        await tx
          .delete(auditSectionsTable)
          .where(eq(auditSectionsTable.templateVersionId, version.id)); // questions cascade
      }
      let questionCount = 0;
      for (let si = 0; si < parsed.data.sections.length; si++) {
        const s = parsed.data.sections[si]!;
        const sectionId = newId();
        await tx.insert(auditSectionsTable).values({
          id: sectionId,
          templateVersionId: version.id,
          title: s.title,
          description: s.description ?? null,
          audience: s.audience ?? null,
          orderIndex: si,
        });
        for (let qi = 0; qi < s.questions.length; qi++) {
          const q = s.questions[qi]!;
          await tx.insert(auditQuestionsTable).values({
            id: newId(),
            sectionId,
            prompt: q.prompt,
            helpText: q.helpText ?? null,
            type: q.type,
            weight: q.weight,
            mandatory: q.mandatory ?? false,
            evidenceRule: q.evidenceRule ?? "NONE",
            numericUnit: q.numericUnit ?? null,
            numericMin: q.numericMin != null ? String(q.numericMin) : null,
            numericMax: q.numericMax != null ? String(q.numericMax) : null,
            optionsJson: q.optionsJson ?? null,
            autoNcJson: q.autoNcJson ?? null,
            bankItemId: q.bankItemId ?? null,
            orderIndex: qi,
          });
          questionCount += 1;
        }
      }
      await appendAuditEvent(tx, {
        entityType: "TEMPLATE_VERSION",
        entityId: version.id,
        actorId: actor.id,
        actorRole: actor.role,
        kind: "CONFIG_CHANGE",
        reason: `Content imported: ${parsed.data.sections.length} sections, ${questionCount} questions`,
      });
      return { sections: parsed.data.sections.length, questions: questionCount };
    });
    res.json({ success: true, data: counts });
  },
);

/** Export a version's full content as JSON (backup / cross-env promotion). */
router.get(
  "/versions/:vid/export",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    const [template] = await db
      .select()
      .from(auditTemplatesTable)
      .where(eq(auditTemplatesTable.id, version.templateId));
    const content = await loadVersionContent(version.id);
    res.json({
      success: true,
      data: {
        template: {
          name: template?.name,
          auditType: template?.auditType,
          targetType: template?.targetType,
          category: template?.category,
        },
        version: {
          versionNo: version.versionNo,
          lifecycle: version.lifecycle,
          passThresholdPct: version.passThresholdPct,
          criticalFailGate: version.criticalFailGate,
          reviewRequired: version.reviewRequired,
          contentHash: version.contentHash,
        },
        sections: content.sections.map((s) => ({
          title: s.title,
          description: s.description,
          audience: s.audience,
          questions: content.questions
            .filter((q) => q.sectionId === s.id)
            .map((q) => ({
              prompt: q.prompt,
              helpText: q.helpText,
              type: q.type,
              weight: q.weight,
              mandatory: q.mandatory,
              evidenceRule: q.evidenceRule,
              numericUnit: q.numericUnit,
              numericMin: q.numericMin,
              numericMax: q.numericMax,
              optionsJson: q.optionsJson,
              autoNcJson: q.autoNcJson,
            })),
        })),
      },
    });
  },
);

/** Sandbox scoring dry-run — nothing persisted (FRD-TLB-08). */
router.post(
  "/versions/:vid/preview-score",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const version = await loadVersion(req.params["vid"] as string);
    const content = await loadVersionContent(version.id);
    const snapshot =
      version.lifecycle === "PUBLISHED" && version.ratingScaleSnapshot
        ? (version.ratingScaleSnapshot as RatingScaleSnapshot)
        : await buildScaleSnapshot(content.questions);

    const answers = Array.isArray(req.body?.answers)
      ? (req.body.answers as { questionId: string; answerJson: unknown }[])
      : [];
    const naCountsAgainst = await getAuditSetting(
      "na_counts_against",
      AUDIT_SETTING_DEFAULTS.na_counts_against,
    );
    const bands = await db
      .select()
      .from(auditPerformanceBandsTable)
      .orderBy(asc(auditPerformanceBandsTable.orderIndex));

    const result = scoreAudit({
      questions: content.questions.map((q) => ({
        id: q.id,
        sectionId: q.sectionId,
        type: q.type,
        weight: q.weight,
        mandatory: q.mandatory,
        optionsJson: q.optionsJson as never,
        numericMin: q.numericMin != null ? Number(q.numericMin) : null,
        numericMax: q.numericMax != null ? Number(q.numericMax) : null,
      })),
      answers,
      scaleSnapshot: snapshot,
      naCountsAgainst: Boolean(naCountsAgainst),
      passThresholdPct: version.passThresholdPct != null ? Number(version.passThresholdPct) : null,
      criticalFailGate: version.criticalFailGate,
      hasCriticalNc: false,
      bands: bands.map((b) => ({ label: b.label, minPct: Number(b.minPct), maxPct: Number(b.maxPct) })),
    });
    res.json({ success: true, data: { ...result, scaleSnapshot: snapshot } });
  },
);

/* ── Question bank (FA-02) ─────────────────────────────────────────────────── */

const bankRouter: IRouter = Router();

const bankItemSchema = z.object({
  prompt: z.string().min(1).max(500),
  helpText: z.string().max(1000).nullish(),
  type: z.enum(QUESTION_TYPES).default("RATING"),
  defaultWeight: z.number().int().min(0).default(0),
  defaultEvidenceRule: z.enum(EVIDENCE_RULES).default("NONE"),
  defaultAutoNcJson: z.unknown().nullish(),
  defaultOptionsJson: z.array(choiceOptionSchema).nullish(),
  tags: z.array(z.string().max(60)).default([]),
  numericUnit: z.string().max(20).nullish(),
  numericMin: z.number().nullish(),
  numericMax: z.number().nullish(),
});

bankRouter.get(
  "/",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (!q["includeArchived"]) conditions.push(isNull(auditQuestionBankItemsTable.archivedAt));
    if (q["q"]) conditions.push(sql`${auditQuestionBankItemsTable.prompt} ILIKE ${"%" + q["q"] + "%"}`);
    if (q["tag"]) conditions.push(sql`${auditQuestionBankItemsTable.tags}::jsonb ? ${q["tag"]}`);
    if (q["type"]) conditions.push(eq(auditQuestionBankItemsTable.type, q["type"] as never));
    const where = conditions.length ? and(...conditions) : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditQuestionBankItemsTable)
      .where(where);
    const rows = await db
      .select()
      .from(auditQuestionBankItemsTable)
      .where(where)
      .orderBy(desc(auditQuestionBankItemsTable.updatedAt))
      .limit(limit)
      .offset(offset);

    // Usage counts (FRD-QBK-02): questions referencing each bank item.
    const ids = rows.map((r) => r.id);
    const usage = ids.length
      ? await db
          .select({ bankItemId: auditQuestionsTable.bankItemId, count: sql<number>`count(*)::int` })
          .from(auditQuestionsTable)
          .where(inArray(auditQuestionsTable.bankItemId, ids))
          .groupBy(auditQuestionsTable.bankItemId)
      : [];
    const usageMap = new Map(usage.map((u) => [u.bankItemId, u.count]));

    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, usageCount: usageMap.get(r.id) ?? 0 })),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

bankRouter.get(
  "/tags",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (_req, res) => {
    const rows = await db
      .select({ tag: sql<string>`DISTINCT jsonb_array_elements_text(${auditQuestionBankItemsTable.tags}::jsonb)` })
      .from(auditQuestionBankItemsTable)
      .where(isNull(auditQuestionBankItemsTable.archivedAt));
    res.json({ success: true, data: rows.map((r) => r.tag).sort() });
  },
);

/**
 * Near-duplicate detection (FRD-QBK-04): normalize a prompt and score token
 * overlap against active bank items. Returns candidates ≥ 0.7 similarity so the
 * builder can warn on create/import — advisory, never a hard block.
 */
function normalizePrompt(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

bankRouter.get(
  "/check-duplicate",
  authenticate,
  authorize("AUDIT_TEMPLATES", "view"),
  async (req, res) => {
    const prompt = String(req.query["prompt"] ?? "").trim();
    if (!prompt) throw httpError(400, "prompt query param required");
    const tokens = normalizePrompt(prompt);
    const items = await db
      .select({ id: auditQuestionBankItemsTable.id, prompt: auditQuestionBankItemsTable.prompt })
      .from(auditQuestionBankItemsTable)
      .where(isNull(auditQuestionBankItemsTable.archivedAt))
      .limit(2000);
    const matches = items
      .map((it) => ({ id: it.id, prompt: it.prompt, similarity: jaccard(tokens, normalizePrompt(it.prompt)) }))
      .filter((m) => m.similarity >= 0.7)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
    res.json({ success: true, data: { duplicates: matches } });
  },
);

bankRouter.post(
  "/",
  authenticate,
  authorize("AUDIT_TEMPLATES", "create"),
  async (req, res) => {
    const parsed = bankItemSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid bank item", parsed.error.flatten());
    const actor = auditActor(req);
    const [row] = await db
      .insert(auditQuestionBankItemsTable)
      .values({
        id: newId(),
        prompt: parsed.data.prompt,
        helpText: parsed.data.helpText ?? null,
        type: parsed.data.type,
        defaultWeight: parsed.data.defaultWeight,
        defaultEvidenceRule: parsed.data.defaultEvidenceRule,
        defaultAutoNcJson: parsed.data.defaultAutoNcJson ?? null,
        defaultOptionsJson: parsed.data.defaultOptionsJson ?? null,
        tags: parsed.data.tags,
        numericUnit: parsed.data.numericUnit ?? null,
        numericMin: parsed.data.numericMin != null ? String(parsed.data.numericMin) : null,
        numericMax: parsed.data.numericMax != null ? String(parsed.data.numericMax) : null,
        createdBy: actor.id,
      })
      .returning();
    res.status(201).json({ success: true, data: row });
  },
);

bankRouter.patch(
  "/:id",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const [existing] = await db
      .select()
      .from(auditQuestionBankItemsTable)
      .where(eq(auditQuestionBankItemsTable.id, req.params["id"] as string));
    if (!existing) throw httpError(404, "Bank item not found");
    const body = pick(req.body, [
      "prompt", "helpText", "type", "defaultWeight", "defaultEvidenceRule",
      "defaultAutoNcJson", "defaultOptionsJson", "tags", "numericUnit", "numericMin", "numericMax",
    ]);
    if (body.numericMin != null) body.numericMin = String(body.numericMin);
    if (body.numericMax != null) body.numericMax = String(body.numericMax);
    if (body.defaultOptionsJson != null) {
      const opts = z.array(choiceOptionSchema).safeParse(body.defaultOptionsJson);
      if (!opts.success) throw httpError(400, "Invalid answer options", opts.error.flatten());
      body.defaultOptionsJson = opts.data;
    }
    // Copy-on-insert (FRD-QBK-03): editing the bank NEVER mutates templates —
    // template questions are independent copies with only provenance FKs.
    const [row] = await db
      .update(auditQuestionBankItemsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(auditQuestionBankItemsTable.id, existing.id))
      .returning();
    res.json({ success: true, data: row });
  },
);

bankRouter.post(
  "/:id/archive",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const restore = req.body?.restore === true;
    const [row] = await db
      .update(auditQuestionBankItemsTable)
      .set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() })
      .where(eq(auditQuestionBankItemsTable.id, req.params["id"] as string))
      .returning();
    if (!row) throw httpError(404, "Bank item not found");
    res.json({ success: true, data: row });
  },
);

/* ── Builder: sections & questions (FA-03) — DRAFT versions only ───────────── */

const builderRouter: IRouter = Router();

async function loadDraftVersionForSection(sectionId: string) {
  const [section] = await db
    .select()
    .from(auditSectionsTable)
    .where(eq(auditSectionsTable.id, sectionId));
  if (!section) throw httpError(404, "Section not found");
  const version = await loadVersion(section.templateVersionId);
  assertDraftVersion(version);
  return { section, version };
}

builderRouter.post(
  "/sections",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const versionId = String(req.body?.templateVersionId ?? "");
    const title = String(req.body?.title ?? "").trim();
    if (!versionId || !title) throw httpError(400, "templateVersionId and title required");
    const version = await loadVersion(versionId);
    assertDraftVersion(version);

    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${auditSectionsTable.orderIndex}), -1)` })
      .from(auditSectionsTable)
      .where(eq(auditSectionsTable.templateVersionId, versionId));
    const [row] = await db
      .insert(auditSectionsTable)
      .values({
        id: newId(),
        templateVersionId: versionId,
        title,
        description: (req.body?.description as string) ?? null,
        audience: (req.body?.audience as string) ?? null,
        orderIndex: (maxRow?.max ?? -1) + 1,
      })
      .returning();
    res.status(201).json({ success: true, data: row });
  },
);

builderRouter.patch(
  "/sections/:sid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const { section } = await loadDraftVersionForSection(req.params["sid"] as string);
    const body = pick(req.body, ["title", "description", "audience", "orderIndex"]);
    if (Object.keys(body).length === 0) throw httpError(400, "Nothing to update");
    const [row] = await db
      .update(auditSectionsTable)
      .set(body)
      .where(eq(auditSectionsTable.id, section.id))
      .returning();
    res.json({ success: true, data: row });
  },
);

builderRouter.delete(
  "/sections/:sid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const { section } = await loadDraftVersionForSection(req.params["sid"] as string);
    await db.delete(auditSectionsTable).where(eq(auditSectionsTable.id, section.id));
    res.json({ success: true });
  },
);

/** Reorder sections of a draft version (drag / index reorder — FRD-TAU-02). */
builderRouter.post(
  "/sections/reorder",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const versionId = String(req.body?.templateVersionId ?? "");
    const orderedIds = Array.isArray(req.body?.orderedIds) ? (req.body.orderedIds as string[]) : [];
    if (!versionId || orderedIds.length === 0) throw httpError(400, "templateVersionId and orderedIds required");
    const version = await loadVersion(versionId);
    assertDraftVersion(version);
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(auditSectionsTable)
          .set({ orderIndex: i })
          .where(
            and(
              eq(auditSectionsTable.id, orderedIds[i]!),
              eq(auditSectionsTable.templateVersionId, versionId),
            ),
          );
      }
    });
    res.json({ success: true });
  },
);

const questionBodySchema = importQuestionSchema.extend({
  ratingScaleId: z.string().nullish(),
});

/** Add a question — inline, or copy-on-insert from the bank via bankItemId. */
builderRouter.post(
  "/sections/:sid/questions",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const { section } = await loadDraftVersionForSection(req.params["sid"] as string);

    let values: z.infer<typeof questionBodySchema>;
    if (req.body?.bankItemId && !req.body?.prompt) {
      // Copy-on-insert (FRD-QBK-03 / FR-TB-09): copy the bank item's fields;
      // the inserted copy is independently editable within the draft.
      const [item] = await db
        .select()
        .from(auditQuestionBankItemsTable)
        .where(eq(auditQuestionBankItemsTable.id, String(req.body.bankItemId)));
      if (!item) throw httpError(404, "Bank item not found");
      values = {
        prompt: item.prompt,
        helpText: item.helpText,
        type: item.type,
        weight: item.defaultWeight,
        mandatory: false,
        evidenceRule: item.defaultEvidenceRule,
        autoNcJson: item.defaultAutoNcJson,
        numericUnit: item.numericUnit,
        numericMin: item.numericMin != null ? Number(item.numericMin) : null,
        numericMax: item.numericMax != null ? Number(item.numericMax) : null,
        optionsJson: (item.defaultOptionsJson as z.infer<typeof questionBodySchema>["optionsJson"]) ?? null,
        bankItemId: item.id,
        ratingScaleId: null,
      };
    } else {
      const parsed = questionBodySchema.safeParse(req.body);
      if (!parsed.success) throw httpError(400, "Invalid question", parsed.error.flatten());
      values = parsed.data;
    }

    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${auditQuestionsTable.orderIndex}), -1)` })
      .from(auditQuestionsTable)
      .where(eq(auditQuestionsTable.sectionId, section.id));
    const [row] = await db
      .insert(auditQuestionsTable)
      .values({
        id: newId(),
        sectionId: section.id,
        prompt: values.prompt,
        helpText: values.helpText ?? null,
        type: values.type,
        weight: values.weight,
        mandatory: values.mandatory ?? false,
        evidenceRule: values.evidenceRule ?? "NONE",
        ratingScaleId: values.ratingScaleId ?? null,
        optionsJson: values.optionsJson ?? null,
        numericUnit: values.numericUnit ?? null,
        numericMin: values.numericMin != null ? String(values.numericMin) : null,
        numericMax: values.numericMax != null ? String(values.numericMax) : null,
        autoNcJson: values.autoNcJson ?? null,
        bankItemId: values.bankItemId ?? null,
        orderIndex: (maxRow?.max ?? -1) + 1,
      })
      .returning();
    res.status(201).json({ success: true, data: row });
  },
);

builderRouter.patch(
  "/questions/:qid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const [question] = await db
      .select()
      .from(auditQuestionsTable)
      .where(eq(auditQuestionsTable.id, req.params["qid"] as string));
    if (!question) throw httpError(404, "Question not found");
    if (question.auditId) throw httpError(409, "Ad-hoc audit items are not editable here");
    await loadDraftVersionForSection(question.sectionId);

    const body = pick(req.body, [
      "prompt", "helpText", "type", "weight", "mandatory", "evidenceRule",
      "ratingScaleId", "optionsJson", "numericUnit", "numericMin", "numericMax",
      "autoNcJson", "orderIndex", "sectionId",
    ]);
    if (Object.keys(body).length === 0) throw httpError(400, "Nothing to update");
    if (body.weight != null && (!Number.isInteger(body.weight) || body.weight < 0)) {
      throw httpError(422, "weight must be an integer ≥ 0");
    }
    if (body.optionsJson != null) {
      const opts = z.array(choiceOptionSchema).safeParse(body.optionsJson);
      if (!opts.success) throw httpError(400, "Invalid answer options", opts.error.flatten());
      body.optionsJson = opts.data;
    }
    if (body.numericMin != null) body.numericMin = String(body.numericMin);
    if (body.numericMax != null) body.numericMax = String(body.numericMax);
    if (body.sectionId) await loadDraftVersionForSection(String(body.sectionId));

    const [row] = await db
      .update(auditQuestionsTable)
      .set(body)
      .where(eq(auditQuestionsTable.id, question.id))
      .returning();
    res.json({ success: true, data: row });
  },
);

builderRouter.delete(
  "/questions/:qid",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const [question] = await db
      .select()
      .from(auditQuestionsTable)
      .where(eq(auditQuestionsTable.id, req.params["qid"] as string));
    if (!question) throw httpError(404, "Question not found");
    if (question.auditId) throw httpError(409, "Ad-hoc audit items are not deletable here");
    await loadDraftVersionForSection(question.sectionId);
    await db.delete(auditQuestionsTable).where(eq(auditQuestionsTable.id, question.id));
    res.json({ success: true });
  },
);

builderRouter.post(
  "/sections/:sid/questions/reorder",
  authenticate,
  authorize("AUDIT_TEMPLATES", "edit"),
  async (req, res) => {
    const { section } = await loadDraftVersionForSection(req.params["sid"] as string);
    const orderedIds = Array.isArray(req.body?.orderedIds) ? (req.body.orderedIds as string[]) : [];
    if (orderedIds.length === 0) throw httpError(400, "orderedIds required");
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(auditQuestionsTable)
          .set({ orderIndex: i })
          .where(and(eq(auditQuestionsTable.id, orderedIds[i]!), eq(auditQuestionsTable.sectionId, section.id)));
      }
    });
    res.json({ success: true });
  },
);

export { router as auditTemplatesRouter, bankRouter as auditBankRouter, builderRouter as auditBuilderRouter };
