/**
 * Rule 2 — "aloo dishes can be served only once per day".
 *
 * INVARIANT: this rule counts across the WHOLE DAY. That is the only thing
 * separating it from the shared-ingredient rule sitting next to it, which asks
 * the same question about a single plate. Aloo at lunch AND aloo at dinner is
 * precisely the case rule 2 exists for, and no per-plate check can see it — so
 * the first describe below is about meals OTHER than the one being written.
 *
 * The limit is per ingredient (`ingredients.max_per_day`), never hardcoded and
 * never one global figure: "at most one aloo dish a day" is a real kitchen rule,
 * "at most one dish containing cooking oil" is not, and in this catalogue oil is
 * on 21 of 58 dishes. A single org-wide cap would make almost every day
 * unsatisfiable, which is why the number lives on the ingredient.
 *
 * Nothing is capped by default, so an existing catalogue is unaffected until
 * someone sets a number AND switches the rule on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingredientsTable, dishesTable, dishIngredientsTable, foodMenuRotationTable,
  systemConfigTable, menuRuleOverrideTable,
} from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

import { ingredientDayCapError, resolveMenuRuleSettings } from "../food-service.js";

const KITCHEN = "k-1";
const BRAND = "UNILIV";
const CELL = { kitchenId: KITCHEN, brand: BRAND, rotationWeek: 1, dayOfWeek: 1, mealType: "LUNCH" };

const on = (extra: Record<string, boolean> = {}) =>
  seedDb([[systemConfigTable, Object.entries({ food_rule_ingredient_day_cap: true, ...extra })
    .map(([key, value]) => ({ id: `cfg-${key}`, key, value, description: null, updatedAt: new Date() }))]]);

/** ingredients: [id, name, maxPerDay | null] */
const seedIngredients = (rows: Array<[string, string, number | null]>) =>
  seedDb([[ingredientsTable, rows.map(([id, name, maxPerDay]) => ({
    id, name, unit: "KG", maxPerDay, isActive: true, createdAt: new Date(), updatedAt: new Date(),
  }))]]);

/** dishes: [id, name] plus their ingredient ids */
const seedDishes = (rows: Array<[string, string, string[]]>) => {
  seedDb([[dishesTable, rows.map(([id, name]) => ({
    id, name, component: "SABZI", unit: "KG", brands: [BRAND], preparations: ["VEG"],
    photoUrl: null, isQtyLocked: false, lockedPersons: null, isStarDish: false,
    isActive: true, createdAt: new Date(), updatedAt: new Date(),
  }))]]);
  seedDb([[dishIngredientsTable, rows.flatMap(([id, , ings]) =>
    ings.map((ingredientId) => ({
      id: `${id}-${ingredientId}`, dishId: id, ingredientId,
      quantity: null, unit: null, createdAt: new Date(), updatedAt: new Date(),
    })))]]);
};

/** Put dishes on a meal of the same day as CELL. */
const seedRotation = (mealType: string, dishIds: string[], dayOfWeek = 1, rotationWeek = 1) =>
  seedDb([[foodMenuRotationTable, dishIds.map((dishId, i) => ({
    id: `rot-${mealType}-${dishId}`, kitchenId: KITCHEN, brand: BRAND,
    rotationWeek, dayOfWeek, mealType, dishId, slotLabel: null, sortOrder: i,
    parentRotationId: null, effectiveFrom: null, effectiveTo: null,
    createdAt: new Date(), updatedAt: new Date(),
  }))]]);

/** The standard fixture: aloo capped at 1/day, two aloo dishes and one without. */
const standard = () => {
  seedIngredients([["i-aloo", "Aloo (Potato)", 1], ["i-oil", "Cooking Oil", null]]);
  seedDishes([
    ["d-gobi", "Aloo Gobi", ["i-aloo", "i-oil"]],
    ["d-methi", "Aloo Methi", ["i-aloo", "i-oil"]],
    ["d-dal", "Dal Tadka", ["i-oil"]],
  ]);
};

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

