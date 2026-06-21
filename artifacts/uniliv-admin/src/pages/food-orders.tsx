import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Plus, Search, Utensils, Package, CheckCircle2, XCircle, Truck, Clock, Ban,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { PropertyScopeBanner } from "@/components/property-scope-banner";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, ORDER_STATUSES, MEAL_LABEL, fmtQty,
  type FoodOrder, type OrderStatus, type OrderDetail, type FoodOrderEvent,
} from "@/lib/food-api";
import { useQueryParam } from "@/lib/nav-helpers";

const ALL = "ALL";

export default function FoodOrders() {
  const [, setLocation] = useLocation();
  const paramProperty = useQueryParam("propertyId");

  const [status, setStatus] = React.useState<string>(ALL);
  const [propertyId, setPropertyId] = React.useState<string>(paramProperty || ALL);
  // When navigated here scoped to a property (?propertyId=), apply that filter.
  React.useEffect(() => { if (paramProperty) setPropertyId(paramProperty); }, [paramProperty]);
  const [brand, setBrand] = React.useState<string>(ALL);
  const [mealType, setMealType] = React.useState<string>(ALL);
  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  const [searchInput, setSearchInput] = React.useState<string>("");
  const [search, setSearch] = React.useState<string>("");
  const [detailId, setDetailId] = React.useState<string | null>(null);

  // Debounce search by orderNumber.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name ?? "—") : "—";

  const params = React.useMemo(
    () => ({
      status: status === ALL ? undefined : status,
      from: from || undefined,
      to: to || undefined,
      propertyId: propertyId === ALL ? undefined : propertyId,
      brand: brand === ALL ? undefined : brand,
      mealType: mealType === ALL ? undefined : mealType,
      search: search || undefined,
      limit: 100,
    }),
    [status, from, to, propertyId, brand, mealType, search],
  );

  const { data: res, isLoading } = useQuery({
    queryKey: foodKeys.orders(params),
    queryFn: () => foodApi.listOrders(params),
  });
  const orders: FoodOrder[] = res?.data ?? [];

  const stats = React.useMemo(() => {
    const total = res?.meta?.total ?? orders.length;
    const active = orders.filter((o) => o.status === "PLACED" || o.status === "PREPARING").length;
    const inTransit = orders.filter((o) => o.status === "DISPATCHED").length;
    const delivered = orders.filter((o) => o.status === "DELIVERED").length;
    return { total, active, inTransit, delivered };
  }, [orders, res?.meta?.total]);

  // Name of the property the page is currently scoped to (URL param or filter),
  // for the scope banner. Falls back gracefully until lookups resolve.
  const scopedPropertyName =
    propertyId === ALL ? null : (properties.find((p) => p.id === propertyId)?.name ?? "Selected property");
  const clearScope = () => {
    setPropertyId(ALL);
    if (paramProperty) setLocation("/food/orders"); // drop the ?propertyId= deep-link
  };

  const resetFilters = () => {
    setStatus(ALL); setPropertyId(ALL); setBrand(ALL); setMealType(ALL);
    setFrom(""); setTo(""); setSearchInput(""); setSearch("");
    if (paramProperty) setLocation("/food/orders");
  };
  const hasFilters =
    status !== ALL || propertyId !== ALL || brand !== ALL || mealType !== ALL || !!from || !!to || !!search;

  const cols = [
    {
      accessorKey: "orderNumber",
      header: "Order ID",
      cell: ({ row }: any) => (
        <span className="font-mono text-xs text-primary font-medium">{row.original.orderNumber}</span>
      ),
    },
    {
      accessorKey: "propertyId",
      header: "Property",
      cell: ({ row }: any) => <span className="font-medium">{propName(row.original.propertyId)}</span>,
    },
    {
      accessorKey: "unitLeadName",
      header: "Unit Lead",
      cell: ({ row }: any) => row.original.unitLeadName || <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "mealType",
      header: "Meal",
      cell: ({ row }: any) => MEAL_LABEL[row.original.mealType as keyof typeof MEAL_LABEL] ?? row.original.mealType,
    },
    {
      accessorKey: "residentsCount",
      header: "Residents",
      cell: ({ row }: any) => <span className="tabular-nums">{row.original.residentsCount}</span>,
    },
    {
      accessorKey: "totalQuantity",
      header: "Quantity",
      cell: ({ row }: any) => <span className="tabular-nums">{fmtQty(row.original.totalQuantity)}</span>,
    },
    {
      accessorKey: "serviceDate",
      header: "Date",
      cell: ({ row }: any) =>
        row.original.serviceDate ? format(new Date(row.original.serviceDate), "dd MMM yyyy") : "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Orders"
        subtitle="Master list of food orders across properties and kitchens"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setLocation("/food/place-order")}>
            <Plus className="w-4 h-4 mr-2" /> Place Order
          </Button>
        }
      />

      <PropertyScopeBanner propertyName={scopedPropertyName} onClear={clearScope} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Orders" value={stats.total} icon={Utensils} />
        <StatCard title="Active (Placed / Preparing)" value={stats.active} icon={Clock} />
        <StatCard title="In Transit" value={stats.inTransit} icon={Truck} />
        <StatCard title="Delivered" value={stats.delivered} icon={CheckCircle2} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order number..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">From</Label>
          <DatePicker value={from} max={to} onChange={setFrom} className="w-[150px]" />
          <Label className="text-xs text-muted-foreground whitespace-nowrap">To</Label>
          <DatePicker value={to} min={from} onChange={setTo} className="w-[150px]" />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>Clear</Button>
        )}
      </div>

      <DataTable
        columns={cols as any}
        data={orders}
        isLoading={isLoading}
        onRowClick={(row: any) => setDetailId(row.id)}
      />

      <OrderDetailSheet id={detailId} onClose={() => setDetailId(null)} propName={propName} />
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs uppercase tracking-wider">{label}</p>
      <p className="font-medium mt-0.5">{value ?? "—"}</p>
    </div>
  );
}

