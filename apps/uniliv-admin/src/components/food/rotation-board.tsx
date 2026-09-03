/**
 * Menu Rotation — the 4-week × 7-day × 4-meal board.
 *
 * The old screen was a filtered table of one dish per row, which made "is next
 * week actually finished?" a question you had to answer by reading. The board
 * answers it at a glance: every cell is a plate, colour-coded against its meal's
 * composition rule, and clicking one opens the composer for that plate.
 *
 * A note on scoping: the prototype had no kitchen dimension, but
 * `food_menu_rotation` is keyed by (kitchen, brand, week, day, meal) and the
 * write endpoints require a kitchen — so the board carries a kitchen picker
 * alongside the brand toggle. F&B manager logins run exactly one kitchen, so
 * for them the picker is hidden and the board pins itself to their kitchen
 * (via lookups.myKitchenIds).
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, CheckCircle2, CircleAlert, ClipboardPaste, Copy,
  FileDown, FileText, Plus, SlidersHorizontal, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { type BulkColumn } from "@/components/bulk-upload-dialog";
import { ImportExportMenu } from "@/components/import-export-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiDownload } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, DAY_LABEL,
  type FoodLookups, type MealType, type MealWindow, type MenuRotationRow,
  type MenuRuleSettings,
} from "@/lib/food-api";
import {
  DAY_SHORT, MEAL_SHORT, REPEAT_WITHIN_DAYS, ROTATION_WEEKS, WEEK_DAYS,
  allPlateDishIds, anyRepeatRuleOn, cellDayCapHits, cellRepeats, componentLabel, fillPlate,
  nearbyRepeats, otherMealDishIds,
  type DayCapHit, type IngredientCap, type RepeatRuleSet,
  plateKey, plateToItems, plateVerdict, rowsToCycleCells,
  rowsToPlates, courseSlotsOf, ruleFor, slotsOf,
  type PlateEntry, type PlateMap,
} from "./menu-lib";
import { GenerateFromRule } from "./generate-from-rule";
import { PlateComposer, PrepDot } from "./plate-composer";
import { DishRail, dishTintProps } from "./dish-color";
import { FoodQueryError } from "./query-error";
import { useActiveBrands, useCompositionRules, useDishCatalogue, useIngredients, useKitchens } from "./use-food-masters";

/**
 * Import template for the rotation — one row per DISH, because that is how the
 * rotation is stored and because a slot's sides belong to a specific dish.
 * Rows are grouped back into (kitchen, brand, week, day, meal) slots server-side
 * and each named slot is replaced wholesale, exactly as saving a plate does.
 */
const MENU_BULK_COLUMNS: BulkColumn[] = [
  { key: "kitchen", label: "kitchen", required: true, hint: "kitchen name or code" },
  { key: "brand", label: "brand", required: true, hint: "brand code, e.g. UNILIV" },
  { key: "week", label: "week", required: true, hint: `rotation week — ${ROTATION_WEEKS.join(", ")}` },
  { key: "day", label: "day", required: true, hint: "Mon–Sun, or 1–7 with 1 = Monday" },
  { key: "meal", label: "meal", required: true, hint: `one of ${MEAL_TYPES.join(", ")}` },
  { key: "dish", label: "dish", required: true, hint: "dish name — must already exist, and be the only dish with that name" },
  { key: "slotLabel", label: "slotLabel", hint: "optional label for the plate slot, e.g. Veg 2" },
  { key: "sides", label: "sides", hint: "accompaniments for this dish, comma-separated. Each must already be paired with it on the dish" },
];

/** Dish lines a cell shows before collapsing the rest into "+N more". */
const CELL_LINES = 4;
/** Slot writes run a few at a time — "auto-fill the week" is up to 28 of them. */
const WRITE_CONCURRENCY = 4;

type SlotWrite = { dayOfWeek: number; mealType: MealType; plate: PlateEntry[] };

