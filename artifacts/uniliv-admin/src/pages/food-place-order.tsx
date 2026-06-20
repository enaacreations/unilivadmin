import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import jsPDF from "jspdf";
import {
  UtensilsCrossed, ChefHat, Loader2, Building2, CalendarDays, Users,
  Check, ChevronsUpDown, Clock, Lock, Download, Share2, Mail, MessageCircle,
  Link2, Copy, Soup, Info, Tag, AlertTriangle, Pencil, RotateCcw, Zap,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberStepper } from "@/components/ui/number-stepper";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Calendar } from "@/components/ui/calendar";
import {
  Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  foodApi, foodKeys, MEAL_LABEL, fmtQty,
  type Cutoff, type OrderPreview, type PropertyOverview,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { useQueryParam } from "@/lib/nav-helpers";
import { cn } from "@/lib/utils";

type ShareChannel = "EMAIL" | "WHATSAPP" | "LINK";
type ShareRecipientType = "GUESTS" | "CUSTOM";

/** Per-item override, keyed `${mealType}__${dishId}`. Anything unset is DERIVED
 *  from the meal's persons (or the global headcount), so changing headcount
 *  recomputes every quantity instantly — no refetch, no state reset. */
type Override = { excluded?: boolean; persons?: number; qty?: number };

const todayDate = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const itemKey = (mealType: string, dishId: string) => `${mealType}__${dishId}`;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export default function FoodPlaceOrder() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { propertyId: storePropertyId } = useAppStore();
  const { can } = usePermissions();
  const canPlace = can("FOOD_PLACE_ORDER", "create");

  const [propertyId, setPropertyId] = React.useState<string>("");
  const [propertyOpen, setPropertyOpen] = React.useState(false);
  const [date, setDate] = React.useState<Date>(todayDate());
  const [dateOpen, setDateOpen] = React.useState(false);

  // The single lever: how many people we're serving. Drives every quantity.
  const [persons, setPersons] = React.useState<number>(1);
  // Per-meal headcount override (absent = inherit the global headcount).
  const [mealPersons, setMealPersons] = React.useState<Record<string, number>>({});
  // Per-item overrides (exclude / custom persons / custom qty).
  const [overrides, setOverrides] = React.useState<Record<string, Override>>({});
  const [activeMeal, setActiveMeal] = React.useState<string>("");

  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareChannel, setShareChannel] = React.useState<ShareChannel>("EMAIL");
  const [shareRecipientType, setShareRecipientType] = React.useState<ShareRecipientType>("GUESTS");
  const [shareLink, setShareLink] = React.useState<string | null>(null);

  const dateStr = format(date, "yyyy-MM-dd");
  const dateLabel = format(date, "EEE, dd MMM yyyy");

  // ── Lookups (properties carry inherited brand + kitchen) ──
  const { data: lookups, isLoading: lookupsLoading } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];

  const paramProperty = useQueryParam("propertyId");
  React.useEffect(() => {
    if (propertyId) return;
    const valid = (id?: string | null) => !!id && properties.some((p) => p.id === id);
    const wanted = valid(paramProperty) ? paramProperty! : valid(storePropertyId) ? storePropertyId! : (properties[0]?.id ?? "");
    if (wanted) setPropertyId(wanted);
  }, [properties, storePropertyId, paramProperty, propertyId]);

  const selectedProperty = properties.find((p) => p.id === propertyId);
  const brand = selectedProperty?.brand ?? null;
  const configured = Boolean(selectedProperty?.brand && selectedProperty?.kitchenId);

  // Seed headcount from the property's active-guest count.
  const { data: overview } = useQuery<PropertyOverview | null>({
    queryKey: foodKeys.propertyOverview({ propertyId }),
    queryFn: () => foodApi.propertyOverview({ propertyId }),
    enabled: !!propertyId,
  });
  React.useEffect(() => {
    if (overview && overview.activeGuests > 0) setPersons(overview.activeGuests);
  }, [overview?.id]);

  // ── Cut-offs ──
  const { data: cutoffsRaw } = useQuery({
    queryKey: foodKeys.cutoffs({ brand, propertyId, date: dateStr }),
    queryFn: () => foodApi.cutoffs({ brand: brand!, propertyId, date: dateStr }),
    enabled: !!propertyId && !!brand,
  });
  const cutoffByMeal = React.useMemo(() => {
    const map: Record<string, Cutoff> = {};
    (cutoffsRaw ?? []).forEach((c) => { map[c.mealType] = c; });
    return map;
  }, [cutoffsRaw]);

  // ── Menu / per-resident rates (fetched ONCE per property+date — persons is
  //    NOT in the key, so changing headcount never refetches). We only need
  //    each dish's qtyPerResident; quantities are computed client-side. ──
  const { data: preview, isLoading: previewLoading } = useQuery<OrderPreview>({
    queryKey: foodKeys.orderPreview({ propertyId, date: dateStr }),
    queryFn: () => foodApi.orderPreview({ propertyId, serviceDate: dateStr, persons: 1 }),
    enabled: !!propertyId && configured,
  });

  // Reset overrides + active meal when a fresh menu arrives (property/date change).
  React.useEffect(() => {
    if (!preview?.meals) return;
    setOverrides({});
    setMealPersons({});
    const firstOpen = preview.meals.find((m) => !cutoffByMeal[m.mealType]?.isPastCutoff) ?? preview.meals[0];
    setActiveMeal(firstOpen?.mealType ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // ── Live full-day menu (for download / share) ──
  const { data: fullMenu, isLoading: menuLoading } = useQuery({
    queryKey: foodKeys.fullMenu({ propertyId, date: dateStr }),
    queryFn: () => foodApi.fullMenu({ propertyId, date: dateStr }),
    enabled: !!propertyId && configured,
  });

  const isClosed = (mt: string) => !!cutoffByMeal[mt]?.isPastCutoff;

  /** Derived effective state for one dish — the heart of the reactive model. */
  const effFor = React.useCallback((mt: string, dishId: string, qtyPerResident: number) => {
    const ov = overrides[itemKey(mt, dishId)];
    const closed = isClosed(mt);
    const included = !closed && !(ov?.excluded ?? false);
    const p = ov?.persons ?? mealPersons[mt] ?? persons;
    const qty = ov?.qty ?? round3(p * qtyPerResident);
    const edited = ov?.persons != null || ov?.qty != null;
    return { included, persons: p, qty, edited, closed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, mealPersons, persons, cutoffByMeal]);

  // ── Derived order ──
  const selection = React.useMemo(() => {
    const meals = (preview?.meals ?? []).map((meal) => {
      const items = meal.items
        .map((it) => ({ it, e: effFor(meal.mealType, it.dishId, it.qtyPerResident) }))
        .filter(({ e }) => e.included && e.qty > 0)
        .map(({ it, e }) => ({ dishId: it.dishId, dishName: it.dishName, personsCount: e.persons, orderedQty: e.qty, unit: it.unit }));
      return { mealType: meal.mealType, label: meal.label, items };
    }).filter((m) => m.items.length > 0);
    const itemCount = meals.reduce((s, m) => s + m.items.length, 0);
    const countByMeal: Record<string, number> = {};
    meals.forEach((m) => { countByMeal[m.mealType] = m.items.length; });
    return { meals, itemCount, mealCount: meals.length, countByMeal };
  }, [preview, effFor]);

  // ── Override mutators ──
  const patchOverride = (key: string, patch: Override) =>
    setOverrides((p) => ({ ...p, [key]: { ...p[key], ...patch } }));
  const setExcluded = (mt: string, dishId: string, excluded: boolean) =>
    patchOverride(itemKey(mt, dishId), { excluded });
  const resetItem = (mt: string, dishId: string) =>
    setOverrides((p) => { const n = { ...p }; const cur = { ...n[itemKey(mt, dishId)] }; delete cur.persons; delete cur.qty; n[itemKey(mt, dishId)] = cur; return n; });
  const toggleAll = (mt: string, dishIds: string[], include: boolean) =>
    setOverrides((p) => { const n = { ...p }; dishIds.forEach((d) => { n[itemKey(mt, d)] = { ...n[itemKey(mt, d)], excluded: !include }; }); return n; });

  // ── Place order ──
  const placeMutation = useMutation({
    mutationFn: () => foodApi.placeOrderBatch({
      propertyId, serviceDate: dateStr, persons,
      meals: selection.meals.map((m) => ({ mealType: m.mealType, items: m.items.map(({ dishId, personsCount, orderedQty, unit }) => ({ dishId, personsCount, orderedQty, unit })) })),
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["food"] });
      const n = res?.orders?.length ?? selection.mealCount;
      toast({ title: `${n} order${n === 1 ? "" : "s"} placed`, description: `${selectedProperty?.name ?? "Property"} • ${brand} • ${dateLabel}` });
      navigate("/food/orders");
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to place order", variant: "destructive" }),
  });

  const handlePlace = () => {
    if (!propertyId) { toast({ title: "Select a property first", variant: "destructive" }); return; }
    if (!configured) { toast({ title: "Property not configured for ordering", variant: "destructive" }); return; }
    if (selection.mealCount === 0) { toast({ title: "Add at least one item", description: "Include an item with quantity greater than 0.", variant: "destructive" }); return; }
    placeMutation.mutate();
  };

  // ── Share ──
  const shareMutation = useMutation({
    mutationFn: () => foodApi.shareMenu({ propertyId, brand, date: dateStr, channel: shareChannel, recipientType: shareRecipientType }),
    onSuccess: (res: any) => {
      if (shareChannel === "LINK" && res?.shareToken) { setShareLink(`${window.location.origin}/m/${res.shareToken}`); toast({ title: "Share link ready" }); }
      else { setShareLink(null); const count = res?.recipientCount ?? 0; toast({ title: shareRecipientType === "GUESTS" ? `Menu shared with ${count} guest${count === 1 ? "" : "s"}` : "Menu shared" }); setShareOpen(false); }
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to share menu", variant: "destructive" }),
  });

  const downloadMenuPdf = () => {
    try {
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const marginX = 48; let y = 64;
      doc.setFont("helvetica", "bold"); doc.setFontSize(20);
      doc.text(`${brand ?? "Menu"}`, marginX, y); y += 22;
      doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(110);
      doc.text(dateLabel, marginX, y);
      if (selectedProperty?.name) doc.text(selectedProperty.name, pageW - marginX, y, { align: "right" });
      doc.setTextColor(0); y += 14; doc.setDrawColor(220); doc.line(marginX, y, pageW - marginX, y); y += 26;
      const ms = fullMenu?.meals ?? [];
      if (ms.length === 0) { doc.setFont("helvetica", "italic"); doc.setFontSize(11); doc.text("No menu configured for this day.", marginX, y); }
      ms.forEach((meal) => {
        if (y > 760) { doc.addPage(); y = 64; }
        doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.text(meal.label || MEAL_LABEL[meal.mealType], marginX, y); y += 18;
        doc.setFont("helvetica", "normal"); doc.setFontSize(11);
        if (meal.dishes.length === 0) { doc.setTextColor(150); doc.text("— No dishes —", marginX + 8, y); doc.setTextColor(0); y += 16; }
        else meal.dishes.slice().sort((a, b) => a.sortOrder - b.sortOrder).forEach((d) => {
          if (y > 780) { doc.addPage(); y = 64; }
          const slot = d.slotLabel ? `  (${d.slotLabel})` : "";
          doc.text(`•  ${d.dishName}`, marginX + 8, y);
          doc.setTextColor(140); doc.text(`${slot ? slot.trim() + " · " : ""}${d.unit.toLowerCase()}`, pageW - marginX, y, { align: "right" }); doc.setTextColor(0); y += 16;
        });
        y += 14;
      });
      doc.save(`uniliv-menu-${dateStr}.pdf`);
      toast({ title: "Menu downloaded" });
    } catch (e: any) { toast({ title: e?.message || "Couldn't generate PDF", variant: "destructive" }); }
  };

  const copyShareLink = async () => {
    if (!shareLink) return;
    try { await navigator.clipboard.writeText(shareLink); toast({ title: "Link copied" }); }
    catch { toast({ title: "Couldn't copy link", variant: "destructive" }); }
  };

  const saving = placeMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Place Order"
        subtitle="Set the headcount once — quantities are calculated for every dish."
        breadcrumbs={[{ label: "Food", href: "/food/orders" }, { label: "Place Order" }]}
        action={
          <Button onClick={handlePlace} disabled={saving || !canPlace || selection.mealCount === 0} size="lg">
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UtensilsCrossed className="mr-2 h-4 w-4" />}
            Place order
            {selection.itemCount > 0 && <Badge variant="secondary" className="ml-2 bg-white/20 text-white border-0">{selection.itemCount}</Badge>}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ── Left: builder ── */}
        <div className="lg:col-span-7 space-y-5">
          {/* Service context — compact */}
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">Property</Label>
                  <Popover open={propertyOpen} onOpenChange={setPropertyOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" role="combobox" aria-expanded={propertyOpen} className="w-full justify-between font-normal" disabled={lookupsLoading}>
                        <span className="flex items-center gap-2 truncate">
                          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate">{selectedProperty?.name ?? (lookupsLoading ? "Loading…" : "Select property")}</span>
                          {brand && <Badge variant="secondary" className="ml-1 gap-1 text-[10px] shrink-0"><Tag className="h-2.5 w-2.5" />{brand}</Badge>}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
                      <Command>
                        <CommandInput placeholder="Search properties…" />
                        <CommandList>
                          <CommandEmpty>No property found.</CommandEmpty>
                          <CommandGroup>
                            {properties.map((p) => (
                              <CommandItem key={p.id} value={p.name} onSelect={() => { setPropertyId(p.id); setPropertyOpen(false); }}>
                                <Check className={cn("mr-2 h-4 w-4", propertyId === p.id ? "opacity-100" : "opacity-0")} />
                                <span className="flex-1">{p.name}</span>
                                {p.brand && <Badge variant="outline" className="ml-2 text-[10px]">{p.brand}</Badge>}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Service date</Label>
                  <Popover open={dateOpen} onOpenChange={setDateOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-start font-normal sm:w-[180px]">
                        <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground" />{dateLabel}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-auto" align="end">
                      <Calendar mode="single" selected={date} onSelect={(d) => { if (d) { const nd = new Date(d); nd.setHours(0, 0, 0, 0); setDate(nd); } setDateOpen(false); }} initialFocus />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Hero headcount — the single lever */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center gap-2.5">
                  <Users className="h-5 w-5 text-accent" />
                  <span className="text-sm font-medium">Serving</span>
                  <NumberStepper value={persons} onChange={setPersons} min={0} aria-label="People being served" className="w-auto" />
                  <span className="text-sm text-muted-foreground">people</span>
                </div>
                {overview && overview.activeGuests > 0 && (
                  <button type="button" onClick={() => setPersons(overview.activeGuests)}
                    className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                      persons === overview.activeGuests ? "bg-success/12 text-success" : "bg-muted text-muted-foreground hover:bg-muted/70")}>
                    <Users className="h-3 w-3" /> {overview.activeGuests} active guests
                  </button>
                )}
                <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Zap className="h-3.5 w-3.5 text-accent" /> quantities update live
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Per-meal builder */}
          {!configured ? (
            <Card><CardContent className="py-10">
              <EmptyState icon={AlertTriangle} title="Property not configured" description="This property has no brand or kitchen assigned, so it can't take orders. Ask an admin to configure it in the Organization console." />
            </CardContent></Card>
          ) : previewLoading ? (
            <Card><CardContent className="space-y-3 py-6">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
            </CardContent></Card>
          ) : !preview || preview.meals.length === 0 ? (
            <Card><CardContent className="py-10">
              <EmptyState icon={Soup} title="No menu for this day" description="Nothing is configured for this property's kitchen and brand on the selected date." />
            </CardContent></Card>
          ) : (
            <Tabs value={activeMeal} onValueChange={setActiveMeal} className="space-y-3">
              <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {preview.meals.map((meal) => {
                  const closed = isClosed(meal.mealType);
                  const count = selection.countByMeal[meal.mealType] ?? 0;
                  return (
                    <TabsTrigger key={meal.mealType} value={meal.mealType}
                      className="shrink-0 gap-2 rounded-lg border border-transparent px-3 py-2 data-[state=active]:border-border data-[state=active]:bg-card">
                      {closed ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : <Soup className="h-3.5 w-3.5 text-accent" />}
                      <span className="font-medium">{meal.label}</span>
                      {closed ? (
                        <span className="text-[10px] uppercase text-muted-foreground">closed</span>
                      ) : (
                        <Badge variant={count > 0 ? "default" : "secondary"} className="h-5 min-w-5 justify-center px-1.5 text-[10px]">{count}</Badge>
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {preview.meals.map((meal) => {
                const closed = isClosed(meal.mealType);
                const cutoff = cutoffByMeal[meal.mealType];
                const dishIds = meal.items.map((i) => i.dishId);
                const allIncluded = !closed && dishIds.every((d) => !(overrides[itemKey(meal.mealType, d)]?.excluded));
                const mealHead = mealPersons[meal.mealType];
                return (
                  <TabsContent key={meal.mealType} value={meal.mealType} className="mt-0">
                    <Card>
                      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 py-3">
                        {closed ? (
                          <Badge variant="destructive" className="gap-1"><Lock className="h-3 w-3" /> Cut-off passed</Badge>
                        ) : (
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <Checkbox checked={allIncluded} onCheckedChange={(v) => toggleAll(meal.mealType, dishIds, !!v)} aria-label={`Include all ${meal.label}`} />
                            <span className="text-muted-foreground">Select all · {meal.items.length} dishes</span>
                          </label>
                        )}
                        {!closed && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{meal.label} persons</span>
                            <NumberStepper value={mealHead ?? persons} min={0}
                              onChange={(n) => setMealPersons((p) => ({ ...p, [meal.mealType]: n }))}
                              aria-label={`${meal.label} persons`} className="w-auto" />
                            {mealHead != null && mealHead !== persons && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label="Reset meal persons"
                                onClick={() => setMealPersons((p) => { const n = { ...p }; delete n[meal.mealType]; return n; })}>
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        )}
                      </CardHeader>
                      {cutoff?.cutoffTime && !closed && (
                        <div className="px-4 pb-2 text-xs text-muted-foreground flex items-center gap-1.5">
                          <Clock className="h-3 w-3" /> Order before cut-off {cutoff.cutoffTime}
                        </div>
                      )}
                      <Separator />
                      <CardContent className="p-0">
                        <BoundedScroll size="lg">
                          <ul className="divide-y">
                            {meal.items.map((it) => {
                              const e = effFor(meal.mealType, it.dishId, it.qtyPerResident);
                              return (
                                <li key={it.dishId} className={cn("flex items-center gap-3 px-4 py-2.5", !e.included && "opacity-50")}>
                                  <Checkbox checked={e.included} disabled={closed}
                                    onCheckedChange={(v) => setExcluded(meal.mealType, it.dishId, !v)}
                                    aria-label={`Include ${it.dishName}`} />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <p className="truncate text-sm font-medium">{it.dishName}</p>
                                      {e.edited && <Badge variant="default" className="text-[9px] px-1.5 py-0">edited</Badge>}
                                    </div>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {it.slotLabel ? `${it.slotLabel} · ` : ""}
                                      {e.edited ? `${e.persons} persons` : `${fmtQty(it.qtyPerResident, it.unit)}/person`}
                                    </p>
                                  </div>
                                  <div className="shrink-0 text-right tabular-nums">
                                    <span className={cn("text-sm font-semibold", !e.included && "text-muted-foreground")}>
                                      {e.included ? fmtQty(e.qty, it.unit) : "—"}
                                    </span>
                                  </div>
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <Button variant="ghost" size="icon" disabled={closed || !e.included}
                                        className={cn("h-8 w-8 shrink-0", e.edited ? "text-accent" : "text-muted-foreground")}
                                        aria-label={`Customise ${it.dishName}`}>
                                        <Pencil className="h-3.5 w-3.5" />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent align="end" className="w-64 space-y-3">
                                      <div>
                                        <p className="text-sm font-medium">{it.dishName}</p>
                                        <p className="text-xs text-muted-foreground">{fmtQty(it.qtyPerResident, it.unit)} per person</p>
                                      </div>
                                      <div className="flex items-center justify-between gap-2">
                                        <Label className="text-xs">Persons</Label>
                                        <NumberStepper value={e.persons} min={0} className="w-auto"
                                          onChange={(n) => patchOverride(itemKey(meal.mealType, it.dishId), { persons: n, qty: undefined })}
                                          aria-label="Override persons" />
                                      </div>
                                      <div className="flex items-center justify-between gap-2">
                                        <Label className="text-xs">Quantity ({it.unit.toLowerCase()})</Label>
                                        <NumberStepper value={e.qty} min={0} step={0.001} className="w-auto"
                                          onChange={(n) => patchOverride(itemKey(meal.mealType, it.dishId), { qty: n })}
                                          aria-label="Override quantity" />
                                      </div>
                                      {e.edited && (
                                        <Button variant="outline" size="sm" className="w-full"
                                          onClick={() => resetItem(meal.mealType, it.dishId)}>
                                          <RotateCcw className="mr-2 h-3.5 w-3.5" /> Reset to calculated
                                        </Button>
                                      )}
                                    </PopoverContent>
                                  </Popover>
                                </li>
                              );
                            })}
                          </ul>
                        </BoundedScroll>
                      </CardContent>
                    </Card>
                  </TabsContent>
                );
              })}
            </Tabs>
          )}
        </div>

        {/* ── Right: summary + share ── */}
        <div className="lg:col-span-5">
          <Card className="lg:sticky lg:top-6">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="font-display flex items-center gap-2 text-base"><ChefHat className="h-5 w-5 text-accent" /> Order summary</CardTitle>
                  <CardDescription className="mt-1 flex flex-wrap items-center gap-1.5">
                    {brand && <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{brand}</Badge>}
                    <span className="inline-flex items-center gap-1 text-xs"><Users className="h-3 w-3" /> {persons} people</span>
                    <span className="inline-flex items-center gap-1 text-xs"><CalendarDays className="h-3 w-3" /> {dateLabel}</span>
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" className="flex-1" onClick={downloadMenuPdf} disabled={menuLoading || !configured}><Download className="mr-2 h-4 w-4" /> Download</Button>
                <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => { setShareLink(null); setShareOpen(true); }} disabled={!propertyId || !configured}><Share2 className="mr-2 h-4 w-4" /> Share</Button>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="p-4">
              {selection.mealCount === 0 ? (
                <EmptyState icon={Info} title="Nothing selected" description="Set the headcount and include dishes to build the order." />
              ) : (
                <BoundedScroll size="md">
                  <div className="space-y-3 pr-1">
                    {selection.meals.map((m) => (
                      <div key={m.mealType} className="rounded-lg border">
                        <div className="border-b px-3 py-2 text-sm font-semibold font-display">{m.label ?? MEAL_LABEL[m.mealType as keyof typeof MEAL_LABEL] ?? m.mealType}</div>
                        <ul className="divide-y">
                          {m.items.map((it) => (
                            <li key={it.dishId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                              <span className="truncate">{it.dishName}</span>
                              <span className="shrink-0 text-muted-foreground tabular-nums">{fmtQty(it.orderedQty, it.unit)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </BoundedScroll>
              )}
            </CardContent>
            {selection.mealCount > 0 && (
              <>
                <Separator />
                <div className="flex items-center justify-between p-4">
                  <div className="text-sm">
                    <span className="text-muted-foreground">{selection.mealCount} meal{selection.mealCount === 1 ? "" : "s"} · </span>
                    <span className="font-semibold">{selection.itemCount} item{selection.itemCount === 1 ? "" : "s"}</span>
                  </div>
                  <Button onClick={handlePlace} disabled={saving || !canPlace}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UtensilsCrossed className="mr-2 h-4 w-4" />}
                    Place order
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      {/* ── Share drawer ── */}
      <Drawer open={shareOpen} onOpenChange={setShareOpen}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-lg">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2"><Share2 className="h-5 w-5 text-accent" /> Share menu</DrawerTitle>
              <DrawerDescription>{brand} • {dateLabel}{selectedProperty ? ` • ${selectedProperty.name}` : ""}</DrawerDescription>
            </DrawerHeader>
            <div className="px-4 space-y-6">
              <div className="space-y-2">
                <Label>Channel</Label>
                <RadioGroup value={shareChannel} onValueChange={(v) => setShareChannel(v as ShareChannel)} className="grid grid-cols-3 gap-2">
                  {[{ v: "EMAIL", label: "Email", icon: Mail }, { v: "WHATSAPP", label: "WhatsApp", icon: MessageCircle }, { v: "LINK", label: "Link", icon: Link2 }].map(({ v, label, icon: Icon }) => (
                    <Label key={v} htmlFor={`channel-${v}`} className={cn("flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-sm transition-colors", shareChannel === v ? "border-accent bg-accent/5 text-foreground" : "border-border text-muted-foreground hover:bg-muted/50")}>
                      <RadioGroupItem id={`channel-${v}`} value={v} className="sr-only" />
                      <Icon className="h-5 w-5" />{label}
                    </Label>
                  ))}
                </RadioGroup>
              </div>
              {shareChannel !== "LINK" && (
                <div className="space-y-2">
                  <Label>Recipients</Label>
                  <RadioGroup value={shareRecipientType} onValueChange={(v) => setShareRecipientType(v as ShareRecipientType)} className="grid grid-cols-2 gap-2">
                    {[{ v: "GUESTS", label: "All active guests" }, { v: "CUSTOM", label: "Custom" }].map(({ v, label }) => (
                      <Label key={v} htmlFor={`rcpt-${v}`} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm transition-colors", shareRecipientType === v ? "border-accent bg-accent/5 text-foreground" : "border-border text-muted-foreground hover:bg-muted/50")}>
                        <RadioGroupItem id={`rcpt-${v}`} value={v} />{label}
                      </Label>
                    ))}
                  </RadioGroup>
                </div>
              )}
              {shareChannel === "LINK" && shareLink && (
                <div className="space-y-2">
                  <Label>Shareable link</Label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={shareLink} className="font-mono text-xs" />
                    <Button type="button" variant="outline" size="icon" onClick={copyShareLink} aria-label="Copy link"><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
              )}
            </div>
            <DrawerFooter>
              <Button onClick={() => shareMutation.mutate()} disabled={shareMutation.isPending || !propertyId}>
                {shareMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {shareChannel === "LINK" ? "Generate link" : "Share menu"}
              </Button>
              <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
