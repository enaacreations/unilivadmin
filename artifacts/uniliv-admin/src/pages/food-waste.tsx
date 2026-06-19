import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, isAfter } from "date-fns";
import {
  Trash2, Clock, Lock, Unlock, Package, AlertTriangle, CalendarDays, Save,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, fmtQty,
  type FoodOrder, type FoodOrderItem,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isWindowOpen(order: { wasteEditableUntil: string | null }): boolean {
  if (!order.wasteEditableUntil) return false;
  return isAfter(new Date(order.wasteEditableUntil), new Date());
}

function WindowBadge({ until }: { until: string | null }) {
  if (!until) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="h-3 w-3" /> Locked
      </Badge>
    );
  }
  const open = isAfter(new Date(until), new Date());
  if (open) {
    return (
      <Badge variant="success" className="gap-1">
        <Unlock className="h-3 w-3" /> Open · {formatDistanceToNowStrict(new Date(until))} left
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Lock className="h-3 w-3" /> Locked · {formatDistanceToNowStrict(new Date(until), { addSuffix: true })}
    </Badge>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function FoodWaste() {
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [brand, setBrand] = React.useState("ALL");
  const [meal, setMeal] = React.useState("ALL");
  const [date, setDate] = React.useState("");
  const [detailId, setDetailId] = React.useState<string | null>(null);

  // Tick every 30s so countdowns / lock state stay live.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? properties.find((p) => p.id === id)?.name ?? "—" : "—";

  const params: Record<string, unknown> = { status: "DELIVERED", limit: 100 };
  if (propertyId !== "ALL") params.propertyId = propertyId;
  if (brand !== "ALL") params.brand = brand;
  if (meal !== "ALL") params.mealType = meal;
  if (date) params.serviceDate = date;

  const { data: ordersRes, isLoading } = useQuery({
    queryKey: foodKeys.orders(params),
    queryFn: () => foodApi.listOrders(params),
  });
  const orders = ordersRes?.data ?? [];

  const openCount = orders.filter((o) => isWindowOpen(o)).length;
  const lockedCount = orders.length - openCount;

  const cols = [
    {
      accessorKey: "orderNumber",
      header: "Order",
      cell: ({ row }: any) => (
        <span className="font-mono text-xs font-medium text-primary">{row.original.orderNumber}</span>
      ),
    },
    {
      accessorKey: "propertyId",
      header: "Property",
      cell: ({ row }: any) => (
        <span className="font-medium">{row.original.propertyName || propName(row.original.propertyId)}</span>
      ),
    },
    {
      accessorKey: "brand",
      header: "Brand",
      cell: ({ row }: any) => (
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{row.original.brand}</Badge>
      ),
    },
    {
      accessorKey: "mealType",
      header: "Meal",
      cell: ({ row }: any) => <span className="text-sm">{MEAL_LABEL[row.original.mealType as keyof typeof MEAL_LABEL]}</span>,
    },
    {
      accessorKey: "serviceDate",
      header: "Service Date",
      cell: ({ row }: any) => (
        <span className="text-sm text-muted-foreground">
          {row.original.serviceDate ? format(new Date(row.original.serviceDate), "dd MMM yyyy") : "—"}
        </span>
      ),
    },
    {
      accessorKey: "deliveredAt",
      header: "Delivered",
      cell: ({ row }: any) => (
        <span className="text-xs text-muted-foreground">
          {row.original.deliveredAt ? format(new Date(row.original.deliveredAt), "dd MMM, HH:mm") : "—"}
        </span>
      ),
    },
    {
      accessorKey: "wasteEditableUntil",
      header: "Waste Window",
      cell: ({ row }: any) => <WindowBadge until={row.original.wasteEditableUntil} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waste Tracking"
        subtitle="Record post-delivery wastage on delivered orders within the 1-hour edit window"
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Delivered Orders" value={isLoading ? "—" : orders.length} icon={Package} />
        <StatCard title="Editable Now" value={isLoading ? "—" : openCount} icon={Unlock} />
        <StatCard title="Locked" value={isLoading ? "—" : lockedCount} icon={Lock} />
      </div>

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
        <Select value={meal} onValueChange={setMeal}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="relative">
          <CalendarDays className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44 pl-9"
          />
        </div>
        {(propertyId !== "ALL" || brand !== "ALL" || meal !== "ALL" || date) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setPropertyId("ALL"); setBrand("ALL"); setMeal("ALL"); setDate(""); }}
          >
            Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={cols as any}
        data={orders}
        isLoading={isLoading}
        onRowClick={(row: FoodOrder) => setDetailId(row.id)}
      />

      <WasteSheet id={detailId} onClose={() => setDetailId(null)} propName={propName} ordersParams={params} />
    </div>
  );
}

// ─── Waste editing sheet ────────────────────────────────────────────────────────
function WasteSheet({
  id, onClose, propName, ordersParams,
}: {
  id: string | null;
  onClose: () => void;
  propName: (id?: string | null) => string;
  ordersParams: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: order, isLoading } = useQuery({
    queryKey: id ? foodKeys.order(id) : ["food", "order", "none"],
    queryFn: () => foodApi.getOrder(id as string),
    enabled: !!id,
  });

  const locked = order ? !isWindowOpen(order) : true;

  // Local draft of wasted quantities keyed by item id.
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (order) {
      const next: Record<string, string> = {};
      for (const it of order.items) {
        next[it.id] = it.wastedQty == null ? "" : String(Number(it.wastedQty));
      }
      setDraft(next);
    } else {
      setDraft({});
    }
  }, [order]);

  const errorFor = (it: FoodOrderItem): string | null => {
    const raw = draft[it.id];
    if (raw === undefined || raw === "") return null; // empty = unchanged / 0
    const n = Number(raw);
    if (Number.isNaN(n)) return "Enter a valid number";
    if (n < 0) return "Cannot be negative";
    const ordered = Number(it.orderedQty);
    if (!Number.isNaN(ordered) && n > ordered) return `Cannot exceed ordered (${fmtQty(ordered, it.unit)})`;
    return null;
  };

  const items = order?.items ?? [];
  const hasError = items.some((it) => errorFor(it) !== null);

  const mutation = useMutation({
    mutationFn: () => {
      const payload = items.map((it) => ({
        itemId: it.id,
        wastedQty: draft[it.id] === "" || draft[it.id] === undefined ? 0 : Number(draft[it.id]),
      }));
      return foodApi.recordWaste(id as string, payload);
    },
    onSuccess: () => {
      toast({ title: "Waste recorded" });
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
      if (id) qc.invalidateQueries({ queryKey: foodKeys.order(id) });
      // keep the params referenced so the active list refetches predictably
      qc.invalidateQueries({ queryKey: foodKeys.orders(ordersParams) });
      onClose();
    },
    onError: (e: any) => {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    },
  });

  const totalWasted = items.reduce((sum, it) => {
    const v = draft[it.id];
    const n = v === "" || v === undefined ? 0 : Number(v);
    return sum + (Number.isNaN(n) ? 0 : n);
  }, 0);

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl w-full overflow-y-auto">
        {isLoading && (
          <div className="space-y-4 mt-6">
            <SheetHeader>
              <SheetTitle className="font-display">Waste tracking</SheetTitle>
            </SheetHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {!isLoading && order && (
          <div className="space-y-6">
            <SheetHeader>
              <SheetTitle className="font-display flex flex-wrap items-center gap-3">
                <Trash2 className="h-5 w-5 text-muted-foreground" />
                Record Waste
                <span className="font-mono text-sm text-muted-foreground">{order.orderNumber}</span>
                <WindowBadge until={order.wasteEditableUntil} />
              </SheetTitle>
            </SheetHeader>

            <div className="grid grid-cols-2 gap-3 text-sm border rounded-md p-4 bg-card">
              <div><p className="text-muted-foreground text-xs uppercase">Property</p><p className="font-medium">{order.propertyName || propName(order.propertyId)}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Meal</p><p className="font-medium">{MEAL_LABEL[order.mealType]} · {order.brand}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Service Date</p><p className="font-medium">{order.serviceDate ? format(new Date(order.serviceDate), "dd MMM yyyy") : "—"}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Delivered</p><p className="font-medium">{order.deliveredAt ? format(new Date(order.deliveredAt), "dd MMM, HH:mm") : "—"}</p></div>
            </div>

            {locked ? (
              <Alert variant="destructive">
                <Lock className="h-4 w-4" />
                <AlertTitle>Waste editing locked</AlertTitle>
                <AlertDescription>
                  Waste is only editable within 1 hour of delivery.
                  {order.wasteEditableUntil && (
                    <> Window closed {formatDistanceToNowStrict(new Date(order.wasteEditableUntil), { addSuffix: true })}.</>
                  )}
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <Clock className="h-4 w-4" />
                <AlertTitle>Edit window open</AlertTitle>
                <AlertDescription>
                  {order.wasteEditableUntil && (
                    <>You have {formatDistanceToNowStrict(new Date(order.wasteEditableUntil))} left to record waste for this order.</>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium">Per-dish waste</h4>
                <span className="text-xs text-muted-foreground">
                  Total wasted: <span className="font-medium text-foreground">{fmtQty(totalWasted)}</span>
                </span>
              </div>

              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-muted-foreground py-10 border border-dashed rounded-md">
                  <Package className="h-8 w-8 mb-2" />
                  <p className="text-sm">No dishes on this order.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {items.map((it) => {
                    const err = errorFor(it);
                    return (
                      <div key={it.id} className="border rounded-md p-3 bg-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{it.dishName || it.dishId}</p>
                            <p className="text-xs text-muted-foreground">
                              {it.component ? `${it.component} · ` : ""}Ordered {fmtQty(it.orderedQty, it.unit)}
                            </p>
                          </div>
                        </div>

                        <Separator className="my-3" />

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">Received ({it.unit.toLowerCase()})</Label>
                            <Input value={it.receivedQty == null ? "—" : String(Number(it.receivedQty))} readOnly disabled className="mt-1 bg-muted/40" />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Wasted ({it.unit.toLowerCase()})</Label>
                            <Input
                              type="number"
                              min={0}
                              max={Number(it.orderedQty)}
                              step="any"
                              value={draft[it.id] ?? ""}
                              placeholder="0"
                              disabled={locked}
                              onChange={(e) => setDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                              className={`mt-1 ${err ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            />
                            {err && <p className="text-xs text-destructive mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {err}</p>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t">
              <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={locked || hasError || items.length === 0 || mutation.isPending}
              >
                <Save className="h-4 w-4 mr-2" />
                {mutation.isPending ? "Saving..." : "Save Waste"}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
