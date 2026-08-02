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
 * alongside the brand toggle.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, CheckCircle2, CircleAlert, ClipboardPaste, Copy, Download,
  FileDown, FileText, ChevronDown, Plus, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiDownload } from "@/lib/api-fetch";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, DAY_LABEL,
  type MealType, type MealWindow, type MenuRotationRow,
} from "@/lib/food-api";
import {
  DAY_SHORT, MEAL_SHORT, ROTATION_WEEKS, WEEK_DAYS,
  allPlateDishIds, componentLabel, fillPlate, nearbyRepeats, plateKey, plateToItems, plateVerdict,
  rowsToPlates, ruleFor, slotsOf,
  type PlateEntry, type PlateMap,
} from "./menu-lib";
import { PlateComposer, PrepDot } from "./plate-composer";
import { useActiveBrands, useCompositionRules, useDishCatalogue, useKitchens } from "./use-food-masters";

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

export function RotationBoard() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: kitchens = [] } = useKitchens();
  const brands = useActiveBrands();
  const { data: dishes = [] } = useDishCatalogue();
  const { data: rules = [] } = useCompositionRules();

  const [kitchenId, setKitchenId] = React.useState("");
  const [brand, setBrand] = React.useState("");
  const [week, setWeek] = React.useState(1);
  const [clipboard, setClipboard] = React.useState<number | null>(null);
  const [sel, setSel] = React.useState<{ day: number; meal: MealType } | null>(null);

  // Default to the first kitchen / brand once the master lists land.
  React.useEffect(() => {
    if (!kitchenId && kitchens.length) setKitchenId(kitchens[0]!.id);
  }, [kitchens, kitchenId]);
  React.useEffect(() => {
    if (!brand && brands.length) setBrand(brands[0]!.code);
  }, [brands, brand]);

  const params = { kitchenId, brand, rotationWeek: week };
  const { data: rows = [], isLoading } = useQuery<MenuRotationRow[]>({
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

  const dishById = React.useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);
  const plates: PlateMap = React.useMemo(() => rowsToPlates(rows), [rows]);
  const brandName = brands.find((b) => b.code === brand)?.name ?? brand;
  const slotsFor = React.useCallback(
    (meal: MealType) => slotsOf(ruleFor(rules, brand, meal, kitchenId)),
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
  const summary = React.useMemo(() => {
    let complete = 0, warning = 0, empty = 0;
    for (const meal of MEAL_TYPES) {
      const slots = slotsFor(meal);
      for (const day of WEEK_DAYS) {
        const plate = plates.get(plateKey(day, meal)) ?? [];
        if (!plate.length) { empty++; continue; }
        if (plateVerdict(plate, slots, dishById).ok) complete++; else warning++;
      }
    }
    return { complete, warning, empty, total: MEAL_TYPES.length * WEEK_DAYS.length };
  }, [plates, dishById, slotsFor]);

  const anyRule = MEAL_TYPES.some((m) => slotsFor(m).length > 0);

  // ── whole-week actions ─────────────────────────────────────────────────────
  const autoFillWeek = () => {
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

  if (!kitchens.length) {
    return (
      <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
        No kitchens yet. Add one under <span className="font-medium text-foreground">More · Kitchens</span> before
        building a rotation.
      </p>
    );
  }

  const busy = bulkWrite.isPending;

  return (
    <div className="space-y-4">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-primary">Menu Rotation</h2>
          <p className="text-sm text-muted-foreground">
            Click any meal to build its plate. The rule for that meal drives what you can pick.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kitchenId} onValueChange={(v) => { setKitchenId(v); setSel(null); }}>
            <SelectTrigger className="w-52"><SelectValue placeholder="Kitchen" /></SelectTrigger>
            <SelectContent>
              {kitchens.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {brands.length > 1 && (
            <Segmented
              value={brand}
              options={brands.map((b) => ({ value: b.code, label: b.name }))}
              onChange={(v) => { setBrand(v); setSel(null); }}
            />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download className="mr-2 h-4 w-4" /> Export <ChevronDown className="ml-2 h-4 w-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel>Export week {week}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => runExport("csv")}>
                <FileDown className="mr-2 h-4 w-4 text-muted-foreground" /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runExport("pdf")}>
                <FileText className="mr-2 h-4 w-4 text-destructive" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" disabled={busy} onClick={duplicateWeek}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy W{week} → W{week === 4 ? 1 : week + 1}
          </Button>
        </div>
      </div>

      {/* ── week strip ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card px-4 py-3">
        <Segmented
          value={week}
          options={ROTATION_WEEKS.map((w) => ({ value: w, label: `W${w}` }))}
          onChange={(v) => { setWeek(v); setSel(null); setClipboard(null); }}
        />
        <div className="flex min-w-52 flex-1 items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${summary.complete === summary.total ? "bg-success" : "bg-accent"}`}
              style={{ width: `${Math.round((summary.complete / summary.total) * 100)}%` }}
            />
          </div>
          <span className="whitespace-nowrap text-sm font-medium">
            {summary.complete} of {summary.total} meals complete
          </span>
        </div>
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
        <Button
          variant="secondary" size="sm" disabled={busy || !anyRule}
          title={anyRule ? undefined : "Define a menu rule first"}
          onClick={autoFillWeek}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {summary.empty ? `Auto-fill ${summary.empty} gap${summary.empty === 1 ? "" : "s"}` : "Top up the week"}
        </Button>
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
      {isLoading ? (
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
                  type="button" disabled={busy} onClick={() => onDayAction(day)}
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
            const time = serviceTime(meal);
            return (
              <React.Fragment key={meal}>
                <div className="flex flex-col justify-center px-1 py-2">
                  <p className="text-sm font-semibold text-primary">{MEAL_SHORT[meal]}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {time ?? (slots.length ? `${slots.length} course${slots.length === 1 ? "" : "s"}` : "no rule")}
                  </p>
                </div>
                {WEEK_DAYS.map((day) => (
                  <BoardCell
                    key={`${meal}-${day}`}
                    cell={`${DAY_LABEL[day]} ${MEAL_SHORT[meal]}`}
                    plate={plates.get(plateKey(day, meal)) ?? []}
                    slots={slots}
                    dishById={dishById}
                    onOpen={() => setSel({ day, meal })}
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
          ruleMissing={slotsFor(sel.meal).length === 0}
          dishes={dishes}
          dishById={dishById}
          initialPlate={plates.get(plateKey(sel.day, sel.meal)) ?? []}
          nearby={nearbyRepeats(plates, sel.day, sel.meal)}
          serviceTime={serviceTime(sel.meal)}
          isSaving={saveSlot.isPending}
          onSave={(plate) => saveSlot.mutate({ day: sel.day, meal: sel.meal, plate })}
        />
      )}
    </div>
  );
}

/** One plate on the board: what's on it, and whether it satisfies its rule. */
function BoardCell({
  cell, plate, slots, dishById, onOpen,
}: {
  /** "Monday Lunch" — the cell's position, which its contents never state. */
  cell: string;
  plate: PlateEntry[];
  slots: ReturnType<typeof slotsOf>;
  dishById: Map<string, import("@/lib/food-api").Dish>;
  onOpen: () => void;
}) {
  if (!plate.length) {
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
  const clash = verdict.clashes[0];
  const noRule = slots.length === 0;

  // Sides render indented under the dish they accompany, so the cell reads the
  // way the plate is actually served.
  const lines = plate.flatMap((e) => [
    { id: e.dishId, isSide: false },
    ...e.sideDishIds.map((s) => ({ id: s, isSide: true })),
  ]);
  const shown = lines.slice(0, CELL_LINES);
  const extra = lines.length - shown.length;

  const tone = clash ? "text-destructive" : noRule ? "text-muted-foreground" : missing.length ? "text-warning" : "text-success";
  const status = clash ? `shares ${clash.ingredientName}`
    : noRule ? "no rule set"
    : missing.length ? `missing ${missing.join(", ")}`
    : "complete";

  return (
    <button
      type="button" onClick={onOpen}
      aria-label={`${cell} — ${lines.length} dish${lines.length === 1 ? "" : "es"}, ${status}. Open to edit.`}
      className="flex min-h-[118px] flex-col rounded-[10px] border bg-card p-2 text-left transition-colors hover:border-accent/50"
    >
      <div className="flex flex-1 flex-col gap-[3px]">
        {shown.map((l, i) => (
          <div key={`${l.id}-${i}`} className={`flex min-w-0 items-center gap-1.5 ${l.isSide ? "pl-3" : ""}`}>
            <PrepDot dish={dishById.get(l.id)} />
            <span className={`flex-1 truncate text-[11px] ${l.isSide ? "text-muted-foreground" : ""}`}>
              {dishById.get(l.id)?.name ?? "Unknown dish"}
            </span>
          </div>
        ))}
        {extra > 0 && <span className="text-[10px] text-muted-foreground">+{extra} more</span>}
      </div>
      <div className={`mt-1.5 flex items-center gap-1 border-t pt-1 text-[10px] font-medium ${tone}`}>
        {clash || missing.length ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> : <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />}
        <span className="truncate">
          {clash ? `Shares ${clash.ingredientName}`
            : noRule ? `${allPlateDishIds(plate).length} dishes`
            : missing.length ? `Missing ${missing[0]}`
            : "Complete"}
        </span>
      </div>
    </button>
  );
}
