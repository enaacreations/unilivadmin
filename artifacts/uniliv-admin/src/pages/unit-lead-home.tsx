import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Users, Home as HomeIcon, IndianRupee, BedDouble, TrendingDown, Trash2, Clock,
  UtensilsCrossed, BarChart3, PieChart as PieChartIcon, LineChart as LineChartIcon,
  Building2, Sparkles, RefreshCw, ClipboardList,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys,
  type HomeAnalytics, type MyPropertyCard, type RevenueData, type FoodLookups,
} from "@/lib/food-api";

// Chart palette — keyed to the design-system CSS variables.
const ACCENT = "var(--accent)";
const PRIMARY = "var(--primary)";
const SUCCESS = "var(--success)";
const WARNING = "var(--warning)";
const DESTRUCTIVE = "var(--destructive)";
const INFO = "var(--info)";
const PROP_PALETTE = [ACCENT, PRIMARY, SUCCESS, WARNING, INFO, DESTRUCTIVE];

// Period presets — drive the home-analytics `period` param (FY-aware on the server).
type PeriodKey = "week" | "month" | "fq" | "fy";
const PERIOD_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "fq", label: "FY Quarter" },
  { key: "fy", label: "FY Year" },
];

const inr = (n: number) => `₹${(n ?? 0).toLocaleString("en-IN")}`;
const dayTickFmt = (v: string) => { try { return format(new Date(v), "dd MMM"); } catch { return v; } };

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

