import * as React from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, addDays, parseISO } from "date-fns";
import {
  ChevronLeft, ChevronRight, Check, AlertCircle, Truck, Soup, Inbox,
  CookingPot, History,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useConfetti } from "@/components/ui/confetti";
import { MealIcon } from "@/components/meal-icon";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, shortMeal, fmtQty,
  type FoodOrder, type MealType, type KitchenSummaryDish,
} from "@/lib/food-api";

/** Kitchen serve-by targets per meal (prototype schedule — not in the API).
 *  Kept in sync with food-kitchen-summary.tsx. */
const SERVE_BY: Record<MealType, string> = {
  BREAKFAST: "7:00 AM", LUNCH: "12:00 PM", SNACKS: "4:00 PM", DINNER: "7:30 PM",
};

/** The kitchen's journey state for one meal — drives tab tint + pill, in the
 *  same visual grammar as the unit lead's Food Overview meal states. */
type KState = "accept" | "cook" | "dispatch" | "transit" | "quiet";

const STATE_TINT: Record<KState, string> = {
  accept: "var(--warning)",   // orders waiting to be accepted — act now
  cook: "var(--pop)",         // accepted, waiting for the stove
  dispatch: "var(--info)",    // in the kitchen — dispatch when ready
  transit: "var(--success)",  // everything's on the road
  quiet: "var(--muted)",
};

const stateShort = (s: KState, n: number): string =>
  s === "accept" ? `${n} to accept`
  : s === "cook" ? "Ready to cook"
  : s === "dispatch" ? "In the kitchen"
  : s === "transit" ? "On the road"
  : "No orders";

type Slot = {
  mealType: MealType;
  placed: FoodOrder[];
  accepted: FoodOrder[];
  preparing: FoodOrder[];
  dispatched: FoodOrder[];
  live: FoodOrder[];
  dishes: KitchenSummaryDish[];
  people: number;
  state: KState;
};

/** Column micro-heading (same primitive as Food Overview's ColumnHead). */
function ColumnHead({ icon, label, tone, right }: {
  icon: React.ReactNode; label: string; tone: string; right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-[7px]">
      <span style={{ color: tone }} className="flex">{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: tone }}>
        {label}
      </span>
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** One property · headcount row inside a pipeline column. */
function OrderRow({ o }: { o: FoodOrder }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
      <span className="min-w-0 truncate text-[13px]">{o.propertyName ?? "Property"}</span>
      <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums text-muted-foreground">
        {o.residentsCount ?? 0} ppl
      </span>
    </div>
  );
}

function ColumnEmpty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-2 py-5 text-center text-[13px] text-muted-foreground">
      {text}
    </div>
  );
}

