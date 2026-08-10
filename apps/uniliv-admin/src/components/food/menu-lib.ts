/**
 * Menu-building logic shared by the Menu Rotation board and the Menu Rules editor.
 *
 * Everything here is pure and runs on the client. That is deliberate: the board
 * renders a verdict for 28 meals at once and the plate composer re-scores every
 * candidate dish on each keystroke, neither of which survives a round-trip per
 * check. The server stays the authority — `PUT /food/menu-rotation/slot` runs the
 * same composition + shared-ingredient checks and rejects a bad plate — so these
 * helpers are a fast mirror for the UI, never the thing that guarantees validity.
 */
import type { CompositionRule, CompositionSlot, Dish, MealType, MenuRotationRow } from "@/lib/food-api";

/** One dish on a plate, plus the accompaniments chosen for it that meal. */
export type PlateEntry = { dishId: string; sideDishIds: string[] };
/** A plate keyed by day (1–7) and meal, as the board holds a whole week. */
export type PlateMap = Map<string, PlateEntry[]>;

export const ROTATION_WEEKS = [1, 2, 3, 4];
/** dayOfWeek is 1-based Monday..Sunday, matching food_menu_rotation. */
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 7];
export const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Board-cell label for each meal. Full labels live in MEAL_LABEL (food-api). */
export const MEAL_SHORT: Record<MealType, string> = {
  BREAKFAST: "Breakfast", LUNCH: "Lunch", SNACKS: "High Tea", DINNER: "Dinner",
};

export const plateKey = (day: number, meal: MealType | string) => `${day}|${meal}`;

export const componentLabel = (s: string | null | undefined) =>
  (s ?? "Any").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Ingredient ids of a dish. Empty when the dish has none configured. */
export const ingredientIdsOf = (d: Dish | undefined): string[] =>
  (d?.ingredients ?? []).map((i) => i.ingredientId).filter(Boolean);

/** Human-readable ingredient list for a dish ("Toor dal · Drumstick"). */
export const ingredientNamesOf = (d: Dish | undefined): string[] =>
  (d?.ingredients ?? []).map((i) => i.ingredientName ?? "").filter(Boolean);

/** Every dish id on a plate — slot fillers plus their accompaniments. */
export const allPlateDishIds = (plate: PlateEntry[]): string[] =>
  plate.flatMap((e) => [e.dishId, ...e.sideDishIds]);

// ─── Rotation rows ⇄ plates ──────────────────────────────────────────────────

/**
 * Folds flat rotation rows into per-(day, meal) plates.
 *
 * Side dishes are stored as ordinary rows tagged with `parentRotationId`, so they
 * are re-attached to their parent here rather than being treated as menu items in
 * their own right — the board must show "Chole ↳ Bhature", not two mains.
 */
export function rowsToPlates(rows: MenuRotationRow[]): PlateMap {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plates: PlateMap = new Map();
  const entryByRowId = new Map<string, PlateEntry>();

  for (const r of rows.filter((r) => !r.parentRotationId).sort((a, b) => a.sortOrder - b.sortOrder)) {
    const k = plateKey(r.dayOfWeek, r.mealType);
    const entry: PlateEntry = { dishId: r.dishId, sideDishIds: [] };
    entryByRowId.set(r.id, entry);
    plates.set(k, [...(plates.get(k) ?? []), entry]);
  }
  for (const r of rows) {
    if (!r.parentRotationId) continue;
    // A side whose parent was filtered out of this page would otherwise vanish
    // silently; promote it to a normal entry so nothing on the menu is hidden.
    const parent = entryByRowId.get(r.parentRotationId);
    if (parent) { parent.sideDishIds.push(r.dishId); continue; }
    if (!byId.has(r.parentRotationId)) {
      const k = plateKey(r.dayOfWeek, r.mealType);
      plates.set(k, [...(plates.get(k) ?? []), { dishId: r.dishId, sideDishIds: [] }]);
    }
  }
  return plates;
}

/** Plate → the `items` payload of PUT /food/menu-rotation/slot. */
export const plateToItems = (plate: PlateEntry[]) =>
  plate.map((e, i) => ({
    dishId: e.dishId,
    slotLabel: null,
    sortOrder: i,
    ...(e.sideDishIds.length ? { sideDishIds: e.sideDishIds } : {}),
  }));