/** Compact tenancy metric card: current value + delta vs the prior period. */
function TenancyCard({ icon: Icon, title, value, prior, hint }: { icon: React.ElementType; title: string; value: number; prior: number; hint: string }) {
  const delta = value - prior;
  const badge = delta > 0 ? "bg-success/12 text-success" : delta < 0 ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
          <Icon className="h-4 w-4 text-accent" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-display font-bold">{value}</div>
        <p className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge}`}>
          {delta > 0 ? "+" : ""}{delta} vs prior
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export default function UnitLeadHome() {
  const { me } = usePermissions();

  // Time-of-day greeting (same boundaries as the header GreetingClock), with the
  // user's name and — when set — their designation.
  const greeting = React.useMemo(() => {
    const h = new Date().getHours();
    const word = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const first = me?.name?.split(" ")[0];
    const who = first ? `${word}, ${first}` : word;
    return me?.designation ? `${who} · ${me.designation}` : who;
  }, [me?.name, me?.designation]);

  // Global property scope: null = all the unit lead's properties.
  const { propertyId: storePropertyId, setPropertyId: setGlobalProperty } = useAppStore();
  const scopedPropertyId = storePropertyId ?? undefined;
  const [period, setPeriod] = React.useState<PeriodKey>("week");

  // Property list for the selector + scope banner (food lookups; food roles can't read /properties).
  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];

  // Per-property cards (active guests / occupancy / vacant beds / revenue).
  const { data: myProps, isLoading: propsLoading } = useQuery<MyPropertyCard[]>({
    queryKey: foodKeys.myProperties(),
    queryFn: () => foodApi.myProperties(),
  });
  const cards = React.useMemo(() => {
    const all = myProps ?? [];
    return scopedPropertyId ? all.filter((p) => p.id === scopedPropertyId) : all;
  }, [myProps, scopedPropertyId]);

  // Home analytics — respects period + property scope.
  const analyticsParams: Record<string, string> = { period };
  if (scopedPropertyId) analyticsParams.propertyId = scopedPropertyId;
  const { data: home, isLoading: homeLoading } = useQuery<HomeAnalytics>({
    queryKey: foodKeys.homeAnalytics(analyticsParams),
    queryFn: () => foodApi.homeAnalytics(analyticsParams),
  });

  // Collections trend (6-month) — reuses /food/revenue (single-property scope).
  const revenueParams: Record<string, string> = {};
  if (scopedPropertyId) revenueParams.propertyId = scopedPropertyId;
  const { data: revenue } = useQuery<RevenueData>({
    queryKey: foodKeys.revenue(revenueParams),
    queryFn: () => foodApi.revenue(revenueParams),
  });

  // ── Aggregate property overview (moved from the food dashboard) ─────────────
  const totalGuests = cards.reduce((s, c) => s + (c.activeGuests || 0), 0);
  const totalBeds = cards.reduce((s, c) => s + (c.totalBeds || 0), 0);
  const totalRevenue = cards.reduce((s, c) => s + (c.monthlyRevenue || 0), 0);
  const occupancyPct = totalBeds ? Math.round((totalGuests / totalBeds) * 100) : 0;

  // ── Chart series ────────────────────────────────────────────────────────────
  const peopleOrderedTrend = home?.peopleOrderedTrend ?? [];
  const peopleByProperty = home?.peopleByProperty ?? [];
  const wastageTrend = home?.wastageTrend ?? [];
  const activeResidentTrend = home?.activeResidentTrend ?? [];
  const orderDelays = home?.orderDelays ?? [];
  const cmp = home?.peopleComparison;

  const topWasteChartData = (home?.topWasteItems ?? [])
    .slice(0, 8)
    .map((w) => ({ name: w.dishName ?? "—", wasted: w.wasted, wastePct: w.wastePct, unit: w.unit }))
    .reverse();

  const peopleByPropChartData = peopleByProperty.map((p) => ({ name: p.propertyName, people: p.people }));
  const peopleComparisonData = cmp
    ? [
        { name: "Prior", people: cmp.prior, label: cmp.priorLabel },
        { name: "Current", people: cmp.current, label: cmp.currentLabel },
      ]
    : [];

  const collectionsData = (revenue?.months ?? []).map((m) => ({
    month: m.month, total: m.total,
    label: (() => { try { return format(new Date(`${m.month}-01`), "MMM yy"); } catch { return m.month; } })(),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={greeting}
        subtitle="Property overview, demand, wastage, occupancy & collections across your properties"
      />

      <GlobalPropertyScopeBanner properties={properties} />

      {/* Aggregate property overview (moved from the food dashboard) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Active Guests" value={propsLoading ? "—" : totalGuests} icon={Users} />
        <StatCard title="Occupancy" value={propsLoading ? "—" : `${occupancyPct}%`} icon={HomeIcon} />
        <StatCard title="Collections (month)" value={propsLoading ? "—" : inr(totalRevenue)} icon={IndianRupee} />
        <StatCard
          title={scopedPropertyId ? "Property" : "Properties"}
          value={propsLoading ? "—" : cards.length}
          icon={Building2}
        />
      </div>

      {/* Per-property breakdown cards */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent" /> Property Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {propsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
            </div>
          ) : cards.length === 0 ? (
            <ChartEmpty icon={Building2} label="No properties in scope" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {cards.map((c) => {
                const vacant = Math.max(0, (c.totalBeds || 0) - (c.occupied || 0));
                return (
                  <Link
                    key={c.id}
                    href="/food/my-properties"
                    className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-accent/60 hover:bg-muted/40"
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium truncate">{c.name}</p>
                      {c.city && <span className="text-xs text-muted-foreground">{c.city}</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Users className="w-3.5 h-3.5" /> {c.activeGuests} guests
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <HomeIcon className="w-3.5 h-3.5" /> {c.occupancyPct}% occ.
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <BedDouble className="w-3.5 h-3.5" /> {vacant} vacant
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <IndianRupee className="w-3.5 h-3.5" /> {inr(c.monthlyRevenue)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filters: period + property — sits below the property overview, right above
          the period-dependent charts it controls. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="inline-flex items-center rounded-lg border border-border bg-card p-1">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
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
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Property</Label>
          <Select
            value={scopedPropertyId ?? "ALL"}
            onValueChange={(v) => setGlobalProperty(v === "ALL" ? null : v)}
          >
            <SelectTrigger className="w-56"><SelectValue placeholder="Property" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All properties</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {home && (
        <p className="text-xs text-muted-foreground">
          Showing {PERIOD_PRESETS.find((p) => p.key === period)?.label.toLowerCase()} ·{" "}
          {format(new Date(home.range.from), "dd MMM yyyy")} – {format(new Date(home.range.to), "dd MMM yyyy")}
        </p>
      )}

      {/* ── Charts ──────────────────────────────────────────────────────────── */}

      {/* a) People ordered for — comparison across periods + across properties */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-accent" /> People Ordered For — Current vs Prior
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : peopleComparisonData.every((d) => !d.people) ? (
              <ChartEmpty icon={Users} label="No orders in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={peopleComparisonData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any, _n: any, item: any) => [`${v} people`, item?.payload?.label ?? ""]} />
                  <Bar dataKey="people" name="People" fill={ACCENT} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-accent" /> People Ordered For — By Property
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : peopleByPropChartData.length === 0 ? (
              <ChartEmpty icon={Building2} label="No orders in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={peopleByPropChartData} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} interval={0} />
                  <Tooltip formatter={(v: any) => [`${v} people`, "Ordered for"]} />
                  <Bar dataKey="people" name="People" fill={PRIMARY} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* People-ordered trend over time */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <LineChartIcon className="w-4 h-4 text-accent" /> People Ordered For — Trend
          </CardTitle>
        </CardHeader>
        <CardContent style={{ height: 280 }}>
          {homeLoading ? (
            <ChartSkeleton />
          ) : peopleOrderedTrend.length === 0 ? (
            <ChartEmpty icon={Users} label="No orders in this period" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={peopleOrderedTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="peopleGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={ACCENT} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip labelFormatter={dayTickFmt} />
                <Area type="monotone" dataKey="people" name="People" stroke={ACCENT} strokeWidth={2} fill="url(#peopleGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* b) Wastage trend + c) Top 20% wastage items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-accent" /> Total Wastage Trend
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : wastageTrend.length === 0 ? (
              <ChartEmpty icon={Trash2} label="No wastage recorded in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={wastageTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="homeWasteGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={WARNING} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={WARNING} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={dayTickFmt} />
                  <Area type="monotone" dataKey="wasted" name="Wasted" stroke={WARNING} strokeWidth={2} fill="url(#homeWasteGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-accent" /> Top 20% Wastage Items
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : topWasteChartData.length === 0 ? (
              <ChartEmpty icon={UtensilsCrossed} label="No wasted items in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topWasteChartData} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} interval={0} />
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

      {/* d) Active resident trend + e) Order delays */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-accent" /> Active Resident Trend
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : activeResidentTrend.length === 0 ? (
              <ChartEmpty icon={Users} label="No resident data in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={activeResidentTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={dayTickFmt} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={dayTickFmt} />
                  <Line type="monotone" dataKey="residents" name="Active Residents" stroke={PRIMARY} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent" /> Food-Order Delays
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {homeLoading ? (
              <ChartSkeleton />
            ) : orderDelays.length === 0 ? (
              <ChartEmpty icon={Clock} label="No delivery data in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={orderDelays} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
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

      {/* f) Occupancy + Collections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PieChartIcon className="w-4 h-4 text-accent" /> Occupancy By Property
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {propsLoading ? (
              <ChartSkeleton />
            ) : cards.length === 0 ? (
              <ChartEmpty icon={HomeIcon} label="No properties in scope" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={cards.map((c) => ({ name: c.name, occupancyPct: c.occupancyPct }))}
                  margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip formatter={(v: any) => [`${v}%`, "Occupancy"]} />
                  <Bar dataKey="occupancyPct" name="Occupancy %" radius={[4, 4, 0, 0]}>
                    {cards.map((_, i) => (
                      <Cell key={i} fill={PROP_PALETTE[i % PROP_PALETTE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <IndianRupee className="w-4 h-4 text-accent" /> Collections (6-month)
            </CardTitle>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {collectionsData.length === 0 ? (
              <ChartEmpty icon={IndianRupee} label="No collections recorded" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={collectionsData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="collGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={SUCCESS} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={SUCCESS} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: any) => [inr(Number(v)), "Collections"]} />
                  <Area type="monotone" dataKey="total" name="Collections" stroke={SUCCESS} strokeWidth={2} fill="url(#collGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* g) New Signups (real) + Renewals (lease-term proxy) */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ClipboardList className="w-4 h-4" /> Tenancy
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TenancyCard
            icon={Sparkles}
            title="New Signups"
            value={home?.newSignups?.current ?? 0}
            prior={home?.newSignups?.prior ?? 0}
            hint="New resident move-ins in the selected period."
          />
          <TenancyCard
            icon={RefreshCw}
            title="Renewals due"
            value={home?.renewals?.current ?? 0}
            prior={home?.renewals?.prior ?? 0}
            hint="Active residents whose lease term completes this period (estimated from move-in + lease term)."
          />
        </div>
      </div>
    </div>
  );
}
