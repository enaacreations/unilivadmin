import * as React from "react";
import {
  useGetCandidates,
  getGetCandidatesQueryKey,
  useCreateCandidate,
  useUpdateCandidate,
  useGetJobRequisitions,
  getGetJobRequisitionsQueryKey,
  useCreateJobRequisition,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import jsPDF from "jspdf";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { FormModal } from "@/components/ui/form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimePicker, ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Calendar, FileText, Briefcase } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STAGES = [
  { key: "APPLIED", label: "Applied" },
  { key: "SCREENED", label: "Screened" },
  { key: "INTERVIEW_1", label: "Interview 1" },
  { key: "INTERVIEW_2", label: "Interview 2" },
  { key: "OFFER", label: "Offer" },
  { key: "JOINED", label: "Joined" },
  { key: "REJECTED", label: "Rejected" },
];

const SOURCES = ["Referral", "LinkedIn", "Naukri", "Walk-in", "Other"];
const BGV_STATUSES = ["PENDING", "IN_PROGRESS", "CLEARED", "FLAGGED"];

const candidateSchema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().min(7, "Required"),
  email: z.string().email("Invalid email").or(z.literal("")).optional(),
  role: z.string().min(1, "Required"),
  source: z.string().min(1, "Required"),
  resumeUrl: z.string().optional(),
});

const reqSchema = z.object({
  role: z.string().min(1, "Required"),
  department: z.string().min(1, "Required"),
  headcount: z.coerce.number().min(1, "At least 1"),
  justification: z.string().optional(),
});

const interviewSchema = z.object({
  scheduledAt: z.string().min(1, "Required"),
  panel: z.string().optional(),
  notes: z.string().optional(),
});

const offerSchema = z.object({
  ctc: z.coerce.number().min(0),
  joiningDate: z.string().min(1, "Required"),
});

