/**
 * Star dish — "every meal's plate must contain exactly one star dish".
 *
 * INVARIANT: the star slot is NON-CONSUMING. Every other composition slot claims
 * a dish exclusively (greedy, first fit), which is right for "1 Dal, 2 Sabzi" —
 * one dish cannot be both. It is wrong for the star, because being the star is a
 * badge on a dish the plate already serves, not an extra portion. Under greedy
 * matching a star Paneer would be eaten by the "1 SABZI" slot and the star slot
 * would read MISSING with the star dish sitting right there on the plate. That
 * regression is invisible in a plate whose star dish happens to match no other
 * slot, so the cases below deliberately star dishes that DO.
 *
 * These are pure-function tests over validateMenuAgainstRule — no database, no
 * routes. The rule-resolution side (synthesising the slot from the switch) is
 * covered by food-star-dish-rule.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  validateMenuAgainstRule,
  buildCompositionVerdict,
  starOnlyRule,
  STAR_SLOT_ID,
  type CompositionRule,
} from "../food-service.js";

const slot = (over: Partial<CompositionRule["slots"][number]> = {}) => ({
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
  slot({ id: STAR_SLOT_ID, slotLabel: "Star dish", minCount: 1, maxCount: 1, sortOrder: -1, isStar: true });

const rule = (slots: CompositionRule["slots"]): CompositionRule => ({
  id: "r-1", brand: "UNILIV", mealType: "LUNCH", kitchenId: null, propertyId: null,
  name: "Lunch", slots,
});

const dish = (dishId: string, component: string, isStarDish = false) =>
  ({ dishId, component, preparations: ["VEG"], isStarDish });

const starRow = (v: ReturnType<typeof validateMenuAgainstRule>) =>
  v.slots.find((s) => s.isStar)!;

describe("validateMenuAgainstRule — the star slot", () => {
  it("is satisfied by a star dish that ALSO fills an ordinary slot", () => {
    // The regression this file exists for: Paneer is both the SABZI and the star.
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" }), slot({ component: "DAL" })]),
      [dish("paneer", "SABZI", true), dish("dal", "DAL")],
    );
    expect(starRow(v).status).toBe("OK");
    expect(v.slots.find((s) => s.component === "SABZI")!.matchedDishIds).toEqual(["paneer"]);
    expect(v.isComplete).toBe(true);
  });

  it("does not consume the dish it counts — the SABZI slot still gets it", () => {
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" })]),
      [dish("paneer", "SABZI", true)],
    );
    expect(v.slots.find((s) => s.component === "SABZI")!.status).toBe("OK");
    expect(starRow(v).matchedDishIds).toEqual(["paneer"]);
  });

  it("is MISSING when no dish on the plate is starred", () => {
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" })]),
      [dish("aloo", "SABZI")],
    );
    expect(starRow(v).status).toBe("MISSING");
    expect(v.isComplete).toBe(false);
  });

  it("is OVER with two star dishes — no more than one per plate", () => {
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI", maxCount: 2 })]),
      [dish("paneer", "SABZI", true), dish("kofta", "SABZI", true)],
    );
    expect(starRow(v).status).toBe("OVER");
    expect(starRow(v).count).toBe(2);
    expect(v.isComplete).toBe(false);
  });

  it("counts star dishes across the WHOLE plate, not just leftovers", () => {
    // Both stars are claimed by consuming slots. A consuming star slot would see
    // nothing left and report OK — the exact false pass this guards.
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" }), slot({ component: "DAL" })]),
      [dish("paneer", "SABZI", true), dish("dal", "DAL", true)],
    );
    expect(starRow(v).status).toBe("OVER");
    expect(starRow(v).count).toBe(2);
  });

  it("leaves ordinary slot assignment untouched whether the star slot is there or not", () => {
    const dishes = [dish("paneer", "SABZI", true), dish("aloo", "SABZI"), dish("dal", "DAL")];
    const ordinary = [slot({ id: "s-sabzi", component: "SABZI", maxCount: 2 }), slot({ id: "s-dal", component: "DAL" })];
    const without = validateMenuAgainstRule(rule(ordinary), dishes);
    const with_ = validateMenuAgainstRule(rule([starSlot(), ...ordinary]), dishes);
    for (const id of ["s-sabzi", "s-dal"]) {
      expect(with_.slots.find((s) => s.slotId === id)!.matchedDishIds)
        .toEqual(without.slots.find((s) => s.slotId === id)!.matchedDishIds);
    }
  });

  it("does not report a star dish as unmatched just because no component slot took it", () => {
    // Kheer is the star but the plate's rule has no DESSERT slot. It is on the
    // plate deliberately, so listing it as "extra" would be a lie the composer
    // renders as a stray dish.
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" })]),
      [dish("sabzi", "SABZI"), dish("kheer", "DESSERT", true)],
    );
    expect(v.unmatchedDishIds).toEqual([]);
    expect(starRow(v).status).toBe("OK");
  });

  it("still reports a NON-star dish that fills no slot as unmatched", () => {
    const v = validateMenuAgainstRule(
      rule([starSlot(), slot({ component: "SABZI" })]),
      [dish("sabzi", "SABZI", true), dish("kheer", "DESSERT")],
    );
    expect(v.unmatchedDishIds).toEqual(["kheer"]);
  });
});

describe("starOnlyRule — the meal with no composition rule", () => {
  it("enforces the star requirement on its own", () => {
    const r = starOnlyRule("UNILIV", "BREAKFAST");
    expect(validateMenuAgainstRule(r, [dish("poha", "HOT_FOOD")]).isComplete).toBe(false);
    expect(validateMenuAgainstRule(r, [dish("poha", "HOT_FOOD", true)]).isComplete).toBe(true);
  });
});

describe("buildCompositionVerdict — star wording", () => {
  it("says what to do, not which slot is empty", () => {
    const v = buildCompositionVerdict(
      validateMenuAgainstRule(rule([starSlot()]), [dish("aloo", "SABZI")]), [],
    );
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.type).toBe("STAR_DISH_MISSING");
    expect(v.violations[0]!.message).toMatch(/no star dish/i);
    // Not the generic slot copy — "Missing a dish for Star dish (needs 1)"
    // describes a slot to fill, when the fix lives in the dish catalogue.
    expect(v.violations[0]!.message).not.toMatch(/needs 1/);
  });

  it("names the count when there is more than one", () => {
    const v = buildCompositionVerdict(
      validateMenuAgainstRule(
        rule([starSlot(), slot({ component: "SABZI", maxCount: 2 })]),
        [dish("a", "SABZI", true), dish("b", "SABZI", true)],
      ), [],
    );
    expect(v.violations[0]!.type).toBe("STAR_DISH_MULTIPLE");
    expect(v.violations[0]!.message).toMatch(/2 star dishes/);
  });
});
