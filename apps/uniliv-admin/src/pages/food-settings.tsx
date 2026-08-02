import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, UtensilsCrossed, CalendarRange, Scale, Truck,
  Network, ShieldCheck, Building2, MapPin, Layers, Globe, ChevronDown,
  ChefHat, ListChecks, Clock, Phone, Boxes, SlidersHorizontal,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { TimePicker } from "@/components/ui/time-picker";
import { NumberStepper } from "@/components/ui/number-stepper";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, fmtQty,
  type Dish, type PerResidentRule,
  type Agency, type AgencyVehicle, type AgencyLocation,
  type Zone, type City, type Cluster, type UserScope, type FoodUser, type FoodLookups,
  type FoodBrand, type MealType, type Kitchen, type MealConfig, type MealWindow, type FoodCutoffConfig,
  type Ingredient, type FoodDefaults,
} from "@/lib/food-api";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { DishesCatalogue } from "@/components/food/dishes-catalogue";
import { IngredientsGrid } from "@/components/food/ingredients-grid";
import { RotationBoard } from "@/components/food/rotation-board";
import { MenuRulesEditor } from "@/components/food/menu-rules";
import { useActiveBrands } from "@/components/food/use-food-masters";

// ─── Enums (from spec) ────────────────────────────────────────────────────────
const UNITS = ["G", "KG", "ML", "LITRE", "PCS", "PLATE", "SERVING"];
const SCOPE_LEVELS = ["GLOBAL", "ZONE", "CITY", "CLUSTER", "PROPERTY"];

const labelize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Small confirm-delete helper modal
function ConfirmDelete({
  open, onOpenChange, label, onConfirm, isDeleting,
}: { open: boolean; onOpenChange: (o: boolean) => void; label: string; onConfirm: () => void; isDeleting: boolean }) {
  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Confirm Delete"
      onSave={onConfirm}
      isSaving={isDeleting}
      saveLabel="Delete"
    >
      <p className="text-sm text-muted-foreground">
        Are you sure you want to delete <span className="font-medium text-foreground">{label}</span>? This action cannot be undone.
      </p>
    </FormModal>
  );
}

