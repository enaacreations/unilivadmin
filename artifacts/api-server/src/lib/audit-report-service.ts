/**
 * Audit & Inspection — per-audit PDF report generation (FRD-RPT-01).
 *
 * Reports are queued as PENDING rows at submission and rendered asynchronously
 * by runReportWorker() (registered with the other audit jobs): evidence-grade
 * PDF with audit metadata (performed-by, duration, GPS), score summary + trend
 * vs previous instances, rating distribution, per-section item tables and a
 * sign-off block with the live geotagged submission photo (D-9). Underlying
 * data is immutable; reopen produces a NEW revision, prior revisions stay
 * downloadable (REV-06).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  db,
  auditsTable,
  auditReportsTable,
  auditResponsesTable,
  auditEvidenceTable,
  auditTemplateVersionsTable,
  auditTemplatesTable,
  propertiesTable,
  roomsTable,
  usersTable,
} from "@workspace/db";
import { isStorageConfigured, putObject } from "@workspace/storage";
import { logger } from "./logger.js";
import { newId } from "./id.js";
import { notify } from "./notification-service.js";
import { recordAuditEvent } from "./audit-events.js";
import { getAuditSetting, loadExecutionQuestions, AUDIT_SETTING_DEFAULTS, evidenceUrl } from "./audit-service.js";
import type { RatingScaleSnapshot } from "./audit-scoring.js";

const PAGE_W = 595; // A4 portrait
const PAGE_H = 842;
const MARGIN = 40;
const INK = rgb(0.14, 0.1, 0.08);
const ACCENT = rgb(0.91, 0.38, 0.17); // sunset coral
const GREY = rgb(0.45, 0.43, 0.41);
const LIGHT = rgb(0.97, 0.95, 0.93);
const GREEN = rgb(0.08, 0.5, 0.36);
const RED = rgb(0.78, 0.23, 0.2);

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
  pageNo: number;
  tz: string;
}

function newPage(c: Cursor): void {
  c.page = c.doc.addPage([PAGE_W, PAGE_H]);
  c.pageNo += 1;
  c.y = PAGE_H - MARGIN;
  const footer = `UNILIV Audit Report · page ${c.pageNo} · times in ${c.tz}`;
  c.page.drawText(footer, { x: MARGIN, y: 18, size: 7, font: c.font, color: GREY });
}

function ensure(c: Cursor, height: number): void {
  if (c.y - height < MARGIN) newPage(c);
}

function text(
  c: Cursor,
  value: string,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; gap?: number } = {},
): void {
  const size = opts.size ?? 9;
  ensure(c, size + (opts.gap ?? 4));
  c.page.drawText(sanitizePdfText(value), {
    x: opts.x ?? MARGIN,
    y: c.y - size,
    size,
    font: opts.bold ? c.bold : c.font,
    color: opts.color ?? INK,
  });
  c.y -= size + (opts.gap ?? 4);
}

/**
 * Standard PDF fonts use WinAnsi encoding — question prompts and notes can
 * carry arbitrary Unicode (arrows, stars, emoji), so map known glyphs and
 * replace anything else non-encodable rather than throwing mid-render.
 */
const GLYPH_MAP: [RegExp, string][] = [
  [/[↳→➡]/g, "->"],
  [/[←]/g, "<-"],
  [/[✓✔]/g, "v"],
  [/[✗✘❌]/g, "x"],
  [/[★☆]/g, "*"],
  [/[‘’ʼ]/g, "'"],
  [/[“”]/g, '"'],
];
const NON_WINANSI = /[^\x20-\x7E -ÿ–—•…€™]/g;
function sanitizePdfText(value: string): string {
  let s = value;
  for (const [re, repl] of GLYPH_MAP) s = s.replace(re, repl);
  return s.replace(NON_WINANSI, "?");
}

