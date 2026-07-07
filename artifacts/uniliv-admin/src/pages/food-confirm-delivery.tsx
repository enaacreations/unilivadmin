import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  CheckCircle2, PackageCheck, Users, Clock,
  ClipboardCheck, CircleDot, Loader2, AlertTriangle,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useScopedColumns } from "@/lib/use-scoped-columns";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, fmtQty,
  type FoodOrder, type FoodOrderItem, type FoodOrderEvent,
} from "@/lib/food-api";

// ─── helpers ──────────────────────────────────────────────────────────────────
function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "—" : format(dt, "dd MMM, HH:mm");
}

// Weight units that auto-convert (mirrors NumberStepper's conversion rule exactly).
const WEIGHT_UNITS = new Set(["kg", "gram", "g"]);
const isKg = (u: string) => u === "kg";
const isGram = (u: string) => u === "gram" || u === "g";

/** Convert `n` from `from`→`to`. kg↔gram/g scales ×/÷1000; otherwise unchanged. */
function convertQty(n: number, from: string, to: string): number {
  if (from === to) return n;
  if (!WEIGHT_UNITS.has(from) || !WEIGHT_UNITS.has(to)) return n;
  if (isKg(from) && isGram(to)) return n * 1000;
  if (isGram(from) && isKg(to)) return n / 1000;
  return n; // gram<->g, same magnitude
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Build the per-item unit options: canonical base unit + kg/gram (de-duped). */
function unitOptionsFor(baseUnit: string): string[] {
  const opts = [baseUnit, "kg", "gram"];
  return opts.filter((u, i) => opts.indexOf(u) === i);
}

export default function FoodConfirmDelivery() {
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [brand, setBrand] = React.useState("ALL");
  const [mealType, setMealType] = React.useState("ALL");
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const partners = lookups?.deliveryPartners ?? [];
  const propName = (id?: string | null) =>
    id ? properties.find((p) => p.id === id)?.name ?? "—" : "—";
  const partnerName = (id?: string | null) =>
    id ? partners.find((p) => p.id === id)?.name ?? "—" : "—";

  const params: Record<string, unknown> = { status: "DISPATCHED", limit: 100 };
  if (propertyId !== "ALL") params.propertyId = propertyId;
  if (brand !== "ALL") params.brand = brand;
  if (mealType !== "ALL") params.mealType = mealType;

  const { data: res, isLoading } = useQuery({
    queryKey: foodKeys.orders(params),
    queryFn: () => foodApi.listOrders(params),
  });
  const orders = res?.data ?? [];

  const cols = [
    {
      accessorKey: "orderNumber",
      header: "Order",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="font-mono text-xs font-medium text-primary">{row.original.orderNumber}</span>
      ),
    },
    {
      accessorKey: "propertyName",
      header: "Property",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="font-medium">{row.original.propertyName ?? propName(row.original.propertyId)}</span>
      ),
    },
    {
      accessorKey: "mealType",
      header: "Meal",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
          {MEAL_LABEL[row.original.mealType]}
        </Badge>
      ),
    },
    {
      accessorKey: "brand",
      header: "Brand",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="text-xs text-muted-foreground">{row.original.brand}</span>
      ),
    },
    {
      accessorKey: "residentsCount",
      header: "Residents",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="flex items-center gap-1.5 text-sm">
          <Users className="w-3.5 h-3.5 text-muted-foreground" /> {row.original.residentsCount}
        </span>
      ),
    },
    {
      accessorKey: "dispatchedAt",
      header: "Dispatched",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="text-sm text-muted-foreground">{fmtDateTime(row.original.dispatchedAt)}</span>
      ),
    },
    {
      accessorKey: "deliveryPartnerId",
      header: "Delivery Partner",
      cell: ({ row }: { row: { original: FoodOrder } }) => (
        <span className="text-sm">
          {row.original.deliveryPartnerName ?? partnerName(row.original.deliveryPartnerId)}
        </span>
      ),
    },
  ];
  const scopedCols = useScopedColumns(cols as any, { singleProperty: ["propertyName", "brand"] });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Confirm Delivery"
        subtitle="Verify receipt of dispatched orders and record proof of delivery"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      {!isLoading && orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed bg-card py-16 text-center">
          <PackageCheck className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">Nothing awaits confirmation</p>
          <p className="text-xs text-muted-foreground mt-1">
            All dispatched orders have been delivered. Newly dispatched orders will appear here.
          </p>
        </div>
      ) : (
        <DataTable
          columns={scopedCols as any}
          data={orders}
          isLoading={isLoading}
          onRowClick={(row: FoodOrder) => setDetailId(row.id)}
        />
      )}

      <ConfirmDeliverySheet
        id={detailId}
        onClose={() => setDetailId(null)}
        propName={propName}
        partnerName={partnerName}
        listParams={params}
      />
    </div>
  );
}

