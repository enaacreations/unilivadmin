import * as React from "react";
import { downloadSheet, parseSheet, type SheetFormat } from "@/lib/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  bulkValidate,
  bulkCommit,
  type BulkResource,
  type BulkRowError,
} from "@/lib/bulk-api";
import { AlertTriangle, Download, Upload, FileSpreadsheet, CheckCircle2, RefreshCw } from "lucide-react";

/** One column of the upload template. `key` is the verbatim object key the
 *  backend reads; `label` is the human header written to the template file and
 *  mapped back to `key` on parse. `hint` documents accepted values in the
 *  dialog — a column with an enum or a comma-separated list is unguessable from
 *  the header alone. */
export interface BulkColumn {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
}

interface BulkUploadDialogProps {
  /** Backend resource segment — POSTed to /bulk/<resource>. */
  resource: BulkResource;
  /** Config-driven column definitions for the template + header mapping. */
  columns: BulkColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once after a successful commit so the caller can invalidate its list. */
  onDone?: () => void;
}

type Step = "select" | "preview";

/**
 * Reusable, config-driven bulk-upload dialog.
 *
 * Flow: download a template (CSV/XLSX) → upload a filled .csv/.xlsx → the file is
 * parsed client-side into row objects keyed by the column `key`s → a dry-run
 * validates and renders a per-row status preview → Commit (enabled only when
 * invalid===0) inserts the whole batch in one transaction.
 */
