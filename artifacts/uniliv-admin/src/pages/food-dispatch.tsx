import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Truck, Package, Clock, Users, Boxes, MapPin, CheckCircle2, Send, Inbox, X,
  ChefHat, User, Phone, Hash, Timer, Route, ChevronRight, PackageCheck,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription,
  DrawerFooter, DrawerClose,
} from "@/components/ui/drawer";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/lib/store";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, fmtQty,
  type FoodOrder, type FoodBrand, type MealType,
  type Dispatch, type DispatchStatus,
} from "@/lib/food-api";

const ALL = "ALL";

const DISPATCH_STATUSES: DispatchStatus[] = ["LOADING", "IN_TRANSIT", "DELIVERED", "PARTIAL"];

const DISPATCH_STATUS_META: Record<
  DispatchStatus,
  { label: string; variant: "secondary" | "info" | "success" | "warning"; icon: React.ElementType }
> = {
  LOADING: { label: "Loading", variant: "secondary", icon: Boxes },
  IN_TRANSIT: { label: "In transit", variant: "info", icon: Truck },
  DELIVERED: { label: "Delivered", variant: "success", icon: PackageCheck },
  PARTIAL: { label: "Partial", variant: "warning", icon: Timer },
};

function DispatchStatusBadge({ status }: { status: DispatchStatus }) {
  const meta = DISPATCH_STATUS_META[status] ?? DISPATCH_STATUS_META.LOADING;
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1">
      <Icon className="w-3 h-3" /> {meta.label}
    </Badge>
  );
}