// ─── Composition rules ───────────────────────────────────────────────────────

/**
 * The rule that governs one (brand, meal).
 *
 * Kitchen-specific rules exist in the schema but are disabled in the UI, so the
 * brand-default (kitchenId === null) wins and a kitchen-scoped rule is only used
 * when no default exists — the same precedence `resolveCompositionRule` applies
 * server-side.
 */
export function ruleFor(
  rules: CompositionRule[], brand: string, meal: MealType, kitchenId?: string | null,
): CompositionRule | null {
  const forMeal = rules.filter((r) => r.brand === brand && r.mealType === meal && r.isActive !== false);
  return forMeal.find((r) => !r.kitchenId)
    ?? (kitchenId ? forMeal.find((r) => r.kitchenId === kitchenId) : undefined)
    ?? forMeal[0]
    ?? null;
}

/** A rule's slots in display order. */
export const slotsOf = (rule: CompositionRule | null): CompositionSlot[] =>
  [...(rule?.slots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

// ─── Plate scoring ───────────────────────────────────────────────────────────

export type SlotRow = { slot: CompositionSlot; dishIds: string[] };
export type Clash = { ingredientId: string; ingredientName: string; a: string; b: string };
export type PlateVerdict = {
  rows: SlotRow[];
  /** Dishes that matched no slot — on the plate but not required by the rule. */
  extras: string[];
  clashes: Clash[];
  met: number;
  total: number;
  ok: boolean;
};

/** True when a dish can fill a slot (component and preparation must both match). */
const dishFitsSlot = (d: Dish | undefined, slot: CompositionSlot): boolean => {
  if (!d) return false;
  if (slot.component && d.component !== slot.component) return false;
  if (slot.preparation && !(d.preparations ?? []).includes(slot.preparation)) return false;
  return true;
};

/** Greedily seats each chosen dish in the first slot it fits that still has room. */
export function assignToSlots(
  dishIds: string[], slots: CompositionSlot[], dishById: Map<string, Dish>,
): { rows: SlotRow[]; extras: string[] } {
  const rows: SlotRow[] = slots.map((slot) => ({ slot, dishIds: [] }));
  const extras: string[] = [];
  for (const id of dishIds) {
    const d = dishById.get(id);
    const row = rows.find((r) => dishFitsSlot(d, r.slot) && r.dishIds.length < (r.slot.maxCount ?? 99));
    if (row) row.dishIds.push(id); else extras.push(id);
  }
  return { rows, extras };
}

/**
 * Pairs of dishes on the plate built from the same raw material.
 *
 * One entry per ingredient, naming the first two offenders — the message the
 * kitchen needs is "swap one of these", not an exhaustive graph.
 */
export function findClashes(dishIds: string[], dishById: Map<string, Dish>): Clash[] {
  const owner = new Map<string, { dishId: string; name: string }>();
  const out: Clash[] = [];
  const seen = new Set<string>();
  for (const id of dishIds) {
    const d = dishById.get(id);
    if (!d) continue;
    for (const ing of d.ingredients ?? []) {
      const held = owner.get(ing.ingredientId);
      if (held && held.dishId !== id) {
        if (seen.has(ing.ingredientId)) continue;
        seen.add(ing.ingredientId);
        out.push({
          ingredientId: ing.ingredientId,
          ingredientName: ing.ingredientName ?? "the same ingredient",
          a: held.name, b: d.name,
        });
      } else if (!held) {
        owner.set(ing.ingredientId, { dishId: id, name: d.name });
      }
    }
  }
  return out;
}

/**
 * Scores a plate against its meal's rule.
 *
 * Sides are EXEMPT from slot counting — a Bhature paired with Chole must not eat
 * the meal's "1 Bread" slot — but they still count for shared ingredients, which
 * applies to everything that lands on the plate. This mirrors what
 * `/food/menu-rotation/validate` does server-side.
 */
export function plateVerdict(
  plate: PlateEntry[], slots: CompositionSlot[], dishById: Map<string, Dish>,
): PlateVerdict {
  const { rows, extras } = assignToSlots(plate.map((e) => e.dishId), slots, dishById);
  const clashes = findClashes(allPlateDishIds(plate), dishById);
  const met = rows.filter((r) => r.dishIds.length >= r.slot.minCount).length;
  return { rows, extras, clashes, met, total: rows.length, ok: met === rows.length && clashes.length === 0 };
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export type Candidate = {
  dish: Dish;
  /** True when adding it would clash — the picker greys these out. */
  blocked: boolean;
  /** "shares Aloo" when blocked, "used Tue" when it repeats nearby, else "". */
  note: string;
};

/**
 * Dishes that could fill a slot, each flagged with why it is discouraged.
 *
 * A blocked candidate stays visible rather than being filtered away, so the user
 * can see *why* the obvious pick is unavailable instead of wondering where it went.
 */
export function candidatesForSlot(
  slot: CompositionSlot,
  brand: string,
  onPlate: string[],
  dishById: Map<string, Dish>,
  dishes: Dish[],
  /** dishId → day label it already appears on this week (nearby-repeat hint). */
  usedNearby?: Map<string, string>,
  /**
   * When false (the shared-ingredient rule is switched off in Menu Rules), a
   * clash is still annotated but no longer greys the candidate out — the
   * information is worth keeping even when the constraint is lifted.
   */
  clashBlocks = true,
): Candidate[] {
  const used = new Map<string, string>();
  for (const id of onPlate) {
    const d = dishById.get(id);
    for (const ing of d?.ingredients ?? []) used.set(ing.ingredientId, ing.ingredientName ?? "an ingredient");
  }
  return dishes
    .filter((d) => d.isActive && (d.brands ?? []).includes(brand) && !onPlate.includes(d.id) && dishFitsSlot(d, slot))
    .map((d) => {
      // Rule off → the clash is not surfaced at all, not merely un-blocked. A
      // note that outlives its own off-switch reads as a toggle that does nothing.
      const hit = clashBlocks ? (d.ingredients ?? []).find((i) => used.has(i.ingredientId)) : undefined;
      if (hit) return { dish: d, blocked: true, note: `shares ${used.get(hit.ingredientId)}` };
      const day = usedNearby?.get(d.id);
      return { dish: d, blocked: false, note: day ? `used ${day}` : "" };
    })
    .sort((a, b) =>
      Number(a.blocked) - Number(b.blocked)
      || Number(!!a.note) - Number(!!b.note)
      || a.dish.name.localeCompare(b.dish.name));
}

/**
 * Tops a plate up to its rule's minimums, skipping anything that would clash.
 *
 * `seed` rotates which candidate is taken, so filling a whole week gives each day
 * a different menu instead of the same plate seven times.
 */
export function fillPlate(
  plate: PlateEntry[], slots: CompositionSlot[], brand: string,
  dishById: Map<string, Dish>, dishes: Dish[], seed: number,
): PlateEntry[] {
  const next = plate.map((e) => ({ dishId: e.dishId, sideDishIds: [...e.sideDishIds] }));
  let n = seed;
  for (const slot of slots) {
    const { rows } = assignToSlots(next.map((e) => e.dishId), slots, dishById);
    const row = rows.find((r) => r.slot === slot);
    let need = slot.minCount - (row?.dishIds.length ?? 0);
    while (need > 0) {
      const open = candidatesForSlot(slot, brand, allPlateDishIds(next), dishById, dishes)
        .filter((c) => !c.blocked);
      if (!open.length) break;
      next.push({ dishId: open[n % open.length]!.dish.id, sideDishIds: [] });
      n += 3;
      need--;
    }
  }
  return next;
}

/* ── Repeat detection ────────────────────────────────────────────────────────
 *
 * The rotation is a CIRCLE, not a line: four weeks that then start over. So the
 * distance between two servings is measured round a 28-day cycle.
 *
 * The original check was `Math.abs(otherDay - day) > 3` over day-of-week numbers
 * inside a single week, which got three things wrong at once — Sunday and Monday
 * looked six days apart, week 1 Sunday could not see week 2 Monday, and week 4
 * never wrapped to week 1. Measuring on the cycle fixes all three together.
 */

/** Days in one full rotation cycle, after which the menu starts over. */
export const CYCLE_DAYS = ROTATION_WEEKS.length * 7;
/**
 * How close two servings of the same dish must be to count as a repeat.
 *
 * Configurable under Menu Rules (system_config `food_rule_repeat_days`); this is
 * the fallback used before the setting has loaded, and the value it defaults to
 * server-side. Callers that have the setting should pass it explicitly.
 */
export const REPEAT_WITHIN_DAYS = 3;
/**
 * Widest window worth offering. cycleGap measures the short way round the
 * cycle, so half of it already reaches every other day — beyond this the rule
 * cannot get any stricter.
 */
export const REPEAT_WITHIN_DAYS_MAX = (ROTATION_WEEKS.length * 7) / 2;

/** 0-based position of (week, day) within the rotation cycle. */
export const cycleIndex = (week: number, day: number) => (week - 1) * 7 + (day - 1);

/** Days between two cycle positions, measured the short way round the circle. */
export const cycleGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % CYCLE_DAYS;
  return Math.min(d, CYCLE_DAYS - d);
};

/** Dish ids per cell across every rotation week, keyed `week|day|meal`. */
export type CycleCells = Map<string, string[]>;
export const cycleKey = (week: number, day: number, meal: MealType | string) =>
  `${week}|${day}|${meal}`;

/** Flatten rotation rows (all weeks) into per-cell dish ids. Sides count too. */
export function rowsToCycleCells(rows: MenuRotationRow[]): CycleCells {
  const out: CycleCells = new Map();
  for (const r of rows) {
    const k = cycleKey(r.rotationWeek, r.dayOfWeek, r.mealType);
    out.set(k, [...(out.get(k) ?? []), r.dishId]);
  }
  return out;
}

/** "Tue" within the same week, "W2 Tue" when it lands in another one. */
const whereLabel = (sameWeek: boolean, week: number, day: number) =>
  sameWeek ? DAY_SHORT[day]! : `W${week} ${DAY_SHORT[day]}`;

/**
 * Dishes served for the SAME meal within `withinDays` of this cell, anywhere in
 * the cycle, as dishId → where it also appears.
 *
 * The cell itself is skipped — a dish is not a repeat of itself.
 */
export function repeatsNearCell(
  cells: CycleCells, week: number, day: number, meal: MealType | string,
  withinDays: number = REPEAT_WITHIN_DAYS,
): Map<string, string> {
  const here = cycleIndex(week, day);
  const out = new Map<string, string>();
  for (const w of ROTATION_WEEKS) {
    for (const d of WEEK_DAYS) {
      if (w === week && d === day) continue;
      const gap = cycleGap(here, cycleIndex(w, d));
      if (gap === 0 || gap > withinDays) continue;
      for (const id of cells.get(cycleKey(w, d, meal)) ?? []) {
        if (!out.has(id)) out.set(id, whereLabel(w === week, w, d));
      }
    }
  }
  return out;
}

/**
 * The subset of a cell's own dishes that also appear within the window — i.e.
 * what the board should mark. Empty when the cell is clean.
 */
export function cellRepeats(
  cells: CycleCells, week: number, day: number, meal: MealType | string,
  withinDays: number = REPEAT_WITHIN_DAYS,
): Array<{ dishId: string; where: string }> {
  const near = repeatsNearCell(cells, week, day, meal, withinDays);
  if (!near.size) return [];
  const mine = cells.get(cycleKey(week, day, meal)) ?? [];
  return [...new Set(mine)]
    .filter((id) => near.has(id))
    .map((id) => ({ dishId: id, where: near.get(id)! }));
}

/**
 * Dishes already used for the same meal nearby, as dishId → where. Drives the
 * soft "used Tue" hint in the picker; repeats are flagged, never blocked.
 */
export function nearbyRepeats(
  cells: CycleCells, week: number, day: number, meal: MealType,
  withinDays: number = REPEAT_WITHIN_DAYS,
): Map<string, string> {
  return repeatsNearCell(cells, week, day, meal, withinDays);
}
