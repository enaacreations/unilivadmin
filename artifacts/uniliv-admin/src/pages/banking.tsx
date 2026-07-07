import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Upload, Check, X, Eye } from "lucide-react";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetResidents, getGetResidentsQueryKey } from "@workspace/api-client-react";
import type { BankImportDto, BankStatementLineDto, ResidentDto } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

type BankImportForm = { fileName: string; accountLabel: string; csv: string };
type BankLineWithSuggestion = BankStatementLineDto & { suggestionPayload?: { confidence?: string } | null; residentName?: string | null };

export default function BankingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: importsRes, isLoading } = useQuery<{ success: boolean; data: BankImportDto[] }>({ queryKey: ["bank-imports"], queryFn: () => apiFetch("/bank-imports") });
  const imports = importsRes?.data || [];

  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [form, setForm] = React.useState<BankImportForm>({ fileName: "", accountLabel: "", csv: "" });
  const [selectedImport, setSelectedImport] = React.useState<string | null>(null);

  const uploadMut = useMutation({
    mutationFn: (d: BankImportForm) => apiFetch("/bank-imports", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Statement imported" }); qc.invalidateQueries({ queryKey: ["bank-imports"] }); setUploadOpen(false); setForm({ fileName: "", accountLabel: "", csv: "" }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setForm(f => ({ ...f, fileName: file.name, csv: String(reader.result || "") }));
    reader.readAsText(file);
  };

  const columns = [
    { accessorKey: "createdAt", header: "Imported", cell: ({row}:any) => format(new Date(row.original.createdAt), "dd MMM yyyy HH:mm") },
    { accessorKey: "fileName", header: "File", cell: ({row}:any) => <span className="font-medium">{row.original.fileName}</span> },
    { accessorKey: "accountLabel", header: "Account", cell: ({row}:any) => row.original.accountLabel || "—" },
    { accessorKey: "matchedLines", header: "Matched", cell: ({row}:any) => <span className="font-mono">{row.original.matchedLines}/{row.original.totalLines}</span> },
    { id: "actions", header: "", cell: ({row}:any) => (
      <Button size="sm" variant="outline" onClick={() => setSelectedImport(row.original.id)} data-testid={`button-view-import-${row.original.id}`}>
        <Eye className="w-3 h-3 mr-1" /> Reconcile
      </Button>
    )},
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Smart Banking" subtitle="Import bank statements and reconcile against invoices"
        action={<Button onClick={() => setUploadOpen(true)} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-upload-statement"><Upload className="w-4 h-4 mr-2" /> Import CSV</Button>}
      />
      <DataTable columns={columns} data={imports} isLoading={isLoading} />

      <FormModal open={uploadOpen} onOpenChange={setUploadOpen} title="Import bank statement" onSave={() => uploadMut.mutate(form)} isSaving={uploadMut.isPending} saveLabel="Upload">
        <div className="space-y-4">
          <div>
            <Label>Account label (optional)</Label>
            <Input value={form.accountLabel} onChange={e => setForm({...form, accountLabel: e.target.value})} placeholder="e.g. HDFC Current 5821" data-testid="input-account-label" />
          </div>
          <div>
            <Label>CSV file *</Label>
            <Input type="file" accept=".csv,text/csv" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} data-testid="input-csv-file" />
            <p className="text-xs text-muted-foreground mt-1">Expected headers (case-insensitive): date, description/narration, reference/utr, credit/debit (or amount).</p>
          </div>
          {form.csv && (
            <div>
              <Label>Preview ({form.fileName})</Label>
              <Textarea readOnly value={form.csv.split("\n").slice(0, 8).join("\n")} className="text-xs font-mono h-32" />
            </div>
          )}
        </div>
      </FormModal>

      <Sheet open={!!selectedImport} onOpenChange={(op) => !op && setSelectedImport(null)}>
        <SheetContent className="sm:max-w-3xl w-full">
          <SheetHeader className="mb-4"><SheetTitle>Reconcile Statement Lines</SheetTitle></SheetHeader>
          {selectedImport && <ReconcilePanel importId={selectedImport} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ReconcilePanel({ importId }: { importId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: linesRes, isLoading } = useQuery<{ success: boolean; data: BankLineWithSuggestion[] }>({ queryKey: ["bank-lines", importId], queryFn: () => apiFetch(`/bank-imports/${importId}/lines`) });
  const lines = linesRes?.data || [];

  const [manualPicks, setManualPicks] = React.useState<Record<string, string>>({});
  const { data: residentsRes } = useGetResidents(undefined, { query: { queryKey: getGetResidentsQueryKey() } });
  const residents: ResidentDto[] = residentsRes?.data || [];

  const confirmMut = useMutation({
    mutationFn: ({ id, residentId }: { id: string; residentId?: string }) =>
      apiFetch(`/bank-lines/${id}/confirm`, { method: "POST", body: JSON.stringify(residentId ? { residentId } : {}) }),
    onSuccess: () => { toast({ title: "Reconciled" }); qc.invalidateQueries({ queryKey: ["bank-lines", importId] }); qc.invalidateQueries({ queryKey: ["bank-imports"] }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });
  const ignoreMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/bank-lines/${id}/ignore`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bank-lines", importId] }); },
    onError: (e: Error) => toast({ title: e.message || "Failed to ignore line", variant: "destructive" }),
  });

  if (isLoading) return <div className="text-muted-foreground">Loading…</div>;
  if (lines.length === 0) return <div className="text-muted-foreground">No transactions in this import.</div>;

  return (
    <div className="space-y-3">
      {lines.map(l => (
        <div key={l.id} className="border rounded-lg p-3 bg-card">
          <div className="flex justify-between items-start gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant={l.direction === "CREDIT" ? "success" : "outline"}>{l.direction}</Badge>
                <span className="text-xs text-muted-foreground">{format(new Date(l.txnDate), "dd MMM yyyy")}</span>
                <span className="font-bold">₹{Number(l.amount).toLocaleString("en-IN")}</span>
              </div>
              <p className="text-sm">{l.description}</p>
              {l.reference && <p className="text-xs text-muted-foreground">Ref: {l.reference}</p>}
              {l.status === "SUGGESTED" && l.residentName && (
                <div className="mt-2 p-2 bg-accent/10 rounded text-xs">
                  Suggested match: <strong>{l.residentName}</strong>
                  {l.suggestionPayload?.confidence && <Badge className="ml-2 text-[10px]" variant={l.suggestionPayload.confidence === "HIGH" ? "success" : "secondary"}>{l.suggestionPayload.confidence}</Badge>}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {l.status === "MATCHED" && <Badge variant="success">Matched</Badge>}
              {l.status === "IGNORED" && <Badge variant="outline">Ignored</Badge>}
              {(l.status === "UNMATCHED" || l.status === "SUGGESTED") && l.direction === "CREDIT" && (
                <>
                  {!l.matchedResidentId && (
                    <Select value={manualPicks[l.id] || ""} onValueChange={(v) => setManualPicks((m) => ({ ...m, [l.id]: v }))}>
                      <SelectTrigger className="w-44 h-8 text-xs" data-testid={`select-resident-${l.id}`}><SelectValue placeholder="Select resident…" /></SelectTrigger>
                      <SelectContent>
                        {residents.map((r) => (
                          <SelectItem key={r.id} value={r.id}>{r.name}{r.roomNumber ? ` · ${r.roomNumber}` : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button size="sm" disabled={(!l.matchedResidentId && !manualPicks[l.id]) || confirmMut.isPending} onClick={() => confirmMut.mutate({ id: l.id, residentId: manualPicks[l.id] })} data-testid={`button-confirm-line-${l.id}`}>
                    <Check className="w-3 h-3 mr-1" /> Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ignoreMut.mutate(l.id)}>
                    <X className="w-3 h-3 mr-1" /> Ignore
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
