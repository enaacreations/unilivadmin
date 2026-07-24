import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  AUDIT_TYPE_LABELS, scoreColorClass,
  type ApiList, type ApiOne, type ApiPage, type AuditRow, type AuditType, type DashboardSummary,
} from "./lib";
import { cn } from "@/lib/utils";
import { ReviewQueuePanel } from "./review-queue";
import { ReportsPanel } from "./reports";

/* Oversight dashboard (redesign — prototype "Audit oversight"). Serves the
 * oversight tier (City Head / Zonal Head / SVP): KPI tiles, per-property /
 * per-cluster leagues, a score trend and a needs-attention list. KPIs + trend
 * come from the summary endpoint; the leagues + needs-attention are aggregated
 * client-side from the register (the summary endpoint carries no per-target
 * scores yet — TODO(backend): a leagues endpoint would avoid the register pull). */

const PASS = 75;
const DONE = new Set(["APPROVED", "CLOSED", "SUBMITTED", "UNDER_REVIEW"]);

function KpiTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-[13px] border border-border bg-card px-[15px] py-[13px]">
      <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-display text-[26px] font-extrabold tracking-[-0.02em] tabular-nums", tone)}>{value}</div>
    </div>
  );
}

type LeagueRow = { name: string; score: number; total: number };

function medalClass(rank: number): string {
  if (rank === 1) return "bg-amber-100 text-amber-700";
  if (rank === 2) return "bg-slate-200 text-slate-600";
  if (rank === 3) return "bg-orange-100 text-orange-700";
  return "bg-muted text-muted-foreground";
}

