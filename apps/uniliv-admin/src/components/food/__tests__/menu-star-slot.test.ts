/**
 * The star slot on the client: scoring it, and keeping it out of course counts.
 *
 * Two separate invariants, both regressions that were live once:
 *
 *  1. plateVerdict must agree with validateMenuAgainstRule on the server. The
 *     composer's verdict is what arms the Save button, so if the client seats a
 *     star dish in the star slot and the server seats it in "1 Sabzi", the user
 *     is shown a complete plate the save then rejects. The star slot is
 *     NON-CONSUMING on both sides.
 *
 *  2. The star slot is a constraint, not a course. It is synthesised onto every
 *     meal while the star rule is on, so anything counting courses — or asking
 *     "does this meal have a plate rule at all" — has to exclude it. Otherwise
 *     turning the rule on makes every meal report "1 course" and claim a rule
 *     nobody wrote, and the Menu board stops offering "no rule → go define one".
 */
import { describe, expect, it } from "vitest";
import { courseSlotsOf, plateVerdict, slotsOf } from "../menu-lib";
import type { CompositionRule, CompositionSlot, Dish } from "@/lib/food-api";

const slot = (over: Partial<CompositionSlot> = {}): CompositionSlot => ({
  id: over.id ?? `s-${over.component ?? "any"}`,
  slotLabel: over.slotLabel ?? null,
  component: over.component ?? null,
  preparation: over.preparation ?? null,
  minCount: over.minCount ?? 1,
  maxCount: over.maxCount ?? null,
  sortOrder: over.sortOrder ?? 0,
  isStar: over.isStar ?? false,
});

const starSlot = () =>
  slot({ id: "__star__", slotLabel: "Star dish", minCount: 1, maxCount: 1, sortOrder: -1, isStar: true });

const dish = (id: string, component: string, isStarDish = false): Dish => ({
  id, name: id, component, unit: "KG", brands: ["UNILIV"], preparations: ["VEG"],
  photoUrl: null, isActive: true, isStarDish, ingredients: [],
});

const mapOf = (...ds: Dish[]) => new Map(ds.map((d) => [d.id, d]));
const plate = (...ids: string[]) => ids.map((dishId) => ({ dishId, sideDishIds: [] }));
const starRow = (v: ReturnType<typeof plateVerdict>) => v.rows.find((r) => r.slot.isStar)!;

describe("plateVerdict — the star slot", () => {
  it("is satisfied by a star dish that ALSO fills a course slot", () => {
    const v = plateVerdict(
      plate("paneer", "dal"),
      [starSlot(), slot({ component: "SABZI" }), slot({ component: "DAL" })],
      mapOf(dish("paneer", "SABZI", true), dish("dal", "DAL")),
    );
    expect(starRow(v).dishIds).toEqual(["paneer"]);
    // …and the SABZI slot still has it: the star counted it without taking it.
    expect(v.rows.find((r) => r.slot.component === "SABZI")!.dishIds).toEqual(["paneer"]);
    expect(v.ok).toBe(true);
  });

  it("is not met when nothing on the plate is starred", () => {
    const v = plateVerdict(
      plate("aloo"), [starSlot(), slot({ component: "SABZI" })], mapOf(dish("aloo", "SABZI")),
    );
    expect(starRow(v).dishIds).toEqual([]);
    expect(v.ok).toBe(false);
  });

  it("is not met with TWO star dishes — maxCount counts, not just minCount", () => {
    // The bug this pins: `met` only ever checked minCount. That was safe while
    // every slot consumed (assignToSlots refuses to overfill one), but the star
    // slot is non-consuming, so two stars is a real over-count the server
    // rejects — and the composer would have called this plate complete.
    const v = plateVerdict(
      plate("paneer", "kofta"),
      [starSlot(), slot({ component: "SABZI", maxCount: 2 })],
      mapOf(dish("paneer", "SABZI", true), dish("kofta", "SABZI", true)),
    );
    expect(starRow(v).dishIds).toHaveLength(2);
    expect(v.ok).toBe(false);
  });

  it("counts stars across the whole plate, not just what other slots left over", () => {
    const v = plateVerdict(
      plate("paneer", "dal"),
      [starSlot(), slot({ component: "SABZI" }), slot({ component: "DAL" })],
      mapOf(dish("paneer", "SABZI", true), dish("dal", "DAL", true)),
    );
    expect(starRow(v).dishIds).toHaveLength(2);
    expect(v.ok).toBe(false);
  });

  it("does not call a star dish an extra just because no course slot took it", () => {
    const v = plateVerdict(
      plate("sabzi", "kheer"),
      [starSlot(), slot({ component: "SABZI" })],
      mapOf(dish("sabzi", "SABZI"), dish("kheer", "DESSERT", true)),
    );
    expect(v.extras).toEqual([]);
  });

  it("still calls a non-star dish that fills no slot an extra", () => {
    const v = plateVerdict(
      plate("sabzi", "kheer"),
      [starSlot(), slot({ component: "SABZI" })],
      mapOf(dish("sabzi", "SABZI", true), dish("kheer", "DESSERT")),
    );
    expect(v.extras).toEqual(["kheer"]);
  });

  it("leaves course-slot assignment identical with and without the star slot", () => {
    const dishes = mapOf(dish("paneer", "SABZI", true), dish("aloo", "SABZI"), dish("dal", "DAL"));
    const courses = [slot({ id: "s-sabzi", component: "SABZI", maxCount: 2 }), slot({ id: "s-dal", component: "DAL" })];
    const p = plate("paneer", "aloo", "dal");
    const without = plateVerdict(p, courses, dishes);
    const with_ = plateVerdict(p, [starSlot(), ...courses], dishes);
    for (const id of ["s-sabzi", "s-dal"]) {
      expect(with_.rows.find((r) => r.slot.id === id)!.dishIds)
        .toEqual(without.rows.find((r) => r.slot.id === id)!.dishIds);
    }
  });
});

describe("courseSlotsOf — the star slot is not a course", () => {
  const rule = (slots: CompositionSlot[]): CompositionRule => ({
    id: "r-1", brand: "UNILIV", mealType: "LUNCH", kitchenId: null, propertyId: null,
    name: "Lunch", slots,
  } as CompositionRule);

  it("drops the star slot but keeps every real course", () => {
    const r = rule([starSlot(), slot({ component: "SABZI" }), slot({ component: "DAL" })]);
    expect(slotsOf(r)).toHaveLength(3);
    expect(courseSlotsOf(r).map((s) => s.component)).toEqual(["SABZI", "DAL"]);
  });

  /* The board asks "has this meal got a rule?" by counting slots. With the star
   * slot synthesised onto every meal, that question answered yes everywhere the
   * moment the star rule went on — so a meal with no plate rule stopped saying
   * "no rule" and stopped offering the link to go and write one. */
  it("reports a star-only meal as having no course rule", () => {
    expect(courseSlotsOf(rule([starSlot()]))).toHaveLength(0);
    expect(slotsOf(rule([starSlot()]))).toHaveLength(1);
  });

  it("is empty for a meal with no rule at all", () => {
    expect(courseSlotsOf(null)).toEqual([]);
  });
});
