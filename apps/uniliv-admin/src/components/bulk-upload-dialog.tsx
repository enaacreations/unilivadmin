import * as React from "react";
import * as XLSX from "xlsx";
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
import { Download, Upload, FileSpreadsheet, CheckCircle2 } from "lucide-react";

/** One column of the upload template. `key` is the verbatim object key the
 *  backend reads; `label` is the human header written to the template file and
 *  mapped back to `key` on parse. */
export interface BulkColumn {
  key: string;
  label: string;
  required?: boolean;
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

  /** Build a single-row (header-only) sheet from the column labels and download it. */
  const downloadTemplate = (format: "csv" | "xlsx") => {
    // json_to_sheet over a single object whose keys are the labels yields a sheet
    // with exactly the header row populated (and one empty example row).
    const headerObj: Record<string, string> = {};
    for (const c of columns) headerObj[c.label] = "";
    const sheet = XLSX.utils.json_to_sheet([headerObj], {
      header: columns.map((c) => c.label),
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Template");
    XLSX.writeFile(wb, `${resource}-template.${format}`, {
      bookType: format === "csv" ? "csv" : "xlsx",
    });
  };

  /** Parse the picked .csv/.xlsx into row objects keyed by column `key`. */
  const onFile = async (file: File) => {
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      // Map each header (which equals a column `label`) back to that column's
      // `key`. Headers we don't recognise are ignored. Drop fully-empty rows.
      const labelToKey = new Map(columns.map((c) => [c.label, c.key]));
      const mapped: Array<Record<string, unknown>> = [];
      for (const r of raw) {
        const obj: Record<string, unknown> = {};
        let hasValue = false;
        for (const [header, value] of Object.entries(r)) {
          const key = labelToKey.get(header);
          if (!key) continue;
          obj[key] = value;
          if (value !== "" && value != null) hasValue = true;
        }
        if (hasValue) mapped.push(obj);
      }

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

  /** Dry-run validation pass; populates counts + per-row errors. */
  const runValidate = async (toValidate: Array<Record<string, unknown>>) => {
    setValidating(true);
    try {
      const res = await bulkValidate(resource, toValidate);
      setCounts({ total: res.total, valid: res.valid, invalid: res.invalid });
      setErrors(res.errors);
    } catch (e: any) {
      toast({ title: e?.message || "Validation failed", variant: "destructive" });
      setErrors([]);
      setCounts({ total: toValidate.length, valid: 0, invalid: toValidate.length });
    } finally {
      setValidating(false);
    }
  };

  /** Commit the whole batch (all-or-nothing). */
  const onCommit = async () => {
    setCommitting(true);
    try {
      const res = await bulkCommit(resource, rows);
      if (res.errors.length > 0) {
        // 422: nothing inserted. Surface the row-level errors in the table.
        setErrors(res.errors);
        setCounts((c) => ({ ...c, valid: c.total - res.errors.length, invalid: res.errors.length }));
        toast({
          title: `Import rejected — ${res.errors.length} row(s) had errors`,
          variant: "destructive",
        });
        return;
      }
      toast({ title: `Imported ${res.inserted} ${resource}` });
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
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                <FileSpreadsheet className="inline w-4 h-4 mr-1" />
                {fileName}
              </span>
              <Badge variant="outline">Total {counts.total}</Badge>
              <Badge variant="success">Valid {counts.valid}</Badge>
              <Badge variant={invalid > 0 ? "destructive" : "outline"}>
                Invalid {invalid}
              </Badge>
              {validating && (
                <span className="text-xs text-muted-foreground">Validating…</span>
              )}
            </div>

            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c.key}>{c.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => {
                    const err = errorByIndex.get(i);
                    return (
                      <TableRow key={i} data-testid={`bulk-row-${i}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell>
                          {err ? (
                            <Badge variant="destructive" title={err}>
                              {err}
                            </Badge>
                          ) : (
                            <Badge variant="success">
                              <CheckCircle2 className="w-3 h-3 mr-1" /> OK
                            </Badge>
                          )}
                        </TableCell>
                        {columns.map((c) => (
                          <TableCell key={c.key} className="whitespace-nowrap">
                            {r[c.key] === "" || r[c.key] == null
                              ? "—"
                              : String(r[c.key])}
                          </TableCell>
                        ))}
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
              disabled={validating || committing || invalid > 0 || counts.total === 0}
              data-testid="button-bulk-commit"
            >
              {committing ? "Importing…" : `Import ${counts.valid} ${resource}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
