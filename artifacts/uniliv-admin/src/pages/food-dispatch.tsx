import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Truck, Package, Clock, Users, Boxes, MapPin, CheckCircle2, Send, Inbox, X,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, fmtQty,
  type FoodOrder, type FoodBrand, type MealType,
} from "@/lib/food-api";

const ALL = "ALL";

export default function FoodDispatch() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [tab, setTab] = React.useState<"queue" | "transit">("queue");
  const [propertyId, setPropertyId] = React.useState(ALL);
  const [brand, setBrand] = React.useState<FoodBrand | typeof ALL>(ALL);
  const [meal, setMeal] = React.useState<MealType | typeof ALL>(ALL);
  const [date, setDate] = React.useState("");

  // Per-card chosen partner (preparing tab) and bulk selection
  const [cardPartner, setCardPartner] = React.useState<Record<string, string>>({});
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkPartner, setBulkPartner] = React.useState("");

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

  // ── Shared filter params ──────────────────────────────────────────────────
  const filterParams: Record<string, unknown> = {
    propertyId: propertyId === ALL ? undefined : propertyId,
    brand: brand === ALL ? undefined : brand,
    mealType: meal === ALL ? undefined : meal,
    serviceDate: date || undefined,
  };

  const preparingParams = { ...filterParams, status: "PREPARING", limit: 100 };
  const dispatchedParams = { ...filterParams, status: "DISPATCHED", limit: 100 };

  const { data: preparingRes, isLoading: loadingPreparing } = useQuery({
    queryKey: foodKeys.orders(preparingParams),
    queryFn: () => foodApi.listOrders(preparingParams),
  });
  const preparing = preparingRes?.data ?? [];

  const { data: dispatchedRes, isLoading: loadingDispatched } = useQuery({
    queryKey: foodKeys.orders(dispatchedParams),
    queryFn: () => foodApi.listOrders(dispatchedParams),
  });
  const dispatched = dispatchedRes?.data ?? [];

  // Prune stale selection when the queue changes
  React.useEffect(() => {
    const ids = new Set(preparing.map((o) => o.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [preparing]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "orders"] });
    qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
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

  const toggleSelect = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (checked) n.add(id); else n.delete(id);
      return n;
    });

  const totalQ = (o: FoodOrder) => fmtQty(o.totalQuantity);
  const partnerListReady = partners.length > 0;

  // ── Stats ─────────────────────────────────────────────────────────────────
  const awaiting = preparing.length;
  const inTransit = dispatched.length;
  const residentsWaiting = preparing.reduce((s, o) => s + (o.residentsCount || 0), 0);
  const propertiesTouched = new Set(preparing.map((o) => o.propertyId)).size;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch"
        subtitle="Assign delivery partners and move prepared meals out the door"
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
        <StatCard title="Properties Affected" value={propertiesTouched} icon={MapPin} />
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

      <Tabs value={tab} onValueChange={(v) => setTab(v as "queue" | "transit")}>
        <TabsList>
          <TabsTrigger value="queue">
            Dispatch Queue
            {awaiting > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{awaiting}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="transit">
            In Transit
            {inTransit > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{inTransit}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ── QUEUE: PREPARING orders as actionable cards ─────────────────── */}
        <TabsContent value="queue" className="mt-4">
          {loadingPreparing ? (
            <CardGridSkeleton />
          ) : preparing.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing waiting to dispatch"
              hint="Prepared orders ready for dispatch will appear here. Adjust the filters above to widen the view."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pb-24">
              {preparing.map((o) => {
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
                            aria-label="Select order for bulk dispatch"
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
                          : "Awaiting preparation timestamp"}
                      </p>

                      <div className="flex items-center gap-2 pt-1">
                        <Select
                          value={cardPartner[o.id] ?? ""}
                          onValueChange={(v) => setCardPartner((prev) => ({ ...prev, [o.id]: v }))}
                          disabled={!partnerListReady}
                        >
                          <SelectTrigger className="flex-1 h-9">
                            <SelectValue placeholder="Delivery partner" />
                          </SelectTrigger>
                          <SelectContent>
                            {partners.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          className="bg-accent hover:bg-accent/90 text-white"
                          onClick={() => onDispatchOne(o)}
                          disabled={dispatchOne.isPending}
                        >
                          <Send className="w-4 h-4 mr-1.5" /> Dispatch
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── IN TRANSIT: DISPATCHED orders, read-only tracking ───────────── */}
        <TabsContent value="transit" className="mt-4">
          {loadingDispatched ? (
            <CardGridSkeleton />
          ) : dispatched.length === 0 ? (
            <EmptyState
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
                        <span className="font-medium">{partnerName(o.deliveryPartnerId)}</span>
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
      </Tabs>

      {/* ── Sticky bulk-dispatch toolbar (queue tab only) ─────────────────── */}
      {tab === "queue" && selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 w-[min(640px,calc(100%-2rem))]">
          <div className="flex items-center gap-3 rounded-lg border bg-card shadow-lg px-4 py-3">
            <div className="flex items-center gap-2 shrink-0">
              <Boxes className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium">{selected.size} selected</span>
            </div>
            <Select value={bulkPartner} onValueChange={setBulkPartner} disabled={!partnerListReady}>
              <SelectTrigger className="flex-1 h-9">
                <SelectValue placeholder="Shared delivery partner" />
              </SelectTrigger>
              <SelectContent>
                {partners.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
              </SelectContent>
            </Select>
            <Button
              className="bg-accent hover:bg-accent/90 text-white shrink-0"
              onClick={onBulkDispatch}
              disabled={dispatchBulk.isPending}
            >
              <Send className="w-4 h-4 mr-2" /> Dispatch Selected
            </Button>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint: string }) {
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
