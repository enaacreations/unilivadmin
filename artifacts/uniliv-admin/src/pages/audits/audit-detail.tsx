import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle, ArrowLeft, ArrowRight, Bell, BellRing, ClipboardList,
  FileBarChart, FileText, Loader2, Lock, MapPin, MessageSquare, Paperclip,
  Pause, Play, Settings2, Share2, ShieldAlert, TrendingUp, UserPlus, X, XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { locateOnce } from "@/hooks/use-geolocation";
import { apiFetch } from "@/lib/api-fetch";
import { fileToDownscaledDataUrl } from "@/lib/image";
import { usePermissions } from "@/lib/use-permissions";
import {
  AUDIT_STATE_BADGE, COMPLETED_AUDIT_STATES, RUNNABLE_STATES,
  fmtDateTime, fmtDuration, scoreColorClass, titleCase,
  type ApiError, type ApiList, type ApiOne, type AuditCommentRow,
  type AuditDetailRow, type AuditEventRow, type AuditState, type RunPayload,
} from "./lib";
import { TypeBadge } from "./shared";
import { cn } from "@/lib/utils";

const EVENT_ICONS: Record<string, LucideIcon> = {
  STATE_CHANGE: ArrowRight,
  ASSIGNMENT: UserPlus,
  SCORE_FREEZE: Lock,
  CONFIG_CHANGE: Settings2,
  GRANT_CHANGE: Settings2,
  NOTIFY: Bell,
  REMINDER: Bell,
  ESCALATION: TrendingUp,
  SHARE: Share2,
  DENIED_ATTEMPT: ShieldAlert,
  COMMENT: MessageSquare,
};

function runnerLabel(state: AuditState): string {
  switch (state) {
    case "SCHEDULED": return "Start audit";
    case "PAUSED": return "Resume audit";
    case "REJECTED": return "Start rework";
    default: return "Open runner";
  }
}

function gps(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium">{children}</div>
    </div>
  );
}