function daysSince(iso?: string | null) {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export default function Recruitment() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: candidatesRes, isLoading: candidatesLoading } = useGetCandidates(undefined, {
    query: { queryKey: getGetCandidatesQueryKey() },
  });
  const candidates = candidatesRes?.data || [];

  const { data: reqsRes, isLoading: reqsLoading } = useGetJobRequisitions(undefined, {
    query: { queryKey: getGetJobRequisitionsQueryKey() },
  });
  const requisitions = reqsRes?.data || [];

  const updateCandidate = useUpdateCandidate();
  const createCandidate = useCreateCandidate();
  const createReq = useCreateJobRequisition();

  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [activeCandidateId, setActiveCandidateId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [reqOpen, setReqOpen] = React.useState(false);

  const cForm = useForm<z.infer<typeof candidateSchema>>({
    resolver: zodResolver(candidateSchema),
    defaultValues: { name: "", phone: "", email: "", role: "", source: "", resumeUrl: "" },
  });
  const rForm = useForm<z.infer<typeof reqSchema>>({
    resolver: zodResolver(reqSchema),
    defaultValues: { role: "", department: "", headcount: 1, justification: "" },
  });

  React.useEffect(() => { if (addOpen) cForm.reset(); /* eslint-disable-next-line */ }, [addOpen]);
  React.useEffect(() => { if (reqOpen) rForm.reset(); /* eslint-disable-next-line */ }, [reqOpen]);

  const moveCandidate = async (id: string, stage: string) => {
    const c = candidates.find((x) => x.id === id);
    if (!c || c.stage === stage) return;
    try {
      await updateCandidate.mutateAsync({
        id,
        data: { name: c.name, email: c.email, phone: c.phone, stage } as any,
      });
      toast({ title: `Moved to ${STAGES.find((s) => s.key === stage)?.label || stage}` });
      qc.invalidateQueries({ queryKey: getGetCandidatesQueryKey() });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const onSubmitCandidate = cForm.handleSubmit(async (v) => {
    try {
      const body: any = {
        name: v.name, phone: v.phone, email: v.email || `${v.name.toLowerCase().replace(/\s+/g, ".")}@noemail.local`,
        source: v.source, stage: "APPLIED",
        notes: `Role: ${v.role}`,
      };
      if (v.resumeUrl) body.resumeUrl = v.resumeUrl;
      await createCandidate.mutateAsync({ data: body });
      toast({ title: "Candidate added" });
      qc.invalidateQueries({ queryKey: getGetCandidatesQueryKey() });
      setAddOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const onSubmitReq = rForm.handleSubmit(async (v) => {
    try {
      await createReq.mutateAsync({
        data: { role: v.role, department: v.department, headcount: Number(v.headcount), status: "OPEN" } as any,
      });
      toast({ title: "Requisition created" });
      qc.invalidateQueries({ queryKey: getGetJobRequisitionsQueryKey() });
      setReqOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const listColumns = [
    { accessorKey: "name", header: "Name", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "phone", header: "Phone" },
    { accessorKey: "source", header: "Source", cell: ({ row }: any) => row.original.source ? <Badge variant="outline" className="text-[10px] uppercase">{row.original.source}</Badge> : "—" },
    { accessorKey: "stage", header: "Stage", cell: ({ row }: any) => <StatusBadge status={row.original.stage} /> },
    { accessorKey: "createdAt", header: "Applied", cell: ({ row }: any) => new Date(row.original.createdAt).toLocaleDateString() },
    { accessorKey: "bgvStatus", header: "BGV", cell: ({ row }: any) => row.original.bgvStatus ? <Badge variant="secondary" className="text-[10px]">{row.original.bgvStatus}</Badge> : <span className="text-xs text-muted-foreground">—</span> },
  ];

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-120px)]">
      <PageHeader
        title="Recruitment"
        subtitle="Track candidates and job requisitions"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setAddOpen(true)} data-testid="button-add-candidate">
            <Plus className="w-4 h-4 mr-2" /> Add Candidate
          </Button>
        }
      />

      <Tabs defaultValue="pipeline" className="flex-1 flex flex-col">
        <TabsList className="bg-surface border w-fit">
          <TabsTrigger value="pipeline" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Pipeline</TabsTrigger>
          <TabsTrigger value="list" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">List</TabsTrigger>
          <TabsTrigger value="requisitions" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Job Requisitions</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="flex-1 mt-6 h-full min-h-0">
          {candidatesLoading ? (
            <div className="grid grid-cols-7 gap-3 h-full">
              {STAGES.map((s) => <Skeleton key={s.key} className="h-full w-full" />)}
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-4 h-full items-start">
              {STAGES.map((stage) => {
                const stageCandidates = candidates.filter((c) => c.stage === stage.key);
                return (
                  <div
                    key={stage.key}
                    className="min-w-[260px] w-[260px] bg-muted/10 border rounded-lg p-3 flex flex-col max-h-full"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggingId) moveCandidate(draggingId, stage.key);
                      setDraggingId(null);
                    }}
                  >
                    <div className="flex justify-between items-center mb-3 px-1">
                      <h3 className="font-display font-semibold text-sm text-primary tracking-tight">{stage.label}</h3>
                      <Badge variant="secondary" className="bg-card text-xs">{stageCandidates.length}</Badge>
                    </div>
                    <div className="space-y-2 overflow-y-auto pr-1 flex-1 pb-2">
                      {stageCandidates.map((c) => {
                        const role = (c.notes?.match(/Role:\s*(.+)/) || [])[1] || "—";
                        return (
                          <Card
                            key={c.id}
                            className="cursor-pointer hover:border-accent/50 transition-colors shadow-sm"
                            draggable
                            onDragStart={() => setDraggingId(c.id)}
                            onDragEnd={() => setDraggingId(null)}
                            onClick={() => setActiveCandidateId(c.id)}
                            data-testid={`card-candidate-${c.id}`}
                          >
                            <CardContent className="p-3">
                              <p className="font-medium text-sm text-primary">{c.name}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">{role}</p>
                              <div className="flex items-center justify-between mt-2">
                                {c.source ? <Badge variant="outline" className="text-[10px] uppercase">{c.source}</Badge> : <span />}
                                <span className="text-[10px] text-muted-foreground">{daysSince(c.createdAt)}d</span>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                      {stageCandidates.length === 0 && (
                        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg bg-surface/50">
                          Drop here
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="list" className="mt-6 flex-1 overflow-y-auto">
          <DataTable
            columns={listColumns as any}
            data={candidates}
            isLoading={candidatesLoading}
            searchKey="name"
            searchPlaceholder="Search candidates..."
            onRowClick={(row: any) => setActiveCandidateId(row.id)}
          />
        </TabsContent>

        <TabsContent value="requisitions" className="mt-6 flex-1 overflow-y-auto">
          <div className="flex justify-end mb-4">
            <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setReqOpen(true)} data-testid="button-create-requisition">
              <Plus className="w-4 h-4 mr-2" /> Create Requisition
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {reqsLoading ? (
              [1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)
            ) : requisitions.length === 0 ? (
              <div className="col-span-3 text-center py-12 text-muted-foreground border border-dashed rounded-lg bg-surface/50">
                <Briefcase className="w-10 h-10 mx-auto text-muted/30 mb-2" />
                No job requisitions found
              </div>
            ) : (
              requisitions.map((r) => (
                <Card key={r.id} className="shadow-sm">
                  <CardContent className="p-5">
                    <div className="flex justify-between items-start gap-4 mb-2">
                      <div>
                        <p className="font-display font-semibold text-base text-primary">{r.role}</p>
                        <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">{r.department}</p>
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="flex justify-between text-sm items-center pt-3 border-t mt-3">
                      <div>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Headcount</span>
                        <span className="font-medium">{r.headcount}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Candidates</span>
                        <span className="font-medium">{r.candidateCount}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Created</span>
                        <span className="font-medium text-xs">{new Date(r.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>

      <FormModal
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add Candidate"
        onSave={onSubmitCandidate}
        isSaving={createCandidate.isPending}
        saveLabel="Add Candidate"
      >
        <div className="space-y-4">
          <div>
            <Label>Name *</Label>
            <Input {...cForm.register("name")} data-testid="input-cand-name" />
            {cForm.formState.errors.name && <p className="text-xs text-destructive mt-1">{cForm.formState.errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Phone *</Label>
              <Input {...cForm.register("phone")} />
              {cForm.formState.errors.phone && <p className="text-xs text-destructive mt-1">{cForm.formState.errors.phone.message}</p>}
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" {...cForm.register("email")} />
              {cForm.formState.errors.email && <p className="text-xs text-destructive mt-1">{cForm.formState.errors.email.message}</p>}
            </div>
          </div>
          <div>
            <Label>Role *</Label>
            <Input {...cForm.register("role")} placeholder="e.g. Cook, Receptionist" />
            {cForm.formState.errors.role && <p className="text-xs text-destructive mt-1">{cForm.formState.errors.role.message}</p>}
          </div>
          <div>
            <Label>Source *</Label>
            <Select value={cForm.watch("source")} onValueChange={(v) => cForm.setValue("source", v)}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
              </SelectContent>
            </Select>
            {cForm.formState.errors.source && <p className="text-xs text-destructive mt-1">{cForm.formState.errors.source.message}</p>}
          </div>
          <div>
            <Label>Resume URL</Label>
            <Input {...cForm.register("resumeUrl")} placeholder="https://..." />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={reqOpen}
        onOpenChange={setReqOpen}
        title="Create Requisition"
        onSave={onSubmitReq}
        isSaving={createReq.isPending}
        saveLabel="Create Requisition"
      >
        <div className="space-y-4">
          <div>
            <Label>Role *</Label>
            <Input {...rForm.register("role")} />
            {rForm.formState.errors.role && <p className="text-xs text-destructive mt-1">{rForm.formState.errors.role.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Department *</Label>
              <Input {...rForm.register("department")} />
              {rForm.formState.errors.department && <p className="text-xs text-destructive mt-1">{rForm.formState.errors.department.message}</p>}
            </div>
            <div>
              <Label>Headcount *</Label>
              <Input type="number" min={1} {...rForm.register("headcount")} />
              {rForm.formState.errors.headcount && <p className="text-xs text-destructive mt-1">{rForm.formState.errors.headcount.message}</p>}
            </div>
          </div>
          <div>
            <Label>Justification</Label>
            <Textarea rows={3} {...rForm.register("justification")} />
          </div>
        </div>
      </FormModal>

      <CandidateSlideOver
        candidateId={activeCandidateId}
        onClose={() => setActiveCandidateId(null)}
      />
    </div>
  );
}

interface CandidateDetail {
  id: string;
  name: string;
  email: string;
  phone: string;
  stage: string;
  source?: string | null;
  resumeUrl?: string | null;
  bgvStatus?: string | null;
  notes?: string | null;
  interviews: Array<{ id: string; scheduledAt: string; panel?: string | null; notes?: string | null }>;
  offers: Array<{ id: string; ctc: number; joiningDate: string }>;
}

function CandidateSlideOver({ candidateId, onClose }: { candidateId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const enabled = !!candidateId;

  const { data: detailRes } = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => apiFetch<{ success: boolean; data: CandidateDetail }>(`/candidates/${candidateId}`),
    enabled,
  });
  const candidate = detailRes?.data;

  const updateCandidate = useUpdateCandidate();
  const [notes, setNotes] = React.useState("");
  const [bgvStatus, setBgvStatus] = React.useState("");
  const [interviewOpen, setInterviewOpen] = React.useState(false);
  const [offerOpen, setOfferOpen] = React.useState(false);

  React.useEffect(() => {
    if (candidate) {
      setNotes(candidate.notes || "");
      setBgvStatus(candidate.bgvStatus || "");
    }
  }, [candidate]);

  // debounced notes save
  const notesTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!candidate || notes === (candidate.notes || "")) return;
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(async () => {
      try {
        await updateCandidate.mutateAsync({
          id: candidate.id,
          data: { name: candidate.name, email: candidate.email, phone: candidate.phone, notes } as any,
        });
        qc.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      } catch {/* ignore */ }
    }, 800);
    return () => { if (notesTimer.current) clearTimeout(notesTimer.current); };
    // eslint-disable-next-line
  }, [notes]);

  const onBgvChange = async (v: string) => {
    if (!candidate) return;
    setBgvStatus(v);
    try {
      await updateCandidate.mutateAsync({
        id: candidate.id,
        data: { name: candidate.name, email: candidate.email, phone: candidate.phone, bgvStatus: v } as any,
      });
      toast({ title: `BGV: ${v}` });
      qc.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      qc.invalidateQueries({ queryKey: getGetCandidatesQueryKey() });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const iForm = useForm<z.infer<typeof interviewSchema>>({
    resolver: zodResolver(interviewSchema),
    defaultValues: { scheduledAt: "", panel: "", notes: "" },
  });
  const oForm = useForm<z.infer<typeof offerSchema>>({
    resolver: zodResolver(offerSchema),
    defaultValues: { ctc: 0, joiningDate: "" },
  });

  React.useEffect(() => { if (interviewOpen) iForm.reset(); /* eslint-disable-next-line */ }, [interviewOpen]);
  React.useEffect(() => { if (offerOpen) oForm.reset(); /* eslint-disable-next-line */ }, [offerOpen]);

  const submitInterview = iForm.handleSubmit(async (v) => {
    if (!candidate) return;
    try {
      await apiFetch(`/candidates/${candidate.id}/interviews`, {
        method: "POST",
        body: JSON.stringify({ scheduledAt: v.scheduledAt, panel: v.panel, notes: v.notes }),
      });
      toast({ title: "Interview scheduled" });
      qc.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      setInterviewOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const submitOffer = oForm.handleSubmit(async (v) => {
    if (!candidate) return;
    try {
      await apiFetch(`/candidates/${candidate.id}/offers`, {
        method: "POST",
        body: JSON.stringify({ ctc: Number(v.ctc), joiningDate: v.joiningDate }),
      });
      toast({ title: "Offer generated" });
      qc.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      qc.invalidateQueries({ queryKey: getGetCandidatesQueryKey() });

      // Generate PDF
      const role = (candidate.notes?.match(/Role:\s*(.+)/) || [])[1] || "—";
      const doc = new jsPDF();
      doc.setFontSize(20);
      doc.text("OFFER LETTER", 105, 25, { align: "center" });
      doc.setFontSize(11);
      let y = 50;
      [
        `Date: ${new Date().toLocaleDateString()}`,
        ``,
        `Dear ${candidate.name},`,
        ``,
        `We are pleased to offer you the position of ${role} at UNILIV.`,
        ``,
        `Annual CTC: Rs ${Number(v.ctc).toLocaleString("en-IN")}`,
        `Joining Date: ${new Date(v.joiningDate).toLocaleDateString()}`,
        ``,
        `Please confirm your acceptance by replying to this offer.`,
      ].forEach((line) => { doc.text(line, 20, y); y += 8; });
      doc.setFontSize(10);
      doc.text("Welcome to UNILIV", 105, 270, { align: "center" });
      doc.save(`offer-${candidate.name.replace(/\s+/g, "-")}.pdf`);

      setOfferOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  if (!candidateId) return null;
  const role = candidate?.notes ? (candidate.notes.match(/Role:\s*(.+)/) || [])[1] || "—" : "—";

  return (
    <>
      <FormModal
        open={enabled}
        onOpenChange={(o) => { if (!o) onClose(); }}
        title={candidate?.name || "Candidate"}
        showFooter={false}
      >
        {!candidate ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="text-sm text-muted-foreground">{role}</div>
              <StatusBadge status={candidate.stage} />
            </div>

            <div className="border rounded-lg p-4 bg-card">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Contact</p>
              <div className="space-y-1 text-sm">
                <div><span className="text-muted-foreground">Phone:</span> {candidate.phone}</div>
                <div><span className="text-muted-foreground">Email:</span> {candidate.email}</div>
                {candidate.source && <div><span className="text-muted-foreground">Source:</span> <Badge variant="outline" className="text-[10px] uppercase">{candidate.source}</Badge></div>}
                {candidate.resumeUrl && (
                  <div className="pt-1">
                    <a className="text-accent hover:underline text-sm inline-flex items-center gap-1" href={candidate.resumeUrl} target="_blank" rel="noreferrer">
                      <FileText className="w-3.5 h-3.5" /> View Resume
                    </a>
                  </div>
                )}
              </div>
            </div>

            <div className="border rounded-lg p-4 bg-card">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">BGV Status</p>
              <Select value={bgvStatus} onValueChange={onBgvChange}>
                <SelectTrigger><SelectValue placeholder="Set status" /></SelectTrigger>
                <SelectContent>
                  {BGV_STATUSES.map((s) => (<SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>

            <div className="border rounded-lg p-4 bg-card">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Notes</p>
              <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <p className="text-[10px] text-muted-foreground mt-1">Auto-saves</p>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setInterviewOpen(true)} data-testid="button-schedule-interview">
                <Calendar className="w-4 h-4 mr-2" /> Schedule Interview
              </Button>
              <Button className="flex-1 bg-accent hover:bg-accent/90 text-white" onClick={() => setOfferOpen(true)} data-testid="button-generate-offer">
                <FileText className="w-4 h-4 mr-2" /> Generate Offer
              </Button>
            </div>

            {candidate.interviews.length > 0 && (
              <div className="border rounded-lg p-4 bg-card">
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Interviews</p>
                <div className="space-y-2">
                  {candidate.interviews.map((iv) => (
                    <div key={iv.id} className="text-sm border-l-2 border-accent pl-3 py-1">
                      <div className="font-medium">{new Date(iv.scheduledAt).toLocaleString()}</div>
                      {iv.panel && <div className="text-xs text-muted-foreground">Panel: {iv.panel}</div>}
                      {iv.notes && <div className="text-xs text-muted-foreground mt-1">{iv.notes}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {candidate.offers.length > 0 && (
              <div className="border rounded-lg p-4 bg-card">
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Offers</p>
                <div className="space-y-2">
                  {candidate.offers.map((o) => (
                    <div key={o.id} className="text-sm flex justify-between border rounded p-2">
                      <span>Joining {new Date(o.joiningDate).toLocaleDateString()}</span>
                      <span className="font-medium">Rs {Number(o.ctc).toLocaleString("en-IN")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </FormModal>

      <FormModal
        open={interviewOpen}
        onOpenChange={setInterviewOpen}
        title="Schedule Interview"
        onSave={submitInterview}
        saveLabel="Schedule"
      >
        <div className="space-y-4">
          <div>
            <Label>Scheduled At *</Label>
            <Controller control={iForm.control} name="scheduledAt" render={({ field }) => (
              <DateTimePicker value={field.value ?? ""} onChange={field.onChange} />
            )} />
            {iForm.formState.errors.scheduledAt && <p className="text-xs text-destructive mt-1">{iForm.formState.errors.scheduledAt.message}</p>}
          </div>
          <div>
            <Label>Panel</Label>
            <Input {...iForm.register("panel")} placeholder="Comma-separated names" />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={3} {...iForm.register("notes")} />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={offerOpen}
        onOpenChange={setOfferOpen}
        title="Generate Offer"
        onSave={submitOffer}
        saveLabel="Generate Offer"
      >
        <div className="space-y-4">
          <div>
            <Label>CTC (Annual) *</Label>
            <Input type="number" {...oForm.register("ctc")} />
            {oForm.formState.errors.ctc && <p className="text-xs text-destructive mt-1">{oForm.formState.errors.ctc.message}</p>}
          </div>
          <div>
            <Label>Joining Date *</Label>
            <ControlledDatePicker control={oForm.control} name="joiningDate" />
            {oForm.formState.errors.joiningDate && <p className="text-xs text-destructive mt-1">{oForm.formState.errors.joiningDate.message}</p>}
          </div>
        </div>
      </FormModal>
    </>
  );
}
