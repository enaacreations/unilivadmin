import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { foodApi, foodKeys } from "@/lib/food-api";
import {
  useCreateProperty,
  useUpdateProperty,
  getGetPropertiesQueryKey,
  getGetPropertyQueryKey,
  type PropertyDto,
} from "@workspace/api-client-react";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { NumberStepper } from "@/components/ui/number-stepper";
import { PropertyPhotosManager } from "@/components/property-photos-manager";
import { MapPin, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  PORTFOLIO_TYPES,
  PORTFOLIO_TYPE_LABELS,
  portfolioAttrFields,
  type PortfolioType,
  type PortfolioAttributes,
} from "@/lib/portfolio-types";

const INDIAN_STATES: string[] = [
  // 28 states
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  // 8 union territories
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
];

const STATE_OPTIONS: ComboboxOption[] = INDIAN_STATES.map((s) => ({
  value: s,
  label: s,
}));

const AMENITIES = [
  "Wifi",
  "AC",
  "Laundry",
  "Mess",
  "Security",
  "Gym",
  "Library",
  "Parking",
  "CCTV",
  "Power Backup",
];

const schema = z.object({
  name: z.string().min(1, "Name required"),
  address: z.string().min(1, "Address required"),
  city: z.string().min(1, "City required"),
  state: z.string().min(1, "State required"),
  pincode: z.string().regex(/^\d{6}$/, "6-digit pincode"),
  totalBeds: z.coerce.number().min(1, "Min 1"),
  phone: z
    .string()
    .optional()
    .refine((v) => !v || /^\d{10}$/.test(v), { message: "10-digit phone" }),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  status: z.enum(["ACTIVE", "INACTIVE", "UNDER_RENOVATION"]),
  portfolioType: z.enum(PORTFOLIO_TYPES),
  brand: z.string().min(1, "Brand required"),
  // Auto-generated on create when blank (PROP-<CITY3>-<NNN>); editable override.
  code: z.string().optional(),
  // Per-property kitchen order cut-off (HH:MM, 24h). Optional → brand/global default.
  cutoffTime: z
    .string()
    .optional()
    .refine((v) => !v || /^([01]?\d|2[0-3]):[0-5]\d$/.test(v), { message: "HH:MM (24h)" }),
});

type FormValues = z.infer<typeof schema>;

interface PropertyFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property?: PropertyDto | null;
}