// Row-action cell shared across tables
function RowActions({ onEdit, onDelete }: { onEdit?: () => void; onDelete?: () => void }) {
  return (
    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {onEdit && (
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} title="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={onDelete} title="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * Settings navigation, split by how often a tab is actually used.
 *
 * PRIMARY is the day-to-day menu-building loop and stays visible: the catalogue
 * (Dishes, Ingredients) and the two screens that turn it into a menu (Rotation,
 * Rules).
 *
 * Portion Size Rules used to sit here, because a dish without one is a dish the
 * kitchen is never told to cook. That reason is gone — portions are now edited
 * on the dish itself, in the Dishes drawer — so the standalone tab is demoted to
 * what it's now good for: reviewing and bulk-fixing portions across dishes.
 *
 * SECONDARY is configured once and rarely revisited, so it folds behind "More".
 */
type SettingsTab = { value: string; label: string; icon: typeof Globe; gated?: boolean };

const PRIMARY_TABS: SettingsTab[] = [
  { value: "dishes", label: "Dishes", icon: UtensilsCrossed },
  { value: "ingredients", label: "Ingredients", icon: Boxes },
  { value: "rotation", label: "Menu Rotation", icon: CalendarRange },
  { value: "composition", label: "Menu Rules", icon: SlidersHorizontal },
];

const SECONDARY_GROUPS: { label: string; items: SettingsTab[] }[] = [
  {
    label: "Kitchen and service",
    items: [
      { value: "rules", label: "Portion Size Rules", icon: Scale },
      { value: "kitchens", label: "Kitchens", icon: ChefHat },
      { value: "meals", label: "Meal Types", icon: ListChecks },
      { value: "cutoffs", label: "Cut-offs & Service", icon: Clock },
      { value: "partners", label: "Agencies", icon: Truck },
    ],
  },
  {
    label: "Access",
    items: [
      { value: "hierarchy", label: "Hierarchy", icon: Network },
      { value: "users", label: "Users & Scopes", icon: ShieldCheck },
    ],
  },
  {
    // Org-wide defaults — Super Admin and F&B Manager only (see canFoodDefaults).
    label: "Advanced",
    items: [
      { value: "food-defaults", label: "Food Defaults", icon: Globe, gated: true },
    ],
  },
];

export default function FoodSettings() {
  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name ?? "—") : "—";
  const { role } = usePermissions();
  const isSuperAdmin = isSuperAdminRole(role);
  // Food Defaults are org-wide (default cut-off + waste edit window). F&B Manager
  // leads food ops org-wide, so they get the tab too (backend PUT mirrors this).
  const canFoodDefaults = isSuperAdmin || role === "FNB_MANAGER";

  // Controlled so the "More" dropdown can drive the same Tabs root.
  const [tab, setTab] = React.useState("dishes");
  const activeSecondary = SECONDARY_GROUPS.flatMap((g) => g.items).find((it) => it.value === tab);

  // No PageHeader: every tab already opens with its own heading and one-line
  // explanation, so a page-level title only pushed the tab strip down and
  // repeated what the sidebar already says.
  return (
    <div className="space-y-6">
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="sticky top-0 z-10 -mx-1 bg-background px-1 pb-1">
          {/* The "More" trigger sits OUTSIDE TabsList — Radix's tab list owns
              roving focus and swallows pointer/keyboard events for any child
              that isn't a TabsTrigger, so a DropdownMenuTrigger nested inside
              it never opens. The wrapper carries the muted pill styling so the
              two still read as one strip. */}
          <div className="inline-flex max-w-full items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground">
            <TabsList className="flex h-auto flex-nowrap justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {PRIMARY_TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value} className="shrink-0 whitespace-nowrap">
                  <Icon className="h-4 w-4 mr-2" /> {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {/* Everything below is configured once and rarely revisited, so it
                lives behind one trigger. The trigger names the active item and
                renders selected — otherwise a tab inside a dropdown leaves you
                unsure where you are. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={activeSecondary ? `More settings, ${activeSecondary.label} selected` : "More settings"}
                  className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeSecondary ? "bg-background text-foreground shadow" : ""}`}
                >
                  {activeSecondary
                    ? <><activeSecondary.icon className="h-4 w-4 mr-2" /> More · {activeSecondary.label}</>
                    : <>More</>}
                  <ChevronDown className="h-4 w-4 ml-1.5 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {SECONDARY_GROUPS.map((group, gi) => {
                  const items = group.items.filter((it) => !it.gated || canFoodDefaults);
                  if (!items.length) return null;
                  return (
                    <React.Fragment key={group.label}>
                      {gi > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{group.label}</DropdownMenuLabel>
                      {items.map(({ value, label, icon: Icon }) => (
                        <DropdownMenuItem
                          key={value}
                          onSelect={() => setTab(value)}
                          className={tab === value ? "bg-accent/10 font-medium text-accent-strong" : ""}
                        >
                          <Icon className="h-4 w-4 mr-2 text-muted-foreground" /> {label}
                        </DropdownMenuItem>
                      ))}
                    </React.Fragment>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* The four menu-building tabs mount lazily — the rotation board and the
            plate composer each pull the whole dish catalogue, which is wasted
            work on a visit to, say, Agencies. */}
        <TabsContent value="dishes"><DishesCatalogue /></TabsContent>
        <TabsContent value="ingredients"><IngredientsGrid /></TabsContent>
        <TabsContent value="rotation"><RotationBoard /></TabsContent>
        <TabsContent value="composition"><MenuRulesEditor /></TabsContent>
        <TabsContent value="rules"><RulesTab /></TabsContent>
        <TabsContent value="partners"><AgenciesTab /></TabsContent>
        <TabsContent value="kitchens"><KitchensTab /></TabsContent>
        <TabsContent value="meals"><MealTypesTab /></TabsContent>
        <TabsContent value="cutoffs"><CutoffWindowsTab properties={properties} propName={propName} /></TabsContent>
        <TabsContent value="hierarchy"><HierarchyTab properties={properties} /></TabsContent>
        <TabsContent value="users"><UsersTab properties={properties} propName={propName} /></TabsContent>
        {canFoodDefaults && (
          <TabsContent value="food-defaults"><FoodDefaultsTab /></TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3) PER-RESIDENT RULES
// ════════════════════════════════════════════════════════════════════════════
type RuleForm = {
  brand: FoodBrand; mealType: MealType; dishId: string;
  qtyPerResident: string; unit: string;
};
const emptyRule: RuleForm = {
  brand: "UNILIV", mealType: "BREAKFAST", dishId: "", qtyPerResident: "", unit: "SERVING",
};

function RulesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [brand, setBrand] = React.useState("ALL");
  const [meal, setMeal] = React.useState("ALL");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PerResidentRule | null>(null);
  const [delTarget, setDelTarget] = React.useState<PerResidentRule | null>(null);
  const [form, setForm] = React.useState<RuleForm>(emptyRule);

  const params: Record<string, unknown> = { brand, mealType: meal };
  const { data: rules = [], isLoading } = useQuery<PerResidentRule[]>({
    queryKey: foodKeys.rules(params),
    queryFn: () => foodApi.listRules(params),
  });
  const { data: dishes = [] } = useQuery<Dish[]>({ queryKey: foodKeys.dishes({}), queryFn: () => foodApi.listDishes() });
  const dishName = (id: string) => dishes.find((d) => d.id === id)?.name ?? id;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "rules"] });

  const saveMut = useMutation({
    mutationFn: (v: RuleForm) => {
      const body: Record<string, unknown> = {
        brand: v.brand, mealType: v.mealType, dishId: v.dishId,
        qtyPerResident: v.qtyPerResident, unit: v.unit,
      };
      return editing ? foodApi.updateRule(editing.id, body) : foodApi.createRule(body);
    },
    onSuccess: () => { toast({ title: editing ? "Rule updated" : "Rule created" }); invalidate(); setModalOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteRule(id),
    onSuccess: () => { toast({ title: "Rule deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyRule); setModalOpen(true); };
  const openEdit = (r: PerResidentRule) => {
    setEditing(r);
    setForm({ brand: r.brand, mealType: r.mealType, dishId: r.dishId, qtyPerResident: String(r.qtyPerResident ?? ""), unit: r.unit });
    setModalOpen(true);
  };
  const submit = () => {
    if (!form.dishId) { toast({ title: "Dish is required", variant: "destructive" }); return; }
    if (!form.qtyPerResident) { toast({ title: "Qty per resident is required", variant: "destructive" }); return; }
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "brand", header: "Brand", cell: ({ row }: any) => <Badge variant="outline" className="text-[10px]">{row.original.brand}</Badge> },
    { accessorKey: "mealType", header: "Meal", cell: ({ row }: any) => MEAL_LABEL[row.original.mealType as MealType] ?? row.original.mealType },
    { accessorKey: "dishId", header: "Dish", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.dishName ?? dishName(row.original.dishId)}</span> },
    { accessorKey: "qtyPerResident", header: "Qty / Resident", cell: ({ row }: any) => <span className="font-medium">{fmtQty(row.original.qtyPerResident, row.original.unit)}</span> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Portion Size Rules" description="Default quantity per resident for each brand + meal + dish."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Rule</Button>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={meal} onValueChange={setMeal}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Meals</SelectItem>
            {MEAL_TYPES.map((m) => <SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={cols as any} data={rules} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Rule" : "Add Rule"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create Rule"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Brand</Label>
              <Select value={form.brand} onValueChange={(v) => setForm({ ...form, brand: v as FoodBrand })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Meal</Label>
              <Select value={form.mealType} onValueChange={(v) => setForm({ ...form, mealType: v as MealType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{MEAL_TYPES.map((m) => <SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Dish *</Label>
            <Select value={form.dishId} onValueChange={(v) => setForm({ ...form, dishId: v })}>
              <SelectTrigger><SelectValue placeholder="Select dish" /></SelectTrigger>
              <SelectContent>{dishes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Qty per Resident *</Label>
              <Input type="number" step="any" value={form.qtyPerResident} onChange={(e) => setForm({ ...form, qtyPerResident: e.target.value })} />
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget ? `${delTarget.dishName ?? dishName(delTarget.dishId)} rule` : ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 4) DELIVERY PARTNERS
// ════════════════════════════════════════════════════════════════════════════
const VEHICLE_TYPES = ["VAN", "BIKE", "TRUCK", "CAR", "TEMPO", "OTHER"];

function AgenciesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: agencies = [], isLoading } = useQuery<Agency[]>({ queryKey: foodKeys.agencies(), queryFn: () => foodApi.listAgencies() });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["food", "agencies"] }); qc.invalidateQueries({ queryKey: foodKeys.lookups() }); };

  // Agency modal
  const [agOpen, setAgOpen] = React.useState(false);
  const [agEdit, setAgEdit] = React.useState<Agency | null>(null);
  const [agForm, setAgForm] = React.useState({ name: "", phone: "", contactName: "", email: "" });
  const [agDel, setAgDel] = React.useState<Agency | null>(null);
  // Vehicle modal
  const [vOpen, setVOpen] = React.useState(false);
  const [vAgencyId, setVAgencyId] = React.useState("");
  const [vEdit, setVEdit] = React.useState<AgencyVehicle | null>(null);
  const [vForm, setVForm] = React.useState({ vehicleNumber: "", vehicleType: "VAN" });
  // Location modal
  const [lOpen, setLOpen] = React.useState(false);
  const [lAgencyId, setLAgencyId] = React.useState("");
  const [lEdit, setLEdit] = React.useState<AgencyLocation | null>(null);
  const [lForm, setLForm] = React.useState({ name: "", city: "", address: "", contactPhone: "" });

  const agSave = useMutation({
    mutationFn: () => { const b = { name: agForm.name, phone: agForm.phone || null, contactName: agForm.contactName || null, email: agForm.email || null }; return agEdit ? foodApi.updateAgency(agEdit.id, b) : foodApi.createAgency(b); },
    onSuccess: () => { toast({ title: agEdit ? "Agency updated" : "Agency created" }); invalidate(); setAgOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const agDelMut = useMutation({ mutationFn: (id: string) => foodApi.deleteAgency(id), onSuccess: () => { toast({ title: "Agency deactivated" }); invalidate(); setAgDel(null); }, onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }) });
  const vSave = useMutation({
    mutationFn: () => { const b = { vehicleNumber: vForm.vehicleNumber, vehicleType: vForm.vehicleType }; return vEdit ? foodApi.updateAgencyVehicle(vEdit.id, b) : foodApi.createAgencyVehicle(vAgencyId, b); },
    onSuccess: () => { toast({ title: vEdit ? "Vehicle updated" : "Vehicle added" }); invalidate(); setVOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const vDel = useMutation({ mutationFn: (id: string) => foodApi.deleteAgencyVehicle(id), onSuccess: () => { toast({ title: "Vehicle removed" }); invalidate(); }, onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }) });
  const lSave = useMutation({
    mutationFn: () => { const b = { name: lForm.name, city: lForm.city || null, address: lForm.address || null, contactPhone: lForm.contactPhone || null }; return lEdit ? foodApi.updateAgencyLocation(lEdit.id, b) : foodApi.createAgencyLocation(lAgencyId, b); },
    onSuccess: () => { toast({ title: lEdit ? "Location updated" : "Location added" }); invalidate(); setLOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const lDel = useMutation({ mutationFn: (id: string) => foodApi.deleteAgencyLocation(id), onSuccess: () => { toast({ title: "Location removed" }); invalidate(); }, onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }) });

  const openAgCreate = () => { setAgEdit(null); setAgForm({ name: "", phone: "", contactName: "", email: "" }); setAgOpen(true); };
  const openAgEdit = (a: Agency) => { setAgEdit(a); setAgForm({ name: a.name, phone: a.phone ?? "", contactName: a.contactName ?? "", email: a.email ?? "" }); setAgOpen(true); };
  const openVCreate = (agencyId: string) => { setVEdit(null); setVAgencyId(agencyId); setVForm({ vehicleNumber: "", vehicleType: "VAN" }); setVOpen(true); };
  const openVEdit = (v: AgencyVehicle) => { setVEdit(v); setVAgencyId(v.agencyId); setVForm({ vehicleNumber: v.vehicleNumber, vehicleType: v.vehicleType }); setVOpen(true); };
  const openLCreate = (agencyId: string) => { setLEdit(null); setLAgencyId(agencyId); setLForm({ name: "", city: "", address: "", contactPhone: "" }); setLOpen(true); };
  const openLEdit = (l: AgencyLocation) => { setLEdit(l); setLAgencyId(l.agencyId); setLForm({ name: l.name, city: l.city ?? "", address: l.address ?? "", contactPhone: l.contactPhone ?? "" }); setLOpen(true); };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Delivery Agencies" description="Agencies that fulfil dispatch — each with multiple locations and vehicles. A dispatch picks an agency, then a vehicle."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openAgCreate}><Plus className="h-4 w-4 mr-2" /> Add Agency</Button>}
      />
      {isLoading ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        : agencies.length === 0 ? <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">No agencies yet.</p>
        : agencies.map((a) => (
          <Card key={a.id}>
            <CardHeader className="flex flex-row items-start justify-between pb-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base"><Truck className="h-4 w-4 text-muted-foreground" /> {a.name} {!a.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}</CardTitle>
                <CardDescription className="text-xs">{[a.contactName, a.phone, a.email].filter(Boolean).join(" · ") || "No contact"}</CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openAgEdit(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setAgDel(a)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">Vehicles ({a.vehicles?.length ?? 0})</span><Button variant="outline" size="sm" className="h-7" onClick={() => openVCreate(a.id)}><Plus className="h-3 w-3 mr-1" /> Add</Button></div>
                <div className="space-y-1">
                  {(a.vehicles ?? []).length === 0 && <p className="text-xs text-muted-foreground">No vehicles.</p>}
                  {(a.vehicles ?? []).map((v) => (
                    <div key={v.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                      <span className="font-mono text-xs">{v.vehicleNumber}</span>
                      <Badge variant="outline" className="text-[10px]">{v.vehicleType}</Badge>
                      <div className="ml-auto flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openVEdit(v)}><Pencil className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => vDel.mutate(v.id)}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">Locations ({a.locations?.length ?? 0})</span><Button variant="outline" size="sm" className="h-7" onClick={() => openLCreate(a.id)}><Plus className="h-3 w-3 mr-1" /> Add</Button></div>
                <div className="space-y-1">
                  {(a.locations ?? []).length === 0 && <p className="text-xs text-muted-foreground">No locations.</p>}
                  {(a.locations ?? []).map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                      <span className="text-xs">{l.name}{l.city ? ` · ${l.city}` : ""}</span>
                      <div className="ml-auto flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openLEdit(l)}><Pencil className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => lDel.mutate(l.id)}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

      <FormModal open={agOpen} onOpenChange={setAgOpen} title={agEdit ? "Edit Agency" : "Add Agency"} onSave={() => { if (!agForm.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; } agSave.mutate(); }} isSaving={agSave.isPending} saveLabel={agEdit ? "Save" : "Create"}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={agForm.name} onChange={(e) => setAgForm({ ...agForm, name: e.target.value })} placeholder="e.g. Swift Logistics" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Contact name</Label><Input value={agForm.contactName} onChange={(e) => setAgForm({ ...agForm, contactName: e.target.value })} /></div>
            <div><Label>Phone</Label><Input value={agForm.phone} onChange={(e) => setAgForm({ ...agForm, phone: e.target.value })} className="font-mono" /></div>
          </div>
          <div><Label>Email</Label><Input type="email" value={agForm.email} onChange={(e) => setAgForm({ ...agForm, email: e.target.value })} /></div>
        </div>
      </FormModal>

      <FormModal open={vOpen} onOpenChange={setVOpen} title={vEdit ? "Edit Vehicle" : "Add Vehicle"} onSave={() => { if (!vForm.vehicleNumber.trim()) { toast({ title: "Vehicle number required", variant: "destructive" }); return; } vSave.mutate(); }} isSaving={vSave.isPending} saveLabel={vEdit ? "Save" : "Add"}>
        <div className="space-y-4">
          <div><Label>Vehicle Number *</Label><Input value={vForm.vehicleNumber} onChange={(e) => setVForm({ ...vForm, vehicleNumber: e.target.value })} className="font-mono" placeholder="KA05AB1234" /></div>
          <div><Label>Type</Label>
            <Select value={vForm.vehicleType} onValueChange={(v) => setVForm({ ...vForm, vehicleType: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{VEHICLE_TYPES.map((t) => <SelectItem key={t} value={t}>{labelize(t)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      <FormModal open={lOpen} onOpenChange={setLOpen} title={lEdit ? "Edit Location" : "Add Location"} onSave={() => { if (!lForm.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; } lSave.mutate(); }} isSaving={lSave.isPending} saveLabel={lEdit ? "Save" : "Add"}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={lForm.name} onChange={(e) => setLForm({ ...lForm, name: e.target.value })} placeholder="e.g. Koramangala Hub" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>City</Label><Input value={lForm.city} onChange={(e) => setLForm({ ...lForm, city: e.target.value })} /></div>
            <div><Label>Phone</Label><Input value={lForm.contactPhone} onChange={(e) => setLForm({ ...lForm, contactPhone: e.target.value })} className="font-mono" /></div>
          </div>
          <div><Label>Address</Label><Input value={lForm.address} onChange={(e) => setLForm({ ...lForm, address: e.target.value })} /></div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!agDel} onOpenChange={(o) => !o && setAgDel(null)} label={agDel?.name ?? ""} onConfirm={() => agDel && agDelMut.mutate(agDel.id)} isDeleting={agDelMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 5) KITCHENS
// ════════════════════════════════════════════════════════════════════════════
type KitchenForm = {
  name: string; code: string; brand: string; address: string; city: string;
  state: string; pincode: string; contactName: string; contactPhone: string; contactEmail: string;
};
const emptyKitchen: KitchenForm = {
  name: "", code: "", brand: "__SHARED__", address: "", city: "",
  state: "", pincode: "", contactName: "", contactPhone: "", contactEmail: "",
};

function KitchensTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Kitchen | null>(null);
  const [delTarget, setDelTarget] = React.useState<Kitchen | null>(null);
  const [form, setForm] = React.useState<KitchenForm>(emptyKitchen);

  const { data: kitchens = [], isLoading } = useQuery<Kitchen[]>({
    queryKey: foodKeys.kitchens({}),
    queryFn: () => foodApi.listKitchens(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "kitchens"] });

  const saveMut = useMutation({
    mutationFn: (v: KitchenForm) => {
      const body: Record<string, unknown> = {
        name: v.name.trim(),
        code: v.code.trim(),
        brand: v.brand === "__SHARED__" ? null : v.brand,
        address: v.address.trim() || null,
        city: v.city.trim() || null,
        state: v.state.trim() || null,
        pincode: v.pincode.trim() || null,
        contactName: v.contactName.trim() || null,
        contactPhone: v.contactPhone.trim() || null,
        contactEmail: v.contactEmail.trim() || null,
      };
      return editing ? foodApi.updateKitchen(editing.id, body) : foodApi.createKitchen(body);
    },
    onSuccess: () => { toast({ title: editing ? "Kitchen updated" : "Kitchen created" }); invalidate(); setModalOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteKitchen(id),
    onSuccess: () => { toast({ title: "Kitchen deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyKitchen); setModalOpen(true); };
  const openEdit = (k: Kitchen) => {
    setEditing(k);
    setForm({
      name: k.name, code: k.code, brand: k.brand ?? "__SHARED__",
      address: k.address ?? "", city: k.city ?? "", state: k.state ?? "",
      pincode: k.pincode ?? "", contactName: k.contactName ?? "", contactPhone: k.contactPhone ?? "", contactEmail: k.contactEmail ?? "",
    });
    setModalOpen(true);
  };
  const submit = () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (!form.code.trim()) { toast({ title: "Code is required", variant: "destructive" }); return; }
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "code", header: "Code", cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.code}</span> },
    { accessorKey: "name", header: "Name", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "brand", header: "Brand", cell: ({ row }: any) => row.original.brand
        ? <Badge variant="outline" className="text-[10px]">{row.original.brand}</Badge>
        : <Badge variant="secondary" className="text-[10px]">SHARED</Badge> },
    { accessorKey: "city", header: "City", cell: ({ row }: any) => row.original.city
        ? <span className="text-sm inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-muted-foreground" />{row.original.city}</span>
        : <span className="text-muted-foreground text-xs">—</span> },
    { id: "contact", header: "Contact", cell: ({ row }: any) => (row.original.contactName || row.original.contactPhone)
        ? (
          <div className="flex flex-col leading-tight">
            {row.original.contactName && <span className="text-sm">{row.original.contactName}</span>}
            {row.original.contactPhone && <span className="font-mono text-[11px] text-muted-foreground inline-flex items-center gap-1"><Phone className="h-3 w-3" />{row.original.contactPhone}</span>}
          </div>
        )
        : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "isActive", header: "Active", cell: ({ row }: any) => <Badge variant={row.original.isActive ? "success" : "secondary"} className="text-[10px]">{row.original.isActive ? "ACTIVE" : "INACTIVE"}</Badge> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Kitchens" description="Production kitchens that prepare and dispatch food orders."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Kitchen</Button>}
      />
      <DataTable columns={cols as any} data={kitchens} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Kitchen" : "Add Kitchen"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create Kitchen"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Central Kitchen" />
            </div>
            <div>
              <Label>Code *</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="font-mono" placeholder="e.g. KIT-BLR-01" />
            </div>
          </div>
          <div>
            <Label>Brand</Label>
            <Select value={form.brand} onValueChange={(v) => setForm({ ...form, brand: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__SHARED__">Shared (all brands)</SelectItem>
                {BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Leave as shared to serve every brand.</p>
          </div>
          <div>
            <Label>Address</Label>
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street address" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>City</Label>
              <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div>
              <Label>State</Label>
              <Input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </div>
            <div>
              <Label>Pincode</Label>
              <Input value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} className="font-mono" />
            </div>
          </div>
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Kitchen head</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name</Label>
                <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
              </div>
              <div>
                <Label>Phone</Label>
                <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} className="font-mono" />
              </div>
              <div className="col-span-2">
                <Label>Email</Label>
                <Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} placeholder="kitchenhead@uniliv.com" />
              </div>
            </div>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget?.name ?? ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6) MEAL TYPES
// ════════════════════════════════════════════════════════════════════════════
type MealConfigForm = { displayLabel: string; sortOrder: number; isEnabled: boolean };

function MealTypesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<MealConfig | null>(null);
  const [form, setForm] = React.useState<MealConfigForm>({ displayLabel: "", sortOrder: 0, isEnabled: true });

  const { data: configs = [], isLoading } = useQuery<MealConfig[]>({
    queryKey: foodKeys.mealConfig(),
    queryFn: () => foodApi.mealConfig(),
  });
  const rows = [...configs].sort((a, b) => a.sortOrder - b.sortOrder);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "meal-config"] });

  const saveMut = useMutation({
    mutationFn: (v: MealConfigForm & { mealType: string }) =>
      foodApi.updateMealConfig(v.mealType, {
        displayLabel: v.displayLabel.trim(),
        sortOrder: v.sortOrder,
        isEnabled: v.isEnabled,
      }),
    onSuccess: () => { toast({ title: "Meal type updated" }); invalidate(); setEditing(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const toggleMut = useMutation({
    mutationFn: (c: MealConfig) =>
      foodApi.updateMealConfig(c.mealType, {
        displayLabel: c.displayLabel,
        sortOrder: c.sortOrder,
        isEnabled: !c.isEnabled,
      }),
    onSuccess: () => { toast({ title: "Meal type updated" }); invalidate(); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openEdit = (c: MealConfig) => {
    setEditing(c);
    setForm({ displayLabel: c.displayLabel, sortOrder: c.sortOrder, isEnabled: c.isEnabled });
  };
  const submit = () => {
    if (!editing) return;
    if (!form.displayLabel.trim()) { toast({ title: "Display label is required", variant: "destructive" }); return; }
    saveMut.mutate({ ...form, mealType: editing.mealType });
  };

  const cols = [
    { accessorKey: "mealType", header: "Meal Type", cell: ({ row }: any) => <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{row.original.mealType}</span> },
    { accessorKey: "displayLabel", header: "Display Label", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.displayLabel}</span> },
    { accessorKey: "sortOrder", header: "Order", cell: ({ row }: any) => <span className="text-muted-foreground text-xs">{row.original.sortOrder}</span> },
    {
      accessorKey: "isEnabled", header: "Enabled",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={row.original.isEnabled}
            onCheckedChange={() => toggleMut.mutate(row.original)}
            disabled={toggleMut.isPending}
          />
          <span className={`text-xs font-medium ${row.original.isEnabled ? "text-success" : "text-muted-foreground"}`}>
            {row.original.isEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
      ),
    },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Meal Types" description="Customise the label, ordering and availability of each meal slot. Meal types are fixed; only their presentation can be edited."
      />
      <DataTable columns={cols as any} data={rows} isLoading={isLoading} />

      <FormModal open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title="Edit Meal Type" onSave={submit} isSaving={saveMut.isPending} saveLabel="Save Changes">
        <div className="space-y-4">
          {editing && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">{editing.mealType}</Badge>
              <span className="text-xs text-muted-foreground">System meal type</span>
            </div>
          )}
          <div>
            <Label>Display Label *</Label>
            <Input value={form.displayLabel} onChange={(e) => setForm({ ...form, displayLabel: e.target.value })} placeholder="e.g. High Tea / Evening Snacks" />
          </div>
          <div>
            <Label>Sort Order</Label>
            <Input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <div>
              <Label className="mb-0">Enabled</Label>
              <p className="text-xs text-muted-foreground">Disabled meal types are hidden from ordering.</p>
            </div>
            <Switch checked={form.isEnabled} onCheckedChange={(v) => setForm({ ...form, isEnabled: v })} />
          </div>
        </div>
      </FormModal>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 7) CUT-OFF WINDOWS
// ════════════════════════════════════════════════════════════════════════════
type WindowForm = {
  brand: FoodBrand; mealType: MealType; serviceTime: string;
  leadTimeMinutes: number; propertyId: string;
};
const emptyWindow: WindowForm = {
  brand: "UNILIV", mealType: "BREAKFAST", serviceTime: "",
  leadTimeMinutes: 0, propertyId: "",
};

// Single cut-off time per brand (applies to ALL meals; optional per-property override).
type CutoffForm = { brand: FoodBrand; cutoffTime: string; propertyId: string };
function CutoffConfigPanel({ properties, propName }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const brandOptions = useActiveBrands();
  const { data: rows = [], isLoading } = useQuery<FoodCutoffConfig[]>({ queryKey: foodKeys.cutoffConfig(), queryFn: () => foodApi.listCutoffConfig() });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["food", "cutoff-config"] }); qc.invalidateQueries({ queryKey: ["food", "cutoffs"] }); };

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<FoodCutoffConfig | null>(null);
  const [form, setForm] = React.useState<CutoffForm>({ brand: "UNILIV", cutoffTime: "21:00", propertyId: "" });
  const [delTarget, setDelTarget] = React.useState<FoodCutoffConfig | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = { brand: form.brand, cutoffTime: form.cutoffTime.trim(), propertyId: form.propertyId || null };
      return editing ? foodApi.updateCutoffConfig(editing.id, body) : foodApi.createCutoffConfig(body);
    },
    onSuccess: () => { toast({ title: editing ? "Cut-off updated" : "Cut-off added" }); invalidate(); setOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: (id: string) => foodApi.deleteCutoffConfig(id),
    onSuccess: () => { toast({ title: "Cut-off removed" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openAdd = () => { setEditing(null); setForm({ brand: (brandOptions[0]?.code as FoodBrand) ?? "UNILIV", cutoffTime: "21:00", propertyId: "" }); setOpen(true); };
  const openEdit = (c: FoodCutoffConfig) => { setEditing(c); setForm({ brand: c.brand, cutoffTime: c.cutoffTime, propertyId: c.propertyId ?? "" }); setOpen(true); };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> Cut-off time</CardTitle>
          <CardDescription className="text-xs">One cut-off applies to <span className="font-medium">all meals</span> that day. Set a default per brand; optionally override per property.</CardDescription>
        </div>
        <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4 mr-1" /> Add cut-off</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="py-4 text-sm text-muted-foreground">Loading…</p>
          : rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No cut-off set — orders never close. Add one.</p>
          : (
            <BoundedScroll size="lg">
              <div className="space-y-1 pr-3">
                {rows.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <Badge variant="outline" className="text-[10px]">{c.brand}</Badge>
                    {c.propertyId
                      ? <span className="text-sm inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" />{propName(c.propertyId)}</span>
                      : <Badge variant="secondary" className="text-[10px]"><Globe className="h-3 w-3 mr-1" /> GLOBAL</Badge>}
                    <span className="ml-auto font-mono text-sm inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-muted-foreground" />{c.cutoffTime}</span>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDelTarget(c)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </div>
            </BoundedScroll>
          )}
      </CardContent>

      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Cut-off" : "Add Cut-off"} onSave={() => { if (!form.cutoffTime.trim()) { toast({ title: "Cut-off time required", variant: "destructive" }); return; } save.mutate(); }} isSaving={save.isPending} saveLabel={editing ? "Save" : "Add"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Brand</Label>
              <Select value={form.brand} onValueChange={(v) => setForm({ ...form, brand: v as FoodBrand })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{brandOptions.map((b) => <SelectItem key={b.code} value={b.code}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Cut-off Time *</Label>
              <TimePicker value={form.cutoffTime} onChange={(v) => setForm({ ...form, cutoffTime: v })} stepMinutes={15} placeholder="Select cut-off" />
            </div>
          </div>
          <div>
            <Label>Property</Label>
            <Select value={form.propertyId || "__GLOBAL__"} onValueChange={(v) => setForm({ ...form, propertyId: v === "__GLOBAL__" ? "" : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__GLOBAL__">Global (all properties)</SelectItem>
                {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget ? `${delTarget.brand} cut-off` : ""} onConfirm={() => delTarget && del.mutate(delTarget.id)} isDeleting={del.isPending} />
    </Card>
  );
}

function CutoffWindowsTab({ properties, propName }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [brand, setBrand] = React.useState("ALL");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MealWindow | null>(null);
  const [delTarget, setDelTarget] = React.useState<MealWindow | null>(null);
  const [form, setForm] = React.useState<WindowForm>(emptyWindow);

  const params: Record<string, unknown> = brand === "ALL" ? {} : { brand };
  const { data: windows = [], isLoading } = useQuery<MealWindow[]>({
    queryKey: foodKeys.mealWindows(params),
    queryFn: () => foodApi.listMealWindows(params),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "meal-windows"] });

  const saveMut = useMutation({
    mutationFn: (v: WindowForm) => {
      const body: Record<string, unknown> = {
        brand: v.brand,
        mealType: v.mealType,
        serviceTime: v.serviceTime.trim() || null,
        leadTimeMinutes: v.leadTimeMinutes,
        propertyId: v.propertyId || null,
      };
      return editing ? foodApi.updateMealWindow(editing.id, body) : foodApi.createMealWindow(body);
    },
    onSuccess: () => { toast({ title: editing ? "Cut-off window updated" : "Cut-off window created" }); invalidate(); setModalOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteMealWindow(id),
    onSuccess: () => { toast({ title: "Cut-off window deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyWindow); setModalOpen(true); };
  const openEdit = (w: MealWindow) => {
    setEditing(w);
    setForm({
      brand: w.brand, mealType: w.mealType,
      serviceTime: w.serviceTime ?? "", leadTimeMinutes: w.leadTimeMinutes ?? 0,
      propertyId: w.propertyId ?? "",
    });
    setModalOpen(true);
  };
  const submit = () => {
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "brand", header: "Brand", cell: ({ row }: any) => <Badge variant="outline" className="text-[10px]">{row.original.brand}</Badge> },
    { accessorKey: "mealType", header: "Meal", cell: ({ row }: any) => MEAL_LABEL[row.original.mealType as MealType] ?? row.original.mealType },
    { accessorKey: "serviceTime", header: "Service", cell: ({ row }: any) => row.original.serviceTime ? <span className="font-mono text-xs">{row.original.serviceTime}</span> : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "leadTimeMinutes", header: "Lead (min)", cell: ({ row }: any) => <span className="text-muted-foreground text-xs">{row.original.leadTimeMinutes}</span> },
    { accessorKey: "propertyId", header: "Scope", cell: ({ row }: any) => row.original.propertyId
        ? <span className="text-sm inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-muted-foreground" />{propName(row.original.propertyId)}</span>
        : <Badge variant="secondary" className="text-[10px]"><Globe className="h-3 w-3 mr-1" /> GLOBAL</Badge> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-6">
      <CutoffConfigPanel properties={properties} propName={propName} />

      <SectionHeader
        title="Service Times" description="Per-meal service/delivery time + lead time (used for ETAs & delay analytics). The cut-off above applies to all meals."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Service Time</Button>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={cols as any} data={windows} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Service Time" : "Add Service Time"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Brand</Label>
              <Select value={form.brand} onValueChange={(v) => setForm({ ...form, brand: v as FoodBrand })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Meal</Label>
              <Select value={form.mealType} onValueChange={(v) => setForm({ ...form, mealType: v as MealType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{MEAL_TYPES.map((m) => <SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Service Time</Label>
              <TimePicker value={form.serviceTime} onChange={(v) => setForm({ ...form, serviceTime: v })} stepMinutes={15} placeholder="Select time" />
            </div>
            <div>
              <Label>Lead (min)</Label>
              <div><NumberStepper value={form.leadTimeMinutes} onChange={(n) => setForm({ ...form, leadTimeMinutes: n })} min={0} step={5} /></div>
            </div>
          </div>
          <div>
            <Label>Property</Label>
            <Select value={form.propertyId || "__GLOBAL__"} onValueChange={(v) => setForm({ ...form, propertyId: v === "__GLOBAL__" ? "" : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__GLOBAL__">Global (all properties)</SelectItem>
                {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Leave global to apply across all properties.</p>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget ? `${delTarget.brand} ${MEAL_LABEL[delTarget.mealType]} window` : ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 8) HIERARCHY (Zones / Cities / Clusters + Property Assignment)
// ════════════════════════════════════════════════════════════════════════════
function HierarchyTab({ properties }: { properties: FoodLookups["properties"] }) {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="geo" className="space-y-4">
        <TabsList>
          <TabsTrigger value="geo"><Layers className="h-4 w-4 mr-2" /> Zones / Cities / Clusters</TabsTrigger>
          <TabsTrigger value="assign"><Building2 className="h-4 w-4 mr-2" /> Property Assignment</TabsTrigger>
        </TabsList>
        <TabsContent value="geo"><GeoSection /></TabsContent>
        <TabsContent value="assign"><PropertyAssignment properties={properties} /></TabsContent>
      </Tabs>
    </div>
  );
}

function GeoSection() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: zones = [], isLoading: zLoading } = useQuery<Zone[]>({ queryKey: foodKeys.zones(), queryFn: () => foodApi.listZones() });
  const { data: cities = [], isLoading: cLoading } = useQuery<City[]>({ queryKey: foodKeys.cities(), queryFn: () => foodApi.listCities() });
  const { data: clusters = [], isLoading: clLoading } = useQuery<Cluster[]>({ queryKey: foodKeys.clusters(), queryFn: () => foodApi.listClusters() });

  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  const cityName = (id: string) => cities.find((c) => c.id === id)?.name ?? id;

  // ── Zone modal ──
  const [zoneOpen, setZoneOpen] = React.useState(false);
  const [zoneForm, setZoneForm] = React.useState({ name: "", code: "" });
  const zoneMut = useMutation({
    mutationFn: (v: { name: string; code: string }) => foodApi.createZone({ name: v.name, code: v.code || null }),
    onSuccess: () => { toast({ title: "Zone created" }); qc.invalidateQueries({ queryKey: foodKeys.zones() }); setZoneOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  // ── City modal ──
  const [cityOpen, setCityOpen] = React.useState(false);
  const [cityForm, setCityForm] = React.useState({ name: "", zoneId: "" });
  const cityMut = useMutation({
    mutationFn: (v: { name: string; zoneId: string }) => foodApi.createCity(v),
    onSuccess: () => { toast({ title: "City created" }); qc.invalidateQueries({ queryKey: ["food", "cities"] }); setCityOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  // ── Cluster modal ──
  const [clusterOpen, setClusterOpen] = React.useState(false);
  const [clusterForm, setClusterForm] = React.useState({ name: "", cityId: "" });
  const clusterMut = useMutation({
    mutationFn: (v: { name: string; cityId: string }) => foodApi.createCluster(v),
    onSuccess: () => { toast({ title: "Cluster created" }); qc.invalidateQueries({ queryKey: ["food", "clusters"] }); setClusterOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const zoneCols = [
    { accessorKey: "name", header: "Zone", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "code", header: "Code", cell: ({ row }: any) => row.original.code ? <span className="font-mono text-xs">{row.original.code}</span> : <span className="text-muted-foreground text-xs">—</span> },
  ];
  const cityCols = [
    { accessorKey: "name", header: "City", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "zoneId", header: "Zone", cell: ({ row }: any) => zoneName(row.original.zoneId) },
  ];
  const clusterCols = [
    { accessorKey: "name", header: "Cluster", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "cityId", header: "City", cell: ({ row }: any) => cityName(row.original.cityId) },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-display flex items-center gap-2"><Globe className="h-4 w-4 text-primary" /> Zones</CardTitle>
            <CardDescription className="text-xs">Top-level geography.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setZoneForm({ name: "", code: "" }); setZoneOpen(true); }}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </CardHeader>
        <CardContent>
          <DataTable columns={zoneCols as any} data={zones} isLoading={zLoading} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-display flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" /> Cities</CardTitle>
            <CardDescription className="text-xs">Cities within a zone.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setCityForm({ name: "", zoneId: "" }); setCityOpen(true); }} disabled={zones.length === 0}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </CardHeader>
        <CardContent>
          <DataTable columns={cityCols as any} data={cities} isLoading={cLoading} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-display flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Clusters</CardTitle>
            <CardDescription className="text-xs">Clusters within a city.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setClusterForm({ name: "", cityId: "" }); setClusterOpen(true); }} disabled={cities.length === 0}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </CardHeader>
        <CardContent>
          <DataTable columns={clusterCols as any} data={clusters} isLoading={clLoading} />
        </CardContent>
      </Card>

      <FormModal open={zoneOpen} onOpenChange={setZoneOpen} title="Add Zone" onSave={() => { if (!zoneForm.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; } zoneMut.mutate(zoneForm); }} isSaving={zoneMut.isPending} saveLabel="Create Zone">
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} /></div>
          <div><Label>Code</Label><Input value={zoneForm.code} onChange={(e) => setZoneForm({ ...zoneForm, code: e.target.value })} className="font-mono" placeholder="e.g. NORTH" /></div>
        </div>
      </FormModal>

      <FormModal open={cityOpen} onOpenChange={setCityOpen} title="Add City" onSave={() => { if (!cityForm.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; } if (!cityForm.zoneId) { toast({ title: "Zone is required", variant: "destructive" }); return; } cityMut.mutate(cityForm); }} isSaving={cityMut.isPending} saveLabel="Create City">
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={cityForm.name} onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })} /></div>
          <div>
            <Label>Zone *</Label>
            <Select value={cityForm.zoneId} onValueChange={(v) => setCityForm({ ...cityForm, zoneId: v })}>
              <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
              <SelectContent>{zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      <FormModal open={clusterOpen} onOpenChange={setClusterOpen} title="Add Cluster" onSave={() => { if (!clusterForm.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; } if (!clusterForm.cityId) { toast({ title: "City is required", variant: "destructive" }); return; } clusterMut.mutate(clusterForm); }} isSaving={clusterMut.isPending} saveLabel="Create Cluster">
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={clusterForm.name} onChange={(e) => setClusterForm({ ...clusterForm, name: e.target.value })} /></div>
          <div>
            <Label>City *</Label>
            <Select value={clusterForm.cityId} onValueChange={(v) => setClusterForm({ ...clusterForm, cityId: v })}>
              <SelectTrigger><SelectValue placeholder="Select city" /></SelectTrigger>
              <SelectContent>{cities.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>
    </div>
  );
}

function PropertyAssignment({ properties }: { properties: FoodLookups["properties"] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: clusters = [] } = useQuery<Cluster[]>({ queryKey: foodKeys.clusters(), queryFn: () => foodApi.listClusters() });
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  const assignMut = useMutation({
    mutationFn: ({ propertyId, clusterId }: { propertyId: string; clusterId: string }) => foodApi.assignCluster(propertyId, clusterId),
    onSuccess: () => { toast({ title: "Cluster assigned" }); qc.invalidateQueries({ queryKey: foodKeys.lookups() }); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
    onSettled: () => setPendingId(null),
  });

  const clusterName = (id?: string | null) => id ? (clusters.find((c) => c.id === id)?.name ?? "—") : "—";

  const cols = [
    { accessorKey: "name", header: "Property", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "clusterId", header: "Current Cluster", cell: ({ row }: any) => row.original.clusterId ? <Badge variant="secondary" className="text-[10px]">{clusterName(row.original.clusterId)}</Badge> : <span className="text-muted-foreground text-xs">Unassigned</span> },
    {
      id: "assign", header: () => <div className="text-right">Assign Cluster</div>,
      cell: ({ row }: any) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <Select
            value={row.original.clusterId ?? ""}
            onValueChange={(v) => { setPendingId(row.original.id); assignMut.mutate({ propertyId: row.original.id, clusterId: v }); }}
            disabled={assignMut.isPending && pendingId === row.original.id}
          >
            <SelectTrigger className="w-48"><SelectValue placeholder="Select cluster" /></SelectTrigger>
            <SelectContent>{clusters.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Property Assignment" description="Assign each property to a cluster to drive scoping and reporting." />
      {clusters.length === 0 && (
        <p className="text-sm text-muted-foreground p-3 border border-dashed rounded-md">Create clusters first to enable assignment.</p>
      )}
      <DataTable columns={cols as any} data={properties} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6) USERS & SCOPES
// ════════════════════════════════════════════════════════════════════════════
function UsersTab({ properties, propName }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);

  const { data: users = [], isLoading: usersLoading } = useQuery<FoodUser[]>({
    queryKey: foodKeys.users(),
    queryFn: () => foodApi.foodUsers(),
  });
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  const userCols = [
    { accessorKey: "name", header: "User", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "email", header: "Email", cell: ({ row }: any) => <span className="text-xs text-muted-foreground">{row.original.email}</span> },
    { accessorKey: "role", header: "Role", cell: ({ row }: any) => <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{labelize(row.original.role)}</Badge> },
    { accessorKey: "propertyId", header: "Property", cell: ({ row }: any) => row.original.propertyId ? propName(row.original.propertyId) : <span className="text-muted-foreground text-xs">—</span> },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-display flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Food Users</CardTitle>
          <CardDescription className="text-xs">Select a user to manage their access scopes.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={userCols as any}
            data={users}
            isLoading={usersLoading}
            onRowClick={(row: any) => setSelectedUserId(row.id)}
          />
        </CardContent>
      </Card>

      <ScopesPanel
        user={selectedUser}
        properties={properties}
        propName={propName}
        onInvalidate={() => qc.invalidateQueries({ queryKey: ["food", "scopes"] })}
        toast={toast}
      />
    </div>
  );
}

function ScopesPanel({
  user, properties, propName, onInvalidate, toast,
}: {
  user: FoodUser | null;
  properties: FoodLookups["properties"];
  propName: (id?: string | null) => string;
  onInvalidate: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const qc = useQueryClient();
  const { data: scopes = [], isLoading } = useQuery<UserScope[]>({
    queryKey: foodKeys.scopes(user?.id),
    queryFn: () => foodApi.listScopes(user!.id),
    enabled: !!user,
  });
  const { data: zones = [] } = useQuery<Zone[]>({ queryKey: foodKeys.zones(), queryFn: () => foodApi.listZones() });
  const { data: cities = [] } = useQuery<City[]>({ queryKey: foodKeys.cities(), queryFn: () => foodApi.listCities() });
  const { data: clusters = [] } = useQuery<Cluster[]>({ queryKey: foodKeys.clusters(), queryFn: () => foodApi.listClusters() });

  const [addOpen, setAddOpen] = React.useState(false);
  const [scopeLevel, setScopeLevel] = React.useState("GLOBAL");
  const [targetId, setTargetId] = React.useState("");
  const [delTarget, setDelTarget] = React.useState<UserScope | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: foodKeys.scopes(user?.id) });
    onInvalidate();
  };

  const addMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { userId: user!.id, scopeLevel };
      if (scopeLevel === "ZONE") body.zoneId = targetId;
      else if (scopeLevel === "CITY") body.cityId = targetId;
      else if (scopeLevel === "CLUSTER") body.clusterId = targetId;
      else if (scopeLevel === "PROPERTY") body.propertyId = targetId;
      return foodApi.createScope(body);
    },
    onSuccess: () => { toast({ title: "Scope added" }); refresh(); setAddOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteScope(id),
    onSuccess: () => { toast({ title: "Scope removed" }); refresh(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openAdd = () => { setScopeLevel("GLOBAL"); setTargetId(""); setAddOpen(true); };
  const submit = () => {
    if (scopeLevel !== "GLOBAL" && !targetId) { toast({ title: "Please select a target", variant: "destructive" }); return; }
    addMut.mutate();
  };

  const scopeTargetName = (s: UserScope): string => {
    if (s.scopeLevel === "ZONE" && s.zoneId) return zones.find((z) => z.id === s.zoneId)?.name ?? s.zoneId;
    if (s.scopeLevel === "CITY" && s.cityId) return cities.find((c) => c.id === s.cityId)?.name ?? s.cityId;
    if (s.scopeLevel === "CLUSTER" && s.clusterId) return clusters.find((c) => c.id === s.clusterId)?.name ?? s.clusterId;
    if (s.scopeLevel === "PROPERTY" && s.propertyId) return propName(s.propertyId);
    return "All (global)";
  };

  const targetOptions: { id: string; name: string }[] =
    scopeLevel === "ZONE" ? zones.map((z) => ({ id: z.id, name: z.name }))
    : scopeLevel === "CITY" ? cities.map((c) => ({ id: c.id, name: c.name }))
    : scopeLevel === "CLUSTER" ? clusters.map((c) => ({ id: c.id, name: c.name }))
    : scopeLevel === "PROPERTY" ? properties.map((p) => ({ id: p.id, name: p.name }))
    : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base font-display flex items-center gap-2"><Network className="h-4 w-4 text-primary" /> Access Scopes</CardTitle>
          <CardDescription className="text-xs">
            {user ? <>For <span className="font-medium text-foreground">{user.name}</span></> : "Select a user on the left."}
          </CardDescription>
        </div>
        {user && <Button size="sm" variant="outline" onClick={openAdd}><Plus className="h-4 w-4 mr-1" /> Add Scope</Button>}
      </CardHeader>
      <CardContent>
        {!user ? (
          <p className="text-sm text-muted-foreground p-6 border border-dashed rounded-md text-center">No user selected.</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground p-3">Loading scopes…</p>
        ) : scopes.length === 0 ? (
          <p className="text-sm text-muted-foreground p-6 border border-dashed rounded-md text-center">No scopes assigned yet.</p>
        ) : (
          <div className="space-y-2">
            {scopes.map((s) => (
              <div key={s.id} className="flex items-center justify-between border rounded-md p-3 bg-card">
                <div className="flex items-center gap-3">
                  <Badge variant="info" className="text-[10px]">{s.scopeLevel}</Badge>
                  <span className="text-sm font-medium">{scopeTargetName(s)}</span>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDelTarget(s)} title="Remove">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <FormModal open={addOpen} onOpenChange={setAddOpen} title="Add Scope" onSave={submit} isSaving={addMut.isPending} saveLabel="Add Scope">
        <div className="space-y-4">
          <div>
            <Label>Scope Level</Label>
            <Select value={scopeLevel} onValueChange={(v) => { setScopeLevel(v); setTargetId(""); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{SCOPE_LEVELS.map((l) => <SelectItem key={l} value={l}>{labelize(l)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {scopeLevel !== "GLOBAL" && (
            <div>
              <Label>{labelize(scopeLevel)} *</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger><SelectValue placeholder={`Select ${labelize(scopeLevel).toLowerCase()}`} /></SelectTrigger>
                <SelectContent>
                  {targetOptions.length === 0
                    ? <div className="px-2 py-1.5 text-xs text-muted-foreground">No options available</div>
                    : targetOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {scopeLevel === "GLOBAL" && (
            <p className="text-xs text-muted-foreground">Global scope grants access across all geography.</p>
          )}
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget ? `${delTarget.scopeLevel} scope` : ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </Card>
  );
}

// ─── Shared section header ────────────────────────────────────────────────────
function SectionHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-display font-semibold text-primary">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Food Defaults (SUPER_ADMIN only) — org-wide fallback cut-off time + waste-edit
// window, stored in system_config. These apply when no brand/property cut-off is
// configured and as the global waste-recording window.
// ════════════════════════════════════════════════════════════════════════════
function FoodDefaultsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<FoodDefaults>({
    queryKey: ["food", "system-config", "food-defaults"],
    queryFn: () => foodApi.foodDefaults(),
  });

  const [defaultCutoff, setDefaultCutoff] = React.useState("09:00");
  const [wasteWindowMinutes, setWasteWindowMinutes] = React.useState(60);

  React.useEffect(() => {
    if (data) {
      setDefaultCutoff(data.defaultCutoff ?? "09:00");
      setWasteWindowMinutes(data.wasteWindowMinutes ?? 60);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => foodApi.updateFoodDefaults({ defaultCutoff: defaultCutoff.trim(), wasteWindowMinutes }),
    onSuccess: () => {
      toast({ title: "Food defaults saved" });
      qc.invalidateQueries({ queryKey: ["food", "system-config", "food-defaults"] });
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to save", variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4" /> Global Food Defaults</CardTitle>
        <CardDescription className="text-xs">
          Organisation-wide fallbacks used when no brand/property cut-off is configured.
          The waste-edit window controls how long after delivery waste can still be recorded. SUPER_ADMIN only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5 max-w-md">
            <div>
              <Label>Default Cut-off Time (HH:MM)</Label>
              <TimePicker value={defaultCutoff} onChange={setDefaultCutoff} stepMinutes={15} placeholder="Select cut-off" />
              <p className="mt-1 text-xs text-muted-foreground">Applied the day before the service date when no brand/property cut-off exists.</p>
            </div>
            <div>
              <Label>Waste-edit Window (minutes)</Label>
              <NumberStepper value={wasteWindowMinutes} onChange={setWasteWindowMinutes} min={1} max={1440} step={5} />
              <p className="mt-1 text-xs text-muted-foreground">Minutes after delivery during which waste can still be recorded.</p>
            </div>
            <Button onClick={() => { if (!/^\d{1,2}:\d{2}$/.test(defaultCutoff.trim())) { toast({ title: "Cut-off must be HH:MM", variant: "destructive" }); return; } save.mutate(); }} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save defaults"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
