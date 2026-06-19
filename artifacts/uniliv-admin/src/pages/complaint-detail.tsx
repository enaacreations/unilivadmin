import * as React from "react";
import { useParams, Link } from "wouter";
import { useGetComplaint, getGetComplaintQueryKey, useUpdateComplaint, useGetUsers, useCreateEscalation } from "@workspace/api-client-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, User, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";

function SLATimer({ deadline, slaHours }: { deadline?: string | null, slaHours: number }) {
  const [now, setNow] = React.useState(new Date().getTime());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date().getTime()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!deadline) return null;
  const d = new Date(deadline).getTime();
  const diff = d - now;
  if (diff <= 0) return <div className="text-2xl font-mono font-bold text-destructive">BREACHED</div>;
  const hours = Math.floor(diff / (1000 * 60 * 60)).toString().padStart(2, '0');
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
  const secs = Math.floor((diff % (1000 * 60)) / 1000).toString().padStart(2, '0');
  const color = (diff / (slaHours * 60 * 60 * 1000)) > 0.5 ? "text-success" : "text-warning";
  return <div className={`text-3xl font-mono font-bold ${color}`}>{hours}:{mins}:{secs}</div>;
}

export default function ComplaintDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: res, isLoading, isError } = useGetComplaint(id, { query: { queryKey: getGetComplaintQueryKey(id), enabled: !!id } });
  const complaint = res?.data;

  const mutUpdate = useUpdateComplaint();
  const mutEscalate = useCreateEscalation();
  const { data: usersRes } = useGetUsers();

  const { data: timelineRes } = useQuery({
    queryKey: ["complaint-timeline", id],
    queryFn: () => apiFetch(`/complaints/${id}/timeline`),
    enabled: !!id
  });
  const timeline = (timelineRes as any)?.data?.events || [];

  const [resNote, setResNote] = React.useState("");
  const [escReason, setEscReason] = React.useState("");
  const [escTo, setEscTo] = React.useState("");

  if (isLoading) return <div className="p-8 text-center">Loading...</div>;
  if (isError || !complaint) return (
    <div className="p-8 text-center space-y-3">
      <p className="text-muted-foreground">Complaint not found or failed to load.</p>
      <Link href="/complaints">
        <Button variant="outline"><ChevronLeft className="w-4 h-4 mr-2" /> Back to Complaints</Button>
      </Link>
    </div>
  );

  const handleUpdateStatus = async (status: string, extra = {}) => {
    try {
      await mutUpdate.mutateAsync({ id, data: { status, ...extra } });
      toast({ title: `Status updated to ${status}` });
      qc.invalidateQueries({ queryKey: getGetComplaintQueryKey(id) });
      qc.invalidateQueries({ queryKey: ["complaint-timeline", id] });
    } catch(e:any) { toast({ title: "Update failed", variant: "destructive" }); }
  };

  const handleEscalate = async () => {
    if(!escTo || !escReason) { toast({title: "Select user and reason", variant: "destructive"}); return; }
    try {
      await mutEscalate.mutateAsync({ data: { complaintId: id, escalatedTo: escTo, reason: escReason, level: 1 } });
      toast({ title: "Complaint Escalated" });
      qc.invalidateQueries({ queryKey: getGetComplaintQueryKey(id) });
      qc.invalidateQueries({ queryKey: ["complaint-timeline", id] });
      setEscReason(""); setEscTo("");
    } catch(e:any) { toast({ title: "Escalation failed", variant: "destructive" }); }
  };

  const handleReassign = async (userId: string) => {
    try {
      await mutUpdate.mutateAsync({ id, data: { assignedTo: userId } });
      toast({ title: "Reassigned" });
      qc.invalidateQueries({ queryKey: getGetComplaintQueryKey(id) });
    } catch(e:any) { toast({ title: "Reassign failed", variant: "destructive" }); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/complaints">
          <Button variant="ghost" size="icon"><ChevronLeft className="w-5 h-5" /></Button>
        </Link>
        <div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-muted-foreground">{complaint.ticketNo}</span>
            <StatusBadge status={complaint.status} />
            <StatusBadge status={complaint.priority} />
          </div>
          <h1 className="text-2xl font-display font-bold mt-1">{complaint.title}</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Details</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-muted-foreground block mb-1">Property</span><span className="font-medium">{complaint.propertyName || "—"}</span></div>
                <div><span className="text-muted-foreground block mb-1">Resident</span><span className="font-medium">{complaint.residentName || "—"}</span></div>
                <div><span className="text-muted-foreground block mb-1">Category</span><Badge variant="outline">{complaint.category}</Badge></div>
                <div><span className="text-muted-foreground block mb-1">Created</span><span>{new Date(complaint.createdAt).toLocaleString()}</span></div>
              </div>
              <div>
                <span className="text-muted-foreground block mb-1 text-sm">Description</span>
                <p className="text-sm whitespace-pre-wrap bg-surface p-3 rounded-md">{complaint.description}</p>
              </div>
            </CardContent>
          </Card>

          {complaint.status !== "RESOLVED" && complaint.status !== "CLOSED" && (
            <Card className="border-accent/20 shadow-sm">
              <CardHeader className="bg-accent/5 pb-3">
                <CardTitle className="text-sm font-medium flex items-center"><CheckCircle2 className="w-4 h-4 mr-2 text-accent" /> Resolution Panel</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => handleUpdateStatus("IN_PROGRESS")} disabled={complaint.status === "IN_PROGRESS"}>Mark In Progress</Button>
                  <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => handleUpdateStatus("CLOSED")}>Close Ticket</Button>
                </div>
                <div className="space-y-2">
                  <Textarea placeholder="Resolution note..." value={resNote} onChange={e => setResNote(e.target.value)} rows={3} />
                  <div className="flex justify-end">
                    <Button onClick={() => handleUpdateStatus("RESOLVED", { resolutionNote: resNote })} disabled={!resNote}>Resolve Issue</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {complaint.status !== "RESOLVED" && complaint.status !== "CLOSED" && (
            <Card className="border-destructive/20">
              <CardHeader className="bg-destructive/5 pb-3">
                <CardTitle className="text-sm font-medium flex items-center text-destructive"><AlertTriangle className="w-4 h-4 mr-2" /> Escalation</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-3">
                <Select value={escTo} onValueChange={setEscTo}>
                  <SelectTrigger><SelectValue placeholder="Escalate to..." /></SelectTrigger>
                  <SelectContent>
                    {usersRes?.data?.map(u => <SelectItem key={u.id} value={u.id}>{u.name} ({u.role})</SelectItem>)}
                  </SelectContent>
                </Select>
                <Textarea placeholder="Reason for escalation..." value={escReason} onChange={e => setEscReason(e.target.value)} rows={2} />
                <div className="flex justify-end">
                  <Button variant="destructive" onClick={handleEscalate}>Escalate</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {complaint.status === "RESOLVED" && complaint.rating && (
            <Card className="bg-success/5 border-success/20">
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-1">Resident Feedback</p>
                <div className="flex items-center gap-1 mb-2 text-warning">
                  {Array.from({length: 5}).map((_, i) => <span key={i}>{i < complaint.rating! ? "★" : "☆"}</span>)}
                </div>
                <p className="text-sm italic">"Resolved nicely."</p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-4 space-y-6">
          {complaint.status !== "RESOLVED" && complaint.status !== "CLOSED" && (
            <Card className="text-center py-6 border-2 border-dashed">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Time Remaining</p>
              <SLATimer deadline={complaint.slaDeadline} slaHours={complaint.slaHours} />
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Assignment</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><User className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="font-medium text-sm">{usersRes?.data?.find(u => u.id === complaint.assignedTo)?.name || "Unassigned"}</p>
                </div>
              </div>
              <Select value={complaint.assignedTo || ""} onValueChange={handleReassign}>
                <SelectTrigger><SelectValue placeholder="Reassign..." /></SelectTrigger>
                <SelectContent>
                  {usersRes?.data?.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center"><Clock className="w-4 h-4 mr-2" /> Timeline</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {timeline.map((ev: any) => (
                <div key={ev.id} className="flex gap-3 text-sm">
                  <div className="w-2 h-2 rounded-full bg-accent mt-1.5 shrink-0" />
                  <div>
                    <p className="font-medium">{ev.type}</p>
                    <p className="text-muted-foreground text-xs">{new Date(ev.createdAt).toLocaleString()}</p>
                  </div>
                </div>
              ))}
              {timeline.length === 0 && <p className="text-xs text-muted-foreground">No events recorded.</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
