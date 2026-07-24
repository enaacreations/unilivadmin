import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle, ChevronDown, ChevronRight, ListChecks, MapPin, RotateCcw,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { apiFetch } from "@/lib/api-fetch";
import { fmtDate, type ApiPage, type NcRow } from "./lib";
import { NcStateBadge, SeverityBadge, SlaCountdown, useNowTick } from "./shared";
import { cn } from "@/lib/utils";

type GroupKey = "overdue" | "dueSoon" | "awaiting" | "onTrack";

// Section titles in urgency order + the tone the heading takes.
const GROUPS: { key: GroupKey; title: string; tone: string }[] = [
  { key: "overdue", title: "Overdue — fix now", tone: "text-destructive" },
  { key: "dueSoon", title: "Due soon", tone: "text-warning" },
  { key: "awaiting", title: "Awaiting verification", tone: "text-pop" },
  { key: "onTrack", title: "On track", tone: "text-success" },
];

function groupOf(nc: NcRow): GroupKey | "terminal" {
  switch (nc.slaState) {
    case "OVERDUE": return "overdue";
    case "DUE_SOON": return "dueSoon";
    case "AWAITING_VERIFICATION": return "awaiting";
    case "ON_TRACK": return "onTrack";
    default: return "terminal"; // VERIFIED / CLOSED / WAIVED
  }
}

function FindingCard({ nc, nowMs, onOpen }: { nc: NcRow; nowMs: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-4 rounded-[14px] border border-border bg-card px-[18px] py-4 text-left transition-colors hover:border-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{nc.ncNo}</span>
          <SeverityBadge severity={nc.severity} />
        </span>
        <span className="mt-1 block font-semibold leading-snug line-clamp-2">{nc.description}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {nc.propertyName ?? "—"}
            <span className="font-mono text-xs"> · {nc.ticketNo}</span>
          </span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5 text-right">
        <SlaCountdown state={nc.state} dueAt={nc.dueAt} slaState={nc.slaState} nowMs={nowMs} className="text-[13px] font-medium" />
        <NcStateBadge state={nc.state} />
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** My Findings (FRD-NCM-02) — the owner's CAPA queue, grouped by SLA urgency.
 *  Also embedded as the "My findings" tab of the My Audits hub (`embedded`
 *  drops the page heading; the hub provides its own). */
export function MyFindingsPanel({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const nowMs = useNowTick();
  const [terminalOpen, setTerminalOpen] = React.useState(false);

  const myQuery = useQuery({
    queryKey: ["/audit/ncs", "mine"],
    queryFn: () => apiFetch<ApiPage<NcRow>>("/audit/ncs?mine=true&limit=100"),
  });

  const ncs = React.useMemo(() => myQuery.data?.data ?? [], [myQuery.data]);
  const grouped = React.useMemo(() => {
    const g: Record<GroupKey, NcRow[]> & { terminal: NcRow[] } = {
      overdue: [], dueSoon: [], awaiting: [], onTrack: [], terminal: [],
    };
    for (const nc of ncs) g[groupOf(nc)].push(nc);
    return g;
  }, [ncs]);

  // Finding detail lives at /audits/ncs/:id (NcDetail); /audits/findings is the
  // list route only, so navigating to /audits/findings/:id 404s.
  const openNc = (id: string) => navigate(`/audits/ncs/${id}`);

  return (
    <div className={cn("flex animate-fade-up flex-col gap-5", !embedded && "mx-auto max-w-[640px]")}>
      {!embedded && (
        <div>
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">Things to fix</h1>
          <p className="text-sm text-muted-foreground">
            Problems found in audits at your property. Fix them before the deadline.
          </p>
        </div>
      )}

      {myQuery.isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px] w-full rounded-[14px]" />)}
        </div>
      ) : myQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-border p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(myQuery.error as Error)?.message || "Failed to load your findings."}</p>
          <button
            type="button"
            onClick={() => myQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      ) : ncs.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No findings on your plate"
          description="Non-conformances raised on your properties appear here with their CAPA deadlines."
        />
      ) : (
        <>
          {GROUPS.map(({ key, title, tone }) => {
            const items = grouped[key];
            if (items.length === 0) return null;
            return (
              <section key={key}>
                <h2 className={cn("mb-2.5 text-xs font-bold uppercase tracking-[0.1em]", tone)}>
                  {title} · {items.length}
                </h2>
                <div className="flex flex-col gap-2.5">
                  {items.map((nc) => (
                    <FindingCard key={nc.id} nc={nc} nowMs={nowMs} onOpen={() => openNc(nc.id)} />
                  ))}
                </div>
              </section>
            );
          })}

          {/* Terminal findings, collapsed to a count */}
          {grouped.terminal.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setTerminalOpen((o) => !o)}
                className="flex min-h-11 items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
              >
                Closed / waived · {grouped.terminal.length}
                <ChevronDown className={cn("h-4 w-4 transition-transform", terminalOpen && "rotate-180")} />
              </button>
              {terminalOpen ? (
                <div className="mt-2.5 flex flex-col gap-2.5">
                  {grouped.terminal.map((nc) => (
                    <FindingCard key={nc.id} nc={nc} nowMs={nowMs} onOpen={() => openNc(nc.id)} />
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  {grouped.terminal.length} finished finding{grouped.terminal.length === 1 ? "" : "s"} — resolved on{" "}
                  {fmtDate(grouped.terminal[0]?.closedAt ?? grouped.terminal[0]?.updatedAt)} and earlier.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function MyFindings() {
  return <MyFindingsPanel />;
}
