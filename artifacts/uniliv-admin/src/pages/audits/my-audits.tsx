import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertCircle, ClipboardCheck, RotateCcw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { UserAvatar } from "@/components/ui/user-avatar";
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

export default function MyAudits() {
  const [, navigate] = useLocation();
  const { me, role } = usePermissions();
  const [viewAll, setViewAll] = React.useState(false);

  const myQuery = useQuery({
    queryKey: ["/audits/my"],
    queryFn: () => apiFetch<ApiList<AuditRow>>("/audits/my"),
  });
  const audits = myQuery.data?.data ?? [];

  const view = React.useMemo(() => {
    const at: AuditType = audits[0]?.auditType ?? ROLE_TYPE[role ?? ""] ?? "UL";
    const cfg = CFG[at];

    const open = audits.filter((a) => OPEN.has(a.state) || a.state === "REJECTED");
    const doneOrReview = audits.filter((a) => DONE.has(a.state) || IN_REVIEW.has(a.state));
    const total = audits.length;
    const pct = total ? Math.round((doneOrReview.length / total) * 100) : 0;

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

    const lastApproved = audits
      .filter((a) => a.state === "APPROVED" && a.approvedAt)
      .sort((a, b) => +new Date(b.approvedAt as string) - +new Date(a.approvedAt as string))[0] ?? null;

    const scope = audits[0]?.propertyName ?? audits[0]?.propertyCity ?? cfg.roleLabel;
    return { cfg, at, open, doneOrReview, total, pct, next, dueLine, lastApproved, scope };
  }, [audits, role]);

  const { cfg, next, total, pct, dueLine, open, doneOrReview, lastApproved, scope } = view;
  const openNext = () => next && navigate(`/audits/${next.id}/run`);
  const openRow = (a: AuditRow) =>
    navigate(DONE.has(a.state) || IN_REVIEW.has(a.state) ? `/audits/${a.id}` : `/audits/${a.id}/run`);

  const nextLabel = next
    ? (next.roomNumber ? `Room ${next.roomNumber}` : next.propertyName ?? next.ticketNo)
    : "";
  const queue = viewAll ? audits : audits.slice(0, 6);

  return (
    <div className="mx-auto max-w-[460px] animate-fade-up pb-6">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pt-1">
        <div>
          <h1 className="font-display text-xl font-extrabold tracking-[-0.012em]">{cfg.title}</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{scope} · {cfg.roleLabel}</p>
        </div>
        <UserAvatar name={me?.name} className="h-9 w-9" />
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
      ) : audits.length === 0 ? (
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
                      {cfg.typeCardTitle} {doneOrReview.length} of {total} done
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
                <div className="mt-0.5 text-xs text-muted-foreground">{doneOrReview.length} submitted · locked for review by Ops Excellence</div>
              </div>
            </div>
          )}

          {/* This month */}
          <div className="flex items-baseline gap-2 px-1 pb-1.5 pt-[18px]">
            <div className="flex-1 font-display text-[14.5px] font-bold tracking-[-0.012em]">This month</div>
            <div className="font-mono text-[11px] text-muted-foreground">{format(new Date(), "MMMM yyyy")}</div>
          </div>
          <div className="flex gap-2.5">
            <div className="flex-1 rounded-[14px] border border-border bg-card p-[12px_13px]">
              <div className="flex items-center gap-1.5">
                <span className="text-base">{cfg.typeIcon}</span>
                <span className="flex-1 font-display text-sm font-bold">{cfg.typeCardTitle}</span>
                <span className={cn("h-2 w-2 rounded-full", open.length ? "bg-warning" : "bg-success")} />
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">{open.length} left</div>
              <span className={cn("mt-[7px] inline-block rounded-full px-[9px] py-[3px] text-[11px] font-bold", open.length ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
                {open.length ? "In progress" : "Complete"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => lastApproved ? navigate(`/audits/${lastApproved.id}`) : undefined}
              disabled={!lastApproved}
              className="flex-1 rounded-[14px] border border-border bg-card p-[12px_13px] text-left transition-colors enabled:hover:border-accent disabled:opacity-70"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-base">📋</span>
                <span className="flex-1 font-display text-sm font-bold">Submitted</span>
                {lastApproved && <span className="h-2 w-2 rounded-full bg-success" />}
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">{lastApproved ? "Last approved" : "None yet"}</div>
              {lastApproved && (
                <span className="mt-[7px] inline-block rounded-full bg-success-soft px-[9px] py-[3px] text-[11px] font-bold text-success">
                  Scored {Math.round(Number(lastApproved.scorePct ?? 0))}%
                </span>
              )}
            </button>
          </div>

          {/* Queue */}
          <div className="mt-3.5 rounded-[14px] border border-border bg-card p-[15px_16px]">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">{cfg.queueTitle}</span>
              <span className="flex-1" />
              <span className="font-mono text-[11px] text-muted-foreground">{open.length} left</span>
            </div>
            {queue.map((a, i) => {
              const isNext = next?.id === a.id;
              const st = statusOf(a, isNext);
              const no = a.roomNumber ?? String(i + 1).padStart(2, "0");
              const name = a.roomNumber ? (a.propertyName ?? cfg.typeCardTitle) : (a.propertyName ?? a.ticketNo);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => openRow(a)}
                  title={fmtDateTime(a.dueAt)}
                  className="flex w-full items-center gap-2.5 border-b border-dashed border-border py-[9px] text-left last:border-0"
                >
                  <span className="w-[38px] font-mono text-[12.5px] font-semibold">{no}</span>
                  <span className="flex-1 truncate text-[13px]">{name}</span>
                  <span className={cn("w-[26px] text-right font-mono text-[11.5px] font-bold", scoreTone(a))}>
                    {a.scorePct != null ? Math.round(Number(a.scorePct)) : "—"}
                  </span>
                  <span className={cn("w-[66px] rounded-full py-[3px] text-center text-[10.5px] font-bold", st.bg, st.fg)}>{st.tag}</span>
                </button>
              );
            })}
            {audits.length > 6 && (
              <button type="button" onClick={() => setViewAll((v) => !v)} className="block w-full pt-2.5 text-center text-xs font-semibold text-muted-foreground hover:text-accent-strong">
                {viewAll ? "Show less" : `View all ${audits.length} ${cfg.noun}s ›`}
              </button>
            )}
          </div>

          {/* Approved report banner */}
          {lastApproved && (
            <button
              type="button"
              onClick={() => navigate(`/audits/${lastApproved.id}`)}
              className="mt-3.5 flex w-full items-center gap-2.5 rounded-[14px] bg-success-soft p-[13px_16px] text-left transition-[filter] hover:brightness-[.98]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-sm text-white">✓</span>
              <div className="flex-1">
                <div className="font-display text-[13.5px] font-bold text-success">{format(new Date(lastApproved.approvedAt as string), "MMMM")} audit approved</div>
                <div className="text-xs text-muted-foreground">Scored {Math.round(Number(lastApproved.scorePct ?? 0))}% · reviewed by Ops Excellence</div>
              </div>
              <span className="text-xs font-semibold text-success">Report ›</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
