import * as React from "react";
import { useGetComplaints, getGetComplaintsQueryKey, useGetProperties, useGetResidents, useGetUsers, useCreateComplaint } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Plus, AlertCircle, CheckCircle2, Clock, Ticket } from "lucide-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { FormModal } from "@/components/ui/form-modal";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from "recharts";
import { useAppStore } from "@/lib/store";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { useScopedColumns } from "@/lib/use-scoped-columns";

const CATEGORIES = ["ELECTRICAL", "PLUMBING", "INTERNET", "HOUSEKEEPING", "SECURITY", "FOOD", "LAUNDRY", "OTHER"];
const SLA_MAP: Record<string, number> = {
  ELECTRICAL: 4, PLUMBING: 4, INTERNET: 2, HOUSEKEEPING: 8, SECURITY: 1, FOOD: 2, LAUNDRY: 24, OTHER: 24
};

function SLATimer({ deadline, slaHours }: { deadline?: string | null, slaHours: number }) {
  const [now, setNow] = React.useState(new Date().getTime());
  
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date().getTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!deadline) return <span className="text-muted-foreground">—</span>;
  
  const d = new Date(deadline).getTime();
  const diff = d - now;
  
  if (diff <= 0) {
    return <StatusBadge status="BREACHED" />;
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((diff % (1000 * 60)) / 1000);
  
  const totalMs = slaHours * 60 * 60 * 1000;
  const pct = diff / totalMs;
  const color = pct > 0.5 ? "text-success" : "text-warning";
  
  return <span className={`font-mono text-xs font-semibold ${color}`}>{hours}h {mins}m {secs}s</span>;
}

