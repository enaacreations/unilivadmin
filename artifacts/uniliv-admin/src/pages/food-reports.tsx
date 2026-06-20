import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
  Download, CalendarRange, ClipboardList, UtensilsCrossed, Users, PieChart as PieChartIcon, BarChart3,
  FileSpreadsheet, FileText, FileDown, Trash2, Clock, TrendingDown, ChevronDown,
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiDownload } from "@/lib/api-fetch";
import {
  foodApi, foodKeys, BRANDS, ORDER_STATUSES, MEAL_LABEL,
  type ReportsData, type AnalyticsData, type MealType, type OrderStatus, type FoodLookups,
} from "@/lib/food-api";

// Chart palette — keyed to the design-system CSS variables (raw hex values).
const ACCENT = "var(--accent)";
const PRIMARY = "var(--primary)";
const SUCCESS = "var(--success)";
const WARNING = "var(--warning)";
const DESTRUCTIVE = "var(--destructive)";
const INFO = "var(--info)";
const MEAL_PALETTE = [ACCENT, PRIMARY, SUCCESS, WARNING, DESTRUCTIVE];

// Period presets — drive both the analytics `period` param and the from/to window.
type PeriodKey = "week" | "month" | "quarter" | "year";
const PERIOD_PRESETS: { key: PeriodKey; label: string; days: number }[] = [
  { key: "week", label: "Week", days: 7 },
  { key: "month", label: "Month", days: 30 },
  { key: "quarter", label: "Quarter", days: 90 },
  { key: "year", label: "Year", days: 365 },
];

