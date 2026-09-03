/**
 * Rule 2 on the board — the warning that tells you before the save refuses you.
 *
 * FLAG ONLY, and these tests are therefore the whole rule. The server enforced
 * it once and that deadlocked every day already over the limit — each step of a
 * fix was still over it, so no edit was accepted. Enforcement was removed and
 * the server now only stores the switch, which means if this detection stops
 * firing the rule silently ceases to exist. Nothing else will catch that.
 *
 * INVARIANT: the count spans every meal of the day. That is what no per-plate
 * check can see, and the reason the rule exists at all.
 */
import { describe, expect, it } from "vitest";
import { cellDayCapHits, cycleKey, dayCapBreaches, type CycleCells, type IngredientCap } from "../menu-lib";
import type { Dish } from "@/lib/food-api";

const ALOO: IngredientCap = { ingredientId: "i-aloo", name: "Aloo (Potato)", maxPerDay: 1 };

const dish = (id: string, ingredientIds: string[]): Dish => ({
  id, name: id, component: "SABZI", unit: "KG", brands: ["UNILIV"], preparations: ["VEG"],
  photoUrl: null, isActive: true,
  ingredients: ingredientIds.map((ingredientId) => ({ ingredientId, ingredientName: ingredientId })),
} as Dish);

const dishes = new Map<string, Dish>([
  ["aloo1", dish("aloo1", ["i-aloo"])],
  ["aloo2", dish("aloo2", ["i-aloo"])],
  ["dal", dish("dal", ["i-dal"])],
]);

/** Place dishes on meals of week 1, day 1. */
const cells = (byMeal: Record<string, string[]>): CycleCells => {
  const m: CycleCells = new Map();
  for (const [meal, ids] of Object.entries(byMeal)) m.set(cycleKey(1, 1, meal), ids);
  return m;
};

const hits = (c: CycleCells, meal: string, caps: IngredientCap[] = [ALOO]) =>
  cellDayCapHits(c, 1, 1, meal, dishes, caps);

describe("cellDayCapHits", () => {
  it("flags aloo at breakfast AND lunch — the cross-meal case", () => {
    const c = cells({ BREAKFAST: ["aloo1"], LUNCH: ["aloo2"] });
    expect(hits(c, "LUNCH")).toEqual([{ ingredientName: "Aloo (Potato)", count: 2, maxPerDay: 1 }]);
    // Both contributing cells are marked, not just the one being edited.
    expect(hits(c, "BREAKFAST")).toHaveLength(1);
  });

  it("counts across all four meals", () => {
    const c = cells({ BREAKFAST: ["aloo1"], LUNCH: ["aloo2"], SNACKS: ["aloo1"], DINNER: ["aloo2"] });
    expect(hits(c, "DINNER")[0]).toMatchObject({ count: 4, maxPerDay: 1 });
  });

  it("stays silent on a cell that carries none of the breaching ingredient", () => {
    // Aloo breaches on the day, but dinner is dal — marking it would send the
    // user to a plate with nothing to fix.
    const c = cells({ BREAKFAST: ["aloo1"], LUNCH: ["aloo2"], DINNER: ["dal"] });
    expect(hits(c, "DINNER")).toEqual([]);
    expect(hits(c, "LUNCH")).toHaveLength(1);
  });

  it("allows exactly the limit", () => {
    expect(hits(cells({ LUNCH: ["aloo1"] }), "LUNCH")).toEqual([]);
  });

  it("honours a limit above 1", () => {
    const c = cells({ BREAKFAST: ["aloo1"], LUNCH: ["aloo2"] });
    expect(hits(c, "LUNCH", [{ ...ALOO, maxPerDay: 2 }])).toEqual([]);
    expect(hits(c, "LUNCH", [{ ...ALOO, maxPerDay: 1 }])).toHaveLength(1);
  });

  it("counts occurrences — the same dish at two meals is the ingredient twice", () => {
    const c = cells({ LUNCH: ["aloo1"], DINNER: ["aloo1"] });
    expect(hits(c, "LUNCH")[0]).toMatchObject({ count: 2 });
  });

  it("is silent when nothing is capped — the rule is off or nothing has a limit", () => {
    const c = cells({ BREAKFAST: ["aloo1"], LUNCH: ["aloo2"] });
    expect(hits(c, "LUNCH", [])).toEqual([]);
  });

  it("ignores other days and weeks", () => {
    const m: CycleCells = new Map();
    m.set(cycleKey(1, 1, "LUNCH"), ["aloo1"]);
    m.set(cycleKey(1, 2, "LUNCH"), ["aloo2"]); // Tuesday
    m.set(cycleKey(3, 1, "LUNCH"), ["aloo2"]); // week 3
    expect(cellDayCapHits(m, 1, 1, "LUNCH", dishes, [ALOO])).toEqual([]);
  });

  it("reports each breaching ingredient separately", () => {
    const both = new Map<string, Dish>([...dishes, ["mix", dish("mix", ["i-aloo", "i-dal"])]]);
    const c = cells({ LUNCH: ["mix"], DINNER: ["mix"] });
    const out = cellDayCapHits(c, 1, 1, "LUNCH", both, [
      ALOO, { ingredientId: "i-dal", name: "Dal", maxPerDay: 1 },
    ]);
    expect(out.map((h) => h.ingredientName).sort()).toEqual(["Aloo (Potato)", "Dal"]);
  });
});

/**
 * The composer path. The board reads a saved cell; the composer re-checks a LIVE
 * draft against the rest of the day, so removing the offending dish clears the
 * warning as you edit rather than after saving. Both go through dayCapBreaches.
 *
 * The meal being edited comes from the DRAFT, never from the stored rows — a
 * save replaces that cell, so counting both would invent a breach on a plate
 * nobody changed.
 */
describe("dayCapBreaches — the live draft in the composer", () => {
  const breaches = (plate: string[], others: string[], caps: IngredientCap[] = [ALOO]) =>
    dayCapBreaches(plate, others, dishes, caps);

  it("flags a draft that pushes the day over", () => {
    expect(breaches(["aloo1"], ["aloo2"])[0]).toMatchObject({ count: 2, maxPerDay: 1 });
  });

  it("clears as soon as the offending dish is removed from the draft", () => {
    expect(breaches(["aloo1", "dal"], ["aloo2"])).toHaveLength(1);
    expect(breaches(["dal"], ["aloo2"])).toEqual([]);
  });

  /* The meal being edited is the draft, never the stored rows — a cell that
   * already held an aloo dish must not count it AND the replacement. */
  it("does not double-count the cell being replaced", () => {
    // Editing lunch, which already had aloo1 stored; the draft still has one
    // aloo dish and the rest of the day has none. That is one, not two.
    expect(breaches(["aloo1"], [])).toEqual([]);
  });

  it("counts a draft carrying two capped dishes on its own", () => {
    expect(breaches(["aloo1", "aloo2"], [])[0]).toMatchObject({ count: 2 });
  });

  it("is silent on an empty draft, whatever the rest of the day holds", () => {
    expect(breaches([], ["aloo1", "aloo2"])).toEqual([]);
  });

  it("is silent when the rule is off (no caps)", () => {
    expect(breaches(["aloo1"], ["aloo2"], [])).toEqual([]);
  });
});
