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

/** Every meal a day can hold — the span a per-day rule counts over. */
export const MEAL_KEYS_OF_DAY: MealType[] = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];

export const componentLabel = (s: string | null | undefined) =>
  (s ?? "Any").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/* ── catalogue identity ──────────────────────────────────────────────────────
 * What makes two catalogue rows "the same". Kept here, in one place, because
 * THREE call sites have to agree on it or the app contradicts itself: the dish
 * drawer, the ingredients grid, and — the authority — the server's 409 on
 * POST/PUT /food/{dishes,ingredients}. The bulk importer enforces the same rule
 * a fourth time in routes/bulk.ts.
 *
 * A name is compared trimmed and case-folded, because that is how a person
 * reads it: "Aloo Gobi", "aloo gobi" and "Aloo Gobi " are one dish. A dish
 * carries its COURSE in the identity too — "Rice" the rice and "Rice" the
 * dessert are genuinely two dishes.
 *
 * A RETIRED row still counts. Both tables are soft-deleted, so the row survives
 * and keeps being joined by name in reports; admitting a second copy would make
 * the catalogue ambiguous for good. Callers say "reactivate it" rather than
 * silently allowing the clone.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The comparable form of a catalogue name. */
export const catalogueKey = (name: string | null | undefined) => (name ?? "").trim().toLowerCase();

/** The dish this draft would duplicate, or null. `selfId` skips the row being edited. */
export const findDuplicateDish = (
  dishes: Dish[], name: string, component: string, selfId: string | null = null,
): Dish | null => {
  const key = catalogueKey(name);
  if (!key) return null;
  return dishes.find((d) =>
    d.id !== selfId && d.component === component && catalogueKey(d.name) === key) ?? null;
};

/** The ingredient this draft would duplicate, or null. `selfId` skips the row being edited. */
export const findDuplicateIngredient = <T extends { id: string; name: string }>(
  ingredients: T[], name: string, selfId: string | null = null,
): T | null => {
  const key = catalogueKey(name);
  if (!key) return null;
  return ingredients.find((i) => i.id !== selfId && catalogueKey(i.name) === key) ?? null;
};

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
 * How specific a rule is for the (kitchen, property) being resolved — higher
 * wins. Mirrors `scopeRank` in the server's food-service.ts; the two MUST agree
 * or the board grades a plate against one rule while the server saves it
 * against another.
 */
export function scopeRank(
  r: { kitchenId?: string | null; propertyId?: string | null },
  kitchenId?: string | null,
  propertyId?: string | null,
): number {
  if (propertyId && r.propertyId === propertyId) return 3;
  if (kitchenId && r.kitchenId === kitchenId) return 2;
  return 1;
}

/**
 * The rule that governs one (brand, meal) at the narrowest scope that applies:
 * a property rule beats a kitchen rule, which beats the brand default.
 *
 * Must match `resolveCompositionRule` (food-service.ts) exactly, or the board
 * validates a plate against a rule the server never applies.
 *
 * Rules carrying a scope that does NOT match the arguments are dropped rather
 * than ranked — another property's rule must never be picked just because it
 * happens to be the only row for the meal, and with no kitchen in play only the
 * brand default is eligible at all. That mirrors the server's query, which
 * filters the narrower rows out entirely in that case.
 */
export function ruleFor(
  rules: CompositionRule[], brand: string, meal: MealType,
  kitchenId?: string | null, propertyId?: string | null,
): CompositionRule | null {
  const applicable = rules.filter((r) =>
    r.brand === brand && r.mealType === meal && r.isActive !== false
    && (!r.propertyId || r.propertyId === propertyId)
    && (!r.kitchenId || r.kitchenId === kitchenId));
  if (!applicable.length) return null;
  return [...applicable].sort(
    (a, b) => scopeRank(b, kitchenId, propertyId) - scopeRank(a, kitchenId, propertyId),
  )[0] ?? null;
}

