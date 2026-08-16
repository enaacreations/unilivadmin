import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertCircle, ChevronRight, ClipboardCheck, Play, RotateCcw, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { fmtDateTime, type ApiList, type AuditRow, type AuditType } from "./lib";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────────
 * Conduct Home (redesign — "Audit App Prototype.dc.html", conducting personas).
 * The identical screen serves UL / CM / CX; only the config below differs by
 * audit type (rooms vs properties vs surveys). Data is the assignee's own
 * queue from /audits/my; each row is one target instance for the current cycle.
 * ──────────────────────────────────────────────────────────────────────────── */

type Cfg = {
  title: string;
  roleLabel: string;
  typeIcon: string;
  typeCardTitle: string; // "Rooms" | "Properties" | "Surveys"
  queueTitle: string;
  noun: string; // singular, lowercase
};

const CFG: Record<AuditType, Cfg> = {
  UL: { title: "Room Audits", roleLabel: "Unit Lead", typeIcon: "🛏", typeCardTitle: "Rooms", queueTitle: "Room queue", noun: "room" },
  CM: { title: "Cluster Audits", roleLabel: "Cluster Manager", typeIcon: "🏢", typeCardTitle: "Properties", queueTitle: "Property queue", noun: "property" },
  CX: { title: "CX Audits", roleLabel: "Customer Experience", typeIcon: "💬", typeCardTitle: "Surveys", queueTitle: "Property queue", noun: "property" },
};

const ROLE_TYPE: Record<string, AuditType> = {
  UNIT_LEAD: "UL", CLUSTER_MANAGER: "CM", CUSTOMER_EXPERIENCE: "CX",
};

/** Server-aggregated per-type counts, so cards survive the 200-row page cap. */
type TypeCount = { auditType: AuditType; pending: number; completed: number };
type MyResponse = ApiList<AuditRow> & { meta?: { counts?: TypeCount[] } };

const SEGMENTS = ["pending", "completed", "all"] as const;
type Segment = (typeof SEGMENTS)[number];
const SEGMENT_LABEL: Record<Segment, string> = {
  pending: "Pending", completed: "Completed", all: "All",
};

// Lifecycle buckets for the current cycle.
const DONE = new Set(["APPROVED", "CLOSED"]);
const IN_REVIEW = new Set(["SUBMITTED", "UNDER_REVIEW"]);
const OPEN = new Set(["DRAFT", "SCHEDULED", "IN_PROGRESS", "PAUSED"]);

type QueueStatus = { tag: string; bg: string; fg: string };
function statusOf(a: AuditRow, isNext: boolean): QueueStatus {
  if (a.state === "REJECTED") return { tag: "Rework", bg: "bg-destructive/10", fg: "text-destructive" };
  if (DONE.has(a.state)) {
    const pass = a.result !== "FAIL";
    return pass
      ? { tag: "Done", bg: "bg-success-soft", fg: "text-success" }
      : { tag: "Fail", bg: "bg-destructive/10", fg: "text-destructive" };
  }
  if (IN_REVIEW.has(a.state)) return { tag: "Submitted", bg: "bg-info-soft", fg: "text-info" };
  if (a.state === "IN_PROGRESS" || a.state === "PAUSED") return { tag: "In progress", bg: "bg-warning-soft", fg: "text-warning" };
  if (isNext) return { tag: "Up next", bg: "bg-warning-soft", fg: "text-warning" };
  return { tag: "Pending", bg: "bg-muted", fg: "text-muted-foreground" };
}

/** The row's call-to-action. The label is the verb for that state — a generic
 *  "Open" would hide the difference between starting, resuming and reviewing.
 *  `primary` fills the button; only the up-next row and rows already underway
 *  earn it, so the queue still reads as "do this one first". */
type QueueAction = { label: string; icon: LucideIcon; primary: boolean };
function actionOf(a: AuditRow, isNext: boolean): QueueAction {
  if (DONE.has(a.state) || IN_REVIEW.has(a.state)) return { label: "View", icon: ChevronRight, primary: false };
  if (a.state === "REJECTED") return { label: "Fix", icon: RotateCcw, primary: true };
  if (a.state === "IN_PROGRESS" || a.state === "PAUSED") return { label: "Resume", icon: Play, primary: true };
  return { label: "Start", icon: Play, primary: isNext };
}