export default function Complaints() {
  const [loc, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { propertyId: globalPropertyId, setPropertyId: setGlobalProperty } = useAppStore();
  const { data: propsRes } = useGetProperties();
  const properties = propsRes?.data || [];

  const [propertyId, setPropertyId] = React.useState(globalPropertyId || "ALL");
  // One scope: the page filter writes the global property too, keeping the
  // sidebar selector + scope banner in sync (effect below mirrors the reverse).
  const selectProperty = (v: string) => {
    setPropertyId(v);
    setGlobalProperty(v === "ALL" ? null : v);
  };
  const [category, setCategory] = React.useState("ALL");
  const [status, setStatus] = React.useState("ALL");

  React.useEffect(() => {
    setPropertyId(globalPropertyId || "ALL");
  }, [globalPropertyId]);
  
  type ComplaintStats = {
    open: number;
    breached: number;
    resolvedToday: number;
    avgHours: number;
    byCategory: Record<string, number>;
    trend: { month: string; count: number }[];
    slaCompliance: { onTime: number; breach: number };
    heatmap: { day: string; date: string; counts: Record<string, number> }[];
    categories: string[];
  };
  const { data: statsRes } = useQuery({
    queryKey: ["complaints-stats", propertyId],
    queryFn: () => apiFetch<{ success: boolean; data: ComplaintStats }>(`/complaints/stats/overview${propertyId !== "ALL" ? `?propertyId=${propertyId}` : ""}`)
  });
  const stats: ComplaintStats = statsRes?.data || { open: 0, breached: 0, resolvedToday: 0, avgHours: 0, byCategory: {}, heatmap: [], trend: [], slaCompliance: { onTime: 0, breach: 0 }, categories: [] };
  const slaComplianceData = [
    { name: "On Time", value: stats.slaCompliance?.onTime || 0 },
    { name: "Breached", value: stats.slaCompliance?.breach || 0 },
  ];

  const apiParams = {
    propertyId: propertyId !== "ALL" ? propertyId : undefined,
    category: category !== "ALL" ? category : undefined,
    status: status !== "ALL" ? status : undefined,
    limit: 100,
  } as any;

  const { data: complaintsRes, isLoading } = useGetComplaints(apiParams, {
    query: { queryKey: getGetComplaintsQueryKey(apiParams) },
  });
  
  const complaints = complaintsRes?.data || [];

  const [createOpen, setCreateOpen] = React.useState(false);

  const columns = [
    { accessorKey: "ticketNo", header: "Ticket #", cell: ({row}: any) => <span className="font-mono text-xs text-primary">{row.original.ticketNo}</span> },
    { accessorKey: "propertyName", header: "Property", cell: ({row}: any) => row.original.propertyName || "—" },
    { accessorKey: "category", header: "Category", cell: ({row}: any) => <Badge variant="outline">{row.original.category}</Badge> },
    { accessorKey: "title", header: "Title", cell: ({row}: any) => <span className="font-medium">{row.original.title}</span> },
    { accessorKey: "residentName", header: "Resident", cell: ({row}: any) => row.original.residentName || "—" },
    { accessorKey: "priority", header: "Priority", cell: ({row}: any) => <StatusBadge status={row.original.priority} /> },
    { accessorKey: "status", header: "Status", cell: ({row}: any) => <StatusBadge status={row.original.status} /> },
    { id: "sla", header: "SLA Timer", cell: ({row}: any) => row.original.status !== "RESOLVED" && row.original.status !== "CLOSED" ? <SLATimer deadline={row.original.slaDeadline} slaHours={row.original.slaHours} /> : "—" },
    { accessorKey: "createdAt", header: "Created", cell: ({row}: any) => new Date(row.original.createdAt).toLocaleDateString() },
  ];
  const scopedColumns = useScopedColumns(columns, { singleProperty: ["propertyName"] });

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Complaint Management" 
        subtitle="Track and resolve resident issues"
        action={
          <Button onClick={() => setCreateOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" /> Raise Complaint
          </Button>
        }
      />

      <GlobalPropertyScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Open" value={stats.open} icon={Ticket} />
        <StatCard title="SLA Breached" value={stats.breached} icon={AlertCircle} className={stats.breached > 0 ? "border-destructive/50 bg-destructive/5" : ""} />
        <StatCard title="Resolved Today" value={stats.resolvedToday} icon={CheckCircle2} />
        <StatCard title="Avg Resolution (Hrs)" value={stats.avgHours} icon={Clock} />
      </div>

      <Tabs defaultValue="tickets">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="tickets">Tickets</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="tickets" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={propertyId} onValueChange={selectProperty}>
              <SelectTrigger className="w-[180px]"><SelectValue placeholder="Property" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Properties</SelectItem>
                {properties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Categories</SelectItem>
                {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Status</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <DataTable
            columns={scopedColumns as any}
            data={complaints}
            isLoading={isLoading}
            onRowClick={(row) => setLocation(`/complaints/${row.id}`)}
          />
        </TabsContent>

        <TabsContent value="analytics">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="border border-border rounded-lg p-4 bg-card">
              <h3 className="font-display font-semibold mb-4">Trend (Last 6 Months)</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stats.trend || []}>
                    <XAxis dataKey="month" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{fill: 'transparent'}} />
                    <Line type="monotone" dataKey="count" stroke="var(--accent)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="border border-border rounded-lg p-4 bg-card">
              <h3 className="font-display font-semibold mb-4">SLA Compliance</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={slaComplianceData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={80}>
                      <Cell fill="var(--success)" />
                      <Cell fill="var(--danger)" />
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <CreateComplaintModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateComplaintModal({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const { data: propsRes } = useGetProperties();
  const { data: resRes } = useGetResidents();
  const mut = useCreateComplaint();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    propertyId: "", residentId: "", category: "OTHER", subCategory: "", title: "", description: "", priority: "MEDIUM", slaHours: 24
  });

  const onSave = async () => {
    if(!form.propertyId || !form.category || !form.title || !form.description) { toast({ title: "Fill required fields", variant: "destructive" }); return; }
    try {
      await mut.mutateAsync({ data: form });
      toast({ title: "Complaint raised" });
      qc.invalidateQueries({ queryKey: getGetComplaintsQueryKey() });
      onOpenChange(false);
    } catch(e: any) {
      toast({ title: e.message || "Failed", variant: "destructive" });
    }
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Raise Complaint" onSave={onSave} isSaving={mut.isPending}>
      <div className="space-y-4">
        <div>
          <Label>Property *</Label>
          <Select value={form.propertyId} onValueChange={v => setForm({...form, propertyId: v})}>
            <SelectTrigger><SelectValue placeholder="Select Property" /></SelectTrigger>
            <SelectContent>
              {propsRes?.data?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Resident</Label>
          <Select value={form.residentId} onValueChange={v => setForm({...form, residentId: v})}>
            <SelectTrigger><SelectValue placeholder="Select Resident (Optional)" /></SelectTrigger>
            <SelectContent>
              {resRes?.data?.filter(r => !form.propertyId || r.propertyId === form.propertyId).map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Category *</Label>
          <Select value={form.category} onValueChange={v => setForm({...form, category: v, slaHours: SLA_MAP[v] || 24})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Expected SLA: {form.slaHours} hours</p>
        </div>
        <div>
          <Label>Priority *</Label>
          <Select value={form.priority} onValueChange={v => setForm({...form, priority: v})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="LOW">Low</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Title *</Label>
          <Input value={form.title} onChange={e => setForm({...form, title: e.target.value})} />
        </div>
        <div>
          <Label>Description *</Label>
          <Textarea rows={4} value={form.description} onChange={e => setForm({...form, description: e.target.value})} />
        </div>
      </div>
    </FormModal>
  )
}
import { Badge } from "@/components/ui/badge";
