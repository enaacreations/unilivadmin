import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ChefHat,
  ChevronDown,
  ChevronRight,
  Utensils,
  Boxes,
  ListChecks,
  Building2,
  CookingPot,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  foodApi,
  foodKeys,
  MEAL_TYPES,
  BRANDS,
  MEAL_LABEL,
  fmtQty,
  type KitchenSummary,
  type KitchenSummaryDish,
  type FoodOrder,
  type MealType,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";

const ALL = "ALL";

export default function FoodKitchenSummary() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [date, setDate] = React.useState(() => format(new Date(), "yyyy-MM-dd"));
  const [brand, setBrand] = React.useState<string>(ALL);
  const [mealType, setMealType] = React.useState<string>(ALL);
  const [propertyId, setPropertyId] = React.useState<string>(ALL);

  // ─── Lookups (properties / brands / meals) ──────────────────────────────────
  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? properties.find((p) => p.id === id)?.name || "—" : "—";

  // ─── Shared filter params ────────────────────────────────────────────────────
  const summaryParams: Record<string, unknown> = {
    date,
    brand: brand === ALL ? undefined : brand,
    mealType: mealType === ALL ? undefined : mealType,
    propertyId: propertyId === ALL ? undefined : propertyId,
  };

  // ─── Kitchen summary ─────────────────────────────────────────────────────────
  const {
    data: summary,
    isLoading: summaryLoading,
    isFetching: summaryFetching,
  } = useQuery<KitchenSummary>({
    queryKey: foodKeys.kitchenSummary(summaryParams),
    queryFn: () => foodApi.kitchenSummary(summaryParams),
  });
  const meals = summary?.meals ?? [];

  // ─── Contributing open (PLACED) orders ───────────────────────────────────────
  const ordersParams: Record<string, unknown> = {
    status: "PLACED",
    date,
    brand: brand === ALL ? undefined : brand,
    mealType: mealType === ALL ? undefined : mealType,
    propertyId: propertyId === ALL ? undefined : propertyId,
    limit: 200,
  };
  const { data: ordersRes, isLoading: ordersLoading } = useQuery({
    queryKey: foodKeys.orders(ordersParams),
    queryFn: () => foodApi.listOrders(ordersParams),
  });
  const placedOrders = ordersRes?.data ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "kitchen-summary"] });
    qc.invalidateQueries({ queryKey: ["food", "orders"] });
    qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
  };

  // ─── Mutations: mark single / bulk preparing ─────────────────────────────────
  const [bulkPreparing, setBulkPreparing] = React.useState(false);

  const prepareOne = useMutation({
    mutationFn: (id: string) => foodApi.prepareOrder(id),
    onSuccess: (_d, id) => {
      const o = placedOrders.find((x) => x.id === id);
      toast({ title: `Order ${o?.orderNumber ?? ""} marked Preparing` });
      invalidate();
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const markAllPreparing = async () => {
    if (placedOrders.length === 0) return;
    setBulkPreparing(true);
    let ok = 0;
    let fail = 0;
    for (const o of placedOrders) {
      try {
        await foodApi.prepareOrder(o.id);
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkPreparing(false);
    invalidate();
    if (fail === 0) {
      toast({ title: `Marked ${ok} order${ok === 1 ? "" : "s"} as Preparing` });
    } else {
      toast({
        title: `${ok} updated, ${fail} failed`,
        variant: fail > ok ? "destructive" : undefined,
      });
    }
  };

  // ─── Derived stats ───────────────────────────────────────────────────────────
  const dishCount = meals.reduce((acc, m) => acc + m.dishes.length, 0);
  const componentCount = new Set(
    meals.flatMap((m) => m.dishes.map((d) => d.component)),
  ).size;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kitchen Summary"
        subtitle="Consolidated prep plan across properties — totals, breakdowns, and order kick-off"
        action={
          <Button
            variant="outline"
            onClick={() => invalidate()}
            disabled={summaryFetching}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${summaryFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Meals to Prep" value={summaryLoading ? "—" : meals.length} icon={Utensils} />
        <StatCard title="Total Dishes" value={summaryLoading ? "—" : dishCount} icon={CookingPot} />
        <StatCard title="Components" value={summaryLoading ? "—" : componentCount} icon={Boxes} />
        <StatCard title="Open Orders (PLACED)" value={ordersLoading ? "—" : placedOrders.length} icon={ListChecks} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <DatePicker value={date} onChange={setDate} className="w-44" />
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      {/* Prep plan */}
      {summaryLoading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-6 w-40" /></CardHeader>
              <CardContent className="space-y-2">
                {[0, 1, 2].map((j) => (<Skeleton key={j} className="h-10 w-full" />))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : meals.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center justify-center text-center text-muted-foreground">
            <ChefHat className="h-10 w-10 mb-3 opacity-60" />
            <p className="font-medium text-foreground">No prep plan for this selection</p>
            <p className="text-sm mt-1">
              Nothing to cook for {format(new Date(date), "dd MMM yyyy")} with the current filters.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {meals.map((meal) => (
            <MealCard key={meal.mealType} mealType={meal.mealType} dishes={meal.dishes} />
          ))}
        </div>
      )}

      <Separator />

      {/* Mark Preparing — contributing open orders */}
      <OpenOrdersPanel
        orders={placedOrders}
        isLoading={ordersLoading}
        propName={propName}
        onPrepare={(id) => prepareOne.mutate(id)}
        preparingId={prepareOne.isPending ? (prepareOne.variables as string) : null}
        onPrepareAll={markAllPreparing}
        bulkPreparing={bulkPreparing}
        onOpenOrder={(id) => setLocation(`/food/orders/${id}`)}
      />
    </div>
  );
}

// ─── Meal card with per-dish total + expandable property breakdown ─────────────
function MealCard({ mealType, dishes }: { mealType: MealType; dishes: KitchenSummaryDish[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="font-display flex items-center gap-2 text-lg">
          <Utensils className="w-4 h-4 text-primary" />
          {MEAL_LABEL[mealType]}
        </CardTitle>
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
          {dishes.length} dish{dishes.length === 1 ? "" : "es"}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <BoundedScroll size="md">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/40 border-y backdrop-blur supports-[backdrop-filter]:bg-muted/60">
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="p-3 font-medium w-8"></th>
                <th className="p-3 font-medium">Dish</th>
                <th className="p-3 font-medium">Component</th>
                <th className="p-3 font-medium text-right">Grand Total</th>
              </tr>
            </thead>
            <tbody>
              {dishes.map((dish) => (
                <DishRow key={dish.dishId} dish={dish} />
              ))}
            </tbody>
          </table>
        </BoundedScroll>
      </CardContent>
    </Card>
  );
}

function DishRow({ dish }: { dish: KitchenSummaryDish }) {
  const [open, setOpen] = React.useState(false);
  const hasBreakdown = dish.byProperty && dish.byProperty.length > 0;

  return (
    <>
      <tr
        className={`border-b last:border-0 ${hasBreakdown ? "cursor-pointer hover:bg-muted/40" : ""}`}
        onClick={() => hasBreakdown && setOpen((o) => !o)}
      >
        <td className="p-3 align-middle text-muted-foreground">
          {hasBreakdown ? (
            open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
          ) : null}
        </td>
        <td className="p-3 align-middle font-medium text-primary">{dish.dishName}</td>
        <td className="p-3 align-middle">
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
            {dish.component.replace(/_/g, " ")}
          </Badge>
        </td>
        <td className="p-3 align-middle text-right">
          <span className="font-display font-bold text-base">
            {fmtQty(dish.displayQty)}
          </span>
          <span className="text-muted-foreground ml-1 text-xs uppercase">{dish.displayUnit}</span>
        </td>
      </tr>
      {open && hasBreakdown && (
        <tr className="bg-muted/20 border-b last:border-0">
          <td></td>
          <td colSpan={3} className="px-3 pb-3 pt-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <Building2 className="w-3 h-3" /> Per-property breakdown
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {dish.byProperty.map((bp) => (
                <div
                  key={bp.propertyId}
                  className="flex items-center justify-between rounded-md border bg-card px-3 py-2"
                >
                  <span className="text-xs text-muted-foreground truncate mr-2">{bp.propertyName}</span>
                  <span className="font-mono text-sm font-medium whitespace-nowrap">
                    {fmtQty(bp.qty, dish.displayUnit)}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Open orders panel: per-order + bulk "Mark Preparing" ──────────────────────
function OpenOrdersPanel({
  orders,
  isLoading,
  propName,
  onPrepare,
  preparingId,
  onPrepareAll,
  bulkPreparing,
  onOpenOrder,
}: {
  orders: FoodOrder[];
  isLoading: boolean;
  propName: (id?: string | null) => string;
  onPrepare: (id: string) => void;
  preparingId: string | null;
  onPrepareAll: () => void;
  bulkPreparing: boolean;
  onOpenOrder: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="font-display flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-primary" /> Open Orders to Start
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            PLACED orders contributing to this prep plan — start the kitchen by marking them Preparing.
          </p>
        </div>
        <Button
          className="bg-accent hover:bg-accent/90 text-white"
          onClick={onPrepareAll}
          disabled={bulkPreparing || isLoading || orders.length === 0}
        >
          {bulkPreparing ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <CookingPot className="w-4 h-4 mr-2" />
          )}
          Mark all as Preparing
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (<Skeleton key={i} className="h-12 w-full" />))}
          </div>
        ) : orders.length === 0 ? (
          <div className="py-10 flex flex-col items-center justify-center text-center text-muted-foreground border border-dashed rounded-md">
            <CookingPot className="h-8 w-8 mb-2 opacity-60" />
            <p className="font-medium text-foreground">All caught up</p>
            <p className="text-sm mt-1">No open orders for this selection.</p>
          </div>
        ) : (
          <BoundedScroll size="lg" className="rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/40 border-y backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="p-3 font-medium">Order</th>
                  <th className="p-3 font-medium">Property</th>
                  <th className="p-3 font-medium">Meal</th>
                  <th className="p-3 font-medium text-right">Residents</th>
                  <th className="p-3 font-medium text-right">Qty</th>
                  <th className="p-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 align-middle">
                      <button
                        className="font-mono text-xs text-primary hover:underline"
                        onClick={() => onOpenOrder(o.id)}
                      >
                        {o.orderNumber}
                      </button>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {o.brand}
                      </div>
                    </td>
                    <td className="p-3 align-middle">{o.propertyName || propName(o.propertyId)}</td>
                    <td className="p-3 align-middle">{MEAL_LABEL[o.mealType]}</td>
                    <td className="p-3 align-middle text-right">{o.residentsCount}</td>
                    <td className="p-3 align-middle text-right font-medium">{fmtQty(o.totalQuantity)}</td>
                    <td className="p-3 align-middle text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onPrepare(o.id)}
                        disabled={preparingId === o.id || bulkPreparing}
                      >
                        {preparingId === o.id ? (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <CookingPot className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        Mark Preparing
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </BoundedScroll>
        )}
      </CardContent>
    </Card>
  );
}
