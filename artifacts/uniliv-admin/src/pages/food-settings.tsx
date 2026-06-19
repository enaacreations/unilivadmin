import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, UtensilsCrossed, CalendarRange, Scale, Truck,
  Network, ShieldCheck, Leaf, Beef, Building2, MapPin, Layers, Globe,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, MEAL_LABEL, DAY_LABEL, fmtQty,
  type Dish, type MenuRotationRow, type PerResidentRule, type DeliveryPartner,
  type Zone, type City, type Cluster, type UserScope, type FoodUser, type FoodLookups,
  type FoodBrand, type MealType,
} from "@/lib/food-api";

// ─── Enums (from spec) ────────────────────────────────────────────────────────
const DISH_COMPONENTS = [
  "HOT_FOOD", "VEG", "DAL", "RICE", "BREAD", "SALAD", "CURD_RAITA", "DESSERT",
  "PAPAD_PICKLE", "CHUTNEY", "PICKLE", "FRUITS", "BAKERY", "BEVERAGE", "SNACK", "MILK", "OTHER",
];
const UNITS = ["G", "KG", "ML", "LITRE", "PCS", "PLATE", "SERVING"];
const SCOPE_LEVELS = ["GLOBAL", "ZONE", "CITY", "CLUSTER", "PROPERTY"];
const DAYS = [1, 2, 3, 4, 5, 6, 7];

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

export default function FoodSettings() {
  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name ?? "—") : "—";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Food Settings & Master Data"
        subtitle="Manage dishes, menu rotation, per-resident rules, delivery partners, hierarchy and user scopes"
      />

      <Tabs defaultValue="dishes" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="dishes"><UtensilsCrossed className="h-4 w-4 mr-2" /> Dishes</TabsTrigger>
          <TabsTrigger value="rotation"><CalendarRange className="h-4 w-4 mr-2" /> Menu Rotation</TabsTrigger>
          <TabsTrigger value="rules"><Scale className="h-4 w-4 mr-2" /> Per-Resident Rules</TabsTrigger>
          <TabsTrigger value="partners"><Truck className="h-4 w-4 mr-2" /> Delivery Partners</TabsTrigger>
          <TabsTrigger value="hierarchy"><Network className="h-4 w-4 mr-2" /> Hierarchy</TabsTrigger>
          <TabsTrigger value="users"><ShieldCheck className="h-4 w-4 mr-2" /> Users & Scopes</TabsTrigger>
        </TabsList>

        <TabsContent value="dishes"><DishesTab /></TabsContent>
        <TabsContent value="rotation"><RotationTab /></TabsContent>
        <TabsContent value="rules"><RulesTab properties={properties} propName={propName} /></TabsContent>
        <TabsContent value="partners"><PartnersTab /></TabsContent>
        <TabsContent value="hierarchy"><HierarchyTab properties={properties} /></TabsContent>
        <TabsContent value="users"><UsersTab properties={properties} propName={propName} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 1) DISHES
// ════════════════════════════════════════════════════════════════════════════
type DishForm = { name: string; component: string; unit: string; isVeg: boolean };
const emptyDish: DishForm = { name: "", component: "HOT_FOOD", unit: "SERVING", isVeg: true };

function DishesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Dish | null>(null);
  const [delTarget, setDelTarget] = React.useState<Dish | null>(null);
  const [form, setForm] = React.useState<DishForm>(emptyDish);

  const { data: dishes = [], isLoading } = useQuery<Dish[]>({
    queryKey: foodKeys.dishes({}),
    queryFn: () => foodApi.listDishes(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "dishes"] });

  const saveMut = useMutation({
    mutationFn: (v: DishForm) =>
      editing ? foodApi.updateDish(editing.id, v) : foodApi.createDish(v),
    onSuccess: () => {
      toast({ title: editing ? "Dish updated" : "Dish created" });
      invalidate();
      setModalOpen(false);
    },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteDish(id),
    onSuccess: () => { toast({ title: "Dish deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyDish); setModalOpen(true); };
  const openEdit = (d: Dish) => {
    setEditing(d);
    setForm({ name: d.name, component: d.component, unit: d.unit, isVeg: d.isVeg });
    setModalOpen(true);
  };
  const submit = () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "name", header: "Dish", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "component", header: "Component", cell: ({ row }: any) => <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{labelize(row.original.component)}</Badge> },
    { accessorKey: "unit", header: "Unit", cell: ({ row }: any) => <span className="text-muted-foreground text-xs uppercase">{row.original.unit}</span> },
    { accessorKey: "isVeg", header: "Type", cell: ({ row }: any) => row.original.isVeg
        ? <span className="inline-flex items-center gap-1 text-success text-xs font-medium"><Leaf className="h-3.5 w-3.5" /> Veg</span>
        : <span className="inline-flex items-center gap-1 text-destructive text-xs font-medium"><Beef className="h-3.5 w-3.5" /> Non-veg</span> },
    { accessorKey: "isActive", header: "Status", cell: ({ row }: any) => <Badge variant={row.original.isActive ? "success" : "secondary"} className="text-[10px]">{row.original.isActive ? "ACTIVE" : "INACTIVE"}</Badge> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Dishes" description="Master catalogue of dishes used across menus and orders."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Dish</Button>}
      />
      <DataTable columns={cols as any} data={dishes} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Dish" : "Add Dish"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create Dish"}>
        <div className="space-y-4">
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Paneer Butter Masala" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Component</Label>
              <Select value={form.component} onValueChange={(v) => setForm({ ...form, component: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DISH_COMPONENTS.map((c) => <SelectItem key={c} value={c}>{labelize(c)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t pt-3">
            <Checkbox id="dish-veg" checked={form.isVeg} onCheckedChange={(v) => setForm({ ...form, isVeg: !!v })} />
            <label htmlFor="dish-veg" className="text-sm">Vegetarian</label>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget?.name ?? ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2) MENU ROTATION
// ════════════════════════════════════════════════════════════════════════════
type RotationForm = {
  brand: FoodBrand; rotationWeek: number; dayOfWeek: number; mealType: MealType;
  dishId: string; slotLabel: string; sortOrder: number;
};
const emptyRotation: RotationForm = {
  brand: "UNILIV", rotationWeek: 1, dayOfWeek: 1, mealType: "BREAKFAST", dishId: "", slotLabel: "", sortOrder: 0,
};

function RotationTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [brand, setBrand] = React.useState("ALL");
  const [week, setWeek] = React.useState("ALL");
  const [day, setDay] = React.useState("ALL");
  const [meal, setMeal] = React.useState("ALL");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MenuRotationRow | null>(null);
  const [delTarget, setDelTarget] = React.useState<MenuRotationRow | null>(null);
  const [form, setForm] = React.useState<RotationForm>(emptyRotation);

  const params: Record<string, unknown> = { brand, rotationWeek: week, dayOfWeek: day, mealType: meal };
  const { data: rows = [], isLoading } = useQuery<MenuRotationRow[]>({
    queryKey: foodKeys.rotation(params),
    queryFn: () => foodApi.listRotation(params),
  });
  const { data: dishes = [] } = useQuery<Dish[]>({ queryKey: foodKeys.dishes({}), queryFn: () => foodApi.listDishes() });
  const dishName = (id: string) => dishes.find((d) => d.id === id)?.name ?? id;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] });

  const saveMut = useMutation({
    mutationFn: (v: RotationForm) => editing ? foodApi.updateRotation(editing.id, v) : foodApi.createRotation(v),
    onSuccess: () => { toast({ title: editing ? "Rotation updated" : "Rotation added" }); invalidate(); setModalOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteRotation(id),
    onSuccess: () => { toast({ title: "Rotation entry deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyRotation); setModalOpen(true); };
  const openEdit = (r: MenuRotationRow) => {
    setEditing(r);
    setForm({ brand: r.brand, rotationWeek: r.rotationWeek, dayOfWeek: r.dayOfWeek, mealType: r.mealType, dishId: r.dishId, slotLabel: r.slotLabel ?? "", sortOrder: r.sortOrder });
    setModalOpen(true);
  };
  const submit = () => {
    if (!form.dishId) { toast({ title: "Dish is required", variant: "destructive" }); return; }
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "brand", header: "Brand", cell: ({ row }: any) => <Badge variant="outline" className="text-[10px]">{row.original.brand}</Badge> },
    { accessorKey: "rotationWeek", header: "Week", cell: ({ row }: any) => <span className="font-mono text-xs">W{row.original.rotationWeek}</span> },
    { accessorKey: "dayOfWeek", header: "Day", cell: ({ row }: any) => DAY_LABEL[row.original.dayOfWeek] ?? row.original.dayOfWeek },
    { accessorKey: "mealType", header: "Meal", cell: ({ row }: any) => MEAL_LABEL[row.original.mealType as MealType] ?? row.original.mealType },
    { accessorKey: "dishId", header: "Dish", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.dishName ?? dishName(row.original.dishId)}</span> },
    { accessorKey: "slotLabel", header: "Slot", cell: ({ row }: any) => row.original.slotLabel ? <span className="text-xs">{row.original.slotLabel}</span> : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "sortOrder", header: "Order", cell: ({ row }: any) => <span className="text-muted-foreground text-xs">{row.original.sortOrder}</span> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Menu Rotation" description="Weekly per-brand rotation that drives auto-suggested menus."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Entry</Button>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {BRANDS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={week} onValueChange={setWeek}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Week" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Weeks</SelectItem>
            {[1, 2, 3, 4].map((w) => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={day} onValueChange={setDay}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Day" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Days</SelectItem>
            {DAYS.map((d) => <SelectItem key={d} value={String(d)}>{DAY_LABEL[d]}</SelectItem>)}
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

      <DataTable columns={cols as any} data={rows} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Rotation Entry" : "Add Rotation Entry"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Add Entry"}>
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
            <div>
              <Label>Rotation Week</Label>
              <Input type="number" min={1} value={form.rotationWeek} onChange={(e) => setForm({ ...form, rotationWeek: Number(e.target.value) })} />
            </div>
            <div>
              <Label>Day of Week</Label>
              <Select value={String(form.dayOfWeek)} onValueChange={(v) => setForm({ ...form, dayOfWeek: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DAYS.map((d) => <SelectItem key={d} value={String(d)}>{DAY_LABEL[d]}</SelectItem>)}</SelectContent>
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
              <Label>Slot Label</Label>
              <Input value={form.slotLabel} onChange={(e) => setForm({ ...form, slotLabel: e.target.value })} placeholder="e.g. Main course" />
            </div>
            <div>
              <Label>Sort Order</Label>
              <Input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
            </div>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget ? `${delTarget.dishName ?? dishName(delTarget.dishId)} (${DAY_LABEL[delTarget.dayOfWeek]}, ${MEAL_LABEL[delTarget.mealType]})` : ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3) PER-RESIDENT RULES
// ════════════════════════════════════════════════════════════════════════════
type RuleForm = {
  brand: FoodBrand; mealType: MealType; dishId: string; propertyId: string;
  qtyPerResident: string; unit: string;
};
const emptyRule: RuleForm = {
  brand: "UNILIV", mealType: "BREAKFAST", dishId: "", propertyId: "", qtyPerResident: "", unit: "SERVING",
};

function RulesTab({ properties, propName }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string }) {
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
        propertyId: v.propertyId || null,
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
    setForm({ brand: r.brand, mealType: r.mealType, dishId: r.dishId, propertyId: r.propertyId ?? "", qtyPerResident: String(r.qtyPerResident ?? ""), unit: r.unit });
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
    { accessorKey: "propertyId", header: "Scope", cell: ({ row }: any) => row.original.propertyId
        ? <span className="text-sm">{propName(row.original.propertyId)}</span>
        : <Badge variant="secondary" className="text-[10px]">GLOBAL DEFAULT</Badge> },
    { accessorKey: "qtyPerResident", header: "Qty / Resident", cell: ({ row }: any) => <span className="font-medium">{fmtQty(row.original.qtyPerResident, row.original.unit)}</span> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Per-Resident Rules" description="Default quantity per resident, optionally overridden per property."
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
          <div>
            <Label>Property</Label>
            <Select value={form.propertyId || "__GLOBAL__"} onValueChange={(v) => setForm({ ...form, propertyId: v === "__GLOBAL__" ? "" : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__GLOBAL__">Global default (all properties)</SelectItem>
                {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Leave as global to apply across all properties.</p>
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
type PartnerForm = { name: string; phone: string; vehicleNumber: string };
const emptyPartner: PartnerForm = { name: "", phone: "", vehicleNumber: "" };

function PartnersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DeliveryPartner | null>(null);
  const [delTarget, setDelTarget] = React.useState<DeliveryPartner | null>(null);
  const [form, setForm] = React.useState<PartnerForm>(emptyPartner);

  const { data: partners = [], isLoading } = useQuery<DeliveryPartner[]>({
    queryKey: foodKeys.partners({}),
    queryFn: () => foodApi.listPartners(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "delivery-partners"] });
    qc.invalidateQueries({ queryKey: foodKeys.lookups() });
  };

  const saveMut = useMutation({
    mutationFn: (v: PartnerForm) => {
      const body = { name: v.name, phone: v.phone || null, vehicleNumber: v.vehicleNumber || null };
      return editing ? foodApi.updatePartner(editing.id, body) : foodApi.createPartner(body);
    },
    onSuccess: () => { toast({ title: editing ? "Partner updated" : "Partner created" }); invalidate(); setModalOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deletePartner(id),
    onSuccess: () => { toast({ title: "Partner deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyPartner); setModalOpen(true); };
  const openEdit = (p: DeliveryPartner) => {
    setEditing(p);
    setForm({ name: p.name, phone: p.phone ?? "", vehicleNumber: p.vehicleNumber ?? "" });
    setModalOpen(true);
  };
  const submit = () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    saveMut.mutate(form);
  };

  const cols = [
    { accessorKey: "name", header: "Partner", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "phone", header: "Phone", cell: ({ row }: any) => row.original.phone ? <span className="font-mono text-xs">{row.original.phone}</span> : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "vehicleNumber", header: "Vehicle", cell: ({ row }: any) => row.original.vehicleNumber ? <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.vehicleNumber}</span> : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "isActive", header: "Status", cell: ({ row }: any) => <Badge variant={row.original.isActive ? "success" : "secondary"} className="text-[10px]">{row.original.isActive ? "ACTIVE" : "INACTIVE"}</Badge> },
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={() => openEdit(row.original)} onDelete={() => setDelTarget(row.original)} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Delivery Partners" description="People and vehicles available for dispatching food orders."
        action={<Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Partner</Button>}
      />
      <DataTable columns={cols as any} data={partners} isLoading={isLoading} />

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Partner" : "Add Partner"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create Partner"}>
        <div className="space-y-4">
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="font-mono" />
          </div>
          <div>
            <Label>Vehicle Number</Label>
            <Input value={form.vehicleNumber} onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })} className="font-mono" />
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} label={delTarget?.name ?? ""} onConfirm={() => delTarget && delMut.mutate(delTarget.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 5) HIERARCHY (Zones / Cities / Clusters + Property Assignment)
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
