import * as React from "react";
import { useLocation } from "wouter";
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
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  type DashboardData,
  type FoodLookups,
  type Kpi,
} from "@/lib/food-api";

const STATUS_COLORS: Record<string, string> = {
  PLACED: "#0EA5E9",
  PREPARING: "#EAB308",
  DISPATCHED: "#A855F7",
  DELIVERED: "#22C55E",
  CANCELLED: "#EF4444",
};

function kpiValue(k?: Kpi): number {
  return k?.value ?? 0;
}
function kpiChange(k?: Kpi): number | undefined {
  return k?.changePct ?? undefined;
}

export default function FoodDashboard() {
  const [, setLocation] = useLocation();

  const [propertyId, setPropertyId] = React.useState("ALL");
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

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
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
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
      </div>

      {/* KPIs */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
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
                    <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? "#94A3B8"} />
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
