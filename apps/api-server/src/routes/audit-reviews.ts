/**
 * Audit & Inspection — review, approval & closure (FA-12, FRD-REV-01..06).
 * Launch baseline (D-11): review/approve/reject/reopen are performed by
 * Operations Excellence / Super Admin only — enforced by the AUDIT_REVIEW
 * module gate (only those roles hold it) plus isSuperAdmin for reopen.
 */
import { Router, type IRouter } from "express";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  auditsTable,
  auditReviewsTable,
  auditResponsesTable,
  auditEvidenceTable,
  auditTemplateVersionsTable,
  auditTemplatesTable,
  propertiesTable,
  roomsTable,
  usersTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError, isSuperAdmin } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { notify } from "../lib/notification-service.js";
import { applyAuditTransition, REOPENABLE_STATES, type AuditState } from "../lib/audit-state.js";
import {
  auditActor,
  evidenceUrl,
  loadExecutionQuestions,
  maybeAutoCloseAudit,
} from "../lib/audit-service.js";

const router: IRouter = Router();

async function loadAudit(id: string) {
  const [audit] = await db.select().from(auditsTable).where(eq(auditsTable.id, id));
  if (!audit) throw httpError(404, "Audit not found");
  return audit;
}

/** Review queue (Submitted only — PRD §8.5), oldest first. */
router.get(
  "/queue",
  authenticate,
  authorize("AUDIT_REVIEW", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const where = eq(auditsTable.state, "SUBMITTED");
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditsTable)
      .where(where);
    const rows = await db
      .select({
        audit: auditsTable,
        propertyName: propertiesTable.name,
        assigneeName: usersTable.name,
        assigneeRole: usersTable.role,
      })
      .from(auditsTable)
      .leftJoin(propertiesTable, eq(propertiesTable.id, auditsTable.propertyId))
      .leftJoin(usersTable, eq(usersTable.id, auditsTable.assigneeId))
      .where(where)
      .orderBy(asc(auditsTable.submittedAt))
      .limit(limit)
      .offset(offset);
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.audit,
        propertyName: r.propertyName,
        assigneeName: r.assigneeName,
        assigneeRole: r.assigneeRole,
      })),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

/**
 * Review workspace (FRD-REV-01): read-only responses with evidence, score
 * breakdown per section, auditor timeline incl. the auto-captured
 * timings/GPS (FRD-EXE-14) and the live submission proof (D-9).
 */
router.get(
  "/:id/workspace",
  authenticate,
  authorize("AUDIT_REVIEW", "view"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    const [version] = await db
      .select()
      .from(auditTemplateVersionsTable)
      .where(eq(auditTemplateVersionsTable.id, audit.templateVersionId));
    const [template] = version
      ? await db.select().from(auditTemplatesTable).where(eq(auditTemplatesTable.id, version.templateId))
      : [];
    const [property] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, audit.propertyId));
    const [room] = audit.roomId
      ? await db.select().from(roomsTable).where(eq(roomsTable.id, audit.roomId))
      : [];
    const [assignee] = audit.assigneeId
      ? await db
          .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
          .from(usersTable)
          .where(eq(usersTable.id, audit.assigneeId))
      : [];

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
    const reviews = await db
      .select({ review: auditReviewsTable, reviewerName: usersTable.name })
      .from(auditReviewsTable)
      .leftJoin(usersTable, eq(usersTable.id, auditReviewsTable.reviewerId))
      .where(eq(auditReviewsTable.auditId, audit.id))
      .orderBy(desc(auditReviewsTable.createdAt));

    const evidenceWithUrls = await Promise.all(
      evidence.map(async (e) => ({
        ...e,
        url: await evidenceUrl(e.storageKey),
        thumbUrl: e.thumbStorageKey ? await evidenceUrl(e.thumbStorageKey) : null,
      })),
    );

    // Per-section score breakdown from the frozen line scores.
    const responseByQ = new Map(responses.map((r) => [r.questionId, r]));
    const sectionScores = sections.map((s) => {
      let earned = 0;
      let possible = 0;
      for (const q of questions.filter((qq) => qq.sectionId === s.id)) {
        const r = responseByQ.get(q.id);
        if (r?.earnedScore != null && r.maxScore != null) {
          earned += Number(r.earnedScore);
          possible += Number(r.maxScore);
        }
      }
      return { sectionId: s.id, title: s.title, earned, possible, pct: possible > 0 ? (earned / possible) * 100 : null };
    });

    res.json({
      success: true,
      data: {
        audit,
        template: template ? { id: template.id, name: template.name } : null,
        version: version ? { id: version.id, versionNo: version.versionNo, passThresholdPct: version.passThresholdPct, criticalFailGate: version.criticalFailGate } : null,
        target: { propertyName: property?.name ?? null, roomNumber: room?.number ?? null },
        assignee: assignee ?? null,
        scaleSnapshot: version?.ratingScaleSnapshot ?? null,
        sections: sections.map((s) => ({ ...s, questions: questions.filter((q) => q.sectionId === s.id) })),
        responses,
        evidence: evidenceWithUrls,
        submissionProof: evidenceWithUrls.find((e) => e.id === audit.submissionEvidenceId) ?? null,
        sectionScores,
        reviews: reviews.map((r) => ({ ...r.review, reviewerName: r.reviewerName })),
      },
    });
  },
);

