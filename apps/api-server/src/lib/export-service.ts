/**
 * Tabular export helpers — produce CSV, PDF (via pdf-lib, already a
 * dependency) and XLS (dependency-free SpreadsheetML 2003 XML). Used by report
 * and guest-list exports (Persona st.34, st.47).
 *
 * Every export carries a human-readable document header showing the property
 * name and the export date.
 *
 * WS4 (security): every cell — CSV and XLS alike — is neutralised against
 * spreadsheet formula injection. TEXT cells beginning with a formula trigger
 * (`= + - @`, tab, CR) are prefixed with a single quote in CSV and are always
 * String-typed in XLS, so a value is never evaluated as a formula.
 *
 * Numbers are the documented exception, and deliberately so: a finite JS number
 * cannot carry a formula, so exempting it costs nothing in safety and fixes a
 * real reporting defect. String-typing every cell landed quantities in Excel as
 * left-aligned TEXT that could not be summed, sorted numerically or charted —
 * and in CSV the `-` trigger turned a negative variance into the literal
 * `'-2.5`. Number-typed cells are emitted verbatim; everything else is escaped
 * exactly as before.
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
 *
 * A finite NUMBER skips both layers. It cannot be a formula, so the guard buys
 * nothing — while applying it wrote a negative quantity out as `'-2.5`, text
 * that no spreadsheet will add up. Numeric cells therefore stay numeric.
 */
export const csvEsc = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
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
    // winAnsi FIRST, not just a String() coerce: pdf-lib's standard fonts are
    // WinAnsi-encoded and drawText THROWS on any glyph outside that set, which
    // makes one out-of-range character in free text a 500 for the whole export.
    // This was live — every report PDF 500'd because the date-range label joins
    // its two dates with U+2192 (→).
    const text = winAnsi(value);
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
    // Both of these are free text reaching drawText directly rather than through
    // fit(), so both need the same WinAnsi treatment — metaLine is the one that
    // was actually 500ing.
    page.drawText(winAnsi(table.title), { x: margin, y: y - 4, size: 14, font: bold, color: navy });
    page.drawRectangle({ x: margin, y: y - 12, width: 48, height: 3, color: orange });
    y -= 26;
    page.drawText(winAnsi(metaLine), { x: margin, y: y - 4, size: 8, font, color: grey });
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

  // Layout is a per-CELL loop, so a long report is a long stretch of synchronous
  // work on the event loop and every other request waits behind it (H11). The
  // callers cap the row count, and this yields between pages so even a capped
  // report never monopolises the loop for the whole render. Yielding is safe:
  // nothing else touches `doc`, `page` or `y`, and the caller already awaits.
  let idx = 0;
  for (const row of table.rows) {
    if (y < margin + rowH) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
      drawHeader();
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    idx++;
  }

  return doc.save();
}

/* ── Menu rotation calendar PDF ───────────────────────────────────────────── */

/**
 * A rotation row as the export query selects it. Deliberately the raw shape
 * rather than the display strings `toPdf` takes: the calendar needs the numeric
 * day and week to place a cell, which a formatted "Monday"/"W1" string has
 * already thrown away.
 */
export interface RotationExportRow {
  kitchenName: string | null;
  brand: string | null;
  rotationWeek: number;
  /** ISO day of week, 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  mealType: string;
  dishName: string | null;
  slotLabel: string | null;
  sortOrder: number | null;
}

/**
 * Canonical meal order. A rotation is read top-to-bottom as the day progresses,
 * so meals must render in service order and never alphabetically. Anything not
 * listed (a meal added to the enum later) sorts after these, alphabetically, so
 * an unknown value still renders rather than vanishing.
 */
const MEAL_ORDER = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];
const MEAL_LABEL: Record<string, string> = {
  BREAKFAST: "Breakfast",
  LUNCH: "Lunch",
  SNACKS: "Snacks",
  DINNER: "Dinner",
};
const DAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and `drawText` THROWS on a glyph
 * outside that set, so a single out-of-range character anywhere in a document
 * 500s the entire export. Map the punctuation that actually occurs to ASCII and
 * drop anything else still outside the encodable range.
 *
 * EVERY string reaching drawText must go through this — in both `toPdf` and
 * `toMenuRotationPdf`. It is not only about free text like dish names: the
 * report exports 500'd on their own generated header, because the date-range
 * label joins its two dates with U+2192.
 */