function OrderDetailSheet({
  id, onClose, propName,
}: {
  id: string | null;
  onClose: () => void;
  propName: (id?: string | null) => string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");

  const { data: order, isLoading } = useQuery<OrderDetail>({
    queryKey: foodKeys.order(id ?? ""),
    queryFn: () => foodApi.getOrder(id as string),
    enabled: !!id,
  });

  React.useEffect(() => { if (cancelOpen) setCancelReason(""); }, [cancelOpen]);

  const cancelMutation = useMutation({
    mutationFn: () => foodApi.cancelOrder(id as string, cancelReason.trim() || undefined),
    onSuccess: () => {
      toast({ title: "Order cancelled" });
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: foodKeys.order(id as string) });
      setCancelOpen(false);
    },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const canCancel = !!order && (order.status === "PLACED" || order.status === "PREPARING");

  // Events oldest -> newest (chronological).
  const events: FoodOrderEvent[] = React.useMemo(
    () =>
      [...(order?.events ?? [])].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [order?.events],
  );

  const fmtDateTime = (s?: string | null) =>
    s ? format(new Date(s), "dd MMM yyyy, HH:mm") : "—";

  return (
    <>
      <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
        <SheetContent className="sm:max-w-2xl w-full overflow-y-auto">
          {isLoading || !order ? (
            <div className="space-y-4 mt-6">
              <SheetHeader>
                <SheetTitle className="font-display">Order details</SheetTitle>
              </SheetHeader>
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="space-y-6">
              <SheetHeader>
                <SheetTitle className="font-display flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-base">{order.orderNumber}</span>
                  <StatusBadge status={order.status} />
                </SheetTitle>
              </SheetHeader>

              {/* Meta grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm border rounded-md p-4 bg-card">
                <MetaItem label="Property" value={propName(order.propertyId)} />
                <MetaItem label="Unit Lead" value={order.unitLeadName} />
                <MetaItem label="Brand" value={order.brand} />
                <MetaItem label="Meal" value={MEAL_LABEL[order.mealType]} />
                <MetaItem label="Residents" value={<span className="tabular-nums">{order.residentsCount}</span>} />
                <MetaItem label="Quantity" value={<span className="tabular-nums">{fmtQty(order.totalQuantity)}</span>} />
                <MetaItem label="Service Date" value={order.serviceDate ? format(new Date(order.serviceDate), "dd MMM yyyy") : "—"} />
                <MetaItem label="Delivery Partner" value={order.deliveryPartnerName} />
                <MetaItem label="Delivered At" value={fmtDateTime(order.deliveredAt)} />
              </div>

              {order.notes && (
                <div className="text-sm border rounded-md p-3 bg-muted/30">
                  <p className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Notes</p>
                  <p>{order.notes}</p>
                </div>
              )}
              {order.status === "CANCELLED" && order.cancelReason && (
                <div className="text-sm border border-destructive/30 rounded-md p-3 bg-destructive/5">
                  <p className="text-destructive text-xs uppercase tracking-wider mb-1 font-medium">Cancellation Reason</p>
                  <p>{order.cancelReason}</p>
                </div>
              )}

              {/* Contextual actions */}
              {canCancel && (
                <div className="flex gap-2">
                  <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)}>
                    <Ban className="w-4 h-4 mr-2" /> Cancel Order
                  </Button>
                </div>
              )}

              {/* Items */}
              <div>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Package className="w-4 h-4 text-muted-foreground" /> Items ({order.items.length})
                </h4>
                {order.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-4 border rounded-md text-center">No items.</p>
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left p-2 font-medium">Dish</th>
                          <th className="text-right p-2 font-medium">Ordered</th>
                          <th className="text-right p-2 font-medium">Prepared</th>
                          <th className="text-right p-2 font-medium">Received</th>
                          <th className="text-right p-2 font-medium">Wasted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((it) => (
                          <tr key={it.id} className="border-t">
                            <td className="p-2">
                              <span className="font-medium">{it.dishName || it.dishId}</span>
                              {it.component && (
                                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">{it.component}</span>
                              )}
                            </td>
                            <td className="p-2 text-right tabular-nums">{fmtQty(it.orderedQty, it.unit)}</td>
                            <td className="p-2 text-right tabular-nums">{fmtQty(it.preparedQty, it.unit)}</td>
                            <td className="p-2 text-right tabular-nums">{fmtQty(it.receivedQty, it.unit)}</td>
                            <td className="p-2 text-right tabular-nums">{fmtQty(it.wastedQty, it.unit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <Separator />

              {/* Timeline */}
              <div>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" /> Timeline
                </h4>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-4 border rounded-md text-center">No events recorded.</p>
                ) : (
                  <ol className="relative border-l border-border ml-2 space-y-5">
                    {events.map((ev) => (
                      <li key={ev.id} className="ml-4">
                        <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusBadge status={ev.status} />
                          <span className="text-xs text-muted-foreground">{fmtDateTime(ev.createdAt)}</span>
                        </div>
                        {ev.note && <p className="text-sm mt-1">{ev.note}</p>}
                        {ev.actorName && <p className="text-xs text-muted-foreground mt-0.5">by {ev.actorName}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <FormModal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel Order"
        onSave={() => cancelMutation.mutate()}
        isSaving={cancelMutation.isPending}
        saveLabel="Cancel Order"
        cancelLabel="Keep Order"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <XCircle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
            <p>This will cancel the order. This action cannot be undone.</p>
          </div>
          <div>
            <Label>Reason</Label>
            <Textarea
              rows={3}
              placeholder="Reason for cancellation (optional)..."
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
        </div>
      </FormModal>
    </>
  );
}
