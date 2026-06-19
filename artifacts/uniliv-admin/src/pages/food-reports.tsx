import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
  Download, CalendarRange, ClipboardList, UtensilsCrossed, Users, PieChart as PieChartIcon, BarChart3,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, BRANDS, ORDER_STATUSES, MEAL_LABEL,
  type ReportsData, type MealType, type OrderStatus, type FoodLookups,
} from "@/lib/food-api";

// Chart palette — keyed to the design-system CSS variables (raw hex values).
const ACCENT = "var(--accent)";
const PRIMARY = "var(--primary)";
const SUCCESS = "var(--success)";
const WARNING = "var(--warning)";
const DESTRUCTIVE = "var(--destructive)";
const MEAL_PALETTE = [ACCENT, PRIMARY, SUCCESS, WARNING, DESTRUCTIVE];

// StatusBadge-aligned colors for the status breakdown chart.
const STATUS_COLOR: Record<OrderStatus, string> = {
  PLACED: "var(--info, #0EA5E9)",
  PREPARING: WARNING,
  DISPATCHED: "var(--info, #0EA5E9)",
  DELIVERED: SUCCESS,
  CANCELLED: DESTRUCTIVE,
};

function buildQuery(p: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v && v !== "ALL") sp.set(k, v);
  }
  return sp.toString();
}

/** Small empty state shown inside a chart card when its dataset is empty. */
function ChartEmpty({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
      <Icon className="w-8 h-8 opacity-40" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full flex items-end gap-2 px-2 pb-2">
      {[60, 80, 45, 90, 70, 55, 75].map((h, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export default function FoodReports() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const today = format(new Date(), "yyyy-MM-dd");
  const thirtyDaysAgo = format(subDays(new Date(), 30), "yyyy-MM-dd");

  const [from, setFrom] = React.useState(thirtyDaysAgo);
  const [to, setTo] = React.useState(today);
  const [status, setStatus] = React.useState<string>("ALL");
  const [propertyId, setPropertyId] = React.useState<string>("ALL");
  const [brand, setBrand] = React.useState<string>("ALL");
  const [downloading, setDownloading] = React.useState(false);

  const filters: Record<string, string> = { from, to, status, propertyId, brand };

  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name || "—") : "—";

  const { data, isLoading, isError, error } = useQuery<ReportsData>({
    queryKey: foodKeys.reports(filters),
    queryFn: () => foodApi.reports(filters),
  });

  const ordersPerDay = data?.ordersPerDay ?? [];
  const mealTypeDistribution = data?.mealTypeDistribution ?? [];
  const residentTrend = data?.residentTrend ?? [];
  const statusBreakdown = data?.statusBreakdown ?? [];

  // Derived headline metrics.
  const totalOrders = ordersPerDay.reduce((s, d) => s + (d.count || 0), 0);
  const peakResidents = residentTrend.reduce((m, d) => Math.max(m, d.residents || 0), 0);
  const activeDays = ordersPerDay.filter((d) => (d.count || 0) > 0).length;
  const avgPerDay = activeDays ? Math.round((totalOrders / activeDays) * 10) / 10 : 0;

  // Shaped chart series.
  const mealChartData = mealTypeDistribution.map((m) => ({
    name: MEAL_LABEL[m.mealType as MealType] ?? m.mealType,
    value: m.count,
    mealType: m.mealType,
  }));
  const statusChartData = statusBreakdown.map((s) => ({
    name: (s.status || "").replace(/_/g, " "),
    value: s.count,
    status: s.status,
  }));
  const dayTickFmt = (v: string) => {
    try { return format(new Date(v), "dd MMM"); } catch { return v; }
  };

  React.useEffect(() => {
    if (isError) {
      toast({ title: (error as any)?.message || "Failed to load reports", variant: "destructive" });
    }
  }, [isError, error, toast]);

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const query = buildQuery(filters);
      const token = localStorage.getItem("uniliv_token");
      const res = await fetch(`/api/food/reports/export${query ? `?${query}` : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "food-orders.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "CSV downloaded", description: "food-orders.csv" });
    } catch (e: any) {
      toast({ title: e?.message || "Download failed", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Food Reports"
        subtitle="Order volume, meal mix, resident demand, and fulfilment status"
        action={
          <Button
            className="bg-accent hover:bg-accent/90 text-white"
            onClick={downloadCsv}
            disabled={downloading}
          >
            <Download className="w-4 h-4 mr-2" />
            {downloading ? "Preparing…" : "Download CSV"}
          </Button>
        }
      />

      {/* KPI summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Orders" value={isLoading ? "—" : totalOrders} icon={ClipboardList} />
        <StatCard title="Avg Orders / Day" value={isLoading ? "—" : avgPerDay} icon={BarChart3} />
        <StatCard title="Peak Residents" value={isLoading ? "—" : peakResidents} icon={Users} />
        <StatCard title="Meal Types" value={isLoading ? "—" : mealTypeDistribution.length} icon={UtensilsCrossed} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarRange className="w-3 h-3" /> From
          </Label>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Statuses</SelectItem>
              {ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Property</Label>
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger className="w-52"><SelectValue placeholder="Property" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Properties</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Brand</Label>
          <Select value={brand} onValueChange={setBrand}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Brands</SelectItem>
              {BRANDS.map((b) => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 1) Orders per day */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-accent" /> Orders per Day
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : ordersPerDay.length === 0 ? (
              <ChartEmpty icon={ClipboardList} label="No orders in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ordersPerDay} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ordersGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={ACCENT} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                  <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={dayTickFmt} />
                  <Area type="monotone" dataKey="count" name="Orders" stroke={ACCENT} strokeWidth={2} fill="url(#ordersGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 2) Meal-type distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PieChartIcon className="w-4 h-4 text-accent" /> Meal-type Distribution
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : mealChartData.length === 0 ? (
              <ChartEmpty icon={UtensilsCrossed} label="No meal data in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={mealChartData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                    label={(e: any) => `${e.value}`}
                  >
                    {mealChartData.map((_, i) => (
                      <Cell key={i} fill={MEAL_PALETTE[i % MEAL_PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 3) Resident trend */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-accent" /> Resident Trend
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : residentTrend.length === 0 ? (
              <ChartEmpty icon={Users} label="No resident data in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={residentTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                  <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={dayTickFmt} />
                  <Line type="monotone" dataKey="residents" name="Residents" stroke={PRIMARY} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 4) Status breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-accent" /> Status Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : statusChartData.length === 0 ? (
              <ChartEmpty icon={ClipboardList} label="No status data in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="Orders" radius={[4, 4, 0, 0]}>
                    {statusChartData.map((d, i) => (
                      <Cell key={i} fill={STATUS_COLOR[d.status as OrderStatus] ?? PRIMARY} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Property filter context footnote */}
      {propertyId !== "ALL" && (
        <p className="text-xs text-muted-foreground">
          Showing data scoped to{" "}
          <button
            type="button"
            className="text-accent hover:underline font-medium"
            onClick={() => setLocation("/food/orders")}
          >
            {propName(propertyId)}
          </button>
          .
        </p>
      )}
    </div>
  );
}
