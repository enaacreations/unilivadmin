/**
 * Client-side .csv/.xlsx writing, shared by the bulk-upload template and the
 * matching export.
 *
 * Both go through one function on purpose: an export is only useful if the
 * importer can read it straight back, and that holds exactly as long as the two
 * files carry the same header row.
 */
import * as XLSX from "xlsx";

export type SheetFormat = "csv" | "xlsx";

/**
 * Build a one-sheet workbook of `rows` under `headers`.
 *
 * Row objects are keyed by header, and any key not in `headers` is dropped —
 * so the column order is the caller's, not the first row's. Empty `rows` still
 * produces the header row, which is what makes a template a template.
 */
export function buildSheet(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): XLSX.WorkBook {
  // Project onto `headers` first: json_to_sheet's own `header` option only sets
  // the order of the keys it finds, and APPENDS any others after them — which
  // would put columns in an export that the template has no header for.
  const project = (r: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const h of headers) out[h] = r[h] ?? "";
    return out;
  };
  const data = rows.length ? rows.map(project) : [project({})];
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return wb;
}

/** Build the sheet and trigger the browser download. */
export function downloadSheet(
  filename: string,
  headers: string[],
  rows: Array<Record<string, unknown>>,
  format: SheetFormat,
): void {
  XLSX.writeFile(buildSheet(headers, rows), `${filename}.${format}`, {
    bookType: format === "csv" ? "csv" : "xlsx",
  });
}

/**
 * Read an uploaded .csv/.xlsx back into row objects keyed by column `key`.
 *
 * The inverse of buildSheet: each header is matched to the column whose `label`
 * it equals, and unrecognised headers are ignored — so a file carrying extra
 * columns still imports. Fully-empty rows are dropped, which is what lets a
 * template's blank example row survive being uploaded untouched.
 */
export function parseSheet(
  buf: ArrayBuffer,
  columns: Array<{ key: string; label: string }>,
): Array<Record<string, unknown>> {
  const wb = XLSX.read(buf);
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return [];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

  const labelToKey = new Map(columns.map((c) => [c.label, c.key]));
  const out: Array<Record<string, unknown>> = [];
  for (const r of raw) {
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    for (const [header, value] of Object.entries(r)) {
      const key = labelToKey.get(header);
      if (!key) continue;
      obj[key] = value;
      if (value !== "" && value != null) hasValue = true;
    }
    if (hasValue) out.push(obj);
  }
  return out;
}

/** `2026-08-10` — stamped into export filenames so downloads don't collide. */
export const todayStamp = (): string => new Date().toISOString().slice(0, 10);
