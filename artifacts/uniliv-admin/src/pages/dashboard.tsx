import type { ReactNode } from "react";
import { useGetDashboardStats, getGetDashboardStatsQueryKey, useGetDashboardCharts, getGetDashboardChartsQueryKey, useGetComplaints, getGetComplaintsQueryKey, useGetResidents, getGetResidentsQueryKey, useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building, Users, AlertCircle, TrendingUp, LayoutDashboard } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { StatCard } from "@/components/stat-card";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatDistanceToNow } from "date-fns";
import { usePermissions } from "@/lib/use-permissions";
import { useScopedColumns } from "@/lib/use-scoped-columns";
import { useAppStore } from "@/lib/store";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { can, me } = usePermissions();
  const { propertyId } = useAppStore(); // sidebar property scope
  const scope = propertyId ?? undefined;

  // What this role can actually work with — the dashboard adapts to it.
  const showResidents = can("RESIDENTS", "view");
  const showComplaints = can("COMPLAINTS", "view");
  const showOccupancy = can("PROPERTIES", "view");
  const showFinance = can("PAYMENTS", "view") || can("LEDGER", "view") || can("WALLET", "view");
  const showCharts = showResidents || showComplaints || showOccupancy;

  const { data: statsRes, isLoading: statsLoading } = useGetDashboardStats({ propertyId: scope } as any, { query: { queryKey: getGetDashboardStatsQueryKey({ propertyId: scope } as any) } });
  const { data: chartsRes, isLoading: chartsLoading } = useGetDashboardCharts(undefined, { query: { queryKey: getGetDashboardChartsQueryKey(), enabled: showCharts } });
  const { data: complaintsRes, isLoading: complaintsLoading } = useGetComplaints({ limit: 5, propertyId: scope } as any, { query: { queryKey: getGetComplaintsQueryKey({ limit: 5, propertyId: scope } as any), enabled: showComplaints } });
  const { data: residentsRes, isLoading: residentsLoading } = useGetResidents({ limit: 5, propertyId: scope } as any, { query: { queryKey: getGetResidentsQueryKey({ limit: 5, propertyId: scope } as any), enabled: showResidents } });
  const { data: propertiesRes, isLoading: propertiesLoading } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey(), enabled: showOccupancy } });

  const stats = statsRes?.data;
  const charts = chartsRes?.data;
  const complaints = complaintsRes?.data || [];
  const residents = residentsRes?.data || [];
  const properties = propertiesRes?.data || [];

  const complaintCols = [
    { accessorKey: "ticketNo", header: "Ticket No" },
    { accessorKey: "category", header: "Category" },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
    {
      accessorKey: "createdAt", header: "Age",
      cell: ({ row }: any) => {
        try { return formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true }); }
        catch { return "Unknown"; }
      },
    },
  ];

  const residentCols = [
    { accessorKey: "name", header: "Resident" },
    { accessorKey: "propertyName", header: "Property" },
    { accessorKey: "roomNumber", header: "Room" },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
  ];

  // Property column is constant for property-scoped viewers (unit leads/wardens).
  const scopedResidentCols = useScopedColumns(residentCols, { singleProperty: ["propertyName"] });

  const propertyData = properties.map(p => ({
    name: p.name,
    Occupied: p.occupiedBeds || 0,
    Total: p.totalBeds || 0,
    rate: p.totalBeds ? Math.round((p.occupiedBeds / p.totalBeds) * 100) : 0,
  }));

  // Permission-gated stat cards.
  const cards: ReactNode[] = [];
  if (showResidents || showOccupancy) {
    cards.push(
      <StatCard key="residents" title="Total Residents (Active)" value={statsLoading ? "..." : (stats?.totalResidents || 0)} icon={Users} />,
      <StatCard key="occupancy" title="Occupancy Rate" value={statsLoading ? "..." : `${stats?.occupancyRate || 0}%`} icon={TrendingUp} />,
    );
  }
  if (showComplaints) {
    cards.push(<StatCard key="complaints" title="Open Complaints" value={statsLoading ? "..." : (stats?.openComplaints || 0)} icon={AlertCircle} />);
  }
  if (showFinance) {
    cards.push(<StatCard key="overdue" title="Overdue Payments" value={statsLoading ? "..." : `₹${(stats?.pendingPayments || 0).toLocaleString("en-IN")}`} icon={Building} />);
  }

  const hasContent = cards.length > 0 || showCharts || showComplaints || showResidents;

  if (!hasContent) {
    const first = me?.name?.split(" ")[0];
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-20 text-center">
          <LayoutDashboard className="h-10 w-10 text-muted-foreground" />
          <p className="text-base font-medium">Welcome{first ? `, ${first}` : ""}</p>
          <p className="max-w-sm text-sm text-muted-foreground">Use the menu on the left to get to your work. Your overview shows up here once you have modules with dashboard data.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <GlobalPropertyScopeBanner />

      {cards.length > 0 && (
        <div className="grid gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">{cards}</div>
      )}

      {showCharts && (
        <Tabs defaultValue={(showResidents || showComplaints) ? "trend" : "occupancy"}>
          <TabsList>
            {(showResidents || showComplaints) && <TabsTrigger value="trend">Trend &amp; Complaints</TabsTrigger>}
            {showOccupancy && <TabsTrigger value="occupancy">Occupancy by Property</TabsTrigger>}
          </TabsList>

          {(showResidents || showComplaints) && (
            <TabsContent value="trend" className="grid gap-6 grid-cols-1 lg:grid-cols-2">
              {showResidents && (
                <Card>
                  <CardHeader><CardTitle className="font-display">Resident Trend</CardTitle></CardHeader>
                  <CardContent className="h-[300px]">
                    {chartsLoading ? <Skeleton className="w-full h-full" /> : (
                      charts?.occupancyTrend && charts.occupancyTrend.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={charts.occupancyTrend}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dy={10} />
                            <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dx={-10} />
                            <RechartsTooltip cursor={{ stroke: 'var(--border)' }} contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px' }} />
                            <Line type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={3} dot={{ r: 4, strokeWidth: 2, fill: 'var(--card)' }} activeDot={{ r: 6 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
                    )}
                  </CardContent>
                </Card>
              )}

              {showComplaints && (
                <Card>
                  <CardHeader><CardTitle className="font-display">Complaints by Category</CardTitle></CardHeader>
                  <CardContent className="h-[300px]">
                    {chartsLoading ? <Skeleton className="w-full h-full" /> : (
                      charts?.complaintsByCategory && charts.complaintsByCategory.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={charts.complaintsByCategory} layout="vertical" margin={{ left: 50 }}>
                            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                            <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                            <YAxis dataKey="label" type="category" axisLine={false} tickLine={false} tick={{ fill: 'var(--primary)', fontSize: 12 }} dx={-10} />
                            <RechartsTooltip cursor={{ fill: 'var(--surface)' }} contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px' }} />
                            <Bar dataKey="value" fill="var(--primary)" radius={[0, 4, 4, 0]} barSize={24} />
                          </BarChart>
                        </ResponsiveContainer>
                      ) : <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          )}

          {showOccupancy && (
            <TabsContent value="occupancy">
              <Card>
                <CardHeader><CardTitle className="font-display">Occupancy by Property</CardTitle></CardHeader>
                <CardContent className="h-[400px]">
                  {propertiesLoading ? <Skeleton className="w-full h-full" /> : (
                    propertyData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={propertyData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                          <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dy={10} angle={-45} textAnchor="end" height={60} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dx={-10} />
                          <RechartsTooltip cursor={{ fill: 'var(--surface)' }} contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px' }} />
                          <Bar dataKey="Occupied" stackId="a" fill="var(--accent)" radius={[0, 0, 4, 4]} />
                          <Bar dataKey="Total" stackId="a" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      )}

      {(showComplaints || showResidents) && (
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
          {showComplaints && (
            <Card className="overflow-hidden flex flex-col">
              <CardHeader className="border-b bg-surface/50 pb-4"><CardTitle className="font-display text-base">Recent Complaints</CardTitle></CardHeader>
              <div className="p-0 flex-1">
                <DataTable columns={complaintCols} data={complaints} isLoading={complaintsLoading} onRowClick={(row: any) => setLocation(`/complaints/${row.id}`)} />
              </div>
            </Card>
          )}

          {showResidents && (
            <Card className="overflow-hidden flex flex-col">
              <CardHeader className="border-b bg-surface/50 pb-4"><CardTitle className="font-display text-base">Recent Residents</CardTitle></CardHeader>
              <div className="p-0 flex-1">
                <DataTable columns={scopedResidentCols} data={residents} isLoading={residentsLoading} onRowClick={(row: any) => setLocation(`/residents/${row.id}`)} />
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
