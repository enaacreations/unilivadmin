import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, Check, ListChecks, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { ScheduleCreateDialog } from "./schedule-create-dialog";
import {
  AUDIT_STATE_BADGE, fmtDateTime, scoreColorClass, titleCase,
  type ApiOne, type ApiPage, type AuditRow, type AuditType, type DashboardSummary,
} from "./lib";
import { cn } from "@/lib/utils";

const TYPE_CHIP: Record<AuditType, string> = { UL: "bg-accent/10 text-accent-strong", CM: "bg-info-soft text-info", CX: "bg-muted text-muted-foreground" };

/** "3d" / "5h" / "12m" — the compact age shown in the queue's right-hand column. */
function shortAge(iso: string | null): string {
  if (!iso) return "—";
  return formatDistanceToNow(new Date(iso)).replace(/ (day|hour|minute)s?.*/, (_m, u) => (u === "day" ? "d" : u === "hour" ? "h" : "m"));
}

function scorePct(a: AuditRow): number | null {
  return a.scorePct != null ? Math.round(Number(a.scorePct)) : null;
}

/** Score + verdict pair. Renders spans only so it is legal inside the accordion
 *  trigger (a <button>) as well as inside a plain row. */
function ScoreBlock({ value, label, tone }: { value: number | null; label: string; tone: string }) {
  return (
    <span className="shrink-0 text-right">
      <span className={cn("block font-display text-[17px] font-extrabold tabular-nums", value == null ? "text-muted-foreground" : scoreColorClass(value))}>{value ?? "—"}</span>
      <span className={cn("block text-[10px] font-bold uppercase tracking-[0.06em]", tone)}>{label}</span>
    </span>
  );
}

/** One audit = one row. The flat presentation used for CM/CX (one audit per
 *  property) and for any UL property that only has a single room in the queue. */
function QueueRow({ audit, onOpen }: { audit: AuditRow; onOpen: () => void }) {
  const pct = scorePct(audit);
  const fail = audit.result === "FAIL";
  return (
    <div className="flex items-center gap-3 rounded-[11px] border border-border bg-card px-3.5 py-3">
      <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] font-mono text-[10.5px] font-bold", TYPE_CHIP[audit.auditType])}>{audit.auditType}</span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[13.5px] font-bold">{audit.propertyName ?? audit.title} <span className="text-muted-foreground">›</span></div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{audit.ticketNo}{audit.roomNumber ? ` · Room ${audit.roomNumber}` : ""} · {audit.assigneeName ?? "—"} · click to review</div>
      </button>
      <ScoreBlock value={pct} label={fail ? "Fail" : pct != null ? "Pass" : "—"} tone={fail ? "text-destructive" : pct != null ? "text-success" : "text-muted-foreground"} />
      <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground" title={fmtDateTime(audit.submittedAt)}>{shortAge(audit.submittedAt)}</span>
    </div>
  );
}

/** A UL property collapsed into one row: a 40-room property otherwise fans out
 *  into 40 near-identical rows. The header carries the roll-up a reviewer
 *  triages on (how many pending, how many failing, the worst score, the oldest
 *  submission); expanding lists the rooms, each opening its own review screen. */
