import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, differenceInCalendarDays } from "date-fns";
import {
  Download, CalendarRange, Trash2, TrendingDown, Recycle, Building2,
  UtensilsCrossed, Soup, BookOpen, ListChecks, ClipboardList, FileText, ChevronDown,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiDownload } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import {
  foodApi, foodKeys, MEAL_LABEL,
  type WasteAnalyticsData, type WasteGranularity, type FoodLookups, type City, type Cluster,
} from "@/lib/food-api";

// Chart palette — keyed to the design-system CSS variables (mirrors food-reports).
const ACCENT = "var(--accent)";
const PRIMARY = "var(--primary)";
const WARNING = "var(--warning)";
const DESTRUCTIVE = "var(--destructive)";
const INFO = "var(--info)";

// Per-meal bar colours for the meal-type breakdown.
const MEAL_COLOR: Record<string, string> = {
  BREAKFAST: WARNING,
  LUNCH: ACCENT,
  SNACKS: INFO,
  DINNER: PRIMARY,
};

// B3-17 — export formats. xlsx → Excel via the xls encoder server-side.
type ExportFmt = "csv" | "xlsx" | "pdf";
const EXPORT_FORMATS: { key: ExportFmt; label: string }[] = [
  { key: "csv", label: "CSV" },
  { key: "xlsx", label: "Excel" },
  { key: "pdf", label: "PDF" },
];
// Each downloadable widget maps to an export `widget` key + a filename base.
type WidgetKey = "property" | "dish" | "mealtype" | "menu" | "trend";

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

