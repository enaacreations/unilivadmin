import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import jsPDF from "jspdf";
import { apiFetch, apiDownload } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { FormModal } from "@/components/ui/form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker, DateTimePicker, ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, LayoutGrid, List, Calendar, FileDown, MessageSquare, X, Phone, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STAGES = [
  { key: "NEW", label: "New" },
  { key: "CONTACTED", label: "Contacted" },
  { key: "VISIT_SCHEDULED", label: "Visit Scheduled" },
  { key: "VISIT_DONE", label: "Visit Done" },
  { key: "NEGOTIATING", label: "Negotiating" },
  { key: "CONVERTED", label: "Converted" },
  { key: "LOST", label: "Lost" },
];
const SOURCES = ["WEBSITE", "WHATSAPP", "INSTAGRAM", "COLD_CALL", "REFERRAL", "COLLEGE", "OTHER"];
const LOST_REASONS = ["Price", "Location", "Amenities", "Timing", "Competitor", "Other"];

const leadSchema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().min(7, "Required"),
  email: z.string().email().or(z.literal("")).optional(),
  source: z.string().min(1, "Required"),
  propertyId: z.string().optional(),
  budgetMin: z.coerce.number().optional(),
  budgetMax: z.coerce.number().optional(),
  moveInDate: z.string().optional(),
  assignedTo: z.string().optional(),
  notes: z.string().optional(),
});
type LeadForm = z.infer<typeof leadSchema>;