function PropertyGroup({ audits, onOpen }: { audits: AuditRow[]; onOpen: (id: string) => void }) {
  const pcts = audits.map(scorePct).filter((p): p is number => p != null);
  const lowest = pcts.length ? Math.min(...pcts) : null;
  const failCount = audits.filter((a) => a.result === "FAIL").length;
  const oldest = audits.reduce<string | null>(
    (acc, a) => (a.submittedAt && (acc == null || a.submittedAt < acc) ? a.submittedAt : acc),
    null,
  );
  // Fail-first inside the group: the rooms that need a decision most are the
  // ones the reviewer should see the moment the property is expanded.
  const rooms = React.useMemo(
    () => [...audits].sort((a, b) => {
      const failDelta = Number(b.result === "FAIL") - Number(a.result === "FAIL");
      if (failDelta !== 0) return failDelta;
      return (scorePct(a) ?? 101) - (scorePct(b) ?? 101);
    }),
    [audits],
  );
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="rooms" className="overflow-hidden rounded-[11px] border border-border bg-card">
        <AccordionTrigger className="gap-3 px-3.5 py-3 hover:no-underline">
          <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] font-mono text-[10.5px] font-bold", TYPE_CHIP.UL)}>UL</span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[13.5px] font-bold">{audits[0]?.propertyName ?? audits[0]?.title}</span>
            <span className="block truncate font-mono text-[11px] font-normal text-muted-foreground">
              {audits.length} rooms pending review{failCount > 0 ? ` · ${failCount} failing` : pcts.length ? " · all passing" : ""}
            </span>
          </span>
          <ScoreBlock
            value={lowest}
            label={failCount > 0 ? `${failCount} fail` : "Lowest"}
            tone={failCount > 0 ? "text-destructive" : "text-muted-foreground"}
          />
          <span className="w-9 shrink-0 text-right font-mono text-[11px] font-normal text-muted-foreground" title={fmtDateTime(oldest)}>{shortAge(oldest)}</span>
        </AccordionTrigger>
        <AccordionContent className="pb-0">
          <div className="border-t border-border">
            {rooms.map((a) => {
              const pct = scorePct(a);
              const fail = a.result === "FAIL";
              return (
                <div key={a.id} className="flex items-center gap-3 border-b border-border/60 py-2.5 pl-[60px] pr-3.5 last:border-b-0 hover:bg-muted/40">
                  <button type="button" onClick={() => onOpen(a.id)} className="min-w-0 flex-1 text-left">
                    {/* roomNumber is only populated once the queue endpoint joins rooms;
                        the ticket number keeps the row identifiable until then. */}
                    <div className="truncate text-[13px] font-bold">{a.roomNumber ? `Room ${a.roomNumber}` : a.ticketNo} <span className="text-muted-foreground">›</span></div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{a.ticketNo} · {a.assigneeName ?? "—"} · click to review</div>
                  </button>
                  <Badge variant={AUDIT_STATE_BADGE[a.state]} className="shrink-0">{titleCase(a.state)}</Badge>
                  <ScoreBlock value={pct} label={fail ? "Fail" : pct != null ? "Pass" : "—"} tone={fail ? "text-destructive" : pct != null ? "text-success" : "text-muted-foreground"} />
                  <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground" title={fmtDateTime(a.submittedAt)}>{shortAge(a.submittedAt)}</span>
                </div>
              );
            })}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

type QueueEntry =
  | { kind: "audit"; key: string; audits: [AuditRow] }
  | { kind: "group"; key: string; audits: AuditRow[] };

/**
 * Collapse UL rows into one entry per property, leaving CM/CX flat.
 * UL audits target a ROOM (one audit per room), so a property fans out into
 * dozens of rows; CM/CX target the PROPERTY itself — one audit each — so
 * grouping them would only add a click. Grouping also applies under the "All"
 * filter, otherwise a single property's UL rows bury every CM/CX row.
 * A group is emitted at the position of its oldest member, which preserves the
 * server's oldest-first ordering across both shapes.
 */
function buildEntries(rows: AuditRow[]): QueueEntry[] {
  const entries: QueueEntry[] = [];
  const groups = new Map<string, AuditRow[]>();
  for (const a of rows) {
    if (a.auditType !== "UL") {
      entries.push({ kind: "audit", key: a.id, audits: [a] });
      continue;
    }
    let bucket = groups.get(a.propertyId);
    if (!bucket) {
      bucket = [];
      groups.set(a.propertyId, bucket);
      entries.push({ kind: "group", key: `property-${a.propertyId}`, audits: bucket });
    }
    bucket.push(a);
  }
  // A property with a single room in the queue reads better as a plain row.
  return entries.map((e): QueueEntry => {
    const only = e.kind === "group" && e.audits.length === 1 ? e.audits[0] : undefined;
    return only ? { kind: "audit", key: only.id, audits: [only] } : e;
  });
}

/** Review queue: single-decision list — each row opens the review workspace at
 *  /audits/review/:id where the decision is made. Rendered standalone at
 *  /audits/review AND embedded as a tab on the Audit Dashboard (`embedded` drops
 *  the page title + the module-health rail, which the dashboard already shows). */
