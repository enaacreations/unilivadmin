import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import jsPDF from "jspdf";
import {
  UtensilsCrossed, ChefHat, Loader2, Building2, CalendarDays, Users,
  Check, ChevronsUpDown, Clock, Lock, Download, Share2, Link2, Copy,
  Soup, Info, Tag, AlertTriangle, Pencil, Zap, CheckCircle2, Truck, ArrowRight,
  Image as ImageIcon, FileText, Mail, ChevronDown,
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
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  foodApi, foodKeys, MEAL_LABEL, fmtQty,
  type Cutoff, type FoodOrder, type OrderBatch, type OrderPreview, type PropertyOverview,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { useQueryParam } from "@/lib/nav-helpers";
import { cn } from "@/lib/utils";

/** Per-item override, keyed `${mealType}__${dishId}`. Editing is disabled for now
 *  ("coming soon"), so every dish is always included and quantities auto-compute. */
type Override = { excluded?: boolean; persons?: number; qty?: number };

const todayDate = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const itemKey = (mealType: string, dishId: string) => `${mealType}__${dishId}`;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Live countdown to a deadline, formatted "Hh Mm Ss" (or "Mm Ss" under an hour). */
function useCountdown(deadline: Date | null): { text: string; passed: boolean } {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline?.getTime()]);
  if (!deadline) return { text: "", passed: false };
  const ms = deadline.getTime() - now;
  if (ms <= 0) return { text: "0s", passed: true };
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const text = h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
  return { text, passed: false };
}

