/**
 * Dish drawer — everything about one dish on a single surface.
 *
 * Two things moved in here from elsewhere. Ingredients are picked from one
 * searchable list (they used to be a stack of Select + Qty + Unit rows), and the
 * per-resident portion grid is edited beside the dish it belongs to rather than
 * on a separate tab — a dish with no portion rule is one the kitchen is never
 * told to cook, so the two belong together.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, Info, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, PREPARATIONS, PREPARATION_LABEL,
  type Dish, type Ingredient, type MealType, type PerResidentRule,
} from "@/lib/food-api";
import { MEAL_SHORT, componentLabel } from "./menu-lib";
import { PrepDot } from "./plate-composer";

const DISH_COMPONENTS = [
  "HOT_FOOD", "SABZI", "DAL", "RICE", "BREAD", "SALAD", "CURD_RAITA", "DESSERT",
  "PAPAD_PICKLE", "CHUTNEY", "PICKLE", "FRUITS", "BAKERY", "BEVERAGE", "SNACK", "MILK", "OTHER",
];
const DISH_UNITS = ["SERVING", "PLATE", "PCS", "G", "KG", "ML", "LITRE"];
/**
 * Courses a side dish plausibly belongs to. Sorting only — every dish stays
 * selectable, because "what goes with what" is a kitchen call, not a taxonomy.
 */
const SIDE_COMPONENTS = ["CHUTNEY", "CURD_RAITA", "PICKLE", "PAPAD_PICKLE", "SALAD", "BREAD", "SABZI", "DAL"];
/** Side-dish candidates rendered at once; the search narrows past this. */
const SIDE_LIMIT = 40;

export type DishDraft = {
  id: string | null;
  name: string;
  component: string;
  unit: string;
  brands: string[];
  preparations: string[];
  isActive: boolean;
  ingredientIds: string[];
  sidesOn: boolean;
  sideDishIds: string[];
  /** brand code → meal → qty per resident, "" meaning "not served then". */
  portions: Record<string, Record<string, string>>;
};