/** Segmented control matching the tab strip's muted-pill styling. */
function Segmented<T extends string | number>({
  value, options, onChange,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
      {options.map((o) => (
        <button
          key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`inline-flex items-center rounded-md px-3 py-1 text-sm font-medium transition-all ${
            o.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** `canEdit` mirrors the server's FOOD_SETTINGS:edit gate (M16) — a view-only
 *  principal reads the week but cannot duplicate, auto-fill, paste or save a plate. */
export function RotationBoard({
  canEdit = true, onGoToRules, kitchenId, onKitchenChange, brand, onBrandChange,
}: {
  canEdit?: boolean;
  onGoToRules?: (focus: { brand: string; meal: MealType }) => void;
  /**
   * Kitchen + brand are owned by the Service Set page and shared with the Menu
   * Rules tab, so switching kitchen on one tab carries to the other. Both are
   * "" until the defaulting effect below picks one — whichever tab mounts first
   * does it, and the other finds it already set.
   */
  kitchenId: string;
  onKitchenChange: (v: string) => void;
  brand: string;
  onBrandChange: (v: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: kitchens = [], isError: kitchensError, refetch: refetchKitchens } = useKitchens();
  const brands = useActiveBrands();
  const { data: dishes = [] } = useDishCatalogue();
  // Rules drive the per-cell verdict AND the auto-fill. With none loaded every
  // non-empty plate scores "complete" and the header reads "All good" for a week
  // that was never actually checked.
  const { data: rules = [], isError: rulesError, refetch: refetchRules } = useCompositionRules();

  // F&B managers run exactly one kitchen: no picker, pinned to their own
  // kitchen (listKitchens is unscoped, so "first kitchen" would be wrong).
  const { role } = usePermissions();
  const kitchenBound = role === "FNB_MANAGER";
  // For a kitchen-bound role this decides WHICH kitchen the board is for, and
  // the defaulting effect below waits on it — so a failed read leaves the board
  // sitting on an empty grid forever with nothing said. Report it instead.
  const { data: lookups, isError: lookupsError, refetch: refetchLookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
    enabled: kitchenBound,
  });

  const setKitchenId = onKitchenChange;
  const setBrand = onBrandChange;
  const [week, setWeek] = React.useState(1);
  const [clipboard, setClipboard] = React.useState<number | null>(null);
  const [sel, setSel] = React.useState<{ day: number; meal: MealType } | null>(null);

  // Default the kitchen once the master lists land: the caller's own kitchen
  // for kitchen-bound roles, otherwise the first kitchen. Waits for the role
  // (and, when bound, the lookups) so a manager never lands on kitchens[0].
  React.useEffect(() => {
    if (kitchenId || !kitchens.length || !role) return;
    if (kitchenBound && !lookups) return;
    const mine = kitchenBound ? lookups?.myKitchenIds?.[0] : null;
    setKitchenId(mine ?? kitchens[0]!.id);
  }, [kitchens, kitchenId, role, kitchenBound, lookups]);
  React.useEffect(() => {
    if (!brand && brands.length) setBrand(brands[0]!.code);
  }, [brands, brand]);

  // Resolved for THIS kitchen (a kitchen override wins over the org default),
  // matching the scope the board actually edits — the rotation is per
  // (kitchen, brand), so there is no single property to resolve against here.
  // The server enforces the same values; this only keeps the composer's
  // affordances honest about what a save will be allowed to do.
  const ruleScope = React.useMemo(() => (kitchenId ? { kitchenId } : {}), [kitchenId]);
  const { data: ruleSettings } = useQuery<MenuRuleSettings>({
    queryKey: foodKeys.menuRuleSettings(ruleScope),
    queryFn: () => foodApi.menuRuleSettings(ruleScope),
  });

  const params = { kitchenId, brand, rotationWeek: week };
  // H1 (same invariant as the Menu Rules generator) — every whole-week action
  // here is a delete-then-insert driven by `plates`, which is derived from this
  // query. A failed read yields an empty board, and "Copy W1 → W2" would then
  // write 28 EMPTY plates over a filled week, "paste a day" would blank the
  // target, and auto-fill would rebuild plates that already existed. Nothing
  // destructive runs unless `weekLoaded` says the week genuinely loaded.
  const {
    data: rows = [], isLoading, isError: weekError, isSuccess: weekLoaded, refetch: refetchWeek,
  } = useQuery<MenuRotationRow[]>({
    queryKey: foodKeys.rotation(params),
    queryFn: () => foodApi.listRotation(params),
    enabled: !!kitchenId && !!brand,
  });
  const { data: windows = [] } = useQuery<MealWindow[]>({
    queryKey: foodKeys.mealWindows({ brand }),
    queryFn: () => foodApi.listMealWindows({ brand }),
    enabled: !!brand,
  });
  /** Brand-level service time per meal (property overrides don't apply here). */
  const serviceTime = (meal: MealType) =>
    windows.find((w) => w.mealType === meal && !w.propertyId)?.serviceTime ?? null;

  /** The Menu Rules switches. Everything the board shows honours them. */
  const flagRepeats = ruleSettings?.flagRepeatsWithin3Days !== false;
  /** The window the rule is set to — see repeatWithinDays under Menu Rules. */
  const repeatDays = ruleSettings?.repeatWithinDays ?? REPEAT_WITHIN_DAYS;
  /* The three variety rules, resolved into one set. Each is independent: the
     window can be off while rule 3 or 4 is on, which is why withinDays is
     nulled rather than zeroed — 0 would still be a window, just an empty one,
     and the distinction matters to isRepeatSource. Both new rules default OFF
     (`=== true`), so an install that never touched them behaves as before. */
  const repeatRules: RepeatRuleSet = React.useMemo(() => ({
    withinDays: flagRepeats ? repeatDays : null,
    sameWeek: ruleSettings?.flagSameWeekRepeats === true,
    sameWeekday: ruleSettings?.flagSameWeekdayRepeats === true,
  }), [flagRepeats, repeatDays, ruleSettings?.flagSameWeekRepeats, ruleSettings?.flagSameWeekdayRepeats]);
  const clashBlocks = ruleSettings?.ingredientClashBlocks !== false;

  // Repeats span the whole rotation cycle — week 4 Sunday sits one day before
  // week 1 Monday — so detection needs EVERY week, not just the one on screen.
  // Omitting rotationWeek returns all of them under its own cache key, so the
  // four weeks share one fetch instead of refetching as you page between them.
  // Not gated on flagRepeats any more: the import/export menu exports the whole
  // cycle, so these rows are needed whether or not repeat-flagging is on.
  const cycleParams = { kitchenId, brand };
  // If this fails, cellRepeats finds nothing and every cell reads clean — a
  // silent all-clear on a check that never ran. Say so rather than imply it.
  const { data: cycleRows = [], isError: cycleError } = useQuery<MenuRotationRow[]>({
    queryKey: foodKeys.rotation(cycleParams),
    queryFn: () => foodApi.listRotation(cycleParams),
    enabled: !!kitchenId && !!brand,
  });
  const cycleCells = React.useMemo(() => rowsToCycleCells(cycleRows), [cycleRows]);

  /**
   * The whole cycle in the import template's own columns, so a download can be
   * edited and uploaded back. Side rows are folded onto the dish they accompany
   * — they live in the table as ordinary rows tagged with parentRotationId, but
   * the sheet expresses them as one cell of their parent's row.
   */
  const menuExportRows = React.useMemo(() => {
    const kitchenName = kitchens.find((k) => k.id === kitchenId)?.name ?? "";
    const sidesByParent = new Map<string, string[]>();
    for (const r of cycleRows) {
      if (!r.parentRotationId) continue;
      sidesByParent.set(r.parentRotationId, [...(sidesByParent.get(r.parentRotationId) ?? []), r.dishName ?? ""]);
    }
    const mealOrder = new Map(MEAL_TYPES.map((m, i) => [m, i]));
    return cycleRows
      .filter((r) => !r.parentRotationId)
      .sort((a, b) =>
        a.rotationWeek - b.rotationWeek
        || a.dayOfWeek - b.dayOfWeek
        || (mealOrder.get(a.mealType) ?? 0) - (mealOrder.get(b.mealType) ?? 0)
        || a.sortOrder - b.sortOrder)
      .map((r) => ({
        kitchen: kitchenName,
        brand: r.brand,
        week: String(r.rotationWeek),
        day: DAY_SHORT[r.dayOfWeek] ?? String(r.dayOfWeek),
        meal: r.mealType,
        dish: r.dishName ?? "",
        slotLabel: r.slotLabel ?? "",
        sides: (sidesByParent.get(r.id) ?? []).filter(Boolean).join(", "),
      }));
  }, [cycleRows, kitchens, kitchenId]);
  const repeatsFor = React.useCallback(
    (day: number, meal: MealType) =>
      (anyRepeatRuleOn(repeatRules) ? cellRepeats(cycleCells, week, day, meal, repeatRules) : []),
    [cycleCells, week, repeatRules],
  );

  const dishById = React.useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);

  /* Rule 2 on the board. FLAG ONLY — the save is never refused, so this marker
     is the entire rule as far as anyone using the app is concerned. It counts
     across every meal of the day, which is the thing no per-plate check sees;
     the caps come from the ingredients themselves. */
  const dayCapOn = ruleSettings?.flagIngredientDayCap === true;
  const { data: ingredients = [] } = useIngredients();
  const caps: IngredientCap[] = React.useMemo(
    () => (dayCapOn ? ingredients : [])
      .filter((i) => i.isActive && i.maxPerDay != null)
      .map((i) => ({ ingredientId: i.id, name: i.name, maxPerDay: i.maxPerDay! })),
    [dayCapOn, ingredients],
  );
  const dayCapFor = React.useCallback(
    (day: number, meal: MealType) =>
      (caps.length ? cellDayCapHits(cycleCells, week, day, meal, dishById, caps) : []),
    [caps, cycleCells, week, dishById],
  );

  const plates: PlateMap = React.useMemo(() => rowsToPlates(rows), [rows]);
  const brandName = brands.find((b) => b.code === brand)?.name ?? brand;
  const slotsFor = React.useCallback(
    (meal: MealType) => slotsOf(ruleFor(rules, brand, meal, kitchenId)),
    [rules, brand, kitchenId],
  );
  // The star slot is a constraint, not a course (see courseSlotsOf). Counting
  // courses and answering "has this meal got a rule?" both have to ignore it,
  // or switching the star rule on would make every meal claim a 1-course plate
  // rule that nobody wrote.
  const coursesFor = React.useCallback(
    (meal: MealType) => courseSlotsOf(ruleFor(rules, brand, meal, kitchenId)),
    [rules, brand, kitchenId],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] });

  /**
   * Writes a batch of plates, a few at a time.
   *
   * The slot endpoint replaces one (kitchen, brand, week, day, meal) wholesale,
   * so "duplicate the week" is 28 independent calls rather than one bulk write.
   */
  const writeSlots = async (targetWeek: number, writes: SlotWrite[]) => {
    const failures: string[] = [];
    for (let i = 0; i < writes.length; i += WRITE_CONCURRENCY) {
      await Promise.all(writes.slice(i, i + WRITE_CONCURRENCY).map(async (w) => {
        try {
          await foodApi.replaceRotationSlot({
            kitchenId, brand, rotationWeek: targetWeek,
            dayOfWeek: w.dayOfWeek, mealType: w.mealType, items: plateToItems(w.plate),
          });
        } catch (e: any) {
          failures.push(`${DAY_SHORT[w.dayOfWeek]} ${MEAL_SHORT[w.mealType]}: ${e?.message ?? "failed"}`);
        }
      }));
    }
    return failures;
  };

  const saveSlot = useMutation({
    mutationFn: async (v: { day: number; meal: MealType; plate: PlateEntry[] }) =>
      foodApi.replaceRotationSlot({
        kitchenId, brand, rotationWeek: week,
        dayOfWeek: v.day, mealType: v.meal, items: plateToItems(v.plate),
      }),
    onSuccess: (_r, v) => {
      toast({ title: `${DAY_LABEL[v.day]} ${MEAL_LABEL[v.meal]} saved` });
      invalidate();
      setSel(null);
    },
    onError: (e: any) => toast({ title: e?.message || "Could not save the plate", variant: "destructive" }),
  });

  const bulkWrite = useMutation({
    mutationFn: (v: { targetWeek: number; writes: SlotWrite[]; label: string }) =>
      writeSlots(v.targetWeek, v.writes).then((failures) => ({ ...v, failures })),
    onSuccess: ({ writes, failures, label, targetWeek }) => {
      invalidate();
      if (failures.length) {
        toast({
          title: `${writes.length - failures.length} of ${writes.length} saved`,
          description: failures.slice(0, 3).join(" · "),
          variant: "destructive",
        });
      } else {
        toast({ title: label });
      }
      if (targetWeek !== week) setWeek(targetWeek);
    },
    onError: (e: any) => toast({ title: e?.message || "Bulk update failed", variant: "destructive" }),
  });

  // ── week roll-up ───────────────────────────────────────────────────────────
  // The header counts exactly what the cells show, applying the same two gates.
  // `plateVerdict().ok` can't be used directly: its `ok` is false whenever a
  // clash exists, regardless of whether that rule is switched on — which is how
  // "21 need attention" survived over twenty-one cells reading "complete".
  const summary = React.useMemo(() => {
    let complete = 0, warning = 0, empty = 0;
    for (const meal of MEAL_TYPES) {
      const slots = slotsFor(meal);
      for (const day of WEEK_DAYS) {
        const plate = plates.get(plateKey(day, meal)) ?? [];
        if (!plate.length) { empty++; continue; }
        const v = plateVerdict(plate, slots, dishById);
        const clash = clashBlocks && v.clashes.length > 0;
        const missing = v.rows.some((r) => r.dishIds.length < r.slot.minCount);
        if (clash || missing || repeatsFor(day, meal).length > 0 || dayCapFor(day, meal).length > 0) warning++;
        else complete++;
      }
    }
    return { complete, warning, empty, total: MEAL_TYPES.length * WEEK_DAYS.length };
  }, [plates, dishById, slotsFor, clashBlocks, repeatsFor, dayCapFor]);

  const anyRule = MEAL_TYPES.some((m) => coursesFor(m).length > 0);

  // ── whole-week actions ─────────────────────────────────────────────────────
  /** Shared refusal for the three actions that write from `plates`. */
  const refuseUnread = () => {
    if (weekLoaded) return false;
    toast({
      title: "The current week could not be read",
      description: "Reload before copying or filling — writing now could overwrite plates that are already planned.",
      variant: "destructive",
    });
    return true;
  };

  const autoFillWeek = () => {
    if (refuseUnread()) return;
    const writes: SlotWrite[] = [];
    let seed = 1;
    for (const meal of MEAL_TYPES) {
      const slots = slotsFor(meal);
      if (!slots.length) continue;
      for (const day of WEEK_DAYS) {
        const current = plates.get(plateKey(day, meal)) ?? [];
        const filled = fillPlate(current, slots, brand, dishById, dishes, (seed += 5));
        if (filled.length !== current.length) writes.push({ dayOfWeek: day, mealType: meal, plate: filled });
      }
    }
    if (!writes.length) { toast({ title: "Nothing to fill — every meal already meets its rule" }); return; }
    bulkWrite.mutate({ targetWeek: week, writes, label: `Filled ${writes.length} meal${writes.length === 1 ? "" : "s"}` });
  };

  const duplicateWeek = () => {
    if (refuseUnread()) return;
    const to = week === 4 ? 1 : week + 1;
    const writes: SlotWrite[] = [];
    for (const meal of MEAL_TYPES) {
      for (const day of WEEK_DAYS) {
        writes.push({ dayOfWeek: day, mealType: meal, plate: plates.get(plateKey(day, meal)) ?? [] });
      }
    }
    bulkWrite.mutate({ targetWeek: to, writes, label: `Week ${week} copied over Week ${to}` });
  };

  const onDayAction = (day: number) => {
    if (clipboard == null) { setClipboard(day); return; }
    if (clipboard === day) { setClipboard(null); return; }
    if (refuseUnread()) return;
    const writes: SlotWrite[] = MEAL_TYPES.map((meal) => ({
      dayOfWeek: day, mealType: meal, plate: plates.get(plateKey(clipboard, meal)) ?? [],
    }));
    bulkWrite.mutate({ targetWeek: week, writes, label: `${DAY_LABEL[clipboard]} pasted onto ${DAY_LABEL[day]}` });
    setClipboard(null);
  };

  // ── export (unchanged behaviour, now scoped by the board's own filters) ────
  const runExport = async (fmt: "csv" | "pdf") => {
    const p: Record<string, string> = { kitchenId, brand, rotationWeek: String(week) };
    const kitchenLabel = (kitchens.find((k) => k.id === kitchenId)?.name ?? "")
      .replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-");
    const name = ["menu-rotation", brand, kitchenLabel, `W${week}`, new Date().toISOString().slice(0, 10)]
      .filter(Boolean).join("-") + `.${fmt}`;
    try {
      await apiDownload(fmt === "pdf" ? foodApi.rotationExportPdfUrl(p) : foodApi.rotationExportCsvUrl(p), name);
      toast({ title: "Export ready", description: name });
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    }
  };

  // "No kitchens yet" is advice to go and create one — never give it because a
  // fetch failed.
  if (kitchensError) {
    return <FoodQueryError label="the kitchens" onRetry={() => refetchKitchens()} />;
  }
  if (kitchenBound && lookupsError) {
    return <FoodQueryError label="your kitchen" onRetry={() => refetchLookups()} />;
  }
  if (rulesError) {
    return (
      <FoodQueryError
        label="the menu rules"
        hint="Without them the board cannot tell a complete plate from an incomplete one, so the week is not shown."
        onRetry={() => refetchRules()}
      />
    );
  }
  if (!kitchens.length) {
    return (
      <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
        No kitchens yet. Add one under <span className="font-medium text-foreground">More · Kitchens</span> before
        building a rotation.
      </p>
    );
  }

  // Every whole-week write reads `plates`, so an unread week disables them all.
  const busy = bulkWrite.isPending || !weekLoaded;

  return (
    <div className="space-y-4">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-primary">Menu</h2>
          <p className="text-sm text-muted-foreground">
            Click any meal to build its plate. The rule for that meal drives what you can pick.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!kitchenBound && (
            <Select value={kitchenId} onValueChange={(v) => { setKitchenId(v); setSel(null); }}>
              <SelectTrigger className="w-52"><SelectValue placeholder="Kitchen" /></SelectTrigger>
              <SelectContent>
                {kitchens.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {brands.length > 1 && (
            <Segmented
              value={brand}
              options={brands.map((b) => ({ value: b.code, label: b.name }))}
              onChange={(v) => { setBrand(v); setSel(null); }}
            />
          )}
          {/* One control for both directions; `canImport` drops the upload half
              for a read-only principal and leaves the downloads. The printable
              week report keeps its place here as an extra group — it is a
              different artefact from the round-trippable export above it, and is
              deliberately labelled so the two CSVs are not mistaken for each
              other. It survives in both modes, being a read. */}
          <ImportExportMenu
            resource="menu"
            columns={MENU_BULK_COLUMNS}
            exportRows={menuExportRows}
            canImport={canEdit}
            onImported={() => qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] })}
          >
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Printable report
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => runExport("csv")}>
              <FileDown className="mr-2 h-4 w-4 text-muted-foreground" /> Week {week} · CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runExport("pdf")}>
              <FileText className="mr-2 h-4 w-4 text-destructive" /> Week {week} · PDF
            </DropdownMenuItem>
          </ImportExportMenu>
          {canEdit && (
            <Button variant="outline" disabled={busy} onClick={duplicateWeek}>
              <Copy className="mr-2 h-3.5 w-3.5" /> Copy W{week} → W{week === 4 ? 1 : week + 1}
            </Button>
          )}
        </div>
      </div>

      {/* ── week strip ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card px-4 py-3">
        <Segmented
          value={week}
          options={ROTATION_WEEKS.map((w) => ({ value: w, label: `W${w}` }))}
          onChange={(v) => { setWeek(v); setSel(null); setClipboard(null); }}
        />
        {/* The roll-up counts an unread week as 28 empty meals — a number, not a
            reading. Withhold it until the week is actually in hand. */}
        <div className="flex min-w-52 flex-1 items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${summary.complete === summary.total ? "bg-success" : "bg-accent"}`}
              style={{ width: weekLoaded ? `${Math.round((summary.complete / summary.total) * 100)}%` : "0%" }}
            />
          </div>
          <span className="whitespace-nowrap text-sm font-medium">
            {weekLoaded ? `${summary.complete} of ${summary.total} meals complete` : "Reading the week…"}
          </span>
        </div>
        {weekLoaded && (
        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${
          summary.warning ? "bg-warning-soft text-warning"
            : summary.empty ? "bg-muted text-muted-foreground"
            : "bg-success-soft text-success"
        }`}>
          {summary.warning ? <AlertTriangle className="h-3 w-3" />
            : summary.empty ? <CircleAlert className="h-3 w-3" />
            : <CheckCircle2 className="h-3 w-3" />}
          {summary.warning ? `${summary.warning} need attention`
            : summary.empty ? `${summary.empty} empty`
            : "All good"}
        </span>
        )}
        {/* Never let a check that failed to run pass for a check that passed. */}
        {cycleError && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-medium text-warning">
            <AlertTriangle className="h-3 w-3" /> Repeats not checked
          </span>
        )}
        {canEdit && (
          <Button
            variant="secondary" size="sm" disabled={busy || !anyRule}
            title={anyRule ? undefined : "Define a menu rule first"}
            onClick={autoFillWeek}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {weekLoaded && summary.empty ? `Auto-fill ${summary.empty} gap${summary.empty === 1 ? "" : "s"}` : "Top up the week"}
          </Button>
        )}
      </div>

      {clipboard != null && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent/10 px-3.5 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-accent-strong">
            <Copy className="h-3 w-3" /> {DAY_LABEL[clipboard]} copied
          </span>
          <span className="text-xs text-muted-foreground">Click the paste icon on any other day to drop it in.</span>
          <button
            type="button" onClick={() => setClipboard(null)}
            className="ml-auto text-xs font-medium text-accent-strong hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── board ────────────────────────────────────────────────────────── */}
      {weekError ? (
        <FoodQueryError
          label={`week ${week}`}
          hint="An empty board here would be indistinguishable from a week nobody has planned yet."
          onRetry={() => refetchWeek()}
        />
      ) : !weekLoaded ? (
        // Not just `isLoading`: a query that is pending, paused (offline) or
        // disabled has also not been read, and an all-empty grid would pass for
        // a week nobody has planned.
        <p className="py-10 text-center text-sm text-muted-foreground">Loading the week…</p>
      ) : (
        <div className="grid gap-2 overflow-x-auto" style={{ gridTemplateColumns: "104px repeat(7, minmax(120px, 1fr))" }}>
          <div />
          {WEEK_DAYS.map((day) => {
            const copying = clipboard != null;
            const isSource = clipboard === day;
            return (
              <div key={day} className="flex items-center justify-center gap-1.5 pb-0.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {DAY_SHORT[day]}
                </p>
                <button
                  type="button" disabled={busy || !canEdit} onClick={() => onDayAction(day)}
                  title={!copying ? `Copy ${DAY_LABEL[day]}`
                    : isSource ? "Cancel copy"
                    : `Paste ${DAY_LABEL[clipboard!]} here`}
                  className={`flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted ${
                    copying && !isSource ? "bg-accent/10 text-accent-strong" : ""
                  }`}
                >
                  {!copying ? <Copy className="h-3 w-3" />
                    : isSource ? <Check className="h-3 w-3" />
                    : <ClipboardPaste className="h-3 w-3" />}
                </button>
              </div>
            );
          })}

          {MEAL_TYPES.map((meal) => {
            const slots = slotsFor(meal);
            const courses = coursesFor(meal);
            const time = serviceTime(meal);
            return (
              <React.Fragment key={meal}>
                <div className="flex flex-col justify-center px-1 py-2">
                  <p className="text-sm font-semibold text-primary">{MEAL_SHORT[meal]}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {time ?? (courses.length ? `${courses.length} course${courses.length === 1 ? "" : "s"}` : "no rule")}
                  </p>
                </div>
                {WEEK_DAYS.map((day) => (
                  <BoardCell
                    key={`${meal}-${day}`}
                    cell={`${DAY_LABEL[day]} ${MEAL_SHORT[meal]}`}
                    plate={plates.get(plateKey(day, meal)) ?? []}
                    slots={slots}
                    hasRule={courses.length > 0}
                    dishById={dishById}
                    repeats={repeatsFor(day, meal)}
                    dayCap={dayCapFor(day, meal)}
                    clashBlocks={clashBlocks}
                    onOpen={() => setSel({ day, meal })}
                    onGoToRules={onGoToRules ? () => onGoToRules({ brand, meal }) : undefined}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {sel && (
        <PlateComposer
          open
          onOpenChange={(o) => !o && setSel(null)}
          day={sel.day}
          meal={sel.meal}
          week={week}
          brand={brand}
          brandName={brandName}
          slots={slotsFor(sel.meal)}
          ruleMissing={coursesFor(sel.meal).length === 0}
          dayCaps={caps}
          otherMealDishIds={otherMealDishIds(cycleCells, week, sel.day, sel.meal)}
          dishes={dishes}
          dishById={dishById}
          initialPlate={plates.get(plateKey(sel.day, sel.meal)) ?? []}
          // Both switches come from Menu Rules. An empty map is how "don't flag
          // repeats" is expressed — the composer needs no separate off-switch.
          nearby={anyRepeatRuleOn(repeatRules)
            ? nearbyRepeats(cycleCells, week, sel.day, sel.meal, repeatRules)
            : new Map<string, string>()}
          clashBlocks={clashBlocks}
          serviceTime={serviceTime(sel.meal)}
          canEdit={canEdit}
          isSaving={saveSlot.isPending}
          // A plate cell is only unique within a kitchen, and the composer
          // never sees the kitchen id — build its autosave identity here.
          draftKey={`plate-form:${kitchenId}:${brand}:w${week}:d${sel.day}:${sel.meal}`}
          onSave={(plate) => saveSlot.mutate({ day: sel.day, meal: sel.meal, plate })}
          {...(onGoToRules
            ? { onGoToRules: () => { onGoToRules({ brand, meal: sel.meal }); setSel(null); } }
            : {})}
        />
      )}

      {/* Bulk fill sits BELOW the board: it is the thing you reach for after
          seeing the empty cells, and it writes into the kitchen selected above
          — no second kitchen picker needed. */}
      <GenerateFromRule kitchenId={kitchenId} brand={brand} brandName={brandName} />
    </div>
  );
}

/** One plate on the board: what's on it, and whether it satisfies its rule. */
function BoardCell({
  cell, plate, slots, hasRule, dishById, repeats, dayCap, clashBlocks, onOpen, onGoToRules,
}: {
  /** "Monday Lunch" — the cell's position, which its contents never state. */
  cell: string;
  plate: PlateEntry[];
  slots: ReturnType<typeof slotsOf>;
  /** Whether the meal has a COURSE rule — the star slot alone is not one. */
  hasRule: boolean;
  dishById: Map<string, import("@/lib/food-api").Dish>;
  /** Dishes here also served for this meal within 3 days, and where. */
  repeats: Array<{ dishId: string; where: string }>;
  /** Shared-ingredient rule. Off means the cell says nothing about clashes. */
  clashBlocks: boolean;
  /** Ingredients this cell pushes over their daily limit (rule 2). */
  dayCap: DayCapHit[];
  onOpen: () => void;
  /** Absent when the viewer cannot open Menu Rules — see FOOD_CATALOGUE. */
  onGoToRules?: () => void;
}) {
  const noRule = !hasRule;

  if (!plate.length) {
    // Rules before rotation: an empty cell with no rule has nothing to compose
    // against, so it points at the fix instead of opening an unusable drawer.
    if (noRule) {
      // Without the catalogue grant there is nowhere to send them, so the cell
      // states the blocker instead of being a button that does nothing.
      if (!onGoToRules) {
        return (
          <div
            aria-label={`${cell} — no menu rule set`}
            className="flex min-h-[118px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed p-2 text-muted-foreground"
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span className="px-1 text-center text-[11px] leading-tight">No menu rule for this meal</span>
          </div>
        );
      }
      return (
        <button
          type="button" onClick={onGoToRules}
          aria-label={`${cell} — no menu rule set. Open Menu Rules to define one.`}
          className="flex min-h-[118px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed p-2 text-muted-foreground transition-colors hover:border-accent/50 hover:bg-muted/40"
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span className="px-1 text-center text-[11px] leading-tight">Set a rule first</span>
        </button>
      );
    }
    return (
      <button
        type="button" onClick={onOpen} aria-label={`${cell} — empty, build meal`}
        className="flex min-h-[118px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed p-2 text-muted-foreground transition-colors hover:border-accent/50 hover:bg-muted/40"
      >
        <Plus className="h-4 w-4" />
        <span className="text-[11px]">Build meal</span>
      </button>
    );
  }

  const verdict = plateVerdict(plate, slots, dishById);
  const missing = verdict.rows
    .filter((r) => r.dishIds.length < r.slot.minCount)
    .map((r) => r.slot.slotLabel || componentLabel(r.slot.component));
  // Switched off means silent, not "shown but harmless" — a flag that survives
  // its own off-switch reads as a broken toggle, which is exactly how it looked.
  const clash = clashBlocks ? verdict.clashes[0] : undefined;

  // Sides render indented under the dish they accompany, so the cell reads the
  // way the plate is actually served.
  const lines = plate.flatMap((e) => [
    { id: e.dishId, isSide: false },
    ...e.sideDishIds.map((s) => ({ id: s, isSide: true })),
  ]);
  const shown = lines.slice(0, CELL_LINES);
  const extra = lines.length - shown.length;

  // A repeat is a variety problem, not a safety one, so it sits below the hard
  // faults — but ABOVE "complete", because a cell that silently reads complete
  // while serving the same dish three days running is how repeats went unseen.
  const repeatLabel = repeats.length === 1
    ? `${dishById.get(repeats[0]!.dishId)?.name ?? "A dish"} also ${repeats[0]!.where}`
    : `${repeats.length} dishes repeat within 3 days`;

  // A variety warning, not a hard fault: it never blocks a save. Ranked with
  // the repeats below rather than with the clash, and shown only when nothing
  // actually broken is competing for the one line the cell has.
  const cap = dayCap[0];
  const tone = clash ? "text-destructive"
    : noRule ? "text-muted-foreground"
    : missing.length ? "text-warning"
    : repeats.length || cap ? "text-destructive"
    : "text-success";
  const status = clash ? `shares ${clash.ingredientName}`
    : noRule ? "no rule set"
    : missing.length ? `missing ${missing.join(", ")}`
    : repeats.length ? repeatLabel
    : cap ? `${cap.ingredientName} ×${cap.count} today (max ${cap.maxPerDay})`
    : "complete";

  return (
    <button
      type="button" onClick={onOpen}
      aria-label={`${cell} — ${lines.length} dish${lines.length === 1 ? "" : "es"}, ${status}. ${noRule ? "Open to clear." : "Open to edit."}`}
      className="flex min-h-[118px] flex-col rounded-[10px] border bg-card p-2 text-left transition-colors hover:border-accent/50"
    >
      <div className="flex flex-1 flex-col gap-[3px]">
        {/* A side's indent is a MARGIN, not padding: with the row tinted,
            padding would start the wash at the cell edge and leave the indent
            sitting inside the dish's own colour. */}
        {shown.map((l, i) => (
          <div
            key={`${l.id}-${i}`}
            {...dishTintProps(
              dishById.get(l.id),
              `flex min-w-0 items-center gap-1.5 rounded px-1 py-px ${l.isSide ? "ml-3" : ""}`,
            )}
          >
            <DishRail dish={dishById.get(l.id)} className="self-stretch" />
            <PrepDot dish={dishById.get(l.id)} />
            <span className={`flex-1 truncate text-[11px] ${l.isSide ? "text-muted-foreground" : ""}`}>
              {dishById.get(l.id)?.name ?? "Unknown dish"}
            </span>
          </div>
        ))}
        {extra > 0 && <span className="text-[10px] text-muted-foreground">+{extra} more</span>}
      </div>
      <div className={`mt-1.5 flex items-center gap-1 border-t pt-1 text-[10px] font-medium ${tone}`}>
        {clash || missing.length ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
          : repeats.length || cap ? <CircleAlert className="h-2.5 w-2.5 shrink-0" />
          : <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />}
        <span className="truncate" title={status}>
          {clash ? `Shares ${clash.ingredientName}`
            : noRule ? `${allPlateDishIds(plate).length} dishes`
            : missing.length ? `Missing ${missing[0]}`
            : repeats.length ? repeatLabel
            : cap ? `${cap.ingredientName} ×${cap.count} today (max ${cap.maxPerDay})`
            : "Complete"}
        </span>
      </div>
    </button>
  );
}
