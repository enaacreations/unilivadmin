import * as React from "react";
import { useLocation, Link } from "wouter";
import { withQuery } from "@/lib/nav-helpers";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
  ClipboardList,
  Package,
  Truck,
  CheckCircle2,
  PackageCheck,
  Trash2,
  ChevronRight,
  PlusCircle,
  ListOrdered,
  ChefHat,
  Send,
  ClipboardCheck,
  BarChart3,
  Settings,
  Building2,
  Users,
  Wallet,
  Clock,
  LayoutDashboard,
  Compass,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  foodApi,
  foodKeys,
  BRANDS,
  MEAL_LABEL,
  type DashboardData,
  type FoodLookups,
  type Kpi,
  type PropertyOverview,
  type Cutoff,
} from "@/lib/food-api";
import { useAppStore } from "@/lib/store";

const STATUS_COLORS: Record<string, string> = {
  PLACED: "var(--info)",
  PREPARING: "var(--warning)",
  DISPATCHED: "var(--pop)",
  DELIVERED: "var(--success)",
  CANCELLED: "var(--destructive)",
};

function kpiValue(k?: Kpi): number {
  return k?.value ?? 0;
}
function kpiChange(k?: Kpi): number | undefined {
  return k?.changePct ?? undefined;
}

export default function FoodDashboard() {
  const [, setLocation] = useLocation();

  // Selected property from the global app store (null = all properties).
  const { propertyId: storePropertyId, setPropertyId: setGlobalProperty } = useAppStore();
  const scopedPropertyId = storePropertyId ?? undefined;

  // Today's date as an ISO string, used to scope cut-offs.
  const todayIso = React.useMemo(() => new Date().toISOString(), []);

  const { data: overview, isLoading: overviewLoading } = useQuery<PropertyOverview | null>({
    queryKey: foodKeys.propertyOverview({ propertyId: scopedPropertyId }),
    queryFn: () => foodApi.propertyOverview({ propertyId: scopedPropertyId }),
  });

  const { data: cutoffs, isLoading: cutoffsLoading } = useQuery<Cutoff[]>({
    queryKey: foodKeys.cutoffs({ brand: "UNILIV", propertyId: scopedPropertyId, date: todayIso }),
    queryFn: () =>
      foodApi.cutoffs({ brand: "UNILIV", propertyId: scopedPropertyId, date: todayIso }),
  });

  const [propertyId, setPropertyId] = React.useState(storePropertyId ?? "ALL");
  // Keep the orders-table filter, the overview/banner scope and the sidebar
  // selector as one: filter changes push to the global store; global changes
  // mirror back here.
  React.useEffect(() => { setPropertyId(storePropertyId ?? "ALL"); }, [storePropertyId]);
  const selectProperty = (v: string) => {
    setPropertyId(v);
    setGlobalProperty(v === "ALL" ? null : v);
  };
  const [brand, setBrand] = React.useState("ALL");
  const [from, setFrom] = React.useState(() => format(subDays(new Date(), 30), "yyyy-MM-dd"));
  const [to, setTo] = React.useState(() => format(new Date(), "yyyy-MM-dd"));

  const params = React.useMemo(
    () => ({ propertyId, brand, from, to }),
    [propertyId, brand, from, to],
  );

  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: foodKeys.dashboard(params),
    queryFn: () => foodApi.dashboard(params),
  });

  const { data: reports } = useQuery({
    queryKey: foodKeys.reports(params),
    queryFn: () => foodApi.reports(params),
  });

  const statusData = React.useMemo(() => {
    const order = ["PLACED", "PREPARING", "DISPATCHED", "DELIVERED", "CANCELLED"];
    const rows = reports?.statusBreakdown ?? [];
    return [...rows].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
    );
  }, [reports]);

  const kpis = data?.kpis;
  const pending = data?.pendingActions;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Food Dashboard"
        subtitle="Kitchen operations at a glance — orders, dispatch, and delivery"
      />

      <GlobalPropertyScopeBanner properties={lookups?.properties} />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Select value={propertyId} onValueChange={selectProperty}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Brand" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <DatePicker value={from} max={to} onChange={setFrom} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <DatePicker value={to} min={from} onChange={setTo} className="w-40" />
        </div>
      </div>

      {/* Sticky KPI row — stays in view as the overview scrolls */}
      <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              title="Total Orders"
              value={kpiValue(kpis?.totalOrders)}
              change={kpiChange(kpis?.totalOrders)}
              icon={ClipboardList}
            />
            <StatCard
              title="Ordered"
              value={kpiValue(kpis?.ordered)}
              change={kpiChange(kpis?.ordered)}
              icon={Package}
            />
            <StatCard
              title="Dispatched"
              value={kpiValue(kpis?.dispatched)}
              change={kpiChange(kpis?.dispatched)}
              icon={Truck}
            />
            <StatCard
              title="Delivered"
              value={kpiValue(kpis?.delivered)}
              change={kpiChange(kpis?.delivered)}
              icon={CheckCircle2}
            />
          </div>
        )}
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="overview" className="gap-1.5">
            <LayoutDashboard className="h-3.5 w-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5">
            <Compass className="h-3.5 w-3.5" /> Insights &amp; Navigation
          </TabsTrigger>
        </TabsList>

        {/* OVERVIEW — property + cut-offs + pending actions */}
        <TabsContent value="overview" className="mt-4 space-y-4">
      {/* Unit-lead home: property overview + today's cut-offs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Property overview */}
        {overviewLoading ? (
          <Skeleton className="h-44 w-full rounded-xl lg:col-span-2" />
        ) : overview ? (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Building2 className="h-5 w-5 text-primary" />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="font-display text-lg leading-tight">
                      {overview.name}
                    </CardTitle>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {[overview.address, overview.city, overview.state]
                        .filter(Boolean)
                        .join(", ")}
                      {overview.pincode ? ` — ${overview.pincode}` : ""}
                    </p>
                  </div>
                </div>
                <Link
                  href={withQuery("/food/guests", { propertyId: overview?.id })}
                  className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-accent hover:text-accent/80 focus:outline-none focus:ring-2 focus:ring-accent/40"
                >
                  View guests
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {/* Active guests */}
                <div className="rounded-lg border border-border bg-surface/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    Active Guests
                  </div>
                  <p className="mt-1 font-display text-2xl font-bold text-foreground">
                    {overview.activeGuests.toLocaleString("en-IN")}
                  </p>
                </div>

                {/* Occupancy */}
                <div className="rounded-lg border border-border bg-surface/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />
                    Occupancy
                  </div>
                  <p className="mt-1 font-display text-2xl font-bold text-foreground">
                    {overview.occupied}
                    <span className="text-base font-medium text-muted-foreground">
                      {" / "}
                      {overview.totalBeds}
                    </span>
                  </p>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{
                        width: `${Math.min(100, Math.max(0, overview.occupancyPct))}%`,
                      }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {Math.round(overview.occupancyPct)}% occupied
                  </p>
                </div>

                {/* Monthly revenue */}
                <div className="rounded-lg border border-border bg-surface/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Wallet className="h-3.5 w-3.5" />
                    Monthly Revenue
                  </div>
                  <p className="mt-1 font-display text-2xl font-bold text-foreground">
                    ₹{overview.monthlyRevenue.toLocaleString("en-IN")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Today's cut-offs */}
        <Card className={overview || overviewLoading ? "" : "lg:col-span-3"}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="h-4 w-4 text-muted-foreground" />
              Today's Cut-offs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {cutoffsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : !cutoffs || cutoffs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
                <Clock className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No cut-offs configured</p>
                <p className="text-xs text-muted-foreground">
                  Set meal windows in Settings to see ordering cut-offs.
                </p>
              </div>
            ) : (
              <div>
                {/* Single cut-off applies to all meals; each meal keeps its own service time. */}
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/50">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-foreground">Cut-off — all meals</p>
                      <p className="font-mono text-xs text-muted-foreground">{cutoffs[0]?.cutoffTime ?? "Not set"}</p>
                    </div>
                  </div>
                  {cutoffs[0]?.cutoffTime ? (
                    cutoffs[0]?.isPastCutoff ? <Badge variant="destructive">Closed</Badge> : <Badge variant="success">Open</Badge>
                  ) : <Badge variant="secondary">—</Badge>}
                </div>
                <BoundedScroll maxHeight="220px" className="pr-2">
                  <ul className="divide-y divide-border">
                    {cutoffs.map((c) => (
                      <li key={c.mealType} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                        <span className="text-sm text-foreground">{MEAL_LABEL[c.mealType] ?? c.mealType}</span>
                        <span className="font-mono text-xs text-muted-foreground">{c.serviceTime ? `Serves ${c.serviceTime}` : "—"}</span>
                      </li>
                    ))}
                  </ul>
                </BoundedScroll>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pending Actions */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Pending Actions
        </h2>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <PendingActionCard
              icon={Truck}
              label="Awaiting Dispatch"
              count={pending?.awaitingDispatch ?? 0}
              accent="text-info"
              onClick={() => setLocation("/food/dispatch")}
            />
            <PendingActionCard
              icon={PackageCheck}
              label="Awaiting Confirmation"
              count={pending?.awaitingConfirmation ?? 0}
              accent="text-warning"
              onClick={() => setLocation("/food/confirm-delivery")}
            />
            <PendingActionCard
              icon={Trash2}
              label="Waste Pending"
              count={pending?.wastePending ?? 0}
              accent="text-destructive"
              onClick={() => setLocation("/food/waste")}
            />
          </div>
        )}
      </div>
        </TabsContent>

        {/* INSIGHTS & NAVIGATION — secondary chart + quick nav */}
        <TabsContent value="insights" className="mt-4 space-y-4">
          {/* Status overview chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="w-4 h-4 text-muted-foreground" />
                Order Status Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent style={{ height: 280 }}>
              {statusData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No orders in the selected range.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="status"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: string) => v.replace(/_/g, " ")}
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      cursor={{ fill: "rgba(0,0,0,0.04)" }}
                      formatter={(value: number) => [value, "Orders"]}
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {statusData.map((d) => (
                        <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? "var(--muted)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Quick Navigation */}
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Quick Navigation
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {QUICK_NAV.map((tile) => (
                <QuickNavTile
                  key={tile.href}
                  icon={tile.icon}
                  label={tile.label}
                  description={tile.description}
                  onClick={() => setLocation(tile.href)}
                />
              ))}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PendingActionCard({
  icon: Icon,
  label,
  count,
  accent,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left w-full rounded-xl border bg-card p-4 shadow-sm transition-all hover:border-primary/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/40">
            <Icon className={`h-4 w-4 ${count > 0 ? accent : "text-muted-foreground"}`} />
          </span>
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span
          className={`font-display text-3xl font-bold ${count > 0 ? "text-foreground" : "text-muted-foreground"}`}
        >
          {count}
        </span>
        <span className="text-xs text-muted-foreground">
          {count === 1 ? "order" : "orders"}
          {count > 0 ? " need attention" : " pending"}
        </span>
      </div>
    </button>
  );
}

function QuickNavTile({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15">
        <Icon className="h-5 w-5 text-primary" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

const QUICK_NAV: {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
}[] = [
  { label: "Place Order", description: "Create a new food order", href: "/food/place-order", icon: PlusCircle },
  { label: "All Orders", description: "Browse & manage orders", href: "/food/orders", icon: ListOrdered },
  { label: "Kitchen Summary", description: "Aggregated prep quantities", href: "/food/kitchen-summary", icon: ChefHat },
  { label: "Dispatch", description: "Assign & dispatch orders", href: "/food/dispatch", icon: Send },
  { label: "Confirm Delivery", description: "Record received quantities", href: "/food/confirm-delivery", icon: ClipboardCheck },
  { label: "Waste", description: "Log wasted quantities", href: "/food/waste", icon: Trash2 },
  { label: "Reports", description: "Trends & analytics", href: "/food/reports", icon: BarChart3 },
  { label: "Settings", description: "Menu, rules & masters", href: "/food/settings", icon: Settings },
];
