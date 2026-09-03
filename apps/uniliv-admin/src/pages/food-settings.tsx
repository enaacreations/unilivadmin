import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, UtensilsCrossed, CalendarRange, Building2, Globe,
  Clock, Boxes, SlidersHorizontal, RotateCcw,
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
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL,
  type FoodLookups, type FoodBrand, type MealType, type MealConfig,
  type MealWindow, type FoodCutoffConfig, type FoodDefaults, type OrderHeadroom,
} from "@/lib/food-api";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { DishesCatalogue } from "@/components/food/dishes-catalogue";
import { IngredientsGrid } from "@/components/food/ingredients-grid";
import { RotationBoard } from "@/components/food/rotation-board";
import { MenuRulesEditor } from "@/components/food/menu-rules";
import { FoodQueryError } from "@/components/food/query-error";
import { useActiveBrands } from "@/components/food/use-food-masters";

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
 * Settings navigation — one flat strip. The list shrank enough (the removed
 * Kitchens / Agencies / Hierarchy / Users tabs, Portion Size Rules folded into
 * the Dishes drawer) that a "More" dropdown hid two items to save no space.
 */
type SettingsTab = {
  value: string; label: string; icon: typeof Globe;
  /** Super Admin only (org-wide defaults). */
  gated?: boolean;
  /** Needs the catalogue grant — the definitional tabs. See FOOD_CATALOGUE. */
  catalogue?: boolean;
};

// Ordered the way a service set is actually built: the raw materials, then the
// dishes made from them, then the rule a plate must satisfy, then the rotation
// built against that rule. Meals & Cut-offs is configured once and rarely
// revisited, so it sits after the four that get daily use.
const TABS: SettingsTab[] = [
  { value: "ingredients", label: "Ingredients", icon: Boxes, catalogue: true },
  { value: "dishes", label: "Dishes", icon: UtensilsCrossed, catalogue: true },
  { value: "composition", label: "Menu Rules", icon: SlidersHorizontal, catalogue: true },
  { value: "rotation", label: "Menu", icon: CalendarRange },
  // Was two tabs — "Meal Types" and "Cut-offs & Service". Both configure the
  // same handful of meal slots (what they're called, when ordering for them
  // closes, when they're served), so setting one up meant bouncing between
  // tabs. One tab, three sections, same order as the questions get asked.
  { value: "meals", label: "Meals & Cut-offs", icon: Clock },
  // Org-wide defaults — Super Admin only (see canFoodDefaults).
  { value: "food-defaults", label: "Food Defaults", icon: Globe, gated: true },
];

