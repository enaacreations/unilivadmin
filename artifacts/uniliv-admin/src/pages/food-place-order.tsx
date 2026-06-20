import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import jsPDF from "jspdf";
import {
  UtensilsCrossed,
  ChefHat,
  Loader2,
  Building2,
  CalendarDays,
  Users,
  Minus,
  Plus,
  Check,
  ChevronsUpDown,
  Clock,
  Lock,
  Download,
  Share2,
  Mail,
  MessageCircle,
  Link2,
  Copy,
  Soup,
  Info,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Calendar } from "@/components/ui/calendar";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  foodApi,
  foodKeys,
  BRANDS,
  MEAL_LABEL,
  type FoodBrand,
  type MealType,
  type Cutoff,
  type MealConfig,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";

type ShareChannel = "EMAIL" | "WHATSAPP" | "LINK";
type ShareRecipientType = "GUESTS" | "CUSTOM";

const todayDate = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export default function FoodPlaceOrder() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { propertyId: storePropertyId } = useAppStore();
  const { can } = usePermissions();
  const canPlace = can("FOOD_PLACE_ORDER", "create");

  // ── Form state ──────────────────────────────────────────────────────────────
  const [propertyId, setPropertyId] = React.useState<string>("");
  const [propertyOpen, setPropertyOpen] = React.useState(false);
  const [brand, setBrand] = React.useState<FoodBrand>("UNILIV");
  const [date, setDate] = React.useState<Date>(todayDate());
  const [dateOpen, setDateOpen] = React.useState(false);
  const [residentsCount, setResidentsCount] = React.useState<number>(1);

  // Per-meal selection: included flag + quantity
  const [meals, setMeals] = React.useState<
    Record<string, { included: boolean; quantity: number }>
  >({});

  // Share drawer state
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareChannel, setShareChannel] = React.useState<ShareChannel>("EMAIL");
  const [shareRecipientType, setShareRecipientType] =
    React.useState<ShareRecipientType>("GUESTS");
  const [shareLink, setShareLink] = React.useState<string | null>(null);

  const dateStr = format(date, "yyyy-MM-dd");
  const dateLabel = format(date, "EEE, dd MMM yyyy");

  // ── Lookups ──────────────────────────────────────────────────────────────────
  const { data: lookups, isLoading: lookupsLoading } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];

  // Default property: store selection, else first property.
  React.useEffect(() => {
    if (propertyId) return;
    if (storePropertyId && properties.some((p) => p.id === storePropertyId)) {
      setPropertyId(storePropertyId);
    } else if (properties.length > 0) {
      setPropertyId(properties[0].id);
    }
  }, [properties, storePropertyId, propertyId]);

  const selectedProperty = properties.find((p) => p.id === propertyId);

  // ── Meal config (enabled meals + display labels) ─────────────────────────────
  const { data: mealConfigRaw, isLoading: mealsLoading } = useQuery({
    queryKey: foodKeys.mealConfig(),
    queryFn: () => foodApi.mealConfig(),
  });
  const mealConfig: MealConfig[] = React.useMemo(() => {
    const list = (mealConfigRaw ?? []).filter(
      (m) => m.isEnabled && (m.brand === null || m.brand === brand),
    );
    return list.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }, [mealConfigRaw, brand]);

  // ── Cut-offs ─────────────────────────────────────────────────────────────────
  const { data: cutoffsRaw } = useQuery({
    queryKey: foodKeys.cutoffs({ brand, propertyId, date: dateStr }),
    queryFn: () =>
      foodApi.cutoffs({
        brand,
        propertyId: propertyId || undefined,
        date: dateStr,
      }),
    enabled: !!propertyId,
  });
  const cutoffByMeal = React.useMemo(() => {
    const map: Record<string, Cutoff> = {};
    (cutoffsRaw ?? []).forEach((c) => {
      map[c.mealType] = c;
    });
    return map;
  }, [cutoffsRaw]);

  // When a meal becomes closed, force it out of the selection.
  React.useEffect(() => {
    setMeals((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [mt, sel] of Object.entries(prev)) {
        if (sel.included && cutoffByMeal[mt]?.isPastCutoff) {
          next[mt] = { ...sel, included: false };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cutoffByMeal]);

  // ── Live full-day menu ───────────────────────────────────────────────────────
  const { data: fullMenu, isLoading: menuLoading } = useQuery({
    queryKey: foodKeys.fullMenu({ brand, date: dateStr }),
    queryFn: () => foodApi.fullMenu({ brand, date: dateStr }),
  });

  // ── Derived selection ────────────────────────────────────────────────────────
  const selectedMeals = React.useMemo(
    () =>
      Object.entries(meals)
        .filter(([, v]) => v.included && v.quantity > 0)
        .map(([mealType, v]) => ({
          mealType: mealType as MealType,
          quantity: v.quantity,
        })),
    [meals],
  );
  const includedMealTypes = React.useMemo(
    () => new Set(selectedMeals.map((m) => m.mealType)),
    [selectedMeals],
  );
  const totalMealsQty = selectedMeals.reduce((s, m) => s + m.quantity, 0);

  // ── Helpers to mutate meal state ─────────────────────────────────────────────
  const toggleMeal = (mealType: string, included: boolean) => {
    setMeals((prev) => {
      const cur = prev[mealType] ?? { included: false, quantity: 0 };
      const quantity =
        included && cur.quantity <= 0 ? residentsCount || 1 : cur.quantity;
      return { ...prev, [mealType]: { included, quantity } };
    });
  };
  const setMealQty = (mealType: string, quantity: number) => {
    setMeals((prev) => {
      const cur = prev[mealType] ?? { included: true, quantity: 0 };
      return {
        ...prev,
        [mealType]: { ...cur, quantity: Math.max(0, quantity) },
      };
    });
  };

  // ── Place order mutation ─────────────────────────────────────────────────────
  const placeMutation = useMutation({
    mutationFn: () =>
      foodApi.placeOrderBatch({
        propertyId,
        brand,
        serviceDate: date.toISOString(),
        residentsCount,
        meals: selectedMeals,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["food"] });
      const n = res?.orders?.length ?? selectedMeals.length;
      toast({
        title: `${n} order${n === 1 ? "" : "s"} placed`,
        description: `${selectedProperty?.name ?? "Property"} • ${brand} • ${dateLabel}`,
      });
      navigate("/food/orders");
    },
    onError: (e: any) =>
      toast({
        title: e?.message || "Failed to place order",
        variant: "destructive",
      }),
  });

  const handlePlace = () => {
    if (!propertyId) {
      toast({ title: "Select a property first", variant: "destructive" });
      return;
    }
    if (selectedMeals.length === 0) {
      toast({
        title: "Add at least one meal",
        description: "Include a meal and set a quantity greater than 0.",
        variant: "destructive",
      });
      return;
    }
    placeMutation.mutate();
  };

  // ── Share mutation ───────────────────────────────────────────────────────────
  const shareMutation = useMutation({
    mutationFn: () =>
      foodApi.shareMenu({
        propertyId,
        brand,
        date: dateStr,
        channel: shareChannel,
        recipientType: shareRecipientType,
      }),
    onSuccess: (res: any) => {
      if (shareChannel === "LINK" && res?.shareToken) {
        setShareLink(`${window.location.origin}/m/${res.shareToken}`);
        toast({ title: "Share link ready" });
      } else {
        setShareLink(null);
        const count = res?.recipientCount ?? 0;
        toast({
          title:
            shareRecipientType === "GUESTS"
              ? `Menu shared with ${count} guest${count === 1 ? "" : "s"}`
              : "Menu shared",
        });
        setShareOpen(false);
      }
    },
    onError: (e: any) =>
      toast({
        title: e?.message || "Failed to share menu",
        variant: "destructive",
      }),
  });

  // ── Download menu as PDF ─────────────────────────────────────────────────────
  const downloadMenuPdf = () => {
    try {
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const marginX = 48;
      let y = 64;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text(`${brand} Menu`, marginX, y);
      y += 22;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(110);
      doc.text(dateLabel, marginX, y);
      if (selectedProperty?.name) {
        doc.text(selectedProperty.name, pageW - marginX, y, { align: "right" });
      }
      doc.setTextColor(0);
      y += 14;
      doc.setDrawColor(220);
      doc.line(marginX, y, pageW - marginX, y);
      y += 26;

      const ms = fullMenu?.meals ?? [];
      if (ms.length === 0) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(11);
        doc.text("No menu configured for this day.", marginX, y);
      }

      ms.forEach((meal) => {
        if (y > 760) {
          doc.addPage();
          y = 64;
        }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(meal.label || MEAL_LABEL[meal.mealType], marginX, y);
        y += 18;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        if (meal.dishes.length === 0) {
          doc.setTextColor(150);
          doc.text("— No dishes —", marginX + 8, y);
          doc.setTextColor(0);
          y += 16;
        } else {
          meal.dishes
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .forEach((d) => {
              if (y > 780) {
                doc.addPage();
                y = 64;
              }
              const slot = d.slotLabel ? `  (${d.slotLabel})` : "";
              doc.text(`•  ${d.dishName}`, marginX + 8, y);
              doc.setTextColor(140);
              doc.text(
                `${slot ? slot.trim() + " · " : ""}${d.unit.toLowerCase()}`,
                pageW - marginX,
                y,
                { align: "right" },
              );
              doc.setTextColor(0);
              y += 16;
            });
        }
        y += 14;
      });

      doc.save(`uniliv-menu-${dateStr}.pdf`);
      toast({ title: "Menu downloaded" });
    } catch (e: any) {
      toast({
        title: e?.message || "Couldn't generate PDF",
        variant: "destructive",
      });
    }
  };

  const copyShareLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy link", variant: "destructive" });
    }
  };

  const saving = placeMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Place Order"
        subtitle="Order multiple meals for a property's day of service in one go"
        breadcrumbs={[
          { label: "Food", href: "/food/orders" },
          { label: "Place Order" },
        ]}
        action={
          <Button
            onClick={handlePlace}
            disabled={saving || !canPlace || selectedMeals.length === 0}
            className="bg-accent hover:bg-accent/90 text-white"
            size="lg"
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UtensilsCrossed className="mr-2 h-4 w-4" />
            )}
            Place order
            {selectedMeals.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-2 bg-white/20 text-white border-0"
              >
                {selectedMeals.length}
              </Badge>
            )}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ── Left: builder ──────────────────────────────────────────────── */}
        <div className="lg:col-span-7 space-y-6">
          {/* Service context */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="font-display flex items-center gap-2 text-base">
                <Building2 className="h-5 w-5 text-accent" /> Service details
              </CardTitle>
              <CardDescription>
                Who is being served, by which brand, on which day.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Property combobox */}
              <div className="space-y-1.5">
                <Label>Property</Label>
                <Popover open={propertyOpen} onOpenChange={setPropertyOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={propertyOpen}
                      className="w-full justify-between font-normal"
                      disabled={lookupsLoading}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="truncate">
                          {selectedProperty?.name ??
                            (lookupsLoading
                              ? "Loading properties…"
                              : "Select property")}
                        </span>
                      </span>
                      <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="p-0 w-[--radix-popover-trigger-width]"
                    align="start"
                  >
                    <Command>
                      <CommandInput placeholder="Search properties…" />
                      <CommandList>
                        <CommandEmpty>No property found.</CommandEmpty>
                        <CommandGroup>
                          {properties.map((p) => (
                            <CommandItem
                              key={p.id}
                              value={p.name}
                              onSelect={() => {
                                setPropertyId(p.id);
                                setPropertyOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  propertyId === p.id
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {p.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {/* Brand segmented control */}
                <div className="space-y-1.5">
                  <Label>Brand</Label>
                  <div className="inline-flex w-full rounded-lg border border-border bg-muted/40 p-1">
                    {BRANDS.map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setBrand(b)}
                        className={cn(
                          "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                          brand === b
                            ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Service date */}
                <div className="space-y-1.5">
                  <Label>Service date</Label>
                  <Popover open={dateOpen} onOpenChange={setDateOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-start font-normal"
                      >
                        <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground" />
                        {dateLabel}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-auto" align="start">
                      <Calendar
                        mode="single"
                        selected={date}
                        onSelect={(d) => {
                          if (d) {
                            const nd = new Date(d);
                            nd.setHours(0, 0, 0, 0);
                            setDate(nd);
                          }
                          setDateOpen(false);
                        }}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Residents stepper */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Users className="h-4 w-4 text-muted-foreground" /> Residents
                  (persons)
                </Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      setResidentsCount((c) => Math.max(0, c - 1))
                    }
                    aria-label="Decrease residents"
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    type="number"
                    min={0}
                    value={residentsCount}
                    onChange={(e) =>
                      setResidentsCount(Math.max(0, Number(e.target.value) || 0))
                    }
                    className="w-24 text-center font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setResidentsCount((c) => c + 1)}
                    aria-label="Increase residents"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <p className="text-xs text-muted-foreground ml-1">
                    Used to pre-fill meal quantities.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Meal selector */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="font-display flex items-center gap-2 text-base">
                <Soup className="h-5 w-5 text-accent" /> Choose meals
              </CardTitle>
              <CardDescription>
                Include the meals you want to order and set quantities. Meals
                past their cut-off are closed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {mealsLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-lg" />
                ))
              ) : mealConfig.length === 0 ? (
                <EmptyState
                  icon={Soup}
                  title="No meals configured"
                  description="Enable meals in Meal Settings to start ordering."
                />
              ) : (
                mealConfig.map((m) => {
                  const cutoff = cutoffByMeal[m.mealType];
                  const closed = !!cutoff?.isPastCutoff;
                  const sel = meals[m.mealType] ?? {
                    included: false,
                    quantity: 0,
                  };
                  const included = sel.included && !closed;
                  return (
                    <div
                      key={m.mealType}
                      className={cn(
                        "rounded-lg border p-4 transition-colors",
                        included
                          ? "border-accent/40 bg-accent/5"
                          : "border-border bg-card",
                        closed && "opacity-70",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={included}
                            disabled={closed}
                            onCheckedChange={(v) => toggleMeal(m.mealType, v)}
                            aria-label={`Include ${m.displayLabel}`}
                          />
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {m.displayLabel}
                            </p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {closed ? (
                                <Badge
                                  variant="destructive"
                                  className="gap-1 text-[10px]"
                                >
                                  <Lock className="h-3 w-3" /> Closed
                                </Badge>
                              ) : cutoff?.cutoffTime ? (
                                <Badge
                                  variant="outline"
                                  className="gap-1 text-[10px] text-muted-foreground"
                                >
                                  <Clock className="h-3 w-3" /> Cut-off{" "}
                                  {cutoff.cutoffTime}
                                </Badge>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">
                                  No cut-off set
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {included && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() =>
                                setMealQty(m.mealType, sel.quantity - 1)
                              }
                              aria-label="Decrease quantity"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <Input
                              type="number"
                              min={0}
                              value={sel.quantity}
                              onChange={(e) =>
                                setMealQty(
                                  m.mealType,
                                  Number(e.target.value) || 0,
                                )
                              }
                              className="h-8 w-16 text-center font-mono"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() =>
                                setMealQty(m.mealType, sel.quantity + 1)
                              }
                              aria-label="Increase quantity"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {closed && (
                        <p className="text-xs text-muted-foreground mt-2 pl-12">
                          The cut-off for this meal has passed for{" "}
                          {format(date, "dd MMM")}. Choose a later date to
                          order it.
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right: live menu preview ───────────────────────────────────── */}
        <div className="lg:col-span-5">
          <Card className="lg:sticky lg:top-6">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="font-display flex items-center gap-2 text-base">
                    <ChefHat className="h-5 w-5 text-accent" /> Live menu
                  </CardTitle>
                  <CardDescription className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="secondary"
                      className="text-[10px] uppercase tracking-wider"
                    >
                      {brand}
                    </Badge>
                    <span className="inline-flex items-center gap-1 text-xs">
                      <CalendarDays className="h-3 w-3" /> {dateLabel}
                    </span>
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={downloadMenuPdf}
                  disabled={menuLoading}
                >
                  <Download className="mr-2 h-4 w-4" /> Download
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setShareLink(null);
                    setShareOpen(true);
                  }}
                  disabled={!propertyId}
                >
                  <Share2 className="mr-2 h-4 w-4" /> Share
                </Button>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ScrollArea className="h-[460px]">
                <div className="p-4 space-y-4">
                  {menuLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="space-y-2">
                        <Skeleton className="h-5 w-32" />
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                      </div>
                    ))
                  ) : !fullMenu || fullMenu.meals.length === 0 ? (
                    <EmptyState
                      icon={Info}
                      title="No menu for this day"
                      description="Nothing is configured for the selected brand and date."
                    />
                  ) : (
                    fullMenu.meals.map((meal) => {
                      const isIncluded = includedMealTypes.has(meal.mealType);
                      const dishes = meal.dishes
                        .slice()
                        .sort((a, b) => a.sortOrder - b.sortOrder);
                      return (
                        <div
                          key={meal.mealType}
                          className={cn(
                            "rounded-lg border",
                            isIncluded
                              ? "border-accent/40 bg-accent/5"
                              : "border-border",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
                            <p className="text-sm font-semibold font-display">
                              {meal.label || MEAL_LABEL[meal.mealType]}
                            </p>
                            {isIncluded && (
                              <Badge variant="success" className="text-[10px] gap-1">
                                <Check className="h-3 w-3" /> In order
                              </Badge>
                            )}
                          </div>
                          {dishes.length === 0 ? (
                            <p className="px-3 py-3 text-xs text-muted-foreground">
                              No dishes configured.
                            </p>
                          ) : (
                            <ul className="divide-y">
                              {dishes.map((d) => (
                                <li
                                  key={d.dishId}
                                  className="flex items-center justify-between gap-3 px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {d.dishName}
                                    </p>
                                    {d.slotLabel && (
                                      <p className="text-xs text-muted-foreground truncate">
                                        {d.slotLabel}
                                      </p>
                                    )}
                                  </div>
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] uppercase tracking-wider shrink-0"
                                  >
                                    {d.unit.toLowerCase()}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
            {selectedMeals.length > 0 && (
              <>
                <Separator />
                <div className="p-4 flex items-center justify-between">
                  <div className="text-sm">
                    <span className="text-muted-foreground">
                      {selectedMeals.length} meal
                      {selectedMeals.length === 1 ? "" : "s"} •{" "}
                    </span>
                    <span className="font-semibold">
                      {totalMealsQty.toLocaleString("en-IN")} portions
                    </span>
                  </div>
                  <Button
                    onClick={handlePlace}
                    disabled={saving || !canPlace}
                    className="bg-accent hover:bg-accent/90 text-white"
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <UtensilsCrossed className="mr-2 h-4 w-4" />
                    )}
                    Place order
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      {/* ── Share drawer (bottom sheet) ──────────────────────────────────── */}
      <Drawer open={shareOpen} onOpenChange={setShareOpen}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-lg">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                <Share2 className="h-5 w-5 text-accent" /> Share menu
              </DrawerTitle>
              <DrawerDescription>
                {brand} • {dateLabel}
                {selectedProperty ? ` • ${selectedProperty.name}` : ""}
              </DrawerDescription>
            </DrawerHeader>

            <div className="px-4 space-y-6">
              {/* Channel */}
              <div className="space-y-2">
                <Label>Channel</Label>
                <RadioGroup
                  value={shareChannel}
                  onValueChange={(v) => setShareChannel(v as ShareChannel)}
                  className="grid grid-cols-3 gap-2"
                >
                  {[
                    { v: "EMAIL", label: "Email", icon: Mail },
                    { v: "WHATSAPP", label: "WhatsApp", icon: MessageCircle },
                    { v: "LINK", label: "Link", icon: Link2 },
                  ].map(({ v, label, icon: Icon }) => (
                    <Label
                      key={v}
                      htmlFor={`channel-${v}`}
                      className={cn(
                        "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-sm transition-colors",
                        shareChannel === v
                          ? "border-accent bg-accent/5 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      <RadioGroupItem
                        id={`channel-${v}`}
                        value={v}
                        className="sr-only"
                      />
                      <Icon className="h-5 w-5" />
                      {label}
                    </Label>
                  ))}
                </RadioGroup>
              </div>

              {/* Recipients */}
              {shareChannel !== "LINK" && (
                <div className="space-y-2">
                  <Label>Recipients</Label>
                  <RadioGroup
                    value={shareRecipientType}
                    onValueChange={(v) =>
                      setShareRecipientType(v as ShareRecipientType)
                    }
                    className="grid grid-cols-2 gap-2"
                  >
                    {[
                      { v: "GUESTS", label: "All active guests" },
                      { v: "CUSTOM", label: "Custom" },
                    ].map(({ v, label }) => (
                      <Label
                        key={v}
                        htmlFor={`rcpt-${v}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm transition-colors",
                          shareRecipientType === v
                            ? "border-accent bg-accent/5 text-foreground"
                            : "border-border text-muted-foreground hover:bg-muted/50",
                        )}
                      >
                        <RadioGroupItem id={`rcpt-${v}`} value={v} />
                        {label}
                      </Label>
                    ))}
                  </RadioGroup>
                </div>
              )}

              {/* Resulting link */}
              {shareChannel === "LINK" && shareLink && (
                <div className="space-y-2">
                  <Label>Shareable link</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={shareLink}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={copyShareLink}
                      aria-label="Copy link"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <DrawerFooter>
              <Button
                onClick={() => shareMutation.mutate()}
                disabled={shareMutation.isPending || !propertyId}
                className="bg-accent hover:bg-accent/90 text-white"
              >
                {shareMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {shareChannel === "LINK" ? "Generate link" : "Share menu"}
              </Button>
              <DrawerClose asChild>
                <Button variant="outline">Close</Button>
              </DrawerClose>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
