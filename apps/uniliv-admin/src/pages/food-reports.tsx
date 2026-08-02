import * as React from "react";
import { useLocation } from "wouter";
import { withQuery } from "@/lib/nav-helpers";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
  ArrowRight, Check, Clock, Download, Settings2, Timer, Trash2, Trophy, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { apiDownload } from "@/lib/api-fetch";
import {
  foodApi, foodKeys, BRANDS,
  type ReportsData, type AnalyticsData, type FoodLookups,
  type OnTimeReport, type OnTimeTolerance, type VarianceByDayData, type MealType,
} from "@/lib/food-api";

// Period presets — drive both the analytics `period` param and the from/to window.
type PeriodKey = "week" | "month" | "quarter" | "year";
const PERIOD_PRESETS: { key: PeriodKey; label: string; days: number }[] = [
  { key: "week", label: "Week", days: 7 },
  { key: "month", label: "Month", days: 30 },
  { key: "quarter", label: "Quarter", days: 90 },
  { key: "year", label: "Year", days: 365 },
];

// O17 — variance-by-day meal filter badges. "All" sends no mealType.
type MealFilter = "ALL" | MealType;
const MEAL_FILTERS: { key: MealFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "BREAKFAST", label: "Breakfast" },
  { key: "LUNCH", label: "Lunch" },
  { key: "SNACKS", label: "High Tea" },
  { key: "DINNER", label: "Dinner" },
];

// O20 — export formats + the report widgets that can be downloaded.
type ExportFmt = "csv" | "xls" | "pdf";
const EXPORT_FORMATS: { key: ExportFmt; label: string }[] = [
  { key: "csv", label: "CSV" },
  { key: "xls", label: "Excel" },
  { key: "pdf", label: "PDF" },
];
type ExportReport = "orders" | "variance" | "waste" | "ontime";
const EXPORT_REPORTS: { key: ExportReport; label: string; base: string }[] = [
  { key: "orders", label: "Food Orders", base: "food-orders" },
  { key: "variance", label: "Variance", base: "food-variance" },
  { key: "waste", label: "Waste", base: "food-waste" },
  { key: "ontime", label: "On-time", base: "food-ontime" },
];

// Prototype bar colors (brand gradient tint) — inline styles per the style kit.
const BAR_GRAD = "linear-gradient(180deg,#FF9A3D,#F2603C)";
const BAR_TINT = "color-mix(in srgb, #F2603C 22%, var(--muted-bg))";
const BAR_OK = "var(--success)";
const BAR_OK_TINT = "color-mix(in srgb, var(--success) 30%, var(--muted-bg))";
const BAR_OVER = "var(--warning)";