/** Audit detail (FRD-EXE-01) — header, meta, Details/Comments/Activity, state-legal actions. */
export default function AuditDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { me, can } = usePermissions();

  const [tab, setTab] = React.useState("details");
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [reassignTo, setReassignTo] = React.useState("");
  const [starting, setStarting] = React.useState(false);

  const auditQuery = useQuery({
    queryKey: ["/audits", id],
    queryFn: () => apiFetch<ApiOne<AuditDetailRow>>(`/audits/${id}`),
  });
  const audit = auditQuery.data?.data;

  const commentsQuery = useQuery({
    queryKey: ["/audits", id, "comments"],
    queryFn: () => apiFetch<ApiList<AuditCommentRow>>(`/audits/${id}/comments`),
    enabled: tab === "comments",
  });
  const eventsQuery = useQuery({
    queryKey: ["/audits", id, "events"],
    queryFn: () => apiFetch<ApiList<AuditEventRow>>(`/audits/${id}/events`),
    enabled: tab === "activity",
  });
  const usersQuery = useQuery({
    queryKey: ["/users", "reassign-picker"],
    queryFn: () =>
      apiFetch<ApiList<{ id: string; name: string; role: string }>>("/users?limit=100"),
    enabled: reassignOpen,
  });

  // Completed audits: pull the run payload to build the prototype scorecard
  // (per-category scores + flagged findings) — server pre-computes per-response
  // earned/max, so we just aggregate.
  const scored = !!audit && COMPLETED_AUDIT_STATES.includes(audit.state);
  const runQuery = useQuery({
    queryKey: ["/audits", id, "run"],
    queryFn: () => apiFetch<ApiOne<RunPayload>>(`/audits/${id}/run`),
    enabled: scored,
  });
  const scorecard = React.useMemo(() => {
    const run = runQuery.data?.data;
    if (!run) return null;
    const secOfQ = new Map<string, string>();
    for (const s of run.sections) for (const q of s.questions) secOfQ.set(q.id, s.id);
    const agg = new Map<string, { earned: number; max: number }>();
    for (const r of run.responses) {
      const sid = secOfQ.get(r.questionId);
      if (!sid) continue;
      const e = agg.get(sid) ?? { earned: 0, max: 0 };
      e.earned += Number(r.earnedScore ?? 0);
      e.max += Number(r.maxScore ?? 0);
      agg.set(sid, e);
    }
    const cats = run.sections
      .map((s) => {
        const a = agg.get(s.id);
        return { id: s.id, name: s.title, pct: a && a.max > 0 ? Math.round((a.earned / a.max) * 100) : null };
      })
      .filter((c): c is { id: string; name: string; pct: number } => c.pct != null);
    const qPrompt = new Map<string, string>();
    for (const s of run.sections) for (const q of s.questions) qPrompt.set(q.id, q.prompt);
    const flagged = run.ncs.map((n) => ({
      id: n.id, ncNo: n.ncNo, severity: n.severity, desc: n.description,
      prompt: n.questionId ? qPrompt.get(n.questionId) ?? null : null,
    }));
    const proof = run.evidence.find((e) => e.kind === "SUBMISSION_PROOF") ?? null;
    const passLine = run.version.passThresholdPct != null ? Number(run.version.passThresholdPct) : 75;
    return { cats, flagged, proof, passLine };
  }, [runQuery.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/audits", id] });
    qc.invalidateQueries({ queryKey: ["/audits"] });
  };

  const startMut = useMutation({
    mutationFn: async () => {
      const geo = await locateOnce();
      return apiFetch(`/audits/${id}/start`, {
        method: "POST",
        body: JSON.stringify(geo ? { geo: { lat: geo.lat, lng: geo.lng } } : {}),
      });
    },
    onSuccess: () => {
      invalidate();
      navigate(`/audits/${id}/run`);
    },
    onError: (e: Error) => toast({ title: e.message || "Could not start", variant: "destructive" }),
    onSettled: () => setStarting(false),
  });

  const actionMut = useMutation({
    mutationFn: ({ action, body }: { action: "pause" | "resume" | "cancel"; body?: unknown }) =>
      apiFetch(`/audits/${id}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    onSuccess: (_r, vars) => {
      toast({ title: `Audit ${vars.action === "cancel" ? "cancelled" : `${vars.action}d`}` });
      setCancelOpen(false);
      invalidate();
    },
    onError: (e: Error) => {
      setCancelOpen(false);
      toast({ title: e.message || "Action failed", variant: "destructive" });
    },
  });

  const nudgeMut = useMutation({
    mutationFn: () => apiFetch(`/audits/${id}/nudge`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => toast({ title: "Nudge sent to the assignee" }),
    onError: (e: ApiError) =>
      toast({
        title: e.status === 429 ? "Rate limited" : "Nudge failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const reassignMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audits/${id}/reassign`, {
        method: "POST",
        body: JSON.stringify({ assigneeId: reassignTo }),
      }),
    onSuccess: () => {
      toast({ title: "Audit reassigned" });
      setReassignOpen(false);
      setReassignTo("");
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Reassign failed", variant: "destructive" }),
  });

  const [commentBody, setCommentBody] = React.useState("");
  const [attachments, setAttachments] = React.useState<{ dataUrl: string; originalName: string; isImage: boolean }[]>([]);
  const [attaching, setAttaching] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = Math.max(0, 5 - attachments.length);
    const picked = Array.from(files).slice(0, room);
    if (picked.length < files.length) {
      toast({ title: "Up to 5 attachments per comment", variant: "destructive" });
    }
    setAttaching(true);
    try {
      const next = await Promise.all(
        picked.map(async (file) => {
          const isImage = file.type.startsWith("image/");
          const dataUrl = isImage
            ? await fileToDownscaledDataUrl(file)
            : await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error("Could not read file"));
                reader.readAsDataURL(file);
              });
          return { dataUrl, originalName: file.name, isImage };
        }),
      );
      setAttachments((a) => [...a, ...next].slice(0, 5));
    } catch (e) {
      toast({ title: (e as Error).message || "Could not read file", variant: "destructive" });
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const commentMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audits/${id}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: commentBody.trim(),
          ...(attachments.length
            ? { attachments: attachments.map((a) => ({ dataUrl: a.dataUrl, originalName: a.originalName })) }
            : {}),
        }),
      }),
    onSuccess: () => {
      setCommentBody("");
      setAttachments([]);
      qc.invalidateQueries({ queryKey: ["/audits", id, "comments"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Comment failed", variant: "destructive" }),
  });

  if (auditQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (auditQuery.isError || !audit) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm">{(auditQuery.error as Error)?.message || "Audit not found."}</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/audits/register")}>
          Back to register
        </Button>
      </div>
    );
  }

  const isAssignee = !!me?.id && me.id === audit.assigneeId;
  const completed = COMPLETED_AUDIT_STATES.includes(audit.state) || audit.state === "CANCELLED";
  const pending = audit.state === "DRAFT" || audit.state === "SCHEDULED";
  const runnable = isAssignee && RUNNABLE_STATES.includes(audit.state);
  const isAdmin = can("AUDIT_SCHEDULES", "edit");
  const pct = audit.scorePct != null ? Number(audit.scorePct) : null;

  const footerActions: React.ReactNode[] = [];
  if (isAssignee && (audit.state === "SCHEDULED" || audit.state === "REJECTED")) {
    footerActions.push(
      <Button
        key="start"
        className="min-h-11"
        disabled={starting || startMut.isPending}
        onClick={() => { setStarting(true); startMut.mutate(); }}
      >
        {startMut.isPending || starting
          ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          : <Play className="mr-2 h-4 w-4" />}
        {audit.state === "REJECTED" ? "Start rework" : "Start"}
      </Button>,
    );
  }
  if (isAssignee && audit.state === "IN_PROGRESS") {
    footerActions.push(
      <Button key="open" className="min-h-11" onClick={() => navigate(`/audits/${id}/run`)}>
        <ClipboardList className="mr-2 h-4 w-4" /> Open runner
      </Button>,
      <Button
        key="pause"
        variant="outline"
        className="min-h-11"
        disabled={actionMut.isPending}
        onClick={() => actionMut.mutate({ action: "pause" })}
      >
        <Pause className="mr-2 h-4 w-4" /> Pause
      </Button>,
    );
  }
  if (isAssignee && audit.state === "PAUSED") {
    footerActions.push(
      <Button
        key="resume"
        className="min-h-11"
        disabled={actionMut.isPending}
        onClick={() => actionMut.mutate({ action: "resume" })}
      >
        <Play className="mr-2 h-4 w-4" /> Resume
      </Button>,
    );
  }
  if (!completed) {
    footerActions.push(
      <Button
        key="nudge"
        variant="outline"
        className="min-h-11"
        disabled={nudgeMut.isPending}
        onClick={() => nudgeMut.mutate()}
      >
        <BellRing className="mr-2 h-4 w-4" /> Nudge
      </Button>,
    );
    if (isAdmin) {
      footerActions.push(
        <Button
          key="reassign"
          variant="outline"
          className="min-h-11"
          onClick={() => setReassignOpen(true)}
        >
          <UserPlus className="mr-2 h-4 w-4" /> Reassign
        </Button>,
      );
    }
  }
  if (pending && can("AUDIT_EXECUTION", "delete")) {
    footerActions.push(
      <Button
        key="cancel"
        variant="outline"
        className="min-h-11 text-destructive hover:text-destructive"
        onClick={() => setCancelOpen(true)}
      >
        <XCircle className="mr-2 h-4 w-4" /> Cancel
      </Button>,
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-24">
      {/* Header */}
      <div className="space-y-2">
        <Link
          href="/audits/register"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" /> Register
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-bold tracking-tight text-primary">{audit.ticketNo}</h1>
          <Badge variant={AUDIT_STATE_BADGE[audit.state] ?? "outline"}>{titleCase(audit.state)}</Badge>
          <TypeBadge type={audit.auditType} />
          {audit.isOverdue && <Badge variant="destructive">Overdue</Badge>}
        </div>
        <p className="text-muted-foreground">{audit.title}</p>
      </div>

      {/* Scorecard — prototype clean score view for completed audits */}
      {completed && audit.state !== "CANCELLED" && scorecard && (
        <div className="space-y-4">
          {/* Score hero */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-5 p-5">
              <div className="relative h-24 w-24 shrink-0">
                <svg width="96" height="96" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" strokeWidth="9" stroke="currentColor" className="text-muted-foreground/20" />
                  <circle
                    cx="48" cy="48" r="40" fill="none" strokeWidth="9" strokeLinecap="round" stroke="currentColor"
                    className={audit.result === "FAIL" ? "text-destructive" : audit.result === "PASS" ? "text-success" : "text-accent"}
                    strokeDasharray={`${((pct ?? 0) / 100) * 251.3} 251.3`}
                    transform="rotate(-90 48 48)"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={cn("font-display text-2xl font-extrabold", scoreColorClass(pct))}>{pct != null ? Math.round(pct) : "—"}</span>
                  <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">/100</span>
                </div>
              </div>
              <div className="min-w-[200px] flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {audit.result && <Badge variant={audit.result === "PASS" ? "success" : "destructive"}>{audit.result}</Badge>}
                  {audit.scoreBand && <Badge variant="outline">{audit.scoreBand}</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {audit.submittedAt ? `Submitted ${fmtDateTime(audit.submittedAt)}` : "Completed"}
                  {audit.approvedAt ? ` · approved ${fmtDateTime(audit.approvedAt)}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => navigate(`/audits/${id}/run`)}
                  className="text-sm font-semibold text-accent-strong hover:underline"
                >
                  View all answers →
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Category breakdown */}
          {scorecard.cats.length > 0 && (
            <Card>
              <CardContent className="p-5">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">Category breakdown</div>
                <div className="space-y-3">
                  {scorecard.cats.map((c) => (
                    <div key={c.id}>
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className="flex-1 text-sm font-medium">{c.name}</span>
                        <span className={cn("font-mono text-xs font-bold tabular-nums", scoreColorClass(c.pct))}>{c.pct}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", c.pct >= scorecard.passLine ? "bg-success" : "bg-destructive")} style={{ width: `${c.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Verification + Flagged */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardContent className="space-y-2 p-5 text-sm">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-success">Verification</div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-success">✓</span>
                  <span className="flex-1">GPS captured at submit</span>
                  {gps(audit.submitGeoLat, audit.submitGeoLng) && (
                    <span className="font-mono text-xs text-muted-foreground">{gps(audit.submitGeoLat, audit.submitGeoLng)}</span>
                  )}
                </div>
                {scorecard.proof && (
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-success">✓</span>
                    <span className="flex-1">Live photo at submit</span>
                    {scorecard.proof.isLiveCapture && <span className="text-xs text-muted-foreground">taken live</span>}
                  </div>
                )}
                {audit.durationSeconds != null && (
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-success">✓</span>
                    <span className="flex-1">Completed in {fmtDuration(audit.durationSeconds)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
            {scorecard.flagged.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-warning">Flagged · {scorecard.flagged.length}</div>
                  <div className="space-y-2">
                    {scorecard.flagged.map((f) => (
                      <div key={f.id} className="flex gap-2 border-b border-dashed border-border pb-2 last:border-0 last:pb-0">
                        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", f.severity === "CRITICAL" ? "bg-destructive" : f.severity === "MAJOR" ? "bg-warning" : "bg-muted-foreground")} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{f.prompt ?? f.ncNo}</div>
                          <div className="text-xs text-muted-foreground">{f.ncNo} · {titleCase(f.severity)}{f.desc ? ` — ${f.desc}` : ""}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Meta grid */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <MetaItem label="Target">
            <span className="flex items-start gap-1">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                {audit.propertyId ? (
                  <Link
                    href={`/properties/${audit.propertyId}`}
                    className="hover:text-primary hover:underline"
                    title="Open property profile"
                  >
                    {audit.propertyName ?? "View property"}
                  </Link>
                ) : (
                  audit.propertyName ?? "—"
                )}
                {audit.roomNumber ? ` · Room ${audit.roomNumber}` : ""}
                {audit.propertyCity && (
                  <span className="block text-xs font-normal text-muted-foreground">{audit.propertyCity}</span>
                )}
              </span>
            </span>
          </MetaItem>
          <MetaItem label="Assignee">
            {audit.assigneeName ?? "—"}
            {audit.assigneeRole && (
              <span className="block text-xs font-normal text-muted-foreground">
                {titleCase(audit.assigneeRole)}
              </span>
            )}
          </MetaItem>
          <MetaItem label="Scheduled">{fmtDateTime(audit.scheduledFor)}</MetaItem>
          <MetaItem label="Due">
            <span className={audit.isOverdue ? "text-red-600" : undefined}>
              {fmtDateTime(audit.dueAt)}
            </span>
          </MetaItem>
          {pct != null && (
            <MetaItem label="Score">
              <span className={`tabular-nums ${scoreColorClass(pct)}`}>{pct.toFixed(1)}%</span>
              {audit.scoreBand && (
                <span className="block text-xs font-normal text-muted-foreground">{audit.scoreBand}</span>
              )}
            </MetaItem>
          )}
          {audit.result && (
            <MetaItem label="Result">
              <Badge variant={audit.result === "PASS" ? "success" : "destructive"}>{audit.result}</Badge>
            </MetaItem>
          )}
          {audit.durationSeconds != null && (
            <MetaItem label="Duration">{fmtDuration(audit.durationSeconds)}</MetaItem>
          )}
          {audit.startedAt && (
            <MetaItem label="Started">
              {fmtDateTime(audit.startedAt)}
              {gps(audit.startGeoLat, audit.startGeoLng) && (
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {gps(audit.startGeoLat, audit.startGeoLng)}
                </span>
              )}
            </MetaItem>
          )}
          {audit.submittedAt && (
            <MetaItem label="Submitted">
              {fmtDateTime(audit.submittedAt)}
              {gps(audit.submitGeoLat, audit.submitGeoLng) && (
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {gps(audit.submitGeoLat, audit.submitGeoLng)}
                </span>
              )}
            </MetaItem>
          )}
          {audit.state === "CANCELLED" && audit.cancelReason && (
            <MetaItem label="Cancel reason">{audit.cancelReason}</MetaItem>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-4 pt-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Template</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">
                  {audit.templateVersion?.templateName ?? "—"}{" "}
                  {audit.templateVersion && (
                    <span className="font-mono text-xs text-muted-foreground">
                      v{audit.templateVersion.versionNo}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {audit.reviewRequired ? "Review required after submission" : "No review required (auto-approve)"}
                </p>
              </div>
              {runnable && (
                <Button className="min-h-11" onClick={() => navigate(`/audits/${id}/run`)}>
                  <ClipboardList className="mr-2 h-4 w-4" /> {runnerLabel(audit.state)}
                </Button>
              )}
            </CardContent>
          </Card>

          {COMPLETED_AUDIT_STATES.includes(audit.state) && (
            <Card>
              <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
                <FileBarChart className="h-5 w-5 shrink-0" />
                Report available under Reports once generated.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="comments" className="space-y-4 pt-2">
          {commentsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="space-y-3">
              {(commentsQuery.data?.data ?? []).length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">No comments yet.</p>
              )}
              {(commentsQuery.data?.data ?? []).map((c) => (
                <div key={c.id} className="rounded-lg border bg-card p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.authorName ?? "Unknown"}</span>
                    {c.authorRole && <span>{titleCase(c.authorRole)}</span>}
                    <span>· {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
                  </div>
                  {c.body && <p className="whitespace-pre-wrap text-sm">{c.body}</p>}
                  {c.attachments && c.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {c.attachments.map((att, i) => {
                        const isImage = att.mime.startsWith("image/");
                        return (
                          <a
                            key={i}
                            href={att.url}
                            target="_blank"
                            rel="noreferrer"
                            className="group flex items-center gap-1.5 overflow-hidden rounded-md border bg-muted/40 text-xs hover:bg-muted"
                            title={att.originalName ?? undefined}
                          >
                            {isImage ? (
                              <img
                                src={att.thumbUrl ?? att.url}
                                alt={att.originalName ?? "attachment"}
                                className="h-12 w-12 object-cover"
                              />
                            ) : (
                              <span className="flex h-12 w-12 items-center justify-center">
                                <FileText className="h-5 w-5 text-muted-foreground" />
                              </span>
                            )}
                            <span className="max-w-[120px] truncate pr-2 text-muted-foreground group-hover:text-foreground">
                              {att.originalName ?? (isImage ? "Image" : "Document")}
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <Textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              className="text-base"
            />
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 overflow-hidden rounded-md border bg-muted/40 pr-1 text-xs"
                  >
                    {a.isImage ? (
                      <img src={a.dataUrl} alt={a.originalName} className="h-10 w-10 object-cover" />
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}
                    <span className="max-w-[110px] truncate">{a.originalName}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-muted"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      aria-label="Remove attachment"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => void onPickFiles(e.target.files)}
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={attaching || attachments.length >= 5}
                onClick={() => fileInputRef.current?.click()}
              >
                {attaching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Paperclip className="mr-2 h-4 w-4" />}
                Attach{attachments.length > 0 ? ` (${attachments.length}/5)` : ""}
              </Button>
              <Button
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={(!commentBody.trim() && attachments.length === 0) || commentMut.isPending}
                onClick={() => commentMut.mutate()}
              >
                {commentMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Post comment
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="activity" className="pt-2">
          {eventsQuery.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (eventsQuery.data?.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ol className="relative space-y-5 border-l pl-6">
              {(eventsQuery.data?.data ?? []).map((e) => {
                const Icon = EVENT_ICONS[e.kind] ?? Bell;
                return (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border bg-card">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                    </span>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{e.actorName ?? "System"}</span>
                      {e.actorRole && (
                        <span className="text-xs text-muted-foreground">{titleCase(e.actorRole)}</span>
                      )}
                      <span className="text-xs text-muted-foreground">{titleCase(e.kind)}</span>
                    </div>
                    {(e.fromState || e.toState) && (
                      <div className="mt-1 flex items-center gap-1.5">
                        {e.fromState && <Badge variant="outline">{titleCase(e.fromState)}</Badge>}
                        {e.fromState && e.toState && (
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        {e.toState && (
                          <Badge variant={AUDIT_STATE_BADGE[e.toState as AuditState] ?? "outline"}>
                            {titleCase(e.toState)}
                          </Badge>
                        )}
                      </div>
                    )}
                    {e.reason && <p className="mt-1 text-sm text-muted-foreground">{e.reason}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </TabsContent>
      </Tabs>

      {/* Sticky action dock — offset past the sidebar on desktop (layout pattern). */}
      {footerActions.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)] md:left-64">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-6">
            {footerActions}
          </div>
        </div>
      )}

      {/* Cancel dialog */}
      <FormModal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel audit"
        onSave={() => actionMut.mutate({ action: "cancel", body: { reason: cancelReason.trim() || "Cancelled" } })}
        isSaving={actionMut.isPending}
        saveLabel="Cancel audit"
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Only pending audits can be cancelled. This cannot be undone.
          </p>
          <Label>Reason</Label>
          <Textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Why is this audit being cancelled?"
            rows={3}
          />
        </div>
      </FormModal>

      {/* Reassign dialog (admin) */}
      <FormModal
        open={reassignOpen}
        onOpenChange={(o) => { setReassignOpen(o); if (!o) setReassignTo(""); }}
        title="Reassign audit"
        onSave={() => { if (reassignTo) reassignMut.mutate(); }}
        isSaving={reassignMut.isPending}
        saveLabel="Reassign"
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Both the current and the new auditor are notified. Allowed until submission.
          </p>
          <Label>New assignee</Label>
          <Select value={reassignTo} onValueChange={setReassignTo}>
            <SelectTrigger>
              <SelectValue placeholder={usersQuery.isLoading ? "Loading users…" : "Pick a user"} />
            </SelectTrigger>
            <SelectContent>
              {(usersQuery.data?.data ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name} · {titleCase(u.role)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FormModal>
    </div>
  );
}