function truncate(font: PDFFont, value: string, size: number, maxW: number): string {
  const clean = sanitizePdfText(value).replace(/[\r\n]+/g, " ");
  const measure = (s: string) => {
    try {
      return font.widthOfTextAtSize(s, size);
    } catch {
      return 0;
    }
  };
  if (measure(clean) <= maxW) return clean;
  let s = clean;
  while (s.length > 0 && measure(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
}

function row(
  c: Cursor,
  cells: { value: string; w: number; bold?: boolean; color?: ReturnType<typeof rgb> }[],
  opts: { shaded?: boolean; size?: number } = {},
): void {
  const size = opts.size ?? 8;
  const h = size + 8;
  ensure(c, h);
  if (opts.shaded) {
    c.page.drawRectangle({ x: MARGIN, y: c.y - h + 2, width: PAGE_W - MARGIN * 2, height: h, color: LIGHT });
  }
  let x = MARGIN + 3;
  for (const cell of cells) {
    c.page.drawText(truncate(cell.bold ? c.bold : c.font, cell.value, size, cell.w - 6), {
      x,
      y: c.y - size - 2,
      size,
      font: cell.bold ? c.bold : c.font,
      color: cell.color ?? INK,
    });
    x += cell.w;
  }
  c.y -= h;
}

function fmt(d: Date | null | undefined, tz: string): string {
  if (!d) return "—";
  return d.toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
}

/** Bytes for an evidence object: inline dev keys decode directly; S3 keys fetch via signed URL. */
async function evidenceBytes(storageKey: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    if (storageKey.startsWith("inline:")) {
      const m = /^inline:data:([^;,]+);base64,(.+)$/s.exec(storageKey);
      if (!m) return null;
      return { bytes: Buffer.from(m[2]!, "base64"), mime: m[1]! };
    }
    if (!isStorageConfigured()) return null;
    const url = await evidenceUrl(storageKey);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "image/jpeg" };
  } catch {
    return null;
  }
}

async function embedImage(c: Cursor, bytes: Uint8Array, mime: string, maxW: number, maxH: number): Promise<void> {
  try {
    const img = mime.includes("png") ? await c.doc.embedPng(bytes) : await c.doc.embedJpg(bytes);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    ensure(c, h + 8);
    c.page.drawImage(img, { x: MARGIN, y: c.y - h, width: w, height: h });
    c.y -= h + 8;
  } catch {
    text(c, "(image could not be embedded)", { size: 7, color: GREY });
  }
}

/** Answer display label from the answer payload + scale snapshot / options. */
function answerLabel(
  question: { type: string; optionsJson: unknown; numericUnit: string | null },
  response: { answerJson: unknown; isNa: boolean } | undefined,
  snapshot: RatingScaleSnapshot | null,
): string {
  if (!response) return "—";
  if (response.isNa) return "N/A";
  const a = (response.answerJson ?? {}) as Record<string, unknown>;
  switch (question.type) {
    case "RATING": {
      const opt = snapshot?.options.find((o) => o.id === String(a["optionId"] ?? ""));
      return opt?.label ?? "—";
    }
    case "SINGLE_CHOICE": {
      const opts = (question.optionsJson ?? []) as { id: string; label: string }[];
      return opts.find((o) => o.id === String(a["optionId"] ?? ""))?.label ?? "—";
    }
    case "MULTI_CHOICE": {
      const opts = (question.optionsJson ?? []) as { id: string; label: string }[];
      const ids = Array.isArray(a["optionIds"]) ? (a["optionIds"] as unknown[]).map(String) : [];
      return opts.filter((o) => ids.includes(o.id)).map((o) => o.label).join(", ") || "—";
    }
    case "NUMERIC":
      return a["value"] != null ? `${a["value"]}${question.numericUnit ? " " + question.numericUnit : ""}` : "—";
    case "SIGNATURE":
      return a["dataUrl"] || a["value"] ? "Signed" : "—";
    case "PHOTO":
      return "See evidence";
    default:
      return a["value"] != null ? String(a["value"]).slice(0, 120) : "—";
  }
}

