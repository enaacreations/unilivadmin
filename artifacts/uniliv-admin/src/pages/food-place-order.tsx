import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  UtensilsCrossed,
  ChefHat,
  Loader2,
  Info,
  ClipboardList,
  CalendarDays,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  foodApi,
  foodKeys,
  MEAL_TYPES,
  BRANDS,
  MEAL_LABEL,
  type FoodBrand,
  type MealType,
} from "@/lib/food-api";
import { useToast } from "@/hooks/use-toast";

// Shape returned by foodApi.resolveMenu — one row per dish the kitchen prepares.
interface ResolvedMenuDish {
  dishId: string;
  dishName: string;
  component: string;
  unit: string;
  slotLabel: string | null;
  sortOrder: number;
}

const today = () => format(new Date(), "yyyy-MM-dd");

const orderSchema = z.object({
  propertyId: z.string().min(1, "Select a property"),
  brand: z.enum(["UNILIV", "HUDDLE"]),
  mealType: z.enum(["BREAKFAST", "LUNCH", "SNACKS", "DINNER", "NIGHT_MILK"]),
  serviceDate: z.string().min(1, "Service date is required"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  residentsCount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
});
type OrderForm = z.infer<typeof orderSchema>;

export default function FoodPlaceOrder() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const form = useForm<OrderForm>({
    resolver: zodResolver(orderSchema),
    defaultValues: {
      propertyId: "",
      brand: "UNILIV",
      mealType: "BREAKFAST",
      serviceDate: today(),
      quantity: undefined as unknown as number,
      residentsCount: undefined,
      notes: "",
    },
  });

  const propertyId = form.watch("propertyId");
  const brand = form.watch("brand");
  const mealType = form.watch("mealType");
  const serviceDate = form.watch("serviceDate");
  const quantity = form.watch("quantity");

  // ── Lookups (properties / brands / meal types) ──────────────────────────────
  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? properties.find((p) => p.id === id)?.name ?? "—" : "—";

  // ── Live menu preview ───────────────────────────────────────────────────────
  const previewReady = !!(brand && mealType && serviceDate);
  const previewParams = { brand, mealType, date: serviceDate };
  const {
    data: menu,
    isLoading: menuLoading,
    isError: menuError,
  } = useQuery({
    queryKey: foodKeys.rotation({ resolve: true, ...previewParams }),
    queryFn: () =>
      foodApi.resolveMenu(previewParams) as Promise<ResolvedMenuDish[]>,
    enabled: previewReady,
  });
  const dishes = (menu ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);

  // ── Mutation ────────────────────────────────────────────────────────────────
  const placeMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => foodApi.placeOrder(body),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ["food", "orders"] });
      qc.invalidateQueries({ queryKey: ["food", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["food", "kitchen-summary"] });
      toast({
        title: "Order placed",
        description: `Order ${order.orderNumber} created for ${propName(
          order.propertyId,
        )}.`,
      });
      setLocation("/food/orders");
    },
    onError: (e: any) => {
      toast({ title: e?.message || "Failed to place order", variant: "destructive" });
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    const body: Record<string, unknown> = {
      propertyId: v.propertyId,
      brand: v.brand,
      mealType: v.mealType,
      serviceDate: v.serviceDate,
      quantity: v.quantity,
    };
    if (v.residentsCount !== undefined && !Number.isNaN(v.residentsCount)) {
      body.residentsCount = v.residentsCount;
    }
    if (v.notes && v.notes.trim()) body.notes = v.notes.trim();
    placeMutation.mutate(body);
  });

  const errors = form.formState.errors;
  const saving = placeMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Place Order"
        subtitle="Create a kitchen order for a property's meal service"
        breadcrumbs={[
          { label: "Food", href: "/food/orders" },
          { label: "Place Order" },
        ]}
      />

      <form onSubmit={onSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
          {/* ── Left: order form ──────────────────────────────────────────── */}
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-primary" /> Order Details
              </CardTitle>
              <CardDescription>
                Choose the property, brand and meal — the kitchen will prepare the
                resolved menu shown alongside.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Property */}
                <div className="sm:col-span-2">
                  <Label>Property *</Label>
                  <Select
                    value={form.watch("propertyId") || ""}
                    onValueChange={(v) =>
                      form.setValue("propertyId", v, { shouldValidate: true })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select property" />
                    </SelectTrigger>
                    <SelectContent>
                      {properties.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.propertyId && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.propertyId.message}
                    </p>
                  )}
                </div>

                {/* Brand */}
                <div>
                  <Label>Brand *</Label>
                  <Select
                    value={brand}
                    onValueChange={(v) =>
                      form.setValue("brand", v as FoodBrand, {
                        shouldValidate: true,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select brand" />
                    </SelectTrigger>
                    <SelectContent>
                      {BRANDS.map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Meal Type */}
                <div>
                  <Label>Meal Type *</Label>
                  <Select
                    value={mealType}
                    onValueChange={(v) =>
                      form.setValue("mealType", v as MealType, {
                        shouldValidate: true,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select meal" />
                    </SelectTrigger>
                    <SelectContent>
                      {MEAL_TYPES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {MEAL_LABEL[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Service Date */}
                <div>
                  <Label>Service Date *</Label>
                  <Input type="date" {...form.register("serviceDate")} />
                  {errors.serviceDate && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.serviceDate.message}
                    </p>
                  )}
                </div>

                {/* Quantity */}
                <div>
                  <Label>Quantity (meals) *</Label>
                  <Input
                    type="number"
                    min={1}
                    step="any"
                    placeholder="Meals to prepare"
                    {...form.register("quantity")}
                  />
                  {errors.quantity && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.quantity.message}
                    </p>
                  )}
                </div>

                {/* Residents Count */}
                <div className="sm:col-span-2">
                  <Label>Residents Count</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Optional"
                    {...form.register("residentsCount")}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Defaults to quantity if left blank.
                  </p>
                </div>

                {/* Notes */}
                <div className="sm:col-span-2">
                  <Label>Notes</Label>
                  <Textarea
                    rows={3}
                    placeholder="Special instructions for the kitchen (optional)"
                    {...form.register("notes")}
                  />
                </div>
              </div>

              <Separator />

              <div className="flex items-center justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setLocation("/food/orders")}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="bg-accent hover:bg-accent/90 text-white"
                  disabled={saving}
                >
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <UtensilsCrossed className="w-4 h-4 mr-2" /> Place Order
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ── Right: live menu preview ──────────────────────────────────── */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <ChefHat className="w-5 h-5 text-primary" /> Kitchen Preview
              </CardTitle>
              <CardDescription>
                {previewReady ? (
                  <span className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
                      {brand}
                    </Badge>
                    <Badge variant="info" className="text-[10px] uppercase tracking-wider">
                      {MEAL_LABEL[mealType]}
                    </Badge>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <CalendarDays className="w-3 h-3" />
                      {serviceDate
                        ? format(new Date(serviceDate), "dd MMM yyyy")
                        : "—"}
                    </span>
                  </span>
                ) : (
                  "Choose brand, meal & date to preview the menu"
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!previewReady ? (
                <div className="flex flex-col items-center justify-center text-center py-10 text-muted-foreground">
                  <Info className="w-8 h-8 mb-3 opacity-50" />
                  <p className="text-sm">
                    Select brand, meal type and service date to see the dishes the
                    kitchen will prepare.
                  </p>
                </div>
              ) : menuLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : menuError ? (
                <Alert variant="destructive">
                  <AlertTitle>Couldn't load menu</AlertTitle>
                  <AlertDescription>
                    Try changing the selection or retry in a moment.
                  </AlertDescription>
                </Alert>
              ) : dishes.length === 0 ? (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>No menu configured</AlertTitle>
                  <AlertDescription>
                    No {MEAL_LABEL[mealType].toLowerCase()} menu is set for{" "}
                    {brand} on{" "}
                    {serviceDate
                      ? format(new Date(serviceDate), "dd MMM yyyy")
                      : "this day"}
                    . You can still place the order, but no dishes will be
                    prepared automatically.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {dishes.length} dish{dishes.length === 1 ? "" : "es"} will be
                    prepared
                    {quantity ? ` for ${quantity} meals` : ""}.
                  </p>
                  <ul className="divide-y rounded-md border">
                    {dishes.map((d) => (
                      <li
                        key={d.dishId}
                        className="flex items-center justify-between gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {d.dishName}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {d.slotLabel || d.component.replace(/_/g, " ")}
                          </p>
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
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  );
}
