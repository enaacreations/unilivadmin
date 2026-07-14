import * as React from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, differenceInMinutes, format, parseISO, subDays } from "date-fns";
import {
  AlertTriangle, Ban, BarChart3, Check, ChevronLeft, ChevronRight, Clock, Flame, History, Loader2, Lock, MapPin, PartyPopper, Pencil, Truck, Trash2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
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
type DishOverride = { qty?: number; persons?: number };

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

/** Journey state of one meal — drives the tab tint + which panel is live.
 *  done=success, action=needs the user now, cooking=info, waiting=muted. */
type MealState = "done" | "action-confirm" | "action-waste" | "cooking" | "waiting" | "cancelled" | "none";

const STATE_TINT: Record<MealState, string> = {
  done: "var(--success)",
  "action-confirm": "var(--warning)",
  "action-waste": "var(--pop)",
  cooking: "var(--info)",
  waiting: "var(--muted)",
  cancelled: "var(--muted)",
  none: "var(--muted)",
};

const STATE_SHORT: Record<MealState, string> = {
  done: "Done",
  "action-confirm": "At gate",
  "action-waste": "Log waste",
  cooking: "Cooking",
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
          ? `Delivered & confirmed — waste logging opens in ${wasteWaitMins}m`
          : "Delivered & confirmed",
    };
  }
  if (s === "DISPATCHED") {
    return {
      mealType, order, state: "action-confirm",
      time: fmtTime(order.dispatchedAt) || "now",
      statusLine: "At your gate — count it in",
    };
  }
  if (s === "PREPARING") {
    return {
      mealType, order, state: "cooking",
      time: order.expectedDeliveryAt ? `by ${fmtTime(order.expectedDeliveryAt)}` : "—",
      statusLine: kitchenName ? `Cooking at ${kitchenName}` : "Cooking at the kitchen",
    };
  }
  // PLACED / ACCEPTED
  return {
    mealType, order, state: "waiting",
    time: order.expectedDeliveryAt ? `by ${fmtTime(order.expectedDeliveryAt)}` : "—",
    statusLine: s === "ACCEPTED" ? "Order in — accepted by the kitchen" : "Order in — waiting for the kitchen",
  };
}

