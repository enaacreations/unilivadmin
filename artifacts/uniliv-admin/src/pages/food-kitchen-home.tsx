import * as React from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, addDays, parseISO } from "date-fns";
import {
  ChevronLeft, ChevronRight, Check, AlertCircle, Truck, Soup, Inbox,
  History,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useConfetti } from "@/components/ui/confetti";
import { MealIcon, DishIcon } from "@/components/meal-icon";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import {
  foodApi, foodKeys, orderPeople, MEAL_TYPES, MEAL_LABEL, ORDER_STATUS_PILL, shortMeal, fmtQty, isFractionalUnit,
  type FoodOrder, type MealType, type KitchenSummaryDish, type KitchenItem,
} from "@/lib/food-api";

/** Kitchen serve-by targets per meal (prototype schedule — not in the API).
 *  Kept in sync with food-kitchen-summary.tsx. */
const SERVE_BY: Record<MealType, string> = {
  BREAKFAST: "7:00 AM", LUNCH: "12:00 PM", SNACKS: "4:00 PM", DINNER: "7:30 PM",
};

/** The kitchen's journey state for one meal — drives tab tint + pill, in the
 *  same visual grammar as the unit lead's Food Overview meal states. */
type KState = "accept" | "dispatch" | "transit" | "quiet";

const STATE_TINT: Record<KState, string> = {
  accept: "var(--warning)",   // orders waiting to be accepted — act now
  dispatch: "var(--info)",    // accepted — dispatch when ready
  transit: "var(--success)",  // everything's on the road
  quiet: "var(--muted)",
};

const stateShort = (s: KState, n: number): string =>
  s === "accept" ? `${n} to accept`
  : s === "dispatch" ? "Ready to send"
  : s === "transit" ? "On the road"
  : "No orders";

