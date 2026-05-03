import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Users, BedDouble, Wallet, AlertTriangle, AlertCircle } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, FunnelChart, Funnel, LabelList } from "recharts";
import { usePermissions } from "@/lib/use-permissions";
import Forbidden from "./forbidden";

const COLORS = ["#FF6B35","#1E2A3A","#0EA5E9","#22C55E","#EAB308","#A855F7"];

function useEx<T>(path: string) {
  return useQuery<{ data: T }>({ queryKey: [path], queryFn: () => apiFetch(path) });
}

export default function ExecutiveDashboard() {
  const { can } = usePermissions();
  const kpis = useEx<any>("/executive/kpis");
  const revenue = useEx<any[]>("/executive/revenue-trend");
  const occupancy = useEx<any[]>("/executive/occupancy-by-property");
  const resolution = useEx<any>("/executive/complaints-resolution");
  const funnel = useEx<any[]>("/executive/lead-funnel");
  const headcount = useEx<any>("/executive/headcount");
  const overdue = useEx<any[]>("/executive/top-overdue");
  const breached = useEx<any[]>("/executive/top-sla-breached");

  if (!can("EXECUTIVE_DASHBOARD")) return <Forbidden />;

  const k = kpis.data?.data || {};
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

      <Card>
        <CardHeader><CardTitle>Revenue — last 12 months</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          <ResponsiveContainer>
            <AreaChart data={revenue.data?.data || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="rent" stackId="1" stroke="#FF6B35" fill="#FF6B35" />
              <Area type="monotone" dataKey="food" stackId="1" stroke="#0EA5E9" fill="#0EA5E9" />
              <Area type="monotone" dataKey="laundry" stackId="1" stroke="#22C55E" fill="#22C55E" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card>
          <CardHeader><CardTitle>Occupancy by Property</CardTitle></CardHeader>
          <CardContent style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={occupancy.data?.data || []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="property" type="category" width={100} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="occupancy" fill="#FF6B35" />
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
                  {resData.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
            <div className="text-center text-sm text-muted-foreground mt-1">{resolution.data?.data?.rate ?? 0}% resolved</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Lead Conversion Funnel</CardTitle></CardHeader>
          <CardContent style={{ height: 280 }}>
            <ResponsiveContainer>
              <FunnelChart>
                <Tooltip />
                <Funnel dataKey="count" data={funnel.data?.data || []} isAnimationActive>
                  <LabelList position="right" fill="#000" stroke="none" dataKey="stage" />
                </Funnel>
              </FunnelChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader><CardTitle>Headcount by Department</CardTitle></CardHeader>
          <CardContent style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={headcount.data?.data?.byDept || []}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="department" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#1E2A3A" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>On Leave Today</CardTitle></CardHeader>
          <CardContent>
            <div className="text-5xl font-display font-bold text-accent">{headcount.data?.data?.leavesToday ?? 0}</div>
            <p className="text-sm text-muted-foreground mt-2">employees on approved leave today</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader><CardTitle>Top Overdue Residents</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground border-b"><th className="py-2">Resident</th><th>Amount</th><th>Days Overdue</th></tr></thead>
              <tbody>
                {(overdue.data?.data || []).map((r: any) => {
                  const days = r.dueDate ? Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86400000) : 0;
                  return <tr key={r.id} className="border-b"><td className="py-2">{r.residentName || "—"}</td><td>₹{Number(r.amount).toLocaleString()}</td><td>{days}</td></tr>;
                })}
                {!(overdue.data?.data?.length) && <tr><td colSpan={3} className="py-4 text-center text-muted-foreground">No overdue payments</td></tr>}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>SLA-Breached Complaints</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground border-b"><th className="py-2">Ticket</th><th>Category</th><th>Age (days)</th></tr></thead>
              <tbody>
                {(breached.data?.data || []).map((c: any) => {
                  const age = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000);
                  return <tr key={c.id} className="border-b"><td className="py-2">{c.ticketNumber || c.id.slice(0,8)}</td><td>{c.category}</td><td>{age}</td></tr>;
                })}
                {!(breached.data?.data?.length) && <tr><td colSpan={3} className="py-4 text-center text-muted-foreground">No breached complaints</td></tr>}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