function scoreTone(a: AuditRow): string {
  if (a.result === "FAIL") return "text-destructive";
  if (a.scorePct != null) return "text-success";
  return "text-muted-foreground";
}

/** Progress ring — matches the prototype's 52px donut. */
function Ring({ pct }: { pct: number }) {
  const r = 22, c = 2 * Math.PI * r;
  const dash = `${(pct / 100) * c} ${c}`;
  return (
    <div className="relative h-[52px] w-[52px] shrink-0">
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
        <circle cx="26" cy="26" r={r} fill="none" stroke="hsl(var(--accent))" strokeWidth="6" strokeLinecap="round" strokeDasharray={dash} transform="rotate(-90 26 26)" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-xs font-bold">{pct}%</div>
    </div>
  );
}

function ConductHome() {
  const [, navigate] = useLocation();
  const { role } = usePermissions();
  const [viewAll, setViewAll] = React.useState(false);
  const [segment, setSegment] = React.useState<Segment>("pending");
  /** Tapping a category card drills the queue into that audit type. */
  const [typeFilter, setTypeFilter] = React.useState<AuditType | null>(null);

  /* The hero and the type cards always describe outstanding work, so they read
     the pending set regardless of which tab is open; the tab only swaps the
     queue below. When segment === "pending" both hooks share a key and React
     Query serves one request. */
  const pendingQuery = useQuery({
    queryKey: ["/audits/my", "pending"],
    queryFn: () => apiFetch<MyResponse>("/audits/my?segment=pending"),
  });
  const listQuery = useQuery({
    queryKey: ["/audits/my", segment],
    queryFn: () => apiFetch<MyResponse>(`/audits/my?segment=${segment}`),
  });

  const myQuery = pendingQuery;
  const audits = pendingQuery.data?.data ?? [];
  const listRows = listQuery.data?.data ?? [];
  const counts = pendingQuery.data?.meta?.counts ?? [];

  const view = React.useMemo(() => {
    /* The type cards come from the server aggregate, not from the rows, so a
       type the auditor holds but has nothing pending on still gets a "0 left"
       card — and the counts stay right past the 200-row page cap. */
    const types = counts.map((c) => c.auditType);
    // Field personas hold exactly one type; the page keeps their specific
    // wording ("Room Audits") and only falls back to generic when there are
    // several to name.
    const primary: AuditType =
      types.length === 1 ? types[0]! : (audits[0]?.auditType ?? ROLE_TYPE[role ?? ""] ?? "UL");
    const cfg = CFG[primary];
    const title = types.length > 1 ? "My Audits" : cfg.title;

    const pendingTotal = counts.reduce((n, c) => n + c.pending, 0);
    const completedTotal = counts.reduce((n, c) => n + c.completed, 0);
    const total = pendingTotal + completedTotal;
    const pct = total ? Math.round((completedTotal / total) * 100) : 0;

    // The pending segment IS the open set — no client-side state filtering.
    const open = audits;

    // Next actionable: rework first, then in-progress, then earliest-due open.
    const byUrgency = [...open].sort((x, y) => {
      const rank = (a: AuditRow) => (a.state === "REJECTED" ? 0 : a.state === "IN_PROGRESS" ? 1 : a.isOverdue ? 2 : 3);
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
      return (x.dueAt ? +new Date(x.dueAt) : Infinity) - (y.dueAt ? +new Date(y.dueAt) : Infinity);
    });
    const next = byUrgency[0] ?? null;

    // Nearest due date across open items → "due in N days".
    const dueTs = open.map((a) => a.dueAt).filter(Boolean).map((d) => +new Date(d as string)).sort((a, b) => a - b)[0];
    let dueLine = "";
    if (dueTs) {
      const days = Math.ceil((dueTs - Date.now()) / 86_400_000);
      dueLine = days < 0 ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`
        : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;
    }

    /* Scope line: name the property only when the queue really is one property.
       Reading audits[0] mislabelled every multi-property queue as whichever
       property happened to be due first. */
    const props = [...new Set(audits.map((a) => a.propertyName).filter(Boolean))] as string[];
    const scope = props.length === 1 ? props[0]! : props.length > 1 ? `${props.length} properties` : cfg.roleLabel;

    return { cfg, title, primary, types, open, total, pendingTotal, completedTotal, pct, next, dueLine, scope };
  }, [audits, counts, role]);

  const { cfg, title, types, next, total, pendingTotal, completedTotal, pct, dueLine, open, scope } = view;
  const openNext = () => next && navigate(`/audits/${next.id}/run`);
  const openRow = (a: AuditRow) =>
    navigate(DONE.has(a.state) || IN_REVIEW.has(a.state) ? `/audits/${a.id}` : `/audits/${a.id}/run`);

  const nextLabel = next
    ? (next.roomNumber ? `Room ${next.roomNumber}` : next.propertyName ?? next.ticketNo)
    : "";
  /* Card drill-down filters client-side: the rows for one segment are already
     in memory, so a round trip per category would only add latency. */
  const visibleRows = typeFilter ? listRows.filter((a) => a.auditType === typeFilter) : listRows;
  const queue = viewAll ? visibleRows : visibleRows.slice(0, 6);

  return (
    <div className="mx-auto max-w-[460px] animate-fade-up pb-6">
      {/* Header — no avatar: the app chrome already shows who you are, and this
          page is only ever your own queue. */}
      <div className="px-1 pt-1">
        <h1 className="font-display text-xl font-extrabold tracking-[-0.012em]">{title}</h1>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{scope} · {cfg.roleLabel}</p>
      </div>

      {myQuery.isLoading ? (
        <div className="mt-4 flex flex-col gap-2.5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[88px] w-full rounded-[14px]" />)}
        </div>
      ) : myQuery.isError ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-border p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(myQuery.error as Error)?.message || "Failed to load your queue."}</p>
          <button type="button" onClick={() => myQuery.refetch()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      ) : total === 0 ? (
        <div className="mt-6">
          <EmptyState icon={ClipboardCheck} title="All clear" description="No audits are assigned to you right now. New assignments will appear here." />
        </div>
      ) : (
        <>
          {/* Due / progress hero */}
          {next ? (
            <div className="mt-3.5 rounded-[14px] bg-brand-gradient p-[2px]">
              <div className="rounded-[12px] bg-card p-[16px_18px]">
                <div className="flex items-center gap-2.5">
                  <div className="flex-1">
                    <div className="font-display text-base font-bold tracking-[-0.012em]">
                      {format(new Date(), "MMMM")} audit{dueLine ? ` — ${dueLine}` : ""}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {completedTotal} of {total} done
                      {/* TODO(backend): on-time streak not returned by /audits/my — wire when available. */}
                    </div>
                  </div>
                  <Ring pct={pct} />
                </div>
                <button
                  type="button"
                  onClick={openNext}
                  className="mt-3 h-[46px] w-full rounded-[11px] bg-accent font-display text-[15px] font-bold text-white transition-[filter] hover:brightness-105"
                >
                  {next.state === "REJECTED" ? "Fix rework" : next.state === "IN_PROGRESS" ? "Resume audit" : "Continue audit"} → {nextLabel}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3.5 flex items-center gap-3 rounded-[14px] bg-success-soft p-[15px_18px]">
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-success text-[15px] text-white">✓</span>
              <div className="flex-1">
                <div className="font-display text-[14.5px] font-bold text-success">All {cfg.noun}s done this cycle</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{completedTotal} submitted · locked for review by Ops Excellence</div>
              </div>
            </div>
          )}

          {/* Audit categories — one card per audit type the auditor holds. */}
          <div className="flex items-baseline gap-2 px-1 pb-1.5 pt-[18px]">
            <div className="flex-1 font-display text-[14.5px] font-bold tracking-[-0.012em]">This month</div>
            <div className="font-mono text-[11px] text-muted-foreground">{format(new Date(), "MMMM yyyy")}</div>
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className={cn("flex gap-2.5", counts.length < 3 && "w-full")}>
              {counts.map((c) => {
                const tc = CFG[c.auditType];
                const active = typeFilter === c.auditType;
                return (
                  <button
                    key={c.auditType}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTypeFilter(active ? null : c.auditType)}
                    className={cn(
                      "min-w-[136px] flex-1 rounded-[14px] border bg-card p-[12px_13px] text-left transition-colors",
                      active ? "border-accent ring-1 ring-accent/30" : "border-border hover:border-accent/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">{tc.typeIcon}</span>
                      <span className="flex-1 truncate font-display text-sm font-bold">{tc.typeCardTitle}</span>
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", c.pending ? "bg-warning" : "bg-success")} />
                    </div>
                    <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">{c.pending} left</div>
                    <span className={cn("mt-[7px] inline-block rounded-full px-[9px] py-[3px] text-[11px] font-bold", c.pending ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
                      {c.pending ? "In progress" : "Complete"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Queue — Pending / Completed / All, optionally drilled to one type. */}
          <div className="mt-3.5 rounded-[14px] border border-border bg-card p-[15px_16px]">
            <div className="mb-2.5 flex rounded-[10px] bg-muted/60 p-0.5" role="tablist">
              {SEGMENTS.map((sgm) => (
                <button
                  key={sgm}
                  type="button"
                  role="tab"
                  aria-selected={segment === sgm}
                  onClick={() => { setSegment(sgm); setViewAll(false); }}
                  className={cn(
                    "flex-1 rounded-[8px] py-[6px] text-[12.5px] font-bold transition-colors",
                    segment === sgm ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {SEGMENT_LABEL[sgm]}
                  {sgm === "pending" && pendingTotal > 0 && (
                    <span className="ml-1 font-mono text-[11px] text-muted-foreground">{pendingTotal}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="mb-2 flex items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">
                {typeFilter ? CFG[typeFilter].queueTitle : cfg.queueTitle}
              </span>
              {typeFilter && (
                <button
                  type="button"
                  onClick={() => setTypeFilter(null)}
                  className="rounded-full bg-muted px-2 py-[2px] text-[10.5px] font-bold text-muted-foreground hover:text-foreground"
                >
                  Clear ×
                </button>
              )}
              <span className="flex-1" />
              <span className="font-mono text-[11px] text-muted-foreground">{visibleRows.length}</span>
            </div>
            {listQuery.isLoading ? (
              <div className="space-y-2 py-1">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
              </div>
            ) : visibleRows.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-muted-foreground">
                Nothing {SEGMENT_LABEL[segment].toLowerCase()}{typeFilter ? ` in ${CFG[typeFilter].typeCardTitle}` : ""}.
              </p>
            ) : null}
            {queue.map((a, i) => {
              const isNext = next?.id === a.id;
              const st = statusOf(a, isNext);
              const no = a.roomNumber ?? String(i + 1).padStart(2, "0");
              const name = a.roomNumber ? (a.propertyName ?? cfg.typeCardTitle) : (a.propertyName ?? a.ticketNo);
              const act = actionOf(a, isNext);
              const ActIcon = act.icon;
              return (
                <div
                  key={a.id}
                  title={fmtDateTime(a.dueAt)}
                  className="flex w-full items-center gap-2 border-b border-dashed border-border py-[9px] last:border-0"
                >
                  {/* The whole row stays tappable (big touch target in the field);
                      the button on the right is the explicit affordance. */}
                  <button
                    type="button"
                    onClick={() => openRow(a)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="w-[38px] shrink-0 font-mono text-[12.5px] font-semibold">{no}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                    {a.scorePct != null && (
                      <span className={cn("shrink-0 font-mono text-[11.5px] font-bold", scoreTone(a))}>
                        {Math.round(Number(a.scorePct))}
                      </span>
                    )}
                    <span className={cn("w-[62px] shrink-0 rounded-full py-[3px] text-center text-[10.5px] font-bold", st.bg, st.fg)}>{st.tag}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openRow(a)}
                    aria-label={`${act.label} ${cfg.noun} ${no} audit`}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-[5px] text-[11px] font-bold transition-colors",
                      act.primary
                        ? "border-accent bg-accent text-white hover:brightness-95"
                        : "border-border bg-card text-muted-foreground hover:border-accent hover:text-accent-strong",
                    )}
                  >
                    <ActIcon className={cn("h-3 w-3", act.label === "Start" || act.label === "Resume" ? "fill-current" : "")} />
                    {act.label}
                  </button>
                </div>
              );
            })}
            {visibleRows.length > 6 && (
              <button type="button" onClick={() => setViewAll((v) => !v)} className="block w-full pt-2.5 text-center text-xs font-semibold text-muted-foreground hover:text-accent-strong">
                {viewAll ? "Show less" : `View all ${visibleRows.length} ›`}
              </button>
            )}
          </div>

          {/* The approved-report banner lived here. It was unreachable — it read
              state APPROVED, which the pending-only endpoint never returned —
              and the Completed tab now covers the same ground properly. */}
        </>
      )}
    </div>
  );
}

/* My Audits — the staff persona's conduct home (the findings/NC subsystem was
 * removed in the 2026-07 PRD trim, so no hub tabs remain). */
export default function MyAudits() {
  return <ConductHome />;
}