/** Render the full report PDF for a report row. Returns the PDF bytes. */
export async function renderAuditReportPdf(reportId: string): Promise<Uint8Array> {
  const [report] = await db.select().from(auditReportsTable).where(eq(auditReportsTable.id, reportId));
  if (!report) throw new Error("Report row missing");
  const [audit] = await db.select().from(auditsTable).where(eq(auditsTable.id, report.auditId));
  if (!audit) throw new Error("Audit missing");
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
    ? await db.select().from(usersTable).where(eq(usersTable.id, audit.assigneeId))
    : [];

  const { sections, questions } = await loadExecutionQuestions(audit.templateVersionId, audit.subsetJson, audit.id);
  const responses = await db.select().from(auditResponsesTable).where(eq(auditResponsesTable.auditId, audit.id));
  const responseByQ = new Map(responses.map((r) => [r.questionId, r]));

  // Score trend: previous scored audits for the same target + template family.
  const trend = await db
    .select({ ticketNo: auditsTable.ticketNo, scorePct: auditsTable.scorePct, submittedAt: auditsTable.submittedAt })
    .from(auditsTable)
    .where(
      and(
        eq(auditsTable.propertyId, audit.propertyId),
        eq(auditsTable.auditType, audit.auditType),
        ne(auditsTable.id, audit.id),
        sql`${auditsTable.scorePct} IS NOT NULL`,
        audit.roomId ? eq(auditsTable.roomId, audit.roomId) : sql`true`,
      ),
    )
    .orderBy(desc(auditsTable.submittedAt))
    .limit(5);

  const snapshot = (version?.ratingScaleSnapshot ?? null) as RatingScaleSnapshot | null;
  const tz = String(await getAuditSetting("org_timezone", AUDIT_SETTING_DEFAULTS.org_timezone));

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: Cursor = { doc, page: null as never, y: 0, font, bold, pageNo: 0, tz };
  newPage(c);

  // ── Header ────────────────────────────────────────────────────────────────
  c.page.drawRectangle({ x: 0, y: PAGE_H - 64, width: PAGE_W, height: 64, color: INK });
  c.page.drawText("UNILIV — Audit Report", { x: MARGIN, y: PAGE_H - 34, size: 16, font: bold, color: rgb(1, 1, 1) });
  c.page.drawText(`${report.reportNo} · revision ${report.revision}`, { x: MARGIN, y: PAGE_H - 52, size: 9, font, color: rgb(0.9, 0.85, 0.8) });
  c.y = PAGE_H - 80;

  // ── Audit metadata (FRD-EXE-14 surfaced) ──────────────────────────────────
  text(c, `${audit.ticketNo} — ${audit.title}`, { size: 13, bold: true, gap: 6 });
  const target = room ? `${property?.name ?? "?"} · Room ${room.number}` : property?.name ?? "?";
  const meta: [string, string][] = [
    ["Template", `${template?.name ?? "?"} (v${version?.versionNo ?? "?"}, ${audit.auditType})`],
    ["Target", target],
    ["Performed by", assignee ? `${assignee.name} (${assignee.role.replace(/_/g, " ")})` : "—"],
    ["Started", `${fmt(audit.startedAt, tz)}${audit.startGeoLat != null ? `  @ ${audit.startGeoLat.toFixed(5)}, ${audit.startGeoLng?.toFixed(5)}` : ""}`],
    ["Submitted", `${fmt(audit.submittedAt, tz)}${audit.submitGeoLat != null ? `  @ ${audit.submitGeoLat.toFixed(5)}, ${audit.submitGeoLng?.toFixed(5)}` : ""}`],
    ["Duration", audit.durationSeconds != null ? `${Math.floor(audit.durationSeconds / 60)}m ${audit.durationSeconds % 60}s` : "—"],
    ["Status", audit.state],
  ];
  for (const [k, v] of meta) {
    row(c, [
      { value: k, w: 110, bold: true, color: GREY },
      { value: v, w: PAGE_W - MARGIN * 2 - 110 },
    ]);
  }
  c.y -= 6;

  // ── Score summary ─────────────────────────────────────────────────────────
  text(c, "Score", { size: 11, bold: true, gap: 6 });
  const pct = audit.scorePct != null ? Number(audit.scorePct) : null;
  const scoreLine = pct != null
    ? `(${Number(audit.earnedScore).toFixed(2)}/${Number(audit.maxScore).toFixed(2)})  ${pct.toFixed(2)}%`
    : "Not scored";
  text(c, scoreLine, { size: 14, bold: true, color: ACCENT, gap: 2 });
  if (audit.result || audit.scoreBand) {
    text(c, `${audit.result ?? ""}${audit.result && audit.scoreBand ? " · " : ""}${audit.scoreBand ?? ""}`, {
      size: 10,
      bold: true,
      color: audit.result === "FAIL" ? RED : GREEN,
      gap: 6,
    });
  }
  if (trend.length) {
    text(c, "Previous instances:", { size: 8, color: GREY, gap: 2 });
    for (const t of trend) {
      text(c, `  ${t.ticketNo} — ${Number(t.scorePct).toFixed(2)}%  (${fmt(t.submittedAt, tz)})`, { size: 8, color: GREY, gap: 2 });
    }
  }

  // ── Rating distribution ───────────────────────────────────────────────────
  if (snapshot) {
    const counts = new Map<string, number>();
    for (const r of responses) {
      if (r.isNa) {
        counts.set("N/A", (counts.get("N/A") ?? 0) + 1);
        continue;
      }
      const optionId = ((r.answerJson ?? {}) as Record<string, unknown>)["optionId"];
      const label = snapshot.options.find((o) => o.id === String(optionId ?? ""))?.label;
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size) {
      c.y -= 4;
      text(c, "Rating distribution", { size: 11, bold: true, gap: 6 });
      const distLine = [...counts.entries()].map(([label, n]) => `${label}: ${n}`).join("   ·   ");
      text(c, distLine, { size: 9, gap: 8 });
    }
  }

  // ── Per-section item tables ───────────────────────────────────────────────
  const usable = PAGE_W - MARGIN * 2;
  const colItem = usable - 90 - 60 - 60;
  const lineByQ = new Map(responses.map((r) => [r.questionId, r]));
  for (const section of sections) {
    const sectionQuestions = questions.filter((q) => q.sectionId === section.id);
    if (!sectionQuestions.length) continue;
    let earned = 0;
    let possible = 0;
    for (const q of sectionQuestions) {
      const r = lineByQ.get(q.id);
      if (r?.earnedScore != null && r.maxScore != null) {
        earned += Number(r.earnedScore);
        possible += Number(r.maxScore);
      }
    }
    c.y -= 6;
    ensure(c, 60);
    text(c, `${section.title}  (${earned.toFixed(2)}/${possible.toFixed(2)})`, { size: 10, bold: true, gap: 4 });
    row(
      c,
      [
        { value: "Item", w: colItem, bold: true, color: GREY },
        { value: "Answer", w: 90, bold: true, color: GREY },
        { value: "Weight", w: 60, bold: true, color: GREY },
        { value: "Score", w: 60, bold: true, color: GREY },
      ],
      { shaded: true },
    );
    let idx = 0;
    for (const q of sectionQuestions) {
      const r = lineByQ.get(q.id);
      idx += 1;
      row(
        c,
        [
          { value: `${idx}. ${q.prompt}${q.adHoc ? "  [ad-hoc]" : ""}`, w: colItem },
          { value: answerLabel(q, r, snapshot), w: 90 },
          { value: q.type === "INSTRUCTION" ? "—" : String(q.weight), w: 60 },
          { value: r?.earnedScore != null ? Number(r.earnedScore).toFixed(2) : "—", w: 60 },
        ],
        { shaded: idx % 2 === 0 },
      );
      if (r?.notes) {
        row(c, [{ value: `   note: ${r.notes}`, w: usable, color: GREY }], { size: 7 });
      }
    }
  }

  // ── Sign-off block with the live submission proof (D-9) ──────────────────
  c.y -= 10;
  ensure(c, 160);
  text(c, "Sign-off", { size: 11, bold: true, gap: 6 });
  if (audit.submissionEvidenceId) {
    const [proof] = await db
      .select()
      .from(auditEvidenceTable)
      .where(eq(auditEvidenceTable.id, audit.submissionEvidenceId));
    if (proof) {
      const bytes = await evidenceBytes(proof.thumbStorageKey ?? proof.storageKey);
      if (bytes) await embedImage(c, bytes.bytes, bytes.mime, 180, 130);
      text(
        c,
        `Live submission photo · captured ${fmt(proof.capturedAt ?? proof.createdAt, tz)} @ ${proof.geoLat?.toFixed(5)}, ${proof.geoLng?.toFixed(5)} (±${proof.geoAccuracyM ?? "?"}m)`,
        { size: 7, color: GREY, gap: 8 },
      );
    }
  }
  text(c, `Performed by: ${assignee?.name ?? "—"}    Submitted: ${fmt(audit.submittedAt, tz)}`, { size: 9, gap: 2 });
  text(c, `Report generated on ${fmt(new Date(), tz)} · timezone ${tz} · ${report.reportNo}`, { size: 7, color: GREY });

  return doc.save();
}