// StatusBadge-aligned colors for the status breakdown chart.
const STATUS_COLOR: Record<OrderStatus, string> = {
  PLACED: "var(--info, #0EA5E9)",
  ACCEPTED: "var(--accent, #F97316)",
  REJECTED: DESTRUCTIVE,
  PREPARING: WARNING,
  DISPATCHED: "var(--info, #0EA5E9)",
  DELIVERED: SUCCESS,
  CANCELLED: DESTRUCTIVE,
};

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
  const [period, setPeriod] = React.useState<PeriodKey>("month");
  const [downloading, setDownloading] = React.useState(false);

  const filters: Record<string, string> = { from, to, status, propertyId, brand };

  // Apply a period preset: sets `period` and recomputes the from/to window.
  const applyPeriod = (p: PeriodKey) => {
    const preset = PERIOD_PRESETS.find((x) => x.key === p);
    if (!preset) return;
    setPeriod(p);
    setFrom(format(subDays(new Date(), preset.days), "yyyy-MM-dd"));
    setTo(format(new Date(), "yyyy-MM-dd"));
  };

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

  // Waste & delays analytics — reuses the same period/property/brand/date scope.
  const analyticsParams: Record<string, string> = { period, from, to };
  if (propertyId !== "ALL") analyticsParams.propertyId = propertyId;
  if (brand !== "ALL") analyticsParams.brand = brand;

  const {
    data: analytics, isLoading: analyticsLoading, isError: analyticsError, error: analyticsErr,
  } = useQuery<AnalyticsData>({
    queryKey: foodKeys.analytics(analyticsParams),
    queryFn: () => foodApi.analytics(analyticsParams),
  });

  const ordersPerDay = data?.ordersPerDay ?? [];
  const mealTypeDistribution = data?.mealTypeDistribution ?? [];
  const residentTrend = data?.residentTrend ?? [];
  const statusBreakdown = data?.statusBreakdown ?? [];

  const wastageTrend = analytics?.wastageTrend ?? [];
  const topWasteItems = analytics?.topWasteItems ?? [];
  const delays = analytics?.delays ?? [];
  const summary = analytics?.summary;

  // Shaped horizontal bar series for top-wastage items.
  const topWasteChartData = topWasteItems
    .slice(0, 8)
    .map((w) => ({
      name: w.dishName ?? "—",
      wasted: w.wasted,
      wastePct: w.wastePct,
      unit: w.unit,
    }))
    .reverse();

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

  React.useEffect(() => {
    if (analyticsError) {
      toast({ title: (analyticsErr as any)?.message || "Failed to load analytics", variant: "destructive" });
    }
  }, [analyticsError, analyticsErr, toast]);

  // Clean export params — drop ALL sentinels so the API receives only real filters.
  const exportParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v && v !== "ALL") exportParams[k] = v;
  }

  const runExport = async (fmt: "xls" | "pdf" | "csv") => {
    setDownloading(true);
    try {
      if (fmt === "xls") {
        await apiDownload(foodApi.reportsExportXlsxUrl(exportParams), "food-orders.xls");
      } else if (fmt === "pdf") {
        await apiDownload(foodApi.reportsExportPdfUrl(exportParams), "food-orders.pdf");
      } else {
        await apiDownload(foodApi.reportsExportUrl(exportParams), "food-orders.csv");
      }
      toast({ title: "Export ready", description: `food-orders.${fmt}` });
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="bg-accent hover:bg-accent/90 text-white" disabled={downloading}>
                <Download className="w-4 h-4 mr-2" />
                {downloading ? "Preparing…" : "Export"}
                <ChevronDown className="w-4 h-4 ml-2 opacity-80" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Download report</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => runExport("xls")}>
                <FileSpreadsheet className="w-4 h-4 mr-2 text-success" /> Excel (.xls)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runExport("pdf")}>
                <FileText className="w-4 h-4 mr-2 text-destructive" /> PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runExport("csv")}>
                <FileDown className="w-4 h-4 mr-2 text-muted-foreground" /> CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* KPI summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Orders" value={isLoading ? "—" : totalOrders} icon={ClipboardList} />
        <StatCard title="Avg Orders / Day" value={isLoading ? "—" : avgPerDay} icon={BarChart3} />
        <StatCard title="Peak Residents" value={isLoading ? "—" : peakResidents} icon={Users} />
        <StatCard title="Meal Types" value={isLoading ? "—" : mealTypeDistribution.length} icon={UtensilsCrossed} />
      </div>

      {/* Period segmented control */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-lg border border-border bg-card p-1">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPeriod(p.key)}
              aria-pressed={period === p.key}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                period === p.key
                  ? "bg-accent text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {format(new Date(from), "dd MMM yyyy")} – {format(new Date(to), "dd MMM yyyy")}
        </p>
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

      {/* Waste & delays analytics */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-5 h-5 text-accent" />
          <h2 className="text-lg font-display font-semibold text-foreground">Waste &amp; Delays</h2>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Total Wasted"
            value={analyticsLoading ? "—" : (summary?.totalWasted ?? 0)}
            icon={Trash2}
          />
          <StatCard
            title="Waste %"
            value={analyticsLoading ? "—" : `${summary?.wastePct ?? 0}%`}
            icon={TrendingDown}
          />
          <StatCard
            title="Delayed Deliveries"
            value={
              analyticsLoading
                ? "—"
                : `${summary?.delayedOrders ?? 0} / ${summary?.deliveredOrders ?? 0} delivered`
            }
            icon={Clock}
          />
        </div>

        {/* Wastage trend + Top wastage items */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Wastage trend */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-accent" /> Wastage Trend
              </CardTitle>
            </CardHeader>
            <CardContent style={{ height: 300 }}>
              {analyticsLoading ? (
                <ChartSkeleton />
              ) : wastageTrend.length === 0 ? (
                <ChartEmpty icon={Trash2} label="No wastage recorded in this range" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={wastageTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <defs>
                      <linearGradient id="wasteGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={WARNING} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={WARNING} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                    <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip labelFormatter={dayTickFmt} />
                    <Area type="monotone" dataKey="wasted" name="Wasted" stroke={WARNING} strokeWidth={2} fill="url(#wasteGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Top wastage items */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-accent" /> Top Wastage Items
              </CardTitle>
            </CardHeader>
            <CardContent style={{ height: 300 }}>
              {analyticsLoading ? (
                <ChartSkeleton />
              ) : topWasteChartData.length === 0 ? (
                <ChartEmpty icon={UtensilsCrossed} label="No wasted items in this range" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topWasteChartData}
                    layout="vertical"
                    margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={110}
                      tick={{ fontSize: 11 }}
                      interval={0}
                    />
                    <Tooltip
                      formatter={(val: any, _n: any, item: any) => [
                        `${val} ${item?.payload?.unit ?? ""}`.trim(),
                        `Wasted (${item?.payload?.wastePct ?? 0}%)`,
                      ]}
                    />
                    <Bar dataKey="wasted" name="Wasted" fill={DESTRUCTIVE} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Delivery delays */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent" /> Delivery Delays
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 320 }}>
            {analyticsLoading ? (
              <ChartSkeleton />
            ) : delays.length === 0 ? (
              <ChartEmpty icon={Clock} label="No delivery data in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={delays} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e5e7eb)" />
                  <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={dayTickFmt} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="total" name="Delivered" fill={INFO} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="delayed" name="Delayed" fill={WARNING} radius={[4, 4, 0, 0]} />
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
