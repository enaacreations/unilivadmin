import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Building2,
  Check,
  ChefHat,
  CookingPot,
  ListChecks,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { useConfetti } from "@/components/ui/confetti";
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
  shortMeal,
  fmtQty,
  type KitchenSummary,
  type KitchenSummaryDish,
  type FoodOrder,
  type MealType,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";
import { MealIcon } from "@/components/meal-icon";
import { cn } from "@/lib/utils";

const ALL = "ALL";

/** Kitchen serve-by targets per meal (prototype schedule — not in the API). */
const SERVE_BY: Record<MealType, string> = {
  BREAKFAST: "7:00 AM",
  LUNCH: "12:00 PM",
  SNACKS: "4:00 PM",
  DINNER: "7:30 PM",
};

export default function FoodKitchenSummary() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { confetti, fire } = useConfetti();

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
  const meals = React.useMemo(() => {
    const list = summary?.meals ?? [];
    return [...list].sort(
      (a, b) => MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType),
    );
  }, [summary]);

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

  // ─── Mutations: mark single / per-meal / bulk preparing ──────────────────────
  const [bulkPreparing, setBulkPreparing] = React.useState(false);
  const [startingMeal, setStartingMeal] = React.useState<MealType | null>(null);
  const [startedMeals, setStartedMeals] = React.useState<ReadonlySet<MealType>>(
    () => new Set<MealType>(),
  );
  const markStarted = (types: MealType[]) =>
    setStartedMeals((prev) => {
      const next = new Set(prev);
      types.forEach((t) => next.add(t));
      return next;
    });

  const prepareOne = useMutation({
    mutationFn: (id: string) => foodApi.prepareOrder(id),
    onSuccess: (_d, id) => {
      const o = placedOrders.find((x) => x.id === id);
      toast({
        title: `Order ${o?.orderNumber ?? ""} marked Preparing`,
        variant: "success",
      });
      invalidate();
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  /** "Start prep" for one meal — kicks every PLACED order of that meal. */
  const startMealPrep = async (meal: MealType) => {
    const pending = placedOrders.filter((o) => o.mealType === meal);
    if (pending.length === 0 || startingMeal || bulkPreparing) return;
    setStartingMeal(meal);
    let ok = 0;
    let fail = 0;
    for (const o of pending) {
      try {
        await foodApi.prepareOrder(o.id);
        ok++;
      } catch {
        fail++;
      }
    }
    setStartingMeal(null);
    invalidate();
    if (fail === 0) {
      markStarted([meal]);
      fire();
      toast({
        title: `${shortMeal(meal)} prep started`,
        description: `${ok} order${ok === 1 ? "" : "s"} moved to Preparing.`,
        variant: "success",
      });
    } else {
      toast({
        title: `${shortMeal(meal)}: ${ok} started, ${fail} failed`,
        variant: fail > ok ? "destructive" : "warning",
      });
    }
  };

  const markAllPreparing = async () => {
    if (placedOrders.length === 0) return;
    const affectedMeals = [...new Set(placedOrders.map((o) => o.mealType))];
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
      markStarted(affectedMeals);
      fire();
      toast({
        title: "Kitchen is go",
        description: `Marked ${ok} order${ok === 1 ? "" : "s"} as Preparing.`,
        variant: "success",
      });
    } else {
      toast({
        title: `${ok} updated, ${fail} failed`,
        variant: fail > ok ? "destructive" : "warning",
      });
    }
  };

  // ─── Derived header stats ────────────────────────────────────────────────────
  const totalProps = new Set(
    meals.flatMap((m) => m.dishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId))),
  ).size;
  const totalPeople = placedOrders.reduce((acc, o) => acc + (o.residentsCount || 0), 0);
  const subtitleBits = [
    format(new Date(date), "EEE, dd MMM yyyy"),
    totalProps > 0 ? `${totalProps} propert${totalProps === 1 ? "y" : "ies"}` : null,
    totalPeople > 0 ? `${totalPeople} people to feed` : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-[900px] animate-fade-up flex-col gap-6">
      {confetti}

      {/* Persona pill + header */}
      <div className="flex flex-col gap-3">
        <span className="self-start rounded-full bg-info-soft px-[9px] py-[3px] text-[10px] font-bold uppercase tracking-[.08em] text-info">
          Kitchen staff view
        </span>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">
              Kitchen Summary
            </h1>
            <p className="text-sm text-muted-foreground">
              {subtitleBits.map((bit, i) => (
                <React.Fragment key={i}>
                  {i > 0 && " · "}
                  {bit}
                </React.Fragment>
              ))}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => invalidate()}
            disabled={summaryFetching}
          >
            <RefreshCw
              className={`mr-1.5 h-4 w-4 ${summaryFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters (compact) */}
      <div className="flex flex-wrap items-center gap-2">
        <DatePicker value={date} onChange={setDate} className="h-9 w-40 text-[13px]" />
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="h-9 w-[128px] text-[13px]">
            <SelectValue placeholder="Brand" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="h-9 w-[150px] text-[13px]">
            <SelectValue placeholder="Meal" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (
              <SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="h-9 w-[190px] text-[13px]">
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Prep plan — one card per meal */}
      {summaryLoading ? (
        <div className="flex flex-col gap-[18px]">
          {[0, 1].map((i) => (
            <div key={i} className="overflow-hidden rounded-[14px] border border-border bg-card">
              <div className="border-b border-border px-5 py-4">
                <Skeleton className="h-6 w-44" />
              </div>
              <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
                {[0, 1, 2, 3].map((j) => (
                  <div key={j} className="bg-card p-4">
                    <Skeleton className="h-6 w-16" />
                    <Skeleton className="mt-2 h-3 w-24" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : meals.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-border py-16 text-center text-muted-foreground">
          <ChefHat className="mb-3 h-10 w-10 opacity-60" />
          <p className="font-display text-[15px] font-bold tracking-[-0.012em] text-foreground">
            No prep plan for this selection
          </p>
          <p className="mt-1 text-sm">
            Nothing to cook for {format(new Date(date), "dd MMM yyyy")} with the current filters.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-[18px]">
          {meals.map((meal) => (
            <MealPrepCard
              key={meal.mealType}
              mealType={meal.mealType}
              dishes={meal.dishes}
              pendingOrders={placedOrders.filter((o) => o.mealType === meal.mealType)}
              started={startedMeals.has(meal.mealType)}
              starting={startingMeal === meal.mealType}
              busy={startingMeal !== null || bulkPreparing}
              onStartPrep={() => startMealPrep(meal.mealType)}
            />
          ))}
        </div>
      )}

      {/* Mark Preparing — contributing open orders */}
      <OpenOrdersPanel
        orders={placedOrders}
        isLoading={ordersLoading}
        propName={propName}
        onPrepare={(id) => prepareOne.mutate(id)}
        preparingId={prepareOne.isPending ? (prepareOne.variables as string) : null}
        onPrepareAll={markAllPreparing}
        bulkPreparing={bulkPreparing}
        mealBusy={startingMeal !== null}
        onOpenOrder={(id) => setLocation(`/food/orders/${id}`)}
      />
    </div>
  );
}

// ─── One card per meal: header + Start prep CTA + aggregate dish tiles ─────────
function MealPrepCard({
  mealType,
  dishes,
  pendingOrders,
  started,
  starting,
  busy,
  onStartPrep,
}: {
  mealType: MealType;
  dishes: KitchenSummaryDish[];
  pendingOrders: FoodOrder[];
  started: boolean;
  starting: boolean;
  busy: boolean;
  onStartPrep: () => void;
}) {
  const [openDishId, setOpenDishId] = React.useState<string | null>(null);
  const openDish = openDishId ? dishes.find((d) => d.dishId === openDishId) : undefined;

  const people = pendingOrders.reduce((acc, o) => acc + (o.residentsCount || 0), 0);
  const propCount = new Set(
    dishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId)),
  ).size;
  const prepStarted = started || pendingOrders.length === 0;

  return (
    <section className="overflow-hidden rounded-[14px] border border-border bg-card">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 font-display text-[17px] font-bold tracking-[-0.012em]">
            <MealIcon meal={mealType} size={22} />
            {MEAL_LABEL[mealType]}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Serve by{" "}
            <span className="font-mono tabular-nums text-foreground">
              {SERVE_BY[mealType]}
            </span>
            {people > 0 && (
              <>
                {" · "}
                <span className="font-mono tabular-nums text-foreground">{people}</span>{" "}
                people
              </>
            )}
            {" · across "}
            {propCount} propert{propCount === 1 ? "y" : "ies"}
          </p>
        </div>
        {prepStarted ? (
          <span className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-success-soft px-4 text-sm font-bold text-success">
            <Check className="h-4 w-4" strokeWidth={3} />
            Prep started
          </span>
        ) : (
          <button
            type="button"
            onClick={onStartPrep}
            disabled={busy}
            className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-accent px-5 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting && <Loader2 className="h-4 w-4 animate-spin" />}
            Start prep
          </button>
        )}
      </div>

      {/* Aggregate dish tiles (1px grid lines via clipped per-tile borders) */}
      <div className="-mb-px -mr-px grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
        {dishes.map((dish) => {
          const hasBreakdown = dish.byProperty && dish.byProperty.length > 0;
          const isOpen = openDishId === dish.dishId;
          return (
            <button
              key={dish.dishId}
              type="button"
              onClick={() =>
                hasBreakdown && setOpenDishId((cur) => (cur === dish.dishId ? null : dish.dishId))
              }
              className={cn(
                "border-b border-r border-border bg-card px-4 py-3.5 text-left",
                hasBreakdown
                  ? "cursor-pointer transition-colors hover:bg-muted/50"
                  : "cursor-default",
                isOpen && "bg-muted/50",
              )}
              title={hasBreakdown ? "Show per-property split" : undefined}
            >
              <div className="font-mono text-xl font-semibold tabular-nums">
                {fmtQty(dish.displayQty)}
                <span className="ml-1 text-xs font-medium uppercase text-muted-foreground">
                  {dish.displayUnit}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {dish.dishName}
              </div>
            </button>
          );
        })}
      </div>

      {/* Per-property split for the selected dish */}
      {openDish && openDish.byProperty.length > 0 && (
        <div className="border-t border-border bg-muted/20 px-5 py-4">
          <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Building2 className="h-3 w-3" />
            {openDish.dishName} — per property
            <span className="rounded-full bg-muted px-[9px] py-[3px] text-[10px] font-bold tracking-wider text-muted-foreground">
              {openDish.component.replace(/_/g, " ")}
            </span>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {openDish.byProperty.map((bp) => (
              <div
                key={bp.propertyId}
                className="flex items-center justify-between rounded-[10px] border border-border bg-card px-3 py-2"
              >
                <span className="mr-2 truncate text-xs text-muted-foreground">
                  {bp.propertyName}
                </span>
                <span className="whitespace-nowrap font-mono text-sm font-medium tabular-nums">
                  {fmtQty(bp.qty, openDish.displayUnit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
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
  mealBusy,
  onOpenOrder,
}: {
  orders: FoodOrder[];
  isLoading: boolean;
  propName: (id?: string | null) => string;
  onPrepare: (id: string) => void;
  preparingId: string | null;
  onPrepareAll: () => void;
  bulkPreparing: boolean;
  mealBusy: boolean;
  onOpenOrder: (id: string) => void;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-base font-bold tracking-[-0.012em]">
            <ListChecks className="h-4 w-4 text-primary" /> Open orders to start
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            PLACED orders contributing to this prep plan — start the kitchen by marking
            them Preparing.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-accent px-4 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onPrepareAll}
          disabled={bulkPreparing || mealBusy || isLoading || orders.length === 0}
        >
          {bulkPreparing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CookingPot className="h-4 w-4" />
          )}
          Mark all as Preparing
        </button>
      </div>
      <div className="p-4">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-border py-10 text-center text-muted-foreground">
            <CookingPot className="mb-2 h-8 w-8 opacity-60" />
            <p className="font-display text-[15px] font-bold tracking-[-0.012em] text-foreground">
              All caught up
            </p>
            <p className="mt-1 text-sm">No open orders for this selection.</p>
          </div>
        ) : (
          <BoundedScroll size="lg" className="rounded-[10px] border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 border-y bg-muted/40 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="p-3 font-medium">Order</th>
                  <th className="p-3 font-medium">Property</th>
                  <th className="p-3 font-medium">Meal</th>
                  <th className="p-3 text-right font-medium">Residents</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 align-middle">
                      <button
                        type="button"
                        className="font-mono text-xs tabular-nums text-primary hover:underline"
                        onClick={() => onOpenOrder(o.id)}
                      >
                        {o.orderNumber}
                      </button>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {o.brand}
                      </div>
                    </td>
                    <td className="p-3 align-middle">
                      {o.propertyName || propName(o.propertyId)}
                    </td>
                    <td className="p-3 align-middle">
                      <span className="inline-flex items-center gap-1.5">
                        <MealIcon meal={o.mealType} size={18} />
                        {shortMeal(o.mealType)}
                      </span>
                    </td>
                    <td className="p-3 text-right align-middle font-mono tabular-nums">
                      {o.residentsCount}
                    </td>
                    <td className="p-3 text-right align-middle font-mono font-medium tabular-nums">
                      {fmtQty(o.totalQuantity)}
                    </td>
                    <td className="p-3 text-right align-middle">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onPrepare(o.id)}
                        disabled={preparingId === o.id || bulkPreparing || mealBusy}
                      >
                        {preparingId === o.id ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CookingPot className="mr-1.5 h-3.5 w-3.5" />
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
      </div>
    </section>
  );
}
