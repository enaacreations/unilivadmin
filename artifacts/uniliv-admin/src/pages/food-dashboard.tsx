import * as React from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, differenceInMinutes, format, parseISO } from "date-fns";
import {
  AlertTriangle, Ban, BarChart3, Check, ChevronLeft, ChevronRight, Clock, Eye, History, Loader2, Lock, MapPin, PartyPopper, Truck, Trash2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PropertyOptions } from "@/components/property-options";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { MealIcon, DishIcon } from "@/components/meal-icon";
import { useToast } from "@/hooks/use-toast";
import { useConfetti } from "@/components/ui/confetti";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import {
  foodApi,
  foodKeys,
  MEAL_LABEL,
  MEAL_TYPES,
  shortMeal,
  isFractionalUnit,
  fmtQty,
  type FoodOrder,
  type MealType,
  type OrderDetail,
  type OrderStatus,
} from "@/lib/food-api";

/* ────────────────────────────── helpers ────────────────────────────── */

/** Escalation contact for missed-order incidents. TODO: source from server
 *  config / the property's cluster manager once such an endpoint exists. */
const ADMIN_CONTACT_EMAIL = "admin@uniliv.com";

/** Per-dish order-mode override: pin a headcount, an absolute qty, or both. */
type DishOverride = { persons?: number };

const num = (v: string | null | undefined): number => {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const fmtTime = (iso: string | null | undefined): string =>
  iso ? format(parseISO(iso), "h:mm a") : "";

/** Re-render every `ms` so countdowns tick. Countdowns display minute
 *  granularity, so a 60s tick keeps them honest at half the render cost. */
function useNow(ms = 60_000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "Xh Ym" until an ISO deadline (clamped at 0). */
function untilLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const mins = Math.max(0, differenceInMinutes(parseISO(iso), now));
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Friendly "time until delivery" for an ETA — "~35 min", "~1 hr 20 min",
 *  "any moment now". null when there's no ETA to show. */
function deliverIn(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const mins = differenceInMinutes(parseISO(iso), now);
  if (mins <= 1) return "any moment now";
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `~${h} hr ${m} min` : `~${h} hr`;
}

/** Journey state of one meal — drives the tab tint + which panel is live.
 *  done=success, action=needs the user now, waiting=muted. */
type MealState = "done" | "action-confirm" | "action-waste" | "waiting" | "cancelled" | "none";

const STATE_TINT: Record<MealState, string> = {
  done: "var(--success)",
  "action-confirm": "var(--warning)",
  "action-waste": "var(--pop)",
  waiting: "var(--muted)",
  cancelled: "var(--muted)",
  none: "var(--muted)",
};

const STATE_SHORT: Record<MealState, string> = {
  done: "Done",
  "action-confirm": "At gate",
  "action-waste": "Log waste",
  waiting: "Scheduled",
  cancelled: "Cancelled",
  none: "Not ordered",
};

interface MealSlot {
  mealType: MealType;
  order: FoodOrder | null;
  state: MealState;
  /** Short time shown on the tab ("7:12 AM" / "by 8:00 PM"). */
  time: string;
  /** One-line status shown in the detail head. */
  statusLine: string;
}

/** Map a real order (or its absence) onto the journey visual state. */
function slotFor(mealType: MealType, order: FoodOrder | null, now: Date, kitchenName?: string): MealSlot {
  if (!order) {
    return { mealType, order, state: "none", time: "—", statusLine: "Not ordered" };
  }
  const s = order.status;
  // Cool-down semantics: wasteEditableUntil is when logging OPENS — the meal
  // must be over (delivered + window) before leftovers can be counted.
  const wasteOpensAt = order.wasteEditableUntil ? parseISO(order.wasteEditableUntil) : null;
  const wasteOpen = !!wasteOpensAt && now.getTime() >= wasteOpensAt.getTime();
  const wasteWaitMins = wasteOpensAt ? Math.max(0, differenceInMinutes(wasteOpensAt, now)) : 0;
  if (s === "CANCELLED" || s === "REJECTED") {
    return {
      mealType, order, state: "cancelled",
      time: fmtTime(order.cancelledAt ?? order.rejectedAt) || "—",
      statusLine: s === "CANCELLED" ? "Cancelled before the kitchen started" : "Rejected by the kitchen",
    };
  }
  if (s === "DELIVERED") {
    // Waste already recorded is only knowable from the detail (items); the
    // caller overrides state to "done" once it has that info.
    return {
      mealType, order,
      state: wasteOpen ? "action-waste" : "done",
      time: fmtTime(order.deliveredAt) || "—",
      statusLine: wasteOpen
        ? "Meal over — record any waste now"
        : wasteOpensAt
          ? `Received & confirmed — waste logging opens in ${wasteWaitMins}m`
          : "Received & confirmed",
    };
  }
  // For everything still on its way, the tab time becomes a live delivery ETA
  // ("~35 min") and the status line spells out that it's the delivery estimate.
  const eta = deliverIn(order.expectedDeliveryAt, now);
  const etaPhrase = eta ? (eta === "any moment now" ? "arriving any moment now" : `likely delivered in ${eta}`) : null;
  if (s === "DISPATCHED") {
    return {
      mealType, order, state: "action-confirm",
      time: eta ?? "now",
      statusLine: etaPhrase ? `Out for delivery — ${etaPhrase}` : "At your gate — count it in",
    };
  }
  // PLACED / ACCEPTED
  const base = s === "ACCEPTED" ? "Accepted by the kitchen" : "Waiting for the kitchen to accept";
  return {
    mealType, order, state: "waiting",
    time: eta ?? "—",
    statusLine: etaPhrase ? `${base} · ${etaPhrase}` : base,
  };
}

/** Canonical tracking ladder; events fill in the completed rungs. */
const LADDER: { status: OrderStatus; label: string }[] = [
  { status: "PLACED", label: "Order placed" },
  { status: "ACCEPTED", label: "Accepted by kitchen" },
  { status: "DISPATCHED", label: "Dispatched" },
  { status: "DELIVERED", label: "Received & confirmed" },
];

/* ─────────────────────────── tiny primitives ─────────────────────────── */

function CheckDot({ done, size = 24 }: { done: boolean; size?: number }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        done ? "bg-success" : "bg-muted border-2 border-border",
      )}
      style={{ width: size, height: size }}
    >
      {done && <Check className="h-[11px] w-[11px] text-white" strokeWidth={3} />}
    </span>
  );
}

function MiniStepper({
  value, display, onMinus, onPlus,
}: {
  value: number;
  display: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onMinus}
        aria-label="Less"
        disabled={value <= 0}
        className="h-[26px] w-[26px] rounded-[7px] border border-border bg-card text-sm text-foreground hover:bg-muted disabled:opacity-40"
      >
        −
      </button>
      <span className="min-w-[52px] text-center font-mono text-[12.5px] font-semibold tabular-nums">
        {display}
      </span>
      <button
        type="button"
        onClick={onPlus}
        aria-label="More"
        className="h-[26px] w-[26px] rounded-[7px] border border-border bg-card text-sm text-foreground hover:bg-muted"
      >
        +
      </button>
    </span>
  );
}

