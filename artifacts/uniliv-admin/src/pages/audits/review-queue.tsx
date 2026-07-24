import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, Check, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  scoreColorClass, type ApiOne, type ApiPage, type AuditRow, type AuditType,
  type DashboardSummary,
} from "./lib";
import { ReasonDialog } from "./shared";
import { cn } from "@/lib/utils";

const TYPE_CHIP: Record<AuditType, string> = { UL: "bg-accent/10 text-accent-strong", CM: "bg-info-soft text-info", CX: "bg-muted text-muted-foreground" };

/** Review queue (redesign — prototype OE "Review queue"): multi-select decide
 *  loop with a fail-first hero and a module-health rail. */
export default function ReviewQueue() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [rejectOpen, setRejectOpen] = React.useState(false);

  const queueQuery = useQuery({
    queryKey: ["/audit/reviews/queue"],
    queryFn: () => apiFetch<ApiPage<AuditRow>>("/audit/reviews/queue?page=1&limit=50"),
  });
  const summaryQuery = useQuery({
    queryKey: ["/audit/reports/dashboard/summary", "review-rail"],
    queryFn: () => apiFetch<ApiOne<DashboardSummary>>("/audit/reports/dashboard/summary"),
  });

  const rows = queueQuery.data?.data ?? [];
  const counts = React.useMemo(() => ({
    ALL: rows.length,
    UL: rows.filter((r) => r.auditType === "UL").length,
    CM: rows.filter((r) => r.auditType === "CM").length,
    CX: rows.filter((r) => r.auditType === "CX").length,
  }), [rows]);
  const failingIds = React.useMemo(() => rows.filter((r) => r.result === "FAIL").map((r) => r.id), [rows]);
  const oldest = React.useMemo(() => {
    const ts = rows.map((r) => r.submittedAt).filter(Boolean).map((s) => +new Date(s as string)).sort((a, b) => a - b)[0];
    return ts ? formatDistanceToNow(new Date(ts)) : null;
  }, [rows]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const decide = (verb: "approve" | "reject", reason?: string) =>
    // Claim-then-decide per audit (claim is best-effort — no-op if already ours).
    (async () => {
      const ids = [...sel];
      for (const id of ids) {
        await apiFetch(`/audit/reviews/${id}/claim`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
        await apiFetch(`/audit/reviews/${id}/${verb}`, { method: "POST", body: JSON.stringify({ comment: reason ?? "" }) });
      }
      return ids.length;
    })();

  const approveMut = useMutation({
    mutationFn: () => decide("approve"),
    onSuccess: (n) => { toast({ title: `${n} audit${n === 1 ? "" : "s"} approved` }); setSel(new Set()); queueQuery.refetch(); },
    onError: (e: Error) => toast({ title: e.message || "Approve failed", variant: "destructive" }),
  });
  const rejectMut = useMutation({
    mutationFn: (reason: string) => decide("reject", reason),
    onSuccess: (n) => { toast({ title: `${n} audit${n === 1 ? "" : "s"} sent back` }); setSel(new Set()); setRejectOpen(false); queueQuery.refetch(); },
    onError: (e: Error) => toast({ title: e.message || "Reject failed", variant: "destructive" }),
  });
  const busy = approveMut.isPending || rejectMut.isPending;

  const kpis = summaryQuery.data?.data?.kpis;

  return (
    <div className="animate-fade-up grid gap-5 lg:grid-cols-[1fr_272px]">
      {/* Main queue */}
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Review queue</h1>
            <p className="text-sm text-muted-foreground">Operations Excellence · all audit types</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full bg-foreground px-3 py-1.5 text-xs font-bold text-background">All · {counts.ALL}</span>
            {(["UL", "CM", "CX"] as AuditType[]).map((t) => (
              <span key={t} className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground/80">{t} · {counts[t]}</span>
            ))}
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
        ) : (
          <>
            {failingIds.length > 0 && (
              <div className="mb-3.5 rounded-[14px] bg-brand-gradient p-[2px]">
                <div className="flex flex-wrap items-center gap-3.5 rounded-[12px] bg-card px-[18px] py-[13px]">
                  <div className="min-w-[240px] flex-1">
                    <div className="font-display text-[15.5px] font-bold tracking-[-0.012em]">{rows.length} awaiting your decision</div>
                    <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {oldest ? `Oldest waiting ${oldest} · ` : ""}<strong className="text-accent-strong">{failingIds.length} failed</strong> need a decision first
                    </div>
                  </div>
                  <Button className="h-[42px] rounded-[11px]" onClick={() => setSel(new Set(failingIds))}>Select failed →</Button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 pb-24">
              {rows.map((a) => {
                const checked = sel.has(a.id);
                const pct = a.scorePct != null ? Math.round(Number(a.scorePct)) : null;
                const fail = a.result === "FAIL";
                return (
                  <div key={a.id} className={cn("flex items-center gap-3 rounded-[11px] border px-3.5 py-3", checked ? "border-accent bg-accent/5" : "border-border bg-card")}>
                    <button type="button" onClick={() => toggle(a.id)} aria-label="Select" className={cn("flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[6px] border-2", checked ? "border-accent bg-accent text-white" : "border-border bg-background")}>
                      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                    </button>
                    <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] font-mono text-[10.5px] font-bold", TYPE_CHIP[a.auditType])}>{a.auditType}</span>
                    <button type="button" onClick={() => navigate(`/audits/review/${a.id}`)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[13.5px] font-bold">{a.propertyName ?? a.title} <span className="text-muted-foreground">›</span></div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{a.ticketNo}{a.roomNumber ? ` · Room ${a.roomNumber}` : ""} · {a.assigneeName ?? "—"} · click to review</div>
                    </button>
                    <div className="shrink-0 text-right">
                      <div className={cn("font-display text-[17px] font-extrabold tabular-nums", pct == null ? "text-muted-foreground" : scoreColorClass(pct))}>{pct ?? "—"}</div>
                      <div className={cn("text-[10px] font-bold uppercase tracking-[0.06em]", fail ? "text-destructive" : pct != null ? "text-success" : "text-muted-foreground")}>{fail ? "Fail" : pct != null ? "Pass" : "—"}</div>
                    </div>
                    <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{a.submittedAt ? formatDistanceToNow(new Date(a.submittedAt)).replace(/ (day|hour|minute)s?.*/, (m, u) => (u === "day" ? "d" : u === "hour" ? "h" : "m")) : "—"}</span>
                  </div>
                );
              })}
            </div>

            {sel.size > 0 && (
              <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card px-4 py-3 shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)] md:left-64">
                <div className="mx-auto flex max-w-3xl items-center gap-3">
                  <span className="text-sm font-bold">{sel.size} selected</span>
                  <span className="flex-1" />
                  <Button variant="outline" className="border-destructive text-destructive hover:text-destructive" disabled={busy} onClick={() => setRejectOpen(true)}>Reject</Button>
                  <Button className="bg-success text-white hover:bg-success/90" disabled={busy} onClick={() => approveMut.mutate()}>
                    {approveMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Approve {sel.size}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Module health rail */}
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

      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={`Reject ${sel.size} audit${sel.size === 1 ? "" : "s"}`}
        description="Remarks are sent to the auditor(s) and required to reject."
        label="Reason"
        placeholder="What needs to be corrected…"
        saveLabel="Reject & send back"
        isSaving={rejectMut.isPending}
        onSave={(reason) => rejectMut.mutate(reason)}
      />
    </div>
  );
}
