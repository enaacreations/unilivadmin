/**
 * Tabular export helpers — produce real .xls (SpreadsheetML 2003, opens in
 * Excel/Sheets, no third-party dependency) and PDF (via pdf-lib, already a
 * dependency). Used by report and guest-list exports (Persona st.34, st.47).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ExportTable {
  title: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

const xmlEsc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const isNum = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && !isNaN(Number(v));

/** Builds a SpreadsheetML 2003 (.xls) document for one table. */
export function toXls(table: ExportTable): string {
  const cell = (v: unknown) =>
    isNum(v)
      ? `<Cell><Data ss:Type="Number">${xmlEsc(v)}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;

  const headerRow = `<Row>${table.headers
    .map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`)
    .join("")}</Row>`;
  const bodyRows = table.rows.map((r) => `<Row>${r.map(cell).join("")}</Row>`).join("");

  const sheetName = table.title.replace(/[\\/?*[\]:]/g, "").slice(0, 31) || "Sheet1";

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#0F172A" ss:Pattern="Solid"/><Font ss:Color="#FFFFFF" ss:Bold="1"/></Style>
 </Styles>
 <Worksheet ss:Name="${xmlEsc(sheetName)}">
  <Table>
   ${headerRow}
   ${bodyRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

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
  const lightRow = rgb(0.96, 0.98, 0.99);

  const cols = table.headers.length;
  const usableW = pageW - margin * 2;
  const colW = usableW / cols;
  const rowH = 20;
  const fontSize = 8;

  const fit = (text: string, width: number) => {
    let s = String(text ?? "");
    while (s.length > 0 && font.widthOfTextAtSize(s, fontSize) > width - 6) s = s.slice(0, -1);
    return s.length < String(text ?? "").length ? s.slice(0, -1) + "…" : s;
  };

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const drawTitle = () => {
    page.drawText(table.title, { x: margin, y: y - 4, size: 14, font: bold, color: navy });
    page.drawRectangle({ x: margin, y: y - 12, width: 48, height: 3, color: orange });
    y -= 34;
  };
  const drawHeader = () => {
    page.drawRectangle({ x: margin, y: y - rowH + 4, width: usableW, height: rowH, color: navy });
    table.headers.forEach((h, i) => {
      page.drawText(fit(h, colW), {
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
      page.drawText(fit(cell == null ? "" : String(cell), colW), {
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