/** Store the PDF (S3, or inline data-URL key in dev like evidence). */
async function storeReportPdf(key: string, bytes: Uint8Array): Promise<string> {
  if (isStorageConfigured()) {
    await putObject(key, bytes, "application/pdf");
    return key;
  }
  return `inline:data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Generate one report row end-to-end; safe to retry (attempts capped). */
export async function generateAuditReport(reportId: string): Promise<void> {
  const [report] = await db
    .select()
    .from(auditReportsTable)
    .where(eq(auditReportsTable.id, reportId));
  if (!report || report.status === "COMPLETED") return;

  await db
    .update(auditReportsTable)
    .set({ status: "RUNNING", attempts: report.attempts + 1 })
    .where(eq(auditReportsTable.id, reportId));

  try {
    const bytes = await renderAuditReportPdf(reportId);
    const key = `audit-reports/${report.auditId}/rev${report.revision}-${newId().slice(0, 8)}.pdf`;
    const storageKey = await storeReportPdf(key, bytes);
    await db
      .update(auditReportsTable)
      .set({ status: "COMPLETED", storageKey, sizeBytes: bytes.length, generatedAt: new Date(), error: null })
      .where(eq(auditReportsTable.id, reportId));
    await recordAuditEvent({
      entityType: "REPORT",
      entityId: reportId,
      auditId: report.auditId,
      actorId: null,
      actorRole: "SYSTEM",
      kind: "STATE_CHANGE",
      fromState: "PENDING",
      toState: "COMPLETED",
      reason: `Report ${report.reportNo} generated (${Math.round(bytes.length / 1024)} KB)`,
    });
    const [audit] = await db
      .select({ assigneeId: auditsTable.assigneeId, ticketNo: auditsTable.ticketNo, id: auditsTable.id })
      .from(auditsTable)
      .where(eq(auditsTable.id, report.auditId));
    if (audit?.assigneeId) {
      await notify({
        userId: audit.assigneeId,
        title: `Report ready: ${report.reportNo}`,
        body: `The PDF report for ${audit.ticketNo} is ready to view and share.`,
        type: "AUDIT_REPORT",
        link: `/audits/reports/${reportId}`,
        entityType: "REPORT",
        entityId: reportId,
      });
    }
  } catch (err) {
    logger.error({ err, reportId }, "audit report generation failed");
    await db
      .update(auditReportsTable)
      .set({ status: "FAILED", error: String((err as Error)?.message ?? err) })
      .where(eq(auditReportsTable.id, reportId));
  }
}

/**
 * Sweep worker (NFR-08): renders PENDING reports and retries FAILED/stale
 * RUNNING ones up to 3 attempts. Registered with the 5-minute audit jobs.
 */
export async function runReportWorker(): Promise<void> {
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const rows = await db
    .select({ id: auditReportsTable.id, status: auditReportsTable.status, createdAt: auditReportsTable.createdAt })
    .from(auditReportsTable)
    .where(
      and(
        inArray(auditReportsTable.status, ["PENDING", "FAILED", "RUNNING"]),
        lt(auditReportsTable.attempts, 3),
      ),
    )
    .orderBy(asc(auditReportsTable.createdAt))
    .limit(20);
  for (const rowItem of rows) {
    // RUNNING rows only retry when stale (a crashed prior worker).
    if (rowItem.status === "RUNNING" && rowItem.createdAt > staleBefore) continue;
    await generateAuditReport(rowItem.id);
  }
}