export function BulkUploadDialog({
  resource,
  columns,
  open,
  onOpenChange,
  onDone,
}: BulkUploadDialogProps) {
  const { toast } = useToast();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [step, setStep] = React.useState<Step>("select");
  const [fileName, setFileName] = React.useState<string>("");
  const [rows, setRows] = React.useState<Array<Record<string, unknown>>>([]);
  const [errors, setErrors] = React.useState<BulkRowError[]>([]);
  const [counts, setCounts] = React.useState({ total: 0, valid: 0, invalid: 0 });
  // Rows that match an existing record and will update it. Undefined on the
  // insert-only resources, which is not the same as "none of them".
  const [updates, setUpdates] = React.useState<Set<number> | null>(null);
  // Whether this resource skips bad rows and imports the rest. Decided by the
  // server, not assumed here — it is the half that has to honour it.
  const [partial, setPartial] = React.useState(false);
  const [validating, setValidating] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);

  // Reset all transient state whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setStep("select");
      setFileName("");
      setRows([]);
      setErrors([]);
      setCounts({ total: 0, valid: 0, invalid: 0 });
      setUpdates(null);
      setPartial(false);
      setValidating(false);
      setCommitting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open]);

  // Map a 0-based row index to its error message (if any) for the preview table.
  const errorByIndex = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors) m.set(e.index, e.message);
    return m;
  }, [errors]);

  /** Header-only sheet built from the column labels. */
  const downloadTemplate = (format: SheetFormat) =>
    downloadSheet(`${resource}-template`, columns.map((c) => c.label), [], format);

  /** Parse the picked .csv/.xlsx into row objects keyed by column `key`. */
  const onFile = async (file: File) => {
    setFileName(file.name);
    try {
      const mapped = parseSheet(await file.arrayBuffer(), columns);

      if (mapped.length === 0) {
        toast({ title: "No data rows found in the file", variant: "destructive" });
        return;
      }

      setRows(mapped);
      await runValidate(mapped);
      setStep("preview");
    } catch (e: any) {
      toast({ title: e?.message || "Could not read file", variant: "destructive" });
    }
  };

  /** Dry-run validation pass; populates counts, per-row errors and insert/update split. */
  const runValidate = async (toValidate: Array<Record<string, unknown>>) => {
    setValidating(true);
    try {
      const res = await bulkValidate(resource, toValidate);
      setCounts({ total: res.total, valid: res.valid, invalid: res.invalid });
      setErrors(res.errors);
      setUpdates(res.updates ? new Set(res.updates) : null);
      setPartial(res.partial === true);
    } catch (e: any) {
      toast({ title: e?.message || "Validation failed", variant: "destructive" });
      setErrors([]);
      setUpdates(null);
      setPartial(false);
      setCounts({ total: toValidate.length, valid: 0, invalid: toValidate.length });
    } finally {
      setValidating(false);
    }
  };

  /**
   * Commit. On a partial resource the errors that come back are rows that were
   * SKIPPED while the rest landed; on an all-or-nothing one they mean nothing
   * was written. The written count is what tells the two apart.
   */
  const onCommit = async () => {
    setCommitting(true);
    try {
      const res = await bulkCommit(resource, rows);
      const written = res.inserted + (res.updated ?? 0);

      if (written === 0) {
        // Either an all-or-nothing rejection, or a file with no valid row in it.
        setErrors(res.errors);
        setCounts((c) => ({ ...c, valid: c.total - res.errors.length, invalid: res.errors.length }));
        toast({
          title: `Nothing imported — ${res.errors.length} row(s) had errors`,
          variant: "destructive",
        });
        return;
      }

      const parts: string[] = [];
      if (res.inserted) parts.push(`${res.inserted} added`);
      if (res.updated) parts.push(`${res.updated} updated`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      toast({
        title: `Imported ${written} ${resource}`,
        ...(parts.length > 1 ? { description: `${parts.join(", ")}.` } : {}),
      });
      onDone?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Import failed", variant: "destructive" });
    } finally {
      setCommitting(false);
    }
  };

  const invalid = counts.invalid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Bulk upload {resource}</DialogTitle>
          <DialogDescription>
            Download the template, fill it in, then upload a .csv or .xlsx file. Rows
            are validated before anything is saved.
          </DialogDescription>
        </DialogHeader>

        {step === "select" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => downloadTemplate("csv")}
                data-testid="button-bulk-template-csv"
              >
                <Download className="w-4 h-4 mr-2" /> Template (CSV)
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadTemplate("xlsx")}
                data-testid="button-bulk-template-xlsx"
              >
                <Download className="w-4 h-4 mr-2" /> Template (XLSX)
              </Button>
            </div>

            <div className="rounded-lg border border-dashed p-8 text-center">
              <FileSpreadsheet className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                Upload a filled-in .csv or .xlsx file
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
                data-testid="input-bulk-file"
              />
              <Button
                className="mt-4"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-bulk-choose-file"
              >
                <Upload className="w-4 h-4 mr-2" /> Choose file
              </Button>
            </div>

            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Required columns:</span>{" "}
              {columns.filter((c) => c.required).map((c) => c.label).join(", ") || "—"}
            </div>

            {columns.some((c) => c.hint) && (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                {columns.filter((c) => c.hint).map((c) => (
                  <li key={c.key}>
                    <span className="font-mono text-foreground">{c.label}</span> — {c.hint}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 truncate text-muted-foreground" title={fileName}>
                <FileSpreadsheet className="inline w-4 h-4 mr-1" />
                {fileName}
              </span>
              <Badge variant="outline">Total {counts.total}</Badge>
              {updates ? (
                <>
                  <Badge variant="success">New {counts.valid - updates.size}</Badge>
                  <Badge variant="outline">Updates {updates.size}</Badge>
                </>
              ) : (
                <Badge variant="success">Valid {counts.valid}</Badge>
              )}
              <Badge variant={invalid > 0 ? "destructive" : "outline"}>
                Invalid {invalid}
              </Badge>
              {validating && (
                <span className="text-xs text-muted-foreground">Validating…</span>
              )}
            </div>

            {/* Say plainly what happens to the bad rows before the user commits —
                the counts above show how many, not what becomes of them. */}
            {invalid > 0 && !validating && (
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-xs leading-relaxed text-warning">
                  {partial ? (
                    <>
                      <span className="font-medium">
                        The {invalid} row{invalid === 1 ? "" : "s"} marked below will not be imported.
                      </span>{" "}
                      The other {counts.valid} will be. Fix the skipped rows in your file and upload
                      it again — rows that already exist are updated, not duplicated.
                    </>
                  ) : (
                    <>
                      <span className="font-medium">
                        {invalid} row{invalid === 1 ? "" : "s"} below have errors.
                      </span>{" "}
                      Nothing is imported until every row is clean — fix them in your file and upload
                      it again.
                    </>
                  )}
                </p>
              </div>
            )}

            {/* min-w-0 is load-bearing: DialogContent is a grid, and a grid item
                defaults to min-width:auto — it refuses to shrink below its
                content's min-content width. Without it this box grows to fit the
                widest row and drags the whole dialog past its max-width instead
                of scrolling, however wide the dialog is made. */}
            <div className="min-w-0 max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    {/* Wide enough for a wrapped error message — it is the one
                        cell the reader actually has to read in full. */}
                    <TableHead className="w-56">Status</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c.key}>{c.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => {
                    const err = errorByIndex.get(i);
                    return (
                      <TableRow
                        key={i}
                        // Dimmed so the rows that won't land are scannable at a glance.
                        className={err ? "opacity-60" : undefined}
                        data-testid={`bulk-row-${i}`}
                      >
                        <TableCell className="align-top text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="align-top">
                          {err ? (
                            // Badge is whitespace-nowrap by default; let the
                            // message wrap inside the column rather than widen it.
                            <Badge
                              variant="destructive"
                              className="whitespace-normal text-left leading-snug"
                              title={err}
                            >
                              {err}
                            </Badge>
                          ) : updates?.has(i) ? (
                            <Badge variant="outline" title="Matches an existing record — it will be updated">
                              <RefreshCw className="w-3 h-3 mr-1" /> Update
                            </Badge>
                          ) : (
                            <Badge variant="success">
                              <CheckCircle2 className="w-3 h-3 mr-1" /> New
                            </Badge>
                          )}
                        </TableCell>
                        {columns.map((c) => {
                          const raw = r[c.key];
                          const text = raw === "" || raw == null ? "—" : String(raw);
                          return (
                            <TableCell key={c.key} className="align-top">
                              {/* max-width lives on an inner block, not the cell:
                                  a <td> in an auto-layout table sizes to content
                                  and ignores its own max-width. The full value is
                                  on the title for hover. */}
                              <div className="max-w-[180px] truncate" title={text}>
                                {text}
                              </div>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "preview" && (
            <Button
              variant="ghost"
              onClick={() => setStep("select")}
              disabled={committing}
              data-testid="button-bulk-back"
            >
              Back
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={committing}>
            Cancel
          </Button>
          {step === "preview" && (
            <Button
              onClick={onCommit}
              disabled={
                validating || committing || counts.total === 0 ||
                // Partial resources import what's valid; the rest need a clean file.
                (partial ? counts.valid === 0 : invalid > 0)
              }
              data-testid="button-bulk-commit"
            >
              {committing
                ? "Importing…"
                : partial && invalid > 0
                  ? `Import ${counts.valid} of ${counts.total} rows`
                  : `Import ${counts.valid} ${resource}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