/** A rule's slots in display order. */
export const slotsOf = (rule: CompositionRule | null): CompositionSlot[] =>
  [...(rule?.slots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

/**
 * The COURSES a rule defines — its slots minus the star slot.
 *
 * The star slot is synthesised by the server from the star-dish menu rule and
 * appears on every meal while that rule is on (see CompositionSlot.isStar). It
 * is a constraint on the plate, not a course on it, so anything that counts
 * courses or asks "does this meal have a rule at all" must exclude it: otherwise
 * turning the rule on makes every meal report "1 course" and claim it has a
 * plate rule when nobody has written one.
 *
 * Use `slotsOf` where the star genuinely participates — scoring a plate,
 * rendering the slots to fill — and this where the question is about the rule.
 */
export const courseSlotsOf = (rule: CompositionRule | null): CompositionSlot[] =>
  slotsOf(rule).filter((s) => !s.isStar);

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

/** True when a dish can fill a slot (component and preparation must both match).
 *  A star slot ignores both and matches on the dish's star flag alone. */
const dishFitsSlot = (d: Dish | undefined, slot: CompositionSlot): boolean => {
  if (!d) return false;
  if (slot.isStar) return !!d.isStarDish;
  if (slot.component && d.component !== slot.component) return false;
  if (slot.preparation && !(d.preparations ?? []).includes(slot.preparation)) return false;
  return true;
};

/**
 * Greedily seats each chosen dish in the first slot it fits that still has room.
 *
 * Star slots are the exception and are filled in a separate, NON-CONSUMING pass
 * — they list every star dish on the plate rather than claiming one. This
 * mirrors validateMenuAgainstRule on the server, and the two must agree: the
 * composer's verdict is what arms the Save button, so if it seated a star dish
 * in the star slot and the server seated it in "1 Sabzi", the user would be
 * shown a complete plate the save then rejected.
 */
export function assignToSlots(
  dishIds: string[], slots: CompositionSlot[], dishById: Map<string, Dish>,
): { rows: SlotRow[]; extras: string[] } {
  const rows: SlotRow[] = slots.map((slot) => ({ slot, dishIds: [] }));
  const extras: string[] = [];
  const consuming = rows.filter((r) => !r.slot.isStar);
  for (const id of dishIds) {
    const d = dishById.get(id);
    const row = consuming.find((r) => dishFitsSlot(d, r.slot) && r.dishIds.length < (r.slot.maxCount ?? 99));
    if (row) row.dishIds.push(id);
    // A star dish the star slot will show is on the plate on purpose, not an
    // extra — it just did not fit any of the component slots.
    else if (!(d?.isStarDish && rows.some((r) => r.slot.isStar))) extras.push(id);
  }
  for (const r of rows) {
    if (!r.slot.isStar) continue;
    r.dishIds = dishIds.filter((id) => dishFitsSlot(dishById.get(id), r.slot));
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

/** An ingredient carrying a per-day dish limit (ingredients.maxPerDay). */
export type IngredientCap = { ingredientId: string; name: string; maxPerDay: number };

/** One ingredient over its daily allowance, as the board reports it on a cell. */
export type DayCapHit = { ingredientName: string; count: number; maxPerDay: number };

/**
 * Ingredients this cell pushes over their DAILY limit (rule 2).
 *
 * The count spans every meal of the (week, day) — that is the whole point of the
 * rule, and what separates it from the shared-ingredient check, which only ever
 * looks at one plate.
 *
 * This is the WHOLE rule. There is no server-side counterpart: enforcing it on
 * save deadlocked any day already over the limit, because every step of a fix
 * was still over it. The server was stripped back to storing the switch, so if
 * this stops firing the rule simply stops existing.
 *
 * Only cells that actually CARRY a breaching ingredient are reported, so a
 * dinner with no aloo is not marked because breakfast and lunch both had some.
 *
 * Occurrences are counted, not distinct dishes: the same dish served at two
 * meals is that ingredient twice in the day, which is what is being limited.
 */
export function cellDayCapHits(
  cells: CycleCells, week: number, day: number, meal: MealType | string,
  dishById: Map<string, Dish>, caps: IngredientCap[],
): DayCapHit[] {
  return dayCapBreaches(
    cells.get(cycleKey(week, day, meal)) ?? [],
    otherMealDishIds(cells, week, day, meal),
    dishById, caps,
  );
}

/** Dishes on the other meals of this day — the context a per-day rule needs. */
export function otherMealDishIds(
  cells: CycleCells, week: number, day: number, meal: MealType | string,
): string[] {
  return MEAL_KEYS_OF_DAY
    .filter((m) => m !== meal)
    .flatMap((m) => cells.get(cycleKey(week, day, m)) ?? []);
}

/**
 * Ingredients that `plateDishIds` pushes over their daily limit, given what the
 * REST of the day already serves.
 *
 * Split this way so the plate composer can re-run it against a live draft: the
 * board passes a saved cell, the composer passes whatever is on screen, and both
 * get the same answer the server will give. `otherDayDishIds` is every other
 * meal of the same day — the meal being edited is `plateDishIds`, because a save
 * REPLACES that cell rather than adding to it.
 *
 * Only breaches this plate actually contributes to are returned, so a dinner
 * with no aloo is never marked because breakfast and lunch both had some.
 */
export function dayCapBreaches(
  plateDishIds: string[], otherDayDishIds: string[],
  dishById: Map<string, Dish>, caps: IngredientCap[],
): DayCapHit[] {
  if (!caps.length || !plateDishIds.length) return [];
  const dayDishIds = [...otherDayDishIds, ...plateDishIds];
  const carries = (dishId: string, ingredientId: string) =>
    ingredientIdsOf(dishById.get(dishId)).includes(ingredientId);
  const out: DayCapHit[] = [];
  for (const cap of caps) {
    // Occurrences, not distinct dishes: the same dish at two meals is that
    // ingredient twice in the day, which is what is being limited.
    const count = dayDishIds.filter((id) => carries(id, cap.ingredientId)).length;
    if (count <= cap.maxPerDay) continue;
    if (!plateDishIds.some((id) => carries(id, cap.ingredientId))) continue;
    out.push({ ingredientName: cap.name, count, maxPerDay: cap.maxPerDay });
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
  // maxCount is part of "met", not just minCount. It never used to matter —
  // assignToSlots refuses to seat past a consuming slot's maxCount, so no row
  // could exceed it. A star slot is non-consuming and lists every star dish on
  // the plate, so two stars is a real over-count the server rejects, and without
  // this the composer would call that plate complete and arm Save.
  const met = rows.filter(
    (r) => r.dishIds.length >= r.slot.minCount
      && (r.slot.maxCount == null || r.dishIds.length <= r.slot.maxCount),
  ).length;
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
 * Which repeat rules are switched on, as the board resolves them from Menu Rules.
 *
 * Three independent rules, all HINTS — none of them ever blocks a save:
 *
 *   withinDays  the +/-N-day window, measured the short way round the cycle
 *   sameWeek    rule 3 - the same dish twice inside one rotation week
 *   sameWeekday rule 4 - the same dish on the same weekday of another week
 *
 * They are genuinely different questions and deliberately not one setting. The
 * window asks "how far apart are these two days?", rule 4 asks "are these the
 * same weekday?" - and no window value expresses the latter: same-weekday pairs
 * sit at gaps of 7 and 14 in a 4-week cycle, so a window wide enough to catch
 * them (14) catches every other cell in the cycle too.
 */
export type RepeatRuleSet = {
  /** Window in days, or null when the window rule is off. */
  withinDays: number | null;
  sameWeek: boolean;
  sameWeekday: boolean;
};

/** Back-compat: a bare number means "window rule only", as callers used to pass. */
const asRules = (r: number | RepeatRuleSet | undefined | null): RepeatRuleSet =>
  r == null || typeof r === "number"
    ? { withinDays: r ?? REPEAT_WITHIN_DAYS, sameWeek: false, sameWeekday: false }
    : r;

/** No rule on - callers can then skip the scan entirely. */
export const anyRepeatRuleOn = (r: RepeatRuleSet): boolean =>
  r.withinDays != null || r.sameWeek || r.sameWeekday;

/**
 * Does cell (w, d) count as a repeat of (week, day) under these rules?
 *
 * The cell itself is never a repeat of itself, which is checked first - it also
 * makes the two later branches exact: any remaining `d === day` necessarily has
 * `w !== week` (rule 4's "another week"), and any remaining `w === week` has
 * `d !== day` (rule 3's "another day this week").
 */
function isRepeatSource(
  rules: RepeatRuleSet, week: number, day: number, w: number, d: number,
): boolean {
  if (w === week && d === day) return false;
  if (rules.withinDays != null) {
    const gap = cycleGap(cycleIndex(week, day), cycleIndex(w, d));
    if (gap > 0 && gap <= rules.withinDays) return true;
  }
  if (rules.sameWeek && w === week) return true;
  if (rules.sameWeekday && d === day) return true;
  return false;
}

/**
 * Dishes served for the SAME meal that repeat this cell under `rules`, as
 * dishId -> where they also appear.
 *
 * Per meal, like every repeat rule here: `cycleKey` carries mealType, so lunches
 * are compared with lunches. Staples appear at several meals a day by design,
 * and comparing across meals would flag rice and dal everywhere.
 *
 * The cell itself is skipped - a dish is not a repeat of itself.
 */
export function repeatsNearCell(
  cells: CycleCells, week: number, day: number, meal: MealType | string,
  rules: number | RepeatRuleSet = REPEAT_WITHIN_DAYS,
): Map<string, string> {
  const r = asRules(rules);
  const out = new Map<string, string>();
  if (!anyRepeatRuleOn(r)) return out;
  for (const w of ROTATION_WEEKS) {
    for (const d of WEEK_DAYS) {
      if (!isRepeatSource(r, week, day, w, d)) continue;
      for (const id of cells.get(cycleKey(w, d, meal)) ?? []) {
        // The label says WHERE, not which rule fired - and it already
        // distinguishes them naturally: a same-week hit reads "Wed", a
        // same-weekday hit reads "W3 Fri".
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
  rules: number | RepeatRuleSet = REPEAT_WITHIN_DAYS,
): Array<{ dishId: string; where: string }> {
  const near = repeatsNearCell(cells, week, day, meal, rules);
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
  rules: number | RepeatRuleSet = REPEAT_WITHIN_DAYS,
): Map<string, string> {
  return repeatsNearCell(cells, week, day, meal, rules);
}