export function PropertyFormModal({
  open,
  onOpenChange,
  property,
}: PropertyFormModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isEdit = !!property;
  const [amenities, setAmenities] = React.useState<string[]>([]);
  const [coords, setCoords] = React.useState<{ lat?: number; lng?: number }>({});
  const [geocoding, setGeocoding] = React.useState(false);
  const [reverseGeocoding, setReverseGeocoding] = React.useState(false);
  const [attrs, setAttrs] = React.useState<PortfolioAttributes>({});
  // Unit-leads tagged to this property (users.propertyId set on submit).
  const [unitLeadIds, setUnitLeadIds] = React.useState<string[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      address: "",
      city: "",
      state: "",
      pincode: "",
      totalBeds: 1,
      phone: "",
      email: "",
      status: "ACTIVE",
      portfolioType: "CO_LIVING",
      brand: "",
      code: "",
      cutoffTime: "",
    },
  });

  const createMut = useCreateProperty();
  const updateMut = useUpdateProperty();

  // Brand options come from the admin-managed master (active brands only).
  const { data: brands = [] } = useQuery({
    queryKey: foodKeys.brands({ active: true }),
    queryFn: () => foodApi.listBrands({ active: true }),
    enabled: open,
  });

  // Unit-leads (UNIT_LEAD/WARDEN) taggable to this property.
  const { data: assignableLeads = [] } = useQuery({
    queryKey: foodKeys.assignableUnitLeads(),
    queryFn: () => foodApi.assignableUnitLeads(),
    enabled: open,
  });

  // On edit, fetch detail extras (current code, tagged unit-leads, cut-off override)
  // that the list payload doesn't carry, to prefill the form.
  const { data: detail } = useQuery({
    queryKey: foodKeys.propertyDetail(property?.id || ""),
    queryFn: () => foodApi.propertyDetail(property!.id),
    enabled: open && !!property?.id,
  });

  React.useEffect(() => {
    if (open) {
      if (property) {
        reset({
          name: property.name,
          address: property.address,
          city: property.city,
          state: property.state,
          pincode: property.pincode,
          totalBeds: property.totalBeds,
          phone: property.phone || "",
          email: property.email || "",
          status: (property.status as any) || "ACTIVE",
          portfolioType: (property.portfolioType as PortfolioType) || "CO_LIVING",
          brand: property.brand || "",
          code: (property as any).code || detail?.code || "",
          cutoffTime: detail?.cutoffTime || "",
        });
        setAmenities(property.amenities || []);
        setCoords({
          lat: property.lat ?? undefined,
          lng: property.lng ?? undefined,
        });
        setAttrs((property.portfolioAttributes as PortfolioAttributes) || {});
        setUnitLeadIds(detail?.unitLeadIds || []);
      } else {
        reset({
          name: "",
          address: "",
          city: "",
          state: "",
          pincode: "",
          totalBeds: 1,
          phone: "",
          email: "",
          status: "ACTIVE",
          portfolioType: "CO_LIVING",
          brand: "",
          code: "",
          cutoffTime: "",
        });
        setAmenities([]);
        setCoords({});
        setAttrs({});
        setUnitLeadIds([]);
      }
    }
  }, [open, property, detail, reset]);

  // Kitchen is auto-derived (read-only) from the pincode via kitchen_pincodes.
  const pincode = watch("pincode");
  const pincodeReady = /^\d{6}$/.test(pincode || "");
  const {
    data: kitchenLookup,
    isFetching: kitchenLoading,
  } = useQuery({
    queryKey: foodKeys.kitchenByPincode(pincode || ""),
    queryFn: () => foodApi.kitchenByPincode(pincode),
    enabled: open && pincodeReady,
    staleTime: 5 * 60_000,
  });
  // Resolved kitchen id (empty when no kitchen serves the pincode). This is the
  // value submitted; the server re-derives and re-validates it independently.
  const derivedKitchenId = kitchenLookup?.kitchenId ?? "";
  const noKitchenForPincode = pincodeReady && !kitchenLoading && !derivedKitchenId;

  const toggleAmenity = (a: string) =>
    setAmenities((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
    );

  // Forward geocode: build a query from the address fields and resolve coordinates
  // via the server (OSM/Nominatim proxy — sends the required UA, provider-swappable).
  const handleGeocode = async () => {
    const q = [
      watch("address"),
      watch("city"),
      watch("state"),
      watch("pincode"),
    ]
      .filter(Boolean)
      .join(", ");
    if (!q) {
      toast({ title: "Enter address first", variant: "destructive" });
      return;
    }
    setGeocoding(true);
    try {
      const res = await foodApi.geocodeForward(q);
      setCoords({ lat: res.lat, lng: res.lon });
      toast({ title: "Location found", description: res.displayName });
    } catch (e: any) {
      toast({
        title: "Location not found",
        description: e?.message,
        variant: "destructive",
      });
    } finally {
      setGeocoding(false);
    }
  };

  // Reverse geocode: turn the current lat/lng into an address + pincode and fill
  // the form fields (server proxy to OSM/Nominatim).
  const handleReverseGeocode = async () => {
    if (coords.lat === undefined || coords.lng === undefined) {
      toast({ title: "Enter coordinates first", variant: "destructive" });
      return;
    }
    setReverseGeocoding(true);
    try {
      const res = await foodApi.geocodeReverse(coords.lat, coords.lng);
      if (res.address) {
        setValue("address", res.address, { shouldValidate: true, shouldDirty: true });
      }
      if (res.pincode && /^\d{6}$/.test(res.pincode)) {
        setValue("pincode", res.pincode, { shouldValidate: true, shouldDirty: true });
      }
      toast({ title: "Address filled", description: res.displayName });
    } catch (e: any) {
      toast({
        title: "Address not found",
        description: e?.message,
        variant: "destructive",
      });
    } finally {
      setReverseGeocoding(false);
    }
  };

  const onSubmit = async (values: FormValues) => {
    // Kitchen must resolve from the pincode — without brand + kitchen we cannot
    // create a property. Block submit with a clear message if it's still loading
    // or no kitchen serves the pincode.
    if (kitchenLoading) {
      toast({ title: "Resolving kitchen for this pincode…", variant: "destructive" });
      return;
    }
    if (!derivedKitchenId) {
      toast({
        title: "No kitchen for this pincode",
        description: "No kitchen serves this pincode. Change the pincode or contact an admin.",
        variant: "destructive",
      });
      return;
    }
    const fields = portfolioAttrFields(values.portfolioType);
    const filteredAttrs: PortfolioAttributes = {};
    for (const k of fields) {
      const v = attrs[k];
      if (v === undefined || v === null || v === "") continue;
      // Each key narrows back to its own value type via PortfolioAttributes.
      (filteredAttrs[k] as PortfolioAttributes[typeof k]) =
        v as PortfolioAttributes[typeof k];
    }
    const body = {
      ...values,
      amenities,
      lat: coords.lat,
      lng: coords.lng,
      phone: values.phone || undefined,
      email: values.email || undefined,
      portfolioAttributes: filteredAttrs,
      brand: values.brand,
      kitchenId: derivedKitchenId,
      // Auto-generated server-side when blank; editable override otherwise.
      code: values.code?.trim() || undefined,
      // Per-property kitchen cut-off override (HH:MM) + tagged unit-leads. These
      // extra fields aren't in the generated body type, hence the cast below.
      cutoffTime: values.cutoffTime?.trim() || undefined,
      unitLeadIds,
    };
    try {
      if (isEdit && property) {
        await updateMut.mutateAsync({ id: property.id, data: body as any });
        toast({ title: "Property updated" });
      } else {
        await createMut.mutateAsync({ data: body as any });
        toast({ title: "Property created" });
      }
      queryClient.invalidateQueries({ queryKey: getGetPropertiesQueryKey() });
      // Tagging a unit-lead changes users.propertyId — refresh assignable list.
      queryClient.invalidateQueries({ queryKey: foodKeys.assignableUnitLeads() });
      if (property) {
        queryClient.invalidateQueries({
          queryKey: getGetPropertyQueryKey(property.id),
        });
        queryClient.invalidateQueries({ queryKey: foodKeys.propertyDetail(property.id) });
      }
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed to save", variant: "destructive" });
    }
  };

  const isSaving = createMut.isPending || updateMut.isPending;
  const status = watch("status");
  const portfolioType = watch("portfolioType");
  const attrFields = portfolioAttrFields(portfolioType);

  const setAttr = <K extends keyof PortfolioAttributes>(
    k: K,
    v: PortfolioAttributes[K] | undefined,
  ) => setAttrs((p) => ({ ...p, [k]: v }));

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit Property" : "Add Property"}
      onSave={handleSubmit(onSubmit)}
      isSaving={isSaving}
      saveLabel={isEdit ? "Save Changes" : "Create Property"}
    >
      <div className="space-y-4">
        <div>
          <Label>Name *</Label>
          <Input data-testid="input-property-name" {...register("name")} />
          {errors.name && (
            <p className="text-xs text-destructive mt-1">{errors.name.message}</p>
          )}
        </div>
        <div>
          <Label className="flex items-center gap-2">
            Property code
            {!isEdit && (
              <Badge variant="outline" className="text-[10px] font-normal">
                Auto
              </Badge>
            )}
          </Label>
          <Input
            data-testid="input-property-code"
            placeholder="PROP-BLR-001"
            {...register("code")}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            {isEdit
              ? "Editable. Leave unchanged to keep the existing code."
              : "Auto-generated from the city if left blank. You can override it."}
          </p>
        </div>
        <div>
          <Label>Portfolio Type *</Label>
          <Select
            value={portfolioType}
            onValueChange={(v) => setValue("portfolioType", v as PortfolioType)}
          >
            <SelectTrigger data-testid="select-property-portfolio-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PORTFOLIO_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {PORTFOLIO_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Brand *</Label>
          <Select
            value={watch("brand") || ""}
            onValueChange={(v) =>
              setValue("brand", v, { shouldValidate: true, shouldDirty: true })
            }
          >
            <SelectTrigger data-testid="select-property-brand">
              <SelectValue placeholder="Select brand" />
            </SelectTrigger>
            <SelectContent>
              {brands.map((b) => (
                <SelectItem key={b.id} value={b.code}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.brand && (
            <p className="text-xs text-destructive mt-1">{errors.brand.message}</p>
          )}
        </div>
        <div>
          <Label>Address *</Label>
          <Textarea data-testid="input-property-address" rows={2} {...register("address")} />
          {errors.address && (
            <p className="text-xs text-destructive mt-1">{errors.address.message}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>City *</Label>
            <Input data-testid="input-property-city" {...register("city")} />
            {errors.city && (
              <p className="text-xs text-destructive mt-1">{errors.city.message}</p>
            )}
          </div>
          <div>
            <Label>State *</Label>
            <Combobox
              options={STATE_OPTIONS}
              value={watch("state") || null}
              onChange={(v) =>
                setValue("state", v ?? "", {
                  shouldValidate: true,
                  shouldDirty: true,
                })
              }
              placeholder="Select state"
              searchPlaceholder="Search states…"
              emptyText="No state found."
            />
            {errors.state && (
              <p className="text-xs text-destructive mt-1">{errors.state.message}</p>
            )}
          </div>
          <div>
            <Label>Pincode *</Label>
            <Input
              data-testid="input-property-pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="560001"
              {...register("pincode", {
                onChange: (e) => {
                  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
                },
              })}
            />
            {errors.pincode && (
              <p className="text-xs text-destructive mt-1">{errors.pincode.message}</p>
            )}
          </div>
          <div>
            <Label>Kitchen *</Label>
            <div
              className="mt-1 flex h-10 items-center rounded-md border bg-surface px-3 text-sm"
              data-testid="display-property-kitchen"
            >
              {!pincodeReady ? (
                <span className="text-muted-foreground">Enter a 6-digit pincode</span>
              ) : kitchenLoading ? (
                <span className="flex items-center text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Resolving kitchen…
                </span>
              ) : derivedKitchenId ? (
                <span className="font-medium text-primary">
                  {kitchenLookup?.kitchenName}
                  {kitchenLookup?.kitchenCode ? ` (${kitchenLookup.kitchenCode})` : ""}
                </span>
              ) : (
                <span className="text-destructive">No kitchen for this pincode</span>
              )}
            </div>
            {noKitchenForPincode && (
              <p className="text-xs text-destructive mt-1">
                No kitchen serves this pincode. Change the pincode or contact an admin.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              Auto-derived from the pincode (read-only).
            </p>
          </div>
          <div>
            <Label>Total Beds *</Label>
            <div className="mt-1">
              <NumberStepper
                value={Number(watch("totalBeds")) || 0}
                onChange={(n) =>
                  setValue("totalBeds", n, {
                    shouldValidate: true,
                    shouldDirty: true,
                  })
                }
                min={0}
                aria-label="Total beds"
              />
            </div>
            {errors.totalBeds && (
              <p className="text-xs text-destructive mt-1">{errors.totalBeds.message}</p>
            )}
          </div>
          <div>
            <Label>Phone</Label>
            <Input data-testid="input-property-phone" type="tel" {...register("phone")} />
            {errors.phone && (
              <p className="text-xs text-destructive mt-1">{errors.phone.message}</p>
            )}
          </div>
          <div>
            <Label>Email</Label>
            <Input data-testid="input-property-email" {...register("email")} />
            {errors.email && (
              <p className="text-xs text-destructive mt-1">{errors.email.message}</p>
            )}
          </div>
        </div>
        <div>
          <Label>Status</Label>
          <Select
            value={status}
            onValueChange={(v) => setValue("status", v as any)}
          >
            <SelectTrigger data-testid="select-property-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="INACTIVE">Inactive</SelectItem>
              <SelectItem value="UNDER_RENOVATION">Under Renovation</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Kitchen order cut-off time</Label>
          <Input
            data-testid="input-property-cutoff"
            type="time"
            {...register("cutoffTime")}
          />
          {errors.cutoffTime && (
            <p className="text-xs text-destructive mt-1">{errors.cutoffTime.message}</p>
          )}
          <p className="text-[11px] text-muted-foreground mt-1">
            Per-property override for this property&apos;s brand. Leave blank to use
            the brand / global default.
          </p>
        </div>

        <div>
          <Label>Unit leads</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
            Tag Unit-Lead / Warden users to this property.
          </p>
          {assignableLeads.length === 0 ? (
            <p className="text-xs text-muted-foreground">No assignable users.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
              {assignableLeads.map((u) => {
                const checked = unitLeadIds.includes(u.id);
                // Already tagged to a DIFFERENT property — flag so the admin knows
                // selecting will move them here.
                const elsewhere =
                  !!u.propertyId && property?.id !== u.propertyId && !checked;
                return (
                  <label
                    key={u.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface"
                    data-testid={`unit-lead-option-${u.id}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setUnitLeadIds((prev) =>
                          v ? [...prev, u.id] : prev.filter((x) => x !== u.id),
                        )
                      }
                    />
                    <span className="flex-1">
                      {u.name}
                      <span className="text-muted-foreground"> · {u.role}</span>
                    </span>
                    {elsewhere && (
                      <Badge variant="outline" className="text-[10px] font-normal">
                        Tagged elsewhere
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {attrFields.length > 0 && (
          <div className="border-t pt-4">
            <Label className="mb-2 block">
              {PORTFOLIO_TYPE_LABELS[portfolioType]} Details
            </Label>
            <div className="grid grid-cols-2 gap-3">
              {attrFields.includes("institutionAffiliation") && (
                <div className="col-span-2">
                  <Label className="text-xs">Institution Affiliation</Label>
                  <Input
                    data-testid="input-attr-institution"
                    value={attrs.institutionAffiliation || ""}
                    onChange={(e) => setAttr("institutionAffiliation", e.target.value)}
                  />
                </div>
              )}
              {attrFields.includes("academicYear") && (
                <div>
                  <Label className="text-xs">Academic Year</Label>
                  <Input
                    data-testid="input-attr-academic-year"
                    placeholder="2025-26"
                    value={attrs.academicYear || ""}
                    onChange={(e) => setAttr("academicYear", e.target.value)}
                  />
                </div>
              )}
              {attrFields.includes("gender") && (
                <div>
                  <Label className="text-xs">Gender</Label>
                  <Select
                    value={attrs.gender || ""}
                    onValueChange={(v) =>
                      setAttr("gender", v as PortfolioAttributes["gender"])
                    }
                  >
                    <SelectTrigger data-testid="select-attr-gender">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MALE">Male</SelectItem>
                      <SelectItem value="FEMALE">Female</SelectItem>
                      <SelectItem value="COED">Co-ed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {attrFields.includes("mealPlanIncluded") && (
                <div className="flex items-center gap-2 mt-6">
                  <Checkbox
                    id="meal-plan-included"
                    data-testid="checkbox-attr-meal-plan"
                    checked={!!attrs.mealPlanIncluded}
                    onCheckedChange={(v) => setAttr("mealPlanIncluded", !!v)}
                  />
                  <Label htmlFor="meal-plan-included" className="text-sm">
                    Meal plan included
                  </Label>
                </div>
              )}
              {attrFields.includes("mealPlanDetails") && (
                <div className="col-span-2">
                  <Label className="text-xs">Meal Plan Details</Label>
                  <Input
                    data-testid="input-attr-meal-plan-details"
                    placeholder="e.g. 2 meals/day, vegetarian"
                    value={attrs.mealPlanDetails || ""}
                    onChange={(e) => setAttr("mealPlanDetails", e.target.value)}
                  />
                </div>
              )}
              {attrFields.includes("nightlyRate") && (
                <div>
                  <Label className="text-xs">Nightly Rate (₹)</Label>
                  <Input
                    data-testid="input-attr-nightly-rate"
                    type="number"
                    min={0}
                    value={attrs.nightlyRate ?? ""}
                    onChange={(e) =>
                      setAttr(
                        "nightlyRate",
                        e.target.value === "" ? undefined : Number(e.target.value)
                      )
                    }
                  />
                </div>
              )}
              {attrFields.includes("weeklyRate") && (
                <div>
                  <Label className="text-xs">Weekly Rate (₹)</Label>
                  <Input
                    data-testid="input-attr-weekly-rate"
                    type="number"
                    min={0}
                    value={attrs.weeklyRate ?? ""}
                    onChange={(e) =>
                      setAttr(
                        "weeklyRate",
                        e.target.value === "" ? undefined : Number(e.target.value)
                      )
                    }
                  />
                </div>
              )}
              {attrFields.includes("deskCapacity") && (
                <div>
                  <Label className="text-xs">Desk Capacity</Label>
                  <div className="mt-1">
                    <NumberStepper
                      aria-label="Desk capacity"
                      value={attrs.deskCapacity ?? 0}
                      min={0}
                      onChange={(n) => setAttr("deskCapacity", n)}
                    />
                  </div>
                </div>
              )}
              {attrFields.includes("privateOfficeCount") && (
                <div>
                  <Label className="text-xs">Private Offices</Label>
                  <div className="mt-1">
                    <NumberStepper
                      aria-label="Private offices"
                      value={attrs.privateOfficeCount ?? 0}
                      min={0}
                      onChange={(n) => setAttr("privateOfficeCount", n)}
                    />
                  </div>
                </div>
              )}
              {attrFields.includes("seatCapacity") && (
                <div>
                  <Label className="text-xs">Seat Capacity</Label>
                  <div className="mt-1">
                    <NumberStepper
                      aria-label="Seat capacity"
                      value={attrs.seatCapacity ?? 0}
                      min={0}
                      onChange={(n) => setAttr("seatCapacity", n)}
                    />
                  </div>
                </div>
              )}
              {attrFields.includes("leaseTermMonths") && (
                <div>
                  <Label className="text-xs">Lease Term (months)</Label>
                  <div className="mt-1">
                    <NumberStepper
                      aria-label="Lease term in months"
                      value={attrs.leaseTermMonths ?? 0}
                      min={0}
                      onChange={(n) => setAttr("leaseTermMonths", n)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <Label>Amenities</Label>
          <div className="flex flex-wrap gap-2 mt-2">
            {AMENITIES.map((a) => {
              const active = amenities.includes(a);
              return (
                <Badge
                  key={a}
                  data-testid={`chip-amenity-${a}`}
                  variant={active ? "default" : "outline"}
                  className={`cursor-pointer select-none ${
                    active ? "bg-accent text-white hover:bg-accent/90" : ""
                  }`}
                  onClick={() => toggleAmenity(a)}
                >
                  {a}
                </Badge>
              );
            })}
          </div>
        </div>
        <div className="border-t pt-4">
          <Label className="flex items-center gap-1.5 mb-2">
            <MapPin className="w-4 h-4" /> Location
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Latitude</Label>
              <Input
                data-testid="input-property-lat"
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="12.9716"
                value={coords.lat ?? ""}
                onChange={(e) =>
                  setCoords((c) => ({
                    ...c,
                    lat: e.target.value === "" ? undefined : Number(e.target.value),
                  }))
                }
              />
            </div>
            <div>
              <Label className="text-xs">Longitude</Label>
              <Input
                data-testid="input-property-lng"
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="77.5946"
                value={coords.lng ?? ""}
                onChange={(e) =>
                  setCoords((c) => ({
                    ...c,
                    lng: e.target.value === "" ? undefined : Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGeocode}
              disabled={geocoding}
              data-testid="button-geocode-address"
            >
              {geocoding && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Fetch coordinates from address
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReverseGeocode}
              disabled={
                reverseGeocoding ||
                coords.lat === undefined ||
                coords.lng === undefined
              }
              data-testid="button-reverse-geocode"
            >
              {reverseGeocoding && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Use these coordinates to fill address
            </Button>
          </div>
          {coords.lat !== undefined && coords.lng !== undefined ? (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-2 font-mono">
                Lat: {coords.lat.toFixed(6)}, Lng: {coords.lng.toFixed(6)}
              </p>
              <iframe
                title="map"
                src={`https://www.openstreetmap.org/export/embed.html?bbox=${coords.lng - 0.005}%2C${coords.lat - 0.005}%2C${coords.lng + 0.005}%2C${coords.lat + 0.005}&layer=mapnik&marker=${coords.lat}%2C${coords.lng}`}
                className="w-full h-48 rounded-lg border"
              />
            </div>
          ) : (
            <div className="mt-3 w-full h-32 rounded-lg border border-dashed bg-surface flex items-center justify-center text-xs text-muted-foreground">
              Enter coordinates or fetch them from the address
            </div>
          )}
        </div>

        {isEdit && property && (
          <PropertyPhotosManager
            propertyId={property.id}
            className="border-t pt-4"
          />
        )}
      </div>
    </FormModal>
  );
}
