import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, FunnelChart, Funnel, LabelList } from "recharts";
import { TrendingUp, Users, Target, Award } from "lucide-react";
import { BoundedScroll } from "@/components/ui/bounded-scroll";

const STAGE_LABELS: Record<string, string> = {
  NEW: "New", CONTACTED: "Contacted", VISIT_SCHEDULED: "Visit Scheduled", VISIT_DONE: "Visit Done",
  NEGOTIATING: "Negotiating", CONVERTED: "Converted", LOST: "Lost",
};

export default function SalesDashboard() {
  const { data: statsRes } = useQuery({ queryKey: ["leads-stats"], queryFn: () => apiFetch<any>("/leads/stats") });
  const stats = statsRes?.data;

  if (!stats) return <div className="p-8 text-muted-foreground">Loading...</div>;

  const funnelOrder = ["NEW", "CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATING", "CONVERTED"];
  const funnelData = funnelOrder.map((s) => ({ name: STAGE_LABELS[s], value: stats.stageCounts[s] || 0, fill: "var(--primary)" }));
  const sourceData = (stats.bySource || []).map((s: any) => ({ source: s.source, count: s.count }));

  return (
    <div className="space-y-6">
      <PageHeader title="Sales Dashboard" subtitle="Pipeline, conversion, and team performance" />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Leads" value={String(stats.total)} icon={Users} />
        <StatCard title="In Pipeline" value={String((stats.total || 0) - (stats.stageCounts?.CONVERTED || 0) - (stats.stageCounts?.LOST || 0))} icon={Target} />
        <StatCard title="Conversion Rate" value={`${stats.conversionRate}%`} icon={TrendingUp} />
        <StatCard title="Converted" value={String(stats.stageCounts?.CONVERTED || 0)} icon={Award} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Funnel — leads by stage</CardTitle></CardHeader>
          <CardContent style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <FunnelChart><Tooltip /><Funnel dataKey="value" data={funnelData} isAnimationActive><LabelList position="right" dataKey="name" stroke="none" fill="var(--foreground)" fontSize={12} /><LabelList position="center" dataKey="value" stroke="none" fill="var(--card)" fontSize={14} fontWeight="bold" /></Funnel></FunnelChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Lead Volume by Source</CardTitle></CardHeader>
          <CardContent style={{ height: 320 }}>
            {sourceData.length ? (
              <ResponsiveContainer width="100%" height="100%"><BarChart data={sourceData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="source" tick={{ fontSize: 11, fill: "var(--muted)" }} /><YAxis allowDecimals={false} tick={{ fill: "var(--muted)" }} /><Tooltip cursor={{ fill: "var(--surface)" }} contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)", borderRadius: "8px" }} /><Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
            ) : <p className="text-sm text-muted-foreground">No data</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Sales Team Performance</CardTitle></CardHeader>
        <CardContent className="p-0">
          <BoundedScroll size="md">
            <table className="w-full">
              <thead className="border-b sticky top-0 bg-card z-10">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left p-3">Executive</th><th className="text-right p-3">Assigned</th><th className="text-right p-3">Converted</th><th className="text-right p-3">Conversion %</th>
                </tr>
              </thead>
              <tbody>
                {(stats.performance || []).map((p: any) => (
                  <tr key={p.userId} className="border-b">
                    <td className="p-3 font-medium">{p.name}</td>
                    <td className="text-right p-3 tabular-nums">{p.assigned}</td>
                    <td className="text-right p-3 tabular-nums">{p.converted}</td>
                    <td className="text-right p-3 tabular-nums">{p.conversionRate}%</td>
                  </tr>
                ))}
                {!stats.performance?.length && <tr><td colSpan={4} className="text-center text-muted-foreground p-6">No assigned leads yet</td></tr>}
              </tbody>
            </table>
          </BoundedScroll>
        </CardContent>
      </Card>
    </div>
  );
}
