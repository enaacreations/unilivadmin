import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Users, BedDouble, Wallet, AlertTriangle, AlertCircle, Receipt, BellRing, ClipboardCheck } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, FunnelChart, Funnel, LabelList } from "recharts";
import { PORTFOLIO_TYPE_LABELS, type PortfolioType } from "@/lib/portfolio-types";
import { useLocation } from "wouter";
import { usePermissions } from "@/lib/use-permissions";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import Forbidden from "./forbidden";

const COLORS = ["var(--accent)","var(--primary)","var(--info)","var(--success)","var(--warning)","var(--pop)"];

function useEx<T>(path: string) {
  return useQuery<{ data: T }>({ queryKey: [path], queryFn: () => apiFetch(path) });
}

export default function ExecutiveDashboard() {
  const { can } = usePermissions();
  const [, setLocation] = useLocation();
  const kpis = useEx<any>("/executive/kpis");
  const revenue = useEx<any[]>("/executive/revenue-trend");
  const occupancy = useEx<any[]>("/executive/occupancy-by-property");
  const resolution = useEx<any>("/executive/complaints-resolution");
  const funnel = useEx<any[]>("/executive/lead-funnel");
  const headcount = useEx<any>("/executive/headcount");
  const overdue = useEx<any[]>("/executive/top-overdue");
  const breached = useEx<any[]>("/executive/top-sla-breached");
  const portfolio = useEx<any[]>("/executive/portfolio-breakdown");
  const finance = useEx<{ paidExpenses: number; pendingExpenses: number; reminderTotal: number }>("/finance-summary");

  if (!can("EXECUTIVE_DASHBOARD")) return <Forbidden />;

  const k = kpis.data?.data || {};
  const f = finance.data?.data || ({} as { paidExpenses?: number; pendingExpenses?: number; reminderTotal?: number });
  const resData = resolution.data?.data ? [
    { name: "Resolved", value: resolution.data.data.resolved },
    { name: "Open", value: resolution.data.data.open },
  ] : [];

  return (
    <>
      <PageHeader title="Executive Dashboard" subtitle="Bird's-eye view of operations, finance, and growth" />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard title="Properties" value={k.totalProperties ?? "—"} icon={Building2} />
        <StatCard title="Residents" value={k.totalResidents ?? "—"} icon={Users} />
        <StatCard title="Occupancy" value={`${k.occupancy ?? 0}%`} icon={BedDouble} />
        <StatCard title="Revenue (MTD)" value={`₹${Math.round(k.revenueThisMonth ?? 0).toLocaleString()}`} icon={Wallet} />
        <StatCard title="Outstanding" value={`₹${Math.round(k.outstandingDues ?? 0).toLocaleString()}`} icon={AlertTriangle} />
        <StatCard title="Open Complaints" value={k.openComplaints ?? 0} icon={AlertCircle} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard title="Expenses Paid" value={`₹${Math.round(f.paidExpenses ?? 0).toLocaleString()}`} icon={Receipt} />
        <StatCard title="Expenses Pending Approval" value={`₹${Math.round(f.pendingExpenses ?? 0).toLocaleString()}`} icon={ClipboardCheck} />
        <StatCard title="Reminders Sent" value={f.reminderTotal ?? 0} icon={BellRing} />
      </div>

      <Tabs defaultValue="finance">
        <TabsList>
          <TabsTrigger value="finance">Finance &amp; Revenue</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>

        {/* ── Finance & Revenue ── */}
        <TabsContent value="finance" className="space-y-3">
          <Card>
            <CardHeader><CardTitle>Revenue — last 12 months</CardTitle></CardHeader>
            <CardContent style={{ height: 280 }}>
              <ResponsiveContainer>
                <AreaChart data={revenue.data?.data || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--muted)" }} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} />
                  <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                  <Legend />
                  <Area type="monotone" dataKey="rent" stackId="1" stroke="var(--accent)" fill="var(--accent)" />
                  <Area type="monotone" dataKey="food" stackId="1" stroke="var(--info)" fill="var(--info)" />
                  <Area type="monotone" dataKey="laundry" stackId="1" stroke="var(--success)" fill="var(--success)" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Lead Conversion Funnel</CardTitle></CardHeader>
            <CardContent style={{ height: 280 }}>
              <ResponsiveContainer>
                <FunnelChart>
                  <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                  <Funnel dataKey="count" data={funnel.data?.data || []} isAnimationActive>
                    {(funnel.data?.data || []).map((_: any, i: number) => (
                      <Cell key={i} fill={["var(--accent)", "var(--pop)", "var(--info)", "var(--success)", "var(--warning)"][i % 5]} />
                    ))}
                    <LabelList position="right" fill="var(--foreground)" stroke="none" dataKey="stage" />
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Operations ── */}
        <TabsContent value="operations" className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader><CardTitle>Occupancy by Property</CardTitle></CardHeader>
              <CardContent style={{ height: 280 }}>
                <ResponsiveContainer>
                  <BarChart data={occupancy.data?.data || []} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <YAxis dataKey="property" type="category" width={100} tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                    <Bar dataKey="occupancy" fill="var(--accent)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Complaint Resolution (MTD)</CardTitle></CardHeader>
              <CardContent style={{ height: 280 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={resData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} label>
                      {resData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
                <div className="text-center text-sm text-muted-foreground mt-1">{resolution.data?.data?.rate ?? 0}% resolved</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Portfolio Breakdown</CardTitle></CardHeader>
            <CardContent>
              {(portfolio.data?.data?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No portfolio data</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div style={{ height: 240 }}>
                    <ResponsiveContainer>
                      <BarChart data={(portfolio.data?.data || []).map((d: any) => ({
                        type: PORTFOLIO_TYPE_LABELS[d.type as PortfolioType] || d.type,
                        properties: d.properties,
                        occupancy: d.occupancy,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="type" tick={{ fontSize: 10, fill: "var(--muted)" }} angle={-15} textAnchor="end" height={60} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} />
                        <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                        <Legend />
                        <Bar dataKey="properties" fill="var(--accent)" name="Properties" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="occupancy" fill="var(--info)" name="Occupancy %" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <BoundedScroll size="sm">
                    <table className="w-full text-sm" data-testid="table-portfolio-breakdown">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground border-b sticky top-0 bg-card z-10">
                          <th className="py-2">Type</th>
                          <th>Properties</th>
                          <th>Beds</th>
                          <th>Occupancy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(portfolio.data?.data || []).map((d: any) => (
                          <tr key={d.type} className="border-b" data-testid={`row-portfolio-${d.type}`}>
                            <td className="py-2">{PORTFOLIO_TYPE_LABELS[d.type as PortfolioType] || d.type}</td>
                            <td className="tabular-nums">{d.properties}</td>
                            <td className="tabular-nums">{d.totalBeds}</td>
                            <td className="tabular-nums">{d.occupancy}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </BoundedScroll>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader><CardTitle>Top Overdue Residents</CardTitle></CardHeader>
              <CardContent>
                <BoundedScroll size="sm">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted-foreground border-b sticky top-0 bg-card z-10"><th className="py-2">Resident</th><th>Amount</th><th>Days Overdue</th></tr></thead>
                    <tbody>
                      {(overdue.data?.data || []).map((r: any) => {
                        const days = r.dueDate ? Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86400000) : 0;
                        const go = can("RESIDENTS", "view") && r.residentId ? () => setLocation(`/residents/${r.residentId}`) : undefined;
                        return <tr key={r.id} onClick={go} className={`border-b ${go ? "cursor-pointer hover:bg-muted/40" : ""}`}><td className="py-2">{r.residentName || "—"}</td><td className="tabular-nums">₹{Number(r.amount).toLocaleString()}</td><td className="tabular-nums">{days}</td></tr>;
                      })}
                      {!(overdue.data?.data?.length) && <tr><td colSpan={3} className="py-4 text-center text-muted-foreground">No overdue payments</td></tr>}
                    </tbody>
                  </table>
                </BoundedScroll>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>SLA-Breached Complaints</CardTitle></CardHeader>
              <CardContent>
                <BoundedScroll size="sm">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted-foreground border-b sticky top-0 bg-card z-10"><th className="py-2">Ticket</th><th>Category</th><th>Age (days)</th></tr></thead>
                    <tbody>
                      {(breached.data?.data || []).map((c: any) => {
                        const age = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000);
                        const go = can("COMPLAINTS", "view") ? () => setLocation(`/complaints/${c.id}`) : undefined;
                        return <tr key={c.id} onClick={go} className={`border-b ${go ? "cursor-pointer hover:bg-muted/40" : ""}`}><td className="py-2">{c.ticketNumber || c.id.slice(0,8)}</td><td>{c.category}</td><td className="tabular-nums">{age}</td></tr>;
                      })}
                      {!(breached.data?.data?.length) && <tr><td colSpan={3} className="py-4 text-center text-muted-foreground">No breached complaints</td></tr>}
                    </tbody>
                  </table>
                </BoundedScroll>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── People ── */}
        <TabsContent value="people" className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader><CardTitle>Headcount by Department</CardTitle></CardHeader>
              <CardContent style={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={headcount.data?.data?.byDept || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="department" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <Tooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} />
                    <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>On Leave Today</CardTitle></CardHeader>
              <CardContent>
                <div className="text-5xl font-display font-bold text-accent tabular-nums">{headcount.data?.data?.leavesToday ?? 0}</div>
                <p className="text-sm text-muted-foreground mt-2">employees on approved leave today</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
