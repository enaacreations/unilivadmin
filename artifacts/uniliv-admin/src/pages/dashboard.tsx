import { useGetDashboardStats, getGetDashboardStatsQueryKey, useGetDashboardCharts, getGetDashboardChartsQueryKey, useGetComplaints, getGetComplaintsQueryKey, useGetResidents, getGetResidentsQueryKey, useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building, Users, AlertCircle, TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { StatCard } from "@/components/stat-card";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { formatDistanceToNow } from "date-fns";

export default function Dashboard() {
  const { data: statsRes, isLoading: statsLoading } = useGetDashboardStats({ query: { queryKey: getGetDashboardStatsQueryKey() } });
  const { data: chartsRes, isLoading: chartsLoading } = useGetDashboardCharts({ query: { queryKey: getGetDashboardChartsQueryKey() } });
  const { data: complaintsRes, isLoading: complaintsLoading } = useGetComplaints({ limit: 5 } as any, { query: { queryKey: getGetComplaintsQueryKey({ limit: 5 } as any) } });
  const { data: residentsRes, isLoading: residentsLoading } = useGetResidents({ limit: 5 } as any, { query: { queryKey: getGetResidentsQueryKey({ limit: 5 } as any) } });
  const { data: propertiesRes, isLoading: propertiesLoading } = useGetProperties({ query: { queryKey: getGetPropertiesQueryKey() } });

  const stats = statsRes?.data;
  const charts = chartsRes?.data;
  const complaints = complaintsRes?.data || [];
  const residents = residentsRes?.data || [];
  const properties = propertiesRes?.data || [];

  const COLORS = ['#F97316', '#0F172A', '#16A34A', '#D97706', '#DC2626'];

  const complaintCols = [
    {
      accessorKey: "ticketNo",
      header: "Ticket No",
    },
    {
      accessorKey: "category",
      header: "Category",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    },
    {
      accessorKey: "createdAt",
      header: "Age",
      cell: ({ row }: any) => {
        try {
          return formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })
        } catch(e) {
          return "Unknown"
        }
      }
    }
  ];

  const residentCols = [
    {
      accessorKey: "name",
      header: "Resident",
    },
    {
      accessorKey: "propertyName",
      header: "Property",
    },
    {
      accessorKey: "roomNumber",
      header: "Room",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    }
  ];

  const propertyData = properties.map(p => ({
    name: p.name,
    Occupied: p.occupiedBeds || 0,
    Total: p.totalBeds || 0,
    rate: p.totalBeds ? Math.round((p.occupiedBeds / p.totalBeds) * 100) : 0
  }));

  return (
    <div className="space-y-6">
      
      {/* Row 1: StatCards */}
      <div className="grid gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Residents (Active)"
          value={statsLoading ? "..." : (stats?.totalResidents || 0)}
          icon={Users}
          change={2.5}
        />
        <StatCard
          title="Occupancy Rate"
          value={statsLoading ? "..." : `${stats?.occupancyRate || 0}%`}
          icon={TrendingUp}
          change={1.2}
        />
        <StatCard
          title="Open Complaints"
          value={statsLoading ? "..." : (stats?.openComplaints || 0)}
          icon={AlertCircle}
          change={-5.4}
        />
        <StatCard
          title="Overdue Payments"
          value={statsLoading ? "..." : (stats?.pendingPayments || 0)}
          icon={Building}
          change={8.1}
        />
      </div>

      {/* Row 2: Charts */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="font-display">Resident Trend</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {chartsLoading ? <Skeleton className="w-full h-full" /> : (
              charts?.occupancyTrend && charts.occupancyTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={charts.occupancyTrend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{fill: 'var(--muted)', fontSize: 12}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: 'var(--muted)', fontSize: 12}} dx={-10} />
                    <RechartsTooltip cursor={{stroke: 'var(--border)'}} contentStyle={{backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px'}} />
                    <Line type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={3} dot={{r: 4, strokeWidth: 2, fill: 'var(--card)'}} activeDot={{r: 6}} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
              )
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="font-display">Complaints by Category</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {chartsLoading ? <Skeleton className="w-full h-full" /> : (
              charts?.complaintsByCategory && charts.complaintsByCategory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={charts.complaintsByCategory} layout="vertical" margin={{ left: 50 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{fill: 'var(--muted)', fontSize: 12}} />
                    <YAxis dataKey="label" type="category" axisLine={false} tickLine={false} tick={{fill: 'var(--primary)', fontSize: 12}} dx={-10} />
                    <RechartsTooltip cursor={{fill: 'var(--surface)'}} contentStyle={{backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px'}} />
                    <Bar dataKey="value" fill="var(--primary)" radius={[0, 4, 4, 0]} barSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
              )
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Tables */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        <Card className="shadow-sm overflow-hidden flex flex-col">
          <CardHeader className="border-b bg-surface/50 pb-4">
            <CardTitle className="font-display text-base">Recent Complaints</CardTitle>
          </CardHeader>
          <div className="p-0 flex-1">
            <DataTable 
              columns={complaintCols} 
              data={complaints} 
              isLoading={complaintsLoading}
            />
          </div>
        </Card>
        
        <Card className="shadow-sm overflow-hidden flex flex-col">
          <CardHeader className="border-b bg-surface/50 pb-4">
            <CardTitle className="font-display text-base">Recent Residents</CardTitle>
          </CardHeader>
          <div className="p-0 flex-1">
            <DataTable 
              columns={residentCols} 
              data={residents} 
              isLoading={residentsLoading}
            />
          </div>
        </Card>
      </div>

      {/* Row 4: Full width Property Occupancy */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="font-display">Occupancy by Property</CardTitle>
        </CardHeader>
        <CardContent className="h-[400px]">
          {propertiesLoading ? <Skeleton className="w-full h-full" /> : (
            propertyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={propertyData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: 'var(--muted)', fontSize: 12}} dy={10} angle={-45} textAnchor="end" height={60} />
                  <YAxis axisLine={false} tickLine={false} tick={{fill: 'var(--muted)', fontSize: 12}} dx={-10} />
                  <RechartsTooltip cursor={{fill: 'var(--surface)'}} contentStyle={{backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '8px'}} />
                  <Bar dataKey="Occupied" stackId="a" fill="var(--accent)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="Total" stackId="a" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted text-sm border border-dashed rounded-lg">No data available</div>
            )
          )}
        </CardContent>
      </Card>

    </div>
  );
}