function winAnsi(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    // Arrows are MAPPED, not stripped: the export date-range label is
    // "<from> → <to>", and dropping the glyph would leave two dates separated
    // by whitespace with nothing saying it is a range.
    .replace(/[→⟶➔➜]/g, "->")
    .replace(/[←⟵]/g, "<-")
    .replace(/[×✕✖]/g, "x")
    .replace(/[•]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

/**
 * Renders the menu rotation as a week-per-page calendar: days across, meals
 * down, dishes listed in plate order inside each cell.
 *
 * Why not `toPdf`: the rotation is a two-dimensional schedule, and flattening it
 * into one row per dish produced a document where a single 4-week cycle was ~450
 * near-identical lines repeating the kitchen, brand, week and day on every one.
 * Nobody could see "what do we cook on Tuesday" without reading the whole file.
 * The grid answers that at a glance, and costs one page per rotation week.
 *
 * One page-set per (kitchen, brand, week) group, because an unfiltered export
 * legitimately spans several kitchens and a calendar that silently merged them
 * would show two different Tuesdays in one column.
 */
export async function toMenuRotationPdf(
  rows: RotationExportRow[],
  opts: { exportDate?: Date } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 842; // A4 landscape
  const PAGE_H = 595;
  const M = 30;

  const navy = rgb(0.06, 0.09, 0.16);
  const orange = rgb(0.98, 0.45, 0.09);
  const ink = rgb(0.11, 0.13, 0.18);
  const muted = rgb(0.45, 0.48, 0.54);
  const faint = rgb(0.66, 0.69, 0.74);
  const hair = rgb(0.87, 0.89, 0.92);
  const headBg = rgb(0.96, 0.97, 0.985);
  const weekendBg = rgb(0.976, 0.973, 0.962);
  const white = rgb(1, 1, 1);

  /** A quiet accent per meal — enough to find "Lunch" without reading, not enough to shout. */
  const MEAL_ACCENT: Record<string, ReturnType<typeof rgb>> = {
    BREAKFAST: rgb(0.95, 0.62, 0.11),
    LUNCH: rgb(0.13, 0.66, 0.41),
    SNACKS: rgb(0.55, 0.36, 0.86),
    DINNER: rgb(0.24, 0.35, 0.76),
  };

  const LABEL_W = 62;
  const GRID_W = PAGE_W - M * 2;
  const DAY_W = (GRID_W - LABEL_W) / 7;
  const DAY_HEAD_H = 24;
  /** Title block above the grid, and the footer rule below it. Fixed, so the
   *  grid can be sized to fill exactly the space between them. */
  const HEADER_H = 56;
  const FOOTER_H = 22;
  const DISH_SIZE = 7;
  const DISH_LH = 9.6;
  const CELL_PAD_Y = 7;
  const MIN_ROW_H = 34;

  const measure = (s: string, f: typeof font, size: number) => {
    try {
      return f.widthOfTextAtSize(s, size);
    } catch {
      return 0;
    }
  };

  /** Truncate to one line — dish names are short and a wrapped list loses its scannability. */
  const clip = (text: string, maxW: number, f: typeof font, size: number) => {
    if (measure(text, f, size) <= maxW) return text;
    const ell = measure("...", f, size);
    let s = text;
    while (s.length > 0 && measure(s, f, size) + ell > maxW) s = s.slice(0, -1);
    return s.trimEnd() + "...";
  };

  // ── Group into (kitchen, brand, week) pages ───────────────────────────────
  type Group = {
    kitchenName: string | null;
    brand: string | null;
    week: number;
    /** meal → ISO day → dish names in plate order */
    cells: Map<string, Map<number, string[]>>;
  };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.kitchenName ?? ""}||${r.brand ?? ""}||${r.rotationWeek}`;
    let g = groups.get(key);
    if (!g) {
      g = { kitchenName: r.kitchenName, brand: r.brand, week: r.rotationWeek, cells: new Map() };
      groups.set(key, g);
    }
    let byDay = g.cells.get(r.mealType);
    if (!byDay) {
      byDay = new Map();
      g.cells.set(r.mealType, byDay);
    }
    const list = byDay.get(r.dayOfWeek) ?? [];
    list.push(winAnsi(r.dishName ?? "—"));
    byDay.set(r.dayOfWeek, list);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      (a.kitchenName ?? "").localeCompare(b.kitchenName ?? "") ||
      (a.brand ?? "").localeCompare(b.brand ?? "") ||
      a.week - b.week,
  );
  const weekCount = new Set(ordered.map((g) => g.week)).size;
  const exportDate = opts.exportDate ?? new Date();

  // ── Empty state ───────────────────────────────────────────────────────────
  // A zero-byte-looking PDF reads as a broken export; say plainly that the
  // filters matched nothing.
  if (ordered.length === 0) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText("Menu Rotation", { x: M, y: PAGE_H - M - 16, size: 17, font: bold, color: navy });
    page.drawRectangle({ x: M, y: PAGE_H - M - 26, width: 46, height: 2.5, color: orange });
    page.drawText("No rotation matches these filters.", {
      x: M, y: PAGE_H - M - 54, size: 10, font, color: muted,
    });
    return doc.save();
  }

  const footers: { page: ReturnType<typeof doc.addPage>; label: string }[] = [];

  for (const g of ordered) {
    const meals = [...g.cells.keys()].sort((a, b) => {
      const ia = MEAL_ORDER.indexOf(a);
      const ib = MEAL_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    // Row height follows the busiest day in that meal, so Lunch gets the space
    // it needs and Snacks does not waste a third of the page.
    const contentHeights = meals.map((meal) => {
      const byDay = g.cells.get(meal)!;
      let max = 0;
      for (let d = 1; d <= 7; d++) max = Math.max(max, (byDay.get(d) ?? []).length);
      return Math.max(MIN_ROW_H, max * DISH_LH + CELL_PAD_Y * 2);
    });
    // Then grow the rows proportionally to fill the page. Sizing purely to
    // content left the grid floating in the top two-thirds with a band of dead
    // space under it, which reads as a truncated document rather than a
    // deliberate one. Proportional (not equal) growth keeps Lunch visibly the
    // heaviest meal, which is information.
    const contentTotal = contentHeights.reduce((a, b) => a + b, 0);
    const available = PAGE_H - M - HEADER_H - DAY_HEAD_H - (M + FOOTER_H);
    // Capped: a rotation with only two sparse meals would otherwise stretch into
    // two near-empty bands half a page tall, which looks like a rendering fault
    // rather than a short menu. Past the cap the grid simply ends early.
    const GROW_CAP = 2.2;
    const scale =
      contentTotal > 0 ? Math.min(GROW_CAP, Math.max(1, available / contentTotal)) : 1;
    const rowHeights = contentHeights.map((h) => h * scale);

    const page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - M;

    // ── Document header ─────────────────────────────────────────────────────
    page.drawText("Menu Rotation", { x: M, y: y - 15, size: 17, font: bold, color: navy });
    page.drawRectangle({ x: M, y: y - 25, width: 46, height: 2.5, color: orange });

    const subtitle = [g.kitchenName || "All kitchens", g.brand || null]
      .filter(Boolean)
      .map((s) => winAnsi(s))
      .join("  ·  ");
    page.drawText(subtitle, { x: M, y: y - 40, size: 9.5, font, color: muted });

    // Week badge, right-aligned — the one thing a reader checks before anything else.
    const weekText = `WEEK ${g.week}`;
    const badgeW = measure(weekText, bold, 9) + 22;
    page.drawRectangle({
      x: PAGE_W - M - badgeW, y: y - 26, width: badgeW, height: 19,
      color: navy, borderColor: navy, borderWidth: 0,
    });
    page.drawText(weekText, {
      x: PAGE_W - M - badgeW + 11, y: y - 20.5, size: 9, font: bold, color: white,
    });
    if (weekCount > 1) {
      const cyc = `${weekCount}-week cycle`;
      page.drawText(cyc, {
        x: PAGE_W - M - measure(cyc, font, 8), y: y - 40, size: 8, font, color: faint,
      });
    }

    y -= 56;

    // ── Day header ──────────────────────────────────────────────────────────
    page.drawRectangle({ x: M, y: y - DAY_HEAD_H, width: GRID_W, height: DAY_HEAD_H, color: headBg });
    for (let d = 1; d <= 7; d++) {
      const cx = M + LABEL_W + (d - 1) * DAY_W;
      const label = DAY_SHORT[d]!;
      const w = measure(label, bold, 8.5);
      page.drawText(label, {
        x: cx + (DAY_W - w) / 2, y: y - DAY_HEAD_H + 7.5,
        size: 8.5, font: bold, color: d >= 6 ? muted : navy,
      });
    }
    page.drawLine({
      start: { x: M, y: y - DAY_HEAD_H }, end: { x: M + GRID_W, y: y - DAY_HEAD_H },
      thickness: 1, color: navy,
    });
    const gridTop = y - DAY_HEAD_H;
    y = gridTop;

    // ── Meal rows ───────────────────────────────────────────────────────────
    meals.forEach((meal, mi) => {
      const h = rowHeights[mi]!;
      const top = y;
      const bottom = y - h;

      // Weekend tint runs the full row so the column reads as one block.
      for (let d = 6; d <= 7; d++) {
        page.drawRectangle({
          x: M + LABEL_W + (d - 1) * DAY_W, y: bottom, width: DAY_W, height: h, color: weekendBg,
        });
      }

      // Meal label cell: accent bar + name, so the row is identifiable by colour
      // alone once the reader knows the key.
      const accent = MEAL_ACCENT[meal] ?? muted;
      page.drawRectangle({ x: M, y: bottom, width: 3, height: h, color: accent });
      page.drawText(winAnsi(MEAL_LABEL[meal] ?? meal), {
        x: M + 9, y: top - CELL_PAD_Y - 6, size: 8.5, font: bold, color: navy,
      });
      const byDay = g.cells.get(meal)!;
      // Per-day, not the weekly total: "70 items" against a Lunch row reads as
      // the size of one plate, which is the number a reader is actually looking
      // for. Show a range when the days differ.
      const perDay: number[] = [];
      for (let d = 1; d <= 7; d++) perDay.push((byDay.get(d) ?? []).length);
      const lo = Math.min(...perDay);
      const hi = Math.max(...perDay);
      page.drawText(lo === hi ? `${hi} per day` : `${lo}-${hi} per day`, {
        x: M + 9, y: top - CELL_PAD_Y - 17, size: 6.5, font, color: faint,
      });

      // Dishes
      for (let d = 1; d <= 7; d++) {
        const dishes = byDay.get(d) ?? [];
        const cx = M + LABEL_W + (d - 1) * DAY_W;
        if (dishes.length === 0) {
          page.drawText("—", { x: cx + 6, y: top - CELL_PAD_Y - 6, size: DISH_SIZE, font, color: faint });
          continue;
        }
        dishes.forEach((dish, i) => {
          page.drawText(clip(dish, DAY_W - 12, font, DISH_SIZE), {
            x: cx + 6, y: top - CELL_PAD_Y - 6 - i * DISH_LH,
            size: DISH_SIZE, font, color: ink,
          });
        });
      }

      // Row separator (not after the last row — the grid border closes it).
      if (mi < meals.length - 1) {
        page.drawLine({
          start: { x: M, y: bottom }, end: { x: M + GRID_W, y: bottom }, thickness: 0.5, color: hair,
        });
      }
      y = bottom;
    });

    // ── Grid rules ──────────────────────────────────────────────────────────
    const gridBottom = y;
    for (let d = 0; d <= 7; d++) {
      const x = M + LABEL_W + d * DAY_W;
      page.drawLine({
        start: { x, y: gridTop }, end: { x, y: gridBottom },
        thickness: d === 0 ? 1 : 0.5, color: d === 0 ? navy : hair,
      });
    }
    page.drawLine({
      start: { x: M, y: gridBottom }, end: { x: M + GRID_W, y: gridBottom },
      thickness: 0.5, color: hair,
    });

    footers.push({
      page,
      label: [winAnsi(g.kitchenName || "All kitchens"), winAnsi(g.brand || ""), `Week ${g.week}`]
        .filter(Boolean)
        .join("  ·  "),
    });

    // The layout above is a per-cell loop on the event loop; yield between pages
    // so a many-kitchen export never monopolises it (H11).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // ── Footers (page N of M needs the total, so this runs last) ──────────────
  footers.forEach((f, i) => {
    f.page.drawLine({
      start: { x: M, y: M + 14 }, end: { x: PAGE_W - M, y: M + 14 }, thickness: 0.5, color: hair,
    });
    f.page.drawText(f.label, { x: M, y: M + 4, size: 7, font, color: faint });
    const right = `Exported ${fmtDateTime(exportDate)}   ·   Page ${i + 1} of ${footers.length}`;
    f.page.drawText(right, {
      x: PAGE_W - M - measure(right, font, 7), y: M + 4, size: 7, font, color: faint,
    });
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

/** Wraps a value as a SpreadsheetML cell.
 *
 *  Finite numbers are emitted as `ss:Type="Number"`; everything else stays
 *  String-typed and XML-escaped. String-typing the numbers too was the safer-
 *  looking choice and the wrong one: Excel showed a wasted quantity of 0.3 as
 *  left-aligned text, so the client could not sum a column, sort it by size or
 *  chart it — the exported report looked like it had lost the decimals it had
 *  in fact carried. A number literal has no formula surface, so the injection
 *  guarantee is unchanged. */
const xlsCell = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
    : `<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;

/** Wraps a list of cell XML fragments as a SpreadsheetML row. */
const xlsRow = (cells: string[]) => `   <Row>${cells.join("")}</Row>`;

/**
 * Builds a SpreadsheetML 2003 (`.xls`) workbook as a dependency-free XML string.
 * Excel and LibreOffice open this classic format directly from a `.xls` file.
 *
 * Text cells are rendered as `ss:Type="String"`, so they are NEVER interpreted
 * as formulas — a cell like `=cmd|…` is stored and shown verbatim as text — and
 * their content is XML-escaped. Finite numbers are rendered as `ss:Type="Number"`
 * so quantities arrive in Excel as numbers you can sum, sort and chart; see
 * `xlsCell` for why that does not weaken the injection guarantee.
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
