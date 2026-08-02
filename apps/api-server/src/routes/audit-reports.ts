/**
 * Audit & Inspection — report registry, sharing, named reports & dashboards
 * (FA-13/FA-14: FRD-RPT-01..04, FRD-ANL-01/02/03/07, D-5).
 *
 * Sharing: expiring signed links via tokens (public router mounted pre-auth);
 * WhatsApp channel returns 501 CHANNEL_NOT_ENABLED at launch (deferred).
 * Every list/aggregate composes scopeAuditsCondition so scoped-out audit
 * types/properties are absent everywhere including counts (FRD-ACC-05 AC).
 */
import { randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  auditsTable,
  auditReportsTable,
  auditReportSharesTable,
  auditTemplateVersionsTable,
  auditTemplatesTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { toCsv, toPdf, toXls, fileDateStamp, type ExportTable } from "../lib/export-service.js";
import { recordAuditEvent } from "../lib/audit-events.js";
import { auditActor, getAuditSetting, evidenceUrl, AUDIT_SETTING_DEFAULTS } from "../lib/audit-service.js";
import { generateAuditReport } from "../lib/audit-report-service.js";
import {
  resolveAuditAccess,
  scopeAuditsCondition,
  canView,
  type AuditType,
} from "../lib/audit-access.js";

const router: IRouter = Router();

/* ── Report registry & access (FRD-RPT-02) ─────────────────────────────────── */

router.get(
  "/",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const access = await resolveAuditAccess(req.user!);
    const scope = scopeAuditsCondition(access);

    const conditions = [];
    if (scope) conditions.push(scope);
    if (req.query["auditId"]) conditions.push(eq(auditReportsTable.auditId, String(req.query["auditId"])));
    const where = conditions.length ? and(...conditions) : undefined;

    const base = db
      .select({
        report: auditReportsTable,
        ticketNo: auditsTable.ticketNo,
        title: auditsTable.title,
        state: auditsTable.state,
        auditType: auditsTable.auditType,
        propertyName: propertiesTable.name,
      })
      .from(auditReportsTable)
      .innerJoin(auditsTable, eq(auditsTable.id, auditReportsTable.auditId))
      .leftJoin(propertiesTable, eq(propertiesTable.id, auditsTable.propertyId));

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditReportsTable)
      .innerJoin(auditsTable, eq(auditsTable.id, auditReportsTable.auditId))
      .where(where);
    const rows = await base.where(where).orderBy(desc(auditReportsTable.createdAt)).limit(limit).offset(offset);

    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.report,
        ticketNo: r.ticketNo,
        title: r.title,
        auditState: r.state,
        auditType: r.auditType,
        propertyName: r.propertyName,
      })),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

/**
 * Properties for the Reports property filter, scoped to the caller's audit
 * access (AUDIT_REPORTS-gated). Distinct properties that have at least one
 * audit the caller may see — so scoped roles (Unit Lead, City Head, …) get a
 * working filter without needing the general PROPERTIES module.
 */
router.get(
  "/filter-properties",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const access = await resolveAuditAccess(req.user!);
    const scope = scopeAuditsCondition(access);
    const rows = await db
      .selectDistinct({ id: propertiesTable.id, name: propertiesTable.name })
      .from(auditsTable)
      .innerJoin(propertiesTable, eq(propertiesTable.id, auditsTable.propertyId))
      .where(scope ? scope : undefined)
      .orderBy(propertiesTable.name);
    res.json({ success: true, data: rows });
  },
);

router.get(
  "/:id",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const [report] = await db
      .select()
      .from(auditReportsTable)
      .where(eq(auditReportsTable.id, req.params["id"] as string));
    if (!report) throw httpError(404, "Report not found");
    const [audit] = await db.select().from(auditsTable).where(eq(auditsTable.id, report.auditId));
    if (!audit) throw httpError(404, "Audit not found");
    const access = await resolveAuditAccess(req.user!);
    if (audit.assigneeId !== req.user!.id && !canView(access, audit.auditType as AuditType, audit.propertyId)) {
      throw httpError(403, "Outside your audit access scope");
    }
    const shares = await db
      .select()
      .from(auditReportSharesTable)
      .where(eq(auditReportSharesTable.reportId, report.id))
      .orderBy(desc(auditReportSharesTable.createdAt));
    res.json({
      success: true,
      data: {
        ...report,
        ticketNo: audit.ticketNo,
        title: audit.title,
        url: report.storageKey ? await evidenceUrl(report.storageKey) : null,
        shares,
      },
    });
  },
);