type Slot = {
  mealType: MealType;
  placed: FoodOrder[];
  accepted: FoodOrder[];
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

/** One property · headcount row inside a pipeline column. Clicking the property
 *  name opens the order-details sheet. */
function OrderRow({ o, onOpen }: { o: FoodOrder; onOpen: (o: FoodOrder) => void }) {
  return (
    <div className="flex w-full items-center gap-2 border-b border-dashed border-border py-1.5 last:border-0">
      <button
        type="button"
        onClick={() => onOpen(o)}
        className="group flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        <span className="min-w-0 truncate text-[13px] transition-colors group-hover:text-accent-strong">
          {o.propertyName ?? "Property"}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
      <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
        {orderPeople(o)} ppl
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

/**
 * One Dispatch-board row: property + per-property partner picker, expandable
 * into an inline dish-quantity editor (the old "Quantities" modal, now inside
 * the row's accordion). Dispatched orders stay on the board as a read-only
 * "done" row showing partner · batch · time.
 */
function DispatchRow({
  o, done, doneText, canDispatch, busy, isPicked, onToggle, partners, partnerId, onPartner, onSaved,
}: {
  o: FoodOrder;
  done: boolean;
  doneText: string;
  canDispatch: boolean;
  busy: string | null;
  isPicked: boolean;
  onToggle: () => void;
  partners: { id: string; name: string }[];
  partnerId: string;
  onPartner: (id: string) => void;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const { data: items, isLoading } = useQuery({
    queryKey: ["food", "kitchen-items", o.id],
    queryFn: () => foodApi.kitchenItems(o.id),
    enabled: open,
    staleTime: 60_000,
  });
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (items) {
      setDraft(Object.fromEntries(items.map((it) => [it.id, String(it.preparedQty ?? it.orderedQty ?? 0)])));
      setReason("");
    }
  }, [items]);
  const [saving, setSaving] = React.useState(false);
  const noPartner = !done && partners.length === 0;
  const dirty = !!items && items.some((it) => draft[it.id] != null && Number(draft[it.id]) !== (it.preparedQty ?? it.orderedQty ?? 0));

  const save = async () => {
    if (!items || saving) return;
    if (Object.values(draft).some((v) => !Number.isFinite(Number(v)) || Number(v) < 0)) {
      toast({ title: "Quantities must be zero or more", variant: "destructive" }); return;
    }
    const changed = items
      .filter((it) => draft[it.id] != null && Number(draft[it.id]) !== (it.preparedQty ?? it.orderedQty ?? 0))
      .map((it) => ({ id: it.id, preparedQty: Number(draft[it.id]) }));
    if (!changed.length) return;
    if (!reason.trim()) { toast({ title: "Add a reason for the quantity change", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await foodApi.updateKitchenItems(o.id, changed, reason.trim());
      toast({ title: "Quantities updated", variant: "success" });
      setReason("");
      await onSaved();
    } catch (e: any) {
      toast({ title: e?.message || "Could not save quantities", variant: "destructive" });
    }
    setSaving(false);
  };

  return (
    <div
      className={cn(
        "rounded-[10px] border transition-colors",
        done ? "border-success/40 bg-success-soft/40" : isPicked ? "border-accent bg-accent/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* select / done */}
        {done ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white">
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
        ) : canDispatch ? (
          <button
            type="button"
            onClick={onToggle}
            disabled={noPartner}
            aria-label={isPicked ? `Unselect ${o.propertyName}` : `Select ${o.propertyName}`}
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors",
              isPicked ? "border-accent bg-accent text-white" : "border-border bg-background",
              noPartner && "cursor-not-allowed opacity-40",
            )}
          >
            {isPicked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </button>
        ) : null}

        {/* property — click to expand the dishes */}
        <button type="button" onClick={() => setOpen((v) => !v)} className="group min-w-0 flex-1 text-left">
          <span className="block truncate text-[15px] font-bold tracking-[-0.006em]">{o.propertyName ?? "Property"}</span>
          <span className="block truncate font-mono text-[12px] tabular-nums text-muted-foreground">
            {o.orderNumber} · {orderPeople(o)} people
          </span>
        </button>

        {/* right side: done summary, partner picker, or no-partner warning */}
        {done ? (
          <span className="shrink-0 text-right text-[13px] font-semibold text-success">{doneText}</span>
        ) : canDispatch ? (
          noPartner ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1.5 text-[11px] font-semibold text-warning">
              <AlertCircle className="h-3.5 w-3.5" /> No partner
            </span>
          ) : (
            <Select value={partnerId} onValueChange={onPartner}>
              <SelectTrigger className="h-8 w-auto min-w-[128px] gap-1.5 rounded-full border-border bg-card px-3 text-[12px] font-semibold">
                <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {partners.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
              </SelectContent>
            </Select>
          )
        ) : null}

        {/* accordion toggle — last thing on the row, after the partner select */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse dishes" : "Show dishes"}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
        </button>
      </div>

      {/* accordion content: the order's dishes (editable while ready, read-only once sent) */}
      {open && (
        <div className="border-t border-border/70 px-3 py-2.5">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !items?.length ? (
            <div className="py-2 text-center text-[12px] text-muted-foreground">No dish breakdown on this order.</div>
          ) : (
            <>
              {items.map((it) => {
                const changed = draft[it.id] != null && Number(draft[it.id]) !== (it.orderedQty ?? 0);
                return (
                  <div key={it.id} className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <DishIcon name={it.dishName ?? ""} meal={o.mealType} size={26} />
                      <span className="min-w-0 truncate text-[13px]">{it.dishName ?? "Item"}</span>
                    </span>
                    {done ? (
                      <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums">
                        {fmtQty(it.preparedQty ?? it.orderedQty ?? 0)}{" "}
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">{it.unit}</span>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {changed && it.orderedQty != null && (
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground line-through">{fmtQty(it.orderedQty)}</span>
                        )}
                        <Input
                          type="number"
                          min={0}
                          step={isFractionalUnit(it.unit) ? 0.5 : 1}
                          value={draft[it.id] ?? ""}
                          onChange={(e) => setDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                          className="h-8 w-20 text-right font-mono text-[12.5px] tabular-nums"
                        />
                        <span className="w-9 text-[10px] font-bold uppercase tracking-[.06em] text-muted-foreground">{it.unit}</span>
                      </span>
                    )}
                  </div>
                );
              })}
              {!done && canDispatch && (
                <div className="mt-2 space-y-2">
                  {/* Any send-quantity change needs a mandatory reason (logged). */}
                  {dirty && (
                    <Input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for the quantity change (required)"
                      className="h-8 w-full text-[12.5px]"
                    />
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={save}
                      disabled={saving || !dirty || !reason.trim() || !!busy}
                      className="h-8 rounded-full bg-accent px-4 text-[12px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save quantities"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
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
  // F&B managers run entirely from Kitchen Home — the standalone Kitchen
  // Summary / Dispatch pages are hidden from their nav, so don't link out to
  // them here either. Other kitchen roles still get the shortcuts.
  const showSideSurfaces = role !== "FNB_MANAGER";

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
  const ordersParams = { serviceDate: date, status: "PLACED,ACCEPTED,DISPATCHED", limit: 100 };
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

  // "Your kitchen" identity chip — F&B manager logins are one-per-kitchen, so
  // the header names the kitchen this login runs. Heads/admins see all.
  const myKitchenIds = lookups?.myKitchenIds;
  const kitchenScopeLabel =
    myKitchenIds === null ? "All kitchens"
    : myKitchenIds && myKitchenIds.length === 1 ? kitchens.find((k) => k.id === myKitchenIds[0])?.name ?? "Your kitchen"
    : myKitchenIds && myKitchenIds.length > 1 ? `${myKitchenIds.length} kitchens`
    : null;

  // ── Per-meal slots ────────────────────────────────────────────────────────
  const slots: Slot[] = MEAL_TYPES.map((mealType) => {
    const live = orders.filter((o) => o.mealType === mealType);
    const placed = live.filter((o) => o.status === "PLACED");
    const accepted = live.filter((o) => o.status === "ACCEPTED");
    const dispatched = live.filter((o) => o.status === "DISPATCHED");
    const dishes = summary?.meals.find((m) => m.mealType === mealType)?.dishes ?? [];
    const people = live.reduce((s, o) => s + orderPeople(o), 0);
    const state: KState =
      placed.length ? "accept"
      : accepted.length ? "dispatch"
      : dispatched.length ? "transit"
      : "quiet";
    return { mealType, placed, accepted, dispatched, live, dishes, people, state };
  });

  // Auto-focus the meal that needs a hand; a manual pick always wins.
  const selected: Slot =
    (pickedMeal && slots.find((s) => s.mealType === pickedMeal)) ||
    slots.find((s) => s.state === "accept") ||
    slots.find((s) => s.state === "dispatch") ||
    slots.find((s) => s.live.length > 0 || s.dishes.length > 0) ||
    slots[0];

  // Pin the auto-pick once data lands so nothing swaps the panel under the
  // user — not a background refetch, and not their own action either (after
  // accepting a meal they stay on it to cook and send it; user decision
  // 17-Jul). Only an explicit tab tap or a day flip moves the focus.
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
    // re-click window on stale data). The focus stays on the acted-on meal —
    // the user carries it through cook and send before moving on.
    await invalidate();
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

  // ── Order-details sheet ───────────────────────────────────────────────────
  // Clicking a property NAME opens a right-side sheet with that order's dish
  // breakdown, so the kitchen sees exactly what was asked before acting.
  const [sheetOrder, setSheetOrder] = React.useState<FoodOrder | null>(null);
  // "Full summary" opens the selected meal's complete cook plan (every dish with
  // its per-property split) inline in a sheet, instead of routing to the
  // standalone Kitchen Summary page.
  const [summaryOpen, setSummaryOpen] = React.useState(false);
  React.useEffect(() => { setSummaryOpen(false); }, [selected?.mealType, day]);
  const { data: sheetItems, isLoading: sheetLoading } = useQuery({
    queryKey: ["food", "kitchen-items", sheetOrder?.id],
    queryFn: () => foodApi.kitchenItems(sheetOrder!.id),
    enabled: !!sheetOrder,
    staleTime: 60_000,
  });

  // ── Dispatch board ────────────────────────────────────────────────────────
  // One row per ready (ACCEPTED) order: pick its delivery partner, tick the
  // ones going out, and dispatch them together. Orders are grouped into trips
  // by (kitchen, partner) — for a single-kitchen manager that's just "one trip
  // per partner", so a mixed selection can go out across several partners at once.
  const partnersFor = (o: FoodOrder) =>
    o.kitchenId ? agencies.filter((a) => (a.kitchenIds ?? []).includes(o.kitchenId!)) : agencies;
  const defaultPartnerId = (o: FoodOrder) => partnersFor(o)[0]?.id ?? "";
  const [rowPartner, setRowPartner] = React.useState<Record<string, string>>({});
  const partnerIdOf = (o: FoodOrder) => rowPartner[o.id] ?? defaultPartnerId(o);
  const partnerNameOf = (o: FoodOrder) => agencies.find((a) => a.id === partnerIdOf(o))?.name ?? "";
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Keep the selection valid as the queue changes (dispatched orders drop out).
  React.useEffect(() => {
    const live = new Set(orders.filter((o) => o.status === "ACCEPTED").map((o) => o.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  const dispatchable = selected?.accepted ?? [];
  const pickedOrders = dispatchable.filter((o) => picked.has(o.id) && !!partnerIdOf(o));
  const pickedPeople = pickedOrders.reduce((n, o) => n + orderPeople(o), 0);
  const pickedPartnerCount = new Set(pickedOrders.map((o) => partnerIdOf(o))).size;
  const dispatchedTotal = (selected?.dispatched.length ?? 0);
  const boardTotal = dispatchable.length + dispatchedTotal;

  const selectAllReady = () => {
    const loadable = dispatchable.filter((o) => !!partnerIdOf(o));
    const allOn = loadable.length > 0 && loadable.every((o) => picked.has(o.id));
    setPicked(allOn ? new Set() : new Set(loadable.map((o) => o.id)));
  };

  const dispatchSelected = async () => {
    if (busy || pickedOrders.length === 0) return;
    // Group into trips by (kitchen, partner) — the server allows one kitchen +
    // one agency per trip and validates the agency serves that kitchen.
    const groups = new Map<string, { agencyId: string; kitchenId: string | null; ids: string[] }>();
    for (const o of pickedOrders) {
      const agencyId = partnerIdOf(o);
      const key = `${o.kitchenId ?? "none"}::${agencyId}`;
      const g = groups.get(key) ?? { agencyId, kitchenId: o.kitchenId ?? null, ids: [] };
      g.ids.push(o.id);
      groups.set(key, g);
    }
    setBusy("dispatch");
    let ok = 0, fail = 0;
    for (const g of groups.values()) {
      try {
        await foodApi.createDispatch({ orderIds: g.ids, agencyId: g.agencyId, kitchenId: g.kitchenId ?? undefined });
        ok += g.ids.length;
      } catch { fail += g.ids.length; }
    }
    setPicked(new Set());
    await invalidate();
    setBusy(null);
    if (fail === 0) {
      fire();
      toast({ title: "Dispatched", description: `${ok} order${ok === 1 ? "" : "s"} sent across ${groups.size} trip${groups.size === 1 ? "" : "s"}.`, variant: "success" });
    } else {
      toast({ title: `${ok} dispatched, ${fail} failed`, variant: fail > ok ? "destructive" : "warning" });
    }
  };

  // Dispatched rows stay on the board as a "done" row showing partner · batch ·
  // time. A "batch" is one trip (createDispatch call); orders sharing a
  // dispatchId went out together, numbered 1..N by dispatch time within the meal.
  const dispatchedForMeal = selected?.dispatched ?? [];
  const batchNumOf = React.useMemo(() => {
    const trips = [...new Set(dispatchedForMeal.filter((o) => o.dispatchId).map((o) => o.dispatchId as string))]
      .map((id) => ({
        id,
        t: Math.min(...dispatchedForMeal.filter((o) => o.dispatchId === id).map((o) => (o.dispatchedAt ? Date.parse(o.dispatchedAt) : 0))),
      }))
      .sort((a, b) => a.t - b.t);
    return new Map(trips.map((x, i) => [x.id, i + 1] as const));
  }, [dispatchedForMeal]);
  const doneLabel = (o: FoodOrder) => {
    const partner = o.deliveryPartnerName ?? agencies.find((a) => a.id === o.deliveryPartnerId)?.name ?? "Dispatched";
    const batch = o.dispatchId ? batchNumOf.get(o.dispatchId) : undefined;
    const time = o.dispatchedAt ? format(parseISO(o.dispatchedAt), "h:mm a").toLowerCase() : "";
    return [partner, batch ? `batch ${batch}` : null, time || null].filter(Boolean).join(" · ");
  };

  const loading = ordersLoading || summaryLoading;
  const tint = STATE_TINT[selected?.state ?? "quiet"];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
      {confetti}

      {/* Header — the title IS the kitchen this login runs (user decision:
          no persona/kitchen badges; the page is simply "your kitchen"). */}
      <div>
        <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">
          {kitchenScopeLabel ?? "Kitchen Home"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Your kitchen day — accept orders and send the vans from one place.
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
              {format(dayDate, "EEEE, dd MMM")} · {totalPeople} people · send the vans below.
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
              const actionable = s.state === "accept" || s.state === "dispatch";
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
              <button
                type="button"
                onClick={() => setSummaryOpen(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
              >
                <Soup className="h-3.5 w-3.5" /> Full summary
              </button>
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
                <div className="-mr-1 max-h-[320px] overflow-y-auto pr-1">
                  {/* Same dish-card language as the unit lead's Food Overview:
                      glass DishIcon + name + per-property meta + mono quantity. */}
                  <div className="grid gap-2.5 py-0.5 sm:grid-cols-2">
                    {selected.dishes.map((d) => (
                      <div
                        key={`${d.dishId}|${d.unit}`}
                        className="flex items-center gap-2.5 rounded-[12px] border border-border bg-card px-3 py-2.5"
                      >
                        <DishIcon name={d.dishName} meal={selected.mealType} size={40} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{d.dishName}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {d.byProperty.length > 1
                              ? `across ${d.byProperty.length} properties`
                              : d.byProperty[0]?.propertyName ?? "—"}
                          </div>
                        </div>
                        <span className="shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums">
                          {fmtQty(d.displayQty)}{" "}
                          <span className="text-[10.5px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* New orders (left) + dispatch board (right): shown side-by-side
                50/50 when there are orders to accept; when nothing's waiting the
                New orders card is hidden and the dispatch board takes the full
                width. Stacks vertically on smaller screens. */}
            <div className={cn("grid items-stretch gap-3", selected.placed.length > 0 && "lg:grid-cols-2")}>
              {/* Accept — only rendered when orders are actually waiting */}
              {selected.placed.length > 0 && (
                <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
                  <ColumnHead
                    icon={<Inbox className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                    label="New orders"
                    tone="var(--warning)"
                    right={
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selected.placed.length}</span>
                    }
                  />
                  <div className="flex-1">
                    {selected.placed.map((o) => (
                      <OrderRow key={o.id} o={o} onOpen={setSheetOrder} />
                    ))}
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
                </div>
              )}

              {/* Dispatch board — pick a partner per property, then dispatch one,
                  a few, or all together. */}
              <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-success">Dispatch board</span>
                  {dispatchable.length > 0 && (
                    <span className="text-[12px] text-muted-foreground">
                      pick a partner per property, then send them out
                    </span>
                  )}
                </div>
                {boardTotal > 0 && (
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {dispatchedTotal} of {boardTotal} dispatched
                  </span>
                )}
              </div>

              {dispatchable.length === 0 && dispatchedForMeal.length === 0 ? (
                <ColumnEmpty text="Accepted orders appear here, ready to send out." />
              ) : (
                <>
                  {canDispatch && dispatchable.length > 0 && (
                    <div className="mb-2 flex justify-end">
                      <button
                        type="button"
                        onClick={selectAllReady}
                        className="text-[12px] font-semibold text-muted-foreground transition-colors hover:text-accent"
                      >
                        {dispatchable.every((o) => picked.has(o.id)) ? "Clear selection" : "Select all"}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    {/* ready orders first (actionable), then the dispatched ones (done) */}
                    {dispatchable.map((o) => (
                      <DispatchRow
                        key={o.id}
                        o={o}
                        done={false}
                        doneText=""
                        canDispatch={canDispatch}
                        busy={busy}
                        isPicked={picked.has(o.id)}
                        onToggle={() => toggleRow(o.id)}
                        partners={partnersFor(o)}
                        partnerId={partnerIdOf(o)}
                        onPartner={(v) => setRowPartner((p) => ({ ...p, [o.id]: v }))}
                        onSaved={invalidate}
                      />
                    ))}
                    {dispatchedForMeal.map((o) => (
                      <DispatchRow
                        key={o.id}
                        o={o}
                        done
                        doneText={doneLabel(o)}
                        canDispatch={canDispatch}
                        busy={busy}
                        isPicked={false}
                        onToggle={() => {}}
                        partners={[]}
                        partnerId=""
                        onPartner={() => {}}
                        onSaved={invalidate}
                      />
                    ))}
                  </div>

                  {/* Sticky dispatch bar — appears once something is selected */}
                  {canDispatch && pickedOrders.length > 0 && (
                    <div className="sticky bottom-3 z-10 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-4 py-3 shadow-lg">
                      <span className="text-[13px] font-semibold">
                        {pickedOrders.length} selected · {pickedPeople} people
                      </span>
                      <button
                        type="button"
                        onClick={dispatchSelected}
                        disabled={!!busy}
                        className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-success px-5 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === "dispatch"
                          ? "Dispatching…"
                          : `Dispatch ${pickedOrders.length} order${pickedOrders.length === 1 ? "" : "s"} · ${pickedPartnerCount} partner${pickedPartnerCount === 1 ? "" : "s"}`}
                        <span aria-hidden>→</span>
                      </button>
                    </div>
                  )}
                </>
              )}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* Quick links — only for roles that keep the standalone pages */}
      {showSideSurfaces && (
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
      )}

      {/* Order-details sheet — what this property ordered */}
      <Sheet open={!!sheetOrder} onOpenChange={(o) => { if (!o) setSheetOrder(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {sheetOrder && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.012em]">
                  <MealIcon meal={sheetOrder.mealType} size={26} />
                  {sheetOrder.propertyName ?? "Property"}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-xs tabular-nums">{sheetOrder.orderNumber}</span>
                  <span>· {MEAL_LABEL[sheetOrder.mealType]}</span>
                  <span>· {orderPeople(sheetOrder)} people</span>
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-3">
                {ORDER_STATUS_PILL[sheetOrder.status] && (
                  <span
                    className={cn(
                      "self-start rounded-full px-[11px] py-1 text-xs font-bold",
                      ORDER_STATUS_PILL[sheetOrder.status].cls,
                    )}
                  >
                    {ORDER_STATUS_PILL[sheetOrder.status].label}
                  </span>
                )}

                <div className="rounded-[12px] border border-border bg-background px-4 py-3.5">
                  <ColumnHead
                    icon={<Soup className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                    label="What they ordered"
                    tone="var(--accent-strong)"
                    right={sheetItems?.length ? (
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {sheetItems.length} dish{sheetItems.length === 1 ? "" : "es"}
                      </span>
                    ) : undefined}
                  />
                  {sheetLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : !sheetItems?.length ? (
                    <div className="py-3 text-center text-[13px] text-muted-foreground">
                      No dish breakdown on this order.
                    </div>
                  ) : (
                    sheetItems.map((it) => {
                      const sent = it.preparedQty ?? it.orderedQty ?? 0;
                      const adjusted = it.preparedQty != null && it.orderedQty != null && it.preparedQty !== it.orderedQty;
                      return (
                        <div
                          key={it.id}
                          className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <DishIcon name={it.dishName ?? ""} meal={sheetOrder.mealType} size={28} />
                            <span className="min-w-0 truncate text-[13px]">{it.dishName ?? "Item"}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12.5px] font-semibold tabular-nums">
                            {adjusted && (
                              <span className="text-[11px] text-muted-foreground line-through">
                                {fmtQty(it.orderedQty!)}
                              </span>
                            )}
                            {fmtQty(sent)}{" "}
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">{it.unit}</span>
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>

                {sheetOrder.notes && (
                  <div className="rounded-[12px] border border-border bg-background px-4 py-3">
                    <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                      Note from the property
                    </div>
                    <p className="text-[13px]">{sheetOrder.notes}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Full summary sheet — the meal's complete cook plan with per-property splits */}
      <Sheet open={summaryOpen} onOpenChange={setSummaryOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.012em]">
                  <MealIcon meal={selected.mealType} size={26} />
                  {MEAL_LABEL[selected.mealType]} · cook plan
                </SheetTitle>
                <SheetDescription>
                  {[
                    kitchenScopeLabel,
                    `${selected.people} people`,
                    (() => {
                      const props = new Set(selected.dishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId)));
                      return props.size > 0 ? `${props.size} propert${props.size === 1 ? "y" : "ies"}` : null;
                    })(),
                  ].filter(Boolean).join(" · ")}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-3">
                {selected.dishes.length === 0 ? (
                  <div className="rounded-[12px] border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
                    No cook plan for {shortMeal(selected.mealType).toLowerCase()} {dayLabel.toLowerCase()} — it fills in as orders land.
                  </div>
                ) : (
                  selected.dishes.map((d) => (
                    <div key={`${d.dishId}|${d.unit}`} className="rounded-[12px] border border-border bg-background px-4 py-3">
                      {/* dish head: icon + name + total */}
                      <div className="mb-2 flex items-center gap-2.5">
                        <DishIcon name={d.dishName} meal={selected.mealType} size={34} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-bold tracking-[-0.006em]">{d.dishName}</div>
                          {d.component && (
                            <div className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">
                              {d.component.replace(/_/g, " ")}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-right font-mono text-[14px] font-bold tabular-nums">
                          {fmtQty(d.displayQty)}{" "}
                          <span className="text-[10.5px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                        </span>
                      </div>
                      {/* per-property split */}
                      {d.byProperty.map((bp) => (
                        <div
                          key={bp.propertyId}
                          className="flex items-center justify-between gap-2 border-t border-dashed border-border py-1.5"
                        >
                          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{bp.propertyName}</span>
                          <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums">
                            {fmtQty(bp.qty)}{" "}
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
