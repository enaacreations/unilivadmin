import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Building2,
  Check,
  ChefHat,
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
import { PropertyOptions } from "@/components/property-options";
import {
  foodApi,
  foodKeys,
  MEAL_TYPES,
  BRANDS,
  MEAL_LABEL,
  shortMeal,
  fmtQty,
  orderPeople,
  type KitchenSummary,
  type KitchenSummaryDish,
  type FoodOrder,
  type MealType,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";
import { MealIcon } from "@/components/meal-icon";
import { usePermissions } from "@/lib/use-permissions";
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
  const { can } = usePermissions();
  // Opening an order navigates to /food/orders/:id, which is server- AND route-
  // gated on FOOD_ALL_ORDERS. F&B roles run the kitchen board without that grant,
  // so for them the order number is plain text, not a link to a Forbidden page.
  const canReadOrders = can("FOOD_ALL_ORDERS", "view");

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

  // ─── Contributing open orders (PLACED awaiting accept, ACCEPTED awaiting prep) ─
  const ordersParams: Record<string, unknown> = {
    status: "PLACED,ACCEPTED",
    // GET /food/orders filters exact days via `serviceDate` — the old `date`
    // key was silently ignored, so the panel listed open orders from ALL days.
    serviceDate: date,
    brand: brand === ALL ? undefined : brand,
    mealType: mealType === ALL ? undefined : mealType,
    propertyId: propertyId === ALL ? undefined : propertyId,
    limit: 200,
  };
  const { data: ordersRes, isLoading: ordersLoading } = useQuery({
    queryKey: foodKeys.orders(ordersParams),
    queryFn: () => foodApi.listOrders(ordersParams),
  });
  const openOrders = ordersRes?.data ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "kitchen-summary"] });
    qc.invalidateQueries({ queryKey: ["food", "orders"] });
    qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
  };

  // ─── Mutations: accept single / per-meal / all ───────────────────────────────
  const [bulkAccepting, setBulkAccepting] = React.useState(false);
  const [acceptingMeal, setAcceptingMeal] = React.useState<MealType | null>(null);
  const [startedMeals, setStartedMeals] = React.useState<ReadonlySet<MealType>>(
    () => new Set<MealType>(),
  );
  const markStarted = (types: MealType[]) =>
    setStartedMeals((prev) => {
      const next = new Set(prev);
      types.forEach((t) => next.add(t));
      return next;
    });

  // Accept one order. Only PLACED orders have an action here; an ACCEPTED order
  // is already confirmed for the kitchen and simply waits for dispatch.
  const stepOne = useMutation({
    mutationFn: (o: FoodOrder) => foodApi.acceptOrder(o.id),
    onSuccess: (_d, o) => {
      toast({ title: `Order ${o.orderNumber} accepted`, variant: "success" });
      invalidate();
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  /** Accept one order if it's still PLACED (ACCEPTED orders are already done). */
  const acceptIfPlaced = async (o: FoodOrder) => {
    if (o.status === "PLACED") await foodApi.acceptOrder(o.id);
  };

  /** "Accept" for one meal — accepts every PLACED order of that meal. */
  const acceptMealOrders = async (meal: MealType) => {
    const pending = openOrders.filter((o) => o.mealType === meal && o.status === "PLACED");
    if (pending.length === 0 || acceptingMeal || bulkAccepting) return;
    setAcceptingMeal(meal);
    let ok = 0;
    let fail = 0;
    for (const o of pending) {
      try {
        await acceptIfPlaced(o);
        ok++;
      } catch {
        fail++;
      }
    }
    setAcceptingMeal(null);
    invalidate();
    if (fail === 0) {
      markStarted([meal]);
      fire();
      toast({
        title: `${shortMeal(meal)} accepted`,
        description: `${ok} order${ok === 1 ? "" : "s"} accepted.`,
        variant: "success",
      });
    } else {
      toast({
        title: `${shortMeal(meal)}: ${ok} accepted, ${fail} failed`,
        variant: fail > ok ? "destructive" : "warning",
      });
    }
  };

  const acceptAll = async () => {
    const pending = openOrders.filter((o) => o.status === "PLACED");
    if (pending.length === 0) return;
    const affectedMeals = [...new Set(pending.map((o) => o.mealType))];
    setBulkAccepting(true);
    let ok = 0;
    let fail = 0;
    for (const o of pending) {
      try {
        await acceptIfPlaced(o);
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkAccepting(false);
    invalidate();
    if (fail === 0) {
      markStarted(affectedMeals);
      fire();
      toast({
        title: "Orders accepted",
        description: `Accepted ${ok} order${ok === 1 ? "" : "s"}.`,
        variant: "success",
      });
    } else {
      toast({
        title: `${ok} accepted, ${fail} failed`,
        variant: fail > ok ? "destructive" : "warning",
      });
    }
  };

  // ─── Derived header stats ────────────────────────────────────────────────────
  const totalProps = new Set(
    meals.flatMap((m) => m.dishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId))),
  ).size;
  const totalPeople = openOrders.reduce((acc, o) => acc + orderPeople(o), 0);
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
            <PropertyOptions properties={properties} />
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
              pendingOrders={openOrders.filter((o) => o.mealType === meal.mealType)}
              started={startedMeals.has(meal.mealType)}
              starting={acceptingMeal === meal.mealType}
              busy={acceptingMeal !== null || bulkAccepting}
              onAccept={() => acceptMealOrders(meal.mealType)}
            />
          ))}
        </div>
      )}

      {/* Accept — contributing open orders */}
      <OpenOrdersPanel
        orders={openOrders}
        isLoading={ordersLoading}
        propName={propName}
        onStep={(o) => stepOne.mutate(o)}
        steppingId={stepOne.isPending ? (stepOne.variables as FoodOrder).id : null}
        onAcceptAll={acceptAll}
        bulkAccepting={bulkAccepting}
        mealBusy={acceptingMeal !== null}
        canOpenOrder={canReadOrders}
        onOpenOrder={(id) => setLocation(`/food/orders/${id}`)}
      />
    </div>
  );
}