/** Force (re)generation — admin convenience; underlying data stays immutable. */
router.post(
  "/:id/generate",
  authenticate,
  authorize("AUDIT_REPORTS", "edit"),
  async (req, res) => {
    const [report] = await db
      .select()
      .from(auditReportsTable)
      .where(eq(auditReportsTable.id, req.params["id"] as string));
    if (!report) throw httpError(404, "Report not found");
    await db
      .update(auditReportsTable)
      .set({ status: "PENDING", attempts: 0, error: null })
      .where(eq(auditReportsTable.id, report.id));
    await generateAuditReport(report.id);
    const [fresh] = await db.select().from(auditReportsTable).where(eq(auditReportsTable.id, report.id));
    res.json({ success: true, data: fresh });
  },
);

/** Create an expiring signed share link (D-5); logged as a SHARE event. */
router.post(
  "/:id/shares",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const [report] = await db
      .select()
      .from(auditReportsTable)
      .where(eq(auditReportsTable.id, req.params["id"] as string));
    if (!report) throw httpError(404, "Report not found");
    if (report.status !== "COMPLETED") throw httpError(409, "Report is not generated yet");

    const channel = String(req.body?.channel ?? "LINK").toUpperCase();
    if (channel === "WHATSAPP") {
      // D-5 deferral: enum + rule slots exist; provider is a fast-follow.
      // 422 (not 501) so the central error handler surfaces the code to the UI.
      throw httpError(422, "CHANNEL_NOT_ENABLED", { channel: "WHATSAPP" });
    }
    if (!["LINK", "EMAIL"].includes(channel)) throw httpError(400, "channel must be LINK | EMAIL");

    const defaultTtl = Number(
      await getAuditSetting("report_share_ttl_hours", AUDIT_SETTING_DEFAULTS.report_share_ttl_hours),
    );
    const ttlHours = Math.min(Math.max(Number(req.body?.ttlHours ?? defaultTtl), 1), 24 * 30);
    const token = randomBytes(24).toString("base64url");

    const [share] = await db
      .insert(auditReportSharesTable)
      .values({
        id: newId(),
        reportId: report.id,
        token,
        channel,
        recipient: (req.body?.recipient as string) ?? null,
        expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
        createdBy: req.user!.id,
      })
      .returning();

    const actor = auditActor(req);
    await recordAuditEvent({
      entityType: "REPORT",
      entityId: report.id,
      auditId: report.auditId,
      actorId: actor.id,
      actorRole: actor.role,
      kind: "SHARE",
      reason: `Share link created (${channel}, expires in ${ttlHours}h)`,
      afterJson: { shareId: share!.id, channel, recipient: share!.recipient },
    });

    res.status(201).json({
      success: true,
      data: { ...share, url: `/api/audit-shared/${token}` },
    });
  },
);

router.delete(
  "/:id/shares/:sid",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const [share] = await db
      .update(auditReportSharesTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(auditReportSharesTable.id, req.params["sid"] as string),
          eq(auditReportSharesTable.reportId, req.params["id"] as string),
        ),
      )
      .returning();
    if (!share) throw httpError(404, "Share not found");
    res.json({ success: true });
  },
);

/* ── Named operational reports (FRD-RPT-04) ────────────────────────────────── */

const NAMED_REPORTS = [
  "audit-summary",
  "property-compliance",
  "auditor-performance",
  "failed-audits",
  "overdue-audits",
] as const;

