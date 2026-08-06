import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, ChevronRight, MapPin, ChefHat, Building2, Tag,
  Users, AlertTriangle, Globe, Network, ShieldCheck, Settings2, Truck,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FormModal } from "@/components/ui/form-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { FoodQueryError } from "@/components/food/query-error";
import {
  foodApi, foodKeys,
  type HierarchyTree, type HierarchyKitchen, type HierarchyProperty,
  type FoodBrandRow, type Zone, type City, type Cluster, type Kitchen, type FoodUser, type UserScope, type FoodLookups,
} from "@/lib/food-api";
import { AgenciesTab } from "@/pages/food-agencies";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/* ════════════════════════════════════════════════════════════════════════════
 * Page
 * ════════════════════════════════════════════════════════════════════════════ */
export default function FoodOrganization() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization"
        subtitle="The India → City → Kitchen → Property → Brand hierarchy. Create and assign each piece, manage brands, and grant food users their access scopes."
      />
      <Tabs defaultValue="hierarchy" className="space-y-4">
        <TabsList>
          <TabsTrigger value="hierarchy"><Network className="mr-2 h-4 w-4" /> Hierarchy</TabsTrigger>
          <TabsTrigger value="brands"><Tag className="mr-2 h-4 w-4" /> Brands</TabsTrigger>
          <TabsTrigger value="agencies"><Truck className="mr-2 h-4 w-4" /> Agencies</TabsTrigger>
          <TabsTrigger value="leads"><ShieldCheck className="mr-2 h-4 w-4" /> Access</TabsTrigger>
        </TabsList>
        <TabsContent value="hierarchy"><HierarchyTab /></TabsContent>
        <TabsContent value="brands"><BrandsTab /></TabsContent>
        <TabsContent value="agencies"><AgenciesTab /></TabsContent>
        <TabsContent value="leads"><UnitLeadsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Hierarchy tab — tree explorer + inline CRUD
 * ════════════════════════════════════════════════════════════════════════════ */
function HierarchyTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Every write on this page is FOOD_ORG edit server-side; PageGuard only
  // checks view, so read-only principals (AUDIT_READONLY) reach it. Mirror the
  // server — the same gate food-agencies.tsx already applies.
  const { can } = usePermissions();
  const canManage = can("FOOD_ORG", "edit");

  const { data: tree, isLoading, isError, refetch } = useQuery<HierarchyTree>({
    queryKey: foodKeys.hierarchy(),
    queryFn: () => foodApi.hierarchy(),
  });
  const { data: cities = [] } = useQuery<City[]>({ queryKey: foodKeys.cities(), queryFn: () => foodApi.listCities() });
  const { data: kitchens = [] } = useQuery<Kitchen[]>({ queryKey: foodKeys.kitchens(), queryFn: () => foodApi.listKitchens() });
  const { data: brands = [] } = useQuery<FoodBrandRow[]>({ queryKey: foodKeys.brands(), queryFn: () => foodApi.listBrands() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: foodKeys.hierarchy() });
    qc.invalidateQueries({ queryKey: ["food", "cities"] });
    qc.invalidateQueries({ queryKey: ["food", "kitchens"] });
    qc.invalidateQueries({ queryKey: foodKeys.lookups() });
  };

  // ── modals ──
  const [cityOpen, setCityOpen] = React.useState(false);
  const [cityName, setCityName] = React.useState("");
  const [kitchenOpen, setKitchenOpen] = React.useState(false);
  const [kEdit, setKEdit] = React.useState<Kitchen | null>(null);
  const [kForm, setKForm] = React.useState({ name: "", code: "", cityId: "" });
  const [propTarget, setPropTarget] = React.useState<HierarchyProperty | null>(null);
  const [pForm, setPForm] = React.useState({ brand: "", kitchenId: "" });

  const createCity = useMutation({
    mutationFn: () => foodApi.createCity({ name: cityName.trim() }),
    onSuccess: () => { toast({ title: "City added" }); invalidate(); setCityOpen(false); setCityName(""); },
    onError: () => toast({ title: "Could not add city", variant: "destructive" }),
  });

  const saveKitchen = useMutation({
    mutationFn: () => kEdit
      ? foodApi.updateKitchen(kEdit.id, { name: kForm.name.trim(), cityId: kForm.cityId || null })
      : foodApi.createKitchen({ name: kForm.name.trim(), code: kForm.code.trim().toUpperCase(), cityId: kForm.cityId || null }),
    onSuccess: () => { toast({ title: kEdit ? "Kitchen updated" : "Kitchen added" }); invalidate(); setKitchenOpen(false); },
    onError: () => toast({ title: "Could not save kitchen", variant: "destructive" }),
  });

  // Two independent writes with no transaction: the brand can commit and the
  // kitchen then 403/422 (unknown kitchen, out-of-scope kitchen, or a restricted
  // caller clearing it). The kitchen goes FIRST because it is the one that can
  // be refused — that way a refusal leaves nothing applied. Either outcome
  // invalidates, so the tree never keeps showing pre-edit values for a property
  // that was in fact half-changed, and the server's own message is surfaced.
  const saveProp = useMutation({
    mutationFn: async () => {
      if (!propTarget) return;
      await foodApi.assignKitchen(propTarget.id, pForm.kitchenId || null);
      await foodApi.assignBrand(propTarget.id, pForm.brand || null);
    },
    onSuccess: () => { toast({ title: "Property updated" }); invalidate(); setPropTarget(null); },
    onError: (e: Error) => { invalidate(); toast({ title: "Could not update property", description: e.message, variant: "destructive" }); },
  });

  const openAddCity = () => { setCityName(""); setCityOpen(true); };
  const openAddKitchen = () => { setKEdit(null); setKForm({ name: "", code: "", cityId: cities[0]?.id ?? "" }); setKitchenOpen(true); };
  const openEditKitchen = (k: HierarchyKitchen | Kitchen) => { setKEdit(k as Kitchen); setKForm({ name: k.name, code: k.code, cityId: k.cityId ?? "" }); setKitchenOpen(true); };
  const openProp = (p: HierarchyProperty) => { setPropTarget(p); setPForm({ brand: p.brand ?? "", kitchenId: p.kitchenId ?? "" }); };

  if (isLoading) return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Loading hierarchy…</CardContent></Card>;
  // A failed fetch must never render as "0 cities · 0 kitchens · 0 properties" —
  // that reads as an unconfigured org and invites someone to rebuild it.
  if (isError) return <FoodQueryError label="the organization hierarchy" onRetry={() => refetch()} />;

  const cityCount = tree?.cities.length ?? 0;
  const kitchenCount = (tree?.cities.flatMap((c) => c.kitchens).length ?? 0) + (tree?.kitchensNoCity.length ?? 0);
  const propCount = (tree?.cities.flatMap((c) => c.kitchens.flatMap((k) => k.properties)).length ?? 0)
    + (tree?.kitchensNoCity.flatMap((k) => k.properties).length ?? 0) + (tree?.propertiesNoKitchen.length ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" /> India
          <span className="text-foreground">· {cityCount} cities · {kitchenCount} kitchens · {propCount} properties</span>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={openAddCity}><Plus className="mr-1 h-4 w-4" /> City</Button>
            <Button size="sm" onClick={openAddKitchen}><Plus className="mr-1 h-4 w-4" /> Kitchen</Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-3">
          <BoundedScroll size="lg">
          <div className="space-y-1 pr-3">
          {tree?.cities.map((city) => (
            <TreeRow
              key={city.id}
              icon={MapPin}
              label={city.name}
              meta={`${city.kitchens.length} kitchen${city.kitchens.length === 1 ? "" : "s"}`}
            >
              {city.kitchens.length === 0 && <EmptyHint>No kitchens in this city yet.</EmptyHint>}
              {city.kitchens.map((k) => (
                <KitchenNode key={k.id} kitchen={k} canManage={canManage} onEdit={() => openEditKitchen(k)} onProp={openProp} />
              ))}
            </TreeRow>
          ))}

          {(tree?.kitchensNoCity.length ?? 0) > 0 && (
            <TreeRow icon={AlertTriangle} label="Kitchens without a city" tone="warn" meta={`${tree!.kitchensNoCity.length}`} defaultOpen>
              {tree!.kitchensNoCity.map((k) => (
                <KitchenNode key={k.id} kitchen={k} canManage={canManage} onEdit={() => openEditKitchen(k)} onProp={openProp} />
              ))}
            </TreeRow>
          )}

          {(tree?.propertiesNoKitchen.length ?? 0) > 0 && (
            <TreeRow icon={AlertTriangle} label="Properties without a kitchen" tone="warn" meta={`${tree!.propertiesNoKitchen.length}`} defaultOpen>
              {tree!.propertiesNoKitchen.map((p) => (
                <PropertyRow key={p.id} property={p} canManage={canManage} onManage={() => openProp(p)} />
              ))}
            </TreeRow>
          )}
          </div>
          </BoundedScroll>
        </CardContent>
      </Card>

      {/* Add City */}
      <FormModal open={cityOpen} onOpenChange={setCityOpen} title="Add City" onSave={() => createCity.mutate()} isSaving={createCity.isPending} saveLabel="Add">
        <div className="space-y-2">
          <Label>City name</Label>
          <Input value={cityName} onChange={(e) => setCityName(e.target.value)} placeholder="e.g. Hyderabad" autoFocus />
        </div>
      </FormModal>

      {/* Add / Edit Kitchen */}
      <FormModal open={kitchenOpen} onOpenChange={setKitchenOpen} title={kEdit ? "Edit Kitchen" : "Add Kitchen"} onSave={() => saveKitchen.mutate()} isSaving={saveKitchen.isPending} saveLabel={kEdit ? "Save" : "Add"}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Kitchen name</Label>
            <Input value={kForm.name} onChange={(e) => setKForm((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Hyderabad Gachibowli Kitchen" />
          </div>
          {!kEdit && (
            <div className="space-y-2">
              <Label>Code</Label>
              <Input value={kForm.code} onChange={(e) => setKForm((s) => ({ ...s, code: e.target.value }))} placeholder="e.g. KIT-HYD-GAC" />
            </div>
          )}
          <div className="space-y-2">
            <Label>City</Label>
            <Select value={kForm.cityId} onValueChange={(v) => setKForm((s) => ({ ...s, cityId: v }))}>
              <SelectTrigger><SelectValue placeholder="Select city" /></SelectTrigger>
              <SelectContent>
                {cities.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      {/* Manage Property — brand + kitchen */}
      <FormModal open={!!propTarget} onOpenChange={(o) => !o && setPropTarget(null)} title={propTarget ? `Configure ${propTarget.name}` : ""} onSave={() => saveProp.mutate()} isSaving={saveProp.isPending} saveLabel="Save">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Brand</Label>
            <Select value={pForm.brand || "__none"} onValueChange={(v) => setPForm((s) => ({ ...s, brand: v === "__none" ? "" : v }))}>
              <SelectTrigger><SelectValue placeholder="Select brand" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">— None —</SelectItem>
                {brands.filter((b) => b.isActive).map((b) => <SelectItem key={b.code} value={b.code}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Kitchen</Label>
            <Select value={pForm.kitchenId || "__none"} onValueChange={(v) => setPForm((s) => ({ ...s, kitchenId: v === "__none" ? "" : v }))}>
              <SelectTrigger><SelectValue placeholder="Select kitchen" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">— None —</SelectItem>
                {kitchens.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>
    </div>
  );
}

function TreeRow({
  icon: Icon, label, meta, tone, defaultOpen, children,
}: {
  icon: typeof MapPin; label: string; meta?: string; tone?: "warn"; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cx(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-muted/60",
        tone === "warn" && "text-amber-600 dark:text-amber-500",
      )}>
        <ChevronRight className={cx("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        {meta && <span className="text-xs font-normal text-muted-foreground">{meta}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-4 border-l pl-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function KitchenNode({ kitchen, canManage, onEdit, onProp }: { kitchen: HierarchyKitchen; canManage: boolean; onEdit: () => void; onProp: (p: HierarchyProperty) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted/60">
        <CollapsibleTrigger className="flex flex-1 items-center gap-2 text-left text-sm">
          <ChevronRight className={cx("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <ChefHat className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{kitchen.name}</span>
          <Badge variant="outline" className="ml-1 shrink-0 text-[10px]">{kitchen.code}</Badge>
          <span className="text-xs text-muted-foreground">· {kitchen.properties.length} prop{kitchen.properties.length === 1 ? "" : "s"}</span>
        </CollapsibleTrigger>
        {canManage && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} title="Edit kitchen"><Pencil className="h-3.5 w-3.5" /></Button>
        )}
      </div>
      <CollapsibleContent className="ml-4 border-l pl-3">
        {kitchen.properties.length === 0 && <EmptyHint>No properties tagged to this kitchen.</EmptyHint>}
        {kitchen.properties.map((p) => <PropertyRow key={p.id} property={p} canManage={canManage} onManage={() => onProp(p)} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PropertyRow({ property, canManage, onManage }: { property: HierarchyProperty; canManage: boolean; onManage: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{property.name}</span>
      {property.brand
        ? <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]"><Tag className="h-3 w-3" />{property.brand}</Badge>
        : <Badge variant="destructive" className="shrink-0 text-[10px]">No brand</Badge>}
      <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex"><Users className="h-3 w-3" />{property.active}</span>
      {canManage && (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onManage} title="Configure"><Settings2 className="h-3.5 w-3.5" /></Button>
      )}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1.5 text-xs italic text-muted-foreground">{children}</p>;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Brands tab — master list CRUD
 * ════════════════════════════════════════════════════════════════════════════ */
function BrandsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Brand CRUD is FOOD_ORG edit server-side — same gate as the hierarchy tab.
  const { can } = usePermissions();
  const canManage = can("FOOD_ORG", "edit");
  const { data: brands = [], isLoading, isError, refetch } = useQuery<FoodBrandRow[]>({ queryKey: foodKeys.brands({ all: true }), queryFn: () => foodApi.listBrands({ all: true }) });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["food", "brands"] }); qc.invalidateQueries({ queryKey: foodKeys.lookups() }); };

  const [open, setOpen] = React.useState(false);
  const [edit, setEdit] = React.useState<FoodBrandRow | null>(null);
  const [form, setForm] = React.useState({ code: "", name: "", isActive: true });
  const [delTarget, setDelTarget] = React.useState<FoodBrandRow | null>(null);

  const save = useMutation({
    mutationFn: () => edit
      ? foodApi.updateBrand(edit.id, { name: form.name.trim(), isActive: form.isActive })
      : foodApi.createBrand({ code: form.code.trim(), name: form.name.trim(), isActive: form.isActive }),
    onSuccess: () => { toast({ title: edit ? "Brand updated" : "Brand added" }); invalidate(); setOpen(false); },
    onError: (e: any) => toast({ title: String(e?.message || "Could not save brand"), variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: (id: string) => foodApi.deleteBrand(id),
    onSuccess: () => { toast({ title: "Brand deactivated" }); invalidate(); setDelTarget(null); },
    onError: () => toast({ title: "Could not delete brand", variant: "destructive" }),
  });

  const openAdd = () => { setEdit(null); setForm({ code: "", name: "", isActive: true }); setOpen(true); };
  const openEdit = (b: FoodBrandRow) => { setEdit(b); setForm({ code: b.code, name: b.name, isActive: b.isActive }); setOpen(true); };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Brands</CardTitle>
          <CardDescription className="text-xs">Admin-managed master list. Each property and dish is tagged to one or more brands.</CardDescription>
        </div>
        {canManage && <Button size="sm" onClick={openAdd}><Plus className="mr-1 h-4 w-4" /> Add Brand</Button>}
      </CardHeader>
      <CardContent>
        {/* "No brands yet" for a failed fetch would invite a duplicate brand. */}
        {isError ? (
          <FoodQueryError label="the brand list" onRetry={() => refetch()} />
        ) : isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : brands.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No brands yet.</p>
        ) : (
          <BoundedScroll size="lg">
            <div className="space-y-1 pr-3">
              {brands.map((b) => (
                <div key={b.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1">
                    <span className="text-sm font-medium">{b.name}</span>
                    <Badge variant="outline" className="ml-2 text-[10px]">{b.code}</Badge>
                  </div>
                  {!b.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                  {canManage && (
                    <>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(b)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDelTarget(b)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </BoundedScroll>
        )}
      </CardContent>

      <FormModal open={open} onOpenChange={setOpen} title={edit ? "Edit Brand" : "Add Brand"} onSave={() => save.mutate()} isSaving={save.isPending} saveLabel={edit ? "Save" : "Add"}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Code</Label>
            <Input value={form.code} disabled={!!edit} onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} placeholder="e.g. XYZ" />
            {edit && <p className="text-xs text-muted-foreground">Code can't be changed after creation.</p>}
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. XYZ Living" />
          </div>
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch checked={form.isActive} onCheckedChange={(v) => setForm((s) => ({ ...s, isActive: v }))} />
          </div>
        </div>
      </FormModal>

      <FormModal open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)} title="Deactivate Brand" onSave={() => delTarget && del.mutate(delTarget.id)} isSaving={del.isPending} saveLabel="Deactivate">
        <p className="text-sm text-muted-foreground">Deactivate <span className="font-medium text-foreground">{delTarget?.name}</span>? It will be hidden from new assignments but existing data is preserved.</p>
      </FormModal>
    </Card>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Access tab — user ↔ scope grants, every role and every level
 *
 * This is the ONLY screen that can write user_scopes, and it used to be
 * hard-wired to role UNIT_LEAD × level PROPERTY. The resolver now honours all
 * five levels across both geo spines, and no role falls open when it holds no
 * grant — so a ZONE/CLUSTER/CITY/KITCHEN row is load-bearing, a wrong one is a
 * silent lockout, and an oversight role with no row at all sees nothing anywhere
 * until someone grants it here. Filtering any of that out of this tab left an
 * admin no way to see or fix it (C4g).
 *
 * Revoked grants are shown too (greyed, ?includeRevoked=true): revocation is
 * soft, and "never granted" and "deliberately revoked" have to be tellable apart
 * — that is the whole reason the isActive column exists.
 * ════════════════════════════════════════════════════════════════════════════ */

/** The geo dimension each level narrows on. Mirrors SCOPE_GEO_FIELD (food.ts). */
const SCOPE_LEVELS = [
  { level: "ZONE", field: "zoneId", label: "Zone", hint: "every city, cluster and property in the zone" },
  { level: "CITY", field: "cityId", label: "City", hint: "every kitchen and cluster in the city" },
  { level: "CLUSTER", field: "clusterId", label: "Cluster", hint: "every property in the cluster" },
  { level: "KITCHEN", field: "kitchenId", label: "Kitchen", hint: "every property the kitchen serves" },
  { level: "PROPERTY", field: "propertyId", label: "Property", hint: "one property" },
] as const;
type ScopeLevel = (typeof SCOPE_LEVELS)[number]["level"];

function UnitLeadsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Granting/revoking a scope is FOOD_ORG edit/delete server-side.
  const { can } = usePermissions();
  const canManage = can("FOOD_ORG", "edit");
  const { data: users = [], isError: usersError, refetch: refetchUsers } = useQuery<FoodUser[]>({ queryKey: foodKeys.users(), queryFn: () => foodApi.foodUsers() });
  const { data: lookups } = useQuery<FoodLookups>({ queryKey: foodKeys.lookups(), queryFn: () => foodApi.lookups() });
  const { data: zones = [] } = useQuery<Zone[]>({ queryKey: foodKeys.zones(), queryFn: () => foodApi.listZones() });
  const { data: cities = [] } = useQuery<City[]>({ queryKey: foodKeys.cities(), queryFn: () => foodApi.listCities() });
  const { data: clusters = [] } = useQuery<Cluster[]>({ queryKey: foodKeys.clusters(), queryFn: () => foodApi.listClusters() });
  const { data: kitchens = [] } = useQuery<Kitchen[]>({ queryKey: foodKeys.kitchens(), queryFn: () => foodApi.listKitchens() });
  const properties = lookups?.properties ?? [];

  /** Options + display name for one level, so add and list share one source. */
  const targets: Record<ScopeLevel, Array<{ id: string; name: string }>> = React.useMemo(() => ({
    ZONE: zones.filter((z) => z.isActive).map((z) => ({ id: z.id, name: z.name })),
    CITY: cities.filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name })),
    CLUSTER: clusters.filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name })),
    KITCHEN: kitchens.filter((k) => k.isActive).map((k) => ({ id: k.id, name: k.name })),
    PROPERTY: properties.map((p) => ({ id: p.id, name: p.name })),
  }), [zones, cities, clusters, kitchens, properties]);

  const nameOf = React.useCallback((level: string, id: string | null): string => {
    if (!id) return "—";
    const list = targets[level as ScopeLevel];
    return list?.find((t) => t.id === id)?.name ?? id;
  }, [targets]);

  const [userId, setUserId] = React.useState<string>("");
  React.useEffect(() => { if (!userId && users[0]) setUserId(users[0].id); }, [users, userId]);
  const selectedUser = users.find((u) => u.id === userId);

  const { data: scopes = [], isLoading: scopesLoading, isError: scopesError, refetch: refetchScopes } = useQuery<UserScope[]>({
    queryKey: foodKeys.scopes(userId),
    // Revoked rows included so a withdrawn grant stays visible as history.
    queryFn: () => foodApi.listScopes(userId, true),
    enabled: !!userId,
  });
  const live = scopes.filter((s) => s.isActive);
  const revoked = scopes.filter((s) => !s.isActive);

  const refresh = () => qc.invalidateQueries({ queryKey: foodKeys.scopes(userId) });

  const [addOpen, setAddOpen] = React.useState(false);
  const [addLevel, setAddLevel] = React.useState<ScopeLevel>("PROPERTY");
  const [addTargetId, setAddTargetId] = React.useState("");

  const levelField = SCOPE_LEVELS.find((l) => l.level === addLevel)!.field;
  const options = targets[addLevel];

  const add = useMutation({
    mutationFn: () => foodApi.createScope({ userId, scopeLevel: addLevel, [levelField]: addTargetId }),
    onSuccess: () => { toast({ title: "Access granted" }); refresh(); setAddOpen(false); setAddTargetId(""); },
    // The server explains itself (already held / not active / self-grant), so
    // show its message rather than a generic failure the admin cannot act on.
    onError: (e: Error) => toast({ title: "Could not grant access", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => foodApi.deleteScope(id),
    onSuccess: () => { toast({ title: "Access revoked" }); refresh(); },
    onError: (e: Error) => toast({ title: "Could not revoke", description: e.message, variant: "destructive" }),
  });

  const openAdd = (level: ScopeLevel) => {
    setAddLevel(level);
    setAddTargetId(targets[level][0]?.id ?? "");
    setAddOpen(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Access grants</CardTitle>
        <CardDescription className="text-xs">
          What each food user can see and edit. A grant at any level opens everything beneath it —
          zone → city → cluster → property, and city → kitchen → property. A user with no grant and no
          home property sees nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">User</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="w-80"><SelectValue placeholder="Select a user" /></SelectTrigger>
              <SelectContent>
                {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name} · {u.role.replace(/_/g, " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {canManage && (
            <Button size="sm" disabled={!userId} onClick={() => openAdd(addLevel)}>
              <Plus className="mr-1 h-4 w-4" /> Grant access
            </Button>
          )}
        </div>

        {/* An empty picker and a failed one look identical — say which it is. */}
        {usersError ? (
          <FoodQueryError label="the food-user list" onRetry={() => refetchUsers()} />
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No food users found.</p>
        ) : null}

        {userId && (
          scopesError ? (
            // "Sees nothing across the food module" is an assertion about this
            // user's access; a failed fetch is not evidence for it, and acting
            // on it would mean re-granting scopes they may already hold.
            <FoodQueryError label={`access grants for ${selectedUser?.name ?? "this user"}`} onRetry={() => refetchScopes()} />
          ) : scopesLoading ? (
            <p className="py-4 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-3">
              {live.length === 0 ? (
                <div className="rounded-md border border-dashed border-warning/50 bg-warning/5 px-3 py-6 text-center">
                  <AlertTriangle className="mx-auto mb-1.5 h-4 w-4 text-warning" />
                  <p className="text-sm font-medium">No live grants</p>
                  <p className="text-xs text-muted-foreground">
                    {selectedUser?.propertyId
                      ? "This user falls back to their home property only."
                      : "This user sees nothing across the food module until they are granted a scope."}
                  </p>
                </div>
              ) : (
                <BoundedScroll size="lg">
                  <div className="space-y-1 pr-3">
                    {live.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline" className="shrink-0 text-[11px]">{s.scopeLevel}</Badge>
                        <span className="flex-1 truncate text-sm">
                          {nameOf(s.scopeLevel, s.zoneId ?? s.cityId ?? s.clusterId ?? s.kitchenId ?? s.propertyId)}
                        </span>
                        {canManage && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove.mutate(s.id)} title="Revoke"><Trash2 className="h-3.5 w-3.5" /></Button>
                        )}
                      </div>
                    ))}
                  </div>
                </BoundedScroll>
              )}

              {revoked.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Revoked</p>
                  {revoked.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 opacity-60">
                      <Badge variant="outline" className="shrink-0 text-[11px]">{s.scopeLevel}</Badge>
                      <span className="flex-1 truncate text-sm line-through">
                        {nameOf(s.scopeLevel, s.zoneId ?? s.cityId ?? s.clusterId ?? s.kitchenId ?? s.propertyId)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </CardContent>

      <FormModal open={addOpen} onOpenChange={setAddOpen} title="Grant access" onSave={() => addTargetId && add.mutate()} isSaving={add.isPending} saveLabel="Grant">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Level</Label>
            <Select value={addLevel} onValueChange={(v) => { setAddLevel(v as ScopeLevel); setAddTargetId(targets[v as ScopeLevel][0]?.id ?? ""); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCOPE_LEVELS.map((l) => <SelectItem key={l.level} value={l.level}>{l.label} — {l.hint}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{SCOPE_LEVELS.find((l) => l.level === addLevel)!.label}</Label>
            <Select value={addTargetId} onValueChange={setAddTargetId}>
              <SelectTrigger><SelectValue placeholder={`Select ${addLevel.toLowerCase()}`} /></SelectTrigger>
              <SelectContent>
                {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {options.length === 0 && (
              // Only City and Kitchen are creatable on the Hierarchy tab. Zones
              // and clusters have no management screen at all, and properties
              // come from the Properties module — pointing all four at Hierarchy
              // sent the admin to a button that isn't there.
              <p className="text-xs text-muted-foreground">
                {addLevel === "ZONE" || addLevel === "CLUSTER"
                  ? `No active ${addLevel.toLowerCase()}s exist, and there is no screen to create one yet — grant at city or kitchen level instead.`
                  : addLevel === "PROPERTY"
                    ? "No property is in your own scope to grant."
                    : `No active ${addLevel.toLowerCase()} to grant — create one on the Hierarchy tab first.`}
              </p>
            )}
          </div>
        </div>
      </FormModal>
    </Card>
  );
}