// ─── One card per meal: header + Accept CTA + aggregate dish tiles ─────────────
function MealPrepCard({
  mealType,
  dishes,
  pendingOrders,
  started,
  starting,
  busy,
  onAccept,
}: {
  mealType: MealType;
  dishes: KitchenSummaryDish[];
  pendingOrders: FoodOrder[];
  started: boolean;
  starting: boolean;
  busy: boolean;
  onAccept: () => void;
}) {
  const [openDishId, setOpenDishId] = React.useState<string | null>(null);
  const openDish = openDishId ? dishes.find((d) => d.dishId === openDishId) : undefined;

  const people = pendingOrders.reduce((acc, o) => acc + orderPeople(o), 0);
  const propCount = new Set(
    dishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId)),
  ).size;
  // Nothing left to accept once every open order for this meal is ACCEPTED.
  const hasPlaced = pendingOrders.some((o) => o.status === "PLACED");
  const allAccepted = started || !hasPlaced;

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
        {allAccepted ? (
          <span className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-success-soft px-4 text-sm font-bold text-success">
            <Check className="h-4 w-4" strokeWidth={3} />
            Accepted
          </span>
        ) : (
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-accent px-5 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting && <Loader2 className="h-4 w-4 animate-spin" />}
            Accept orders
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

// ─── Open orders panel: per-order + bulk "Accept all" ──────────────────────────
function OpenOrdersPanel({
  orders,
  isLoading,
  propName,
  onStep,
  steppingId,
  onAcceptAll,
  bulkAccepting,
  mealBusy,
  canOpenOrder,
  onOpenOrder,
}: {
  orders: FoodOrder[];
  isLoading: boolean;
  propName: (id?: string | null) => string;
  onStep: (o: FoodOrder) => void;
  steppingId: string | null;
  onAcceptAll: () => void;
  bulkAccepting: boolean;
  mealBusy: boolean;
  canOpenOrder: boolean;
  onOpenOrder: (id: string) => void;
}) {
  const placedCount = orders.filter((o) => o.status === "PLACED").length;
  return (
    <section className="rounded-[14px] border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-base font-bold tracking-[-0.012em]">
            <ListChecks className="h-4 w-4 text-primary" /> Open orders to accept
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            New orders contributing to this cook plan — accept each one to confirm it
            for the kitchen.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-accent px-4 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onAcceptAll}
          disabled={bulkAccepting || mealBusy || isLoading || placedCount === 0}
        >
          {bulkAccepting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" strokeWidth={3} />
          )}
          Accept all{placedCount > 0 ? ` (${placedCount})` : ""}
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
            <ListChecks className="mb-2 h-8 w-8 opacity-60" />
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
                  <th className="p-3 text-right font-medium">People</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 align-middle">
                      {canOpenOrder ? (
                        <button
                          type="button"
                          className="font-mono text-xs tabular-nums text-primary hover:underline"
                          onClick={() => onOpenOrder(o.id)}
                        >
                          {o.orderNumber}
                        </button>
                      ) : (
                        <span className="font-mono text-xs tabular-nums text-foreground">
                          {o.orderNumber}
                        </span>
                      )}
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
                      {orderPeople(o)}
                    </td>
                    <td className="p-3 text-right align-middle font-mono font-medium tabular-nums">
                      {fmtQty(o.totalQuantity)}
                    </td>
                    <td className="p-3 text-right align-middle">
                      {o.status === "PLACED" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onStep(o)}
                          disabled={steppingId === o.id || bulkAccepting || mealBusy}
                        >
                          {steppingId === o.id ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Accept
                        </Button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-success">
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                          Accepted
                        </span>
                      )}
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
