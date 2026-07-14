import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RechartsTooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
} from "recharts";
import {
  Gauge, TrendingUp, Clock, AlertTriangle, ShieldCheck, Users,
  Table as TableIcon, PieChart as PieIcon,
} from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api-fetch";
import { AUDIT_TYPE_LABELS, type ApiOne, type AuditType, type DashboardSummary } from "./lib";
import { TypeBadge } from "./shared";

/** Status → chart colour (matches AUDIT_STATE_BADGE intent). */
const STATE_COLOR: Record<string, string> = {
  DRAFT: "#94a3b8",
  SCHEDULED: "#3666CF",
  IN_PROGRESS: "#9A6206",
  PAUSED: "#a855f7",
  SUBMITTED: "#7C5CFF",
  UNDER_REVIEW: "#0891b2",
  REJECTED: "#C73B33",
  APPROVED: "#157F5B",
  CLOSED: "#6b7280",
  CANCELLED: "#b91c1c",
};

const pct = (n: number) => `${(n ?? 0).toFixed(1)}%`;

export default function AuditDashboard() {
  const [typeTab, setTypeTab] = React.useState<"ALL" | AuditType>("ALL");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [donutView, setDonutView] = React.useState<"chart" | "table">("chart");

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
    queryFn: () =>
      apiFetch<ApiOne<DashboardSummary>>(`/audit/reports/dashboard/summary${qs.toString() ? `?${qs}` : ""}`),
  });
  const d = query.data?.data;

  const donutData = React.useMemo(() => {
    if (!d) return [];
    return Object.entries(d.statusCounts)
      .filter(([, n]) => n > 0)
      .map(([state, count]) => ({ name: state.replace(/_/g, " "), state, value: count }));
  }, [d]);

  const trendData = React.useMemo(
    () => (d?.scoreTrend ?? []).map((t) => ({ month: t.month, avgScore: Math.round(t.avgScore * 10) / 10 })),
    [d],
  );

  const volumeByTemplate = React.useMemo(
    () => [...(d?.volumeByTemplate ?? [])].sort((a, b) => b.count - a.count),
    [d],
  );
  const maxVolume = volumeByTemplate.reduce((m, v) => Math.max(m, v.count), 0);

  return (
    <div className="animate-fade-up space-y-6">
      <div>
        <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">Audit dashboard</h1>
        <p className="text-sm text-muted-foreground">Program health across your permitted audit types.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Tabs value={typeTab} onValueChange={(v) => setTypeTab(v as "ALL" | AuditType)}>
          <TabsList>
            <TabsTrigger value="ALL">All</TabsTrigger>
            {visibleTypes.map((t) => (
              <TabsTrigger key={t} value={t}>{AUDIT_TYPE_LABELS[t]}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
      </div>

      {query.isLoading || !d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <>
          {/* KPI tiles (FRD-ANL-07) — zeros, not blanks. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard title="Completion rate" value={pct(d.kpis.completionRate)} icon={Gauge} />
            <StatCard title="Average score" value={pct(d.kpis.averageScore)} icon={TrendingUp} />
            <StatCard title="On-time %" value={pct(d.kpis.onTimePct)} icon={Clock} />
            <StatCard title="Overdue" value={d.kpis.overdueCount} icon={AlertTriangle} />
            <StatCard title="Compliance %" value={pct(d.kpis.compliancePct)} icon={ShieldCheck} />
            <StatCard title="Active auditors" value={d.kpis.activeAuditors} icon={Users} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Status donut with table toggle (FRD-ANL-01). */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">Audits by status</CardTitle>
                <div className="flex gap-1">
                  <Button variant={donutView === "chart" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" onClick={() => setDonutView("chart")}>
                    <PieIcon className="h-4 w-4" />
                  </Button>
                  <Button variant={donutView === "table" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" onClick={() => setDonutView("table")}>
                    <TableIcon className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {donutData.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">No audits in range.</p>
                ) : donutView === "chart" ? (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={100} paddingAngle={2}>
                          {donutData.map((entry) => (
                            <Cell key={entry.state} fill={STATE_COLOR[entry.state] ?? "#94a3b8"} />
                          ))}
                        </Pie>
                        <RechartsTooltip />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Status</TableHead><TableHead className="text-right">Count</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {donutData.map((row) => (
                        <TableRow key={row.state}>
                          <TableCell className="flex items-center gap-2">
                            <span className="inline-block h-3 w-3 rounded-full" style={{ background: STATE_COLOR[row.state] }} />
                            {row.name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{row.value}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* Score trend (FRD-ANL-02). */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Average score trend</CardTitle></CardHeader>
              <CardContent>
                {trendData.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">No scored audits yet.</p>
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="month" fontSize={11} />
                        <YAxis domain={[0, 100]} fontSize={11} />
                        <RechartsTooltip />
                        <Line type="monotone" dataKey="avgScore" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* NC analytics (FRD-ANL-03). */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Findings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-6">
                  <div>
                    <div className="text-2xl font-display font-bold">{d.ncAnalytics.total}</div>
                    <div className="text-xs text-muted-foreground">Total NCs</div>
                  </div>
                  <div>
                    <div className="text-2xl font-display font-bold text-success">{pct(d.ncAnalytics.capaClosureRate)}</div>
                    <div className="text-xs text-muted-foreground">CAPA closure rate</div>
                  </div>
                </div>
                {d.ncAnalytics.bySeverity.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Severity</TableHead><TableHead>State</TableHead><TableHead className="text-right">Count</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.ncAnalytics.bySeverity.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.severity}</TableCell>
                          <TableCell className="text-muted-foreground">{r.state.replace(/_/g, " ")}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Top failing questions</CardTitle></CardHeader>
              <CardContent>
                {d.ncAnalytics.topFailingQuestions.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No repeat findings yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {d.ncAnalytics.topFailingQuestions.map((q, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 text-sm">
                        <span className="line-clamp-2">{q.prompt}</span>
                        <Badge variant="secondary" className="shrink-0 tabular-nums">{q.count}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Volume by template (per-template audit counts). */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Audits by template</CardTitle></CardHeader>
            <CardContent>
              {volumeByTemplate.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No audits in range.</p>
              ) : (
                <ul className="space-y-3">
                  {volumeByTemplate.map((v) => (
                    <li key={v.templateId} className="space-y-1">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <TypeBadge type={v.auditType} />
                          <span className="truncate">{v.templateName}</span>
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">{v.count}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${maxVolume > 0 ? (v.count / maxVolume) * 100 : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