/** Skeleton shaped like the 7-bar chart while a widget loads. */
function BarsSkeleton() {
  return (
    <div className="flex h-full w-full items-end gap-2">
      {[60, 80, 45, 90, 70, 55, 75].map((h, i) => (
        <Skeleton key={i} className="flex-1 rounded-[6px]" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

/** Small empty state shown inside a chart card when its dataset is empty. */
function BarsEmpty({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      <Icon className="h-6 w-6 opacity-40" />
      <p className="text-xs">{label}</p>
    </div>
  );
}

export default function FoodReports() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const today = format(new Date(), "yyyy-MM-dd");
  const thirtyDaysAgo = format(subDays(new Date(), 30), "yyyy-MM-dd");

  const [from, setFrom] = React.useState(thirtyDaysAgo);
  const [to, setTo] = React.useState(today);
  const [propertyId, setPropertyId] = React.useState<string>("ALL");
  const [brand, setBrand] = React.useState<string>("ALL");
  const [period, setPeriod] = React.useState<PeriodKey>("month");
  const [downloading, setDownloading] = React.useState(false);

  // Same key shape as before; the status dimension is fixed to ALL in this view.
  const filters: Record<string, string> = { from, to, status: "ALL", propertyId, brand };

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

  // O15 — on-time delivery report (% on-time + per-day on-time/late trend).
  const onTimeParams: Record<string, string> = { period, from, to };
  if (propertyId !== "ALL") onTimeParams.propertyId = propertyId;
  if (brand !== "ALL") onTimeParams.brand = brand;

  const {
    data: onTime, isLoading: onTimeLoading,
  } = useQuery<OnTimeReport>({
    queryKey: foodKeys.reportsOnTime(onTimeParams),
    queryFn: () => foodApi.reportsOnTime(onTimeParams),
  });

  // O16 — global on-time tolerance (read by any food user, written by SUPER_ADMIN).
  const { role } = usePermissions();
  const isSuperAdmin = isSuperAdminRole(role);

  const { data: tolerance } = useQuery<OnTimeTolerance>({
    queryKey: foodKeys.ontimeTolerance(),
    queryFn: () => foodApi.ontimeTolerance(),
  });
  // Local draft for the tolerance editor; reseeds when the server value loads.
  const [toleranceDraft, setToleranceDraft] = React.useState<string>("");
  React.useEffect(() => {
    if (tolerance) setToleranceDraft(String(tolerance.minutes));
  }, [tolerance?.minutes]);

  const saveTolerance = useMutation({
    mutationFn: (minutes: string) => foodApi.updateOntimeTolerance(minutes),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: foodKeys.ontimeTolerance() });
      // Refetch the on-time calc so the % reflects the new tolerance.
      qc.invalidateQueries({ queryKey: ["food", "reports-ontime"] });
      setToleranceDraft(String(data.minutes));
      toast({ title: "Tolerance updated", description: `On-time within ${data.minutes} minutes` });
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to save tolerance", variant: "destructive" }),
  });

  // O17 — ordered-vs-received variance per service-day, filterable by meal badge.
  const [mealFilter, setMealFilter] = React.useState<MealFilter>("ALL");
  const varianceByDayParams: Record<string, string> = { from, to, period };
  if (propertyId !== "ALL") varianceByDayParams.propertyId = propertyId;
  if (mealFilter !== "ALL") varianceByDayParams.mealType = mealFilter;

  const {
    data: varianceByDay, isLoading: varianceByDayLoading,
  } = useQuery<VarianceByDayData>({
    queryKey: foodKeys.reportsVarianceByDay(varianceByDayParams),
    queryFn: () => foodApi.reportsVarianceByDay(varianceByDayParams),
  });
  const varianceByDayRows = varianceByDay?.rows ?? [];

  const ordersPerDay = data?.ordersPerDay ?? [];
  const residentTrend = data?.residentTrend ?? [];
  const summary = analytics?.summary;

  // Derived headline metrics (shown as footnotes under the bar cards).
  const totalOrders = ordersPerDay.reduce((s, d) => s + (d.count || 0), 0);
  const peakResidents = residentTrend.reduce((m, d) => Math.max(m, d.residents || 0), 0);

  const weekday = (v: string) => {
    try { return format(new Date(v), "EEE"); } catch { return v; }
  };

  // ---- "People fed daily" — last 7 days of the resident trend, hand-rolled bars.
  const peopleBars = residentTrend.slice(-7);
  const peopleMax = peopleBars.reduce((m, d) => Math.max(m, d.residents || 0), 0);
  // Heights are relative to max * 1.07 so the tallest bar leaves headroom for its label.
  const peopleHeight = (v: number) =>
    peopleMax > 0 ? Math.round((v / (peopleMax * 1.07)) * 100) : 0;

  // ---- "Food waste %" — last 7 variance days, pct = wasted/ordered per day.
  const wasteRows = varianceByDayRows.slice(-7);
  const wasteBars = wasteRows.map((r) => ({
    date: r.date,
    wasted: r.wasted || 0,
    pct: r.ordered > 0 ? ((r.wasted || 0) / r.ordered) * 100 : 0,
  }));
  // Scale floor of 4% keeps within-goal (<=3%) bars visually low, like the prototype.
  const wasteMax = Math.max(4, ...wasteBars.map((b) => b.pct));
  const wasteHeight = (pct: number) => Math.round((pct / (wasteMax * 1.07)) * 100);

  // ---- Milestones, derived client-side from the widgets' data.
  // (a) Zero-waste week — earned when every one of the last 7 variance days
  //     recorded zero waste; otherwise in progress at zeroDays/7.
  const zeroDays = wasteRows.filter((r) => (r.wasted || 0) === 0).length;
  const zeroWasteEarned = wasteRows.length === 7 && zeroDays === 7;
  // (b) Mismatch-free deliveries — consecutive most-recent days where ordered ==
  //     received (variance 0), scanned backwards from the latest day. Target: 8.
  const MISMATCH_TARGET = 8;
  let mismatchRun = 0;
  for (let i = varianceByDayRows.length - 1; i >= 0; i--) {
    if ((varianceByDayRows[i].variance || 0) === 0) mismatchRun++;
    else break;
  }
  const mismatchEarned = mismatchRun >= MISMATCH_TARGET;
  // (c) Full month of on-time orders — from the O15 on-time report over the
  //     selected window: earned when every delivered order was on time.
  const onTimeCount = onTime?.onTimeCount ?? 0;
  const totalDelivered = onTime?.totalDelivered ?? 0;
  const onTimeEarned = totalDelivered > 0 && (onTime?.onTimePct ?? 0) >= 100;
  const onTimeProgress = totalDelivered > 0 ? Math.min(1, onTimeCount / totalDelivered) : 0;

  const milestones = [
    {
      name: "Zero-waste week",
      earned: zeroWasteEarned,
      pct: zeroDays / 7,
      sub: zeroWasteEarned
        ? "All of the last 7 days waste-free"
        : `${zeroDays} of 7 days waste-free`,
    },
    {
      name: "Mismatch-free deliveries",
      earned: mismatchEarned,
      pct: Math.min(1, mismatchRun / MISMATCH_TARGET),
      sub: mismatchEarned
        ? `${mismatchRun} days in a row — earned`
        : `${mismatchRun} of ${MISMATCH_TARGET} days in a row`,
    },
    {
      name: "Full month of on-time orders",
      earned: onTimeEarned,
      pct: onTimeProgress,
      sub: `${onTimeCount} of ${totalDelivered} on time`,
    },
  ];
  const milestonesLoading = varianceByDayLoading || onTimeLoading;

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
  // `status` only applies to the orders report; omit it for the others.
  const buildExportParams = (report: ExportReport): Record<string, string> => {
    const p: Record<string, string> = { report };
    for (const [k, v] of Object.entries(filters)) {
      if (!v || v === "ALL") continue;
      if (k === "status" && report !== "orders") continue;
      p[k] = v;
    }
    return p;
  };

  // Property name embedded in the export filename when a single property is in scope.
  const scopedExportPropName = propertyId !== "ALL" ? propName(propertyId) : null;
  const exportFilename = (report: ExportReport, ext: string) => {
    const base = EXPORT_REPORTS.find((r) => r.key === report)?.base ?? "food-orders";
    const prop = scopedExportPropName && scopedExportPropName !== "—"
      ? `-${scopedExportPropName.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-")}`
      : "";
    return `${base}${prop}-${format(new Date(), "yyyy-MM-dd")}.${ext}`;
  };

  const runExport = async (report: ExportReport, fmt: ExportFmt) => {
    setDownloading(true);
    const filename = exportFilename(report, fmt);
    try {
      await apiDownload(
        foodApi.reportsExportFmtUrl(fmt, buildExportParams(report)),
        filename,
      );
      toast({ title: "Export ready", description: filename });
    } catch (e: any) {
      toast({ title: e?.message || "Download failed", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const scopeName = propertyId !== "ALL" && propName(propertyId) !== "—"
    ? propName(propertyId)
    : null;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 animate-fade-up">
      {/* Header + export dropdown */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scopeName
              ? `How ${scopeName} is doing — people fed, waste and milestones.`
              : "How your properties are doing — people fed, waste and milestones."}
          </p>
        </div>
        {/* O20 — Export: report → format dropdown. Download is restricted to
            Super Admin (+ OPS parity); everyone else can still view reports. */}
        {isSuperAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={downloading} className="gap-1.5">
                <Download className="h-4 w-4" />
                {downloading ? "Preparing…" : "Download"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {EXPORT_REPORTS.map((r) => (
                <DropdownMenuSub key={r.key}>
                  <DropdownMenuSubTrigger>{r.label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {EXPORT_FORMATS.map((f) => (
                      <DropdownMenuItem key={f.key} onClick={() => runExport(r.key, f.key)}>
                        {f.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Slim filter row: period presets + property/brand scope */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-[10px] border border-border bg-card p-0.5">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPeriod(p.key)}
              aria-pressed={period === p.key}
              className={`rounded-[8px] px-3 py-1 text-xs font-semibold transition-colors ${
                period === p.key
                  ? "bg-accent text-white shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Property">
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label="Brand">
            <SelectValue placeholder="Brand" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
          {format(new Date(from), "dd MMM")} – {format(new Date(to), "dd MMM yyyy")}
        </span>
      </div>

      {/* Weekly bar cards */}
      <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {/* People fed daily */}
        <div className="rounded-[14px] border border-border bg-card p-[18px]">
          <h3 className="font-display text-[15px] font-bold tracking-[-0.012em]">People fed daily</h3>
          <p className="mb-3.5 mt-0.5 text-xs text-muted-foreground">Last 7 days</p>
          <div className="flex h-[90px] items-end gap-2">
            {isLoading ? (
              <BarsSkeleton />
            ) : peopleBars.length === 0 ? (
              <BarsEmpty icon={Users} label="No resident data in this range" />
            ) : (
              peopleBars.map((d, i) => (
                <div
                  key={d.date}
                  className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                >
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    {d.residents ?? 0}
                  </span>
                  <div
                    className="w-full"
                    style={{
                      height: `${peopleHeight(d.residents || 0)}%`,
                      minHeight: 2,
                      borderRadius: "6px 6px 3px 3px",
                      background: i === peopleBars.length - 1 ? BAR_GRAD : BAR_TINT,
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">{weekday(d.date)}</span>
                </div>
              ))
            )}
          </div>
          {!isLoading && peopleBars.length > 0 && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              {totalOrders} orders in range · peak {peakResidents} people
            </p>
          )}
        </div>

        {/* Food waste % */}
        <div className="rounded-[14px] border border-border bg-card p-[18px]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-display text-[15px] font-bold tracking-[-0.012em]">Food waste %</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Last 7 days · goal under 3%</p>
            </div>
          </div>
          {/* O17 — meal filter badges; selecting one refetches with that mealType. */}
          <div className="mb-3.5 mt-2 flex flex-wrap gap-1.5">
            {MEAL_FILTERS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMealFilter(m.key)}
                aria-pressed={mealFilter === m.key}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
                  mealFilter === m.key
                    ? "bg-accent text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex h-[90px] items-end gap-2">
            {varianceByDayLoading ? (
              <BarsSkeleton />
            ) : wasteBars.length === 0 ? (
              <BarsEmpty icon={Trash2} label="No waste data in this range" />
            ) : (
              wasteBars.map((b, i) => (
                <div
                  key={b.date}
                  className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                >
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    {b.pct.toFixed(1)}
                  </span>
                  <div
                    className="w-full"
                    style={{
                      height: `${wasteHeight(b.pct)}%`,
                      minHeight: 2,
                      borderRadius: "6px 6px 3px 3px",
                      background:
                        b.pct > 3
                          ? BAR_OVER
                          : i === wasteBars.length - 1
                            ? BAR_OK
                            : BAR_OK_TINT,
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">{weekday(b.date)}</span>
                </div>
              ))
            )}
          </div>
          {!analyticsLoading && summary && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              In range: {summary.totalWasted ?? 0} wasted · {summary.wastePct ?? 0}% ·{" "}
              {summary.delayedOrders ?? 0}/{summary.deliveredOrders ?? 0} delayed
            </p>
          )}
        </div>
      </section>

      {/* O15/O16 — on-time stat strip + (super admin) tolerance settings */}
      <section className="flex flex-wrap items-center gap-3 rounded-[14px] border border-border bg-card px-[18px] py-3.5">
        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-muted text-accent">
          <Timer className="h-4 w-4" />
        </span>
        {onTimeLoading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <span className="font-mono text-xl font-bold tabular-nums">
            {(onTime?.onTimePct ?? 0).toFixed(1)}%
          </span>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold">On-time deliveries</div>
          <div className="text-xs text-muted-foreground">
            {onTimeLoading
              ? "Loading…"
              : `${onTimeCount} on-time · ${onTime?.lateCount ?? 0} late of ${totalDelivered} delivered · within ${onTime?.toleranceMinutes ?? tolerance?.minutes ?? 45} min`}
          </div>
        </div>
        {/* O16 — SUPER_ADMIN only tolerance editor, behind a settings icon. */}
        {isSuperAdmin && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-8 w-8 text-muted-foreground"
                aria-label="On-time tolerance settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <div className="flex flex-col gap-2.5">
                <Label className="text-xs text-muted-foreground">
                  Preferable arrival within
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={240}
                    value={toleranceDraft}
                    onChange={(e) => setToleranceDraft(e.target.value)}
                    className="w-20 text-right tabular-nums"
                    aria-label="On-time tolerance in minutes"
                  />
                  <span className="text-sm text-muted-foreground">min of service time</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="self-end"
                  disabled={
                    saveTolerance.isPending ||
                    toleranceDraft === "" ||
                    toleranceDraft === String(tolerance?.minutes ?? "")
                  }
                  onClick={() => saveTolerance.mutate(toleranceDraft)}
                >
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {saveTolerance.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </section>

      {/* Milestones */}
      <section className="rounded-[14px] border border-border bg-card p-[18px]">
        <h3 className="mb-3.5 font-display text-[15px] font-bold tracking-[-0.012em]">
          Your milestones
        </h3>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          {milestonesLoading
            ? [0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-[34px] w-[34px] flex-none rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              ))
            : milestones.map((m) => (
                <div key={m.name} className="flex items-center gap-3">
                  <span
                    className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full ${
                      m.earned
                        ? "bg-warning-soft text-[#B4741B]"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {m.earned ? <Trophy className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{m.sub}</div>
                    {!m.earned && (
                      <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-brand-gradient transition-[width] duration-500"
                          style={{ width: `${Math.round(m.pct * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
        </div>
      </section>

      {/* View orders deep link (keeps the property scope in the query string) */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setLocation(
              propertyId !== "ALL"
                ? withQuery("/food/orders", { propertyId })
                : "/food/orders",
            )
          }
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-[13px] font-bold text-accent transition-colors hover:bg-muted"
        >
          View orders <ArrowRight className="h-3.5 w-3.5" />
        </button>
        {scopeName && (
          <p className="text-xs text-muted-foreground">Scoped to {scopeName}.</p>
        )}
      </div>
    </div>
  );
}
