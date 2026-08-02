import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Plus, Play, Trash2, Settings2 } from "lucide-react";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { useGetProperties } from "@workspace/api-client-react";
import type { BillingCycleDto, BillingRunDto, CreateBillingCycleBody, CreateBillingCycleBodyCadence } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

type CycleForm = CreateBillingCycleBody;

export default function BillingCyclesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Recurring Billing" subtitle="Automate rent invoice generation per property" />
      <Tabs defaultValue="cycles">
        <TabsList>
          <TabsTrigger value="cycles">Cycles</TabsTrigger>
          <TabsTrigger value="runs">Run History</TabsTrigger>
        </TabsList>
        <TabsContent value="cycles" className="mt-4"><CyclesTab /></TabsContent>
        <TabsContent value="runs" className="mt-4"><RunsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function CyclesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: cyclesRes, isLoading } = useQuery<{ success: boolean; data: BillingCycleDto[] }>({ queryKey: ["billing-cycles"], queryFn: () => apiFetch("/billing-cycles") });
  const cycles = cyclesRes?.data || [];
  const { data: propsRes } = useGetProperties();
  const properties = propsRes?.data || [];

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BillingCycleDto | null>(null);
  const [delId, setDelId] = React.useState<string | null>(null);
  const defaultForm: CycleForm & { propertyId: string } = { name: "", propertyId: "GLOBAL", cadence: "MONTHLY" as CreateBillingCycleBodyCadence, dayOfMonth: 5, ledgerType: "RENT", descriptionTemplate: "Rent for {{month}}", isActive: true };
  const [form, setForm] = React.useState<CycleForm & { propertyId: string }>(defaultForm);

  React.useEffect(() => {
    if (editing) setForm({
      name: editing.name,
      propertyId: editing.propertyId || "GLOBAL",
      cadence: editing.cadence,
      dayOfMonth: editing.dayOfMonth,
      customDays: editing.customDays,
      ledgerType: editing.ledgerType,
      descriptionTemplate: editing.descriptionTemplate,
      isActive: editing.isActive,
    });
    else setForm(defaultForm);
  }, [editing, open]);

  const saveMut = useMutation({
    mutationFn: (data: CycleForm) => editing
      ? apiFetch(`/billing-cycles/${editing.id}`, { method: "PUT", body: JSON.stringify(data) })
      : apiFetch("/billing-cycles", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { toast({ title: editing ? "Cycle updated" : "Cycle created" }); qc.invalidateQueries({ queryKey: ["billing-cycles"] }); setOpen(false); setEditing(null); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/billing-cycles/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "Deleted" }); qc.invalidateQueries({ queryKey: ["billing-cycles"] }); setDelId(null); },
  });

  const runMut = useMutation({
    mutationFn: (id: string) => apiFetch<{ success: boolean; data: BillingRunDto }>(`/billing-cycles/${id}/run`, { method: "POST" }),
    onSuccess: (res) => {
      const r = res.data;
      toast({ title: `Run completed`, description: `${r.successCount} created • ${r.skippedCount} skipped • ${r.failedCount} failed` });
      qc.invalidateQueries({ queryKey: ["billing-cycles"] });
      qc.invalidateQueries({ queryKey: ["billing-runs"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Run failed", variant: "destructive" }),
  });

  const onSubmit = () => {
    const payload = { ...form, propertyId: form.propertyId === "GLOBAL" ? null : form.propertyId };
    saveMut.mutate(payload);
  };

  const columns = [
    { accessorKey: "name", header: "Name", cell: ({row}:any) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: "propertyName", header: "Scope", cell: ({row}:any) => row.original.propertyName ? <Badge variant="outline">{row.original.propertyName}</Badge> : <Badge variant="secondary">All Properties</Badge> },
    { accessorKey: "cadence", header: "Cadence", cell: ({row}:any) => {
      const c = row.original;
      if (c.cadence === "WEEKLY") return <span>Weekly (Mon)</span>;
      if (c.cadence === "CUSTOM_DAYS") return <span>Every {c.customDays || 30}d</span>;
      return <span>Monthly (day {c.dayOfMonth})</span>;
    }},
    { accessorKey: "ledgerType", header: "Type" },
    { accessorKey: "isActive", header: "Status", cell: ({row}:any) => row.original.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Paused</Badge> },
    { accessorKey: "lastRunAt", header: "Last Run", cell: ({row}:any) => row.original.lastRunAt ? format(new Date(row.original.lastRunAt), "dd MMM yyyy HH:mm") : "—" },
    { id: "actions", header: "", cell: ({row}:any) => (
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" onClick={() => runMut.mutate(row.original.id)} disabled={runMut.isPending} data-testid={`button-run-cycle-${row.original.id}`}>
          <Play className="w-3 h-3 mr-1" /> Run now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(row.original); setOpen(true); }}><Settings2 className="w-4 h-4" /></Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDelId(row.original.id)}><Trash2 className="w-4 h-4" /></Button>
      </div>
    )},
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-add-cycle">
          <Plus className="w-4 h-4 mr-2" /> New Billing Cycle
        </Button>
      </div>
      <DataTable columns={columns} data={cycles} isLoading={isLoading} />

      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Cycle" : "New Billing Cycle"} onSave={onSubmit} isSaving={saveMut.isPending}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Monthly Rent" data-testid="input-cycle-name" /></div>
          <div>
            <Label>Property scope</Label>
            <Select value={form.propertyId} onValueChange={v => setForm({...form, propertyId: v})}>
              <SelectTrigger data-testid="select-cycle-property"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="GLOBAL">All Properties (Global)</SelectItem>
                {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cadence</Label>
              <Select value={form.cadence} onValueChange={v => setForm({...form, cadence: v as CreateBillingCycleBodyCadence})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="WEEKLY">Weekly (every Monday)</SelectItem>
                  <SelectItem value="CUSTOM_DAYS">Every N days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.cadence === "MONTHLY" && (
              <div>
                <Label>Day of month (1-28)</Label>
                <Input type="number" min={1} max={28} value={form.dayOfMonth} onChange={e => setForm({...form, dayOfMonth: parseInt(e.target.value) || 1})} />
              </div>
            )}
            {form.cadence === "CUSTOM_DAYS" && (
              <div>
                <Label>Interval (days)</Label>
                <Input type="number" min={1} max={365} value={form.customDays ?? 30} onChange={e => setForm({...form, customDays: parseInt(e.target.value) || 30})} data-testid="input-custom-days" />
              </div>
            )}
            {form.cadence === "WEEKLY" && (
              <div className="flex items-end text-xs text-muted-foreground pb-2">
                Runs every Monday morning automatically.
              </div>
            )}
          </div>
          <div>
            <Label>Ledger type</Label>
            <Select value={form.ledgerType} onValueChange={v => setForm({...form, ledgerType: v})}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="RENT">Rent</SelectItem>
                <SelectItem value="UTILITY">Utility</SelectItem>
                <SelectItem value="FOOD">Food</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Description template</Label>
            <Input value={form.descriptionTemplate} onChange={e => setForm({...form, descriptionTemplate: e.target.value})} />
            <p className="text-xs text-muted-foreground mt-1">Use {`{{month}}`} for the period name.</p>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={form.isActive} onCheckedChange={(c) => setForm({...form, isActive: c})} />
            <Label>Active</Label>
          </div>
        </div>
      </FormModal>

      <ConfirmDialog open={!!delId} onOpenChange={(op) => !op && setDelId(null)} title="Delete cycle?" description="Past billing run history will be retained, but no future invoices will be generated." onConfirm={() => delId && delMut.mutate(delId)} isConfirming={delMut.isPending} />
    </div>
  );
}

function RunsTab() {
  const { data: runsRes, isLoading } = useQuery<{ success: boolean; data: BillingRunDto[] }>({ queryKey: ["billing-runs"], queryFn: () => apiFetch("/billing-runs") });
  const runs = runsRes?.data || [];
  const columns = [
    { accessorKey: "createdAt", header: "Run At", cell: ({row}:any) => format(new Date(row.original.createdAt), "dd MMM yyyy HH:mm") },
    { accessorKey: "periodLabel", header: "Period" },
    { accessorKey: "triggeredBy", header: "Trigger", cell: ({row}:any) => <Badge variant={row.original.triggeredBy === "SCHEDULER" ? "secondary" : "outline"}>{row.original.triggeredBy === "SCHEDULER" ? "Auto" : "Manual"}</Badge> },
    { accessorKey: "successCount", header: "Created", cell: ({row}:any) => <span className="font-mono text-success">{row.original.successCount}</span> },
    { accessorKey: "skippedCount", header: "Skipped", cell: ({row}:any) => <span className="font-mono">{row.original.skippedCount}</span> },
    { accessorKey: "failedCount", header: "Failed", cell: ({row}:any) => <span className={`font-mono ${row.original.failedCount > 0 ? "text-destructive" : ""}`}>{row.original.failedCount}</span> },
    { accessorKey: "totalEligible", header: "Eligible" },
  ];
  return <DataTable columns={columns} data={runs} isLoading={isLoading} />;
}