router.get(
  "/named/:key",
  authenticate,
  authorize("AUDIT_REPORTS", "view"),
  async (req, res) => {
    const key = req.params["key"] as (typeof NAMED_REPORTS)[number];
    if (!NAMED_REPORTS.includes(key)) throw httpError(404, "Unknown report");
    const q = req.query as Record<string, string | undefined>;
    const access = await resolveAuditAccess(req.user!);

    const conditions = [];
    const scope = scopeAuditsCondition(access);
    if (scope) conditions.push(scope);
    conditions.push(sql`${auditsTable.state} != 'CANCELLED'`);
    if (q["auditType"]) conditions.push(eq(auditsTable.auditType, q["auditType"] as AuditType));
    if (q["propertyId"]) conditions.push(eq(auditsTable.propertyId, q["propertyId"]));
    if (q["assigneeId"]) conditions.push(eq(auditsTable.assigneeId, q["assigneeId"]));
    if (q["from"]) conditions.push(gte(auditsTable.createdAt, new Date(q["from"])));
    if (q["to"]) {
      const to = new Date(q["to"]);
      to.setHours(23, 59, 59, 999);
      conditions.push(lte(auditsTable.createdAt, to));
    }
    if (key === "failed-audits") conditions.push(eq(auditsTable.result, "FAIL"));
    if (key === "overdue-audits") {
      conditions.push(eq(auditsTable.isOverdue, true));
      conditions.push(inArray(auditsTable.state, ["SCHEDULED", "IN_PROGRESS", "PAUSED"]));
    }

    const rows = await db
      .select({
        audit: auditsTable,
        propertyName: propertiesTable.name,
        assigneeName: usersTable.name,
      })
      .from(auditsTable)
      .leftJoin(propertiesTable, eq(propertiesTable.id, auditsTable.propertyId))
      .leftJoin(usersTable, eq(usersTable.id, auditsTable.assigneeId))
      .where(and(...conditions))
      .orderBy(desc(auditsTable.createdAt))
      .limit(5000);

    let table: ExportTable;
    if (key === "property-compliance") {
      const byProperty = new Map<string, { name: string; total: number; scored: number; passed: number; pctSum: number }>();
      for (const r of rows) {
        const cur = byProperty.get(r.audit.propertyId) ?? { name: r.propertyName ?? "?", total: 0, scored: 0, passed: 0, pctSum: 0 };
        cur.total += 1;
        if (r.audit.scorePct != null) {
          cur.scored += 1;
          cur.pctSum += Number(r.audit.scorePct);
          if (r.audit.result === "PASS") cur.passed += 1;
        }
        byProperty.set(r.audit.propertyId, cur);
      }
      table = {
        title: "Property Compliance",
        headers: ["Property", "Audits", "Scored", "Avg score %", "Passed", "Compliance %"],
        rows: [...byProperty.values()].map((p) => [
          p.name,
          p.total,
          p.scored,
          p.scored ? (p.pctSum / p.scored).toFixed(2) : "0",
          p.passed,
          p.scored ? ((p.passed / p.scored) * 100).toFixed(2) : "0",
        ]),
      };
    } else if (key === "auditor-performance") {
      const byAuditor = new Map<string, { name: string; completed: number; pctSum: number; scored: number; onTime: number; durationSum: number; withDuration: number }>();
      for (const r of rows) {
        if (!r.audit.assigneeId) continue;
        const cur = byAuditor.get(r.audit.assigneeId) ?? { name: r.assigneeName ?? "?", completed: 0, pctSum: 0, scored: 0, onTime: 0, durationSum: 0, withDuration: 0 };
        if (r.audit.submittedAt) {
          cur.completed += 1;
          if (r.audit.dueAt && r.audit.submittedAt <= r.audit.dueAt) cur.onTime += 1;
          if (r.audit.durationSeconds != null) {
            cur.durationSum += r.audit.durationSeconds;
            cur.withDuration += 1;
          }
        }
        if (r.audit.scorePct != null) {
          cur.scored += 1;
          cur.pctSum += Number(r.audit.scorePct);
        }
        byAuditor.set(r.audit.assigneeId, cur);
      }
      table = {
        title: "Auditor Performance",
        headers: ["Auditor", "Completed", "Avg score %", "On-time %", "Avg duration (min)"],
        rows: [...byAuditor.values()].map((a) => [
          a.name,
          a.completed,
          a.scored ? (a.pctSum / a.scored).toFixed(2) : "0",
          a.completed ? ((a.onTime / a.completed) * 100).toFixed(2) : "0",
          a.withDuration ? (a.durationSum / a.withDuration / 60).toFixed(1) : "0",
        ]),
      };
    } else {
      const title =
        key === "failed-audits" ? "Failed Audits" : key === "overdue-audits" ? "Overdue Audits" : "Audit Summary";
      table = {
        title,
        headers: ["Ticket", "Title", "Type", "Property", "Assignee", "Status", "Score %", "Result", "Scheduled", "Submitted"],
        rows: rows.map((r) => [
          r.audit.ticketNo,
          r.audit.title,
          r.audit.auditType,
          r.propertyName ?? "",
          r.assigneeName ?? "",
          r.audit.state + (r.audit.isOverdue ? " (OVERDUE)" : ""),
          r.audit.scorePct != null ? Number(r.audit.scorePct).toFixed(2) : "",
          r.audit.result ?? "",
          r.audit.scheduledFor?.toISOString().slice(0, 16).replace("T", " ") ?? "",
          r.audit.submittedAt?.toISOString().slice(0, 16).replace("T", " ") ?? "",
        ]),
      };
    }

    const format = (q["format"] ?? "json").toLowerCase();
    const filename = `${key}-${fileDateStamp()}`;
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      res.send(toCsv(table));
      return;
    }
    if (format === "xlsx" || format === "xls") {
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.xls"`);
      res.send(toXls(table));
      return;
    }
    if (format === "pdf") {
      const bytes = await toPdf(table);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
      res.send(Buffer.from(bytes));
      return;
    }
    // Empty state, not blank (FRD-RPT-04): headers always present.
    res.json({ success: true, data: { title: table.title, headers: table.headers, rows: table.rows } });
  },
);

