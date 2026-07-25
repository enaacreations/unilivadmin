import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle, ArrowLeft, Camera, Check, Loader2,
  Pencil, ThumbsDown, ThumbsUp, Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  NON_SCORED_TYPES, answerLabel, fmtDateTime, fmtDuration,
  scoreColorClass, titleCase,
  type ApiOne, type AuditType,
  type ReviewWorkspaceData, type RunQuestion, type RunResponse, type WorkspaceEvidence,
} from "./lib";
import { cn } from "@/lib/utils";

/** Square type chip in the header (mirrors the review-queue list). */
const TYPE_CHIP: Record<AuditType, string> = {
  UL: "bg-accent/10 text-accent-strong",
  CM: "bg-info-soft text-info",
  CX: "bg-muted text-muted-foreground",
};

/** "12.9128° N, 77.6413° E" — signed lat/lng → hemisphere-tagged display. */
function gpsFmt(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null) return null;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

type Tone = "pass" | "warn" | "fail" | "na" | "neutral" | "unanswered";

/** How an answer reads at a glance — drives the left chip + row tint.
 *  Tone is driven by the earned multiplier (always present on a scored
 *  response), so pass/fail colour survives answer shapes `answerLabel` can't
 *  name — e.g. ratings stored as a raw `{ score }` rather than an `optionId`. */
function answerTone(
  question: RunQuestion,
  response: RunResponse | undefined,
  ws: ReviewWorkspaceData,
): { tone: Tone; label: string } {
  if (!response) return { tone: "unanswered", label: "—" };
  if (response.isNa) return { tone: "na", label: "N/A" };
  const scorable = !NON_SCORED_TYPES.has(question.type) && question.weight > 0;
  const m = response.multiplierPct != null ? Number(response.multiplierPct) : null;
  const named = answerLabel(question, response.answerJson, ws.scaleSnapshot);
  if (scorable && m != null && Number.isFinite(m)) {
    const tone: Tone = m >= 75 ? "pass" : m >= 50 ? "warn" : "fail";
    return { tone, label: named ?? `${Math.round(m)}%` };
  }
  if (named == null) return { tone: "unanswered", label: "—" };
  return { tone: "neutral", label: named };
}

const CHIP_CLASS: Record<Tone, string> = {
  pass: "bg-success/15 text-success",
  warn: "bg-amber-500/15 text-amber-600",
  fail: "bg-destructive/12 text-destructive",
  na: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-foreground/70",
  unanswered: "border border-dashed border-border text-muted-foreground",
};
const ROW_TINT: Record<Tone, string> = {
  pass: "",
  warn: "bg-amber-500/[0.05]",
  fail: "bg-destructive/[0.05]",
  na: "",
  neutral: "",
  unanswered: "",
};

/** Strip a file extension for a compact evidence chip label ("IMG_2041.jpg" → "IMG_2041"). */
function evidenceLabel(e: WorkspaceEvidence): string {
  const name = e.originalName?.trim();
  if (!name) return "Photo";
  return name.replace(/\.[a-z0-9]+$/i, "");
}

