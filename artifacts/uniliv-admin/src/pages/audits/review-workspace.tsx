import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle, AlertTriangle, ArrowLeft, BadgeCheck, Camera, Loader2,
  MapPin, Plus, RotateCcw, ThumbsDown, ThumbsUp, Undo2,
} from "lucide-react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  AUDIT_STATE_BADGE, NC_SEVERITIES, NON_SCORED_TYPES, answerLabel, fmtDateTime,
  fmtDuration, scoreColorClass, titleCase,
  type ApiList, type ApiOne, type NcSeverity, type ReviewWorkspaceData,
  type RunQuestion, type RunResponse, type WorkspaceEvidence,
} from "./lib";
import { NcStateBadge, SeverityBadge, TypeBadge } from "./shared";
import { cn } from "@/lib/utils";

function gps(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** One read-only answered question row. */
function ResponseRow({
  question, response, ws, onOpenImage,
}: {
  question: RunQuestion;
  response: RunResponse | undefined;
  ws: ReviewWorkspaceData;
  onOpenImage: (evidenceId: string) => void;
}) {
  if (question.type === "INSTRUCTION") return null;
  const label = response ? answerLabel(question, response.answerJson, ws.scaleSnapshot) : null;
  const isNa = response?.isNa === true;
  const earned = response?.earnedScore != null ? Number(response.earnedScore) : null;
  const max = response?.maxScore != null ? Number(response.maxScore) : null;
  const scorable = !NON_SCORED_TYPES.has(question.type) && question.weight > 0;
  const evidence = (response
    ? ws.evidence.filter((e) => e.kind === "RESPONSE" && e.responseId === response.id)
    : []);
  const signatureUrl =
    question.type === "SIGNATURE" && response
      ? String((response.answerJson as Record<string, unknown> | null)?.["dataUrl"] ?? "") || null
      : null;

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{question.prompt}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {scorable && (
            <Badge variant="outline" className="tabular-nums" title="Weight">w{question.weight}</Badge>
          )}
          {question.adHoc && <Badge variant="secondary">ad-hoc</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {isNa ? (
          <Badge variant="outline">N/A — excluded</Badge>
        ) : label ? (
          <Badge variant="secondary">{label}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not answered</span>
        )}
        {earned != null && max != null && max > 0 && (
          <span className={`text-xs tabular-nums ${scoreColorClass((earned / max) * 100)}`}>
            {earned.toFixed(1)} / {max.toFixed(1)} pts
          </span>
        )}
      </div>
      {signatureUrl && (
        <div className="inline-block rounded-md border bg-white p-1.5">
          <img src={signatureUrl} alt="Signature" className="max-h-16" />
        </div>
      )}
      {response?.notes && (
        <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-sm text-muted-foreground">
          {response.notes}
        </p>
      )}
      {evidence.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {evidence.map((e) => (
            <button key={e.id} type="button" onClick={() => onOpenImage(e.id)}>
              <img
                src={e.thumbUrl ?? e.url ?? undefined}
                alt={e.originalName ?? "Evidence"}
                className="h-14 w-14 rounded-md border object-cover hover:opacity-90"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineRow({ dot, label, when }: { dot: string; label: string; when: string | null }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", dot)} />
      <span className="flex-1 text-[12px] font-semibold text-foreground/80">{label}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{when ? fmtDateTime(when) : "—"}</span>
    </div>
  );
}

/** Review workspace (FRD-REV-01/02/03/06) — read-only evidence pack + verdict dock. */
export default function ReviewWorkspace() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { role, can } = usePermissions();

  const wsQuery = useQuery({
    queryKey: ["/audit/reviews", id, "workspace"],
    queryFn: () => apiFetch<ApiOne<ReviewWorkspaceData>>(`/audit/reviews/${id}/workspace`),
  });
  const ws = wsQuery.data?.data;

  const [decisionRemark, setDecisionRemark] = React.useState("");
  const [findingOpen, setFindingOpen] = React.useState(false);
  const [findingSeverity, setFindingSeverity] = React.useState<NcSeverity>("MINOR");
  const [findingDescription, setFindingDescription] = React.useState("");
  const [findingOwner, setFindingOwner] = React.useState("");
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  const usersQuery = useQuery({
    queryKey: ["/users", "finding-owner-picker"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string; role: string }>>("/users?limit=100"),
    enabled: findingOpen,
  });

  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/audit/reviews"] });
    qc.invalidateQueries({ queryKey: ["/audits"] });
    qc.invalidateQueries({ queryKey: ["/audit/ncs"] });
  }, [qc]);

  const leaveWithToast = (title: string) => {
    invalidate();
    navigate("/audits/review");
    toast({ title });
  };

  const claimMut = useMutation({
    mutationFn: () => apiFetch(`/audit/reviews/${id}/claim`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => { toast({ title: "Review started" }); invalidate(); },
    onError: (e: Error) => toast({ title: e.message || "Claim failed", variant: "destructive" }),
  });
  const approveMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/reviews/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(decisionRemark.trim() ? { comments: decisionRemark.trim() } : {}),
      }),
    onSuccess: () => leaveWithToast(`Audit ${ws?.audit.ticketNo ?? ""} approved`),
    onError: (e: Error) => toast({ title: e.message || "Approve failed", variant: "destructive" }),
  });
  const rejectMut = useMutation({
    mutationFn: (comment: string) =>
      apiFetch(`/audit/reviews/${id}/reject`, { method: "POST", body: JSON.stringify({ comment }) }),
    onSuccess: () => leaveWithToast(`Audit ${ws?.audit.ticketNo ?? ""} rejected — returned for rework`),
    onError: (e: Error) => toast({ title: e.message || "Reject failed", variant: "destructive" }),
  });
  const reopenMut = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/audit/reviews/${id}/reopen`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => leaveWithToast(`Audit ${ws?.audit.ticketNo ?? ""} reopened`),
    onError: (e: Error) => toast({ title: e.message || "Reopen failed", variant: "destructive" }),
  });
  const findingMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<{ ncNo: string }>>(`/audit/reviews/${id}/findings`, {
        method: "POST",
        body: JSON.stringify({
          severity: findingSeverity,
          description: findingDescription.trim(),
          ...(findingOwner ? { ownerId: findingOwner } : {}),
        }),
      }),
    onSuccess: (res) => {
      toast({ title: `Finding ${res.data.ncNo} raised` });
      setFindingOpen(false);
      qc.invalidateQueries({ queryKey: ["/audit/reviews", id, "workspace"] });
      qc.invalidateQueries({ queryKey: ["/audit/ncs"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Could not raise the finding", variant: "destructive" }),
  });

  /* — Derived — */
  const images = React.useMemo(() => {
    const list: WorkspaceEvidence[] = (ws?.evidence ?? []).filter(
      (e) => e.mime.startsWith("image/") && (e.url || e.thumbUrl),
    );
    return list;
  }, [ws?.evidence]);
  const openImage = (evidenceId: string) => {
    const idx = images.findIndex((e) => e.id === evidenceId);
    if (idx >= 0) setLightboxIndex(idx);
  };

  if (wsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (wsQuery.isError || !ws) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm">{(wsQuery.error as Error)?.message || "Could not load the workspace."}</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/audits/review")}>
          Back to queue
        </Button>
      </div>
    );
  }

  const audit = ws.audit;
  const pct = audit.scorePct != null ? Number(audit.scorePct) : null;
  const threshold = ws.version?.passThresholdPct != null ? Number(ws.version.passThresholdPct) : null;
  const responseByQ = new Map(ws.responses.map((r) => [r.questionId, r]));
  const sectionScoreById = new Map(ws.sectionScores.map((s) => [s.sectionId, s]));
  const canReview = can("AUDIT_REVIEW", "edit");
  const canReopen = audit.state === "CLOSED" && (role === "SUPER_ADMIN" || role === "OPS_EXCELLENCE");
  const canAddFinding =
    canReview && ["SUBMITTED", "UNDER_REVIEW", "APPROVED"].includes(audit.state);
  const proof = ws.submissionProof;

  return (
    <div className="mx-auto max-w-5xl animate-fade-up space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/audits/review" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-border text-muted-foreground hover:text-primary">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <TypeBadge type={audit.auditType} />
        <div className="min-w-[220px] flex-1">
          <h1 className="font-display text-xl font-bold tracking-[-0.012em]">{audit.title}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {audit.ticketNo} · {ws.target.propertyName ?? "—"}{ws.target.roomNumber ? ` · Room ${ws.target.roomNumber}` : ""}
            {ws.template ? ` · ${ws.template.name}${ws.version ? ` v${ws.version.versionNo}` : ""}` : ""}
          </p>
        </div>
        <Badge variant="warning">{titleCase(audit.state)} · locked for review</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px] lg:items-start">
        {/* Left — score + answers */}
        <div className="min-w-0 space-y-3">

      {/* Score summary — ring + band + category breakdown */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-5 p-5">
          <div className="relative h-[84px] w-[84px] shrink-0">
            <svg width="84" height="84" viewBox="0 0 84 84">
              <circle cx="42" cy="42" r="35" fill="none" strokeWidth="8" stroke="currentColor" className="text-muted-foreground/20" />
              <circle cx="42" cy="42" r="35" fill="none" strokeWidth="8" strokeLinecap="round" stroke="currentColor"
                className={audit.result === "FAIL" ? "text-destructive" : audit.result === "PASS" ? "text-success" : "text-accent"}
                strokeDasharray={`${((pct ?? 0) / 100) * 2 * Math.PI * 35} ${2 * Math.PI * 35}`}
                transform="rotate(-90 42 42)" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={cn("font-display text-2xl font-extrabold", scoreColorClass(pct))}>{pct != null ? Math.round(pct) : "—"}</span>
              <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">/100</span>
            </div>
          </div>
          <div className="min-w-[220px] flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {audit.result && <Badge variant={audit.result === "PASS" ? "success" : "destructive"}>{audit.result}</Badge>}
              {audit.scoreBand && <Badge variant="outline">{audit.scoreBand}</Badge>}
              {threshold != null && <span className="text-xs text-muted-foreground">pass {threshold.toFixed(0)}%{ws.version?.criticalFailGate ? " · critical-fail gate" : ""}</span>}
            </div>
            {ws.sectionScores.filter((s) => s.pct != null).map((s) => (
              <div key={s.sectionId} className="flex items-center gap-2.5">
                <span className="w-[150px] truncate text-xs font-medium text-foreground/80">{s.title}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", (s.pct ?? 0) >= (threshold ?? 75) ? "bg-success" : "bg-destructive")} style={{ width: `${s.pct}%` }} />
                </div>
                <span className={cn("w-8 text-right font-mono text-[11px] font-bold", scoreColorClass(s.pct))}>{Math.round(s.pct ?? 0)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* (b) Sections — read-only responses */}
      <Accordion type="multiple" className="space-y-3" defaultValue={ws.sections[0] ? [ws.sections[0].id] : []}>
        {ws.sections.map((section) => {
          const score = sectionScoreById.get(section.id);
          return (
            <AccordionItem
              key={section.id}
              value={section.id}
              className="rounded-lg border bg-card px-4 last:border-b"
            >
              <AccordionTrigger className="hover:no-underline">
                <span className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                  <span className="truncate font-medium">{section.title}</span>
                  <span className="flex-1" />
                  {score && score.possible > 0 && score.pct != null && (
                    <span className={`text-xs font-semibold tabular-nums ${scoreColorClass(score.pct)}`}>
                      {score.earned.toFixed(1)}/{score.possible.toFixed(1)} · {score.pct.toFixed(0)}%
                    </span>
                  )}
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2.5">
                  {section.questions.map((q) => (
                    <ResponseRow
                      key={q.id}
                      question={q}
                      response={responseByQ.get(q.id)}
                      ws={ws}
                      onOpenImage={openImage}
                    />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {/* Findings */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> Findings
              <Badge variant="secondary" className="tabular-nums">{ws.ncs.length}</Badge>
            </span>
            {canAddFinding && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFindingSeverity("MINOR");
                  setFindingDescription("");
                  setFindingOwner("");
                  setFindingOpen(true);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add finding
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {ws.ncs.length === 0 && (
            <p className="text-sm text-muted-foreground">No non-conformances on this audit.</p>
          )}
          {ws.ncs.map((nc) => (
            <Link
              key={nc.id}
              href={`/audits/ncs/${nc.id}`}
              className="flex items-center justify-between gap-3 rounded-md border p-2.5 hover:border-primary"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{nc.ncNo}</span>{" "}
                  {nc.description}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5">
                <SeverityBadge severity={nc.severity} />
                <NcStateBadge state={nc.state} />
              </span>
            </Link>
          ))}
        </CardContent>
      </Card>

        </div>

        {/* Right — verification, auditor, timeline, decision */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-2 p-4 text-sm">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-success">Verification</div>
              {proof && (proof.thumbUrl || proof.url) ? (
                <button type="button" onClick={() => openImage(proof.id)} className="block w-full">
                  <img src={proof.thumbUrl ?? proof.url ?? undefined} alt="Live photo at submit" className="h-24 w-full rounded-[10px] border object-cover hover:opacity-90" />
                </button>
              ) : (
                <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-[10px] bg-muted text-muted-foreground">
                  <Camera className="h-5 w-5" /><span className="text-[10px] font-bold uppercase tracking-wide">No live photo</span>
                </div>
              )}
              <div className="flex items-center gap-2"><span className="font-bold text-success">✓</span><span className="flex-1">GPS captured at submit</span></div>
              {gps(audit.submitGeoLat, audit.submitGeoLng) && <div className="pl-5 font-mono text-[10.5px] text-muted-foreground">{gps(audit.submitGeoLat, audit.submitGeoLng)}</div>}
              {audit.durationSeconds != null && <div className="flex items-center gap-2"><span className="font-bold text-success">✓</span><span className="flex-1">Completed in {fmtDuration(audit.durationSeconds)}{audit.reopenCount > 0 ? ` · reopened ×${audit.reopenCount}` : ""}</span></div>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Auditor</div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted font-display text-xs font-bold">{(ws.assignee?.name ?? "—").split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold">{ws.assignee?.name ?? "—"}</div>
                  <div className="text-[11.5px] text-muted-foreground">{ws.assignee?.role ? titleCase(ws.assignee.role) : ""}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Timeline</div>
              <div className="space-y-1">
                <TimelineRow dot="bg-muted-foreground" label="Started" when={audit.startedAt} />
                <TimelineRow dot="bg-info" label="Submitted" when={audit.submittedAt} />
                {ws.reviews.map((r) => (
                  <TimelineRow key={r.id} dot={r.verdict === "APPROVED" ? "bg-success" : "bg-destructive"} label={`${titleCase(r.verdict)} · ${r.reviewerName ?? "—"}`} when={r.createdAt} />
                ))}
              </div>
              {ws.reviews.some((r) => r.comments) && (
                <div className="mt-2 space-y-1 border-t border-dashed border-border pt-2">
                  {ws.reviews.filter((r) => r.comments).map((r) => (
                    <p key={r.id} className="text-[11.5px] text-muted-foreground">&ldquo;{r.comments}&rdquo;</p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {((canReview && ["SUBMITTED", "UNDER_REVIEW"].includes(audit.state)) || canReopen) && (
            <Card className="border-foreground/40">
              <CardContent className="p-4">
                <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">Your decision</div>
                {canReview && audit.state === "SUBMITTED" ? (
                  <Button className="w-full" disabled={claimMut.isPending} onClick={() => claimMut.mutate()}>
                    {claimMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BadgeCheck className="mr-2 h-4 w-4" />}Start review
                  </Button>
                ) : (
                  <>
                    <Textarea value={decisionRemark} onChange={(e) => setDecisionRemark(e.target.value)} placeholder="Remarks — required to reject or reopen…" rows={3} className="text-sm" />
                    {canReview && audit.state === "UNDER_REVIEW" && (
                      <>
                        <Button className="mt-2.5 w-full bg-success text-white hover:bg-success/90" disabled={approveMut.isPending} onClick={() => approveMut.mutate()}>
                          {approveMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ThumbsUp className="mr-2 h-4 w-4" />}Approve
                        </Button>
                        <Button variant="outline" className="mt-2 w-full border-destructive text-destructive hover:text-destructive" disabled={rejectMut.isPending || !decisionRemark.trim()} onClick={() => rejectMut.mutate(decisionRemark.trim())}>
                          <ThumbsDown className="mr-2 h-4 w-4" /> Reject with remarks
                        </Button>
                      </>
                    )}
                    {canReopen && (
                      <Button variant="ghost" className="mt-2 w-full text-muted-foreground" disabled={reopenMut.isPending || !decisionRemark.trim()} onClick={() => reopenMut.mutate(decisionRemark.trim())}>
                        <Undo2 className="mr-2 h-4 w-4" /> Reopen for corrections
                      </Button>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Finding dialog */}
      <FormModal
        open={findingOpen}
        onOpenChange={setFindingOpen}
        title="Add finding"
        onSave={() => { if (findingDescription.trim()) findingMut.mutate(); }}
        isSaving={findingMut.isPending}
        saveLabel="Raise finding"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Raise a non-conformance the auditor missed (FRD-REV-03). It defaults
            to the property's Unit Lead unless you pick an owner.
          </p>
          <div className="space-y-2">
            <Label>Severity</Label>
            <Select value={findingSeverity} onValueChange={(v) => setFindingSeverity(v as NcSeverity)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {NC_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Description *</Label>
            <Textarea
              value={findingDescription}
              onChange={(e) => setFindingDescription(e.target.value)}
              placeholder="What is non-conforming?"
              rows={3}
              className="text-base"
            />
          </div>
          <div className="space-y-2">
            <Label>Owner (optional)</Label>
            <Select value={findingOwner} onValueChange={setFindingOwner}>
              <SelectTrigger>
                <SelectValue placeholder={usersQuery.isLoading ? "Loading users…" : "Default (auditee of target)"} />
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
        </div>
      </FormModal>

      <ImageLightbox
        images={images.map((e) => e.url ?? e.thumbUrl!)}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        alt="Audit evidence"
      />
    </div>
  );
}
