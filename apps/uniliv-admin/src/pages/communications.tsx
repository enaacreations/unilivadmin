import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Send, FileText, Settings2, Users, FileOutput, Radio } from "lucide-react";
import { useGetAnnouncements, getGetAnnouncementsQueryKey, useCreateAnnouncement, useDeleteAnnouncement, useGetProperties } from "@workspace/api-client-react";
import { format } from "date-fns";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/status-badge";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// TipTap
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

interface BulkPrefill {
  body: string;
  channel: string;
  subject?: string;
}

export default function Communications() {
  const [tab, setTab] = React.useState("announcements");
  const [bulkPrefill, setBulkPrefill] = React.useState<BulkPrefill | null>(null);
  
  return (
    <div className="space-y-6">
      <PageHeader 
        title="Communications Hub" 
        subtitle="Manage resident announcements, bulk messaging, and templates"
      />
      
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4 lg:w-[600px]">
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
          <TabsTrigger value="bulk">Bulk Messages</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>
        <div className="mt-6">
          <TabsContent value="announcements"><AnnouncementsTab /></TabsContent>
          <TabsContent value="bulk"><BulkMessagesTab prefill={bulkPrefill} onPrefillConsumed={() => setBulkPrefill(null)} /></TabsContent>
          <TabsContent value="templates"><TemplatesTab onUseTemplate={(tmpl) => { setBulkPrefill({ body: tmpl.body, channel: tmpl.channel, subject: tmpl.subject }); setTab("bulk"); }} /></TabsContent>
          <TabsContent value="audit"><AuditLogTab /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

const announcementSchema = z.object({
  title: z.string().min(1, "Required"),
  content: z.string().min(1, "Required"),
  type: z.string().default("GENERAL"),
  target: z.string().default("ALL"),
  propertyIds: z.array(z.string()).default([]),
});

function AnnouncementsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: res, isLoading } = useGetAnnouncements({} as any, { query: { queryKey: getGetAnnouncementsQueryKey({} as any) } });
  const { data: propsRes } = useGetProperties();
  const createMut = useCreateAnnouncement();
  const delMut = useDeleteAnnouncement();

  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  const announcements = res?.data || [];
  const properties = propsRes?.data || [];

  const form = useForm<z.infer<typeof announcementSchema>>({
    resolver: zodResolver(announcementSchema),
    defaultValues: { title: "", content: "", type: "GENERAL", target: "ALL", propertyIds: [] }
  });

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    onUpdate: ({ editor }) => {
      form.setValue("content", editor.getHTML());
    },
  });

  React.useEffect(() => {
    if (isCreateOpen && editor) {
      editor.commands.setContent("");
      form.reset();
    }
  }, [isCreateOpen, editor, form]);

  const onSubmit = async (values: z.infer<typeof announcementSchema>) => {
    const base = { title: values.title, content: values.content, type: values.type };

    // The announcement endpoint scopes a row to a single `propertyId`. When the
    // admin targets several specific properties we fan out one announcement per
    // property so every selected property actually receives it — instead of
    // silently keeping only the first selection.
    const targets: (string | null)[] =
      values.target === "SPECIFIC" && values.propertyIds.length > 0
        ? values.propertyIds
        : [null]; // ALL Properties → single un-scoped row

    setIsSubmitting(true);
    try {
      const results = await Promise.allSettled(
        targets.map((propertyId) =>
          createMut.mutateAsync({
            data: { ...base, ...(propertyId ? { propertyId } : {}) } as any,
          }),
        ),
      );

      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;

      qc.invalidateQueries({ queryKey: getGetAnnouncementsQueryKey({} as any) });

      if (failed === 0) {
        setIsCreateOpen(false);
        toast({
          title:
            targets.length > 1
              ? `Announcement posted to ${succeeded} properties`
              : "Announcement posted",
        });
      } else if (succeeded > 0) {
        // Partial failure — keep the modal open so the admin can retry the rest.
        toast({
          variant: "destructive",
          title: `Posted to ${succeeded} of ${targets.length} properties`,
          description: `${failed} ${failed === 1 ? "property" : "properties"} failed. Please retry.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Failed to post announcement",
          description: "No properties were updated. Please try again.",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns = [
    { accessorKey: "title", header: "Title", cell: ({row}:any) => <span className="font-medium">{row.original.title}</span> },
    { accessorKey: "propertyName", header: "Scope", cell: ({row}:any) => {
      if (!row.original.propertyId) return <Badge variant="secondary">All Properties</Badge>;
      const p = properties.find(x => x.id === row.original.propertyId);
      return <Badge variant="outline">{p?.name || "Specific Property"}</Badge>;
    }},
    { accessorKey: "type", header: "Priority/Type", cell: ({row}:any) => <StatusBadge status={row.original.type} /> },
    { accessorKey: "createdAt", header: "Date", cell: ({row}:any) => format(new Date(row.original.createdAt), "dd MMM yyyy") },
    { id: "actions", header: "", cell: ({row}:any) => (
      <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(row.original.id)}>
        <Trash2 className="w-4 h-4" />
      </Button>
    )}
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setIsCreateOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
          <Plus className="w-4 h-4 mr-2" /> New Announcement
        </Button>
      </div>
      <DataTable columns={columns} data={announcements} isLoading={isLoading} searchKey="title" searchPlaceholder="Search announcements..." />
      
      <FormModal open={isCreateOpen} onOpenChange={setIsCreateOpen} title="Create Announcement" onSave={form.handleSubmit(onSubmit)} isSaving={isSubmitting}>
        <Form {...form}>
          <form className="space-y-4">
            <FormField control={form.control} name="title" render={({field}) => (
              <FormItem><FormLabel>Title</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="type" render={({field}) => (
                <FormItem><FormLabel>Priority</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="GENERAL">Normal</SelectItem>
                      <SelectItem value="URGENT">Urgent</SelectItem>
                      <SelectItem value="EVENT">Event</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
              <FormField control={form.control} name="target" render={({field}) => (
                <FormItem><FormLabel>Target Scope</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="ALL">All Properties</SelectItem>
                      <SelectItem value="SPECIFIC">Specific Properties</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
            </div>
            {form.watch("target") === "SPECIFIC" && (
              <div className="border rounded p-3 bg-surface max-h-40 overflow-y-auto space-y-2">
                <Label className="mb-2 flex items-center justify-between">
                  <span>Select Properties</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {form.watch("propertyIds").length} selected
                  </span>
                </Label>
                {properties.map(p => (
                  <div key={p.id} className="flex items-center space-x-2">
                    <Checkbox id={`p-${p.id}`} checked={form.watch("propertyIds").includes(p.id)} onCheckedChange={(c) => {
                      const cur = form.watch("propertyIds");
                      form.setValue("propertyIds", c ? [...cur, p.id] : cur.filter(x => x !== p.id));
                    }} />
                    <label htmlFor={`p-${p.id}`} className="text-sm font-medium leading-none">{p.name}</label>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <Label>Content</Label>
              <div className="border rounded-md min-h-[150px] p-2 bg-card prose prose-sm max-w-none">
                <EditorContent editor={editor} />
              </div>
            </div>
          </form>
        </Form>
      </FormModal>

      <ConfirmDialog open={!!deleteId} onOpenChange={(op) => !op && setDeleteId(null)} title="Delete Announcement?" description="Cannot be undone." onConfirm={() => { if(deleteId) delMut.mutate({id: deleteId}, {onSuccess: () => {setDeleteId(null); qc.invalidateQueries({queryKey: getGetAnnouncementsQueryKey({} as any)});}}); }} isConfirming={delMut.isPending} />
    </div>
  );
}

function BulkMessagesTab({ prefill, onPrefillConsumed }: { prefill: BulkPrefill | null; onPrefillConsumed: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: propsRes } = useGetProperties();
  const properties = propsRes?.data || [];
  
  const [form, setForm] = React.useState({ propertyId: "ALL", audience: "ACTIVE", channel: "EMAIL", subject: "", body: "" });

  // Apply template prefill when switched from Templates tab
  React.useEffect(() => {
    if (!prefill) return;
    setForm(prev => ({
      ...prev,
      channel: prefill.channel || prev.channel,
      body: prefill.body || prev.body,
      subject: prefill.subject || prev.subject,
    }));
    onPrefillConsumed();
  }, [prefill]);

  const mutPreview = useMutation({
    mutationFn: (data: any) => apiFetch("/communications/preview", { method: "POST", body: JSON.stringify(data) })
  });

  const mutSend = useMutation({
    mutationFn: (data: any) => apiFetch("/communications/bulk-send", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (res: any) => {
      // Surface the new send in the Audit Log immediately.
      qc.invalidateQueries({ queryKey: ["communications-logs"] });
      const d = res?.data ?? {};
      // Read the real dispatch outcome from the backend. The notification
      // service either delivers inline or enqueues for the worker, so a recipient
      // is counted as "queued" when handed off and "failed" when the provider
      // (or address resolution) rejected it. Fall back to the recipient count for
      // older response shapes so the toast never under-reports.
      const total: number = d.totalRecipients ?? d.total ?? 0;
      const failures: { to?: string; name?: string; error?: string }[] = Array.isArray(d.failures)
        ? d.failures
        : [];
      const failed: number = d.failed ?? failures.length;
      const sent: number = d.sent ?? d.delivered ?? 0;
      const queued: number = d.queued ?? 0;
      // Prefer explicit accepted/handed-off counts; otherwise infer from total − failed.
      const accepted: number = d.accepted ?? (sent + queued > 0 ? sent + queued : Math.max(total - failed, 0));

      if (failed > 0) {
        const names = failures
          .slice(0, 3)
          .map((f) => f.name || f.to)
          .filter(Boolean)
          .join(", ");
        toast({
          variant: "destructive",
          title: `${accepted} of ${total} ${form.channel} messages dispatched`,
          description:
            `${failed} failed` +
            (names ? `: ${names}${failures.length > 3 ? ` +${failures.length - 3} more` : ""}` : ". See Audit Log for details."),
        });
      } else {
        // Distinguish "delivered now" from "handed to the queue" so we never imply
        // guaranteed delivery for messages that are still in flight.
        const verb = queued > 0 && sent === 0 ? "queued for delivery" : "dispatched";
        toast({
          title: `${accepted || total} ${form.channel} message${(accepted || total) === 1 ? "" : "s"} ${verb}`,
          description: "Recorded in the Audit Log.",
        });
      }

      // Only clear the composer when the whole batch was accepted, so the admin
      // can retry after a partial/total failure without re-typing.
      if (failed === 0) setForm({ ...form, subject: "", body: "" });
    },
    onError: (e: any) => toast({ title: e.message || "Failed to send", variant: "destructive" })
  });

  // Debounced preview
  React.useEffect(() => {
    const t = setTimeout(() => {
      mutPreview.mutate({ propertyId: form.propertyId === "ALL" ? undefined : form.propertyId, status: form.audience === "ALL" ? undefined : form.audience, body: form.body || " ", subject: form.subject });
    }, 500);
    return () => clearTimeout(t);
  }, [form.propertyId, form.audience, form.body, form.subject]);

  const previewData = (mutPreview.data as any)?.data || { total: 0, sample: [] };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="p-4 border rounded-lg bg-card space-y-4">
          <h3 className="font-display font-semibold border-b pb-2">Target Audience</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="mb-2 block">Property</Label>
              <Select value={form.propertyId} onValueChange={v => setForm({...form, propertyId: v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Properties</SelectItem>
                  {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-2 block">Resident Status</Label>
              <Select value={form.audience} onValueChange={v => setForm({...form, audience: v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Residents</SelectItem>
                  <SelectItem value="ACTIVE">Active Only</SelectItem>
                  <SelectItem value="OVERDUE">Payment Overdue</SelectItem>
                  <SelectItem value="NOTICE_PERIOD">On Notice</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="p-4 border rounded-lg bg-card space-y-4">
          <div className="flex justify-between items-center border-b pb-2 mb-2">
            <h3 className="font-display font-semibold">Message Content</h3>
            <div className="flex bg-surface p-1 rounded-md">
              {["SMS", "WHATSAPP", "EMAIL"].map(ch => (
                <button key={ch} onClick={() => setForm({...form, channel: ch})} className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${form.channel === ch ? 'bg-card shadow text-primary' : 'text-muted-foreground hover:text-primary'}`}>
                  {ch}
                </button>
              ))}
            </div>
          </div>
          
          {form.channel === "EMAIL" && (
            <div>
              <Label className="mb-1 block">Subject</Label>
              <Input value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} placeholder="Email Subject" />
            </div>
          )}
          
          <div>
            <div className="flex justify-between mb-1">
              <Label>Body</Label>
              <span className="text-xs text-muted-foreground">Vars: {"{{name}}, {{amount}}, {{dueDate}}"}</span>
            </div>
            <Textarea className="h-40" value={form.body} onChange={e => setForm({...form, body: e.target.value})} placeholder="Hello {{name}}, your rent of {{amount}} is due on {{dueDate}}..." />
          </div>

          <div className="flex justify-between items-center pt-2">
            <p className="text-sm font-medium">Recipients: <span className="text-primary font-bold">{previewData.total}</span></p>
            <Button onClick={() => mutSend.mutate(form)} disabled={!form.body || mutSend.isPending || previewData.total === 0} className="bg-accent hover:bg-accent/90 text-white">
              <Send className="w-4 h-4 mr-2" /> Send Message
            </Button>
          </div>
        </div>
      </div>

      <div className="lg:col-span-1 space-y-4">
        <div className="border rounded-lg bg-card overflow-hidden">
          <div className="bg-surface px-4 py-3 border-b flex items-center justify-between">
            <h3 className="font-display font-medium text-sm">Live Preview</h3>
            <Badge variant="outline" className="text-xs">{form.channel}</Badge>
          </div>
          <div className="p-4 space-y-4">
            {previewData.sample && previewData.sample.length > 0 ? previewData.sample.map((s: any, i: number) => (
              <div key={i} className="p-3 border rounded-md bg-surface/50 text-sm">
                <p className="text-xs text-muted-foreground mb-1 border-b pb-1">To: {s.to} ({s.name})</p>
                {form.channel === "EMAIL" && s.subject && <p className="font-semibold mb-1">{s.subject}</p>}
                <p className="whitespace-pre-wrap">{s.body}</p>
              </div>
            )) : (
              <div className="text-center p-6 text-muted-foreground text-sm">
                Type a message to see preview with substituted variables.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplatesTab({ onUseTemplate }: { onUseTemplate: (b: any) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: tmplRes, isLoading } = useQuery({ queryKey: ["message-templates"], queryFn: () => apiFetch("/message-templates") });
  const templates = (tmplRes as any)?.data || [];

  const [createOpen, setCreateOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", channel: "SMS", body: "", variables: [] as string[] });

  const mutCreate = useMutation({
    mutationFn: (data: any) => apiFetch("/message-templates", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { toast({title: "Template Saved"}); qc.invalidateQueries({queryKey: ["message-templates"]}); setCreateOpen(false); setForm({name:"", channel:"SMS", body:"", variables:[]}); }
  });

  const mutDelete = useMutation({
    mutationFn: (id: string) => apiFetch(`/message-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast({title: "Deleted"}); qc.invalidateQueries({queryKey: ["message-templates"]}); }
  });

  const extractVars = (text: string) => {
    const matches = text.match(/{{([^}]+)}}/g) || [];
    return Array.from(new Set(matches.map(m => m.replace(/[{}]/g, ''))));
  };

  const handleBodyChange = (v: string) => {
    setForm({...form, body: v, variables: extractVars(v)});
  };

  const columns = [
    { accessorKey: "name", header: "Template Name", cell: ({row}:any) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: "channel", header: "Channel", cell: ({row}:any) => <Badge variant="outline">{row.original.channel}</Badge> },
    { id: "vars", header: "Variables", cell: ({row}:any) => (
      <div className="flex gap-1 flex-wrap max-w-[200px]">
        {(row.original.variables || []).map((v:string) => <Badge key={v} variant="secondary" className="text-[10px]">{`{{${v}}}`}</Badge>)}
      </div>
    )},
    { accessorKey: "body", header: "Preview", cell: ({row}:any) => <span className="text-muted-foreground truncate max-w-[300px] block">{row.original.body}</span> },
    { id: "actions", header: "", cell: ({row}:any) => (
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={() => onUseTemplate(row.original)}>Use</Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => mutDelete.mutate(row.original.id)}><Trash2 className="w-4 h-4" /></Button>
      </div>
    )}
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
          <Plus className="w-4 h-4 mr-2" /> New Template
        </Button>
      </div>
      <DataTable columns={columns} data={templates} isLoading={isLoading} searchKey="name" searchPlaceholder="Search templates..." />

      <FormModal open={createOpen} onOpenChange={setCreateOpen} title="New Template" onSave={() => mutCreate.mutate(form)} isSaving={mutCreate.isPending}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} /></div>
          <div>
            <Label>Channel *</Label>
            <Select value={form.channel} onValueChange={v => setForm({...form, channel: v})}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SMS">SMS</SelectItem>
                <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
                <SelectItem value="EMAIL">Email</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="flex justify-between">Body * <span className="text-xs text-muted-foreground">Use {"{{var}}"} for variables</span></Label>
            <Textarea rows={6} value={form.body} onChange={e => handleBodyChange(e.target.value)} />
          </div>
          {form.variables.length > 0 && (
            <div>
              <Label className="mb-2 block">Detected Variables</Label>
              <div className="flex gap-2 flex-wrap">
                {form.variables.map(v => <Badge key={v} variant="secondary">{`{{${v}}}`}</Badge>)}
              </div>
            </div>
          )}
        </div>
      </FormModal>
    </div>
  );
}

function AuditLogTab() {
  const { data: logRes, isLoading } = useQuery({ queryKey: ["communications-logs"], queryFn: () => apiFetch("/communications/logs") });
  const logs = (logRes as any)?.data || [];
  
  const [viewLog, setViewLog] = React.useState<any>(null);

  const columns = [
    { accessorKey: "createdAt", header: "Date", cell: ({row}:any) => format(new Date(row.original.createdAt), "dd MMM yyyy HH:mm") },
    { accessorKey: "channel", header: "Channel", cell: ({row}:any) => <Badge variant="outline">{row.original.channel}</Badge> },
    { accessorKey: "recipientCount", header: "Recipients", cell: ({row}:any) => <span className="font-mono">{row.original.recipientCount}</span> },
    { accessorKey: "subject", header: "Subject", cell: ({row}:any) => row.original.subject || "—" },
    { accessorKey: "body", header: "Content Preview", cell: ({row}:any) => <span className="text-muted-foreground truncate max-w-[200px] block">{row.original.body}</span> },
    { id: "action", header: "", cell: ({row}:any) => <Button variant="ghost" size="sm" onClick={() => setViewLog(row.original)}>View</Button> }
  ];

  return (
    <div>
      <DataTable columns={columns} data={logs} isLoading={isLoading} />
      
      <Dialog open={!!viewLog} onOpenChange={(op) => !op && setViewLog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Message Log Details</DialogTitle></DialogHeader>
          {viewLog && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-3 gap-4 text-sm bg-surface p-4 rounded-lg">
                <div><span className="text-muted-foreground block text-xs">Date</span>{new Date(viewLog.createdAt).toLocaleString()}</div>
                <div><span className="text-muted-foreground block text-xs">Channel</span>{viewLog.channel}</div>
                <div><span className="text-muted-foreground block text-xs">Recipients</span>{viewLog.recipientCount}</div>
              </div>
              
              <div>
                <Label className="mb-2 block">Content</Label>
                <div className="p-4 border rounded bg-card text-sm whitespace-pre-wrap">
                  {viewLog.subject && <div className="font-bold border-b pb-2 mb-2">{viewLog.subject}</div>}
                  {viewLog.body}
                </div>
              </div>
              
              <div>
                <Label className="mb-2 block">Target Filter</Label>
                <pre className="p-4 rounded bg-primary text-primary-foreground font-mono text-xs overflow-x-auto">
                  {JSON.stringify(viewLog.recipientFilter || viewLog.filter || {}, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
