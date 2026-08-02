import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Send, Settings2 } from "lucide-react";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import type { ReminderRuleDto, ReminderLogDto, CreateReminderRuleBody } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

type ReminderRuleForm = CreateReminderRuleBody;

export default function RemindersPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Rent Reminders" subtitle="Automated nudges before/after due date" />
      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="logs">Sent History</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-4"><RulesTab /></TabsContent>
        <TabsContent value="logs" className="mt-4"><LogsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function RulesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: rulesRes, isLoading } = useQuery<{ success: boolean; data: ReminderRuleDto[] }>({ queryKey: ["reminder-rules"], queryFn: () => apiFetch("/reminder-rules") });
  const rules = rulesRes?.data || [];

  const defaultForm: ReminderRuleForm = { name: "", offsetDays: -5, channel: "EMAIL", templateSubject: "Rent reminder", templateBody: "Hi {{name}}, your rent of {{amount}} is due on {{dueDate}}.", isActive: true };
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ReminderRuleDto | null>(null);
  const [delId, setDelId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<ReminderRuleForm>(defaultForm);

  React.useEffect(() => {
    if (editing) setForm({
      name: editing.name,
      offsetDays: editing.offsetDays,
      channel: editing.channel,
      templateSubject: editing.templateSubject,
      templateBody: editing.templateBody,
      isActive: editing.isActive,
    });
    else setForm(defaultForm);
  }, [editing, open]);

  const saveMut = useMutation({
    mutationFn: (d: ReminderRuleForm) => editing
      ? apiFetch(`/reminder-rules/${editing.id}`, { method: "PUT", body: JSON.stringify(d) })
      : apiFetch(`/reminder-rules`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: editing ? "Rule updated" : "Rule created" }); qc.invalidateQueries({ queryKey: ["reminder-rules"] }); setOpen(false); setEditing(null); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/reminder-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "Deleted" }); qc.invalidateQueries({ queryKey: ["reminder-rules"] }); setDelId(null); },
  });
  const runMut = useMutation({
    mutationFn: (id: string) => apiFetch<{ success: boolean; data: { sent: number } }>(`/reminder-rules/${id}/run`, { method: "POST" }),
    onSuccess: (res) => { toast({ title: `Sent ${res.data?.sent ?? 0} reminders` }); qc.invalidateQueries({ queryKey: ["reminder-logs"] }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  const offsetLabel = (n: number) => n < 0 ? `${Math.abs(n)} days before due` : n === 0 ? "On due date" : `${n} days overdue`;

  const columns = [
    { accessorKey: "name", header: "Name", cell: ({row}:any) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: "offsetDays", header: "Trigger", cell: ({row}:any) => <Badge variant="outline">{offsetLabel(row.original.offsetDays)}</Badge> },
    { accessorKey: "channel", header: "Channel", cell: ({row}:any) => <Badge>{row.original.channel}</Badge> },
    { accessorKey: "isActive", header: "Status", cell: ({row}:any) => row.original.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Paused</Badge> },
    { id: "actions", header: "", cell: ({row}:any) => (
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" onClick={() => runMut.mutate(row.original.id)} disabled={runMut.isPending}>
          <Send className="w-3 h-3 mr-1" /> Run now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(row.original); setOpen(true); }}><Settings2 className="w-4 h-4" /></Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDelId(row.original.id)}><Trash2 className="w-4 h-4" /></Button>
      </div>
    )},
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-add-reminder-rule">
          <Plus className="w-4 h-4 mr-2" /> New Rule
        </Button>
      </div>
      <DataTable columns={columns} data={rules} isLoading={isLoading} />

      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Rule" : "New Reminder Rule"} onSave={() => saveMut.mutate(form)} isSaving={saveMut.isPending}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} data-testid="input-rule-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Offset days (negative=before due)</Label>
              <Input type="number" value={form.offsetDays} onChange={e => setForm({...form, offsetDays: parseInt(e.target.value) || 0})} />
              <p className="text-xs text-muted-foreground mt-1">{offsetLabel(form.offsetDays)}</p>
            </div>
            <div>
              <Label>Channel</Label>
              <Select value={form.channel} onValueChange={v => setForm({...form, channel: v as ReminderRuleForm["channel"]})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMAIL">Email</SelectItem>
                  <SelectItem value="SMS">SMS</SelectItem>
                  <SelectItem value="INAPP">In-app</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.channel === "EMAIL" && (
            <div><Label>Subject</Label><Input value={form.templateSubject || ""} onChange={e => setForm({...form, templateSubject: e.target.value})} /></div>
          )}
          <div>
            <Label>Body template *</Label>
            <Textarea rows={5} value={form.templateBody} onChange={e => setForm({...form, templateBody: e.target.value})} />
            <p className="text-xs text-muted-foreground mt-1">Variables: {`{{name}}, {{amount}}, {{dueDate}}, {{description}}`}</p>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={form.isActive} onCheckedChange={(c) => setForm({...form, isActive: c})} />
            <Label>Active</Label>
          </div>
        </div>
      </FormModal>

      <ConfirmDialog open={!!delId} onOpenChange={(op) => !op && setDelId(null)} title="Delete rule?" description="Sent reminder history will be retained." onConfirm={() => delId && delMut.mutate(delId)} isConfirming={delMut.isPending} />
    </div>
  );
}

function LogsTab() {
  const { data: logsRes, isLoading } = useQuery<{ success: boolean; data: ReminderLogDto[] }>({ queryKey: ["reminder-logs"], queryFn: () => apiFetch("/reminder-logs") });
  const logs = logsRes?.data || [];
  const columns = [
    { accessorKey: "createdAt", header: "Sent At", cell: ({row}:any) => format(new Date(row.original.createdAt), "dd MMM yyyy HH:mm") },
    { accessorKey: "residentName", header: "Resident" },
    { accessorKey: "ruleName", header: "Rule" },
    { accessorKey: "channel", header: "Channel", cell: ({row}:any) => <Badge variant="outline">{row.original.channel}</Badge> },
    { accessorKey: "subject", header: "Subject", cell: ({row}:any) => row.original.subject || "—" },
    { accessorKey: "body", header: "Body", cell: ({row}:any) => <span className="text-muted-foreground truncate max-w-[300px] block">{row.original.body}</span> },
    { accessorKey: "status", header: "Status", cell: ({row}:any) => <Badge variant={row.original.status === "SENT" ? "success" : "destructive"}>{row.original.status}</Badge> },
  ];
  return <DataTable columns={columns} data={logs} isLoading={isLoading} />;
}
