/**
 * Tabular export helpers — produce CSV, PDF (via pdf-lib, already a
 * dependency) and XLS (dependency-free SpreadsheetML 2003 XML). Used by report
 * and guest-list exports (Persona st.34, st.47).
 *
 * Every export carries a human-readable document header showing the property
 * name and the export date.
 *
 * WS4 (security): every cell — CSV and XLS alike — is neutralised against
 * spreadsheet formula injection. CSV cells beginning with a formula trigger
 * (`= + - @`, tab, CR) are prefixed with a single quote; XLS cells are always
 * emitted as String-typed data so a value is never evaluated as a formula.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ExportTable {
  title: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
  /** Optional property name rendered in the document/header line. */
  propertyName?: string | null;
  /** Optional data date-range label rendered in the header (e.g. "01/06/2026 → 23/06/2026"). */
  dateRange?: string | null;
  /** Timestamp the file was generated. Defaults to "now" at render time. */
  exportDate?: Date;
}

/* ── Date formatting ──────────────────────────────────────────────────────────
 * Centralised human-readable formatters. All exports go through these so that
 * dates never leak out as raw ISO/epoch strings. */

const pad = (n: number) => String(n).padStart(2, "0");

/** dd/MM/yyyy — for a calendar date (e.g. service date). */
export function fmtDate(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** dd/MM/yyyy HH:mm — for a datetime (e.g. delivered-at). */
export function fmtDateTime(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** yyyy-MM-dd — unambiguous date stamp for filenames. */
export function fileDateStamp(value: Date = new Date()): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Strip filesystem-unsafe characters from a label so it can go in a filename. */
export function sanitizeForFilename(label: string | null | undefined): string {
  return String(label ?? "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * Escapes a single cell for CSV output. Two layers:
 *  1. Formula-injection neutralisation — if the value's first character is a
 *     formula trigger (`= + - @`, tab, CR), prefix it with a single quote so a
 *     spreadsheet treats it as literal text rather than evaluating it.
 *  2. Standard RFC-4180 quoting for cells containing `" , \n`.
 * Exported so route handlers building CSV by hand share the same hardening.
 */
export const csvEsc = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Builds a CSV document for one table. Prepends a metadata block (title,
 * property, date-range, export date) above the column header so the file is
 * self-describing, mirroring the PDF header.
 */
export function toCsv(table: ExportTable): string {
  const exportDate = table.exportDate ?? new Date();
  const meta: string[] = [table.title];
  if (table.propertyName) meta.push(`Property: ${table.propertyName}`);
  if (table.dateRange) meta.push(`Range: ${table.dateRange}`);
  meta.push(`Exported: ${fmtDateTime(exportDate)}`);

  const lines: string[] = [];
  // One metadata cell per line keeps the header readable in a spreadsheet.
  // Every line goes through csvEsc so the title/Property/Range lines get the
  // same formula-injection + quoting treatment as the data cells.
  for (const m of meta) lines.push(csvEsc(m));
  lines.push(""); // blank separator row
  lines.push(table.headers.map(csvEsc).join(","));
  for (const r of table.rows) lines.push(r.map(csvEsc).join(","));
  // BOM so Excel reads UTF-8 correctly.
  return "﻿" + lines.join("\n");
}

/* ── PDF ──────────────────────────────────────────────────────────────────── */

/** Builds a landscape A4 PDF table; paginates rows automatically. */
export async function toPdf(table: ExportTable): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 842; // A4 landscape
  const pageH = 595;
  const margin = 36;
  const navy = rgb(0.06, 0.09, 0.16);
  const orange = rgb(0.98, 0.45, 0.09);
  const grey = rgb(0.42, 0.45, 0.5);
  const lightRow = rgb(0.96, 0.98, 0.99);

  const cols = table.headers.length;
  const usableW = pageW - margin * 2;
  const colW = usableW / cols;
  const rowH = 20;
  const fontSize = 8;

  const ELLIPSIS = "…";
  // Width measurement guarded so a font/glyph edge case can never throw the
  // request and 500 the whole export; on failure we treat the text as zero-width
  // (i.e. it "fits"), which is harmless for layout.
  const measure = (s: string) => {
    try {
      return font.widthOfTextAtSize(s, fontSize);
    } catch {
      return 0;
    }
  };
  const fit = (value: unknown) => {
    // Coerce null/undefined/number cell values to string safely before measuring.
    const text = value == null ? "" : String(value);
    const maxW = colW - 6;
    if (measure(text) <= maxW) return text;
    // Need to truncate. Account for the ellipsis glyph width in the loop
    // condition, and never slice past an empty string.
    const ellW = measure(ELLIPSIS);
    let s = text;
    while (s.length > 0 && measure(s) + ellW > maxW) s = s.slice(0, -1);
    return s + ELLIPSIS;
  };

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const exportDate = table.exportDate ?? new Date();
  // Metadata line below the title: property + date-range + export timestamp.
  const metaParts: string[] = [];
  if (table.propertyName) metaParts.push(`Property: ${table.propertyName}`);
  if (table.dateRange) metaParts.push(`Range: ${table.dateRange}`);
  metaParts.push(`Exported: ${fmtDateTime(exportDate)}`);
  const metaLine = metaParts.join("    ");

  const drawTitle = () => {
    page.drawText(table.title, { x: margin, y: y - 4, size: 14, font: bold, color: navy });
    page.drawRectangle({ x: margin, y: y - 12, width: 48, height: 3, color: orange });
    y -= 26;
    page.drawText(metaLine, { x: margin, y: y - 4, size: 8, font, color: grey });
    y -= 18;
  };
  const drawHeader = () => {
    page.drawRectangle({ x: margin, y: y - rowH + 4, width: usableW, height: rowH, color: navy });
    table.headers.forEach((h, i) => {
      page.drawText(fit(h), {
        x: margin + i * colW + 4,
        y: y - rowH + 10,
        size: fontSize,
        font: bold,
        color: rgb(1, 1, 1),
      });
    });
    y -= rowH;
  };

  drawTitle();
  drawHeader();

  table.rows.forEach((row, idx) => {
    if (y < margin + rowH) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
      drawHeader();
    }
    if (idx % 2 === 0) {
      page.drawRectangle({ x: margin, y: y - rowH + 4, width: usableW, height: rowH, color: lightRow });
    }
    row.forEach((cell, i) => {
      page.drawText(fit(cell), {
        x: margin + i * colW + 4,
        y: y - rowH + 10,
        size: fontSize,
        font,
        color: rgb(0.1, 0.12, 0.16),
      });
    });
    y -= rowH;
  });

  return doc.save();
}

/* ── XLS (SpreadsheetML 2003) ─────────────────────────────────────────────── */

/** XML-escapes a value for safe inclusion in SpreadsheetML element text. Also
 *  strips characters that are illegal in XML 1.0 (control bytes other than
 *  \t \n \r) — a single stray control byte in DB free-text would otherwise make
 *  the whole .xls workbook unopenable in Excel/LibreOffice. */
const xmlEsc = (v: unknown) =>
  (v == null ? "" : String(v))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Wraps a value as a String-typed SpreadsheetML cell. */
const xlsCell = (v: unknown) =>
  `<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;

/** Wraps a list of cell XML fragments as a SpreadsheetML row. */
const xlsRow = (cells: string[]) => `   <Row>${cells.join("")}</Row>`;

/**
 * Builds a SpreadsheetML 2003 (`.xls`) workbook as a dependency-free XML string.
 * Excel and LibreOffice open this classic format directly from a `.xls` file.
 *
 * Every cell is rendered as `ss:Type="String"`, so values are NEVER interpreted
 * as formulas — this makes the output inherently formula-injection-safe (a cell
 * like `=cmd|…` is stored and shown verbatim as text). Cell text is XML-escaped.
 *
 * Layout mirrors toCsv/toPdf: title + property/range/exported meta rows, a blank
 * spacer row, the column header row, then the data rows.
 *
 * Returns the XML as a string. The serving route should send it with
 * `Content-Type: application/vnd.ms-excel` and a `.xls` filename, e.g.
 * `Content-Disposition: attachment; filename="report-2026-06-26.xls"`.
 */
export function toXls(table: ExportTable): string {
  const exportDate = table.exportDate ?? new Date();

  const rows: string[] = [];
  rows.push(xlsRow([xlsCell(table.title)]));
  if (table.propertyName) rows.push(xlsRow([xlsCell(`Property: ${table.propertyName}`)]));
  if (table.dateRange) rows.push(xlsRow([xlsCell(`Range: ${table.dateRange}`)]));
  rows.push(xlsRow([xlsCell(`Exported: ${fmtDateTime(exportDate)}`)]));
  rows.push(xlsRow([])); // blank spacer row
  rows.push(xlsRow(table.headers.map(xlsCell)));
  for (const r of table.rows) rows.push(xlsRow(r.map(xlsCell)));

  return [
    '<?xml version="1.0"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    ' <Worksheet ss:Name="Export">',
    "  <Table>",
    ...rows,
    "  </Table>",
    " </Worksheet>",
    "</Workbook>",
  ].join("\n");
}