export const emptyPortions = (brands: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(brands.map((b) => [b, Object.fromEntries(MEAL_TYPES.map((m) => [m, ""]))]));

export const draftFromDish = (
  d: Dish | null, brands: string[], rules: PerResidentRule[],
): DishDraft => {
  const portions = emptyPortions(brands);
  for (const r of rules) {
    if (portions[r.brand]) portions[r.brand]![r.mealType] = String(r.qtyPerResident);
  }
  return {
    id: d?.id ?? null,
    name: d?.name ?? "",
    component: d?.component ?? "SABZI",
    unit: d?.unit ?? "SERVING",
    brands: d ? (d.brands ?? []) : brands,
    preparations: d?.preparations ?? ["VEG"],
    isActive: d?.isActive ?? true,
    ingredientIds: (d?.ingredients ?? []).map((i) => i.ingredientId),
    sidesOn: (d?.sideDishIds ?? []).length > 0,
    sideDishIds: d?.sideDishIds ?? [],
    portions,
  };
};

/** Selectable pill used by every chip group in this drawer. */
function Chip({
  on, onClick, children, className = "",
}: { on: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        on ? "border-accent bg-accent/10 font-medium text-accent-strong" : "border-border bg-card hover:bg-muted"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function ChipGroup({
  title, children,
}: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function DishDrawer({
  open, onOpenChange, draft, setDraft, dishes, ingredients, brands, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  draft: DishDraft | null;
  setDraft: (d: DishDraft | null) => void;
  dishes: Dish[];
  ingredients: Ingredient[];
  brands: { code: string; name: string }[];
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [ingOpen, setIngOpen] = React.useState(false);
  const [ingQuery, setIngQuery] = React.useState("");
  const [sideSearch, setSideSearch] = React.useState("");

  React.useEffect(() => { if (open) { setIngOpen(false); setIngQuery(""); setSideSearch(""); } }, [open]);

  const patch = (p: Partial<DishDraft>) => draft && setDraft({ ...draft, ...p });
  const ingById = React.useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const editing = dishes.find((d) => d.id === draft?.id) ?? null;

  // Portion rules currently on file, so save can diff rather than blindly rewrite.
  const { data: savedRules = [] } = useQuery<PerResidentRule[]>({
    queryKey: foodKeys.rules({ dishId: draft?.id ?? "" }),
    queryFn: () => foodApi.listRules({ dishId: draft!.id! }),
    enabled: open && !!draft?.id,
  });

  /** Creates / updates / deletes the per-resident rules to match the grid. */
  const syncPortions = async (dishId: string, d: DishDraft) => {
    const existing = new Map(savedRules.map((r) => [`${r.brand}|${r.mealType}`, r]));
    const jobs: Promise<unknown>[] = [];
    for (const b of brands) {
      for (const m of MEAL_TYPES) {
        const raw = (d.portions[b.code]?.[m] ?? "").trim();
        const prev = existing.get(`${b.code}|${m}`);
        if (!raw) { if (prev) jobs.push(foodApi.deleteRule(prev.id)); continue; }
        const qty = Number(raw);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        if (!prev) {
          jobs.push(foodApi.createRule({ brand: b.code, mealType: m, dishId, qtyPerResident: qty, unit: d.unit, isActive: true }));
        } else if (Number(prev.qtyPerResident) !== qty || prev.unit !== d.unit) {
          jobs.push(foodApi.updateRule(prev.id, { qtyPerResident: qty, unit: d.unit }));
        }
      }
    }
    await Promise.all(jobs);
  };

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      // Quantities live on dish_ingredients and aren't edited here — carry the
      // existing ones through so switching to this drawer never wipes them.
      const prevRows = new Map((editing?.ingredients ?? []).map((r) => [r.ingredientId, r]));
      const body = {
        name: d.name.trim(),
        component: d.component,
        unit: d.unit,
        brands: d.brands,
        preparations: d.preparations,
        isActive: d.isActive,
        ingredients: d.ingredientIds.map((id) => ({
          ingredientId: id,
          quantity: prevRows.get(id)?.quantity ?? null,
          unit: prevRows.get(id)?.unit ?? null,
        })),
        sideDishIds: d.sidesOn ? d.sideDishIds : [],
      };
      const saved = d.id
        ? await foodApi.updateDish(d.id, body)
        : { dish: await foodApi.createDish(body), rotationSidesRemoved: 0 };
      await syncPortions(saved.dish.id, d);
      return saved;
    },
    onSuccess: ({ dish, rotationSidesRemoved }) => {
      toast({ title: draft?.id ? `${dish.name} updated` : `${dish.name} added` });
      // Dropping a side rewrites already-planned plates, so say so — the board
      // is a different screen and the change would otherwise go unnoticed.
      if (rotationSidesRemoved > 0) {
        toast({
          title: `Removed from ${rotationSidesRemoved} planned ${rotationSidesRemoved === 1 ? "plate" : "plates"}`,
          description: "Menu Rotation no longer serves the accompaniments you un-paired.",
        });
      }
      qc.invalidateQueries({ queryKey: ["food", "dishes"] });
      qc.invalidateQueries({ queryKey: ["food", "rules"] });
      qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] });
      onSaved();
    },
    onError: (e: any) => toast({ title: e?.message || "Could not save the dish", variant: "destructive" }),
  });

  const createIngredient = useMutation({
    mutationFn: (name: string) => foodApi.createIngredient({ name, unit: "KG", isActive: true }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["food", "ingredients"] });
      patch({ ingredientIds: [...(draft?.ingredientIds ?? []), row.id] });
      setIngQuery("");
    },
    onError: (e: any) => toast({ title: e?.message || "Could not add the ingredient", variant: "destructive" }),
  });

  if (!draft) return null;

  const q = ingQuery.trim();
  const ql = q.toLowerCase();
  const ingMatches = ingredients.filter((g) => g.isActive && g.name.toLowerCase().includes(ql));
  const canCreateIng = !!q && !ingredients.some((g) => g.name.toLowerCase() === ql);

  // Which other dish this one can now never share a plate with — the single most
  // consequential side effect of adding an ingredient, so it is stated plainly.
  const conflict = (() => {
    for (const id of draft.ingredientIds) {
      const others = dishes.filter((x) => x.id !== draft.id && (x.ingredients ?? []).some((r) => r.ingredientId === id));
      if (others.length) return { name: ingById.get(id)?.name ?? "that ingredient", others };
    }
    return null;
  })();

  const sideQ = sideSearch.trim().toLowerCase();
  const rankSide = (c: string) => { const i = SIDE_COMPONENTS.indexOf(c); return i === -1 ? SIDE_COMPONENTS.length : i; };
  const sideCandidates = dishes
    .filter((x) => x.isActive && x.id !== draft.id)
    // A picked dish always survives the filter, so searching can't hide a choice
    // the user has already made.
    .filter((x) => !sideQ || draft.sideDishIds.includes(x.id)
      || x.name.toLowerCase().includes(sideQ) || componentLabel(x.component).toLowerCase().includes(sideQ))
    .sort((a, b) =>
      Number(!draft.sideDishIds.includes(a.id)) - Number(!draft.sideDishIds.includes(b.id))
      || rankSide(a.component) - rankSide(b.component)
      || a.name.localeCompare(b.name))
    .slice(0, SIDE_LIMIT);

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[520px]">
        <div className="shrink-0 border-b bg-card px-6 py-4">
          <SheetTitle className="font-display text-xl font-semibold text-primary">
            {draft.id ? "Edit dish" : "New dish"}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {draft.id ? "Changes apply everywhere this dish is used." : "Everything the kitchen and the menu engine need to know."}
          </SheetDescription>
        </div>

        <div className="flex-1 overflow-y-auto bg-background px-6 py-5">
          <Input
            value={draft.name} onChange={(e) => patch({ name: e.target.value })}
            placeholder="Dish name" aria-label="Dish name"
            className="mb-5 h-11 text-base"
          />

          <ChipGroup title="Course">
            {DISH_COMPONENTS.map((c) => (
              <Chip key={c} on={draft.component === c} onClick={() => patch({ component: c })}>
                {componentLabel(c)}
              </Chip>
            ))}
          </ChipGroup>

          <ChipGroup title="Served as">
            {DISH_UNITS.map((u) => (
              <Chip key={u} on={draft.unit === u} onClick={() => patch({ unit: u })}>{u}</Chip>
            ))}
          </ChipGroup>

          <ChipGroup title="Preparation">
            {PREPARATIONS.map((p) => (
              <Chip key={p} on={draft.preparations.includes(p)} onClick={() => patch({ preparations: toggle(draft.preparations, p) })}>
                {PREPARATION_LABEL[p] ?? p}
              </Chip>
            ))}
          </ChipGroup>

          <ChipGroup title="Brands that can serve it">
            {brands.length === 0 && <span className="text-xs text-muted-foreground">No brands defined yet.</span>}
            {brands.map((b) => (
              <Chip key={b.code} on={draft.brands.includes(b.code)} onClick={() => patch({ brands: toggle(draft.brands, b.code) })}>
                {b.name}
              </Chip>
            ))}
          </ChipGroup>

          {/* ── ingredients ────────────────────────────────────────────── */}
          <div className="mb-5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Ingredients</p>
            <button
              type="button" onClick={() => { setIngOpen((o) => !o); setIngQuery(""); }}
              aria-expanded={ingOpen}
              className={`flex h-10 w-full items-center justify-between rounded-lg border bg-card px-3 text-sm ${
                ingOpen ? "rounded-b-none border-accent" : ""
              }`}
            >
              <span className={draft.ingredientIds.length ? "" : "text-muted-foreground"}>
                {draft.ingredientIds.length
                  ? `${draft.ingredientIds.length} ingredient${draft.ingredientIds.length === 1 ? "" : "s"} selected`
                  : "Select ingredients"}
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${ingOpen ? "rotate-180" : ""}`} />
            </button>

            {ingOpen && (
              <div className="overflow-hidden rounded-b-lg border border-t-0 bg-card">
                <div className="border-b p-2">
                  <Input
                    value={ingQuery} onChange={(e) => setIngQuery(e.target.value)}
                    placeholder="Filter ingredients…" aria-label="Filter ingredients" className="h-8 text-xs"
                  />
                </div>
                <div className="max-h-52 overflow-y-auto p-1">
                  {ingMatches.map((g) => {
                    const on = draft.ingredientIds.includes(g.id);
                    const used = dishes.filter((x) => x.id !== draft.id && (x.ingredients ?? []).some((r) => r.ingredientId === g.id)).length;
                    return (
                      <button
                        key={g.id} type="button"
                        onClick={() => patch({ ingredientIds: toggle(draft.ingredientIds, g.id) })}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                          on ? "bg-accent/10" : "hover:bg-muted"
                        }`}
                      >
                        <span className={`inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded border-[1.5px] ${
                          on ? "border-accent bg-accent text-white" : "border-border"
                        }`}>
                          {on && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <span className="flex-1 text-xs">{g.name}</span>
                        {used > 0 && <span className="text-[10px] text-muted-foreground">in {used}</span>}
                      </button>
                    );
                  })}
                  {ingMatches.length === 0 && (
                    <p className="p-2.5 text-xs text-muted-foreground">No ingredient matches.</p>
                  )}
                </div>
                {canCreateIng && (
                  <button
                    type="button" disabled={createIngredient.isPending}
                    onClick={() => createIngredient.mutate(q)}
                    className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs text-accent-strong hover:bg-muted"
                  >
                    <Plus className="h-3 w-3" /> Create “{q}”
                  </button>
                )}
              </div>
            )}

            {draft.ingredientIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.ingredientIds.map((id) => (
                  <button
                    key={id} type="button"
                    onClick={() => patch({ ingredientIds: draft.ingredientIds.filter((x) => x !== id) })}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs hover:bg-muted/70"
                  >
                    {ingById.get(id)?.name ?? "Unknown"}
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}

            <p className={`mt-2 flex items-start gap-1.5 text-[11px] ${conflict ? "text-warning" : "text-muted-foreground"}`}>
              <Info className="mt-px h-3 w-3 shrink-0" />
              {conflict
                ? `Using ${conflict.name} means this dish can never share a plate with ${conflict.others.slice(0, 2).map((x) => x.name).join(" or ")}.`
                : "Ingredients are the raw materials only — they drive the shared-ingredient block."}
            </p>
          </div>

          {/* ── side dishes ────────────────────────────────────────────── */}
          <div className="mb-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Comes with a side dish
                </p>
                <p className="text-[11px] text-muted-foreground">
                  e.g. Chole with Bhature. Pick every option that’s possible — which one is served is chosen per menu.
                </p>
              </div>
              <Switch
                checked={draft.sidesOn}
                onCheckedChange={(on) => patch(on ? { sidesOn: true } : { sidesOn: false, sideDishIds: [] })}
                aria-label="Comes with a side dish"
              />
            </div>
            {draft.sidesOn && (
              <div className="mt-2.5">
                <div className="mb-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={sideSearch} onChange={(e) => setSideSearch(e.target.value)}
                      placeholder="Search dishes…" aria-label="Search side dishes" className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                    {draft.sideDishIds.length} selected
                  </span>
                </div>
                <div className="max-h-44 overflow-y-auto rounded-lg border bg-card p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {sideCandidates.map((x) => (
                      <Chip
                        key={x.id} on={draft.sideDishIds.includes(x.id)}
                        onClick={() => patch({ sideDishIds: toggle(draft.sideDishIds, x.id) })}
                      >
                        <PrepDot dish={x} />
                        {x.name}
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                          {componentLabel(x.component)}
                        </span>
                      </Chip>
                    ))}
                    {sideCandidates.length === 0 && (
                      <p className="text-xs text-muted-foreground">No dish matches that search.</p>
                    )}
                  </div>
                </div>
                {/* The two directions aren't symmetric, and the asymmetry is
                    invisible from here — say it rather than surprise them. */}
                {draft.id && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Adding an option affects plates you compose from now on. Removing one strips it
                    from plates already in Menu Rotation.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── portions ───────────────────────────────────────────────── */}
          <div className="mb-5">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Portion per resident{" "}
                <span className="normal-case tracking-normal">· in {draft.unit.toLowerCase()}</span>
              </p>
              {brands.length === 2 && (
                <button
                  type="button"
                  onClick={() => patch({
                    portions: { ...draft.portions, [brands[1]!.code]: { ...draft.portions[brands[0]!.code]! } },
                  })}
                  className="flex items-center gap-1 text-[11px] font-medium text-accent-strong hover:underline"
                >
                  <ArrowRight className="h-3 w-3" /> Copy {brands[0]!.name} → {brands[1]!.name}
                </button>
              )}
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Leave blank if the dish isn’t served at that meal for that brand.
            </p>
            <div className="overflow-hidden rounded-lg border bg-card">
              <div
                className="grid items-center gap-2.5 border-b bg-muted px-3 py-1.5"
                style={{ gridTemplateColumns: `1fr repeat(${Math.max(1, brands.length)}, 84px)` }}
              >
                <span />
                {brands.map((b) => (
                  <span key={b.code} className="text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.name}
                  </span>
                ))}
              </div>
              {MEAL_TYPES.map((m, i) => (
                <div
                  key={m}
                  className={`grid items-center gap-2.5 px-3 py-1.5 ${i < MEAL_TYPES.length - 1 ? "border-b" : ""}`}
                  style={{ gridTemplateColumns: `1fr repeat(${Math.max(1, brands.length)}, 84px)` }}
                >
                  <span className="text-sm">{MEAL_SHORT[m]}</span>
                  {brands.map((b) => (
                    <Input
                      key={b.code}
                      value={draft.portions[b.code]?.[m] ?? ""}
                      onChange={(e) => patch({
                        portions: {
                          ...draft.portions,
                          [b.code]: { ...(draft.portions[b.code] ?? {}), [m]: e.target.value },
                        },
                      })}
                      placeholder="—" inputMode="decimal"
                      aria-label={`${b.name} ${MEAL_LABEL[m]} portion`}
                      className="h-8 bg-transparent text-center font-mono text-sm"
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card px-3.5 py-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-[11px] text-muted-foreground">
                Inactive dishes stay on saved menus but can’t be added to new ones.
              </p>
            </div>
            <Switch checked={draft.isActive} onCheckedChange={(v) => patch({ isActive: v })} aria-label="Active" />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t bg-card px-6 py-3.5">
          <Button
            className="flex-1 bg-accent text-white hover:bg-accent/90"
            disabled={!draft.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save dish"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