/* ── Dashboards & KPIs (FRD-ANL-01/02/03/07) ───────────────────────────────── */

router.get(
  "/dashboard/summary",
  authenticate,
  authorize("AUDIT_DASHBOARD", "view"),
  async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const access = await resolveAuditAccess(req.user!);
    const conditions = [];
    const scope = scopeAuditsCondition(access);
    if (scope) conditions.push(scope);
    if (q["auditType"]) conditions.push(eq(auditsTable.auditType, q["auditType"] as AuditType));
    if (q["propertyId"]) conditions.push(eq(auditsTable.propertyId, q["propertyId"]));
    if (q["from"]) conditions.push(gte(auditsTable.createdAt, new Date(q["from"])));
    if (q["to"]) {
      const to = new Date(q["to"]);
      to.setHours(23, 59, 59, 999);
      conditions.push(lte(auditsTable.createdAt, to));
    }
    const where = conditions.length ? and(...conditions) : undefined;

    // Status counts (FRD-ANL-01) — zeros not blanks.
    const statusRows = await db
      .select({ state: auditsTable.state, count: sql<number>`count(*)::int` })
      .from(auditsTable)
      .where(where)
      .groupBy(auditsTable.state);
    const statusCounts: Record<string, number> = {
      DRAFT: 0, SCHEDULED: 0, IN_PROGRESS: 0, PAUSED: 0, SUBMITTED: 0,
      UNDER_REVIEW: 0, REJECTED: 0, APPROVED: 0, CLOSED: 0, CANCELLED: 0,
    };
    for (const r of statusRows) statusCounts[r.state] = r.count;

    // KPI tiles (FRD-ANL-07).
    const [kpi] = await db
      .select({
        total: sql<number>`count(*) filter (where ${auditsTable.state} != 'CANCELLED')::int`,
        completed: sql<number>`count(*) filter (where ${auditsTable.state} in ('SUBMITTED','UNDER_REVIEW','APPROVED','CLOSED'))::int`,
        avgScore: sql<number>`coalesce(avg(${auditsTable.scorePct}), 0)::float`,
        scored: sql<number>`count(*) filter (where ${auditsTable.scorePct} is not null)::int`,
        passed: sql<number>`count(*) filter (where ${auditsTable.result} = 'PASS')::int`,
        overdue: sql<number>`count(*) filter (where ${auditsTable.isOverdue} and ${auditsTable.state} in ('SCHEDULED','IN_PROGRESS','PAUSED'))::int`,
        onTime: sql<number>`count(*) filter (where ${auditsTable.submittedAt} is not null and (${auditsTable.dueAt} is null or ${auditsTable.submittedAt} <= ${auditsTable.dueAt}))::int`,
        submitted: sql<number>`count(*) filter (where ${auditsTable.submittedAt} is not null)::int`,
        activeAuditors: sql<number>`count(distinct ${auditsTable.assigneeId}) filter (where ${auditsTable.submittedAt} is not null)::int`,
      })
      .from(auditsTable)
      .where(where);

    // Score trend by month (FRD-ANL-02), last 6 months.
    const trend = await db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${auditsTable.submittedAt}), 'YYYY-MM')`,
        avgScore: sql<number>`avg(${auditsTable.scorePct})::float`,
        count: sql<number>`count(*)::int`,
      })
      .from(auditsTable)
      .where(and(where ?? sql`true`, sql`${auditsTable.scorePct} IS NOT NULL`))
      .groupBy(sql`date_trunc('month', ${auditsTable.submittedAt})`)
      .orderBy(sql`date_trunc('month', ${auditsTable.submittedAt})`)
      .limit(12);

    // Audit volume per template (FRD-ANL-04).
    const volumeByTemplate = await db
      .select({
        templateId: auditTemplatesTable.id,
        templateName: auditTemplatesTable.name,
        auditType: auditTemplatesTable.auditType,
        count: sql<number>`count(*)::int`,
      })
      .from(auditsTable)
      .innerJoin(auditTemplateVersionsTable, eq(auditTemplateVersionsTable.id, auditsTable.templateVersionId))
      .innerJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
      .where(where ?? sql`true`)
      .groupBy(auditTemplatesTable.id, auditTemplatesTable.name, auditTemplatesTable.auditType)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    res.json({
      success: true,
      data: {
        statusCounts,
        kpis: {
          completionRate: kpi!.total ? (kpi!.completed / kpi!.total) * 100 : 0,
          averageScore: kpi!.avgScore ?? 0,
          onTimePct: kpi!.submitted ? (kpi!.onTime / kpi!.submitted) * 100 : 0,
          overdueCount: kpi!.overdue ?? 0,
          compliancePct: kpi!.scored ? (kpi!.passed / kpi!.scored) * 100 : 0,
          activeAuditors: kpi!.activeAuditors ?? 0,
          totalAudits: kpi!.total ?? 0,
        },
        scoreTrend: trend,
        volumeByTemplate,
      },
    });
  },
);

export { router as auditReportsRouter };

/* ── Public share access (pre-auth mount, like esign) ──────────────────────── */

const publicRouter: IRouter = Router();

publicRouter.get("/:token", async (req, res) => {
  const [share] = await db
    .select()
    .from(auditReportSharesTable)
    .where(eq(auditReportSharesTable.token, req.params["token"] as string));
  if (!share || share.revokedAt) {
    res.status(404).json({ success: false, error: "Share link not found or revoked" });
    return;
  }
  if (share.expiresAt < new Date()) {
    res.status(410).json({ success: false, error: "Share link has expired" });
    return;
  }
  const [report] = await db
    .select()
    .from(auditReportsTable)
    .where(eq(auditReportsTable.id, share.reportId));
  if (!report?.storageKey) {
    res.status(404).json({ success: false, error: "Report not available" });
    return;
  }

  await db
    .update(auditReportSharesTable)
    .set({ accessCount: share.accessCount + 1, lastAccessAt: new Date() })
    .where(eq(auditReportSharesTable.id, share.id));

  if (report.storageKey.startsWith("inline:")) {
    const m = /^inline:data:application\/pdf;base64,(.+)$/s.exec(report.storageKey);
    if (!m) {
      res.status(500).json({ success: false, error: "Report unreadable" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${report.reportNo}.pdf"`);
    res.send(Buffer.from(m[1]!, "base64"));
    return;
  }
  const url = await evidenceUrl(report.storageKey);
  if (!url) {
    res.status(503).json({ success: false, error: "Storage not available" });
    return;
  }
  res.redirect(url);
});

export { publicRouter as auditSharedPublicRouter };
