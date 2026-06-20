import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
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
  const [attrs, setAttrs] = React.useState<PortfolioAttributes>({});

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
    },
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
        });
        setAmenities(property.amenities || []);
        setCoords({
          lat: property.lat ?? undefined,
          lng: property.lng ?? undefined,
        });
        setAttrs((property.portfolioAttributes as PortfolioAttributes) || {});
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
        });
        setAmenities([]);
        setCoords({});
        setAttrs({});
      }
    }
  }, [open, property, reset]);

  const createMut = useCreateProperty();
  const updateMut = useUpdateProperty();

  const toggleAmenity = (a: string) =>
    setAmenities((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
    );

  const handleGeocode = async () => {
    const address = watch("address");
    const city = watch("city");
    const state = watch("state");
    const q = [address, city, state].filter(Boolean).join(", ");
    if (!q) {
      toast({ title: "Enter address first", variant: "destructive" });
      return;
    }
    setGeocoding(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`,
        { headers: { "User-Agent": "UnilivAdmin/1.0" } as any }
      );
      const json = await res.json();
      if (json && json[0]) {
        setCoords({ lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) });
        toast({ title: "Location found" });
      } else {
        toast({ title: "Location not found", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Geocoding failed", variant: "destructive" });
    } finally {
      setGeocoding(false);
    }
  };

  const onSubmit = async (values: FormValues) => {
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
    };
    try {
      if (isEdit && property) {
        await updateMut.mutateAsync({ id: property.id, data: body });
        toast({ title: "Property updated" });
      } else {
        await createMut.mutateAsync({ data: body });
        toast({ title: "Property created" });
      }
      queryClient.invalidateQueries({ queryKey: getGetPropertiesQueryKey() });
      if (property) {
        queryClient.invalidateQueries({
          queryKey: getGetPropertyQueryKey(property.id),
        });
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
          <div className="flex items-center justify-between mb-2">
            <Label className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4" /> Location
            </Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGeocode}
              disabled={geocoding}
              data-testid="button-geocode-address"
            >
              {geocoding && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Geocode address
            </Button>
          </div>
          {coords.lat && coords.lng ? (
            <>
              <p className="text-xs text-muted-foreground mb-2 font-mono">
                Lat: {coords.lat.toFixed(6)}, Lng: {coords.lng.toFixed(6)}
              </p>
              <iframe
                title="map"
                src={`https://www.openstreetmap.org/export/embed.html?bbox=${coords.lng - 0.005}%2C${coords.lat - 0.005}%2C${coords.lng + 0.005}%2C${coords.lat + 0.005}&layer=mapnik&marker=${coords.lat}%2C${coords.lng}`}
                className="w-full h-48 rounded-lg border"
              />
            </>
          ) : (
            <div className="w-full h-32 rounded-lg border border-dashed bg-surface flex items-center justify-center text-xs text-muted-foreground">
              Click Geocode to fetch coordinates
            </div>
          )}
        </div>
      </div>
    </FormModal>
  );
}
