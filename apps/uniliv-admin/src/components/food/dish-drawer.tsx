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
import { ArrowRight, Check, ChevronsUpDown, Info, Plus, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
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
  /** Pin the people count at order time — see dishesTable.isQtyLocked. The
   *  count itself isn't drafted: locking pins the dish at 0. */
  qtyLockOn: boolean;
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
    qtyLockOn: d?.isQtyLocked ?? false,
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
        isQtyLocked: d.qtyLockOn,
        // Null when the switch is off, 0 when it's on — the server normalises to
        // exactly this, so the flag/count pair can never drift apart.
        lockedPersons: d.qtyLockOn ? 0 : null,
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
  // cmdk narrows the list itself, so only the "create" affordance reads the query.
  // A retired ingredient still shows while it is selected — otherwise the row that
  // is already on the dish would be the one row you cannot untick.
  const ingOptions = ingredients.filter((g) => g.isActive || draft.ingredientIds.includes(g.id));
  const canCreateIng = !!q && !ingredients.some((g) => g.name.toLowerCase() === ql);

  // A dish has to be served at a meal to exist usefully: computeOrderItems skips
  // dishes with no per-resident rule, so one with an empty grid can never be
  // ordered. Only cells that will actually become a rule count — syncPortions
  // drops blanks and non-positive numbers, so those must not satisfy the check.
  const portionCell = (brandCode: string, m: MealType) =>
    (draft.portions[brandCode]?.[m] ?? "").trim();
  const isValidPortion = (raw: string) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0;
  };
  const filledMeals = MEAL_TYPES.filter((m) =>
    brands.some((b) => isValidPortion(portionCell(b.code, m))),
  );
  /** Why saving is blocked, or null when the dish is good to go. */
  const blockReason = !draft.name.trim()
    ? "Give the dish a name to save it."
    : filledMeals.length === 0
      ? `Add a portion for at least one meal — ${MEAL_TYPES.map((m) => MEAL_SHORT[m]).join(", ")}.`
      : null;

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
            <Popover open={ingOpen} onOpenChange={(o) => { setIngOpen(o); if (!o) setIngQuery(""); }}>
              <PopoverTrigger asChild>
                <button
                  type="button" role="combobox" aria-expanded={ingOpen}
                  className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                >
                  {draft.ingredientIds.length === 0 && (
                    <span className="px-1 text-muted-foreground">Select ingredients</span>
                  )}
                  {draft.ingredientIds.map((id) => {
                    const name = ingById.get(id)?.name ?? "Unknown";
                    return (
                      <Badge key={id} variant="secondary" className="gap-1 rounded-md py-0.5 pl-2 pr-1 font-normal">
                        {name}
                        {/* Nested inside the trigger, so the click must not also open the popover. */}
                        <span
                          role="button" tabIndex={-1} aria-label={`Remove ${name}`}
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={(e) => { e.stopPropagation(); patch({ ingredientIds: draft.ingredientIds.filter((x) => x !== id) }); }}
                          className="rounded-sm text-muted-foreground/70 hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </Badge>
                    );
                  })}
                  <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 self-center text-muted-foreground opacity-50" />
                </button>
              </PopoverTrigger>
              {/* Tailwind v4 needs the explicit var() — the bare `w-[--custom-prop]`
                  form is v3 syntax and silently collapses the panel to its content. */}
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command
                  filter={(value, search, keywords) =>
                    [value, ...(keywords ?? [])].join(" ").toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput
                    value={ingQuery} onValueChange={setIngQuery}
                    placeholder="Search ingredients…"
                  />
                  {/* The drawer's scroll lock preventDefaults wheel/touchmove whose
                      target sits outside it, and this popover is portalled to the
                      body — so without this the list only scrolled by dragging its
                      scrollbar. Stopping the events short of that document listener
                      hands scrolling back to the list, on mouse and on touch. */}
                  <CommandList
                    className="max-h-56"
                    onWheel={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                  >
                    {!canCreateIng && <CommandEmpty>No ingredient matches.</CommandEmpty>}
                    <CommandGroup>
                      {ingOptions.map((g) => {
                        const on = draft.ingredientIds.includes(g.id);
                        const used = dishes.filter((x) => x.id !== draft.id && (x.ingredients ?? []).some((r) => r.ingredientId === g.id)).length;
                        return (
                          <CommandItem
                            key={g.id} value={g.name}
                            onSelect={() => patch({ ingredientIds: toggle(draft.ingredientIds, g.id) })}
                          >
                            <span className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
                              on ? "border-accent bg-accent text-white" : "border-border [&_svg]:invisible",
                            )}>
                              <Check className="h-3 w-3" />
                            </span>
                            <span className="truncate">{g.name}</span>
                            {used > 0 && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">in {used}</span>}
                          </CommandItem>
                        );
                      })}
                      {canCreateIng && (
                        <CommandItem
                          value={`__create__${q}`} keywords={[q]}
                          disabled={createIngredient.isPending}
                          onSelect={() => createIngredient.mutate(q)}
                        >
                          <Plus className="h-4 w-4 text-accent-strong" />
                          <span className="truncate text-accent-strong">Create “{q}”</span>
                        </CommandItem>
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

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
              Fill at least one meal — a dish with no portion can’t be ordered.
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
                      // Flagged, not blocked: syncPortions silently skips a cell
                      // that isn't a positive number, so say so at the cell.
                      className={`h-8 bg-transparent text-center font-mono text-sm ${
                        portionCell(b.code, m) && !isValidPortion(portionCell(b.code, m))
                          ? "border-destructive text-destructive"
                          : ""
                      }`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* A pinned dish ignores the unit lead's headcount entirely: locking it
              saves a count of 0, so it reaches no kitchen order at all. It is the
              one setting on this form that changes what someone ELSE can do, so
              it is tinted rather than left to blend into the rest of the fields. */}
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-3.5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Non-editable quantity</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Unit leads can’t change how many people this dish is ordered for — as a main or as a side.
                </p>
              </div>
              <Switch
                checked={draft.qtyLockOn}
                onCheckedChange={(v) => patch({ qtyLockOn: v })}
                aria-label="Non-editable quantity"
              />
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

        <div className="shrink-0 border-t bg-card px-6 py-3.5">
          {/* A disabled button with no reason reads as a bug — always say why. */}
          {blockReason && (
            <p className="mb-2 text-[11px] text-muted-foreground">{blockReason}</p>
          )}
          <div className="flex items-center gap-2">
            <Button
              className="flex-1 bg-accent text-white hover:bg-accent/90"
              disabled={!!blockReason || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save dish"}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
