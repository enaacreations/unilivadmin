/**
 * Ingredient roll-up for the Kitchen Home exports.
 *
 * The rates in `dish_ingredients` are PER PERSON, so the arithmetic under test
 * is `rate × the people eating that dish` — where the head count comes from the
 * properties in the dish's own per-property split, not from the meal total.
 * Getting that wrong silently over- or under-orders the store, so the numbers
 * below are pinned against real seed data.
 */
import { describe, it, expect } from "vitest";
import { buildIngredientLines } from "../food-kitchen-home";
import type { KitchenSummaryDish, DishIngredientRow } from "@/lib/food-api";

const dish = (
  dishId: string,
  dishName: string,
  byProperty: { propertyId: string; propertyName: string; qty: number }[],
): KitchenSummaryDish =>
  ({
    dishId,
    dishName,
    component: null,
    unit: "KG",
    displayQty: byProperty.reduce((n, b) => n + b.qty, 0),
    displayUnit: "KG",
    byProperty,
  }) as unknown as KitchenSummaryDish;

const ing = (ingredientName: string, quantity: number, unit: string): DishIngredientRow =>
  ({ ingredientId: ingredientName, ingredientName, quantity, unit }) as DishIngredientRow;

/** Real per-person rates from the seeded catalogue. */
const IDLI_SAMBAR = [
  ing("Chawal (Rice)", 0.06, "KG"),
  ing("Mixed Vegetables", 0.04, "KG"),
  ing("Tomato", 0.03, "KG"),
  ing("Toor Dal", 0.03, "KG"),
  ing("Urad Dal", 0.03, "KG"),
];
const CHUTNEY = [
  ing("Hara Dhaniya (Coriander)", 0.02, "KG"),
  ing("Hari Mirch (Green Chilli)", 0.005, "KG"),
  ing("Nariyal (Coconut)", 0.02, "KG"),
];
const HOT_MILK = [ing("Cheeni (Sugar)", 0.01, "KG"), ing("Doodh (Milk)", 0.2, "LITRE")];

const qtyOf = (lines: ReturnType<typeof buildIngredientLines>, name: string) =>
  lines.find((l) => l.name === name)?.qty;

describe("buildIngredientLines", () => {
  it("scales per-person rates by the people eating each dish", () => {
    // The single dispatched breakfast at UNILIV Koramangala, 15 Aug: 80 people.
    const lines = buildIngredientLines(
      [
        dish("d_idli", "Idli Sambar", [{ propertyId: "p_kora", propertyName: "UNILIV Koramangala", qty: 14.4 }]),
        dish("d_chutney", "Chutney", [{ propertyId: "p_kora", propertyName: "UNILIV Koramangala", qty: 2.4 }]),
        dish("d_milk", "Hot Milk", [{ propertyId: "p_kora", propertyName: "UNILIV Koramangala", qty: 80 }]),
      ],
      new Map([["d_idli", IDLI_SAMBAR], ["d_chutney", CHUTNEY], ["d_milk", HOT_MILK]]),
      new Map([["p_kora", 80]]),
    );

    // Pinned against the same roll-up computed in SQL from the seed.
    expect(qtyOf(lines, "Chawal (Rice)")).toBe(4.8);
    expect(qtyOf(lines, "Mixed Vegetables")).toBe(3.2);
    expect(qtyOf(lines, "Tomato")).toBe(2.4);
    expect(qtyOf(lines, "Toor Dal")).toBe(2.4);
    expect(qtyOf(lines, "Urad Dal")).toBe(2.4);
    expect(qtyOf(lines, "Hara Dhaniya (Coriander)")).toBe(1.6);
    expect(qtyOf(lines, "Hari Mirch (Green Chilli)")).toBe(0.4);
    expect(qtyOf(lines, "Nariyal (Coconut)")).toBe(1.6);
    expect(qtyOf(lines, "Cheeni (Sugar)")).toBe(0.8);
    expect(qtyOf(lines, "Doodh (Milk)")).toBe(16);
    expect(lines).toHaveLength(10);
  });

  it("counts only the properties that ordered the dish, not the whole meal", () => {
    // Two properties in the meal, but only one ordered the chutney — the roll-up
    // must not bill the other property's heads to it.
    const lines = buildIngredientLines(
      [dish("d_chutney", "Chutney", [{ propertyId: "p_a", propertyName: "A", qty: 1 }])],
      new Map([["d_chutney", CHUTNEY]]),
      new Map([["p_a", 50], ["p_b", 200]]),
    );
    expect(qtyOf(lines, "Nariyal (Coconut)")).toBe(1); // 0.02 × 50, not × 250
  });

  it("sums a shared ingredient across dishes and keeps units apart", () => {
    const lines = buildIngredientLines(
      [
        dish("d1", "Dish One", [{ propertyId: "p", propertyName: "P", qty: 1 }]),
        dish("d2", "Dish Two", [{ propertyId: "p", propertyName: "P", qty: 1 }]),
      ],
      new Map([
        ["d1", [ing("Tomato", 0.03, "KG"), ing("Garam Masala", 3, "G")]],
        ["d2", [ing("Tomato", 0.02, "KG")]],
      ]),
      new Map([["p", 100]]),
    );
    // Tomato merges across both dishes; the gram-measured spice stays separate.
    expect(lines.find((l) => l.name === "Tomato")).toMatchObject({
      qty: 5, unit: "KG", dishes: ["Dish One", "Dish Two"],
    });
    expect(lines.find((l) => l.name === "Garam Masala")).toMatchObject({ qty: 300, unit: "G" });
  });

  it("skips dishes with no ingredient list, and properties with no head count", () => {
    const lines = buildIngredientLines(
      [
        dish("d_known", "Known", [{ propertyId: "p", propertyName: "P", qty: 1 }]),
        dish("d_unknown", "Unmapped", [{ propertyId: "p", propertyName: "P", qty: 1 }]),
        dish("d_ghost", "Ghost", [{ propertyId: "p_missing", propertyName: "Gone", qty: 1 }]),
      ],
      new Map([["d_known", [ing("Tomato", 0.03, "KG")]], ["d_ghost", [ing("Tomato", 99, "KG")]]]),
      new Map([["p", 10]]),
    );
    expect(lines).toEqual([{ name: "Tomato", qty: 0.3, unit: "KG", dishes: ["Known"] }]);
  });

  it("ignores null and non-positive rates rather than emitting zero rows", () => {
    const lines = buildIngredientLines(
      [dish("d", "D", [{ propertyId: "p", propertyName: "P", qty: 1 }])],
      new Map([[
        "d",
        [ing("Real", 0.5, "KG"), { ingredientId: "x", ingredientName: "NoQty", quantity: null, unit: "KG" } as DishIngredientRow],
      ]]),
      new Map([["p", 4]]),
    );
    expect(lines).toEqual([{ name: "Real", qty: 2, unit: "KG", dishes: ["D"] }]);
  });
});