function ColumnHead({ icon, label, tone, right }: {
  icon: React.ReactNode;
  label: string;
  tone: string;
  right?: React.ReactNode;
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

function LockedPanel({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-2 py-[18px] text-center text-muted-foreground">
      <Lock className="h-[26px] w-[26px]" />
      <span className="text-[13px]">{text}</span>
    </div>
  );
}

/* ────────────────────────────── the page ────────────────────────────── */

export default function FoodDashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { me, can } = usePermissions();
  const { confetti, fire } = useConfetti();
  const now = useNow();

  const canPlace = can("FOOD_PLACE_ORDER", "create");
  const canConfirm = can("FOOD_CONFIRM_DELIVERY", "edit") || can("FOOD_CONFIRM_DELIVERY", "create");
  const canWaste = can("FOOD_WASTE_TRACKING", "edit") || can("FOOD_WASTE_TRACKING", "create");
  // Cancel mirrors the server guard (food.ts POST /orders/:id/cancel): either
  // permission, on a pre-dispatch order.
  const canCancel = can("FOOD_PLACE_ORDER", "edit") || can("FOOD_KITCHEN_SUMMARY", "edit");
  const canViewReports = can("FOOD_REPORTS", "view");
  // GET /food/orders(+/:id) is server-gated on FOOD_ALL_ORDERS. Some food
  // personas (FNB supervisor/manager/zonal head, SVP) hold FOOD_DASHBOARD but
  // not FOOD_ALL_ORDERS — for them every order query would 403. Gate the
  // queries and show an honest state instead of silently-empty meal slots.
  const canReadOrders = can("FOOD_ALL_ORDERS", "view");

  /* ── property scope: global store ?? own property ?? sole property ── */
  const { propertyId: storePropertyId, setPropertyId } = useAppStore();
  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
    staleTime: 300_000,
  });
  const properties = lookups?.properties ?? [];
  const propertyId =
    storePropertyId ??
    me?.propertyId ??
    (properties.length === 1 ? properties[0].id : null);

  const { data: overview } = useQuery({
    queryKey: foodKeys.propertyOverview({ propertyId }),
    queryFn: () => foodApi.propertyOverview({ propertyId: propertyId! }),
    enabled: !!propertyId,
  });

  /* ── journey day: -1 yesterday / 0 today / forward to the next orderable
     service day (usually +1 tomorrow; +2 once tomorrow's cut-off passes, so
     ordering ALWAYS happens inline on this page — prototype behaviour). ── */
  const [journeyDay, setJourneyDay] = React.useState(0);
  const dayDate = addDays(now, journeyDay);
  const serviceDate = format(dayDate, "yyyy-MM-dd");

  const { data: dayOrders, isLoading: ordersLoading } = useQuery({
    queryKey: foodKeys.orders({ serviceDate, propertyId, journey: true }),
    queryFn: () =>
      foodApi
        .listOrders({ serviceDate, propertyId: propertyId ?? undefined, limit: 50 })
        .then((r) => r.data),
    enabled: !!propertyId && canReadOrders,
    refetchInterval: 60_000,
  });

  /* ── tomorrow's order state (hero + order mode) ── */
  // Cut-off/ordered state changes a handful of times a day — a 5-minute poll
  // is plenty (mutations invalidate it immediately; the countdown ticks on
  // the client clock regardless).
  const { data: nextOrders } = useQuery({
    queryKey: foodKeys.nextOrders(),
    queryFn: () => foodApi.nextOrders(),
    refetchInterval: 300_000,
  });
  const myNext = nextOrders?.find((p) => p.propertyId === propertyId) ?? null;
  const orderedMealTypes = new Set((myNext?.orderedMeals ?? []).map((m) => m.mealType));
  const missingMeals = (myNext?.availableMeals ?? []).filter((m) => !orderedMealTypes.has(m.mealType));
  // Days ahead of today for the next orderable service date: 1 = tomorrow;
  // 2 = the day after, once tomorrow's cut-off has passed (the server rolls
  // next-orders forward). The journey's forward range extends to this day so
  // the place-order UI lives inline here in every case.
  const nextOffset = myNext
    ? Math.max(1, differenceInCalendarDays(parseISO(myNext.serviceDate), now))
    : 1;
  const maxDay = Math.max(1, nextOffset);
  const nextIsTomorrow = nextOffset === 1;
  const nextDayLabel = myNext
    ? nextIsTomorrow ? "Tomorrow" : format(parseISO(myNext.serviceDate), "EEEE")
    : "Tomorrow";
  const nextPending =
    !!myNext && myNext.configured && missingMeals.length > 0 && !myNext.isPastCutoff;
  const nextPlaced = !!myNext && orderedMealTypes.size > 0 && missingMeals.length === 0;

  // Keep the selected day inside the visible range if the range shrinks
  // (e.g. next-orders advances after midnight or after placing).
  React.useEffect(() => {
    if (journeyDay > maxDay) setJourneyDay(maxDay);
  }, [journeyDay, maxDay]);

  /* ── missed tomorrow: the cut-off has passed (next-orders rolled beyond
     tomorrow) and NOTHING was ordered for tomorrow. The app can no longer
     take that order, so surface it as an incident with an escalation CTA. ── */
  const tomorrowYmd = format(addDays(now, 1), "yyyy-MM-dd");
  const { data: tomorrowOrders } = useQuery({
    queryKey: foodKeys.orders({ serviceDate: tomorrowYmd, propertyId, missCheck: true }),
    queryFn: () =>
      foodApi
        .listOrders({ serviceDate: tomorrowYmd, propertyId: propertyId ?? undefined, limit: 20 })
        .then((r) => r.data),
    enabled: !!propertyId && canReadOrders && nextOffset > 1,
    staleTime: 60_000,
  });
  const missedTomorrow =
    nextOffset > 1 &&
    tomorrowOrders != null &&
    !tomorrowOrders.some((o) => o.status !== "CANCELLED" && o.status !== "REJECTED");
  // The missed day is literal-tomorrow (journeyDay 1). Surface the incident
  // inside the journey only when the user actually navigates to that day —
  // not as a persistent top-of-page banner.
  const selectedDayMissed = missedTomorrow && journeyDay === 1;
  const propertyLabel = properties.find((p) => p.id === propertyId)?.name ?? "my property";
  const missedDayStr = format(addDays(now, 1), "EEEE, dd MMM");
  const missedMailto =
    `mailto:${ADMIN_CONTACT_EMAIL}?subject=${encodeURIComponent(
      `URGENT: missed food order for ${format(addDays(now, 1), "EEE, dd MMM")} — ${propertyLabel}`,
    )}&body=${encodeURIComponent(
      `Hi,\n\nThe order cut-off for ${missedDayStr} has passed and no food order is in for ${propertyLabel}. Please help arrange that day's meals with the kitchen.\n\nThanks`,
    )}`;

  /* ── per-meal service times for the order day ("by 2:00 PM" on the tabs
     and the detail head, like the prototype) ── */
  const propertyBrand = properties.find((p) => p.id === propertyId)?.brand ?? null;
  const { data: dayCutoffs } = useQuery({
    queryKey: foodKeys.cutoffs({ propertyId, date: myNext?.serviceDate, journey: true }),
    queryFn: () =>
      foodApi.cutoffs({ brand: propertyBrand!, propertyId: propertyId!, date: myNext!.serviceDate }),
    enabled: !!propertyId && !!propertyBrand && !!myNext,
    staleTime: 300_000,
  });

  /* ── meal slots for the selected day ── */
  const kitchenName = undefined; // kitchen name comes from the order detail below
  const slots: MealSlot[] = React.useMemo(() => {
    const byMeal = new Map<MealType, FoodOrder>();
    (dayOrders ?? []).forEach((o) => {
      const prev = byMeal.get(o.mealType);
      // Prefer a live order over a cancelled one for the same meal.
      if (!prev || prev.status === "CANCELLED" || prev.status === "REJECTED") byMeal.set(o.mealType, o);
    });
    // "by 2:00 PM" from the meal's configured service time (order day only).
    const svcTime = (mt: MealType): string => {
      const t = dayCutoffs?.find((c) => c.mealType === mt)?.serviceTime;
      if (!t) return "—";
      const [h, m] = t.split(":").map(Number);
      const d = new Date();
      d.setHours(h, m || 0, 0, 0);
      return `by ${format(d, "h:mm a")}`;
    };
    // On the next orderable day the tab list comes from next-orders'
    // availableMeals (the day's actual menu); other days show the four meals.
    const orderDayView = journeyDay === nextOffset && !!myNext?.availableMeals.length;
    const mealsToShow: MealType[] = orderDayView
      ? myNext!.availableMeals.map((m) => m.mealType)
      : (["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as MealType[]);
    const ordered = new Set((myNext?.orderedMeals ?? []).map((m) => m.mealType));
    return mealsToShow.map((mt) => {
      const slot = slotFor(mt, byMeal.get(mt) ?? null, now, kitchenName);
      // Meals still orderable on the order day (none or only a cancelled
      // order) show their service-window time, not the cancelled stamp.
      if (orderDayView && !ordered.has(mt)) slot.time = svcTime(mt);
      return slot;
    });
  }, [dayOrders, journeyDay, myNext, nextOffset, dayCutoffs, now]);

  /* ── order day: the journey day where the inline place-order UI lives ── */
  const orderDay = journeyDay === nextOffset && nextPending && canPlace;
  const isMissing = (mt: MealType) => missingMeals.some((m) => m.mealType === mt);

  /* ── selected meal tab (auto-focus the meal that needs action; on the
     order day, the first meal that still needs ordering) ── */
  const [pickedMeal, setPickedMeal] = React.useState<MealType | null>(null);
  const actionSlot = slots.find((s) => s.state.startsWith("action"));
  const firstMissingSlot = orderDay ? slots.find((s) => isMissing(s.mealType)) : undefined;
  const selected =
    (pickedMeal && slots.find((s) => s.mealType === pickedMeal)) ||
    firstMissingSlot ||
    actionSlot ||
    slots[0] ||
    null;

  // Reset the manual pick when flipping days so auto-focus works again.
  React.useEffect(() => { setPickedMeal(null); }, [journeyDay]);

  /* ── the selected meal's full detail (items/events/dispatch) ── */
  const selectedOrderId = selected?.order?.id ?? null;
  const { data: detail } = useQuery<OrderDetail>({
    queryKey: foodKeys.order(selectedOrderId ?? "none"),
    queryFn: () => foodApi.getOrder(selectedOrderId!),
    enabled: !!selectedOrderId,
  });

  // Waste already recorded? (any item has a non-null wastedQty)
  const wasteRecorded = !!detail?.items?.some((i) => i.wastedQty != null);
  const displayState: MealState =
    selected?.state === "action-waste" && (wasteRecorded || !canWaste) ? "done" : (selected?.state ?? "none");

  /* ── order mode: on the order day, tabs whose meal still needs ordering
     show the inline place-order UI (prototype); already-ordered meals show
     their normal Track/Received/Waste detail. ── */
  const orderMode = orderDay && !!selected && isMissing(selected.mealType);
  // Inline cancel is offered only for a real, pre-dispatch order the caller may
  // cancel — never while still placing (orderMode) or once dispatched/closed.
  const canCancelThis =
    !orderMode && !!selected?.order && canCancel &&
    (selected.order.status === "PLACED" || selected.order.status === "ACCEPTED");
  // Headcount is set PER MEAL — attendance genuinely differs across
  // breakfast/lunch/high-tea/dinner, so each meal step carries its own count.
  const [headcounts, setHeadcounts] = React.useState<Partial<Record<MealType, number>>>({});
  // Per-meal STAFF count. Staff eat the same food, so the kitchen cooks for
  // residents + staff. Kept in a SEPARATE map (residentsCount stays residents-
  // only for clean analytics); defaults to 0 so a blank/legacy meal's total
  // equals residents.
  const [staffCounts, setStaffCounts] = React.useState<Partial<Record<MealType, number>>>({});
  // Occupied residents (current occupancy) — the default residents count and the
  // basis for the 20% ordering cap.
  const occupied = myNext?.activeGuests ?? overview?.activeGuests ?? 1;
  // Residents default to current occupancy (0 for a property with no ACTIVE
  // residents — such a property orders staff-only; the Send button stays disabled
  // until at least one meal has people).
  const baseHead = occupied;
  // 20% cap: residents ordered for a meal can't exceed 120% of occupancy; a
  // property with 0 occupancy caps residents at 0 (staff stay uncapped). Mirrors
  // residentsCapForProperty on the server exactly.
  const residentsCap = occupied > 0 ? Math.ceil(occupied * 1.2) : 0;
  // Residents only — drives the residentsCount column. Can be 0 (skip the meal).
  const residentsFor = (mealType: MealType): number => headcounts[mealType] ?? baseHead;
  // Staff only — drives the new staffCount column (0 when unset).
  const staffFor = (mealType: MealType): number => staffCounts[mealType] ?? 0;
  // TOTAL people eating this meal = residents + staff. Every quantity (dish qty,
  // per-dish persons default) is computed from this.
  const effHeadFor = (mealType: MealType): number => residentsFor(mealType) + staffFor(mealType);
  // Residents clamp to [0, cap]: 0 skips the meal, cap enforces the 20% limit.
  const setResidentsFor = (mealType: MealType, n: number) =>
    setHeadcounts((h) => ({ ...h, [mealType]: Math.min(residentsCap, Math.max(0, n)) }));
  const setStaffFor = (mealType: MealType, n: number) =>
    setStaffCounts((s) => ({ ...s, [mealType]: Math.max(0, n) }));
  const { data: preview } = useQuery({
    queryKey: foodKeys.orderPreview({ propertyId, serviceDate: myNext?.serviceDate, persons: 1 }),
    queryFn: () =>
      foodApi.orderPreview({ propertyId: propertyId!, serviceDate: myNext!.serviceDate, persons: 1 }),
    enabled: orderDay && !!propertyId && !!myNext,
  });
  // Per-dish overrides, keyed `${mealType}:${dishId}`. `persons` pins how many
  // people eat THAT dish; the quantity is always derived (qtyPerResident ×
  // persons) and never edited directly.
  const [dishOverrides, setDishOverrides] = React.useState<Record<string, DishOverride>>({});
  // Order-mode edits belong to ONE property — dishIds are a shared catalogue,
  // so carrying overrides (or manual headcounts) across a property switch
  // would place the next property's order with the previous one's numbers.
  React.useEffect(() => {
    setHeadcounts({});
    setStaffCounts({});
    setDishOverrides({});
  }, [propertyId]);
  const dishKey = (mealType: MealType, dishId: string) => `${mealType}:${dishId}`;
  const dishPersons = (mealType: MealType, dishId: string): number =>
    dishOverrides[dishKey(mealType, dishId)]?.persons ?? effHeadFor(mealType);
  const dishQty = (mealType: MealType, dishId: string, perResident: number, unit: string): number => {
    const raw = perResident * dishPersons(mealType, dishId);
    return isFractionalUnit(unit) ? Math.round(raw * 10) / 10 : Math.round(raw);
  };
  const setDishPersonsOverride = (mealType: MealType, dishId: string, persons: number) => {
    setDishOverrides((q) => ({
      ...q,
      [dishKey(mealType, dishId)]: { persons: Math.max(1, persons) },
    }));
  };

  /* ── server-side draft: a half-built order follows the unit lead across
     browsers/devices (stored per user+property+serviceDate). ── */
  const draftParams =
    propertyId && myNext ? { propertyId, serviceDate: myNext.serviceDate } : null;
  const draftId = draftParams ? `${draftParams.propertyId}:${draftParams.serviceDate}` : null;
  const { data: serverDraft } = useQuery({
    queryKey: foodKeys.orderDraft({ propertyId, serviceDate: myNext?.serviceDate }),
    queryFn: () => foodApi.orderDraft(draftParams!),
    enabled: !!draftParams && nextPending && canPlace,
    staleTime: 60_000,
    refetchOnWindowFocus: false, // never clobber in-progress edits
  });
  // Restore the draft ONCE per property+day, then let live edits win.
  const restoredFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!draftId || restoredFor.current === draftId || serverDraft === undefined) return;
    restoredFor.current = draftId;
    const p = serverDraft?.payload as
      | {
          v: number;
          headcounts?: Partial<Record<MealType, number>>;
          staffCounts?: Partial<Record<MealType, number>>;
          headcount?: number | null;
          overrides: Record<string, DishOverride>;
        }
      | null
      | undefined;
    if (p) {
      // Restored residents must respect the CURRENT cap — a draft saved when
      // occupancy was higher (or a legacy draft with no client cap) could hold a
      // count above today's residentsCap, which the server would 422 on send.
      const clampRes = (n: number) => Math.min(residentsCap, Math.max(0, n));
      if (p.headcounts && typeof p.headcounts === "object") {
        // v2+: per-meal residents.
        const clamped: Partial<Record<MealType, number>> = {};
        for (const [m, n] of Object.entries(p.headcounts)) {
          if (typeof n === "number") clamped[m as MealType] = clampRes(n);
        }
        setHeadcounts(clamped);
      } else if (typeof p.headcount === "number") {
        // Legacy v1 draft (single scalar) — apply it to every meal so a
        // resumed pre-deploy draft keeps the count the lead had set.
        const h = clampRes(p.headcount);
        setHeadcounts(Object.fromEntries(MEAL_TYPES.map((m) => [m, h])) as Partial<Record<MealType, number>>);
      }
      // v3+: per-meal staff. v1/v2 drafts have no staffCounts → stays {} → 0.
      if (p.staffCounts && typeof p.staffCounts === "object") setStaffCounts(p.staffCounts);
      if (p.overrides && typeof p.overrides === "object") {
        // Overrides are people-only now. Sanitize legacy pre-deploy drafts that
        // pinned an absolute `qty` (a removed feature) down to their `persons`
        // pin so no stale, no-longer-honored qty lingers in state.
        const clean: Record<string, DishOverride> = {};
        for (const [k, v] of Object.entries(p.overrides)) {
          if (v && typeof (v as DishOverride).persons === "number") clean[k] = { persons: (v as DishOverride).persons };
        }
        setDishOverrides(clean);
      }
    }
  }, [serverDraft, draftId]);
  // Debounced autosave of every edit (per-meal residents/staff / per-dish overrides).
  const draftDirty =
    Object.keys(headcounts).length > 0 ||
    Object.keys(staffCounts).length > 0 ||
    Object.keys(dishOverrides).length > 0;
  const [draftSavedAt, setDraftSavedAt] = React.useState<Date | null>(null);
  const [savingDraft, setSavingDraft] = React.useState(false);
  React.useEffect(() => {
    if (!draftParams || !nextPending || !canPlace || !draftDirty) return;
    if (restoredFor.current !== draftId) return; // wait for the restore pass
    const t = setTimeout(() => {
      setSavingDraft(true);
      foodApi
        .saveOrderDraft({ ...draftParams, payload: { v: 3, headcounts, staffCounts, overrides: dishOverrides } })
        .then(() => setDraftSavedAt(new Date()))
        .catch(() => {/* draft persistence is best-effort */})
        .finally(() => setSavingDraft(false));
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headcounts, staffCounts, dishOverrides, draftId, nextPending, canPlace, draftDirty]);

  const placeMutation = useMutation({
    mutationFn: () => {
      const missing = new Set(missingMeals.map((m) => m.mealType));
      const meals = (preview?.meals ?? [])
        .filter((m) => missing.has(m.mealType))
        .map((m) => ({
          mealType: m.mealType,
          // residentsCount stays residents-ONLY (clean analytics); staffCount is
          // the new sibling. The kitchen cooks for residents + staff = total.
          residentsCount: residentsFor(m.mealType),
          staffCount: staffFor(m.mealType),
          items: m.items
            .map((it) => ({
              dishId: it.dishId,
              personsCount: dishPersons(m.mealType, it.dishId),
              orderedQty: dishQty(m.mealType, it.dishId, it.qtyPerResident, it.unit),
              unit: it.unit,
            }))
            .filter((it) => it.orderedQty > 0),
        }))
        .filter((m) => m.items.length > 0);
      return foodApi.placeOrderBatch({
        propertyId: propertyId!,
        serviceDate: myNext!.serviceDate,
        // Batch-level fallbacks; each meal carries its own residents/staff above.
        persons: missingMeals[0] ? residentsFor(missingMeals[0].mealType) : baseHead,
        staffCount: missingMeals[0] ? staffFor(missingMeals[0].mealType) : 0,
        meals,
      });
    },
    onSuccess: (res) => {
      // The draft served its purpose — clear it (server + local, best-effort).
      if (draftParams) void foodApi.deleteOrderDraft(draftParams).catch(() => {});
      setDishOverrides({});
      setHeadcounts({});
      setStaffCounts({});
      setDraftSavedAt(null);
      // Targeted refresh: order lists (incl. streak + journey), the placed
      // day's details, next-orders state and the (now deleted) draft. A broad
      // ["food"] invalidation would also re-fetch lookups/overview needlessly.
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "order"] });
      qc.invalidateQueries({ queryKey: foodKeys.nextOrders() });
      qc.invalidateQueries({ queryKey: ["food", "order-draft"] });
      fire();
      toast({
        variant: "success",
        title: `${nextIsTomorrow ? "Tomorrow" : nextDayLabel}'s order sent`,
        description: `${res.orders.length} meal${res.orders.length === 1 ? "" : "s"} on the way to the kitchen`,
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Couldn't send the order",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  /* ── receive (confirm delivery) panel state ── */
  const [ack, setAck] = React.useState(false);
  const [received, setReceived] = React.useState<Record<string, number>>({});
  const [reason, setReason] = React.useState<string | null>(null);
  /* ── inline cancel dialog state ── */
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  React.useEffect(() => {
    // Reset the receive + cancel forms whenever the focused order changes.
    setAck(false);
    setReceived({});
    setReason(null);
    setCancelOpen(false);
    setCancelReason("");
  }, [selectedOrderId]);

  const sentOf = (i: { orderedQty: string; preparedQty: string | null }) =>
    num(i.preparedQty ?? i.orderedQty);
  const receivedOf = (i: { id: string; orderedQty: string; preparedQty: string | null }) =>
    received[i.id] ?? sentOf(i);
  const mismatches = (detail?.items ?? []).filter((i) => receivedOf(i) !== sentOf(i));
  const confirmDisabled = mismatches.length > 0 && !reason;

  const confirmMutation = useMutation({
    mutationFn: () =>
      foodApi.confirmDelivery(
        detail!.id,
        detail!.items.map((i) => ({ itemId: i.id, receivedQty: receivedOf(i) })),
        mismatches.length > 0 && reason ? reason : undefined,
      ),
    onSuccess: () => {
      // Order lists + details cover everything a confirm changes.
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "order"] });
      fire();
      toast({
        variant: mismatches.length > 0 ? "warning" : "success",
        title: "Delivery confirmed",
        description:
          mismatches.length > 0
            ? `${mismatches.length} short item${mismatches.length > 1 ? "s" : ""} noted — the kitchen has been told`
            : "Everything matched the kitchen's numbers",
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Couldn't confirm the delivery",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  /* ── waste panel state ── */
  const [wasteQty, setWasteQty] = React.useState<Record<string, number>>({});
  React.useEffect(() => { setWasteQty({}); }, [selectedOrderId]);
  const wasteMutation = useMutation({
    mutationFn: () =>
      foodApi.recordWaste(
        detail!.id,
        detail!.items.map((i) => ({ itemId: i.id, wastedQty: wasteQty[i.id] ?? 0 })),
      ),
    onSuccess: () => {
      const any = Object.values(wasteQty).some((v) => v > 0);
      // Order lists + details cover everything a waste entry changes.
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "order"] });
      fire();
      toast({
        variant: "success",
        title: any ? "Waste recorded — thanks for keeping it honest" : "Zero waste recorded — brilliant!",
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Couldn't record waste",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  /* ── cancel the focused (pre-dispatch) order, with an optional reason ── */
  const cancelMutation = useMutation({
    mutationFn: () => foodApi.cancelOrder(selectedOrderId!, cancelReason.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "order"] });
      qc.invalidateQueries({ queryKey: foodKeys.nextOrders() });
      setCancelOpen(false);
      setCancelReason("");
      toast({ variant: "warning", title: "Order cancelled", description: "The kitchen has been notified." });
    },
    onError: (e: unknown) => {
      toast({
        title: "Couldn't cancel the order",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  /* ────────────────────────────── render ────────────────────────────── */

  // No property resolvable yet → pick one (managers with many properties).
  if (!propertyId) {
    return (
      <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
        <div>
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">Food</h1>
          <p className="text-sm text-muted-foreground">Pick a property to see its food day.</p>
        </div>
        <div className="rounded-[14px] border border-border bg-card p-5">
          {properties.length === 0 ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select onValueChange={(v) => setPropertyId(v)}>
              <SelectTrigger className="w-full" aria-label="Choose a property">
                <SelectValue placeholder="Choose a property…" />
              </SelectTrigger>
              <SelectContent>
                <PropertyOptions properties={properties} />
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    );
  }

  const dayLabel =
    journeyDay === -1 ? "Yesterday"
    : journeyDay === 0 ? "Today"
    : journeyDay === 1 ? "Tomorrow"
    : format(dayDate, "EEEE");

  return (
    <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
      {confetti}

      {/* ── next-order hero: a reminder + shortcut to the order day. Hidden once
          you're actually ON that day (orderDay) — the wizard there already
          carries the send action, so the banner would just waste space. Compact
          on mobile (description hidden, full-width button). ── */}
      {nextPending && canPlace && !orderDay && (
        <section className="rounded-[14px] bg-brand-gradient p-[2px]">
          <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-card px-4 py-3.5 sm:gap-[18px] sm:px-6 sm:py-5">
            <div className="min-w-0 flex-1 sm:min-w-[220px]">
              <div className="font-display text-[15px] font-bold tracking-[-0.012em] sm:text-lg">
                {nextDayLabel}'s order isn't in yet
              </div>
              <div className="mt-1 hidden text-[13px] text-muted-foreground sm:block">
                {!nextIsTomorrow && myNext && !missedTomorrow ? (
                  <>Tomorrow's cut-off has passed — next up is {format(parseISO(myNext.serviceDate), "EEEE, dd MMM")}. </>
                ) : null}
                Send it before <strong className="text-accent-strong">{myNext?.cutoffTime ?? "the cut-off"}</strong> so it reaches the kitchen in time.
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-lg font-semibold tabular-nums text-warning sm:text-[22px]">
                {untilLabel(myNext?.cutoffAt, now)}
              </div>
              <div className="text-[11px] text-muted-foreground">left</div>
            </div>
            <button
              type="button"
              onClick={() => setJourneyDay(nextOffset)}
              className="h-11 w-full rounded-[12px] bg-accent px-4 font-display text-sm font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105 sm:h-[52px] sm:w-auto sm:px-6 sm:text-base"
            >
              Send {nextIsTomorrow ? "tomorrow" : nextDayLabel}'s order →
            </button>
          </div>
        </section>
      )}
      {/* Placed-day status — hidden next to a missed-day incident so the
          incident stays the dominant message, and hidden when the journey is
          already showing that same day (the banner would just repeat it). */}
      {nextPlaced && !missedTomorrow && journeyDay !== nextOffset && (
        <section className="flex items-center gap-3.5 rounded-[14px] bg-success-soft px-[22px] py-4">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-success">
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          </span>
          <div className="flex-1">
            <div className="font-display font-bold tracking-[-0.012em] text-success">
              {nextDayLabel}'s order is in
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {myNext ? format(parseISO(myNext.serviceDate), "EEEE, dd MMM") : ""} ·{" "}
              {myNext?.activeGuests ?? "—"} people · {orderedMealTypes.size} meal{orderedMealTypes.size === 1 ? "" : "s"}
            </div>
          </div>
        </section>
      )}
      {nextPlaced && missedTomorrow && (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-4 py-2.5 text-[13px] text-muted-foreground">
          <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={3} />
          <span>
            <strong className="font-semibold text-foreground">
              {myNext ? format(parseISO(myNext.serviceDate), "EEEE, dd MMM") : nextDayLabel}
            </strong>{" "}
            is covered — {myNext?.activeGuests ?? "—"} people · {orderedMealTypes.size} meal{orderedMealTypes.size === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* ── food journey ── */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 font-display text-base font-bold tracking-[-0.012em]">Food journey</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setJourneyDay((d) => Math.max(-1, d - 1))}
              aria-label="Previous day"
              disabled={journeyDay <= -1}
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
              onClick={() => setJourneyDay((d) => Math.min(maxDay, d + 1))}
              aria-label="Next day"
              disabled={journeyDay >= maxDay}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-border bg-card text-foreground disabled:text-border"
            >
              <ChevronRight className="h-[15px] w-[15px]" />
            </button>
          </div>
        </div>

        {/* Missed day: cut-off passed with no order in — show the incident
            here (day-contextual), in place of the meal tabs + detail. */}
        {selectedDayMissed ? (
          <section className="flex flex-wrap items-center gap-3.5 rounded-2xl border border-destructive/30 bg-danger-soft px-[22px] py-5">
            <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-destructive">
              <AlertTriangle className="h-4 w-4 text-white" strokeWidth={2.5} />
            </span>
            <div className="min-w-[220px] flex-1">
              <div className="font-display font-bold tracking-[-0.012em] text-destructive">
                {dayLabel}'s order isn't in — the cut-off has passed
              </div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                Nothing was ordered for {missedDayStr} before the cut-off, and the app can't take it
                anymore. Contact your admin right away so the kitchen can still plan the meals.
              </div>
            </div>
            <a href={missedMailto} className="shrink-0">
              <span className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-[10px] bg-destructive px-5 text-sm font-bold text-white transition-[filter] hover:brightness-105">
                Contact admin
              </span>
            </a>
          </section>
        ) : (
        <>
        {/* meal tabs */}
        {!canReadOrders ? (
          /* FNB/executive roles hold FOOD_DASHBOARD but not FOOD_ALL_ORDERS —
             the order-level endpoints would 403, so say so instead of
             rendering confidently-empty meal slots. */
          <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
            Your role doesn't include order-level tracking, so the meal journey
            can't be shown here. Kitchen Summary and Dispatch have your live
            queues.
          </div>
        ) : ordersLoading ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] min-w-[150px] flex-1 rounded-[14px]" />
            ))}
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap gap-3">
            {slots.map((s) => {
              const st = s.mealType === selected?.mealType ? displayState : s.state;
              const tint = STATE_TINT[st];
              const isSel = s.mealType === selected?.mealType;
              // Prototype: while a meal is still being ordered its tab shows
              // just emoji + name + dot — no time or status pill.
              const showMeta = !(orderDay && isMissing(s.mealType));
              return (
                <button
                  key={s.mealType}
                  type="button"
                  onClick={() => setPickedMeal(s.mealType)}
                  className="flex min-w-[150px] flex-1 basis-[160px] flex-col items-start gap-[7px] rounded-[14px] px-4 py-3.5 text-left transition-shadow"
                  style={{
                    background: isSel ? `color-mix(in srgb, ${tint} 12%, var(--card))` : "var(--card)",
                    border: isSel ? `1.5px solid ${tint}` : "1px solid var(--border)",
                    boxShadow: isSel ? `0 6px 18px color-mix(in srgb, ${tint} 16%, transparent)` : "none",
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <MealIcon meal={s.mealType} size={26} />
                    <span className="flex-1 text-left font-display text-[15px] font-bold tracking-[-0.012em]">
                      {shortMeal(s.mealType)}
                    </span>
                    <span
                      className={cn("h-[9px] w-[9px] shrink-0 rounded-full", st.startsWith("action") && "animate-pulse-dot")}
                      style={{ background: tint }}
                    />
                  </span>
                  {showMeta && (
                    <>
                      <span className="font-mono text-xs text-muted-foreground">{s.time}</span>
                      <span
                        className="self-start rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                        style={{ background: `color-mix(in srgb, ${tint} 16%, var(--card))`, color: tint }}
                      >
                        {STATE_SHORT[st]}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* detail panel */}
        {canReadOrders && (
        <div className="rounded-2xl border border-border bg-card p-[18px]">
          {selected ? (
            <>
              {/* Meal head — label, time, status pill, and the order actions
                  (View order / Cancel) shown directly inline. */}
              <div className="mb-4 flex flex-wrap items-center gap-2.5">
                <span className="font-display text-[17px] font-bold tracking-[-0.012em]">
                  {MEAL_LABEL[selected.mealType]}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{selected.time}</span>
                <span className="flex-1" />
                <span
                  className="rounded-full px-[11px] py-1 text-xs font-bold"
                  style={{
                    background: `color-mix(in srgb, ${STATE_TINT[displayState]} 16%, var(--card))`,
                    color: STATE_TINT[displayState],
                  }}
                >
                  {orderMode
                    ? "Not ordered yet"
                    : selected.order == null
                      ? "Not ordered"
                      : displayState === "done" && wasteRecorded
                        ? "Received & confirmed · waste recorded ✓"
                        : selected.statusLine}
                </span>
                {!orderMode && selected.order != null && canReadOrders && (
                  <Link href={`/food/orders/${selected.order.id}`}>
                    <span className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
                      <Eye className="h-3.5 w-3.5" /> View order
                    </span>
                  </Link>
                )}
                {canCancelThis && (
                  <button
                    type="button"
                    onClick={() => setCancelOpen(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-danger-soft px-2.5 py-1 text-xs font-semibold text-destructive transition-colors hover:bg-destructive hover:text-white"
                  >
                    <Ban className="h-3.5 w-3.5" /> Cancel
                  </button>
                )}
              </div>

              {orderMode ? (
                <OrderModePanel
                  myNextCutoffAt={myNext?.cutoffAt ?? null}
                  myNextCutoffTime={myNext?.cutoffTime ?? null}
                  now={now}
                  dayWord={nextIsTomorrow ? "tomorrow" : `on ${nextDayLabel}`}
                  dayPossessive={nextIsTomorrow ? "tomorrow's" : `${nextDayLabel}'s`}
                  residents={residentsFor(selected.mealType)}
                  setResidents={(n) => setResidentsFor(selected.mealType, n)}
                  staff={staffFor(selected.mealType)}
                  setStaff={(n) => setStaffFor(selected.mealType, n)}
                  occupied={occupied}
                  residentsMax={residentsCap}
                  previewMeals={(preview?.meals ?? []).filter((m) =>
                    missingMeals.some((x) => x.mealType === m.mealType),
                  )}
                  selectedMeal={selected.mealType}
                  orderedMeals={missingMeals.map((m) => m.mealType)}
                  onSelectMeal={setPickedMeal}
                  dishQty={dishQty}
                  dishPersons={dishPersons}
                  setDishPersons={setDishPersonsOverride}
                  onSend={() => placeMutation.mutate()}
                  sending={placeMutation.isPending}
                  mealsCount={missingMeals.filter((m) => effHeadFor(m.mealType) > 0).length}
                  draftSavedAt={draftSavedAt}
                  savingDraft={savingDraft}
                />
              ) : selected.order == null ? (
                <div className="rounded-[12px] border border-dashed border-border px-4 py-9 text-center text-sm text-muted-foreground">
                  No {shortMeal(selected.mealType)} order for {dayLabel.toLowerCase()}.
                </div>
              ) : (
                <div className="grid items-stretch gap-3 md:grid-cols-3">
                  <TrackColumn detail={detail ?? null} order={selected.order} />
                  <ReceiveColumn
                    detail={detail ?? null}
                    state={displayState}
                    canConfirm={canConfirm}
                    ack={ack}
                    onAck={() => setAck(true)}
                    receivedOf={receivedOf}
                    sentOf={sentOf}
                    setReceived={setReceived}
                    mismatchCount={mismatches.length}
                    reason={reason}
                    setReason={setReason}
                    confirmDisabled={confirmDisabled}
                    onConfirm={() => confirmMutation.mutate()}
                    confirming={confirmMutation.isPending}
                    journeyDay={journeyDay}
                  />
                  <WasteColumn
                    detail={detail ?? null}
                    state={displayState}
                    canWaste={canWaste}
                    wasteRecorded={wasteRecorded}
                    now={now}
                    wasteQty={wasteQty}
                    setWasteQty={setWasteQty}
                    onSave={() => wasteMutation.mutate()}
                    saving={wasteMutation.isPending}
                  />
                </div>
              )}
            </>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </div>
        )}
        </>
        )}
      </section>

      {/* ── footer: quick links to full order history + reports ── */}
      <div className="flex flex-wrap justify-end gap-2">
        {canViewReports && (
          <Link href="/food/reports">
            <span className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
              <BarChart3 className="h-3.5 w-3.5" />
              Reports
              <ChevronRight className="h-[13px] w-[13px]" />
            </span>
          </Link>
        )}
        <Link href="/food/orders">
          <span className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground">
            <History className="h-3.5 w-3.5" />
            Previous orders
            <ChevronRight className="h-[13px] w-[13px]" />
          </span>
        </Link>
      </div>

      {/* ── inline cancel dialog (optional reason → audit trail) ── */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-warning" /> Cancel order
            </DialogTitle>
            <DialogDescription>
              This order will be cancelled and removed from the kitchen queue.
              Optionally share a reason for the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dash-cancel-reason">Reason (optional)</Label>
            <Textarea
              id="dash-cancel-reason"
              rows={3}
              placeholder="e.g. Residents away, duplicate order…"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={cancelMutation.isPending}>
              Keep order
            </Button>
            <Button variant="destructive" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
              {cancelMutation.isPending ? "Cancelling…" : "Cancel order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ───────────────────────── detail sub-panels ───────────────────────── */

function TrackColumn({ detail, order }: { detail: OrderDetail | null; order: FoodOrder }) {
  // Completed rungs from real events; future rungs from the canonical ladder.
  const events = detail?.events ?? [];
  const doneBy = new Map<OrderStatus, string>();
  events.forEach((e) => { doneBy.set(e.status, e.createdAt); });
  const cancelled = order.status === "CANCELLED" || order.status === "REJECTED";
  const rows = LADDER.map((step) => {
    const at = doneBy.get(step.status);
    return {
      label: step.label,
      done: !!at,
      time: at
        ? format(parseISO(at), "EEE, h:mm a")
        : step.status === "DELIVERED" && order.expectedDeliveryAt
          ? `Expected ${fmtTime(order.expectedDeliveryAt)}`
          : "—",
    };
  });
  return (
    <div className="rounded-[12px] border border-border bg-background px-4 py-3.5">
      <ColumnHead
        icon={<MapPin className="h-[13px] w-[13px]" strokeWidth={2.5} />}
        label="Track"
        tone="var(--info)"
        right={<span className="font-mono text-[11px] text-muted-foreground">{order.orderNumber}</span>}
      />
      {cancelled ? (
        <div className="px-1 py-4 text-[13px] text-muted-foreground">
          This order was {order.status.toLowerCase()}.
          {order.cancelReason ? ` Reason: ${order.cancelReason}` : ""}
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((r, i) => (
            <div key={r.label} className="flex gap-2.5">
              <div className="flex flex-col items-center">
                <CheckDot done={r.done} />
                {i < rows.length - 1 && <span className="w-[2px] flex-1 bg-border" style={{ minHeight: 10 }} />}
              </div>
              <div className="min-w-0 pb-[9px]">
                <span className={cn("block text-[13.5px]", r.done ? "font-semibold text-foreground" : "font-medium text-muted-foreground")}>
                  {r.label}
                </span>
                <span className="block font-mono text-[11px] text-muted-foreground">{r.time}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Additional Food — log a top-up sourced from another property after the order
 *  is received. Source-property dropdown + the meal's dishes on the place-order
 *  stepper. Purely a log (no order, no cap, no approval, no notification). */
function AdditionalFoodDialog({
  order, open, onOpenChange,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: properties } = useQuery({
    queryKey: ["food", "property-options"],
    queryFn: () => foodApi.propertyOptions(),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const [sourceId, setSourceId] = React.useState("");
  const [qtys, setQtys] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    if (open) { setSourceId(""); setQtys({}); }
  }, [open]);
  const total = Object.values(qtys).reduce((s, n) => s + (n || 0), 0);
  const mut = useMutation({
    mutationFn: () =>
      foodApi.addAdditionalFood(order.id, {
        sourcePropertyId: sourceId,
        items: order.items
          .filter((it) => (qtys[it.dishId] ?? 0) > 0)
          .map((it) => ({ dishId: it.dishId, qty: qtys[it.dishId]! })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["food", "order"] });
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      toast({ title: "Additional food logged", variant: "success" });
      onOpenChange(false);
    },
    onError: (e: any) => toast({ title: e?.message || "Couldn't log additional food", variant: "destructive" }),
  });
  // Food is sourced from ANOTHER property, so exclude this one.
  const sources = (properties ?? []).filter((p) => p.id !== order.propertyId);
  const canSubmit = !!sourceId && total > 0 && !mut.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Additional food</DialogTitle>
          <DialogDescription>
            Log top-up food arranged from another property for {MEAL_LABEL[order.mealType]}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Source property</label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger><SelectValue placeholder="Where did the food come from?" /></SelectTrigger>
              <SelectContent>
                {sources.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}{p.city ? ` · ${p.city}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
            {order.items.map((it) => {
              const q = qtys[it.dishId] ?? 0;
              return (
                <div key={it.id} className="flex items-center justify-between gap-2 rounded-[10px] border border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{it.dishName ?? "Item"}</div>
                    <div className="text-[11px] uppercase text-muted-foreground">{it.unit}</div>
                  </div>
                  <MiniStepper
                    value={q}
                    display={String(q)}
                    onMinus={() => setQtys((s) => ({ ...s, [it.dishId]: Math.max(0, q - 1) }))}
                    onPlus={() => setQtys((s) => ({ ...s, [it.dishId]: q + 1 }))}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mut.isPending}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={!canSubmit}>
            {mut.isPending ? "Logging…" : "Log additional food"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceiveColumn({
  detail, state, canConfirm, ack, onAck, receivedOf, sentOf, setReceived,
  mismatchCount, reason, setReason, confirmDisabled, onConfirm, confirming, journeyDay,
}: {
  detail: OrderDetail | null;
  state: MealState;
  canConfirm: boolean;
  ack: boolean;
  onAck: () => void;
  receivedOf: (i: OrderDetail["items"][number]) => number;
  sentOf: (i: OrderDetail["items"][number]) => number;
  setReceived: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  mismatchCount: number;
  reason: string | null;
  setReason: (r: string) => void;
  confirmDisabled: boolean;
  onConfirm: () => void;
  confirming: boolean;
  journeyDay: number;
}) {
  const delivered = detail?.status === "DELIVERED";
  const atGate = state === "action-confirm" && canConfirm;
  const REASONS = ["Spilled in transit", "Short from kitchen", "Counting mistake"];
  const [addlOpen, setAddlOpen] = React.useState(false);
  // Per-dish additional-food totals (top-ups sourced from other properties).
  const additionalByDish = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const req of detail?.additionalFood ?? [])
      for (const it of req.items) m.set(it.dishId, (m.get(it.dishId) ?? 0) + it.qty);
    return m;
  }, [detail?.additionalFood]);
  return (
    <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
      <ColumnHead
        icon={<Check className="h-[13px] w-[13px]" strokeWidth={2.5} />}
        label="Received"
        tone="var(--success)"
        right={delivered && canConfirm && detail ? (
          <button
            type="button"
            onClick={() => setAddlOpen(true)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
          >
            + Additional Food
          </button>
        ) : undefined}
      />
      {delivered || state === "done" || state === "action-waste" ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <CheckDot done />
            <span className="text-[13px] font-semibold text-success">Received & confirmed</span>
          </div>
          <div className="flex flex-col">
            {(detail?.items ?? []).map((i) => {
              const received = num(i.receivedQty ?? i.preparedQty ?? i.orderedQty);
              const addl = additionalByDish.get(i.dishId) ?? 0;
              return (
                <div key={i.id} className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
                  <span className="text-[13px]">{i.dishName ?? "Item"}</span>
                  <span className="font-mono text-[12.5px] font-semibold tabular-nums text-muted-foreground">
                    {fmtQty(received + addl, i.unit)}
                    {addl > 0 && (
                      <span className="ml-1 text-[10px] font-normal text-accent">(+{fmtQty(addl)} extra)</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {(detail?.additionalFood ?? []).length > 0 && (
            <div className="mt-2 space-y-1">
              {detail!.additionalFood!.map((req, idx) => (
                <div key={req.requestId} className="rounded-[9px] border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground">Additional #{idx + 1}</span>
                  {req.sourcePropertyName ? ` · from ${req.sourcePropertyName}` : ""}
                  {" — "}
                  {req.items.map((it) => `${it.dishName ?? "Item"} ${fmtQty(it.qty)}${it.unit}`).join(", ")}
                </div>
              ))}
            </div>
          )}
          {detail?.deliveryRemarks && (
            <div className="mt-2 text-xs text-muted-foreground">{detail.deliveryRemarks}</div>
          )}
          {detail && <AdditionalFoodDialog order={detail} open={addlOpen} onOpenChange={setAddlOpen} />}
        </>
      ) : atGate && !ack ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-2 py-[18px] text-center">
          <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-warning">
            <Truck className="h-4 w-4 text-white" strokeWidth={2.5} />
          </span>
          <span className="text-[13px] text-muted-foreground">
            {detail?.deliveryPartnerName ? `${detail.deliveryPartnerName} · ` : ""}
            arrived {fmtTime(detail?.dispatchedAt) || "just now"}
          </span>
          <button
            type="button"
            onClick={onAck}
            className="h-10 rounded-[9px] bg-warning px-4 text-[13px] font-bold text-white transition-[filter] hover:brightness-105"
          >
            I've received this order ✓
          </button>
        </div>
      ) : atGate && ack ? (
        <>
          <div className="flex flex-col">
            {(detail?.items ?? []).map((i) => {
              const sent = sentOf(i);
              const rec = receivedOf(i);
              const diff = rec !== sent;
              return (
                <div key={i.id} className={cn("flex items-center gap-2 border-b border-dashed border-border py-[7px] last:border-0", diff && "rounded bg-warning-soft px-1")}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{i.dishName ?? "Item"}</span>
                    <span className="block text-[11px] text-muted-foreground">sent {fmtQty(sent, i.unit)}</span>
                  </span>
                  <MiniStepper
                    value={rec}
                    display={String(rec)}
                    onMinus={() => setReceived((r) => ({ ...r, [i.id]: Math.max(0, rec - 1) }))}
                    onPlus={() => setReceived((r) => ({ ...r, [i.id]: Math.min(sent, rec + 1) }))}
                  />
                </div>
              );
            })}
          </div>
          {mismatchCount > 0 && (
            <div className="mt-2.5 rounded-[9px] bg-warning-soft px-3 py-2.5">
              <div className="mb-1.5 text-xs font-semibold">
                {mismatchCount} item{mismatchCount > 1 ? "s are" : " is"} less than what was sent
              </div>
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold",
                      reason === r ? "bg-warning text-white" : "border border-border bg-card text-foreground",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={confirmDisabled || confirming}
            onClick={onConfirm}
            className={cn(
              "mt-3 h-10 w-full rounded-[9px] text-[13px] font-bold transition-[filter]",
              confirmDisabled || confirming
                ? "cursor-not-allowed bg-muted text-muted-foreground"
                : "bg-success text-white hover:brightness-105",
            )}
          >
            {confirming
              ? "Saving…"
              : mismatchCount > 0
                ? reason ? "Save received — short noted" : "Pick a reason first"
                : "Save received ✓"}
          </button>
        </>
      ) : (
        <LockedPanel
          text={
            journeyDay === 1
              ? "Arrives tomorrow — confirm at the gate"
              : state === "action-confirm" && !canConfirm
                ? "Awaiting confirmation by the property team"
                : "Waiting for delivery"
          }
        />
      )}
    </div>
  );
}

function WasteColumn({
  detail, state, canWaste, wasteRecorded, now, wasteQty, setWasteQty, onSave, saving,
}: {
  detail: OrderDetail | null;
  state: MealState;
  canWaste: boolean;
  wasteRecorded: boolean;
  now: Date;
  wasteQty: Record<string, number>;
  setWasteQty: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onSave: () => void;
  saving: boolean;
}) {
  const active = state === "action-waste" && canWaste && !wasteRecorded;
  // Cool-down: wasteEditableUntil is when logging OPENS. While the meal is
  // still on, show only the countdown — no dish editors.
  const opensAt = detail?.wasteEditableUntil ? parseISO(detail.wasteEditableUntil) : null;
  const waiting =
    detail?.status === "DELIVERED" && !!opensAt && now.getTime() < opensAt.getTime() && !wasteRecorded;
  const minsToOpen = opensAt ? Math.max(1, differenceInMinutes(opensAt, now)) : 0;
  const wasteStep = (unit: string) => (isFractionalUnit(unit) ? 0.5 : 1);
  const capOf = (i: OrderDetail["items"][number]) => num(i.receivedQty ?? i.preparedQty ?? i.orderedQty);
  const summary = (detail?.items ?? []).filter((i) => num(i.wastedQty) > 0);
  return (
    <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
      <ColumnHead
        icon={<Trash2 className="h-[13px] w-[13px]" strokeWidth={2.5} />}
        label="Food waste"
        tone="var(--pop)"
        right={active ? (
          <span className="font-mono text-[11px] font-semibold text-pop">Open now</span>
        ) : undefined}
      />
      {wasteRecorded ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <CheckDot done />
            <span className="text-[13px] font-semibold text-success">Waste recorded</span>
          </div>
          {summary.length > 0 ? (
            <div className="flex flex-col">
              {summary.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
                  <span className="text-[13px]">{i.dishName ?? "Item"}</span>
                  <span className="font-mono text-[12.5px] font-semibold tabular-nums text-muted-foreground">
                    {fmtQty(num(i.wastedQty), i.unit)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              Zero waste recorded — brilliant!
              <PartyPopper className="h-3.5 w-3.5 text-success" />
            </div>
          )}
        </>
      ) : active ? (
        <>
          <div className="flex flex-col">
            {(detail?.items ?? []).map((i) => {
              const v = wasteQty[i.id] ?? 0;
              const step = wasteStep(i.unit);
              return (
                <div key={i.id} className="flex items-center gap-2 border-b border-dashed border-border py-[7px] last:border-0">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{i.dishName ?? "Item"}</span>
                  <MiniStepper
                    value={v}
                    display={fmtQty(v, i.unit)}
                    onMinus={() =>
                      setWasteQty((q) => ({ ...q, [i.id]: Math.max(0, Math.round((v - step) * 10) / 10) }))
                    }
                    onPlus={() =>
                      setWasteQty((q) => ({ ...q, [i.id]: Math.min(capOf(i), Math.round((v + step) * 10) / 10) }))
                    }
                  />
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="mt-3 h-10 w-full rounded-[9px] bg-success text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save waste ✓"}
          </button>
        </>
      ) : waiting ? (
        /* Cool-down running — prototype: lock, explainer, BIG centred timer.
           No dish editors until the meal is actually over. */
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 py-[18px] text-center">
          <Lock className="h-[26px] w-[26px] text-pop" />
          <span className="text-[13px] text-muted-foreground">
            Waste can be logged 1 hour after delivery
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-pop">
            {minsToOpen} min
          </span>
        </div>
      ) : state === "action-waste" && !canWaste ? (
        <LockedPanel text="Waste is recorded by the property team" />
      ) : (
        <LockedPanel text="Opens once the delivery is confirmed" />
      )}
    </div>
  );
}

/* ───────────────────────── order mode (tomorrow) ───────────────────────── */

function OrderModePanel({
  myNextCutoffAt, myNextCutoffTime, now, dayWord, dayPossessive, residents, setResidents, staff, setStaff, occupied, residentsMax, previewMeals,
  selectedMeal, orderedMeals, onSelectMeal, dishQty, dishPersons, setDishPersons, onSend, sending, mealsCount, draftSavedAt, savingDraft,
}: {
  myNextCutoffAt: string | null;
  myNextCutoffTime: string | null;
  now: Date;
  /** "tomorrow" or "on Wednesday" — for the headcount heading. */
  dayWord: string;
  /** "tomorrow's" or "Wednesday's" — for the send button. */
  dayPossessive: string;
  /** Residents eating the selected meal (0..residentsMax; 0 skips the meal). */
  residents: number;
  setResidents: (n: number) => void;
  /** Staff eating the selected meal (min 0). Same food as residents. */
  staff: number;
  setStaff: (n: number) => void;
  /** Occupied residents (current occupancy) — reference + cap basis. */
  occupied: number;
  /** Max residents allowed = 120% of occupancy (the 20% ordering cap). */
  residentsMax: number;
  previewMeals: Array<{
    mealType: MealType;
    label: string;
    items: Array<{ dishId: string; dishName: string; unit: string; qtyPerResident: number }>;
  }>;
  selectedMeal: MealType | null;
  /** The orderable meals in tab order — drives the "Next: {meal}" CTA. */
  orderedMeals: MealType[];
  onSelectMeal: (mealType: MealType) => void;
  dishQty: (mealType: MealType, dishId: string, perResident: number, unit: string) => number;
  dishPersons: (mealType: MealType, dishId: string) => number;
  setDishPersons: (mealType: MealType, dishId: string, persons: number) => void;
  onSend: () => void;
  sending: boolean;
  mealsCount: number;
  draftSavedAt: Date | null;
  savingDraft: boolean;
}) {
  // The dish grid shows the selected meal; the unit lead walks meal by meal via
  // the sticky "Next" CTA, and the last meal's CTA places every meal at once.
  const meal =
    previewMeals.find((m) => m.mealType === selectedMeal) ?? previewMeals[0] ?? null;
  // Wizard position within the orderable meals — the last meal sends the order.
  const mealIdx = selectedMeal ? orderedMeals.indexOf(selectedMeal) : -1;
  const isLastMeal = mealIdx === -1 || mealIdx >= orderedMeals.length - 1;
  const nextMeal = isLastMeal ? null : orderedMeals[mealIdx + 1] ?? null;
  return (
    // The dishes flow naturally — no fixed-height scroll box — so every dish is
    // visible as you scroll the page. Long menus aren't crammed into a small
    // internal scroll region; the CTA is a normal footer at the end of the list.
    <>
      <div className="mb-3.5 flex items-center gap-2.5 rounded-[10px] bg-warning-soft px-3.5 py-2.5 text-[13px]">
        <Clock className="h-[15px] w-[15px] shrink-0 text-warning" />
        <span>
          Order closes at <strong>{myNextCutoffTime ?? "the cut-off"}</strong> —{" "}
          <span className="font-mono font-semibold text-warning">{untilLabel(myNextCutoffAt, now)}</span> left
        </span>
      </div>

      <div className="mb-3.5 rounded-[10px] border border-border bg-background/60 px-3.5 py-3">
        <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="min-w-[160px] flex-1">
            <div className="font-display text-sm font-bold tracking-[-0.012em]">
              Who's eating {meal?.label ?? "this meal"} {dayWord}?
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Occupied: <span className="font-semibold text-foreground">{occupied}</span> residents · order up to{" "}
              <span className="font-semibold text-foreground">{residentsMax}</span> (120%). Set to 0 to skip this meal.
            </div>
          </div>
          {/* Total = residents + staff — the number the kitchen cooks for. */}
          {residents + staff === 0 ? (
            <div className="text-xs font-semibold text-warning">Won't be ordered</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Total{" "}
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {residents + staff}
              </span>{" "}
              ppl
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
          <div className="flex items-center gap-2.5">
            <span className="w-[64px] text-xs font-semibold text-muted-foreground">Residents</span>
            <button
              type="button"
              onClick={() => setResidents(Math.max(0, residents - 1))}
              aria-label="Fewer residents"
              className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted"
            >
              −
            </button>
            <span className="min-w-[40px] text-center font-mono text-base font-semibold tabular-nums">
              {residents}
            </span>
            <button
              type="button"
              onClick={() => setResidents(residents + 1)}
              disabled={residents >= residentsMax}
              aria-label="More residents"
              title={residents >= residentsMax ? `Limit reached — max ${residentsMax} (120% of ${occupied} occupied)` : undefined}
              className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="w-[64px] text-xs font-semibold text-muted-foreground">Staff</span>
            <button
              type="button"
              onClick={() => setStaff(Math.max(0, staff - 1))}
              aria-label="Fewer staff"
              className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted"
            >
              −
            </button>
            <span className="min-w-[40px] text-center font-mono text-base font-semibold tabular-nums">
              {staff}
            </span>
            <button
              type="button"
              onClick={() => setStaff(staff + 1)}
              aria-label="More staff"
              className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {meal == null ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {meal.items.map((d) => {
            const qty = dishQty(meal.mealType, d.dishId, d.qtyPerResident, d.unit);
            const ppl = dishPersons(meal.mealType, d.dishId);
            return (
              <div
                key={d.dishId}
                className="flex items-center gap-2.5 rounded-[12px] border border-border bg-background px-3 py-2.5"
              >
                <DishIcon name={d.dishName} meal={meal.mealType} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{d.dishName}</span>
                  {/* Quantity is derived (portion × people) and shown read-only. */}
                  <span className="block text-[11px] text-muted-foreground">
                    <span className="font-mono font-semibold tabular-nums text-foreground">{qty}</span>{" "}
                    {d.unit.toLowerCase()}
                  </span>
                </span>
                {/* The +/- sets how many PEOPLE eat this dish — the quantity
                    recomputes live; the quantity itself is never edited. */}
                <MiniStepper
                  value={ppl}
                  display={`${ppl} ppl`}
                  onMinus={() => setDishPersons(meal.mealType, d.dishId, ppl - 1)}
                  onPlus={() => setDishPersons(meal.mealType, d.dishId, ppl + 1)}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Footer action bar at the end of the dish list: the unit lead reviews
         each meal, then "Next" walks to the following meal; on the last meal the
         CTA places every meal at once. */}
      <div className="-mx-[18px] mt-3.5 border-t border-border bg-card px-[18px] pb-[2px] pt-2.5">
        {/* Always-on reassurance that edits persist — autosaves silently. */}
        <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          {savingDraft ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </>
          ) : draftSavedAt ? (
            <>
              <Check className="h-3 w-3 text-success" strokeWidth={3} />
              Changes saved · {format(draftSavedAt, "h:mm a")}
            </>
          ) : (
            <>
              <Check className="h-3 w-3" strokeWidth={3} /> Changes are saved automatically as you edit
            </>
          )}
        </div>
        {isLastMeal ? (
          <button
            type="button"
            disabled={sending || previewMeals.length === 0 || mealsCount === 0}
            onClick={onSend}
            className="h-[52px] w-full rounded-[12px] bg-success font-display text-[15px] font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105 disabled:opacity-60"
          >
            {sending
              ? "Sending…"
              : mealsCount === 0
                ? "Set at least one meal to order"
                : `Place ${dayPossessive} order — all ${mealsCount} meal${mealsCount === 1 ? "" : "s"} ✓`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => nextMeal && onSelectMeal(nextMeal)}
            className="flex h-[52px] w-full items-center justify-center gap-1.5 rounded-[12px] bg-accent font-display text-[15px] font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105"
          >
            Next: {nextMeal ? shortMeal(nextMeal) : ""}
            <ChevronRight className="h-[18px] w-[18px]" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </>
  );
}