describe("counting across the whole day", () => {
  it("catches aloo at lunch AND aloo at dinner — what a per-plate rule cannot", () => {
    on(); standard();
    seedRotation("DINNER", ["d-methi"]);
    return expect(ingredientDayCapError(CELL, ["d-gobi"])).resolves.toMatchObject({
      details: { ingredientDayCap: [expect.objectContaining({ name: "Aloo (Potato)", count: 2, maxPerDay: 1 })] },
    });
  });

  it("allows one aloo dish on the day", async () => {
    on(); standard();
    seedRotation("DINNER", ["d-dal"]);
    expect(await ingredientDayCapError(CELL, ["d-gobi"])).toBeNull();
  });

  it("ignores the SAME meal's stored rows — the write replaces them", async () => {
    on(); standard();
    // Lunch already holds an aloo dish, but this write is replacing lunch, so
    // the stored row is about to vanish and must not be counted against itself.
    seedRotation("LUNCH", ["d-methi"]);
    expect(await ingredientDayCapError(CELL, ["d-gobi"])).toBeNull();
  });

  it("ignores other DAYS", async () => {
    on(); standard();
    seedRotation("DINNER", ["d-methi"], 2); // Tuesday
    expect(await ingredientDayCapError(CELL, ["d-gobi"])).toBeNull();
  });

  it("ignores other rotation WEEKS", async () => {
    on(); standard();
    seedRotation("DINNER", ["d-methi"], 1, 3);
    expect(await ingredientDayCapError(CELL, ["d-gobi"])).toBeNull();
  });

  it("catches two capped dishes inside the incoming plate alone", async () => {
    on(); standard();
    const err = await ingredientDayCapError(CELL, ["d-gobi", "d-methi"]);
    expect(err).not.toBeNull();
    expect(err!.error).toContain("Aloo");
  });

  /* `alsoCounting` is how the bulk importer makes sibling meals of one import
   * visible to each other before anything is written. */
  it("counts dishes the caller has approved but not yet written", async () => {
    on(); standard();
    expect(await ingredientDayCapError(CELL, ["d-gobi"])).toBeNull();
    expect(await ingredientDayCapError(CELL, ["d-gobi"], ["d-methi"])).not.toBeNull();
  });
});

describe("the limit is data, not code", () => {
  it("does nothing when no ingredient carries a limit", async () => {
    on();
    seedIngredients([["i-aloo", "Aloo (Potato)", null]]);
    seedDishes([["d-gobi", "Aloo Gobi", ["i-aloo"]], ["d-methi", "Aloo Methi", ["i-aloo"]]]);
    expect(await ingredientDayCapError(CELL, ["d-gobi", "d-methi"])).toBeNull();
  });

  it("honours a limit above 1", async () => {
    on();
    seedIngredients([["i-aloo", "Aloo (Potato)", 2]]);
    seedDishes([
      ["d-gobi", "Aloo Gobi", ["i-aloo"]],
      ["d-methi", "Aloo Methi", ["i-aloo"]],
      ["d-jeera", "Jeera Aloo", ["i-aloo"]],
    ]);
    expect(await ingredientDayCapError(CELL, ["d-gobi", "d-methi"])).toBeNull();
    expect(await ingredientDayCapError(CELL, ["d-gobi", "d-methi", "d-jeera"])).not.toBeNull();
  });

  it("applies to any ingredient, not a hardcoded one", async () => {
    on();
    seedIngredients([["i-paneer", "Paneer", 1]]);
    seedDishes([["d-pbm", "Paneer Butter Masala", ["i-paneer"]], ["d-pt", "Paneer Tikka", ["i-paneer"]]]);
    const err = await ingredientDayCapError(CELL, ["d-pbm", "d-pt"]);
    expect(err!.error).toContain("Paneer");
  });

  it("caps each ingredient by its OWN number", async () => {
    on();
    seedIngredients([["i-aloo", "Aloo (Potato)", 1], ["i-oil", "Cooking Oil", 5]]);
    seedDishes([["a", "A", ["i-aloo", "i-oil"]], ["b", "B", ["i-oil"]], ["c", "C", ["i-oil"]]]);
    // Three oil dishes is under oil's limit of 5, and only one carries aloo.
    expect(await ingredientDayCapError(CELL, ["a", "b", "c"])).toBeNull();
  });

  it("names every breached ingredient, not just the first", async () => {
    on();
    seedIngredients([["i-aloo", "Aloo (Potato)", 1], ["i-oil", "Cooking Oil", 1]]);
    seedDishes([["a", "A", ["i-aloo", "i-oil"]], ["b", "B", ["i-aloo", "i-oil"]]]);
    const err = await ingredientDayCapError(CELL, ["a", "b"]);
    expect(err!.details["ingredientDayCap"]).toHaveLength(2);
  });
});

describe("the switch", () => {
  it("is OFF by default, so a capped ingredient still passes", async () => {
    standard(); // no `on()`
    expect((await resolveMenuRuleSettings()).ingredientDayCapBlocks).toBe(false);
    expect(await ingredientDayCapError(CELL, ["d-gobi", "d-methi"])).toBeNull();
  });

  it("blocks once switched on", async () => {
    on(); standard();
    expect(await ingredientDayCapError(CELL, ["d-gobi", "d-methi"])).not.toBeNull();
  });

  it("resolves a kitchen override that turns it off", async () => {
    on();
    seedDb([[menuRuleOverrideTable, [{
      id: "o-1", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: null, flagSameWeekRepeats: null, flagSameWeekdayRepeats: null,
      ingredientDayCapBlocks: false, createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).ingredientDayCapBlocks).toBe(false);
    expect((await resolveMenuRuleSettings()).ingredientDayCapBlocks).toBe(true);
  });
});
