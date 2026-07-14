import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronLeft, Check, X, Loader2, ExternalLink, PackageSearch } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys, MEAL_LABEL, ORDER_STATUS_PILL, shortMeal, fmtQty, groupLabel,
  type OrderStatus, type FoodOrderEvent,
} from "@/lib/food-api";
import { useQueryParam } from "@/lib/nav-helpers";
import { cn } from "@/lib/utils";

const fmtDateTime = (s?: string | null) => (s ? format(new Date(s), "dd MMM, HH:mm") : "—");
const fmtDate = (s?: string | null) => (s ? format(new Date(s), "EEE, dd MMM yyyy") : "—");

export default function FoodTrack() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();

  // Pre-fill from ?order=<orderNumber> or ?id=<uuid>.
  const paramOrder = useQueryParam("order");
  const paramId = useQueryParam("id");
  const initial = paramOrder ?? paramId ?? "";

  const [input, setInput] = React.useState(initial);
  // The submitted term that actually drives the lookup (so typing doesn't refetch).
  const [term, setTerm] = React.useState(initial.trim());
  // Arm-twice cancel: first tap arms, second tap confirms.
  const [cancelArm, setCancelArm] = React.useState(false);

  // Keep the query in sync when the URL param changes (success-page links).
  React.useEffect(() => {
    const next = (paramOrder ?? paramId ?? "").trim();
    if (next) { setInput(next); setTerm(next); setCancelArm(false); }
  }, [paramOrder, paramId]);

  const { data: order, isLoading, isError, error, isFetching } = useQuery({
    queryKey: foodKeys.trackOrder(term),
    queryFn: () => foodApi.trackOrder(term),
    enabled: !!term,
    retry: false,
  });

  // The user's ACTIVE orders, offered as a quick-pick instead of typing an id.
  // ACCEPTED is a live pre-dispatch stage (kitchen has taken the order), so it
  // belongs here too. Only 8 pills render — no need for a bigger page.
  const { data: activeOrders = [] } = useQuery({
    queryKey: foodKeys.orders({ status: "PLACED,ACCEPTED,PREPARING,DISPATCHED", limit: 8, scope: "track-active" }),
    queryFn: () =>
      foodApi.listOrders({ status: "PLACED,ACCEPTED,PREPARING,DISPATCHED", limit: 8 }).then((r) => r.data),
    staleTime: 60_000,
  });

  // Run the tracking lookup for a given order number (shared by the form + pills).
  const runLookup = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setInput(t);
    setTerm(t);
    setCancelArm(false);
    // Reflect the lookup in the URL so it can be shared / refreshed.
    navigate(`/food/track?order=${encodeURIComponent(t)}`, { replace: true });
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    runLookup(input);
  };

  const cancelMut = useMutation({
    mutationFn: (id: string) => foodApi.cancelOrder(id),
    onSuccess: () => {
      // Same broad invalidation the order-detail page uses — refreshes the
      // tracked order, order lists and dashboard counters.
      qc.invalidateQueries({ queryKey: ["food"] });
      setCancelArm(false);
      toast({ title: "Order cancelled — the kitchen has been told", variant: "warning" });
    },
    onError: (e: any) => {
      setCancelArm(false);
      toast({ title: e?.message || "Failed to cancel", variant: "destructive" });
    },
  });

  // Mirrors food-order-detail.tsx: cancellable while pre-dispatch, by order
  // placers or kitchen staff.
  const isPreDispatch =
    order?.status === "PLACED" || order?.status === "ACCEPTED" || order?.status === "PREPARING";
  const canCancel =
    !!order && isPreDispatch &&
    (can("FOOD_PLACE_ORDER", "edit") || can("FOOD_KITCHEN_SUMMARY", "edit"));

  const pill = order ? ORDER_STATUS_PILL[order.status] : null;

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-[18px] animate-fade-up">
      <Link
        href="/food/orders"
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-[15px] w-[15px]" /> All orders
      </Link>

      <div>
        <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Track an order</h1>
        <p className="mt-1 text-sm text-muted-foreground">Type an order number, or tap one of today's orders.</p>
      </div>

      {/* Lookup card */}
      <div className="rounded-[14px] border border-border bg-card p-[18px]">
        <form onSubmit={submit} className="flex gap-2.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. ORD-2026-000123"
            aria-label="Order number"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 rounded-[10px] border border-border bg-background px-3.5 font-mono text-[15px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-accent"
          />
          <button
            type="submit"
            disabled={!input.trim() || isFetching}
            className="inline-flex h-12 items-center gap-2 rounded-[10px] bg-accent px-[22px] text-[15px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
            Track
          </button>
        </form>

        {activeOrders.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {activeOrders.slice(0, 8).map((o) => {
              const active = term === o.orderNumber;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => runLookup(o.orderNumber)}
                  className={cn(
                    "h-10 rounded-full border px-3.5 font-mono text-[13px] font-semibold transition-colors",
                    active
                      ? "border-transparent bg-accent text-white"
                      : "border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {o.orderNumber} · {shortMeal(o.mealType)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!term ? (
        <div className="rounded-[14px] border border-dashed border-border px-6 py-9 text-center text-muted-foreground">
          <PackageSearch className="mx-auto mb-2 h-6 w-6" />
          <p className="mb-1 text-sm font-semibold text-foreground">Track any order</p>
          <p className="text-[13px]">Paste an order number above to see its current status and timeline.</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3 rounded-[14px] border border-border bg-card p-5">
          <Skeleton className="h-6 w-2/3 rounded-md" />
          <Skeleton className="h-4 w-1/3 rounded-md" />
          <Skeleton className="h-44 w-full rounded-[12px]" />
        </div>
      ) : isError || !order ? (
        <div className="rounded-[14px] border border-dashed border-border px-6 py-9 text-center text-muted-foreground">
          <p className="mb-1 text-sm font-semibold text-foreground">No order with that number</p>
          <p className="text-[13px]">
            {(error as any)?.message || "Check the number and try again — no match in your accessible properties."}
          </p>
        </div>
      ) : (
        <>
          {/* Status + timeline card */}
          <div className="rounded-[14px] border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-sm font-semibold tabular-nums">{order.orderNumber}</span>
              {order.batchNumber && (
                <span
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  title="Group order ID — every meal placed together shares it"
                >
                  {groupLabel(order.batchNumber)}
                </span>
              )}
              <span className="flex-1 font-display text-base font-bold tracking-[-0.012em]">
                {MEAL_LABEL[order.mealType] ?? order.mealType}
              </span>
              {pill && (
                <span className={cn("rounded-full px-[9px] py-[3px] text-[11px] font-bold", pill.cls)}>
                  {pill.label}
                </span>
              )}
            </div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              {order.propertyName ?? "—"} · {order.residentsCount} people · {fmtDate(order.serviceDate)}
            </div>

            <TrackTimeline status={order.status} events={order.events ?? []} />
          </div>

          {/* Delivery card */}
          {order.dispatch && order.status !== "CANCELLED" && (
            <div className="grid grid-cols-3 gap-3 rounded-[14px] border border-border bg-card px-5 py-4">
              <div>
                <div className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">Vehicle</div>
                <div className="mt-[3px] truncate font-mono text-sm font-semibold tabular-nums">
                  {order.dispatch.vehicleNumber ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">Driver</div>
                <div className="mt-[3px] truncate text-sm font-semibold">
                  {order.dispatch.driverName
                    ? `${order.dispatch.driverName}${order.dispatch.driverPhone ? ` · ${order.dispatch.driverPhone}` : ""}`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">Arrival</div>
                <div className="mt-[3px] truncate font-mono text-sm font-semibold tabular-nums">
                  {order.deliveredAt
                    ? `Arrived ${format(new Date(order.deliveredAt), "HH:mm")}`
                    : fmtDateTime(order.dispatch.estimatedArrivalAt)}
                </div>
              </div>
            </div>
          )}

          {/* Items card */}
          <div className="overflow-hidden rounded-[14px] border border-border bg-card">
            <div className="border-b border-border px-5 py-3 font-display text-[13px] font-bold tracking-[-0.012em]">
              What's in this order
            </div>
            {(order.items ?? []).map((it) => (
              <div
                key={it.id}
                className="flex items-center justify-between gap-2.5 border-b border-dashed border-border px-5 py-2.5 last:border-b-0"
              >
                <span className="truncate text-sm">{it.dishName ?? it.dishId}</span>
                <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">
                  {fmtQty(it.orderedQty, it.unit)}
                </span>
              </div>
            ))}
            {(order.items ?? []).length === 0 && (
              <div className="px-5 py-4 text-sm text-muted-foreground">No items on this order.</div>
            )}
          </div>

          {/* Cancel — arm twice to confirm */}
          {canCancel && (
            <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-dashed border-border bg-background px-4 py-3">
              <span className="flex-1 text-[13px] text-muted-foreground">
                Plans changed? You can cancel until the kitchen dispatches it.
              </span>
              <button
                type="button"
                disabled={cancelMut.isPending}
                onClick={() => {
                  if (!cancelArm) { setCancelArm(true); return; }
                  cancelMut.mutate(order.id);
                }}
                className={cn(
                  "h-12 rounded-[10px] px-5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  cancelArm
                    ? "border border-transparent bg-destructive text-white"
                    : "border border-border bg-card text-destructive hover:bg-muted",
                )}
              >
                {cancelMut.isPending
                  ? "Cancelling…"
                  : cancelArm
                    ? "Tap again to confirm cancel"
                    : "Cancel this order"}
              </button>
            </div>
          )}

          <Link
            href={`/food/orders/${order.id}`}
            className="inline-flex items-center gap-1.5 self-end text-[13px] font-semibold text-accent-strong hover:underline"
          >
            Full order detail <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </>
      )}
    </div>
  );
}

// ─── Vertical journey timeline ───────────────────────────────────────────────
// Always renders the full canonical path (Placed → Accepted → Preparing →
// Dispatched → Delivered) so an order shows where it IS and what's ahead;
// terminal states (Cancelled / Rejected) end the path with a red node.
const HAPPY_PATH: { key: OrderStatus; label: string }[] = [
  { key: "PLACED", label: "Order placed" },
  { key: "ACCEPTED", label: "Accepted by kitchen" },
  { key: "PREPARING", label: "Preparing" },
  { key: "DISPATCHED", label: "Dispatched" },
  { key: "DELIVERED", label: "Delivered" },
];

type StepState = "done" | "pending" | "terminal";
type Step = { key: string; label: string; time: string | null; state: StepState; note?: string | null };

function TrackTimeline({ status, events }: { status: OrderStatus; events: FoodOrderEvent[] }) {
  // Earliest event per status = the moment the order entered that stage.
  const eventByStatus = React.useMemo(() => {
    const sorted = [...events].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const m = new Map<string, FoodOrderEvent>();
    for (const e of sorted) if (!m.has(e.status)) m.set(e.status, e);
    return m;
  }, [events]);

  const isTerminal = status === "CANCELLED" || status === "REJECTED";
  const happyIdx = HAPPY_PATH.findIndex((s) => s.key === status);
  const reachedIdx = isTerminal
    ? HAPPY_PATH.reduce((max, s, i) => (eventByStatus.has(s.key) ? i : max), 0)
    : Math.max(0, happyIdx);

  const steps: Step[] = [];
  if (isTerminal) {
    for (let i = 0; i <= reachedIdx; i++) {
      const st = HAPPY_PATH[i]!;
      steps.push({
        key: st.key, label: st.label, state: "done",
        time: fmtDateTime(eventByStatus.get(st.key)?.createdAt),
      });
    }
    const te = eventByStatus.get(status);
    steps.push({
      key: status,
      label: status === "CANCELLED" ? "Cancelled" : "Rejected",
      state: "terminal",
      time: fmtDateTime(te?.createdAt),
      note: te?.note,
    });
  } else {
    HAPPY_PATH.forEach((st, i) => {
      const done = i <= reachedIdx;
      steps.push({
        key: st.key, label: st.label, state: done ? "done" : "pending",
        time: done ? fmtDateTime(eventByStatus.get(st.key)?.createdAt) : null,
      });
    });
  }

  return (
    <div className="mt-[18px] flex flex-col">
      {steps.map((st, i) => (
        <div key={st.key} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                "flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full",
                st.state === "done" && "bg-success text-white",
                st.state === "terminal" && "bg-destructive text-white",
                st.state === "pending" && "border-2 border-border bg-muted",
              )}
            >
              {st.state === "done" && <Check className="h-[13px] w-[13px]" strokeWidth={3} />}
              {st.state === "terminal" && <X className="h-[13px] w-[13px]" strokeWidth={3} />}
            </span>
            {i < steps.length - 1 && <span className="min-h-[22px] w-[2px] flex-1 bg-border" />}
          </div>
          <div className="pb-4">
            <span
              className={cn(
                "block text-sm",
                st.state === "pending" ? "font-medium text-muted-foreground" : "font-semibold text-foreground",
              )}
            >
              {st.label}
            </span>
            <span className="mt-px block font-mono text-xs tabular-nums text-muted-foreground">
              {st.time ?? "Pending"}
            </span>
            {st.note && <span className="mt-0.5 block text-xs text-muted-foreground">{st.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