function League({ title, accent, data }: { title: string; accent: string; data: { rows: LeagueRow[]; done: number; total: number } }) {
  return (
    <Card>
      <CardContent className="px-[18px] py-4">
        <div className="mb-2.5 flex items-center gap-2">
          <span className={cn("text-[11px] font-bold uppercase tracking-[0.1em]", accent)}>{title}</span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-muted-foreground">{data.done} of {data.total} done</span>
        </div>
        {data.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No scored audits yet.</p>
        ) : data.rows.map((p, i) => {
          const pass = p.score >= PASS;
          return (
            <div key={p.name} className="flex items-center gap-2.5 border-b border-dashed border-border py-[7px] last:border-0">
              <span className={cn("flex h-[22px] w-[22px] items-center justify-center rounded-full font-mono text-[10.5px] font-bold", medalClass(i + 1))}>{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{p.name}</span>
              <div className="hidden h-1.5 w-[110px] overflow-hidden rounded-full bg-muted sm:block">
                <div className={cn("h-full rounded-full", pass ? "bg-success" : "bg-destructive")} style={{ width: `${p.score}%` }} />
              </div>
              <span className={cn("w-[34px] text-right font-mono text-[12.5px] font-bold", pass ? "text-success" : "text-destructive")}>{p.score}</span>
              <span className={cn("w-[56px] rounded-full py-[2px] text-center text-[10.5px] font-bold", pass ? "bg-success-soft text-success" : "bg-destructive/10 text-destructive")}>{pass ? "Pass" : "Fail"}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function AuditDashboard() {
  const { role, can } = usePermissions();
  const canReview = can("AUDIT_REVIEW", "view");
  const canReports = can("AUDIT_REPORTS", "view");
  const [view, setView] = React.useState<"overview" | "review" | "reports">("overview");
  // Ops Excellence lands on the review queue (their primary action); everyone
  // else opens on the oversight overview. Applied once, when the role resolves.
  const viewInit = React.useRef(false);
  React.useEffect(() => {
    if (!viewInit.current && role) {
      viewInit.current = true;
      if (role === "OPS_EXCELLENCE") setView("review");
    }
  }, [role]);

  const [typeTab, setTypeTab] = React.useState<"ALL" | AuditType>("ALL");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  // Shares the queue cache with ReviewQueuePanel (same key) — for the tab count.
  const pendingQuery = useQuery({
    queryKey: ["/audit/reviews/queue"],
    queryFn: () => apiFetch<ApiPage<AuditRow>>("/audit/reviews/queue?page=1&limit=50"),
    enabled: canReview,
  });
  const pendingCount = pendingQuery.data?.data?.length ?? 0;

  const typesQuery = useQuery({
    queryKey: ["/audits/visible-types"],
    queryFn: () => apiFetch<ApiOne<AuditType[]>>("/audits/visible-types"),
  });
  const visibleTypes = typesQuery.data?.data ?? [];

  const qs = new URLSearchParams();
  if (typeTab !== "ALL") qs.set("auditType", typeTab);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const query = useQuery({
    queryKey: ["/audit/reports/dashboard/summary", qs.toString()],
    queryFn: () => apiFetch<ApiOne<DashboardSummary>>(`/audit/reports/dashboard/summary${qs.toString() ? `?${qs}` : ""}`),
  });
  const d = query.data?.data;

  const regQuery = useQuery({
    queryKey: ["/audits", "register-league"],
    queryFn: () => apiFetch<ApiList<AuditRow>>("/audits?limit=200"),
  });

  const league = React.useMemo(() => {
    const rows = regQuery.data?.data ?? [];
    const build = (type: AuditType) => {
      const byProp = new Map<string, { name: string; scores: number[] }>();
      const typeRows = rows.filter((r) => r.auditType === type);
      for (const r of typeRows) {
        const key = r.propertyId ?? r.propertyName ?? r.id;
        const e = byProp.get(key) ?? { name: r.propertyName ?? "—", scores: [] };
        if (r.scorePct != null) e.scores.push(Number(r.scorePct));
        byProp.set(key, e);
      }
      const list: LeagueRow[] = [...byProp.values()]
        .filter((e) => e.scores.length > 0)
        .map((e) => ({ name: e.name, score: Math.round(e.scores.reduce((a, b) => a + b, 0) / e.scores.length), total: e.scores.length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 7);
      return { rows: list, done: typeRows.filter((r) => DONE.has(r.state)).length, total: typeRows.length };
    };
    const needs = rows
      .filter((r) => r.isOverdue || r.result === "FAIL")
      .sort((a, b) => Number(b.result === "FAIL") - Number(a.result === "FAIL"))
      .slice(0, 6)
      .map((r) => {
        const fail = r.result === "FAIL";
        return {
          id: r.id,
          dot: fail ? "bg-destructive" : "bg-warning",
          title: fail
            ? `${r.propertyName ?? r.ticketNo} failed ${r.auditType} audit (${Math.round(Number(r.scorePct ?? 0))})`
            : `${r.propertyName ?? r.ticketNo} — ${r.auditType} audit overdue`,
          sub: `${r.assigneeName ?? "Unassigned"} · ${r.ticketNo}`,
        };
      });
    return { ul: build("UL"), cm: build("CM"), needs };
  }, [regQuery.data]);

  const trendData = React.useMemo(
    () => (d?.scoreTrend ?? []).map((t) => ({ month: t.month, avgScore: Math.round(t.avgScore * 10) / 10 })),
    [d],
  );

  const showReview = canReview && view === "review";
  const showReports = canReports && view === "reports";

  return (
    <div className="animate-fade-up space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-0.5 font-display text-2xl font-bold tracking-[-0.012em]">Audit oversight</h1>
          <p className="text-sm text-muted-foreground">
            {showReview
              ? "Approve or send back submitted audits."
              : showReports
                ? "Per-audit PDF registry plus the named operational reports."
                : "Program health across your permitted audit types."}
          </p>
        </div>
        {(canReview || canReports) && (
          <Tabs value={view} onValueChange={(v) => setView(v as "overview" | "review" | "reports")}>
            <TabsList>
              {canReview && <TabsTrigger value="review">Review{pendingCount ? ` · ${pendingCount}` : ""}</TabsTrigger>}
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {canReports && <TabsTrigger value="reports">Reports</TabsTrigger>}
            </TabsList>
          </Tabs>
        )}
      </div>

      {showReview ? (
        <ReviewQueuePanel embedded />
      ) : showReports ? (
        <ReportsPanel embedded />
      ) : (
      <>
      <div className="flex flex-wrap items-end gap-3">
        <Tabs value={typeTab} onValueChange={(v) => setTypeTab(v as "ALL" | AuditType)}>
          <TabsList>
            <TabsTrigger value="ALL">All</TabsTrigger>
            {visibleTypes.map((t) => <TabsTrigger key={t} value={t}>{AUDIT_TYPE_LABELS[t]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" /></div>
        <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" /></div>
      </div>

      {query.isLoading || !d ? (
        <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[76px]" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <KpiTile label="Completion" value={`${(d.kpis.completionRate ?? 0).toFixed(0)}%`} />
            <KpiTile label="Avg score" value={(d.kpis.averageScore ?? 0).toFixed(0)} tone={scoreColorClass(d.kpis.averageScore)} />
            <KpiTile label="On-time" value={`${(d.kpis.onTimePct ?? 0).toFixed(0)}%`} />
            <KpiTile label="Overdue" value={d.kpis.overdueCount} tone={d.kpis.overdueCount > 0 ? "text-destructive" : undefined} />
            <KpiTile label="Compliance" value={`${(d.kpis.compliancePct ?? 0).toFixed(0)}%`} />
            <KpiTile label="Active auditors" value={d.kpis.activeAuditors} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <League title="UL Room audits · property league" accent="text-accent-strong" data={league.ul} />
            <League title="CM audits · cluster league" accent="text-info" data={league.cm} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardContent className="px-[18px] py-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Score trend · 6 months</div>
                {trendData.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">No scored audits yet.</p>
                ) : (
                  <div className="h-[160px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis dataKey="month" fontSize={10.5} tickLine={false} axisLine={false} />
                        <YAxis domain={[0, 100]} fontSize={10.5} tickLine={false} axisLine={false} />
                        <RechartsTooltip />
                        <Line type="monotone" dataKey="avgScore" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="px-[18px] py-4">
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-destructive">Needs attention</span>
                  <span className="flex-1" />
                  <span className="rounded-full bg-destructive/10 px-2 py-[2px] text-[11px] font-bold text-destructive">{league.needs.length}</span>
                </div>
                {league.needs.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Nothing overdue or failing.</p>
                ) : league.needs.map((a) => (
                  <div key={a.id} className="flex items-start gap-2.5 border-b border-dashed border-border py-[7px] last:border-0">
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", a.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-semibold">{a.title}</div>
                      <div className="text-[11.5px] text-muted-foreground">{a.sub}</div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}