function daysSince(d?: string | null) {
  if (!d) return 0;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

export default function Leads() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [view, setView] = React.useState<"kanban" | "list">("kanban");
  const [open, setOpen] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<{ stage?: string; source?: string; propertyId?: string; assignedTo?: string }>({});

  const { data: leadsRes, isLoading } = useQuery({ queryKey: ["leads", filters], queryFn: () => {
    const qs = new URLSearchParams();
    if (filters.stage) qs.set("stage", filters.stage);
    if (filters.source) qs.set("source", filters.source);
    if (filters.propertyId) qs.set("propertyId", filters.propertyId);
    if (filters.assignedTo) qs.set("assignedTo", filters.assignedTo);
    qs.set("limit", "200");
    return apiFetch<any>(`/leads?${qs}`);
  }});
  const leads = leadsRes?.data || [];

  const { data: propsRes } = useQuery({ queryKey: ["properties"], queryFn: () => apiFetch<any>("/properties") });
  const properties = propsRes?.data || [];
  const { data: usersRes } = useQuery({ queryKey: ["users"], queryFn: () => apiFetch<any>("/users") });
  const users = usersRes?.data || [];

  const form = useForm<LeadForm>({ resolver: zodResolver(leadSchema), defaultValues: { name: "", phone: "", email: "", source: "WEBSITE" } });

  const onCreate = form.handleSubmit(async (values) => {
    try {
      const payload: any = { ...values };
      if (!payload.email) delete payload.email;
      await apiFetch("/leads", { method: "POST", body: JSON.stringify(payload) });
      toast({ title: "Lead created" });
      setOpen(false); form.reset();
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  });

  const moveStage = async (id: string, stage: string) => {
    try {
      await apiFetch(`/leads/${id}`, { method: "PUT", body: JSON.stringify({ stage }) });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const onDragStart = (e: React.DragEvent, id: string) => e.dataTransfer.setData("text/plain", id);
  const onDrop = (e: React.DragEvent, stage: string) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id) moveStage(id, stage); };

  const exportCsv = async () => {
    // Authenticated download: the export route requires a Bearer token, which window.open
    // cannot attach. apiDownload attaches the in-memory token (with 401→refresh→retry) and
    // saves the returned blob.
    try {
      await apiDownload(`/api/leads/export-csv?_t=${Date.now()}`, "leads.csv");
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    }
  };

  const cols = [
    { accessorKey: "name", header: "Name", cell: ({ row }: any) => <button className="font-medium text-primary" onClick={() => setActiveId(row.original.id)}>{row.original.name}</button> },
    { accessorKey: "phone", header: "Contact" },
    { accessorKey: "source", header: "Source", cell: ({ row }: any) => <Badge variant="outline">{row.original.source}</Badge> },
    { accessorKey: "stage", header: "Stage", cell: ({ row }: any) => <Badge>{row.original.stage}</Badge> },
    { accessorKey: "propertyName", header: "Property" },
    { accessorKey: "assignedToName", header: "Assigned" },
    { accessorKey: "createdAt", header: "Created", cell: ({ row }: any) => new Date(row.original.createdAt).toLocaleDateString() },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Sales Pipeline" subtitle="Track leads from inquiry to move-in" action={
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportCsv}><FileDown className="h-4 w-4 mr-2" />Export</Button>
          <Button variant={view === "kanban" ? "default" : "outline"} size="icon" onClick={() => setView("kanban")}><LayoutGrid className="h-4 w-4" /></Button>
          <Button variant={view === "list" ? "default" : "outline"} size="icon" onClick={() => setView("list")}><List className="h-4 w-4" /></Button>
          <Button onClick={() => { form.reset({ name: "", phone: "", email: "", source: "WEBSITE" }); setOpen(true); }}><Plus className="h-4 w-4 mr-2" />Add Lead</Button>
        </div>
      } />

      <div className="flex flex-wrap gap-2">
        <Select value={filters.source || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, source: v === "ALL" ? undefined : v }))}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All sources</SelectItem>{SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={filters.propertyId || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, propertyId: v === "ALL" ? undefined : v }))}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All properties</SelectItem>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={filters.assignedTo || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, assignedTo: v === "ALL" ? undefined : v }))}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Assigned to" /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All staff</SelectItem>{users.map((u: any) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {view === "kanban" ? (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-7 gap-3 min-h-[60vh]">
          {STAGES.map((s) => {
            const items = leads.filter((l: any) => l.stage === s.key);
            return (
              <div key={s.key} className="bg-muted/30 rounded-lg p-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, s.key)}>
                <div className="flex items-center justify-between mb-2 px-1"><span className="text-xs font-medium">{s.label}</span><Badge variant="outline" className="text-xs">{items.length}</Badge></div>
                <div className="space-y-2">
                  {items.map((l: any) => {
                    const overdue = l.followUpAt && new Date(l.followUpAt) < new Date();
                    return (
                      <div key={l.id} draggable onDragStart={(e) => onDragStart(e, l.id)} onClick={() => setActiveId(l.id)} className="bg-card rounded-md p-2 cursor-pointer border hover:border-primary transition-colors">
                        <div className="font-medium text-sm">{l.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{l.propertyName || "—"}</div>
                        <div className="flex items-center justify-between mt-2">
                          <Badge variant="outline" className="text-[10px] px-1">{l.source}</Badge>
                          <span className="text-[10px] text-muted-foreground">{daysSince(l.updatedAt)}d</span>
                        </div>
                        {l.followUpAt && <div className={`text-[10px] mt-1 ${overdue ? "text-destructive" : "text-muted-foreground"}`}>FU: {new Date(l.followUpAt).toLocaleDateString()}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : <DataTable columns={cols} data={leads} isLoading={isLoading} />}

      <FormModal open={open} onOpenChange={setOpen} title="Add Lead" onSave={onCreate}>
        <form className="space-y-3">
          <div><Label>Name *</Label><Input {...form.register("name")} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Phone *</Label><Input {...form.register("phone")} /></div>
            <div><Label>Email</Label><Input type="email" {...form.register("email")} /></div>
          </div>
          <div><Label>Source *</Label>
            <Select value={form.watch("source")} onValueChange={(v) => form.setValue("source", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
          </div>
          <div><Label>Property Interested In</Label>
            <Select value={form.watch("propertyId") || ""} onValueChange={(v) => form.setValue("propertyId", v)}><SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger><SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Budget min</Label><Input type="number" {...form.register("budgetMin")} /></div>
            <div><Label>Budget max</Label><Input type="number" {...form.register("budgetMax")} /></div>
          </div>
          <div><Label>Move-in date</Label><ControlledDatePicker control={form.control} name="moveInDate" /></div>
          <div><Label>Assign to</Label>
            <Select value={form.watch("assignedTo") || ""} onValueChange={(v) => form.setValue("assignedTo", v)}><SelectTrigger><SelectValue placeholder="Auto-assign" /></SelectTrigger><SelectContent>{users.map((u: any) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent></Select>
          </div>
          <div><Label>Notes</Label><Textarea rows={3} {...form.register("notes")} /></div>
        </form>
      </FormModal>

      {activeId && <LeadDetail id={activeId} onClose={() => setActiveId(null)} properties={properties} />}
    </div>
  );
}

function LeadDetail({ id, onClose, properties }: { id: string; onClose: () => void; properties: any[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: leadRes } = useQuery({ queryKey: ["lead", id], queryFn: () => apiFetch<any>(`/leads/${id}`) });
  const { data: actsRes } = useQuery({ queryKey: ["lead-acts", id], queryFn: () => apiFetch<any>(`/leads/${id}/activities`) });
  const lead = leadRes?.data;
  const activities = actsRes?.data || [];

  const [visitOpen, setVisitOpen] = React.useState(false);
  const [outcomeOpen, setOutcomeOpen] = React.useState(false);
  const [followOpen, setFollowOpen] = React.useState(false);
  const [lostOpen, setLostOpen] = React.useState(false);
  const [convertOpen, setConvertOpen] = React.useState(false);
  const [noteText, setNoteText] = React.useState("");

  if (!lead) return null;

  const stageIdx = STAGES.findIndex((s) => s.key === lead.stage);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["lead", id] }); qc.invalidateQueries({ queryKey: ["lead-acts", id] }); qc.invalidateQueries({ queryKey: ["leads"] }); };

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await apiFetch(`/leads/${id}/activities`, { method: "POST", body: JSON.stringify({ type: "NOTE", note: noteText }) });
      setNoteText(""); refresh(); toast({ title: "Note added" });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const generateQuote = () => {
    const doc = new jsPDF();
    doc.setFontSize(18); doc.text("UNILIV — Lead Quotation", 20, 20);
    doc.setFontSize(11); doc.text(`Lead: ${lead.name}`, 20, 35); doc.text(`Phone: ${lead.phone}`, 20, 42);
    doc.text(`Property: ${lead.propertyName || "—"}`, 20, 49); doc.text(`Date: ${new Date().toLocaleDateString()}`, 20, 56);
    doc.line(20, 65, 190, 65);
    doc.text("Plan: Monthly", 20, 75); doc.text(`Estimated rent: Rs. ${lead.budgetMax || "TBD"}/mo`, 20, 82);
    doc.text("Includes: Wi-Fi, housekeeping, security, common utilities", 20, 92);
    doc.setFontSize(9); doc.text("This is a non-binding estimate. Final pricing on visit.", 20, 270);
    doc.save(`Quote-${lead.name.replace(/\s+/g, "_")}.pdf`);
    apiFetch(`/leads/${id}/activities`, { method: "POST", body: JSON.stringify({ type: "QUOTE_SENT", note: "Quotation generated" }) }).then(refresh);
  };

  return (
    <Sheet open={true} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader><SheetTitle className="flex items-center justify-between"><span>{lead.name}</span><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button></SheetTitle></SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge>{lead.stage}</Badge>
            <Badge variant="outline">{lead.source}</Badge>
            {lead.assignedToName && <Badge variant="secondary">{lead.assignedToName}</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <div className="flex items-center gap-1 text-muted-foreground"><Phone className="h-3 w-3" />Phone</div><div>{lead.phone}</div>
            <div className="flex items-center gap-1 text-muted-foreground"><Mail className="h-3 w-3" />Email</div><div>{lead.email || "—"}</div>
            <div className="text-muted-foreground">Property</div><div>{lead.propertyName || "—"}</div>
            <div className="text-muted-foreground">Budget</div><div>{lead.budgetMin && lead.budgetMax ? `Rs. ${lead.budgetMin} – ${lead.budgetMax}` : "—"}</div>
            {lead.visitDate && <><div className="text-muted-foreground">Visit</div><div>{new Date(lead.visitDate).toLocaleString()}</div></>}
            {lead.followUpAt && <><div className="text-muted-foreground">Follow-up</div><div>{new Date(lead.followUpAt).toLocaleString()}</div></>}
          </div>

          <div className="flex gap-1">
            {STAGES.slice(0, 5).map((s, i) => <div key={s.key} className={`h-1.5 flex-1 rounded ${i <= stageIdx ? "bg-primary" : "bg-muted"}`} />)}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={() => setVisitOpen(true)}><Calendar className="h-3 w-3 mr-1" />Schedule Visit</Button>
            <Button variant="outline" size="sm" onClick={() => setOutcomeOpen(true)} disabled={!lead.visitDate}>Visit Done</Button>
            <Button variant="outline" size="sm" onClick={generateQuote}>Generate Quote</Button>
            <Button variant="outline" size="sm" onClick={() => setFollowOpen(true)}>Set Follow-up</Button>
            <Button variant="outline" size="sm" onClick={() => setLostOpen(true)}>Mark Lost</Button>
            <Button size="sm" onClick={() => setConvertOpen(true)} disabled={!["NEGOTIATING", "VISIT_DONE"].includes(lead.stage)}>Convert to Resident</Button>
          </div>

          <div>
            <h3 className="font-medium text-sm mb-2 flex items-center gap-2"><MessageSquare className="h-4 w-4" />Activity</h3>
            <div className="flex gap-2 mb-2">
              <Input placeholder="Add a note..." value={noteText} onChange={(e) => setNoteText(e.target.value)} />
              <Button size="sm" onClick={addNote}>Add</Button>
            </div>
            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {activities.map((a: any) => (
                <div key={a.id} className="text-xs border-l-2 border-primary pl-3 py-1">
                  <div className="font-medium">{a.type}</div>
                  {a.note && <div className="text-muted-foreground">{a.note}</div>}
                  <div className="text-muted-foreground text-[10px]">{new Date(a.createdAt).toLocaleString()}</div>
                </div>
              ))}
              {!activities.length && <p className="text-xs text-muted-foreground">No activity yet</p>}
            </div>
          </div>
        </div>

        {visitOpen && <ScheduleVisitDialog id={id} onClose={() => setVisitOpen(false)} onDone={refresh} />}
        {outcomeOpen && <VisitOutcomeDialog id={id} onClose={() => setOutcomeOpen(false)} onDone={refresh} />}
        {followOpen && <FollowUpDialog id={id} onClose={() => setFollowOpen(false)} onDone={refresh} />}
        {lostOpen && <MarkLostDialog id={id} onClose={() => setLostOpen(false)} onDone={refresh} />}
        {convertOpen && <ConvertDialog lead={lead} properties={properties} onClose={() => setConvertOpen(false)} onDone={() => { refresh(); onClose(); }} />}
      </SheetContent>
    </Sheet>
  );
}

function ScheduleVisitDialog({ id, onClose, onDone }: any) {
  const [dt, setDt] = React.useState("");
  const { toast } = useToast();
  return (
    <FormModal open={true} onOpenChange={(o) => !o && onClose()} title="Schedule Visit" onSave={async () => {
      if (!dt) return;
      try {
        await apiFetch(`/leads/${id}/schedule-visit`, { method: "POST", body: JSON.stringify({ visitDate: new Date(dt).toISOString() }) });
        toast({ title: "Visit scheduled — confirmation SMS queued" }); onClose(); onDone();
      } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    }}>
      <Label>Visit date &amp; time</Label><DateTimePicker value={dt} onChange={setDt} />
    </FormModal>
  );
}

function VisitOutcomeDialog({ id, onClose, onDone }: any) {
  const [outcome, setOutcome] = React.useState("YES");
  const [feedback, setFeedback] = React.useState("");
  const [lostReason, setLostReason] = React.useState("Other");
  const { toast } = useToast();
  return (
    <FormModal open={true} onOpenChange={(o) => !o && onClose()} title="Visit Outcome" onSave={async () => {
      try {
        await apiFetch(`/leads/${id}/visit-outcome`, { method: "POST", body: JSON.stringify({ outcome, feedback, lostReason: outcome === "NO" ? lostReason : undefined }) });
        toast({ title: "Outcome recorded" }); onClose(); onDone();
      } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    }}>
      <div className="space-y-3">
        <div><Label>Interested?</Label>
          <Select value={outcome} onValueChange={setOutcome}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["YES", "MAYBE", "NO"].map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent></Select>
        </div>
        <div><Label>Feedback</Label><Textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></div>
        {outcome === "NO" && <div><Label>Lost reason</Label>
          <Select value={lostReason} onValueChange={setLostReason}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{LOST_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent></Select>
        </div>}
      </div>
    </FormModal>
  );
}

function FollowUpDialog({ id, onClose, onDone }: any) {
  const [dt, setDt] = React.useState("");
  const [note, setNote] = React.useState("");
  const { toast } = useToast();
  return (
    <FormModal open={true} onOpenChange={(o) => !o && onClose()} title="Set Follow-up" onSave={async () => {
      if (!dt) return;
      try {
        await apiFetch(`/leads/${id}/follow-up`, { method: "POST", body: JSON.stringify({ followUpAt: new Date(dt).toISOString(), followUpNote: note }) });
        toast({ title: "Follow-up set" }); onClose(); onDone();
      } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    }}>
      <div className="space-y-3"><div><Label>When</Label><DateTimePicker value={dt} onChange={setDt} /></div><div><Label>Reminder note</Label><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div></div>
    </FormModal>
  );
}

function MarkLostDialog({ id, onClose, onDone }: any) {
  const [reason, setReason] = React.useState("Price");
  const { toast } = useToast();
  return (
    <FormModal open={true} onOpenChange={(o) => !o && onClose()} title="Mark Lead Lost" onSave={async () => {
      try {
        await apiFetch(`/leads/${id}/mark-lost`, { method: "POST", body: JSON.stringify({ lostReason: reason }) });
        toast({ title: "Lead marked lost" }); onClose(); onDone();
      } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    }}>
      <Label>Reason *</Label>
      <Select value={reason} onValueChange={setReason}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{LOST_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent></Select>
    </FormModal>
  );
}

function ConvertDialog({ lead, properties, onClose, onDone }: any) {
  const [propertyId, setPropertyId] = React.useState(lead.propertyId || properties[0]?.id || "");
  const [planType, setPlanType] = React.useState("MONTHLY");
  const [monthlyRent, setMonthlyRent] = React.useState(lead.budgetMax || 0);
  const [depositAmount, setDepositAmount] = React.useState(0);
  const [checkInDate, setCheckInDate] = React.useState("");
  const { toast } = useToast();
  return (
    <FormModal open={true} onOpenChange={(o) => !o && onClose()} title={`Convert ${lead.name} to Resident`} onSave={async () => {
      try {
        await apiFetch(`/leads/${lead.id}/convert`, { method: "POST", body: JSON.stringify({ propertyId, planType, monthlyRent, depositAmount, checkInDate: checkInDate || undefined }) });
        toast({ title: "Resident created and lead converted" }); onClose(); onDone();
      } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    }}>
      <div className="space-y-3">
        <div><Label>Property *</Label>
          <Select value={propertyId} onValueChange={setPropertyId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select>
        </div>
        <div><Label>Plan</Label>
          <Select value={planType} onValueChange={setPlanType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["MONTHLY", "QUARTERLY", "ANNUAL"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="grid grid-cols-2 gap-3"><div><Label>Monthly rent</Label><Input type="number" value={monthlyRent} onChange={(e) => setMonthlyRent(Number(e.target.value))} /></div><div><Label>Deposit</Label><Input type="number" value={depositAmount} onChange={(e) => setDepositAmount(Number(e.target.value))} /></div></div>
        <div><Label>Check-in date</Label><DatePicker value={checkInDate} onChange={setCheckInDate} /></div>
      </div>
    </FormModal>
  );
}