export function ReviewQueuePanel({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const [typeFilter, setTypeFilter] = React.useState<"ALL" | AuditType>("ALL");

  const queueQuery = useQuery({
    queryKey: ["/audit/reviews/queue"],
    queryFn: () => apiFetch<ApiPage<AuditRow>>("/audit/reviews/queue?page=1&limit=50"),
  });
  const summaryQuery = useQuery({
    queryKey: ["/audit/reports/dashboard/summary", "review-rail"],
    queryFn: () => apiFetch<ApiOne<DashboardSummary>>("/audit/reports/dashboard/summary"),
    enabled: !embedded,
  });

  const rows = queueQuery.data?.data ?? [];
  const counts = React.useMemo(() => ({
    ALL: rows.length,
    UL: rows.filter((r) => r.auditType === "UL").length,
    CM: rows.filter((r) => r.auditType === "CM").length,
    CX: rows.filter((r) => r.auditType === "CX").length,
  }), [rows]);
  const visibleRows = React.useMemo(
    () => (typeFilter === "ALL" ? rows : rows.filter((r) => r.auditType === typeFilter)),
    [rows, typeFilter],
  );
  const entries = React.useMemo(() => buildEntries(visibleRows), [visibleRows]);

  const kpis = summaryQuery.data?.data?.kpis;

  const main = (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {!embedded && (
          <div className="min-w-[220px] flex-1">
            <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Review Queue</h1>
            <p className="text-sm text-muted-foreground">Approve or send back submitted audits — all audit types</p>
          </div>
        )}
        <div className={cn("flex flex-wrap items-center gap-1.5", embedded && "flex-1")}>
          {([["ALL", "All"], ["UL", "UL"], ["CM", "CM"], ["CX", "CX"]] as const).map(([key, label]) => {
            const active = typeFilter === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setTypeFilter(key)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "border border-border bg-card text-foreground/70 hover:border-foreground/40 hover:text-foreground",
                )}
              >
                {label} · {counts[key]}
              </button>
            );
          })}
        </div>
      </div>

      {queueQuery.isLoading ? (
        <div className="flex flex-col gap-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-[11px]" />)}</div>
      ) : queueQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(queueQuery.error as Error)?.message || "Failed to load the queue."}</p>
          <Button variant="outline" size="sm" onClick={() => queueQuery.refetch()}><RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[14px] bg-success-soft p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success text-white"><Check className="h-6 w-6" /></div>
          <div className="font-display text-lg font-extrabold text-success">Queue cleared</div>
          <div className="text-[12.5px] text-muted-foreground">Every submitted audit has a decision. Auditors have been notified.</div>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="rounded-[11px] border border-dashed p-8 text-center text-sm text-muted-foreground">
          No {typeFilter} audits waiting for a decision.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((e) =>
            e.kind === "group" ? (
              <PropertyGroup key={e.key} audits={e.audits} onOpen={(id) => navigate(`/audits/review/${id}`)} />
            ) : (
              <QueueRow key={e.key} audit={e.audits[0]} onOpen={() => navigate(`/audits/review/${e.audits[0].id}`)} />
            ),
          )}
        </div>
      )}
    </div>
  );

  const rail = (
    <div className="space-y-3.5">
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Module health</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { queueQuery.refetch(); summaryQuery.refetch(); }}><RefreshCw className={cn("h-3.5 w-3.5", queueQuery.isFetching && "animate-spin")} /></Button>
          </div>
          <div className="flex flex-col gap-2">
            {[
              { v: `${Math.round(kpis?.completionRate ?? 0)}%`, l: "completion this month", tone: "" },
              { v: kpis?.overdueCount ?? 0, l: "overdue across zones", tone: (kpis?.overdueCount ?? 0) > 0 ? "text-destructive" : "" },
              { v: kpis?.activeAuditors ?? 0, l: "active auditors", tone: "" },
            ].map((m, i) => (
              <div key={i} className="flex items-baseline gap-1.5 rounded-[11px] border border-border bg-background px-[13px] py-2.5">
                <span className={cn("font-display text-xl font-extrabold tabular-nums", m.tone)}>{m.v}</span>
                <span className="text-[11.5px] text-muted-foreground">{m.l}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="rounded-[11px] bg-info-soft px-[13px] py-[11px]">
        <div className="text-xs font-bold text-info">Checklist edits are versioned</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">Changes never alter historical audits.</div>
      </div>
    </div>
  );

  if (embedded) {
    return <div className="animate-fade-up">{main}</div>;
  }
  return (
    <div className="animate-fade-up grid gap-5 lg:grid-cols-[1fr_272px]">
      {main}
      {rail}
    </div>
  );
}

/** Review Queue is the Ops audit hub: the decision queue, with quick actions to
 *  browse previous audits and to schedule a new audit (each gated per module). */
export default function ReviewQueue() {
  const [, navigate] = useLocation();
  const { can } = usePermissions();
  const showPrevious = can("AUDIT_REGISTER", "view");
  const showSchedules = can("AUDIT_SCHEDULES", "view");
  const [scheduleOpen, setScheduleOpen] = React.useState(false);

  if (!showPrevious && !showSchedules) return <ReviewQueuePanel />;

  return (
    <div className="animate-fade-up space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-0.5 font-display text-2xl font-bold tracking-[-0.012em]">Review Queue</h1>
          <p className="text-sm text-muted-foreground">Approve or send back submitted audits — all audit types.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showPrevious && (
            <Button variant="outline" onClick={() => navigate("/audits/register")}>
              <ListChecks className="mr-1.5 h-4 w-4" /> Audits
            </Button>
          )}
          {showSchedules && (
            <Button onClick={() => setScheduleOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Schedule Audit
            </Button>
          )}
        </div>
      </div>
      <ReviewQueuePanel embedded />
      {showSchedules && <ScheduleCreateDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />}
    </div>
  );
}