export default function FoodPlaceOrder() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { propertyId: storePropertyId } = useAppStore();
  const { can, role } = usePermissions();
  const canPlace = can("FOOD_PLACE_ORDER", "create");
  // Download menu stays for Unit Lead + FnB roles (only on the success state).
  const canDownload = role === "UNIT_LEAD" || role === "SUPER_ADMIN" || (role ?? "").startsWith("FNB_");

  const [propertyId, setPropertyId] = React.useState<string>("");
  const [propertyOpen, setPropertyOpen] = React.useState(false);

  // Service date is ALWAYS tomorrow (today + 1) and read-only — no picker.
  const date = React.useMemo(() => addDays(todayDate(), 1), []);
  const dateStr = format(date, "yyyy-MM-dd");
  const dateLabel = format(date, "EEE, dd MMM yyyy");

  // The single lever: how many people we're serving. Drives every quantity.
  const [persons, setPersons] = React.useState<number>(1);

  // Per-item overrides retained for derivation, but editing is disabled.
  const [overrides] = React.useState<Record<string, Override>>({});
  const [activeMeal, setActiveMeal] = React.useState<string>("");

  // Success state (shown after a batch is placed).
  const [placed, setPlaced] = React.useState<{ batch: OrderBatch; orders: FoodOrder[] } | null>(null);

  // po4 — when an order already exists for tomorrow we lead with an "already placed"
  // panel instead of the builder. "Place another order" reveals the builder anyway.
  const [showBuilder, setShowBuilder] = React.useState(false);
  // Set once the user places in THIS session, so we never bounce them back to the
  // "already placed" panel after a successful batch.
  const [placedThisSession, setPlacedThisSession] = React.useState(false);

  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareLink, setShareLink] = React.useState<string | null>(null);

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

  // ── Cut-offs (day-before-anchored cutoffAt / isPastCutoff from the server) ──
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

  // Single cut-off applies to all meals. Derive the shared deadline for the banner.
  const cutoffAny = cutoffsRaw?.[0];
  const cutoffTime = cutoffAny?.cutoffTime ?? null;
  const cutoffDeadline = cutoffAny?.cutoffAt ? new Date(cutoffAny.cutoffAt) : null;
  const countdown = useCountdown(cutoffDeadline);
  // Closed once the server says the (day-before) cut-off passed, or the live countdown elapses.
  const orderingClosed = Boolean(cutoffAny?.isPastCutoff) || countdown.passed;

  // ── Menu / per-resident rates (fetched ONCE per property+date) ──
  const { data: preview, isLoading: previewLoading } = useQuery<OrderPreview>({
    queryKey: foodKeys.orderPreview({ propertyId, date: dateStr }),
    queryFn: () => foodApi.orderPreview({ propertyId, serviceDate: dateStr, persons: 1 }),
    enabled: !!propertyId && configured,
  });

  React.useEffect(() => {
    if (!preview?.meals) return;
    setActiveMeal(preview.meals[0]?.mealType ?? "");
  }, [preview]);

  // ── po4 — existing orders for this property + tomorrow's service date ──
  // An order is "already placed" if it is NOT CANCELLED and NOT REJECTED.
  const { data: existingRes } = useQuery({
    queryKey: foodKeys.orders({ propertyId, serviceDate: dateStr, scope: "place-order" }),
    queryFn: () => foodApi.listOrders({
      propertyId, serviceDate: dateStr,
      status: "PLACED,PREPARING,DISPATCHED,DELIVERED",
    }),
    enabled: !!propertyId,
  });
  const existingOrders = existingRes?.data ?? [];
  const hasExistingOrders = existingOrders.length > 0;

  // Switching property re-evaluates from scratch: collapse the builder and forget
  // the "placed this session" flag so the other property's existing orders show.
  React.useEffect(() => {
    setShowBuilder(false);
    setPlacedThisSession(false);
  }, [propertyId]);

  // Show the "already placed" panel when orders exist, the user hasn't placed in
  // this session, and they haven't explicitly opted into "place another order".
  const showAlreadyPlaced = hasExistingOrders && !placedThisSession && !showBuilder;

  // ── Live full-day menu (for download / share on the success state) ──
  const { data: fullMenu, isLoading: menuLoading } = useQuery({
    queryKey: foodKeys.fullMenu({ propertyId, date: dateStr }),
    queryFn: () => foodApi.fullMenu({ propertyId, date: dateStr }),
    enabled: !!propertyId && configured,
  });

  /** Derived effective state for one dish. Checkboxes/edit are disabled, so every
   *  dish is included by default and the quantity is always the auto-computed one. */
  const effFor = React.useCallback((mt: string, dishId: string, qtyPerResident: number) => {
    const ov = overrides[itemKey(mt, dishId)];
    const included = !(ov?.excluded ?? false);
    const p = ov?.persons ?? persons;
    const qty = ov?.qty ?? round3(p * qtyPerResident);
    return { included, persons: p, qty };
  }, [overrides, persons]);

  // ── Derived order (only meals that have a menu produce items → one order each) ──
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
      setPlacedThisSession(true);
      setPlaced({ batch: res.batch, orders: res.orders });
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to place order", variant: "destructive" }),
  });

  const handlePlace = () => {
    if (!propertyId) { toast({ title: "Select a property first", variant: "destructive" }); return; }
    if (!configured) { toast({ title: "Property not configured for ordering", variant: "destructive" }); return; }
    if (orderingClosed) { toast({ title: "Ordering for tomorrow is closed", variant: "destructive" }); return; }
    if (selection.mealCount === 0) { toast({ title: "No menu to order", description: "There is no menu configured for tomorrow.", variant: "destructive" }); return; }
    placeMutation.mutate();
  };

  // ── Share — copy-link (LINK) OR dispatch to active guests (EMAIL/GUESTS) ──
  // `recipientCount` may arrive on `res` or `res.data` depending on the unwrap; read both.
  const shareMutation = useMutation({
    mutationFn: (mode: "LINK" | "GUESTS") =>
      mode === "GUESTS"
        // For GUESTS the backend resolves the property's active guests and dispatches via notify().
        ? foodApi.shareMenu({ propertyId, brand, date: dateStr, channel: "EMAIL", recipientType: "GUESTS" } as Record<string, unknown>)
        : foodApi.shareMenu({ propertyId, brand, date: dateStr, channel: "LINK" }),
    onSuccess: (res: any, mode) => {
      if (mode === "GUESTS") {
        const n = res?.recipientCount ?? res?.data?.recipientCount ?? 0;
        toast({ title: `Menu shared with ${n} active guest${n === 1 ? "" : "s"}` });
        setShareOpen(false);
        return;
      }
      const token = res?.shareToken ?? res?.data?.shareToken;
      if (token) { setShareLink(`${window.location.origin}/m/${token}`); toast({ title: "Share link ready" }); }
      else { toast({ title: "Menu shared" }); }
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to share menu", variant: "destructive" }),
  });
  const sharingMode = (shareMutation.variables as "LINK" | "GUESTS" | undefined);

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

  // #14 — render the same menu content to a PNG via the canvas 2D API (no new deps).
  const downloadMenuImage = () => {
    try {
      const ms = fullMenu?.meals ?? [];
      // Layout constants (CSS px; we scale the backing store by `dpr` for crisp text).
      const W = 720, PAD = 48, dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
      const titleH = 34, dateH = 22, ruleGap = 26;
      const mealHeadH = 26, dishH = 22, dishGap = 6, mealGap = 22, emptyH = 22;
      // First pass: measure height so the canvas fits all content.
      let H = PAD + titleH + dateH + 14 + ruleGap;
      if (ms.length === 0) H += emptyH;
      ms.forEach((meal) => {
        H += mealHeadH + 6;
        H += meal.dishes.length === 0 ? emptyH : meal.dishes.length * (dishH + dishGap);
        H += mealGap;
      });
      H += PAD;

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) { toast({ title: "Couldn't generate image", variant: "destructive" }); return; }
      ctx.scale(dpr, dpr);

      // Background.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);

      const font = (size: number, weight = "400") =>
        `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      let y = PAD;

      // Title (brand) + meta (date / property).
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#0f172a";
      ctx.font = font(24, "700");
      ctx.textAlign = "left";
      y += 24;
      ctx.fillText(brand ?? "Menu", PAD, y);
      y += dateH;
      ctx.font = font(13, "400");
      ctx.fillStyle = "#64748b";
      ctx.fillText(dateLabel, PAD, y);
      if (selectedProperty?.name) {
        ctx.textAlign = "right";
        ctx.fillText(selectedProperty.name, W - PAD, y);
        ctx.textAlign = "left";
      }

      // Divider rule.
      y += 14;
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(W - PAD, y + 0.5); ctx.stroke();
      y += ruleGap;

      if (ms.length === 0) {
        ctx.font = font(13, "400");
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("No menu configured for this day.", PAD, y);
      }

      ms.forEach((meal) => {
        // Meal heading.
        ctx.font = font(16, "700");
        ctx.fillStyle = "#0f172a";
        y += 16;
        ctx.fillText(meal.label || MEAL_LABEL[meal.mealType], PAD, y);
        y += 10;

        if (meal.dishes.length === 0) {
          ctx.font = font(13, "400");
          ctx.fillStyle = "#94a3b8";
          y += dishH - 6;
          ctx.fillText("— No dishes —", PAD + 8, y);
          y += emptyH - (dishH - 6);
        } else {
          meal.dishes.slice().sort((a, b) => a.sortOrder - b.sortOrder).forEach((d) => {
            y += dishH - 6;
            ctx.font = font(13, "400");
            ctx.fillStyle = "#1e293b";
            ctx.textAlign = "left";
            ctx.fillText(`•  ${d.dishName}`, PAD + 8, y);
            const slot = d.slotLabel ? `${d.slotLabel} · ` : "";
            ctx.fillStyle = "#94a3b8";
            ctx.textAlign = "right";
            ctx.fillText(`${slot}${d.unit.toLowerCase()}`, W - PAD, y);
            ctx.textAlign = "left";
            y += dishGap;
          });
        }
        y += mealGap;
      });

      canvas.toBlob((blob) => {
        if (!blob) { toast({ title: "Couldn't generate image", variant: "destructive" }); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `uniliv-menu-${dateStr}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast({ title: "Menu image downloaded" });
      }, "image/png");
    } catch (e: any) { toast({ title: e?.message || "Couldn't generate image", variant: "destructive" }); }
  };

  // Shared download control (PDF + image) — gated by canDownload; reused on the
  // menu-preview area and the success screen.
  const hasMenu = (fullMenu?.meals?.length ?? 0) > 0;
  const MenuDownloadButton = () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={menuLoading || !hasMenu} className="w-[164px] justify-start">
          <Download className="mr-2 h-4 w-4" /> Download menu
          <ChevronDown className="ml-auto h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem onClick={downloadMenuPdf}>
          <FileText className="mr-2 h-4 w-4" /> Download PDF
        </DropdownMenuItem>
        <DropdownMenuItem onClick={downloadMenuImage}>
          <ImageIcon className="mr-2 h-4 w-4" /> Download image
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const copyShareLink = async () => {
    if (!shareLink) return;
    try { await navigator.clipboard.writeText(shareLink); toast({ title: "Link copied" }); }
    catch { toast({ title: "Couldn't copy link", variant: "destructive" }); }
  };

  const saving = placeMutation.isPending;

  // ════════════════════════════════════════════════════════════════════════
  // SUCCESS STATE — batch reference + per-meal orders (each links to tracking)
  // ════════════════════════════════════════════════════════════════════════
  if (placed) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Order placed"
          subtitle="Your meal orders are in. Track each one or place another."
          breadcrumbs={[{ label: "Food", href: "/food/orders" }, { label: "Place Order" }]}
        />
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/12">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </div>
              <div>
                <h2 className="font-display text-lg font-semibold">
                  {placed.orders.length} order{placed.orders.length === 1 ? "" : "s"} placed
                </h2>
                <p className="text-sm text-muted-foreground">
                  {selectedProperty?.name ?? "Property"} · {brand} · {dateLabel}
                </p>
              </div>
              <Badge variant="secondary" className="gap-1.5 font-mono text-xs">
                <Tag className="h-3 w-3" /> Batch {placed.batch.batchNumber}
              </Badge>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">Your orders</CardTitle>
              <CardDescription>Track any order to follow its kitchen-to-delivery status.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ul className="divide-y">
                {placed.orders.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                    <Soup className="h-4 w-4 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{MEAL_LABEL[o.mealType] ?? o.mealType}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{o.orderNumber}</p>
                    </div>
                    <StatusBadge status={o.status} />
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/food/track?order=${encodeURIComponent(o.orderNumber)}`}>
                        <Truck className="mr-1.5 h-3.5 w-3.5" /> Track your order
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* Download + Share — only on the success state */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 py-4">
              {canDownload && <MenuDownloadButton />}
              <Button type="button" variant="outline" size="sm" onClick={() => { setShareLink(null); setShareOpen(true); }}>
                <Share2 className="mr-2 h-4 w-4" /> Share menu
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => navigate("/food/orders")}>View all orders</Button>
                <Button size="sm" onClick={() => { setPlaced(null); setShareLink(null); }}>
                  Place another <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Share drawer — copy link OR dispatch to active guests */}
        <ShareMenuDrawer
          open={shareOpen} onOpenChange={setShareOpen}
          brand={brand} dateLabel={dateLabel} propertyName={selectedProperty?.name}
          activeGuests={overview?.activeGuests ?? 0}
          shareLink={shareLink}
          onShare={(mode) => shareMutation.mutate(mode)}
          generating={shareMutation.isPending} sharingMode={sharingMode}
          onCopy={copyShareLink}
        />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRE-ORDER STATE
  // ════════════════════════════════════════════════════════════════════════
  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-6">
      <PageHeader
        title="Place Order"
        subtitle="Set the headcount once — quantities are calculated for every dish."
        breadcrumbs={[{ label: "Food", href: "/food/orders" }, { label: "Place Order" }]}
      />

      {/* ── Cut-off banner ── */}
      {orderingClosed ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            Ordering for tomorrow is closed{cutoffTime ? ` — the ${cutoffTime} cut-off has passed` : ""}.
          </span>
        </div>
      ) : cutoffDeadline ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <Clock className="h-4 w-4 shrink-0 text-accent" />
          <span className="text-muted-foreground">
            Order for tomorrow before today's {cutoffTime} cut-off.
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 font-medium tabular-nums">
            <Zap className="h-3.5 w-3.5 text-accent" /> {countdown.text} left
          </span>
        </div>
      ) : null}

      {/* ── po4 — "Order already placed for tomorrow" panel (instead of leading with the builder) ── */}
      {showAlreadyPlaced && (
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" /> Order already placed for tomorrow
              </CardTitle>
              <CardDescription>
                {selectedProperty?.name ?? "This property"} already has {existingOrders.length} order{existingOrders.length === 1 ? "" : "s"} for {dateLabel}. Track or edit them below.
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ul className="divide-y">
                {existingOrders.map((o) => {
                  const editable = o.status === "PLACED" || o.status === "PREPARING";
                  return (
                    <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                      <Soup className="h-4 w-4 shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{MEAL_LABEL[o.mealType] ?? o.mealType}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{o.orderNumber}</p>
                      </div>
                      <StatusBadge status={o.status} />
                      {editable && (
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/food/orders/${o.id}`}>
                            <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                          </Link>
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/food/orders/${o.id}`}>
                          <Truck className="mr-1.5 h-3.5 w-3.5" /> Track
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {/* Secondary action — place an additional order via the existing builder */}
          <div className="flex items-center justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowBuilder(true)} disabled={orderingClosed}>
              Place another order <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <div className={cn("grid grid-cols-1 lg:grid-cols-12 gap-6 items-start", showAlreadyPlaced && "hidden")}>
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
                {/* Service date — read-only, always tomorrow */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Service date</Label>
                  <div className="flex h-10 items-center gap-2 rounded-md border bg-muted/40 px-3 sm:w-[220px]" aria-readonly="true">
                    <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm">
                      <span className="font-medium">Tomorrow</span>
                      <span className="text-muted-foreground"> · {dateLabel}</span>
                    </span>
                    <Lock className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </div>
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
                  <Zap className="h-3.5 w-3.5 text-accent" /> quantities are updated live
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
              <EmptyState icon={Soup} title="No menu for tomorrow" description="Nothing is configured for this property's kitchen and brand for tomorrow's service date." />
            </CardContent></Card>
          ) : (
            <Tabs value={activeMeal} onValueChange={setActiveMeal} className="space-y-3">
              {/* Menu actions — surfaced as soon as a menu is loaded (not only post-order). */}
              {(canDownload || hasMenu) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canDownload && <MenuDownloadButton />}
                  <Button type="button" variant="outline" size="sm" onClick={() => { setShareLink(null); setShareOpen(true); }} disabled={!hasMenu}>
                    <Share2 className="mr-2 h-4 w-4" /> Share menu
                  </Button>
                </div>
              )}
              <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {preview.meals.map((meal) => {
                  const count = selection.countByMeal[meal.mealType] ?? 0;
                  return (
                    <TabsTrigger key={meal.mealType} value={meal.mealType}
                      className="shrink-0 gap-2 rounded-lg border border-transparent px-3 py-2 data-[state=active]:border-border data-[state=active]:bg-card">
                      <Soup className="h-3.5 w-3.5 text-accent" />
                      <span className="font-medium">{meal.label}</span>
                      <Badge variant={count > 0 ? "default" : "secondary"} className="h-5 min-w-5 justify-center px-1.5 text-[10px]">{count}</Badge>
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {/* B3-16: This screen does NOT let the user pick individual dishes —
                  the menu is auto-derived from the configured rotation/composition
                  (per-dish include/exclude is "coming soon" and disabled below, so
                  every dish is always included). There is therefore no dish selection
                  to validate or hard-block here; the composition hard-block lives in
                  Food Settings → Menu Rotation, where dishes are actually chosen. */}
              {preview.meals.map((meal) => {
                const dishIds = meal.items.map((i) => i.dishId);
                return (
                  <TabsContent key={meal.mealType} value={meal.mealType} className="mt-0">
                    <Card>
                      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 py-3">
                        {/* Select-all checkbox — DISABLED ("coming soon"); all dishes always included */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <label className="flex items-center gap-2 text-sm opacity-60" aria-disabled="true">
                              <Checkbox checked disabled aria-label={`Include all ${meal.label}`} />
                              <span className="text-muted-foreground">All {dishIds.length} dishes included</span>
                              <Badge variant="outline" className="text-[9px] uppercase">coming soon</Badge>
                            </label>
                          </TooltipTrigger>
                          <TooltipContent>Selecting individual dishes is coming soon — all dishes are included for now.</TooltipContent>
                        </Tooltip>
                      </CardHeader>
                      <Separator />
                      <CardContent className="p-0">
                        <BoundedScroll size="lg">
                          <ul className="divide-y">
                            {meal.items.map((it) => {
                              const e = effFor(meal.mealType, it.dishId, it.qtyPerResident);
                              return (
                                <li key={it.dishId} className="flex items-center gap-3 px-4 py-2.5">
                                  {/* Per-item include checkbox — DISABLED ("coming soon") */}
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex" aria-disabled="true">
                                        <Checkbox checked disabled aria-label={`Include ${it.dishName}`} />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>Including/excluding dishes is coming soon.</TooltipContent>
                                  </Tooltip>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{it.dishName}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {it.slotLabel ? `${it.slotLabel} · ` : ""}
                                      {fmtQty(it.qtyPerResident, it.unit)}/person
                                    </p>
                                  </div>
                                  <div className="shrink-0 text-right tabular-nums">
                                    <span className="text-sm font-semibold">{fmtQty(e.qty, it.unit)}</span>
                                  </div>
                                  {/* Edit pencil — DISABLED ("coming soon") */}
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex">
                                        <Button variant="ghost" size="icon" disabled className="h-8 w-8 shrink-0 text-muted-foreground" aria-label={`Customise ${it.dishName} (coming soon)`}>
                                          <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>Per-dish quantity editing is coming soon.</TooltipContent>
                                  </Tooltip>
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

        {/* ── Right: summary ── */}
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
            </CardHeader>
            <Separator />
            <CardContent className="p-4">
              {selection.mealCount === 0 ? (
                <EmptyState icon={Info} title="Nothing to order" description="Set the headcount — every dish on tomorrow's menu is included automatically." />
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
                  <Button onClick={handlePlace} disabled={saving || !canPlace || orderingClosed}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UtensilsCrossed className="mr-2 h-4 w-4" />}
                    Place order
                    {selection.itemCount > 0 && <Badge variant="secondary" className="ml-2 bg-white/20 text-white border-0">{selection.itemCount}</Badge>}
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      {/* Share drawer — copy link OR dispatch to active guests (available pre-order too) */}
      <ShareMenuDrawer
        open={shareOpen} onOpenChange={setShareOpen}
        brand={brand} dateLabel={dateLabel} propertyName={selectedProperty?.name}
        activeGuests={overview?.activeGuests ?? 0}
        shareLink={shareLink}
        onShare={(mode) => shareMutation.mutate(mode)}
        generating={shareMutation.isPending} sharingMode={sharingMode}
        onCopy={copyShareLink}
      />
    </div>
    </TooltipProvider>
  );
}

/** Share drawer — copy a menu link OR dispatch the menu to the property's active guests. */
function ShareMenuDrawer({
  open, onOpenChange, brand, dateLabel, propertyName, activeGuests, shareLink, onShare, generating, sharingMode, onCopy,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  brand: string | null; dateLabel: string; propertyName?: string;
  activeGuests: number;
  shareLink: string | null;
  onShare: (mode: "LINK" | "GUESTS") => void; generating: boolean;
  sharingMode?: "LINK" | "GUESTS"; onCopy: () => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-lg">
          <DrawerHeader>
            <DrawerTitle className="flex items-center gap-2"><Share2 className="h-5 w-5 text-accent" /> Share menu</DrawerTitle>
            <DrawerDescription>{brand} • {dateLabel}{propertyName ? ` • ${propertyName}` : ""}</DrawerDescription>
          </DrawerHeader>
          <div className="space-y-5 px-4">
            {/* Option 1 — copy a shareable link */}
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Link2 className="h-4 w-4 text-accent" /> Copy a shareable link
              </p>
              <p className="text-xs text-muted-foreground">Generate a public menu link anyone can open.</p>
              {shareLink ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value={shareLink} className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={onCopy} aria-label="Copy link"><Copy className="h-4 w-4" /></Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => onShare("LINK")} disabled={generating}>
                    {generating && sharingMode === "LINK" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Regenerate
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => onShare("LINK")} disabled={generating}>
                  {generating && sharingMode === "LINK" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Link2 className="mr-2 h-4 w-4" /> Generate link
                </Button>
              )}
            </div>

            <Separator />

            {/* Option 2 — dispatch to the property's active guests */}
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4 text-accent" /> Share with active guests
              </p>
              <p className="text-xs text-muted-foreground">
                {activeGuests > 0
                  ? `Email the menu to all ${activeGuests} active guest${activeGuests === 1 ? "" : "s"} at ${propertyName ?? "this property"}.`
                  : `Email the menu to all active guests at ${propertyName ?? "this property"}.`}
              </p>
              <Button type="button" size="sm" onClick={() => onShare("GUESTS")} disabled={generating}>
                {generating && sharingMode === "GUESTS" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                Share with guests
              </Button>
            </div>
          </div>
          <DrawerFooter>
            <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