/** Canonical tracking ladder; events fill in the completed rungs. */
const LADDER: { status: OrderStatus; label: string }[] = [
  { status: "PLACED", label: "Order placed" },
  { status: "ACCEPTED", label: "Accepted by kitchen" },
  { status: "PREPARING", label: "Preparing" },
  { status: "DISPATCHED", label: "Dispatched" },
  { status: "DELIVERED", label: "Delivered & confirmed" },
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

  /* ── streak: consecutive days (ending today) with ≥1 live order ── */
  // `to` is exclusive-ish on the server (serviceDate is a timestamp), so bound
  // by tomorrow to make sure ALL of today's orders are included. The API
  // clamps page size to 100, so page through the window (4 meals/day × 35
  // days can exceed one page) and ask only for live statuses so cancelled
  // churn doesn't eat the row budget.
  const streakFrom = format(subDays(now, 35), "yyyy-MM-dd");
  const streakTo = format(addDays(now, 1), "yyyy-MM-dd");
  const { data: streakOrders } = useQuery({
    queryKey: foodKeys.orders({ propertyId, streak: streakFrom }),
    queryFn: async () => {
      const params = {
        propertyId: propertyId ?? undefined,
        from: streakFrom,
        to: streakTo,
        status: "PLACED,ACCEPTED,PREPARING,DISPATCHED,DELIVERED",
        limit: 100,
      };
      const first = await foodApi.listOrders({ ...params, page: 1 });
      const rows = [...first.data];
      const totalPages = Math.min(first.meta?.totalPages ?? 1, 3);
      for (let p = 2; p <= totalPages; p++) {
        rows.push(...(await foodApi.listOrders({ ...params, page: p })).data);
      }
      return rows;
    },
    enabled: !!propertyId && canReadOrders,
    staleTime: 300_000,
  });
  const streakDays = React.useMemo(() => {
    if (!streakOrders?.length) return 0;
    const days = new Set(
      streakOrders
        // Normalise to the LOCAL calendar day (serviceDate is a timestamp).
        .map((o) => format(parseISO(o.serviceDate), "yyyy-MM-dd")),
    );
    let n = 0;
    let cursor = now;
    while (n < 60 && days.has(format(cursor, "yyyy-MM-dd"))) {
      n++;
      cursor = subDays(cursor, 1);
    }
    return n;
  }, [streakOrders, now]);

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
    (selected.order.status === "PLACED" || selected.order.status === "ACCEPTED" || selected.order.status === "PREPARING");
  const [headcount, setHeadcount] = React.useState<number | null>(null);
  const effectiveHead = headcount ?? myNext?.activeGuests ?? overview?.activeGuests ?? 1;
  const { data: preview } = useQuery({
    queryKey: foodKeys.orderPreview({ propertyId, serviceDate: myNext?.serviceDate, persons: 1 }),
    queryFn: () =>
      foodApi.orderPreview({ propertyId: propertyId!, serviceDate: myNext!.serviceDate, persons: 1 }),
    enabled: orderDay && !!propertyId && !!myNext,
  });
  // Per-dish overrides, keyed `${mealType}:${dishId}`. `persons` pins a
  // per-dish headcount (qty recomputes from it); `qty` pins an absolute
  // quantity (wins over everything) — same model as the full builder.
  const [dishOverrides, setDishOverrides] = React.useState<Record<string, DishOverride>>({});
  // Order-mode edits belong to ONE property — dishIds are a shared catalogue,
  // so carrying overrides (or a manual headcount) across a property switch
  // would place the next property's order with the previous one's numbers.
  React.useEffect(() => {
    setHeadcount(null);
    setDishOverrides({});
  }, [propertyId]);
  const dishStep = (unit: string) => (isFractionalUnit(unit) ? 0.5 : 5);
  const dishKey = (mealType: MealType, dishId: string) => `${mealType}:${dishId}`;
  const dishPersons = (mealType: MealType, dishId: string): number =>
    dishOverrides[dishKey(mealType, dishId)]?.persons ?? effectiveHead;
  const dishQty = (mealType: MealType, dishId: string, perResident: number, unit: string): number => {
    const o = dishOverrides[dishKey(mealType, dishId)];
    if (o?.qty != null) return o.qty;
    const raw = perResident * (o?.persons ?? effectiveHead);
    return isFractionalUnit(unit) ? Math.round(raw * 10) / 10 : Math.round(raw);
  };
  const bumpDish = (mealType: MealType, dishId: string, perResident: number, unit: string, dir: 1 | -1) => {
    const cur = dishQty(mealType, dishId, perResident, unit);
    const next = Math.max(0, Math.round((cur + dir * dishStep(unit)) * 10) / 10);
    setDishOverrides((q) => ({
      ...q,
      [dishKey(mealType, dishId)]: { ...q[dishKey(mealType, dishId)], qty: next },
    }));
  };
  const setDishPersonsOverride = (mealType: MealType, dishId: string, persons: number) => {
    // Pinning persons clears any absolute qty so the quantity recomputes.
    setDishOverrides((q) => ({
      ...q,
      [dishKey(mealType, dishId)]: { persons: Math.max(1, persons), qty: undefined },
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
      | { v: number; headcount: number | null; overrides: Record<string, DishOverride> }
      | null
      | undefined;
    if (p && p.v === 1) {
      if (p.headcount != null) setHeadcount(p.headcount);
      if (p.overrides && typeof p.overrides === "object") setDishOverrides(p.overrides);
    }
  }, [serverDraft, draftId]);
  // Debounced autosave of every edit (headcount / per-dish overrides).
  const draftDirty = headcount != null || Object.keys(dishOverrides).length > 0;
  const [draftSavedAt, setDraftSavedAt] = React.useState<Date | null>(null);
  const [savingDraft, setSavingDraft] = React.useState(false);
  React.useEffect(() => {
    if (!draftParams || !nextPending || !canPlace || !draftDirty) return;
    if (restoredFor.current !== draftId) return; // wait for the restore pass
    const t = setTimeout(() => {
      setSavingDraft(true);
      foodApi
        .saveOrderDraft({ ...draftParams, payload: { v: 1, headcount, overrides: dishOverrides } })
        .then(() => setDraftSavedAt(new Date()))
        .catch(() => {/* draft persistence is best-effort */})
        .finally(() => setSavingDraft(false));
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headcount, dishOverrides, draftId, nextPending, canPlace, draftDirty]);

  const placeMutation = useMutation({
    mutationFn: () => {
      const missing = new Set(missingMeals.map((m) => m.mealType));
      const meals = (preview?.meals ?? [])
        .filter((m) => missing.has(m.mealType))
        .map((m) => ({
          mealType: m.mealType,
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
        persons: effectiveHead,
        meals,
      });
    },
    onSuccess: (res) => {
      // The draft served its purpose — clear it (server + local, best-effort).
      if (draftParams) void foodApi.deleteOrderDraft(draftParams).catch(() => {});
      setDishOverrides({});
      setHeadcount(null);
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
        description: `Group ${res.batch.batchNumber} · ${res.orders.length} meal${res.orders.length === 1 ? "" : "s"}`,
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
                {properties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
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

      {/* ── tomorrow's order hero ── */}
      {nextPending && canPlace && (
        <section className="rounded-[14px] bg-brand-gradient p-[2px]">
          <div className="flex flex-wrap items-center gap-[18px] rounded-[12px] bg-card px-6 py-5">
            <div className="min-w-[220px] flex-1">
              <div className="font-display text-lg font-bold tracking-[-0.012em]">
                {nextDayLabel}'s order isn't in yet
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {!nextIsTomorrow && myNext && !missedTomorrow ? (
                  <>Tomorrow's cut-off has passed — next up is {format(parseISO(myNext.serviceDate), "EEEE, dd MMM")}. </>
                ) : null}
                Send it before {myNext?.cutoffTime ?? "the cut-off"} to keep your{" "}
                <strong className="text-accent-strong">{streakDays}-day streak</strong> alive{" "}
                <Flame className="inline h-[15px] w-[15px] align-text-bottom text-warning" />
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[22px] font-semibold tabular-nums text-warning">
                {untilLabel(myNext?.cutoffAt, now)}
              </div>
              <div className="text-[11px] text-muted-foreground">left</div>
            </div>
            <button
              type="button"
              onClick={() => setJourneyDay(nextOffset)}
              className="h-[52px] rounded-[12px] bg-accent px-6 font-display text-base font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105"
            >
              Send {nextIsTomorrow ? "tomorrow" : nextDayLabel}'s order →
            </button>
          </div>
        </section>
      )}
      {/* Placed-day status. Next to a missed-day incident it compresses to a
          quiet one-liner — celebrating a streak that the miss is about to
          break would be wrong, and the incident must stay dominant. */}
      {nextPlaced && !missedTomorrow && (
        <section className="flex items-center gap-3.5 rounded-[14px] bg-success-soft px-[22px] py-4">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-success">
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          </span>
          <div className="flex-1">
            <div className="font-display font-bold tracking-[-0.012em] text-success">
              {nextDayLabel}'s order is in — streak safe at {streakDays + 1} days{" "}
              <Flame className="inline h-[15px] w-[15px] align-text-bottom text-warning" />
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
              {/* Meal head — shown in every mode (prototype: "Lunch by 2:00 PM · Not ordered yet") */}
              <div className="mb-4 flex flex-wrap items-center gap-2.5">
                <span className="font-display text-[17px] font-bold tracking-[-0.012em]">
                  {MEAL_LABEL[selected.mealType]}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{selected.time}</span>
                {detail?.batchNumber && (
                  <span
                    className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    title="Group order ID — every meal placed together shares it"
                  >
                    {detail.batchNumber}
                  </span>
                )}
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
                        ? "Delivered & confirmed · waste recorded ✓"
                        : selected.statusLine}
                </span>
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
                  headcount={effectiveHead}
                  setHeadcount={setHeadcount}
                  previewMeals={(preview?.meals ?? []).filter((m) =>
                    missingMeals.some((x) => x.mealType === m.mealType),
                  )}
                  selectedMeal={selected.mealType}
                  dishQty={dishQty}
                  dishPersons={dishPersons}
                  setDishPersons={setDishPersonsOverride}
                  bumpDish={bumpDish}
                  onSend={() => placeMutation.mutate()}
                  sending={placeMutation.isPending}
                  mealsCount={missingMeals.length}
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
  return (
    <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
      <ColumnHead
        icon={<Check className="h-[13px] w-[13px]" strokeWidth={2.5} />}
        label="Received"
        tone="var(--success)"
      />
      {delivered || state === "done" || state === "action-waste" ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <CheckDot done />
            <span className="text-[13px] font-semibold text-success">Delivered & confirmed</span>
          </div>
          <div className="flex flex-col">
            {(detail?.items ?? []).map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
                <span className="text-[13px]">{i.dishName ?? "Item"}</span>
                <span className="font-mono text-[12.5px] font-semibold tabular-nums text-muted-foreground">
                  {fmtQty(num(i.receivedQty ?? i.preparedQty ?? i.orderedQty), i.unit)}
                </span>
              </div>
            ))}
          </div>
          {detail?.deliveryRemarks && (
            <div className="mt-2 text-xs text-muted-foreground">{detail.deliveryRemarks}</div>
          )}
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
            state === "cooking"
              ? "Cooking now — confirm once it arrives at your gate"
              : journeyDay === 1
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
  myNextCutoffAt, myNextCutoffTime, now, dayWord, dayPossessive, headcount, setHeadcount, previewMeals,
  selectedMeal, dishQty, dishPersons, setDishPersons, bumpDish, onSend, sending, mealsCount, draftSavedAt, savingDraft,
}: {
  myNextCutoffAt: string | null;
  myNextCutoffTime: string | null;
  now: Date;
  /** "tomorrow" or "on Wednesday" — for the headcount heading. */
  dayWord: string;
  /** "tomorrow's" or "Wednesday's" — for the send button. */
  dayPossessive: string;
  headcount: number;
  setHeadcount: (updater: number | null) => void;
  previewMeals: Array<{
    mealType: MealType;
    label: string;
    items: Array<{ dishId: string; dishName: string; unit: string; qtyPerResident: number }>;
  }>;
  selectedMeal: MealType | null;
  dishQty: (mealType: MealType, dishId: string, perResident: number, unit: string) => number;
  dishPersons: (mealType: MealType, dishId: string) => number;
  setDishPersons: (mealType: MealType, dishId: string, persons: number) => void;
  bumpDish: (mealType: MealType, dishId: string, perResident: number, unit: string, dir: 1 | -1) => void;
  onSend: () => void;
  sending: boolean;
  mealsCount: number;
  draftSavedAt: Date | null;
  savingDraft: boolean;
}) {
  // The dish grid shows the selected meal (tabs above switch meals); the send
  // button submits every missing meal at once — exactly like the prototype.
  const meal =
    previewMeals.find((m) => m.mealType === selectedMeal) ?? previewMeals[0] ?? null;
  // One dish editable at a time (pencil → persons/qty steppers → check).
  const [editing, setEditing] = React.useState<string | null>(null);
  return (
    <>
      <div className="mb-3.5 flex items-center gap-2.5 rounded-[10px] bg-warning-soft px-3.5 py-2.5 text-[13px]">
        <Clock className="h-[15px] w-[15px] shrink-0 text-warning" />
        <span>
          Order closes at <strong>{myNextCutoffTime ?? "the cut-off"}</strong> —{" "}
          <span className="font-mono font-semibold text-warning">{untilLabel(myNextCutoffAt, now)}</span> left
        </span>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-3.5">
        <div className="min-w-[160px] flex-1">
          <div className="font-display text-sm font-bold tracking-[-0.012em]">Who's eating {dayWord}?</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Dishes below adjust automatically. Switch tabs above to edit each meal.
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setHeadcount(Math.max(1, headcount - 1))}
            aria-label="Fewer people"
            className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted"
          >
            −
          </button>
          <span className="min-w-[64px] text-center font-mono text-base font-semibold tabular-nums">
            {headcount} ppl
          </span>
          <button
            type="button"
            onClick={() => setHeadcount(headcount + 1)}
            aria-label="More people"
            className="h-[38px] w-[38px] rounded-[10px] border border-border bg-background text-lg text-foreground hover:bg-muted"
          >
            +
          </button>
        </div>
      </div>

      {meal == null ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        /* Bounded scroll keeps long menus manageable — the send button and
           headcount stay in view no matter how many dishes a meal has. */
        <div className="-mr-1 max-h-[420px] overflow-y-auto pr-1">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {meal.items.map((d) => {
              const key = `${meal.mealType}:${d.dishId}`;
              const qty = dishQty(meal.mealType, d.dishId, d.qtyPerResident, d.unit);
              const ppl = dishPersons(meal.mealType, d.dishId);
              const isEditing = editing === key;
              return (
                <div
                  key={d.dishId}
                  className={cn(
                    "rounded-[12px] border bg-background px-3 py-2.5",
                    isEditing ? "border-accent/50" : "border-border",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <DishIcon name={d.dishName} meal={meal.mealType} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold">{d.dishName}</span>
                      <span className="block text-[11px] text-muted-foreground">{d.unit.toLowerCase()}</span>
                    </span>
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        aria-label="Done editing"
                        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-border bg-card text-accent hover:bg-muted"
                      >
                        <Check className="h-4 w-4" strokeWidth={3} />
                      </button>
                    ) : (
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-right">
                          <span className="font-mono text-[13.5px] font-semibold tabular-nums">{qty}</span>{" "}
                          <span className="text-[11px] text-muted-foreground">
                            {d.unit.toLowerCase()} · {ppl} ppl
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditing(key)}
                          aria-label={`Edit ${d.dishName}`}
                          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  {isEditing && (
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-dashed border-border pt-2">
                      <span className="text-[11px] text-muted-foreground">persons</span>
                      <MiniStepper
                        value={ppl}
                        display={String(ppl)}
                        onMinus={() => setDishPersons(meal.mealType, d.dishId, ppl - 1)}
                        onPlus={() => setDishPersons(meal.mealType, d.dishId, ppl + 1)}
                      />
                      <span className="text-[11px] text-muted-foreground">qty</span>
                      <MiniStepper
                        value={qty}
                        display={String(qty)}
                        onMinus={() => bumpDish(meal.mealType, d.dishId, d.qtyPerResident, d.unit, -1)}
                        onPlus={() => bumpDish(meal.mealType, d.dishId, d.qtyPerResident, d.unit, 1)}
                      />
                      <span className="text-[11px] text-muted-foreground">{d.unit.toLowerCase()}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Always-on reassurance that edits persist — autosaves silently, so the
         tester (and users) can see the draft is being kept. */}
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
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
      <button
        type="button"
        disabled={sending || previewMeals.length === 0}
        onClick={onSend}
        className="mt-3.5 h-[52px] w-full rounded-[12px] bg-success font-display text-[15px] font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105 disabled:opacity-60"
      >
        {sending ? "Sending…" : `Send ${dayPossessive} order — all ${mealsCount} meal${mealsCount === 1 ? "" : "s"} ✓`}
      </button>
    </>
  );
}