/** One read-only answered question row — chip · prompt · note · evidence · weight. */
function ResponseRow({
  question, response, ws, onOpenImage,
}: {
  question: RunQuestion;
  response: RunResponse | undefined;
  ws: ReviewWorkspaceData;
  onOpenImage: (evidenceId: string) => void;
}) {
  if (question.type === "INSTRUCTION") return null;
  const { tone, label } = answerTone(question, response, ws);
  const scorable = !NON_SCORED_TYPES.has(question.type) && question.weight > 0;
  const evidence = response
    ? ws.evidence.filter((e) => e.kind === "RESPONSE" && e.responseId === response.id)
    : [];
  const signatureUrl =
    question.type === "SIGNATURE" && response
      ? String((response.answerJson as Record<string, unknown> | null)?.["dataUrl"] ?? "") || null
      : null;

  return (
    <div className={cn("flex items-start gap-3 px-4 py-3", ROW_TINT[tone])}>
      <span
        className={cn(
          "mt-px inline-flex min-w-[44px] shrink-0 justify-center rounded-[7px] px-2 py-1 text-[11px] font-bold leading-none tabular-nums",
          CHIP_CLASS[tone],
        )}
      >
        {label}
      </span>

      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[13.5px] font-semibold leading-snug">
          {question.prompt}
          {question.mandatory && <span className="text-destructive"> *</span>}
          {question.adHoc && <Badge variant="secondary" className="ml-1.5 align-middle">ad-hoc</Badge>}
        </p>
        {response?.notes && (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-amber-600">
            <Pencil className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0">{response.notes}</span>
          </p>
        )}
        {signatureUrl && (
          <div className="inline-block rounded-md border bg-white p-1.5">
            <img src={signatureUrl} alt="Signature" className="max-h-16" />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {evidence.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpenImage(e.id)}
            className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-muted/40 px-2 py-1 font-mono text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
            title="View photo"
          >
            <Camera className="h-3 w-3" />
            <span className="max-w-[76px] truncate">{evidenceLabel(e)}</span>
          </button>
        ))}
        {scorable && (
          <span className="w-7 text-right font-mono text-[10.5px] text-muted-foreground" title="Weight">
            w{question.weight}
          </span>
        )}
      </div>
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
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/audit/reviews"] });
    qc.invalidateQueries({ queryKey: ["/audits"] });
  }, [qc]);

  const leaveWithToast = (title: string) => {
    invalidate();
    navigate("/audits/review");
    toast({ title });
  };

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

  const questionCount = React.useMemo(
    () => (ws?.sections ?? []).reduce(
      (n, s) => n + s.questions.filter((q) => q.type !== "INSTRUCTION").length, 0),
    [ws?.sections],
  );

  if (wsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
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
  const canReopen =
    ["APPROVED", "CLOSED"].includes(audit.state) &&
    (role === "SUPER_ADMIN" || role === "OPS_EXCELLENCE");
  const proof = ws.submissionProof;

  const waiting =
    audit.submittedAt && ["SUBMITTED", "UNDER_REVIEW"].includes(audit.state)
      ? `waiting ${formatDistanceToNow(new Date(audit.submittedAt))}`
      : null;
  const headTitle = ws.target.propertyName ? `${ws.target.propertyName} — ${audit.title}` : audit.title;
  const passPill =
    audit.result === "FAIL"
      ? { text: threshold != null ? `Fail · below pass line ${Math.round(threshold)}` : "Fail", cls: "bg-destructive/12 text-destructive" }
      : audit.result === "PASS"
        ? { text: threshold != null ? `Pass · above pass line ${Math.round(threshold)}` : "Pass", cls: "bg-success-soft text-success" }
        : { text: "Awaiting score", cls: "bg-muted text-muted-foreground" };
  const ringColor = audit.result === "FAIL" ? "text-destructive" : audit.result === "PASS" ? "text-success" : "text-accent";

  return (
    <div className="mx-auto max-w-6xl animate-fade-up space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/audits/review" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-border text-muted-foreground hover:text-primary">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] font-mono text-[11px] font-bold", TYPE_CHIP[audit.auditType])}>
          {audit.auditType}
        </span>
        <div className="min-w-[220px] flex-1">
          <h1 className="font-display text-xl font-bold leading-tight tracking-[-0.012em]">{headTitle}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {audit.ticketNo} · {ws.assignee?.name ?? "—"}
            {ws.target.roomNumber ? ` · Room ${ws.target.roomNumber}` : ""}
            {waiting ? ` · ${waiting}` : ""}
          </p>
        </div>
        <Badge variant="warning">{titleCase(audit.state)} · locked for review</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        {/* Left — score hero + answers */}
        <div className="min-w-0 space-y-3">

          {/* Score hero — ring + pass-line pill + at-a-glance meta + category bars */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-5 p-5">
              <div className="relative h-[104px] w-[104px] shrink-0">
                <svg width="104" height="104" viewBox="0 0 104 104">
                  <circle cx="52" cy="52" r="45" fill="none" strokeWidth="9" stroke="currentColor" className="text-muted-foreground/15" />
                  <circle cx="52" cy="52" r="45" fill="none" strokeWidth="9" strokeLinecap="round" stroke="currentColor"
                    className={ringColor}
                    strokeDasharray={`${((pct ?? 0) / 100) * 2 * Math.PI * 45} ${2 * Math.PI * 45}`}
                    transform="rotate(-90 52 52)" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={cn("font-display text-[32px] font-extrabold leading-none", scoreColorClass(pct))}>{pct != null ? Math.round(pct) : "—"}</span>
                  <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">/100</span>
                </div>
              </div>
              <div className="min-w-[240px] flex-1 space-y-3">
                <div>
                  <span className={cn("inline-flex rounded-full px-3 py-1 text-[12px] font-bold", passPill.cls)}>{passPill.text}</span>
                  <p className="mt-1.5 text-[12px] text-muted-foreground">
                    {questionCount} question{questionCount === 1 ? "" : "s"} audited
                    {" · "}{images.length} photo{images.length === 1 ? "" : "s"} attached
                    {" · full history retained"}
                  </p>
                </div>
                <div className="space-y-2">
                  {ws.sectionScores.filter((s) => s.pct != null).map((s) => (
                    <div key={s.sectionId} className="flex items-center gap-2.5">
                      <span className="w-[150px] truncate text-xs font-medium text-foreground/80">{s.title}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", (s.pct ?? 0) >= (threshold ?? 75) ? "bg-success" : "bg-destructive")} style={{ width: `${s.pct}%` }} />
                      </div>
                      <span className={cn("w-9 text-right font-mono text-[11px] font-bold", scoreColorClass(s.pct))}>{Math.round(s.pct ?? 0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Sections — fully expanded read-only responses */}
          {ws.sections.map((section) => {
            const score = sectionScoreById.get(section.id);
            const rows = section.questions.filter((q) => q.type !== "INSTRUCTION");
            if (rows.length === 0) return null;
            return (
              <div key={section.id} className="overflow-hidden rounded-[14px] border bg-card">
                <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
                  <span className="truncate text-[12.5px] font-bold uppercase tracking-[0.07em] text-accent-strong">{section.title}</span>
                  {score && score.possible > 0 && score.pct != null && (
                    <span className={cn("shrink-0 font-mono text-[12px] font-bold tabular-nums", scoreColorClass(score.pct))}>{Math.round(score.pct)}%</span>
                  )}
                </div>
                <div className="divide-y divide-border/70">
                  {rows.map((q) => (
                    <ResponseRow
                      key={q.id}
                      question={q}
                      response={responseByQ.get(q.id)}
                      ws={ws}
                      onOpenImage={openImage}
                    />
                  ))}
                </div>
              </div>
            );
          })}

        </div>

        {/* Right — verification, auditor, timeline, decision */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-2.5 p-4 text-sm">
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-success">Verification</div>
              {proof && (proof.thumbUrl || proof.url) ? (
                <button type="button" onClick={() => openImage(proof.id)} className="block w-full">
                  <img src={proof.thumbUrl ?? proof.url ?? undefined} alt="Live photo at submit" className="h-28 w-full rounded-[10px] border object-cover hover:opacity-90" />
                </button>
              ) : (
                <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-[10px] bg-muted text-muted-foreground">
                  <Camera className="h-5 w-5" /><span className="text-[10px] font-bold uppercase tracking-wide">Live photo at submit</span>
                </div>
              )}
              <div className="space-y-1.5">
                {(proof?.capturedAt || audit.submittedAt) && (
                  <div className="flex items-start gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={3} />
                    <span className="flex-1">{proof?.isLiveCapture ? "Taken live" : "Photo at submit"} · {fmtDateTime(proof?.capturedAt ?? audit.submittedAt)}</span>
                  </div>
                )}
                {gpsFmt(audit.submitGeoLat, audit.submitGeoLng) && (
                  <div className="flex items-start gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={3} />
                    <span className="flex-1">
                      GPS matches property
                      <span className="mt-0.5 block font-mono text-[10.5px] text-muted-foreground">{gpsFmt(audit.submitGeoLat, audit.submitGeoLng)}{ws.target.propertyName ? ` · ${ws.target.propertyName}` : ""}</span>
                    </span>
                  </div>
                )}
                {audit.durationSeconds != null && (
                  <div className="flex items-start gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={3} />
                    <span className="flex-1">{fmtDuration(audit.durationSeconds)} on site{audit.reopenCount > 0 ? ` · reopened ×${audit.reopenCount}` : ""}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Auditor</div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted font-display text-xs font-bold">{(ws.assignee?.name ?? "—").split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold">{ws.assignee?.name ?? "—"}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">
                    {ws.assignee?.role ? titleCase(ws.assignee.role) : ""}
                    {ws.target.propertyName ? ` · ${ws.target.propertyName}` : ""}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Timeline</div>
              <div className="space-y-1">
                <TimelineRow dot="bg-muted-foreground" label="Assigned" when={audit.scheduledFor ?? audit.createdAt} />
                <TimelineRow dot="bg-accent" label={audit.startGeoLat != null ? "Started · GPS captured" : "Started"} when={audit.startedAt} />
                <TimelineRow dot="bg-success" label="Submitted & locked" when={audit.submittedAt} />
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

          {((canReview && audit.state === "SUBMITTED") || canReopen) && (
            <Card className="border-foreground/40">
              <CardContent className="p-4">
                <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">Your decision</div>
                <Textarea value={decisionRemark} onChange={(e) => setDecisionRemark(e.target.value)} placeholder="Remarks — required to reject or reopen…" rows={3} className="text-sm" />
                {canReview && audit.state === "SUBMITTED" && (
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
              </CardContent>
            </Card>
          )}
        </div>
      </div>

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