export default function FoodDispatch() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { propertyId: storeProperty } = useAppStore();

  const [tab, setTab] = React.useState<"queue" | "transit" | "trips">("queue");
  const [propertyId, setPropertyId] = React.useState(ALL);
  const [brand, setBrand] = React.useState<FoodBrand | typeof ALL>(ALL);
  const [meal, setMeal] = React.useState<MealType | typeof ALL>(ALL);
  const [date, setDate] = React.useState("");

  // Per-card chosen partner (single dispatch) and bulk selection
  const [cardPartner, setCardPartner] = React.useState<Record<string, string>>({});
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkPartner, setBulkPartner] = React.useState("");

  // Trip-builder drawer state
  const [tripOpen, setTripOpen] = React.useState(false);
  const [tripForm, setTripForm] = React.useState({
    kitchenId: "",
    deliveryPartnerId: "",
    vehicleNumber: "",
    driverName: "",
    driverPhone: "",
    etaMinutes: "",
  });

  // Trip-detail sheet state
  const [openTripId, setOpenTripId] = React.useState<string | null>(null);

  // ── Lookups (properties + delivery partners) ──────────────────────────────
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

  // ── Kitchens (for trip builder) ───────────────────────────────────────────
  const { data: kitchens = [] } = useQuery({
    queryKey: foodKeys.kitchens(),
    queryFn: () => foodApi.listKitchens(),
  });

  // ── Effective property scope: explicit filter wins, else global store ──────
  const effectiveProperty =
    propertyId !== ALL ? propertyId : storeProperty ?? undefined;

  // ── Shared filter params ──────────────────────────────────────────────────
  const filterParams: Record<string, unknown> = {
    propertyId: effectiveProperty,
    brand: brand === ALL ? undefined : brand,
    mealType: meal === ALL ? undefined : meal,
    serviceDate: date || undefined,
  };

  const preparingParams = { ...filterParams, status: "PREPARING", limit: 100 };
  const acceptedParams = { ...filterParams, status: "ACCEPTED", limit: 100 };
  const dispatchedParams = { ...filterParams, status: "DISPATCHED", limit: 100 };

  const { data: preparingRes, isLoading: loadingPreparing } = useQuery({
    queryKey: foodKeys.orders(preparingParams),
    queryFn: () => foodApi.listOrders(preparingParams),
  });
  const { data: acceptedRes, isLoading: loadingAccepted } = useQuery({
    queryKey: foodKeys.orders(acceptedParams),
    queryFn: () => foodApi.listOrders(acceptedParams),
  });

  // Dispatchable board = PREPARING (primary) + ACCEPTED (ready to load).
  const dispatchable = React.useMemo<FoodOrder[]>(() => {
    const prep = preparingRes?.data ?? [];
    const acc = acceptedRes?.data ?? [];
    const seen = new Set(prep.map((o) => o.id));
    return [...prep, ...acc.filter((o) => !seen.has(o.id))];
  }, [preparingRes, acceptedRes]);
  const loadingQueue = loadingPreparing || loadingAccepted;

  const { data: dispatchedRes, isLoading: loadingDispatched } = useQuery({
    queryKey: foodKeys.orders(dispatchedParams),
    queryFn: () => foodApi.listOrders(dispatchedParams),
  });
  const dispatched = dispatchedRes?.data ?? [];

  // ── Recent trips ──────────────────────────────────────────────────────────
  const { data: trips = [], isLoading: loadingTrips } = useQuery({
    queryKey: foodKeys.dispatches(),
    queryFn: () => foodApi.listDispatches(),
  });

  // Prune stale selection when the queue changes
  React.useEffect(() => {
    const ids = new Set(dispatchable.map((o) => o.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [dispatchable]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food"] });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const dispatchOne = useMutation({
    mutationFn: ({ id, deliveryPartnerId }: { id: string; deliveryPartnerId: string }) =>
      foodApi.dispatchOrder(id, { deliveryPartnerId, action: "dispatch" }),
    onSuccess: (_d, vars) => {
      toast({ title: "Order dispatched" });
      setSelected((prev) => { const n = new Set(prev); n.delete(vars.id); return n; });
      invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to dispatch", variant: "destructive" }),
  });

  const dispatchBulk = useMutation({
    mutationFn: ({ ids, deliveryPartnerId }: { ids: string[]; deliveryPartnerId: string }) =>
      foodApi.bulkDispatch(ids, deliveryPartnerId),
    onSuccess: (_d, vars) => {
      toast({ title: `Dispatched ${vars.ids.length} order${vars.ids.length === 1 ? "" : "s"}` });
      setSelected(new Set());
      setBulkPartner("");
      invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Bulk dispatch failed", variant: "destructive" }),
  });

  const createTrip = useMutation({
    mutationFn: (body: Record<string, unknown>) => foodApi.createDispatch(body),
    onSuccess: (trip) => {
      toast({
        title: "Dispatch trip created",
        description: trip?.dispatchNumber ? `Trip ${trip.dispatchNumber} is loading` : undefined,
      });
      setSelected(new Set());
      setTripForm({ kitchenId: "", deliveryPartnerId: "", vehicleNumber: "", driverName: "", driverPhone: "", etaMinutes: "" });
      setTripOpen(false);
      invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Could not create trip", variant: "destructive" }),
  });

  const updateTripStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DispatchStatus }) =>
      foodApi.updateDispatchStatus(id, status),
    onSuccess: () => {
      toast({ title: "Trip status updated" });
      invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Could not update trip", variant: "destructive" }),
  });

  const onDispatchOne = (o: FoodOrder) => {
    const dp = cardPartner[o.id];
    if (!dp) { toast({ title: "Select a delivery partner first", variant: "destructive" }); return; }
    dispatchOne.mutate({ id: o.id, deliveryPartnerId: dp });
  };

  const onBulkDispatch = () => {
    if (selected.size === 0) return;
    if (!bulkPartner) { toast({ title: "Select a delivery partner", variant: "destructive" }); return; }
    dispatchBulk.mutate({ ids: [...selected], deliveryPartnerId: bulkPartner });
  };

  const onCreateTrip = () => {
    if (selected.size === 0) {
      toast({ title: "Select at least one order", variant: "destructive" });
      return;
    }
    if (!tripForm.deliveryPartnerId) {
      toast({ title: "Choose a delivery partner", variant: "destructive" });
      return;
    }
    const eta = tripForm.etaMinutes.trim();
    createTrip.mutate({
      orderIds: [...selected],
      kitchenId: tripForm.kitchenId || undefined,
      deliveryPartnerId: tripForm.deliveryPartnerId,
      vehicleNumber: tripForm.vehicleNumber.trim() || undefined,
      driverName: tripForm.driverName.trim() || undefined,
      driverPhone: tripForm.driverPhone.trim() || undefined,
      etaMinutes: eta ? Number(eta) : undefined,
    });
  };

  const toggleSelect = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (checked) n.add(id); else n.delete(id);
      return n;
    });

  const totalQ = (o: FoodOrder) => fmtQty(o.totalQuantity);
  const partnerListReady = partners.length > 0;

  // ── Stats ─────────────────────────────────────────────────────────────────
  const awaiting = dispatchable.length;
  const inTransit = dispatched.length;
  const residentsWaiting = dispatchable.reduce((s, o) => s + (o.residentsCount || 0), 0);
  const activeTrips = trips.filter((t) => t.status === "LOADING" || t.status === "IN_TRANSIT").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch"
        subtitle="Build trips, assign vans and drivers, and move prepared meals out the door"
        action={
          <Button variant="outline" onClick={() => setLocation("/food/orders")}>
            <Package className="w-4 h-4 mr-2" /> All Orders
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Awaiting Dispatch" value={awaiting} icon={Clock} />
        <StatCard title="In Transit" value={inTransit} icon={Truck} />
        <StatCard title="Residents Waiting" value={residentsWaiting} icon={Users} />
        <StatCard title="Active Trips" value={activeTrips} icon={Route} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={(v) => setBrand(v as FoodBrand | typeof ALL)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={meal} onValueChange={(v) => setMeal(v as MealType | typeof ALL)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        {date && (
          <Button variant="ghost" size="sm" onClick={() => setDate("")} className="text-muted-foreground">
            <X className="w-4 h-4 mr-1" /> Clear date
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "queue" | "transit" | "trips")}>
        <TabsList>
          <TabsTrigger value="queue">
            Dispatch Queue
            {awaiting > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{awaiting}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="transit">
            In Transit
            {inTransit > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{inTransit}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="trips">
            Trips
            {trips.length > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{trips.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ── QUEUE: dispatchable orders (PREPARING + ACCEPTED) ─────────────── */}
        <TabsContent value="queue" className="mt-4">
          {loadingQueue ? (
            <CardGridSkeleton />
          ) : dispatchable.length === 0 ? (
            <LocalEmpty
              icon={CheckCircle2}
              title="Nothing waiting to dispatch"
              hint="Prepared and accepted orders ready for a trip will appear here. Adjust the filters above to widen the view."
            />
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-muted-foreground">
                  Select orders to bundle into a single dispatch trip, or dispatch one at a time.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() =>
                    setSelected((prev) =>
                      prev.size === dispatchable.length ? new Set() : new Set(dispatchable.map((o) => o.id)),
                    )
                  }
                >
                  {selected.size === dispatchable.length ? "Clear all" : "Select all"}
                </Button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pb-28">
                {dispatchable.map((o) => {
                  const isSel = selected.has(o.id);
                  return (
                    <Card
                      key={o.id}
                      className={`overflow-hidden transition-colors ${isSel ? "ring-2 ring-accent border-accent" : ""}`}
                    >
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-3 min-w-0">
                            <Checkbox
                              checked={isSel}
                              onCheckedChange={(v) => toggleSelect(o.id, !!v)}
                              className="mt-1"
                              aria-label="Select order for dispatch trip"
                            />
                            <div className="min-w-0">
                              <p className="font-medium text-primary truncate">{o.propertyName || propName(o.propertyId)}</p>
                              <p className="font-mono text-xs text-muted-foreground">{o.orderNumber}</p>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{o.brand}</Badge>
                            <StatusBadge status={o.status} />
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 text-sm border-y py-3">
                          <div>
                            <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Meal</p>
                            <p className="font-medium">{MEAL_LABEL[o.mealType]}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Residents</p>
                            <p className="font-medium">{o.residentsCount}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Total Qty</p>
                            <p className="font-medium">{totalQ(o)}</p>
                          </div>
                        </div>

                        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          {o.preparingAt
                            ? `Prepared ${format(new Date(o.preparingAt), "dd MMM, HH:mm")}`
                            : o.acceptedAt
                              ? `Accepted ${format(new Date(o.acceptedAt), "dd MMM, HH:mm")}`
                              : "Awaiting preparation"}
                        </p>

                        <div className="flex items-center gap-2 pt-1">
                          <Select
                            value={cardPartner[o.id] ?? ""}
                            onValueChange={(v) => setCardPartner((prev) => ({ ...prev, [o.id]: v }))}
                            disabled={!partnerListReady}
                          >
                            <SelectTrigger className="flex-1 h-9">
                              <SelectValue placeholder="Quick dispatch partner" />
                            </SelectTrigger>
                            <SelectContent>
                              {partners.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onDispatchOne(o)}
                            disabled={dispatchOne.isPending}
                          >
                            <Send className="w-4 h-4 mr-1.5" /> Send
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>

        {/* ── IN TRANSIT: DISPATCHED orders, read-only tracking ───────────── */}
        <TabsContent value="transit" className="mt-4">
          {loadingDispatched ? (
            <CardGridSkeleton />
          ) : dispatched.length === 0 ? (
            <LocalEmpty
              icon={Inbox}
              title="No orders in transit"
              hint="Once you dispatch an order it will show here with its delivery partner and dispatch time until delivery is confirmed."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {dispatched.map((o) => (
                <Card key={o.id} className="overflow-hidden">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-primary truncate">{o.propertyName || propName(o.propertyId)}</p>
                        <p className="font-mono text-xs text-muted-foreground">{o.orderNumber}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{o.brand}</Badge>
                        <StatusBadge status={o.status} />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-sm border-y py-3">
                      <div>
                        <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Meal</p>
                        <p className="font-medium">{MEAL_LABEL[o.mealType]}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Residents</p>
                        <p className="font-medium">{o.residentsCount}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-[10px] uppercase tracking-wider">Total Qty</p>
                        <p className="font-medium">{totalQ(o)}</p>
                      </div>
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <p className="flex items-center gap-1.5 text-foreground">
                        <Truck className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="font-medium">{o.deliveryPartnerName || partnerName(o.deliveryPartnerId)}</span>
                      </p>
                      <p className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5" />
                        {o.dispatchedAt
                          ? `Dispatched ${format(new Date(o.dispatchedAt), "dd MMM, HH:mm")}`
                          : "Dispatch time unavailable"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── TRIPS: recent dispatch trips ─────────────────────────────────── */}
        <TabsContent value="trips" className="mt-4">
          {loadingTrips ? (
            <CardGridSkeleton />
          ) : trips.length === 0 ? (
            <LocalEmpty
              icon={Route}
              title="No dispatch trips yet"
              hint="Bundle prepared orders from the Dispatch Queue into a trip with a van and driver. Active and past trips will appear here."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {trips.map((t) => (
                <TripCard
                  key={t.id}
                  trip={t}
                  onOpen={() => setOpenTripId(t.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Sticky action bar: create trip + bulk quick dispatch ──────────── */}
      {tab === "queue" && selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 w-[min(760px,calc(100%-2rem))]">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card shadow-lg px-4 py-3">
            <div className="flex items-center gap-2 shrink-0">
              <Boxes className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium">{selected.size} selected</span>
            </div>
            <Button
              className="bg-accent hover:bg-accent/90 text-white shrink-0"
              onClick={() => setTripOpen(true)}
            >
              <Route className="w-4 h-4 mr-2" /> Create dispatch trip ({selected.size})
            </Button>
            <div className="flex items-center gap-2 flex-1 min-w-[220px]">
              <Select value={bulkPartner} onValueChange={setBulkPartner} disabled={!partnerListReady}>
                <SelectTrigger className="flex-1 h-9">
                  <SelectValue placeholder="Quick dispatch partner" />
                </SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={onBulkDispatch}
                disabled={dispatchBulk.isPending}
              >
                <Send className="w-4 h-4 mr-2" /> Quick send
              </Button>
            </div>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Create trip drawer (bottom sheet) ─────────────────────────────── */}
      <Drawer open={tripOpen} onOpenChange={setTripOpen}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-2xl">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                <Route className="w-5 h-5 text-accent" /> New dispatch trip
              </DrawerTitle>
              <DrawerDescription>
                Bundling {selected.size} order{selected.size === 1 ? "" : "s"} onto one van.
              </DrawerDescription>
            </DrawerHeader>

            <div className="px-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <ChefHat className="w-3.5 h-3.5 text-muted-foreground" /> Kitchen
                </Label>
                <Select
                  value={tripForm.kitchenId}
                  onValueChange={(v) => setTripForm((f) => ({ ...f, kitchenId: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select kitchen (optional)" /></SelectTrigger>
                  <SelectContent>
                    {kitchens.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No kitchens configured</div>
                    ) : (
                      kitchens.map((k) => (
                        <SelectItem key={k.id} value={k.id}>{k.name} ({k.code})</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5 text-muted-foreground" /> Delivery partner
                </Label>
                <Select
                  value={tripForm.deliveryPartnerId}
                  onValueChange={(v) => setTripForm((f) => ({ ...f, deliveryPartnerId: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select partner" /></SelectTrigger>
                  <SelectContent>
                    {partners.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No partners available</div>
                    ) : (
                      partners.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-muted-foreground" /> Vehicle number
                </Label>
                <Input
                  placeholder="e.g. DL 1A 2345"
                  value={tripForm.vehicleNumber}
                  onChange={(e) => setTripForm((f) => ({ ...f, vehicleNumber: e.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Timer className="w-3.5 h-3.5 text-muted-foreground" /> ETA (minutes)
                </Label>
                <Input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="e.g. 30"
                  value={tripForm.etaMinutes}
                  onChange={(e) => setTripForm((f) => ({ ...f, etaMinutes: e.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-muted-foreground" /> Driver name
                </Label>
                <Input
                  placeholder="Driver name"
                  value={tripForm.driverName}
                  onChange={(e) => setTripForm((f) => ({ ...f, driverName: e.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-muted-foreground" /> Driver mobile
                </Label>
                <Input
                  type="tel"
                  inputMode="tel"
                  placeholder="Driver mobile"
                  value={tripForm.driverPhone}
                  onChange={(e) => setTripForm((f) => ({ ...f, driverPhone: e.target.value }))}
                />
              </div>
            </div>

            <DrawerFooter className="flex-row justify-end gap-2">
              <DrawerClose asChild>
                <Button variant="outline">Cancel</Button>
              </DrawerClose>
              <Button
                className="bg-accent hover:bg-accent/90 text-white"
                onClick={onCreateTrip}
                disabled={createTrip.isPending}
              >
                <Route className="w-4 h-4 mr-2" />
                {createTrip.isPending ? "Creating…" : `Create trip (${selected.size})`}
              </Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>

      {/* ── Trip detail sheet (side) ──────────────────────────────────────── */}
      <TripDetailSheet
        tripId={openTripId}
        onClose={() => setOpenTripId(null)}
        propName={propName}
        partnerName={partnerName}
        onUpdateStatus={(id, status) => updateTripStatus.mutate({ id, status })}
        updating={updateTripStatus.isPending}
      />
    </div>
  );
}

/* ── Trip summary card ──────────────────────────────────────────────────── */
function TripCard({ trip, onOpen }: { trip: Dispatch; onOpen: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="overflow-hidden cursor-pointer transition-colors hover:border-accent/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-sm font-medium text-primary truncate">{trip.dispatchNumber}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <Boxes className="w-3.5 h-3.5" />
              {trip.orderCount ?? 0} order{(trip.orderCount ?? 0) === 1 ? "" : "s"}
            </p>
          </div>
          <DispatchStatusBadge status={trip.status} />
        </div>

        <Separator />

        <div className="space-y-1.5 text-xs">
          <p className="flex items-center gap-1.5 text-foreground">
            <ChefHat className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{trip.kitchenName || "Kitchen unassigned"}</span>
          </p>
          <p className="flex items-center gap-1.5 text-foreground">
            <Truck className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{trip.partnerName || "Partner unassigned"}</span>
            {trip.vehicleNumber && (
              <span className="font-mono text-muted-foreground">· {trip.vehicleNumber}</span>
            )}
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <User className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{trip.driverName || "Driver unassigned"}</span>
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Timer className="w-3.5 h-3.5 shrink-0" />
            {trip.estimatedArrivalAt
              ? `ETA ${format(new Date(trip.estimatedArrivalAt), "dd MMM, HH:mm")}`
              : "ETA not set"}
          </p>
        </div>

        <div className="flex items-center justify-end text-xs text-accent font-medium pt-1">
          View trip <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Trip detail sheet (loads full dispatch) ────────────────────────────── */
function TripDetailSheet({
  tripId, onClose, propName, partnerName, onUpdateStatus, updating,
}: {
  tripId: string | null;
  onClose: () => void;
  propName: (id?: string | null) => string;
  partnerName: (id?: string | null) => string;
  onUpdateStatus: (id: string, status: DispatchStatus) => void;
  updating: boolean;
}) {
  const { data: detail, isLoading } = useQuery({
    queryKey: foodKeys.dispatch(tripId ?? ""),
    queryFn: () => foodApi.getDispatch(tripId as string),
    enabled: !!tripId,
  });

  return (
    <Sheet open={!!tripId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
        <SheetHeader className="p-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2 font-mono">
            <Route className="w-5 h-5 text-accent" />
            {detail?.dispatchNumber ?? "Dispatch trip"}
          </SheetTitle>
          <SheetDescription>
            {detail ? (
              <span className="flex items-center gap-2">
                <DispatchStatusBadge status={detail.status} />
                <span>{detail.orders?.length ?? detail.orderCount ?? 0} orders on this trip</span>
              </span>
            ) : (
              "Loading trip details"
            )}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {isLoading || !detail ? (
              <div className="space-y-4">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
              <>
                {/* Trip header: van / driver / kitchen / ETA */}
                <div className="grid grid-cols-2 gap-4">
                  <InfoTile icon={ChefHat} label="Kitchen" value={detail.kitchen?.name || detail.kitchenName || "Unassigned"} />
                  <InfoTile icon={Truck} label="Partner" value={detail.partnerName || partnerName(detail.deliveryPartnerId)} />
                  <InfoTile icon={Hash} label="Vehicle" value={detail.vehicleNumber || "—"} mono />
                  <InfoTile icon={Timer} label="ETA" value={detail.estimatedArrivalAt ? format(new Date(detail.estimatedArrivalAt), "dd MMM, HH:mm") : "Not set"} />
                  <InfoTile icon={User} label="Driver" value={detail.driverName || "—"} />
                  <InfoTile icon={Phone} label="Driver mobile" value={detail.driverPhone || "—"} mono />
                </div>

                {detail.dispatchedAt && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Send className="w-3.5 h-3.5" />
                    Dispatched {format(new Date(detail.dispatchedAt), "dd MMM yyyy, HH:mm")}
                  </p>
                )}

                {/* Status updater */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Update trip status</Label>
                  <Select
                    value={detail.status}
                    onValueChange={(v) => onUpdateStatus(detail.id, v as DispatchStatus)}
                    disabled={updating}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DISPATCH_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{DISPATCH_STATUS_META[s].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                {/* Orders on this trip */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium flex items-center gap-1.5">
                      <Boxes className="w-4 h-4 text-muted-foreground" /> Orders on this trip
                    </h4>
                    <Badge variant="secondary">{detail.orders?.length ?? 0}</Badge>
                  </div>
                  {!detail.orders || detail.orders.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No orders attached to this trip.</p>
                  ) : (
                    <div className="rounded-lg border overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Order</TableHead>
                            <TableHead>Property</TableHead>
                            <TableHead>Meal</TableHead>
                            <TableHead className="text-right">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.orders.map((o) => (
                            <TableRow key={o.id}>
                              <TableCell className="font-mono text-xs">{o.orderNumber}</TableCell>
                              <TableCell className="text-sm">{o.propertyName || propName(o.propertyId)}</TableCell>
                              <TableCell className="text-sm">{MEAL_LABEL[o.mealType]}</TableCell>
                              <TableCell className="text-right"><StatusBadge status={o.status} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function InfoTile({ icon: Icon, label, value, mono }: { icon: React.ElementType; label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-surface p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </p>
      <p className={`text-sm font-medium mt-0.5 truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</p>
    </div>
  );
}

function LocalEmpty({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center border border-dashed rounded-lg py-16 px-6 bg-card">
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-muted-foreground" />
      </div>
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">{hint}</p>
    </div>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-4 w-40" />
            <div className="flex gap-2">
              <Skeleton className="h-9 flex-1" />
              <Skeleton className="h-9 w-24" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
