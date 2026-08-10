/**
 * One "Import / export" control for a bulk-uploadable resource.
 *
 * Folds the template downloads, the upload dialog and the export into a single
 * trigger — the Service Set headers already carry a search box and a primary
 * action, and a third and fourth button did not fit.
 *
 * The export writes the SAME columns as the template, so a file exported here
 * can be edited and uploaded back through the same dialog. That round trip is
 * the reason `columns` drives both.
 */
import * as React from "react";
import { ChevronDown, Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BulkUploadDialog, type BulkColumn } from "@/components/bulk-upload-dialog";
import { downloadSheet, todayStamp, type SheetFormat } from "@/lib/sheet";
import type { BulkResource } from "@/lib/bulk-api";

interface ImportExportMenuProps {
  /** Backend resource segment — POSTed to /bulk/<resource>. */
  resource: BulkResource;
  /** Template + export columns. `key` is the row key, `label` the sheet header. */
  columns: BulkColumn[];
  /**
   * The current rows, keyed by the same column `key`s the importer reads. List
   * cells (ingredients, brands) must already be comma-joined strings.
   */
  exportRows: Array<Record<string, unknown>>;
  /** Called after a successful import so the caller can invalidate its list. */
  onImported?: () => void;
  /**
   * Extra menu items appended in their own group — for a resource that also
   * offers something this component knows nothing about, e.g. the Menu tab's
   * printable week report.
   */
  children?: React.ReactNode;
}

export function ImportExportMenu({
  resource, columns, exportRows, onImported, children,
}: ImportExportMenuProps) {
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const headers = columns.map((c) => c.label);

  const downloadTemplate = (format: SheetFormat) =>
    downloadSheet(`${resource}-template`, headers, [], format);

  const exportAll = (format: SheetFormat) =>
    downloadSheet(
      `${resource}-${todayStamp()}`,
      headers,
      // Re-key from column `key` to the sheet header the parser maps back.
      exportRows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const c of columns) out[c.label] = row[c.key] ?? "";
        return out;
      }),
      format,
    );

  const n = exportRows.length;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-1.5">
            <FileSpreadsheet className="h-4 w-4" /> Import / export
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Import
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => downloadTemplate("csv")}>
            <Download className="mr-2 h-4 w-4" /> Download template (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => downloadTemplate("xlsx")}>
            <Download className="mr-2 h-4 w-4" /> Download template (XLSX)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Upload a filled file
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Export
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={n === 0} onClick={() => exportAll("csv")}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Export {n} row{n === 1 ? "" : "s"} (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem disabled={n === 0} onClick={() => exportAll("xlsx")}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Export {n} row{n === 1 ? "" : "s"} (XLSX)
          </DropdownMenuItem>
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            An export uploads back through this same menu — edit it and re-upload
            to update these rows.
          </p>

          {children ? (
            <>
              <DropdownMenuSeparator />
              {children}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <BulkUploadDialog
        resource={resource}
        columns={columns}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onDone={onImported}
      />
    </>
  );
}