// ─── Detail / proof-of-receipt sheet ────────────────────────────────────────────
interface ItemEntry {
  itemId: string;
  dishName: string;
  /** Canonical unit of the line item — `value` is submitted in this unit. */
  unit: string;
  /** Unit currently shown in the stepper; `value` is expressed in this unit. */
  displayUnit: string;
  orderedQty: number;
  /** Received quantity, expressed in `displayUnit`. */
  value: string;
}

function ConfirmDeliverySheet({
  id, onClose, propName, partnerName, listParams,
}: {
  id: string | null;
  onClose: () => void;
  propName: (id?: string | null) => string;
  partnerName: (id?: string | null) => string;
  listParams: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: order, isLoading } = useQuery({
    queryKey: id ? foodKeys.order(id) : ["food", "order", "none"],
    queryFn: () => foodApi.getOrder(id!),
    enabled: !!id,
  });

  const [entries, setEntries] = React.useState<ItemEntry[]>([]);
  const [remarks, setRemarks] = React.useState("");

  // Seed the receipt form whenever an order loads. Default receivedQty = orderedQty.
  React.useEffect(() => {
    if (!order) return;
    setEntries(
      (order.items ?? []).map((it: FoodOrderItem) => {
        const ordered = Number(it.orderedQty ?? 0);
        return {
          itemId: it.id,
          dishName: it.dishName ?? it.dishId,
          unit: it.unit,
          displayUnit: it.unit,
          orderedQty: ordered,
          value: String(ordered),
        };
      }),
    );
    setRemarks(order.deliveryRemarks ?? "");
  }, [order]);

  // Received qty in the item's canonical unit (value is entered in displayUnit).
  const receivedCanonical = (e: ItemEntry): number =>
    round3(convertQty(Number(e.value), e.displayUnit, e.unit));

  const errorFor = (e: ItemEntry): string | null => {
    if (e.value.trim() === "") return "Required";
    const n = Number(e.value);
    if (!Number.isFinite(n)) return "Must be a number";
    if (n < 0) return "Cannot be negative";
    if (receivedCanonical(e) > e.orderedQty) return `Cannot exceed ${fmtQty(e.orderedQty, e.unit)}`;
    return null;
  };
  const hasErrors = entries.some((e) => errorFor(e) !== null);

  const setValue = (itemId: string, value: string) =>
    setEntries((prev) => prev.map((e) => (e.itemId === itemId ? { ...e, value } : e)));

  // Stepper unit change: value already auto-converted via onChange; just record the unit.
  const setDisplayUnit = (itemId: string, displayUnit: string) =>
    setEntries((prev) => prev.map((e) => (e.itemId === itemId ? { ...e, displayUnit } : e)));

  // Per-item variance (computed in canonical units).
  const varianceFor = (e: ItemEntry) => {
    const received = receivedCanonical(e);
    const diff = round3(received - e.orderedQty);
    const pct = e.orderedQty > 0 ? (diff / e.orderedQty) * 100 : 0;
    return { received, diff, pct, short: diff < 0 };
  };

  // Order-level variance summary (canonical units share the same base only when
  // units match; we still aggregate raw canonical totals + a combined % shortfall).
  const overall = entries.reduce(
    (acc, e) => {
      const v = varianceFor(e);
      acc.ordered += e.orderedQty;
      acc.received += v.received;
      return acc;
    },
    { ordered: 0, received: 0 },
  );
  const overallDiff = round3(overall.received - overall.ordered);
  const overallPct = overall.ordered > 0 ? (overallDiff / overall.ordered) * 100 : 0;

  const mutation = useMutation({
    mutationFn: () =>
      foodApi.confirmDelivery(
        id!,
        entries.map((e) => ({ itemId: e.itemId, receivedQty: receivedCanonical(e) })),
        remarks.trim() || undefined,
      ),
    onSuccess: () => {
      toast({ title: "Delivery confirmed", description: `${order?.orderNumber} marked as delivered.` });
      qc.invalidateQueries({ queryKey: foodKeys.orders(listParams) });
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
      if (id) qc.invalidateQueries({ queryKey: foodKeys.order(id) });
      onClose();
    },
    onError: (e: any) => {
      toast({ title: e?.message || "Failed to confirm delivery", variant: "destructive" });
    },
  });

  const onSubmit = () => {
    if (hasErrors) {
      toast({ title: "Fix the highlighted quantities before confirming", variant: "destructive" });
      return;
    }
    mutation.mutate();
  };

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl w-full overflow-y-auto flex flex-col">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-3">
            <span className="font-mono text-base">{order?.orderNumber ?? "Order"}</span>
            {order && <StatusBadge status={order.status} />}
          </SheetTitle>
        </SheetHeader>

        {isLoading || !order ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6 mt-4 flex-1">
            {/* Summary */}
            <div className="grid grid-cols-2 gap-3 text-sm border rounded-md p-4 bg-card">
              <div>
                <p className="text-muted-foreground text-xs uppercase">Property</p>
                <p className="font-medium">{order.propertyName ?? propName(order.propertyId)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Meal</p>
                <p className="font-medium">{MEAL_LABEL[order.mealType]} · {order.brand}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Residents</p>
                <p className="font-medium">{order.residentsCount}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Delivery Partner</p>
                <p className="font-medium">{order.deliveryPartnerName ?? partnerName(order.deliveryPartnerId)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Service Date</p>
                <p className="font-medium">{fmtDateTime(order.serviceDate)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Dispatched</p>
                <p className="font-medium">{fmtDateTime(order.dispatchedAt)}</p>
              </div>
            </div>

            {/* Lifecycle timeline */}
            <div>
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-muted-foreground" /> Lifecycle
              </h4>
              <LifecycleTimeline events={order.events ?? []} />
            </div>

            <Separator />

            {/* Proof of receipt */}
            <div>
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-muted-foreground" /> Proof of Receipt
              </h4>
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground p-3 border border-dashed rounded-md">
                  This order has no line items.
                </p>
              ) : (
                <div className="space-y-2">
                  {entries.map((e) => {
                    const err = errorFor(e);
                    const v = varianceFor(e);
                    // Stepper min/max expressed in the currently displayed unit.
                    const dispMax = round3(convertQty(e.orderedQty, e.unit, e.displayUnit));
                    const critical = e.orderedQty > 0 && v.pct < -5;
                    return (
                      <div key={e.itemId} className="border rounded-md p-3 bg-card">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{e.dishName}</p>
                            <p className="text-xs text-muted-foreground">
                              Ordered: {fmtQty(e.orderedQty, e.unit)}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <Label className="text-[10px] uppercase text-muted-foreground">
                              Received
                            </Label>
                            <NumberStepper
                              value={Number(e.value)}
                              min={0}
                              max={dispMax}
                              step={0.001}
                              unit={e.displayUnit}
                              unitOptions={unitOptionsFor(e.unit)}
                              onChange={(n) => setValue(e.itemId, String(n))}
                              onUnitChange={(u) => setDisplayUnit(e.itemId, u)}
                              aria-label={`${e.dishName} received quantity`}
                              className={err ? "mt-1 border-destructive" : "mt-1"}
                            />
                          </div>
                        </div>
                        {/* Per-item variance preview (ordered vs received) */}
                        {err ? (
                          <p className="text-xs text-destructive mt-1.5">{err}</p>
                        ) : v.diff === 0 ? (
                          <p className="text-xs text-muted-foreground mt-1.5">
                            Received {fmtQty(v.received, e.unit)} · no variance
                          </p>
                        ) : (
                          <p
                            className={cn(
                              "text-xs mt-1.5 flex items-center gap-1.5",
                              v.short
                                ? critical
                                  ? "text-destructive font-medium"
                                  : "text-warning"
                                : "text-muted-foreground",
                            )}
                          >
                            {v.short && (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span>
                              {v.diff > 0 ? "+" : ""}
                              {fmtQty(v.diff, e.unit)} ({v.pct > 0 ? "+" : ""}
                              {Math.round(v.pct)}%)
                              {critical && " · critical shortfall"}
                            </span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Order-level overall variance summary */}
              {entries.length > 0 && !hasErrors && (
                <div
                  className={cn(
                    "mt-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm",
                    overallDiff < 0
                      ? overallPct < -5
                        ? "border-destructive/40 bg-destructive/5"
                        : "border-warning/40 bg-warning/5"
                      : "bg-card",
                  )}
                >
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    Overall received
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="font-medium">
                      {round3(overall.received)} / {round3(overall.ordered)}
                    </span>
                    {overallDiff < 0 ? (
                      <span
                        className={cn(
                          "flex items-center gap-1 font-medium",
                          overallPct < -5 ? "text-destructive" : "text-warning",
                        )}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {round3(overallDiff)} ({Math.round(overallPct)}%)
                      </span>
                    ) : (
                      <span className="text-muted-foreground">no shortfall</span>
                    )}
                  </span>
                </div>
              )}
            </div>

            <div>
              <Label>Remarks</Label>
              <Textarea
                rows={3}
                placeholder="Optional notes about the delivery (shortfalls, condition, etc.)"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>
          </div>
        )}

        {order && (
          <div className="border-t pt-4 mt-2 flex items-center justify-end gap-3 sticky bottom-0 bg-background">
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={onSubmit}
              disabled={mutation.isPending || hasErrors || entries.length === 0}
              className="bg-accent hover:bg-accent/90 text-white"
            >
              {mutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Mark Delivered
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function LifecycleTimeline({ events }: { events: FoodOrderEvent[] }) {
  if (!events.length) {
    return (
      <p className="text-sm text-muted-foreground p-3 border border-dashed rounded-md">
        No lifecycle events recorded.
      </p>
    );
  }
  return (
    <ol className="relative border-l border-border ml-2 space-y-4">
      {events.map((ev) => (
        <li key={ev.id} className="ml-4">
          <span className="absolute -left-[5px] mt-1.5 flex h-2.5 w-2.5 items-center justify-center">
            <CircleDot className="h-2.5 w-2.5 text-primary" />
          </span>
          <div className="flex items-center gap-2">
            <StatusBadge status={ev.status} />
            <span className="text-xs text-muted-foreground">{fmtDateTime(ev.createdAt)}</span>
          </div>
          {ev.note && <p className="text-xs text-muted-foreground mt-1">{ev.note}</p>}
          {ev.actorName && <p className="text-[11px] text-muted-foreground/80 mt-0.5">by {ev.actorName}</p>}
        </li>
      ))}
    </ol>
  );
}
