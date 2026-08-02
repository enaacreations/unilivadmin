import { describe, expect, it } from "vitest";
import {
  buildCompositionVerdict,
  validateMenuAgainstRule,
  type CompositionRule,
  type CompositionSlot,
  type SharedIngredient,
} from "../food-service.js";

/** Seed a slot from the live composition-rule shape (defaults: component-agnostic, min 1). */
const slot = (over: Partial<CompositionSlot> & { id: string }): CompositionSlot => ({
  slotLabel: null,
  component: null,
  preparation: null,
  minCount: 1,
  maxCount: null,
  sortOrder: 0,
  ...over,
});

/** Seed a rule around a set of slots (brand/meal are irrelevant to the pure validator). */
const rule = (slots: CompositionSlot[], over: Partial<CompositionRule> = {}): CompositionRule => ({
  id: "rule-1",
  brand: "UNILIV",
  mealType: "LUNCH",
  kitchenId: null,
  name: "Standard Thali",
  slots,
  ...over,
});

const dish = (dishId: string, component: string, preparations: string[] = []) => ({
  dishId,
  component,
  preparations,
});

describe("validateMenuAgainstRule — greedy slot matching", () => {
  it("a complete thali satisfies every slot and leaves nothing unmatched", () => {
    const result = validateMenuAgainstRule(
      rule([
        slot({ id: "s1", component: "RICE" }),
        slot({ id: "s2", component: "SABZI" }),
        slot({ id: "s3", component: "DAL" }),
      ]),
      [dish("d-rice", "RICE"), dish("d-sabzi", "SABZI"), dish("d-dal", "DAL")],
    );
    expect(result.slots.map((s) => s.status)).toEqual(["OK", "OK", "OK"]);
    expect(result.unmatchedDishIds).toEqual([]);
    expect(result.isComplete).toBe(true);
  });

  it("flags a slot with no matching dish as MISSING", () => {
    const result = validateMenuAgainstRule(
      rule([slot({ id: "s1", component: "RICE" }), slot({ id: "s2", component: "DAL" })]),
      [dish("d-rice", "RICE")],
    );
    expect(result.slots[1]!.status).toBe("MISSING");
    expect(result.slots[1]!.count).toBe(0);
    expect(result.isComplete).toBe(false);
  });

  it("flags a slot below its minimum as UNDER", () => {
    const result = validateMenuAgainstRule(
      rule([slot({ id: "s1", component: "SABZI", minCount: 2 })]),
      [dish("d-sabzi", "SABZI")],
    );
    expect(result.slots[0]!.status).toBe("UNDER");
    expect(result.slots[0]!.count).toBe(1);
  });

  it("flags a slot above its maximum as OVER", () => {
    const result = validateMenuAgainstRule(
      rule([slot({ id: "s1", component: "SABZI", minCount: 1, maxCount: 1 })]),
      [dish("d-sabzi-1", "SABZI"), dish("d-sabzi-2", "SABZI")],
    );
    expect(result.slots[0]!.status).toBe("OVER");
    expect(result.slots[0]!.count).toBe(2);
    expect(result.slots[0]!.matchedDishIds).toEqual(["d-sabzi-1", "d-sabzi-2"]);
  });

  it("consumes each dish once — a second slot cannot reuse an already-matched dish", () => {
    const result = validateMenuAgainstRule(
      rule([
        slot({ id: "s1", component: "HOT_FOOD" }),
        slot({ id: "s2", component: "HOT_FOOD" }),
      ]),
      [dish("d-hot", "HOT_FOOD")],
    );
    expect(result.slots[0]!.status).toBe("OK");
    expect(result.slots[0]!.matchedDishIds).toEqual(["d-hot"]);
    expect(result.slots[1]!.status).toBe("MISSING");
  });
});

describe("component & preparation matching (dishMatchesSlot)", () => {
  it("a component-agnostic slot matches any dish", () => {
    const result = validateMenuAgainstRule(
      rule([slot({ id: "s1", component: null })]),
      [dish("d-dessert", "DESSERT")],
    );
    expect(result.slots[0]!.status).toBe("OK");
  });

  it("a preparation-constrained slot only matches a dish carrying that preparation", () => {
    const jainSlot = rule([slot({ id: "s1", component: "SABZI", preparation: "JAIN" })]);
    const veg = validateMenuAgainstRule(jainSlot, [dish("d-veg", "SABZI", ["VEG"])]);
    const jain = validateMenuAgainstRule(jainSlot, [dish("d-jain", "SABZI", ["VEG", "JAIN"])]);
    expect(veg.slots[0]!.status).toBe("MISSING");
    expect(jain.slots[0]!.status).toBe("OK");
  });
});

describe("null rule / unmatched dishes", () => {
  it("a null rule enforces nothing — complete, with every dish reported unmatched", () => {
    const result = validateMenuAgainstRule(null, [dish("d1", "RICE"), dish("d2", "DAL")]);
    expect(result.ruleId).toBeNull();
    expect(result.slots).toEqual([]);
    expect(result.unmatchedDishIds).toEqual(["d1", "d2"]);
    expect(result.isComplete).toBe(true);
  });

  it("lists dishes no slot consumed in unmatchedDishIds", () => {
    const result = validateMenuAgainstRule(
      rule([slot({ id: "s1", component: "RICE" })]),
      [dish("d-rice", "RICE"), dish("d-extra", "DESSERT")],
    );
    expect(result.slots[0]!.matchedDishIds).toEqual(["d-rice"]);
    expect(result.unmatchedDishIds).toEqual(["d-extra"]);
  });
});

describe("buildCompositionVerdict — machine-readable hard-block", () => {
  const okValidation = () =>
    validateMenuAgainstRule(rule([slot({ id: "s1", component: "RICE" })]), [dish("d-rice", "RICE")]);

  it("ok:true only when every slot is satisfied and no ingredient is shared", () => {
    const verdict = buildCompositionVerdict(okValidation(), []);
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it("maps MISSING / UNDER / OVER slot statuses to violation types", () => {
    const validation = validateMenuAgainstRule(
      rule([
        slot({ id: "s1", component: "RICE" }), // MISSING (no rice supplied)
        slot({ id: "s2", component: "SABZI", minCount: 2 }), // UNDER (only 1)
        slot({ id: "s3", component: "DAL", maxCount: 1 }), // OVER (2 supplied)
      ]),
      [dish("d-sabzi", "SABZI"), dish("d-dal-1", "DAL"), dish("d-dal-2", "DAL")],
    );
    const verdict = buildCompositionVerdict(validation, []);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.map((v) => v.type)).toEqual(["SLOT_MISSING", "SLOT_UNDER", "SLOT_OVER"]);
  });

  it("reports a shared ingredient as a SHARED_INGREDIENT violation and blocks", () => {
    const shared: SharedIngredient[] = [
      { ingredientId: "ing-onion", name: "Onion", dishIds: ["d-rice", "d-sabzi"] },
    ];
    const verdict = buildCompositionVerdict(okValidation(), shared);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]!.type).toBe("SHARED_INGREDIENT");
    expect(verdict.violations[0]!.dishIds).toEqual(["d-rice", "d-sabzi"]);
  });

  it("a null-rule validation yields an ok verdict (nothing to enforce)", () => {
    const verdict = buildCompositionVerdict(validateMenuAgainstRule(null, [dish("d1", "RICE")]), []);
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });
});