export default function FoodSettings() {
  const { data: lookups, isError: lookupsError, refetch: refetchLookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name ?? "—") : "—";
  const { role, can } = usePermissions();
  const isSuperAdmin = isSuperAdminRole(role);
  // Ingredients / Dishes / Menu Rules define what a plate may contain. Roles
  // without the grant (F&B Manager) build the rotation from the agreed
  // catalogue instead of editing it, so those three tabs are not shown —
  // the write endpoints refuse them too, this is not the only gate.
  const canCatalogue = can("FOOD_CATALOGUE", "view");
  // Food Defaults are org-wide (default cut-off + waste edit window) — Super
  // Admin only (backend PUT mirrors this). F&B Manager manages day-to-day food
  // config but not these org-wide fallbacks.
  const canFoodDefaults = isSuperAdmin;
  // Every other write here is FOOD_SETTINGS edit server-side; PageGuard only
  // checks view, so read-only principals (AUDIT_READONLY) reach this page.
  const canEdit = can("FOOD_SETTINGS", "edit");
  // Two config surfaces here are BRAND-WIDE by construction — the per-resident
  // portion rules (no property/kitchen column at all) and the composition rules'
  // brand-level row. The server refuses both for a scope-restricted caller (H4),
  // so the controls have to know: `myKitchenIds` is the authoritative signal
  // (null = unrestricted). Undefined while the lookup is in flight, which reads
  // as restricted — better a briefly-hidden button than one that 403s.
  const orgWideConfig = lookups != null && lookups.myKitchenIds == null;

  const visibleTabs = TABS.filter((t) =>
    (!t.gated || canFoodDefaults) && (!t.catalogue || canCatalogue));

  // Controlled so the rotation board can send you to Menu Rules when a meal has
  // no rule to build against.
  const [tab, setTab] = React.useState("dishes");
  const [rulesFocus, setRulesFocus] = React.useState<{ brand: string; meal: MealType }>();

  // Kitchen + brand are page-level, not per-tab: picking Koramangala under Menu
  // Rules should leave you on Koramangala when you switch to Menu. Each tab
  // unmounts when inactive, so local state there was silently reset on every
  // switch. "" until whichever tab mounts first seeds them.
  const [kitchenId, setKitchenId] = React.useState("");
  const [brand, setBrand] = React.useState("");
  // Menu Rules can also sit on "all kitchens" (the brand default), which the
  // board has no equivalent of. It lives here rather than in the tab so that
  // choosing it survives a trip to another tab and back — tab-local state would
  // be thrown away on unmount and silently snap back to a specific kitchen.
  // Starts true: every rule authored before the picker existed is a brand default.
  const [rulesAllKitchens, setRulesAllKitchens] = React.useState(true);
  const menuScope = {
    kitchenId, onKitchenChange: setKitchenId,
    brand, onBrandChange: setBrand,
  };

  // A tab the role cannot see renders no trigger AND no content, so landing on
  // one would show an empty page. Fall back to the first tab that is actually
  // there — which is what a role without the catalogue does on arrival, since
  // the default is Dishes.
  React.useEffect(() => {
    if (!visibleTabs.length) return;
    if (!visibleTabs.some((t) => t.value === tab)) setTab(visibleTabs[0]!.value);
  }, [visibleTabs, tab]);

  // No PageHeader: every tab already opens with its own heading and one-line
  // explanation, so a page-level title only pushed the tab strip down and
  // repeated what the sidebar already says.
  return (
    <div className="space-y-6">
      {/* A failed lookup leaves `properties` empty, which reads as "this org has
          no properties" in every scope picker below — so a per-property cut-off
          would silently be saved as a global one. Say it failed. */}
      {lookupsError && (
        <FoodQueryError
          label="the property list"
          hint="Scope pickers on these tabs will be missing their properties until this loads."
          onRetry={() => refetchLookups()}
        />
      )}
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        {/* The scroll container (<main>) is padded, so a plain `top-0` pins the
            strip to its PADDING box — leaving a gap the width of that padding in
            which content scrolls visibly above the tabs. Cancel the padding on
            all four sides with negative top/margins, then add it back as the
            strip's own padding: the tabs stay exactly where they were, but the
            opaque background now reaches the scrollport edges and nothing can
            slide past it. */}
        <div className="sticky -top-4 sm:-top-6 z-20 -mx-4 sm:-mx-6 -mt-4 sm:-mt-6 bg-background px-4 sm:px-6 pt-4 sm:pt-6 pb-2">
          <TabsList className="flex h-auto w-fit max-w-full flex-nowrap justify-start gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleTabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="shrink-0 whitespace-nowrap">
                <Icon className="h-4 w-4 mr-2" /> {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* The four menu-building tabs mount lazily — the rotation board and the
            plate composer each pull the whole dish catalogue, which is wasted
            work on a visit to, say, Meals & Cut-offs. */}
        {/* Two independent gates, and they answer different questions.
            `canCatalogue` (FOOD_CATALOGUE:view) decides whether the three
            definitional tabs EXIST for this role at all. `canEdit`
            (FOOD_SETTINGS:edit) decides whether the controls inside a tab the
            role can see are armed (M16): each of these tabs writes through a
            FOOD_SETTINGS:edit endpoint, and AUDIT_READONLY holds
            FOOD_SETTINGS:view through ALL_MODULES — so without it that role got
            an armed New dish / Delete / Duplicate week / plate save, each of
            which 403s at the server. */}
        {canCatalogue && (
          <>
            <TabsContent value="ingredients"><IngredientsGrid canEdit={canEdit} /></TabsContent>
            <TabsContent value="dishes"><DishesCatalogue canEdit={canEdit} orgWideConfig={orgWideConfig} /></TabsContent>
            <TabsContent value="composition">
              <MenuRulesEditor
                canEdit={canEdit} orgWideConfig={orgWideConfig}
                focus={rulesFocus} {...menuScope}
                allKitchens={rulesAllKitchens} onAllKitchensChange={setRulesAllKitchens}
                onGoToDishes={() => setTab("dishes")}
                onGoToIngredients={() => setTab("ingredients")}
              />
            </TabsContent>
          </>
        )}
        <TabsContent value="rotation">
          {/* Only offer the jump to Menu Rules to someone who can open them. */}
          <RotationBoard
            canEdit={canEdit}
            {...menuScope}
            onGoToRules={canCatalogue
              ? (f) => { setRulesFocus(f); setTab("composition"); }
              : undefined}
          />
        </TabsContent>
        <TabsContent value="meals">
          <MealsAndCutoffsTab
            properties={properties} propName={propName}
            canEdit={canEdit} orgWideConfig={orgWideConfig}
          />
        </TabsContent>
        {canFoodDefaults && (
          <TabsContent value="food-defaults" className="space-y-4">
            <FoodDefaultsTab />
            <OrderHeadroomCard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6) MEALS & CUT-OFFS
// Three sections that all describe the same handful of meal slots, read in the
// order they get decided: what the slots ARE, when ordering for them CLOSES,
// and when each one is SERVED. They were two separate tabs, which put a meal's
// name and its service time a tab apart.
// ════════════════════════════════════════════════════════════════════════════
function MealsAndCutoffsTab({
  properties, propName, canEdit, orgWideConfig,
}: {
  properties: FoodLookups["properties"];
  propName: (id?: string | null) => string;
  canEdit: boolean;
  orgWideConfig: boolean;
}) {
  // space-y-8 rather than the sections' own space-y-4: three stacked sections
  // need a bigger gap between them than between a heading and its table, or
  // the seams disappear and it reads as one very long list.
  return (
    <div className="space-y-8">
      <MealTypesSection properties={properties} propName={propName} canEdit={canEdit} orgWideConfig={orgWideConfig} />
      <CutoffConfigPanel properties={properties} propName={propName} canEdit={canEdit} />
      <ServiceTimesSection properties={properties} propName={propName} canEdit={canEdit} />
    </div>
  );
}

// ─── 6a) Meal types — the slots themselves ───────────────────────────────────
type MealConfigForm = { displayLabel: string; sortOrder: number; isEnabled: boolean };

function MealTypesSection({
  properties, propName, canEdit, orgWideConfig,
}: {
  properties: FoodLookups["properties"];
  propName: (id?: string | null) => string;
  canEdit: boolean;
  orgWideConfig: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // "" = the organisation-wide default row; otherwise a property's override.
  // Same sentinel the cut-off and service-time scope pickers below use.
  const [scopeId, setScopeId] = React.useState("");
  const [editing, setEditing] = React.useState<MealConfig | null>(null);
  const [form, setForm] = React.useState<MealConfigForm>({ displayLabel: "", sortOrder: 0, isEnabled: true });
  const [resetTarget, setResetTarget] = React.useState<MealConfig | null>(null);

  // H4, narrowed: the GLOBAL row still moves every property that has not
  // overridden it, so writing it still takes org-wide authority and the server
  // still 403s a scoped caller. A property override moves only that property,
  // so it needs no more than FOOD_SETTINGS:edit — which is the whole point of
  // this picker. Gate each scope on what it can actually reach.
  const canEditScope = canEdit && (scopeId !== "" || orgWideConfig);

  const params = scopeId ? { propertyId: scopeId } : {};
  const { data: configs = [], isLoading, isError, refetch } = useQuery<MealConfig[]>({
    queryKey: foodKeys.mealConfig(params),
    queryFn: () => foodApi.mealConfig(params),
  });

  // What is IN FORCE at the selected scope: the property's own row wins, else
  // the org default it inherits. Mirrors the server's pickMealConfig, minus the
  // enabled filter — a disabled meal must stay visible here or there would be no
  // way to switch it back on.
  const rows = React.useMemo(() => {
    const byMeal = new Map<string, MealConfig>();
    for (const c of configs) {
      if (c.propertyId !== null && c.propertyId !== scopeId) continue;
      const cur = byMeal.get(c.mealType);
      if (!cur || c.propertyId === scopeId) byMeal.set(c.mealType, c);
    }
    return [...byMeal.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [configs, scopeId]);
  const isOverride = (c: MealConfig) => c.propertyId !== null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "meal-config"] });

  // `propertyId` decides which row the write lands on, so it goes on every
  // mutation. Sending it for an INHERITED row is what creates the override —
  // the server seeds the new row from the org default, so a bare toggle keeps
  // the label and ordering that were already in force.
  const scopeBody = () => ({ propertyId: scopeId || null });

  const saveMut = useMutation({
    mutationFn: (v: MealConfigForm & { mealType: string }) =>
      foodApi.updateMealConfig(v.mealType, {
        ...scopeBody(),
        displayLabel: v.displayLabel.trim(),
        sortOrder: v.sortOrder,
        isEnabled: v.isEnabled,
      }),
    onSuccess: () => { toast({ title: scopeId ? "Property meal type saved" : "Meal type updated" }); invalidate(); setEditing(null); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const toggleMut = useMutation({
    mutationFn: (c: MealConfig) =>
      foodApi.updateMealConfig(c.mealType, {
        ...scopeBody(),
        displayLabel: c.displayLabel,
        sortOrder: c.sortOrder,
        isEnabled: !c.isEnabled,
      }),
    onSuccess: () => { toast({ title: "Meal type updated" }); invalidate(); },
    onError: (e: any) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });
  const resetMut = useMutation({
    mutationFn: (c: MealConfig) => foodApi.deleteMealConfigOverride(c.mealType, c.propertyId!),
    onSuccess: () => { toast({ title: "Reverted to the organisation default" }); invalidate(); setResetTarget(null); },
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
            disabled={toggleMut.isPending || !canEditScope}
          />
          <span className={`text-xs font-medium ${row.original.isEnabled ? "text-success" : "text-muted-foreground"}`}>
            {row.original.isEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
      ),
    },
    // Only meaningful inside a property: at org scope every row is the default
    // BY DEFINITION, so a column saying so on every line is pure noise.
    ...(scopeId ? [{
      id: "scope", header: "Source",
      cell: ({ row }: any) => isOverride(row.original)
        ? <Badge variant="outline" className="text-[10px]"><Building2 className="h-3 w-3 mr-1" /> This property</Badge>
        : <Badge variant="secondary" className="text-[10px]"><Globe className="h-3 w-3 mr-1" /> Inherited</Badge>,
    }] : []),
    {
      id: "actions", header: () => <div className="text-right">Actions</div>,
      cell: ({ row }: any) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {canEditScope && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row.original)} title="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* Reset only exists for a row this property actually owns — an
              inherited row has nothing to revert to. */}
          {canEditScope && isOverride(row.original) && (
            <Button
              variant="ghost" size="icon" className="h-8 w-8"
              onClick={() => setResetTarget(row.original)}
              title="Revert to the organisation default"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Meal Types"
        description="Customise the label, ordering and availability of each meal slot — for the whole organisation, or for one property. Meal types are fixed; only their presentation can be edited."
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={scopeId || "__GLOBAL__"} onValueChange={(v) => setScopeId(v === "__GLOBAL__" ? "" : v)}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Scope" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__GLOBAL__">Organisation default (all properties)</SelectItem>
            {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {scopeId
            ? <>Editing <span className="font-medium text-foreground">{propName(scopeId)}</span>. Changing an inherited row creates an override for this property only; everywhere else keeps the organisation default.</>
            : <>Applies everywhere except properties that have set their own — pick a property above to give it different meals.</>}
        </p>
      </div>

      {/* Read-only at org scope is a real state (F&B Manager can set their own
          properties but not move the network), and silently disabled controls
          look broken — say which it is. */}
      {!scopeId && canEdit && !orgWideConfig && (
        <p className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Globe className="h-3.5 w-3.5 shrink-0" />
          The organisation default applies to every property, so only an org-wide administrator can change it. Pick a property above to configure the meals you do control.
        </p>
      )}

      {/* An empty table here reads as "this org serves no meals" — never render
          a failed read as the configured state. */}
      {isError
        ? <FoodQueryError label="the meal types" onRetry={() => refetch()} />
        : <DataTable columns={cols as any} data={rows} isLoading={isLoading} />}

      <FormModal
        open={!!editing} onOpenChange={(o) => !o && setEditing(null)}
        title={scopeId ? `Edit Meal Type — ${propName(scopeId)}` : "Edit Meal Type"}
        onSave={submit} isSaving={saveMut.isPending} saveLabel="Save Changes"
      >
        <div className="space-y-4">
          {editing && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">{editing.mealType}</Badge>
              <span className="text-xs text-muted-foreground">System meal type</span>
              {scopeId
                ? <Badge variant="secondary" className="text-[10px]"><Building2 className="h-3 w-3 mr-1" /> {propName(scopeId)}</Badge>
                : <Badge variant="secondary" className="text-[10px]"><Globe className="h-3 w-3 mr-1" /> All properties</Badge>}
            </div>
          )}
          {/* Saying so BEFORE the save, not after: the row on screen is the org
              default, and the fields are pre-filled from it, so without this the
              dialog looks like it is editing the thing it is about to fork. */}
          {editing && scopeId && !isOverride(editing) && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This meal currently follows the organisation default. Saving creates an override for {propName(scopeId)} — no other property is affected.
            </p>
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
              <p className="text-xs text-muted-foreground">Disabled meal types are hidden from ordering{scopeId ? ` at ${propName(scopeId)}` : ""}.</p>
            </div>
            <Switch checked={form.isEnabled} onCheckedChange={(v) => setForm({ ...form, isEnabled: v })} />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}
        title="Revert to organisation default"
        onSave={() => resetTarget && resetMut.mutate(resetTarget)}
        isSaving={resetMut.isPending} saveLabel="Revert"
      >
        <p className="text-sm text-muted-foreground">
          {resetTarget && (
            <>Remove the <span className="font-medium text-foreground">{MEAL_LABEL[resetTarget.mealType] ?? resetTarget.mealType}</span> override at{" "}
            <span className="font-medium text-foreground">{propName(resetTarget.propertyId)}</span>? It will follow the organisation default again.</>
          )}
        </p>
      </FormModal>
    </div>
  );
}

// ─── 6b) Cut-off — when ordering closes ──────────────────────────────────────
// Single cut-off time per brand (applies to ALL meals; optional per-property override).
type CutoffForm = { brand: FoodBrand; cutoffTime: string; propertyId: string };
function CutoffConfigPanel({ properties, propName, canEdit }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const brandOptions = useActiveBrands();
  const { data: rows = [], isLoading, isError, refetch } = useQuery<FoodCutoffConfig[]>({ queryKey: foodKeys.cutoffConfig(), queryFn: () => foodApi.listCutoffConfig() });
  // resolveCutoff falls back to the org default and can never return null, so
  // "no rows" means "the default is in force", not "orders never close". Read
  // it here (GET is open to any authenticated food user) and state the value —
  // the editable Food Defaults tab is Super Admin only, but everyone subject to
  // the cut-off needs to see what it is.
  const { data: defaults, isError: defaultsError } = useQuery<FoodDefaults>({
    queryKey: ["food", "system-config", "food-defaults"],
    queryFn: () => foodApi.foodDefaults(),
  });
  // The 09:00 fallback is a placeholder, not a reading — on a failed fetch say
  // so rather than printing a cut-off time the org may not actually use.
  const defaultCutoff = defaultsError ? "unknown" : (defaults?.defaultCutoff ?? "09:00");
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
        {canEdit && <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4 mr-1" /> Add cut-off</Button>}
      </CardHeader>
      <CardContent>
        {/* The value in force when nothing below matches — always something. */}
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          Organisation default: <span className="font-mono text-foreground">{defaultCutoff}</span>
          <span>— used whenever no brand or property cut-off below applies.</span>
        </p>
        {/* "No cut-off configured" is a claim about live config that decides when
            ordering closes — never make it on the strength of a failed read. */}
        {isError ? <FoodQueryError label="the cut-off overrides" onRetry={() => refetch()} />
          : isLoading ? <p className="py-4 text-sm text-muted-foreground">Loading…</p>
          : rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No brand or property cut-off configured — every order closes at the organisation default of <span className="font-mono text-foreground">{defaultCutoff}</span>. Add one to override it.</p>
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
                    {canEdit && (
                      <>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDelTarget(c)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </>
                    )}
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

// ─── 6c) Service times — when each meal is served ────────────────────────────
type WindowForm = {
  brand: FoodBrand; mealType: MealType; serviceTime: string;
  leadTimeMinutes: number; propertyId: string;
};
const emptyWindow: WindowForm = {
  brand: "UNILIV", mealType: "BREAKFAST", serviceTime: "",
  leadTimeMinutes: 0, propertyId: "",
};

function ServiceTimesSection({ properties, propName, canEdit }: { properties: FoodLookups["properties"]; propName: (id?: string | null) => string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // The live brand master, not the two-brand dev fallback: a service time is
  // what stamps expectedDeliveryAt, so a brand missing from this list can never
  // be given one and drops out of on-time reporting entirely.
  const brandOptions = useActiveBrands();
  const [brand, setBrand] = React.useState("ALL");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MealWindow | null>(null);
  const [delTarget, setDelTarget] = React.useState<MealWindow | null>(null);
  const [form, setForm] = React.useState<WindowForm>(emptyWindow);

  const params: Record<string, unknown> = brand === "ALL" ? {} : { brand };
  const { data: windows = [], isLoading, isError, refetch } = useQuery<MealWindow[]>({
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

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyWindow, brand: (brandOptions[0]?.code as FoodBrand) ?? emptyWindow.brand });
    setModalOpen(true);
  };
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
    { id: "actions", header: () => <div className="text-right">Actions</div>, cell: ({ row }: any) => <RowActions onEdit={canEdit ? () => openEdit(row.original) : undefined} onDelete={canEdit ? () => setDelTarget(row.original) : undefined} /> },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Service Times" description="Per-meal service/delivery time + lead time (used for ETAs & delay analytics). The cut-off above applies to all meals."
        action={canEdit ? <Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Service Time</Button> : undefined}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Brands</SelectItem>
            {brandOptions.map((b) => <SelectItem key={b.code} value={b.code}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* An empty table would say "no service times configured", which sends the
          user to add a duplicate of one that already exists. */}
      {isError
        ? <FoodQueryError label="the service times" onRetry={() => refetch()} />
        : <DataTable columns={cols as any} data={windows} isLoading={isLoading} />}

      <FormModal open={modalOpen} onOpenChange={setModalOpen} title={editing ? "Edit Service Time" : "Add Service Time"} onSave={submit} isSaving={saveMut.isPending} saveLabel={editing ? "Save Changes" : "Create"}>
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
  // Same invariant as the rotation generator: this form's Save OVERWRITES the
  // stored org defaults, and the fields seed from 09:00/60 when `data` is
  // absent. A failed read must not present those placeholders as the current
  // values and let one click write them over the real ones.
  const { data, isLoading, isError, refetch } = useQuery<FoodDefaults>({
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
    mutationFn: async () => {
      // Restated at the write: never save values that were never read back.
      if (!data) throw new Error("The current defaults could not be read — reload before saving.");
      return foodApi.updateFoodDefaults({ defaultCutoff: defaultCutoff.trim(), wasteWindowMinutes });
    },
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
        {isError ? (
          <FoodQueryError
            label="the current food defaults"
            hint="Saving now would write the placeholder values over whatever is really stored, so the form stays hidden until this loads."
            onRetry={() => refetch()}
          />
        ) : isLoading ? (
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

// ════════════════════════════════════════════════════════════════════════════
// Ordering headroom (SUPER_ADMIN + OPS_EXCELLENCE) — the single percentage that
// bounds how far above the derived numbers an order may go. Its own card, and
// its own save, because it writes through a different endpoint with a different
// gate than the two org defaults above: those are FOOD_SETTINGS, this one is
// super-admin parity (it lifts the ordering ceiling for every property at once).
// ════════════════════════════════════════════════════════════════════════════
function OrderHeadroomCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  // Same invariant as Food Defaults: Save OVERWRITES the stored value, so a
  // failed read must not let the seeded placeholder be written over the real one.
  const { data, isLoading, isError, refetch } = useQuery<OrderHeadroom>({
    queryKey: foodKeys.orderHeadroom(),
    queryFn: () => foodApi.orderHeadroom(),
  });

  const [pct, setPct] = React.useState(100);
  React.useEffect(() => {
    if (data) setPct(data.pct);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("The current headroom could not be read — reload before saving.");
      return foodApi.updateOrderHeadroom(pct);
    },
    onSuccess: (saved) => {
      toast({
        title: "Ordering headroom saved",
        description: `Orders may now go up to ${saved.pct}% above the derived headcount and quantity.`,
      });
      // The ordering grid draws its own +/- ceilings from this, so refresh it
      // rather than leaving open tabs enforcing the previous number.
      qc.invalidateQueries({ queryKey: foodKeys.orderHeadroom() });
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to save", variant: "destructive" }),
  });

  const maxPct = data?.maxPct ?? 1000;
  const defaultPct = data?.defaultPct ?? 100;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" /> Ordering Headroom
        </CardTitle>
        <CardDescription className="text-xs">
          How far above the derived numbers a property may order. One percentage bounds all three
          ordering limits — residents against occupancy, people per dish, and the quantity per dish —
          because each is computed from the one before it. Super Admin / Ops Excellence only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <FoodQueryError
            label="the current ordering headroom"
            hint="Saving now would write the placeholder over whatever is really stored, so the form stays hidden until this loads."
            onRetry={() => refetch()}
          />
        ) : isLoading ? (
          <p className="py-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5 max-w-md">
            <div>
              <Label>Headroom above the derived number (%)</Label>
              <NumberStepper value={pct} onChange={setPct} min={0} max={maxPct} step={10} />
              <p className="mt-1 text-xs text-muted-foreground">
                {pct === 0
                  ? "0% — orders may not exceed the derived headcount or quantity at all."
                  : `${pct}% — a meal for 50 people can be ordered for up to ${Math.ceil(50 * (1 + pct / 100))}.`}
                {" "}Default {defaultPct}%.
              </p>
            </div>
            <Button onClick={() => save.mutate()} disabled={save.isPending || pct === data?.pct}>
              {save.isPending ? "Saving…" : "Save headroom"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