/** Approve (PRD §8.5): straight from SUBMITTED; closes right after. */
router.post(
  "/:id/approve",
  authenticate,
  authorize("AUDIT_REVIEW", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    const actor = auditActor(req);

    await db.transaction(async (tx) => {
      await applyAuditTransition(tx, audit, "APPROVED", {
        actor,
        reason: (req.body?.comments as string) ?? "Approved",
      });
      await tx.insert(auditReviewsTable).values({
        id: newId(),
        auditId: audit.id,
        reviewerId: req.user!.id,
        verdict: "APPROVED",
        comments: (req.body?.comments as string) ?? null,
      });
    });

    if (audit.assigneeId) {
      await notify({
        userId: audit.assigneeId,
        title: `Audit ${audit.ticketNo} approved`,
        body: audit.title,
        type: "AUDIT",
        link: `/audits/${audit.id}`,
        entityType: "AUDIT",
        entityId: audit.id,
      });
    }
    // PRD §10: Review → Close (unconditional; safety-net job is the catch-up).
    await maybeAutoCloseAudit(audit.id, actor);
    res.json({ success: true, data: await loadAudit(audit.id) });
  },
);

/**
 * Reject with a mandatory comment. The audit RESTS in REJECTED — the auditor's
 * Rework bucket — with answers preserved. It leaves only via /audits/:id/start,
 * which demands a fresh geotagged start photo, so a rework re-proves presence.
 *
 * This used to collapse REJECTED→IN_PROGRESS inside the same transaction, which
 * meant no row ever committed as REJECTED: every rework affordance in the app
 * was unreachable and the start gate was silently skipped on the second attempt.
 */
router.post(
  "/:id/reject",
  authenticate,
  authorize("AUDIT_REVIEW", "edit"),
  async (req, res) => {
    const audit = await loadAudit(req.params["id"] as string);
    const comment = String(req.body?.comment ?? "").trim();
    if (!comment) throw httpError(422, "A comment is required to reject (FRD-REV-02)");
    const actor = auditActor(req);

    await db.transaction(async (tx) => {
      await applyAuditTransition(tx, audit, "REJECTED", { actor, reason: comment });
      await tx.insert(auditReviewsTable).values({
        id: newId(),
        auditId: audit.id,
        reviewerId: req.user!.id,
        verdict: "REJECTED",
        comments: comment,
      });
    });

    if (audit.assigneeId) {
      await notify({
        userId: audit.assigneeId,
        title: `Audit ${audit.ticketNo} rejected — rework needed`,
        body: comment.slice(0, 180),
        type: "AUDIT",
        link: `/audits/${audit.id}`,
        entityType: "AUDIT",
        entityId: audit.id,
      });
    }
    res.json({ success: true, data: await loadAudit(audit.id) });
  },
);

/**
 * Reopen a finished audit (FRD-REV-06): Operations Excellence only, mandatory
 * reason, prior report revision preserved; resubmission produces revision+1.
 *
 * Accepts any finished state — SUBMITTED, UNDER_REVIEW, APPROVED or CLOSED.
 * It used to accept CLOSED alone while the review UI offered the button for
 * APPROVED too, so that path 409'd. Note approve auto-closes immediately, which
 * made APPROVED a narrow but real window.
 *
 * The audit lands in REJECTED, not IN_PROGRESS: a reopen is the same "send it
 * back" as a rejection, so it shows in the auditor's Rework bucket and re-entry
 * goes through the start gate.
 * AC matrix: non-OE → 403 · missing reason → 422 · valid → REJECTED.
 */
router.post(
  "/:id/reopen",
  authenticate,
  authorize("AUDIT_REVIEW", "edit"),
  async (req, res) => {
    if (!isSuperAdmin(req.user?.role)) {
      throw httpError(403, "Only Operations Excellence may reopen a closed audit (D-11 / FRD-REV-06)");
    }
    const audit = await loadAudit(req.params["id"] as string);
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw httpError(422, "A reason is required to reopen (FRD-REV-06)");
    if (!REOPENABLE_STATES.includes(audit.state as AuditState)) {
      throw httpError(409, "ILLEGAL_TRANSITION", {
        from: audit.state,
        to: "REJECTED",
        allowed: REOPENABLE_STATES,
      });
    }

    await db.transaction(async (tx) => {
      await applyAuditTransition(tx, audit, "REJECTED", {
        actor: auditActor(req),
        reason: `Reopened: ${reason}`,
      });
    });
    if (audit.assigneeId) {
      await notify({
        userId: audit.assigneeId,
        title: `Audit ${audit.ticketNo} reopened`,
        body: reason.slice(0, 180),
        type: "AUDIT",
        link: `/audits/${audit.id}/run`,
        entityType: "AUDIT",
        entityId: audit.id,
      });
    }
    res.json({ success: true, data: await loadAudit(audit.id) });
  },
);

export { router as auditReviewsRouter };