export default function FoodWasteAnalytics() {
  const { toast } = useToast();
  // Data download/export is restricted to Super Admin (+ OPS parity).
  const { role } = usePermissions();
  const canExport = isSuperAdminRole(role);

  const today = format(new Date(), "yyyy-MM-dd");
  const ninetyDaysAgo = format(subDays(new Date(), 90), "yyyy-MM-dd");

  const [from, setFrom] = React.useState(ninetyDaysAgo);
  const [to, setTo] = React.useState(today);
  const [propertyId, setPropertyId] = React.useState<string>("ALL");
  const [clusterId, setClusterId] = React.useState<string>("ALL");
  const [cityId, setCityId] = React.useState<string>("ALL");
  const [brand, setBrand] = React.useState<string>("ALL");
  // Granularity follows the backend default (month if range > 60d else day) unless
  // the user pins one explicitly via the toggle.
  const rangeDays = (() => {
    try { return Math.abs(differenceInCalendarDays(new Date(to), new Date(from))); } catch { return 0; }
  })();
  const [granularityOverride, setGranularityOverride] = React.useState<WasteGranularity | "AUTO">("AUTO");
  const effectiveGranularity: WasteGranularity =
    granularityOverride === "AUTO" ? (rangeDays > 60 ? "month" : "day") : granularityOverride;

  const [downloading, setDownloading] = React.useState<WidgetKey | null>(null);

  // Lookups: properties + brands. Cities/clusters come from their own endpoints so
  // the geography filters mirror the rest of the app's scoping selects.
  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const brands = lookups?.brands ?? [];

  const { data: cities } = useQuery<City[]>({
    queryKey: foodKeys.cities(),
    queryFn: () => foodApi.listCities(),
  });
  const { data: clusters } = useQuery<Cluster[]>({
    queryKey: foodKeys.clusters(cityId === "ALL" ? undefined : cityId),
    queryFn: () => foodApi.listClusters(cityId === "ALL" ? undefined : cityId),
  });

  // Live filters → query params (ALL sentinels are dropped by qs()).
  const filters: Record<string, string> = {
    from, to, propertyId, clusterId, cityId, brand, granularity: effectiveGranularity,
  };

  const { data, isLoading, isError, error } = useQuery<WasteAnalyticsData>({
    queryKey: foodKeys.wasteAnalytics(filters),
    queryFn: () => foodApi.wasteAnalytics(filters),
  });

  React.useEffect(() => {
    if (isError) {
      toast({ title: (error as any)?.message || "Failed to load waste analytics", variant: "destructive" });
    }
  }, [isError, error, toast]);

  const summary = data?.summary;
  const byProperty = data?.byProperty ?? [];
  const byDish = data?.byDish ?? [];
  const byMealType = data?.byMealType ?? [];
  const byMenu = data?.byMenu ?? [];
  const trend = data?.trend ?? [];

  // Top-N horizontal bar series (reversed so the largest sits at the top).
  const propertyChart = byProperty.slice(0, 10).map((p) => ({
    name: p.name, wasted: p.wastedQty, wastePct: p.wastePct, city: p.city, cluster: p.cluster,
  })).reverse();
  const dishChart = byDish.slice(0, 10).map((d) => ({ name: d.name, wasted: d.wastedQty })).reverse();
  const mealChart = byMealType.map((m) => ({
    name: MEAL_LABEL[m.mealType] ?? m.mealType, mealType: m.mealType, wasted: m.wastedQty,
  }));
  const menuChart = byMenu.slice(0, 10).map((m) => ({ name: m.brand, wasted: m.wastedQty }));

  // Period tick formatter — handles both "yyyy-MM-dd" (day) and "yyyy-MM" (month).
  const periodTickFmt = (v: string) => {
    try {
      if (/^\d{4}-\d{2}$/.test(v)) return format(new Date(`${v}-01`), "MMM yy");
      return format(new Date(v), "dd MMM");
    } catch { return v; }
  };

  // ─── Export ────────────────────────────────────────────────────────────────
  // Clean params: drop ALL sentinels so the API receives only real filters.
  const buildExportParams = (): Record<string, string> => {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (!v || v === "ALL") continue;
      p[k] = v;
    }
    return p;
  };

  const exportFilename = (widget: WidgetKey, fmt: ExportFmt) =>
    `food-waste-by-${widget}-${format(new Date(), "yyyy-MM-dd")}.${fmt}`;

  const runExport = async (widget: WidgetKey, fmt: ExportFmt) => {
    setDownloading(widget);
    const filename = exportFilename(widget, fmt);
    try {
      await apiDownload(
        foodApi.wasteAnalyticsExportUrl(fmt, widget, buildExportParams()),
        filename,
      );
      toast({ title: "Export ready", description: filename });
    } catch (e: any) {
      toast({ title: e?.message || "Download failed", variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  };

  // Reusable per-widget download dropdown (CSV / Excel / PDF). Restricted to
  // Super Admin (+ OPS parity); hidden for everyone else.
  const ExportMenu = ({ widget }: { widget: WidgetKey }) => (
    !canExport ? null :
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={downloading === widget}>
          <Download className="w-3.5 h-3.5" />
          {downloading === widget ? "Preparing…" : "Export"}
          <ChevronDown className="w-3.5 h-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuLabel className="text-xs">Download as</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {EXPORT_FORMATS.map((f) => (
          <DropdownMenuItem key={f.key} onClick={() => runExport(widget, f.key)} className="gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" /> {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // When the city filter changes, clear a now-irrelevant cluster selection.
  const onCityChange = (v: string) => {
    setCityId(v);
    setClusterId("ALL");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waste Analytics"
        subtitle="Cross-property food wastage — where it happens, what's wasted, and the trend over time"
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarRange className="w-3 h-3" /> From
          </Label>
          <DatePicker value={from} max={to} onChange={setFrom} className="w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">To</Label>
          <DatePicker value={to} min={from} max={today} onChange={setTo} className="w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">City</Label>
          <Select value={cityId} onValueChange={onCityChange}>
            <SelectTrigger className="w-44"><SelectValue placeholder="City" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Cities</SelectItem>
              {(cities ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Cluster</Label>
          <Select value={clusterId} onValueChange={setClusterId}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Cluster" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Clusters</SelectItem>
              {(clusters ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
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
              {brands.map((b) => (
                <SelectItem key={b.code} value={b.code}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Range + granularity toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {(() => { try { return `${format(new Date(from), "dd MMM yyyy")} – ${format(new Date(to), "dd MMM yyyy")}`; } catch { return ""; } })()}
        </p>
        <div className="inline-flex items-center rounded-lg border border-border bg-card p-1">
          {(["day", "month"] as WasteGranularity[]).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGranularityOverride(g)}
              aria-pressed={effectiveGranularity === g}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium capitalize transition-colors ${
                effectiveGranularity === g
                  ? "bg-accent text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          title="Total Wasted"
          value={isLoading ? 0 : (summary?.totalWasted ?? 0)}
          icon={Trash2}
        />
        <StatCard
          title="Waste %"
          value={isLoading ? "0%" : `${summary?.wastePct ?? 0}%`}
          icon={TrendingDown}
        />
        <StatCard
          title="Orders with Waste"
          value={isLoading ? 0 : (summary?.ordersWithWaste ?? 0)}
          icon={ClipboardList}
        />
      </div>

      {/* Waste trend over time */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-accent" /> Waste Trend
          </CardTitle>
          <ExportMenu widget="trend" />
        </CardHeader>
        <CardContent style={{ height: 300 }}>
          {isLoading ? (
            <ChartSkeleton />
          ) : trend.length === 0 ? (
            <ChartEmpty icon={Trash2} label="No wastage recorded in this range" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="wasteTrendGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={WARNING} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={WARNING} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="period" tickFormatter={periodTickFmt} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip labelFormatter={periodTickFmt} />
                <Area type="monotone" dataKey="wastedQty" name="Wasted" stroke={WARNING} strokeWidth={2} fill="url(#wasteTrendGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top properties + Top dishes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4 text-accent" /> Top Properties by Waste
            </CardTitle>
            <ExportMenu widget="property" />
          </CardHeader>
          <CardContent style={{ height: 340 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : propertyChart.length === 0 ? (
              <ChartEmpty icon={Building2} label="No property waste in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={propertyChart} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} interval={0} />
                  <Tooltip
                    formatter={(val: any, _n: any, item: any) => [
                      `${val}`,
                      `Wasted (${item?.payload?.wastePct ?? 0}%)`,
                    ]}
                  />
                  <Bar dataKey="wasted" name="Wasted" fill={DESTRUCTIVE} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <UtensilsCrossed className="w-4 h-4 text-accent" /> Top Dishes by Waste
            </CardTitle>
            <ExportMenu widget="dish" />
          </CardHeader>
          <CardContent style={{ height: 340 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : dishChart.length === 0 ? (
              <ChartEmpty icon={UtensilsCrossed} label="No wasted dishes in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dishChart} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} interval={0} />
                  <Tooltip />
                  <Bar dataKey="wasted" name="Wasted" fill={WARNING} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Meal-type breakdown + Menu (brand) breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Soup className="w-4 h-4 text-accent" /> Meal-Type Breakdown
            </CardTitle>
            <ExportMenu widget="mealtype" />
          </CardHeader>
          <CardContent style={{ height: 320 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : !mealChart.some((m) => m.wasted) ? (
              <ChartEmpty icon={Soup} label="No meal-type waste in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mealChart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="wasted" name="Wasted" radius={[4, 4, 0, 0]}>
                    {mealChart.map((m, i) => (
                      <Cell key={i} fill={MEAL_COLOR[m.mealType] ?? PRIMARY} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-accent" /> Menu (Brand) Breakdown
            </CardTitle>
            <ExportMenu widget="menu" />
          </CardHeader>
          <CardContent style={{ height: 320 }}>
            {isLoading ? (
              <ChartSkeleton />
            ) : menuChart.length === 0 ? (
              <ChartEmpty icon={ListChecks} label="No menu waste in this range" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={menuChart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="wasted" name="Wasted" fill={ACCENT} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Empty-overall hint when nothing matches the current scope */}
      {!isLoading && !isError && (summary?.totalWasted ?? 0) === 0 && (
        <Card>
          <CardContent className="py-10">
            <ChartEmpty icon={Recycle} label="No waste data for the selected filters" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