export default function FoodKitchenHome() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { confetti, fire } = useConfetti();
  const { role, can } = usePermissions();
  // Accept/prepare are FOOD_KITCHEN_SUMMARY edit; sending a van is
  // FOOD_DISPATCH edit — mirror the server so view-only roles (auditors,
  // leadership) get a read-only board instead of buttons that 403.
  const canKitchen = can("FOOD_KITCHEN_SUMMARY", "edit");
  const canDispatch = can("FOOD_DISPATCH", "edit");
  const roleLabel =
    role === "FNB_MANAGER" ? "F&B manager view"
    : role === "FNB_SUPERVISOR" ? "F&B supervisor view"
    : role === "FNB_ZONAL_HEAD" ? "F&B zonal head view"
    : "Kitchen view";

  // ── Day navigation: yesterday / today / tomorrow ──────────────────────────
  const [day, setDay] = React.useState(0);
  const [pickedMeal, setPickedMeal] = React.useState<MealType | null>(null);
  React.useEffect(() => { setPickedMeal(null); }, [day]);

  // The kitchen's day is an IST calendar day (order serviceDates are anchored
  // to IST server-side) — so "Today" follows Asia/Kolkata, not the viewer's
  // clock. A viewer west of IST would otherwise act on an already-finished day.
  const istTodayYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const dayDate = addDays(parseISO(istTodayYmd), day);
  const date = format(dayDate, "yyyy-MM-dd");
  const dayLabel = day === -1 ? "Yesterday" : day === 0 ? "Today" : "Tomorrow";

  // ── Data ──────────────────────────────────────────────────────────────────
  const summaryParams = { date };
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: foodKeys.kitchenSummary(summaryParams),
    queryFn: () => foodApi.kitchenSummary(summaryParams),
  });

  // The live pipeline for the day. serviceDate is the exact-day filter the
  // server supports; the status list matches the operational clamp for F&B.
  // The server caps `limit` at 100, so page through until meta.total is
  // covered — otherwise a big day silently truncates and "Accept all" would
  // celebrate while unfetched PLACED orders remain. Bounded at 5 pages as a
  // runaway stop (500 live orders in one day means something else is wrong).
  const ordersParams = { serviceDate: date, status: "PLACED,ACCEPTED,PREPARING,DISPATCHED", limit: 100 };
  const { data: orders = [], isLoading: ordersLoading } = useQuery({
    queryKey: foodKeys.orders(ordersParams),
    queryFn: async () => {
      const all: FoodOrder[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await foodApi.listOrders({ ...ordersParams, page });
        const batch = res.data ?? [];
        all.push(...batch);
        const total = res.meta?.total ?? all.length;
        if (batch.length === 0 || all.length >= total) break;
      }
      return all;
    },
    refetchInterval: 60_000,
  });

  const { data: lookups } = useQuery({ queryKey: foodKeys.lookups(), queryFn: () => foodApi.lookups() });
  const agencies = lookups?.agencies ?? [];
  const { data: kitchens = [] } = useQuery({ queryKey: foodKeys.kitchens(), queryFn: () => foodApi.listKitchens() });
  const kitchenName = (id: string | null) =>
    id ? kitchens.find((k) => k.id === id)?.name ?? "this kitchen" : "the kitchen";

  // ── Per-meal slots ────────────────────────────────────────────────────────
  const slots: Slot[] = MEAL_TYPES.map((mealType) => {
    const live = orders.filter((o) => o.mealType === mealType);
    const placed = live.filter((o) => o.status === "PLACED");
    const accepted = live.filter((o) => o.status === "ACCEPTED");
    const preparing = live.filter((o) => o.status === "PREPARING");
    const dispatched = live.filter((o) => o.status === "DISPATCHED");
    const dishes = summary?.meals.find((m) => m.mealType === mealType)?.dishes ?? [];
    const people = live.reduce((s, o) => s + (o.residentsCount || 0), 0);
    const state: KState =
      placed.length ? "accept"
      : accepted.length ? "cook"
      : preparing.length ? "dispatch"
      : dispatched.length ? "transit"
      : "quiet";
    return { mealType, placed, accepted, preparing, dispatched, live, dishes, people, state };
  });

  // Auto-focus the meal that needs a hand; a manual pick always wins.
  const selected: Slot =
    (pickedMeal && slots.find((s) => s.mealType === pickedMeal)) ||
    slots.find((s) => s.state === "accept") ||
    slots.find((s) => s.state === "cook") ||
    slots.find((s) => s.state === "dispatch") ||
    slots.find((s) => s.live.length > 0 || s.dishes.length > 0) ||
    slots[0];

  // Pin the auto-pick once data lands so a background refetch (60s poll or a
  // colleague's action) can't swap the panel under the user's cursor. Actions
  // release the pin on success (setPickedMeal(null)) to advance the focus to
  // the next meal that needs a hand — the kanban feel, but only on OUR action.
  const loadingAny = ordersLoading || summaryLoading;
  React.useEffect(() => {
    if (!pickedMeal && !loadingAny && selected) setPickedMeal(selected.mealType);
  }, [pickedMeal, loadingAny, selected?.mealType]);

  const totalPlaced = slots.reduce((n, s) => n + s.placed.length, 0);
  const totalPeople = slots.reduce((n, s) => n + s.people, 0);

  // ── Actions ───────────────────────────────────────────────────────────────
  // One shared busy flag — the loops are sequential so each transition event
  // lands cleanly on the order timeline (same pattern as Kitchen Summary).
  const [busy, setBusy] = React.useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["food"] });

  const runAccept = async (targets: FoodOrder[], label: string, key: string) => {
    if (busy || targets.length === 0) return;
    setBusy(key);
    let ok = 0, fail = 0;
    for (const o of targets) {
      try { await foodApi.acceptOrder(o.id); ok++; } catch { fail++; }
    }
    // Await the refetch so the buttons re-enable against FRESH counts (no
    // re-click window on stale data), then release the focus pin so the panel
    // advances to the next meal that needs a hand.
    await invalidate();
    setPickedMeal(null);
    setBusy(null);
    if (fail === 0) {
      fire();
      toast({ title: `${label} accepted`, description: `${ok} order${ok === 1 ? "" : "s"} moved to the kitchen queue.`, variant: "success" });
    } else {
      toast({ title: `${ok} accepted, ${fail} failed`, variant: fail > ok ? "destructive" : "warning" });
    }
  };

  const acceptMeal = (s: Slot) => runAccept(s.placed, shortMeal(s.mealType), `accept:${s.mealType}`);
  const acceptEverything = () =>
    runAccept(slots.flatMap((s) => s.placed), `${dayLabel}'s orders`, "accept:ALL");

  const startCooking = async (s: Slot) => {
    if (busy || s.accepted.length === 0) return;
    setBusy(`cook:${s.mealType}`);
    let ok = 0, fail = 0;
    for (const o of s.accepted) {
      try { await foodApi.prepareOrder(o.id); ok++; } catch { fail++; }
    }
    await invalidate();
    setPickedMeal(null);
    setBusy(null);
    if (fail === 0) {
      fire();
      toast({ title: `${shortMeal(s.mealType)} is on the stove`, description: `${ok} order${ok === 1 ? "" : "s"} marked Preparing.`, variant: "success" });
    } else {
      toast({ title: `${ok} started, ${fail} failed`, variant: fail > ok ? "destructive" : "warning" });
    }
  };

  // PREPARING orders grouped per kitchen — a van is one kitchen, so each group
  // becomes its own trip (kitchen-agnostic orders ride together as one group).
  const vanGroups = (s: Slot): Array<[string | null, FoodOrder[]]> => {
    const m = new Map<string | null, FoodOrder[]>();
    for (const o of s.preparing) {
      const k = o.kitchenId ?? null;
      m.set(k, [...(m.get(k) ?? []), o]);
    }
    return [...m.entries()];
  };

  // Kitchen-bound groups auto-pick a partner that actually serves the kitchen
  // (the server validates the link). Kitchen-agnostic groups (no kitchenId)
  // have no "serves" relation to validate against, so we never auto-book an
  // arbitrary partner — the user must pick one explicitly.
  const [agnosticAgency, setAgnosticAgency] = React.useState("");
  const servingAgency = (kid: string | null) =>
    kid
      ? agencies.find((a) => (a.kitchenIds ?? []).includes(kid))
      : agencies.find((a) => a.id === agnosticAgency);

  const sendVan = async (kid: string | null, group: FoodOrder[]) => {
    if (busy) return;
    const agency = servingAgency(kid);
    if (!agency) {
      toast({
        title: kid ? "No delivery partner serves this kitchen" : "Pick a delivery partner first",
        variant: "destructive",
      });
      return;
    }
    setBusy(`send:${kid ?? "none"}`);
    try {
      const trip = await foodApi.createDispatch({
        orderIds: group.map((o) => o.id),
        agencyId: agency.id,
        kitchenId: kid ?? undefined,
      });
      fire();
      toast({
        title: "Van sent off",
        description: trip?.dispatchNumber ? `Trip ${trip.dispatchNumber} is on its way with ${agency.name}` : undefined,
        variant: "success",
      });
      setPickedMeal(null);
      setAgnosticAgency("");
    } catch (e: any) {
      toast({ title: e?.message || "Could not create the trip", variant: "destructive" });
    }
    await invalidate();
    setBusy(null);
  };

  const loading = ordersLoading || summaryLoading;
  const tint = STATE_TINT[selected?.state ?? "quiet"];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
      {confetti}

      {/* Header */}
      <div>
        <span className="mb-2 inline-block self-start rounded-full bg-info-soft px-[9px] py-[3px] text-[10px] font-bold uppercase tracking-[.08em] text-info">
          {roleLabel}
        </span>
        <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">Kitchen Home</h1>
        <p className="text-sm text-muted-foreground">
          Your kitchen day — accept orders, cook, and send the vans from one place.
        </p>
      </div>

      {/* Hero: what needs the kitchen's attention for the selected day */}
      {ordersLoading ? (
        <Skeleton className="h-24 w-full rounded-[14px]" />
      ) : totalPlaced > 0 ? (
        <section className="rounded-[14px] bg-brand-gradient p-[2px]">
          <div className="flex flex-wrap items-center gap-[18px] rounded-[12px] bg-card px-6 py-5">
            <div className="min-w-[220px] flex-1">
              <div className="font-display text-lg font-bold tracking-[-0.012em]">
                {totalPlaced} order{totalPlaced === 1 ? "" : "s"} waiting for the kitchen
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {dayLabel}, {format(dayDate, "EEEE, dd MMM")} ·{" "}
                <strong className="text-accent-strong">{totalPeople} people</strong> to feed
              </div>
            </div>
            {canKitchen && (
              <button
                type="button"
                onClick={acceptEverything}
                disabled={!!busy}
                className="h-[52px] rounded-[12px] bg-accent px-6 font-display text-base font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105 disabled:opacity-60"
              >
                {busy === "accept:ALL" ? "Accepting…" : "Accept all →"}
              </button>
            )}
          </div>
        </section>
      ) : orders.length > 0 ? (
        <section className="flex items-center gap-3.5 rounded-[14px] bg-success-soft px-[22px] py-4">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-success">
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          </span>
          <div className="flex-1">
            <div className="font-display font-bold tracking-[-0.012em] text-success">
              Everything&rsquo;s accepted
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {format(dayDate, "EEEE, dd MMM")} · {totalPeople} people · cook, then send the vans below.
            </div>
          </div>
        </section>
      ) : null}

      {/* Kitchen day: day nav + meal tabs + detail */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 font-display text-base font-bold tracking-[-0.012em]">Kitchen day</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDay((d) => Math.max(-1, d - 1))}
              aria-label="Previous day"
              disabled={day <= -1}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-border bg-card text-foreground disabled:text-border"
            >
              <ChevronLeft className="h-[15px] w-[15px]" />
            </button>
            <span className="min-w-[130px] text-center">
              <span className="block font-display text-sm font-bold tracking-[-0.012em]">{dayLabel}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {format(dayDate, "EEE, dd MMM")}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setDay((d) => Math.min(1, d + 1))}
              aria-label="Next day"
              disabled={day >= 1}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-border bg-card text-foreground disabled:text-border"
            >
              <ChevronRight className="h-[15px] w-[15px]" />
            </button>
          </div>
        </div>

        {/* Meal tabs */}
        {loading ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] min-w-[150px] flex-1 rounded-[14px]" />
            ))}
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap gap-3">
            {slots.map((s) => {
              const t = STATE_TINT[s.state];
              const isSel = s.mealType === selected?.mealType;
              const actionable = s.state === "accept" || s.state === "cook";
              return (
                <button
                  key={s.mealType}
                  type="button"
                  onClick={() => setPickedMeal(s.mealType)}
                  className="flex min-w-[150px] flex-1 basis-[160px] flex-col items-start gap-[7px] rounded-[14px] px-4 py-3.5 text-left transition-shadow"
                  style={{
                    background: isSel ? `color-mix(in srgb, ${t} 12%, var(--card))` : "var(--card)",
                    border: isSel ? `1.5px solid ${t}` : "1px solid var(--border)",
                    boxShadow: isSel ? `0 6px 18px color-mix(in srgb, ${t} 16%, transparent)` : "none",
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <MealIcon meal={s.mealType} size={26} />
                    <span className="flex-1 text-left font-display text-[15px] font-bold tracking-[-0.012em]">
                      {shortMeal(s.mealType)}
                    </span>
                    <span
                      className={cn("h-[9px] w-[9px] shrink-0 rounded-full", actionable && "animate-pulse-dot")}
                      style={{ background: t }}
                    />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">by {SERVE_BY[s.mealType]}</span>
                  <span
                    className="self-start rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                    style={{ background: `color-mix(in srgb, ${t} 16%, var(--card))`, color: t }}
                  >
                    {stateShort(s.state, s.placed.length)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Detail panel for the selected meal */}
        {loading ? (
          <Skeleton className="h-40 w-full rounded-2xl" />
        ) : selected ? (
          <div className="rounded-2xl border border-border bg-card p-[18px]">
            {/* Meal head */}
            <div className="mb-4 flex flex-wrap items-center gap-2.5">
              <span className="font-display text-[17px] font-bold tracking-[-0.012em]">
                {MEAL_LABEL[selected.mealType]}
              </span>
              <span className="font-mono text-xs text-muted-foreground">serve by {SERVE_BY[selected.mealType]}</span>
              <span className="flex-1" />
              <span
                className="rounded-full px-[11px] py-1 text-xs font-bold"
                style={{ background: `color-mix(in srgb, ${tint} 16%, var(--card))`, color: tint }}
              >
                {stateShort(selected.state, selected.placed.length)}
              </span>
              <Link href="/food/kitchen-summary">
                <span className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
                  <Soup className="h-3.5 w-3.5" /> Full summary
                </span>
              </Link>
            </div>

            {/* Cook plan */}
            <div className="mb-3 rounded-[12px] border border-border bg-background px-4 py-3.5">
              <ColumnHead
                icon={<Soup className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                label="Cook plan"
                tone="var(--accent-strong)"
                right={selected.people > 0 ? (
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {selected.people} people
                  </span>
                ) : undefined}
              />
              {selected.dishes.length === 0 ? (
                <div className="rounded-[9px] border border-dashed border-border px-3 py-5 text-center text-[13px] text-muted-foreground">
                  No cook plan for {shortMeal(selected.mealType).toLowerCase()} {dayLabel.toLowerCase()} — it fills in as orders land.
                </div>
              ) : (
                <div className="-mr-1 max-h-[240px] overflow-y-auto pr-1">
                  {selected.dishes.map((d) => (
                    <div
                      key={`${d.dishId}|${d.unit}`}
                      className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0"
                    >
                      <span className="min-w-0 truncate text-[13px]">{d.dishName}</span>
                      <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums">
                        {fmtQty(d.displayQty)} <span className="text-muted-foreground">{d.displayUnit}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pipeline: accept → cook → send */}
            <div className="grid items-stretch gap-3 md:grid-cols-3">
              {/* Accept */}
              <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
                <ColumnHead
                  icon={<Inbox className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                  label="New orders"
                  tone="var(--warning)"
                  right={selected.placed.length > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selected.placed.length}</span>
                  ) : undefined}
                />
                {selected.placed.length === 0 ? (
                  <ColumnEmpty text="Nothing waiting — all caught up." />
                ) : (
                  <>
                    <div className="flex-1">
                      {selected.placed.map((o) => <OrderRow key={o.id} o={o} />)}
                    </div>
                    {canKitchen && (
                      <button
                        type="button"
                        onClick={() => acceptMeal(selected)}
                        disabled={!!busy}
                        className="mt-3 h-10 w-full rounded-[9px] bg-warning text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === `accept:${selected.mealType}` ? "Accepting…" : `Accept all (${selected.placed.length})`}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Cook */}
              <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
                <ColumnHead
                  icon={<CookingPot className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                  label="Cook"
                  tone="var(--pop)"
                  right={selected.accepted.length > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selected.accepted.length}</span>
                  ) : undefined}
                />
                {selected.accepted.length === 0 ? (
                  <ColumnEmpty
                    text={selected.preparing.length > 0 || selected.dispatched.length > 0
                      ? "The stove is already going."
                      : "Accept orders to start cooking."}
                  />
                ) : (
                  <>
                    <div className="flex-1">
                      {selected.accepted.map((o) => <OrderRow key={o.id} o={o} />)}
                    </div>
                    {canKitchen && (
                      <button
                        type="button"
                        onClick={() => startCooking(selected)}
                        disabled={!!busy}
                        className="mt-3 h-10 w-full rounded-[9px] bg-pop text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === `cook:${selected.mealType}` ? "Starting…" : `Start cooking (${selected.accepted.length})`}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Send */}
              <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
                <ColumnHead
                  icon={<Truck className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                  label="Send the van"
                  tone="var(--success)"
                  right={selected.preparing.length > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selected.preparing.length}</span>
                  ) : undefined}
                />
                {selected.preparing.length === 0 ? (
                  <ColumnEmpty
                    text={selected.dispatched.length > 0
                      ? "All vans are out."
                      : "Cooking orders appear here when they're ready to go."}
                  />
                ) : (
                  <div className="flex flex-1 flex-col">
                    <div className="flex-1">
                      {vanGroups(selected).map(([kid, group]) => {
                        const agency = servingAgency(kid);
                        const many = vanGroups(selected).length > 1;
                        return (
                          <div key={kid ?? "none"} className="mb-1.5 last:mb-0">
                            {many && (
                              <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                                {kitchenName(kid)}
                              </div>
                            )}
                            {group.map((o) => <OrderRow key={o.id} o={o} />)}
                            {!canDispatch ? null : kid === null ? (
                              <>
                                {/* No kitchen on these orders → nothing to auto-
                                    match a partner against; ask for an explicit pick. */}
                                <Select value={agnosticAgency} onValueChange={setAgnosticAgency}>
                                  <SelectTrigger className="mt-2 h-9 w-full text-xs">
                                    <SelectValue placeholder="Pick a delivery partner" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {agencies.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
                                  </SelectContent>
                                </Select>
                                <button
                                  type="button"
                                  onClick={() => sendVan(kid, group)}
                                  disabled={!!busy || !agnosticAgency}
                                  className="mt-2 h-10 w-full rounded-[9px] bg-success text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === "send:none" ? "Sending…" : `Send the van (${group.length})`}
                                </button>
                              </>
                            ) : agency ? (
                              <button
                                type="button"
                                onClick={() => sendVan(kid, group)}
                                disabled={!!busy}
                                className="mt-2 h-10 w-full rounded-[9px] bg-success text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === `send:${kid}` ? "Sending…" : `Send the van (${group.length})`}
                              </button>
                            ) : (
                              <div className="mt-2 flex items-start gap-1.5 rounded-[9px] bg-warning-soft px-2.5 py-2 text-[11px] text-warning">
                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>No partner serves {kitchenName(kid)} — link one in Masters.</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {selected.dispatched.length > 0 && (
                  <div className="mt-2.5 flex items-center gap-1.5 text-[12px] font-semibold text-success">
                    <Truck className="h-3.5 w-3.5" />
                    {selected.dispatched.length} on the road
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* Quick links */}
      <div className="flex flex-wrap justify-end gap-2">
        <Link href="/food/kitchen-summary">
          <span className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
            <Soup className="h-3.5 w-3.5" />
            Full kitchen summary
            <ChevronRight className="h-[13px] w-[13px]" />
          </span>
        </Link>
        <Link href="/food/dispatch">
          <span className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
            <History className="h-3.5 w-3.5" />
            Dispatch board
            <ChevronRight className="h-[13px] w-[13px]" />
          </span>
        </Link>
      </div>
    </div>
  );
}
