import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, isSameDay } from "date-fns";
import { AlertCircle, ChevronRight, ClipboardCheck, MapPin, Plus, RotateCcw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { fmtDateTime, titleCase, type ApiList, type AuditRow } from "./lib";
import { cn } from "@/lib/utils";

type GroupKey = "rework" | "overdue" | "today" | "upcoming";

// Section titles, in urgency order, with the tone their heading takes.
const GROUPS: { key: GroupKey; title: string; tone: string }[] = [
  { key: "rework", title: "Rework", tone: "text-destructive" },
  { key: "overdue", title: "Overdue", tone: "text-destructive" },
  { key: "today", title: "Today", tone: "text-warning" },
  { key: "upcoming", title: "Upcoming", tone: "text-muted-foreground" },
];

function groupOf(a: AuditRow): GroupKey {
  if (a.state === "REJECTED") return "rework";
  if (a.isOverdue) return "overdue";
  if (a.dueAt && isSameDay(new Date(a.dueAt), new Date())) return "today";
  return "upcoming";
}

/** "Overdue by 2 hours" / "Due in 3 days" / "No due date". */
function dueText(a: AuditRow): { text: string; urgent: boolean } {
  if (!a.dueAt) return { text: "No due date", urgent: false };
  const due = new Date(a.dueAt);
  const distance = formatDistanceToNow(due);
  if (due.getTime() < Date.now()) return { text: `Overdue by ${distance}`, urgent: true };
  return { text: `Due in ${distance}`, urgent: false };
}

// auditType is the short code "UL" | "CM" | "CX" (lib.ts), not the role enum.
const TYPE_LABEL: Record<string, string> = {
  UL: "UL audit", CM: "CM audit", CX: "CX audit",
};

function AuditCard({ audit, onOpen }: { audit: AuditRow; onOpen: () => void }) {
  const due = dueText(audit);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-4 rounded-[14px] border border-border bg-card px-[18px] py-4 text-left transition-colors hover:border-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{audit.ticketNo}</span>
          <span className="rounded-full bg-info-soft px-[9px] py-[3px] text-[11px] font-bold text-info">
            {TYPE_LABEL[audit.auditType] ?? titleCase(audit.auditType)}
          </span>
        </span>
        <span className="mt-1 block truncate font-semibold">{audit.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {audit.propertyName ?? "—"}
            {audit.roomNumber ? ` · Room ${audit.roomNumber}` : ""}
            {audit.propertyCity ? `, ${audit.propertyCity}` : ""}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className={cn("block text-[13px] font-medium", due.urgent ? "text-destructive" : "text-muted-foreground")}
          title={fmtDateTime(audit.dueAt)}
        >
          {due.text}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{titleCase(audit.state)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** My Audits (FRD-REG-05) — the assignee's mobile-first field queue. */
export default function MyAudits() {
  const [, navigate] = useLocation();
  const { can } = usePermissions();
  const canCreate = can("AUDIT_EXECUTION", "create");

  const myQuery = useQuery({
    queryKey: ["/audits/my"],
    queryFn: () => apiFetch<ApiList<AuditRow>>("/audits/my"),
  });

  const audits = myQuery.data?.data ?? [];
  const grouped = React.useMemo(() => {
    const g: Record<GroupKey, AuditRow[]> = { overdue: [], today: [], upcoming: [], rework: [] };
    for (const a of audits) g[groupOf(a)].push(a);
    return g;
  }, [audits]);

  return (
    <div className="mx-auto flex max-w-[640px] animate-fade-up flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">My audits</h1>
          <p className="text-sm text-muted-foreground">
            Your checks, sorted by what's most urgent. Tap one to start.
          </p>
        </div>
        {canCreate && (
          <Link href="/audits/new">
            <span className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[13px] font-bold text-white transition-[filter] hover:brightness-105">
              <Plus className="h-4 w-4" /> New audit
            </span>
          </Link>
        )}
      </div>

      {myQuery.isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px] w-full rounded-[14px]" />)}
        </div>
      ) : myQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-border p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(myQuery.error as Error)?.message || "Failed to load your queue."}</p>
          <button
            type="button"
            onClick={() => myQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      ) : audits.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="All clear"
          description="No audits are assigned to you right now. New assignments will appear here."
        />
      ) : (
        GROUPS.map(({ key, title, tone }) => {
          const items = grouped[key];
          if (items.length === 0) return null;
          return (
            <section key={key}>
              <h2 className={cn("mb-2.5 text-xs font-bold uppercase tracking-[0.1em]", tone)}>
                {title} · {items.length}
              </h2>
              <div className="flex flex-col gap-2.5">
                {items.map((a) => (
                  <AuditCard key={a.id} audit={a} onOpen={() => navigate(`/audits/${a.id}`)} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
