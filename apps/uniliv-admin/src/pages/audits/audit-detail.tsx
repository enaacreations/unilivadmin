import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle, ArrowLeft, ArrowRight, Bell, CameraOff, ClipboardList,
  FileBarChart, Lock, MapPin, MessageSquare,
  Play, Settings2, Share2, ShieldAlert, TrendingUp, UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImageLightbox } from "@/components/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  AUDIT_STATE_BADGE, COMPLETED_AUDIT_STATES, RUNNABLE_STATES,
  fmtDateTime, fmtDuration, fmtGps, scoreColorClass, secondsBetween, titleCase,
  type ApiList, type ApiOne,
  type AuditDetailRow, type AuditEventRow, type AuditState, type ProofPhoto,
  type RunPayload,
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
    case "REJECTED": return "Start rework";
    default: return "Open runner";
  }
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium">{children}</div>
    </div>
  );
}

/**
 * One end of the on-site presence trail: the auditor's selfie plus the exact
 * coordinates and time it was taken. Deliberately states facts only — there is
 * no geofence check in this system, so nothing here claims the auditor was
 * "at the property".
 */
function ProofSide({
  label, proof, at, geo, onOpen,
}: {
  label: string;
  proof: ProofPhoto | null;
  /** Fallback timestamp from the audit row (start/submit stamp). */
  at: string | null;
  /** Fallback coordinates from the audit row. */
  geo: string | null;
  onOpen: () => void;
}) {
  const coords = fmtGps(proof?.geoLat, proof?.geoLng) ?? geo;
  const takenAt = proof?.capturedAt ?? at;
  const thumb = proof?.thumbUrl ?? proof?.url ?? null;

  return (
    <div className="flex gap-3">
      {thumb ? (
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="View full size"
        >
          <img src={thumb} alt={`${label} photo`} className="h-16 w-16 rounded-[10px] border object-cover" />
        </button>
      ) : (
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[10px] border border-dashed text-muted-foreground">
          <CameraOff className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold">{label}</p>
        {proof ? (
          <>
            <p className="font-mono text-xs text-muted-foreground">{coords ?? "no coordinates"}</p>
            <p className="text-xs text-muted-foreground">{fmtDateTime(takenAt)}</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not captured{at ? ` · ${fmtDateTime(at)}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

/** Audit detail (FRD-EXE-01) — header, meta, Details/Activity, state-legal actions. */
export default function AuditDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [, navigate] = useLocation();
  const { me, can } = usePermissions();

  const [tab, setTab] = React.useState("details");
  /** Index into `proofImages` — null closes the lightbox. */
  const [proofIndex, setProofIndex] = React.useState<number | null>(null);

  const auditQuery = useQuery({
    queryKey: ["/audits", id],
    queryFn: () => apiFetch<ApiOne<AuditDetailRow>>(`/audits/${id}`),
  });
  const audit = auditQuery.data?.data;

  const eventsQuery = useQuery({
    queryKey: ["/audits", id, "events"],
    queryFn: () => apiFetch<ApiList<AuditEventRow>>(`/audits/${id}/events`),
    enabled: tab === "activity",
  });

  // Completed audits: pull the run payload to build the prototype scorecard
  // (per-category scores) — server pre-computes per-response earned/max, so we
  // just aggregate.
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
    const passLine = run.version.passThresholdPct != null ? Number(run.version.passThresholdPct) : 75;
    return { cats, passLine };
  }, [runQuery.data]);

  // Presence trail images, in start→end order, for the shared lightbox.
  const proofImages = React.useMemo(() => {
    const list: { key: "start" | "end"; url: string }[] = [];
    if (audit?.startProof?.url) list.push({ key: "start", url: audit.startProof.url });
    if (audit?.endProof?.url) list.push({ key: "end", url: audit.endProof.url });
    return list;
  }, [audit]);
  const openProof = (key: "start" | "end") => {
    const idx = proofImages.findIndex((p) => p.key === key);
    if (idx >= 0) setProofIndex(idx);
  };

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
  const runnable = isAssignee && RUNNABLE_STATES.includes(audit.state);
  const pct = audit.scorePct != null ? Number(audit.scorePct) : null;
  // Reviewer-side content (Ops Excellence has AUDIT_REVIEW), plus the auditor
  // who took the photos. Everyone else keeps the timestamps in the meta grid.
  const showPresence =
    (isAssignee || can("AUDIT_REVIEW", "view")) &&
    !!(audit.startedAt || audit.startProof || audit.endProof);
  const onSiteSeconds = secondsBetween(audit.startedAt, audit.submittedAt) ?? audit.durationSeconds;

  const footerActions: React.ReactNode[] = [];
  if (isAssignee && (audit.state === "SCHEDULED" || audit.state === "REJECTED")) {
    // Starting now requires the live start photo, so hand off to the runner's
    // start screen instead of firing the transition from here.
    footerActions.push(
      <Button key="start" className="min-h-11" onClick={() => navigate(`/audits/${id}/run`)}>
        <Play className="mr-2 h-4 w-4" />
        {audit.state === "REJECTED" ? "Start rework" : "Start"}
      </Button>,
    );
  }
  if (isAssignee && audit.state === "IN_PROGRESS") {
    footerActions.push(
      <Button key="open" className="min-h-11" onClick={() => navigate(`/audits/${id}/run`)}>
        <ClipboardList className="mr-2 h-4 w-4" /> Open runner
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

          {audit.durationSeconds != null && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardContent className="space-y-2 p-5 text-sm">
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-success">Verification</div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-success">✓</span>
                    <span className="flex-1">Completed in {fmtDuration(audit.durationSeconds)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* On-site presence — the mandatory start & end selfies (FRD-EXE-14). */}
      {showPresence && (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">
                On-site presence
              </div>
              {onSiteSeconds != null && (
                <span className="text-xs text-muted-foreground">
                  {fmtDuration(onSiteSeconds)} between start and end
                </span>
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <ProofSide
                label="Start"
                proof={audit.startProof}
                at={audit.startedAt}
                geo={fmtGps(audit.startGeoLat, audit.startGeoLng)}
                onOpen={() => openProof("start")}
              />
              <ProofSide
                label="End"
                proof={audit.endProof}
                at={audit.submittedAt}
                geo={fmtGps(audit.submitGeoLat, audit.submitGeoLng)}
                onOpen={() => openProof("end")}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Coordinates are recorded from the auditor's device at capture time and cannot be
              edited. They are reported as captured — no distance check against the property is
              performed.
            </p>
          </CardContent>
        </Card>
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
              {fmtGps(audit.startGeoLat, audit.startGeoLng) && (
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {fmtGps(audit.startGeoLat, audit.startGeoLng)}
                </span>
              )}
            </MetaItem>
          )}
          {audit.submittedAt && (
            <MetaItem label="Submitted">
              {fmtDateTime(audit.submittedAt)}
              {fmtGps(audit.submitGeoLat, audit.submitGeoLng) && (
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {fmtGps(audit.submitGeoLat, audit.submitGeoLng)}
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

      <ImageLightbox
        images={proofImages.map((p) => p.url)}
        index={proofIndex}
        onIndexChange={setProofIndex}
        onClose={() => setProofIndex(null)}
        alt="Presence photo"
      />

      {/* Sticky action dock — offset past the sidebar on desktop (layout pattern). */}
      {footerActions.length > 0 && (
        <div className=/* Sticky, not fixed: <main> is the scroll container and the sidebar is a
          flex sibling, so the dock spans the content column exactly. The old
          `fixed … md:left-64` hard-coded a 256px offset against a sidebar that
          is 248px expanded and 68px collapsed, so it was wrong at every width. */
       "sticky bottom-0 z-20 border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)]">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-6">
            {footerActions}
          </div>
        </div>
      )}

    </div>
  );
}
