import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { dishesTable, foodMenuRotationTable, perResidentRuleTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { computeOrderItems } from "../food-service.js";
import { logger } from "../logger.js";
import { atIst } from "../tz.js";

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

const KITCHEN = "K-BLR";
const BRAND = "UNILIV";
const MEAL = "LUNCH";
/** A Monday (ISO day 1) in IST — the seeded rotation cells are all dayOfWeek 1. */
const MONDAY = atIst("2026-08-10", "12:00");

/** A rotation cell: one dish on the plate, no seasonal window, week 1. */
const cell = (dishId: string, sortOrder = 0) => ({
  id: `rot-${dishId}`,
  kitchenId: KITCHEN,
  brand: BRAND,
  mealType: MEAL,
  dayOfWeek: 1,
  rotationWeek: 1,
  dishId,
  slotLabel: null,
  sortOrder,
  parentRotationId: null,
  effectiveFrom: null,
  effectiveTo: null,
  isActive: true,
});

const dish = (
  id: string,
  over: { unit?: string; isQtyLocked?: boolean; lockedPersons?: number | null } = {},
) => ({
  id,
  name: `Dish ${id}`,
  component: "SABZI",
  unit: "KG",
  preparations: [],
  isQtyLocked: false,
  lockedPersons: null,
  isActive: true,
  ...over,
});

/** qtyPerResident is `numeric` — node-postgres hands it back as a string. */
const rule = (dishId: string, qtyPerResident: string, unit = "KG") => ({
  id: `r-${dishId}`,
  brand: BRAND,
  mealType: MEAL,
  dishId,
  propertyId: null,
  qtyPerResident,
  unit,
  isActive: true,
});

/** The dropped-dish warning is asserted below; silenced everywhere else. */
let warn: MockInstance;

beforeEach(() => {
  resetDb();
  warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("computeOrderItems — quantity rounding", () => {
  it("rounds the cook quantity to three decimals, half up", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-rice")]],
      [dishesTable, [dish("d-rice")]],
      [perResidentRuleTable, [rule("d-rice", "0.1255")]],
    ]);
    // 37 × 0.1255 = 4.6435 — the half lands on the third decimal.
    const items = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 37);
    expect(items).toEqual([{ dishId: "d-rice", unit: "KG", orderedQty: 4.644, personsCount: 37 }]);
  });

  it("does not leak binary floating-point dust into the cook plan", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-dal")]],
      [dishesTable, [dish("d-dal")]],
      [perResidentRuleTable, [rule("d-dal", "0.1")]],
    ]);
    // 3 × 0.1 is 0.30000000000000004 in IEEE-754; the kitchen must be told 0.3.
    const [item] = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 3);
    expect(item!.orderedQty).toBe(0.3);
  });

  it("carries the rule's unit, not the dish's catalogue unit", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-curd")]],
      [dishesTable, [dish("d-curd", { unit: "KG" })]],
      [perResidentRuleTable, [rule("d-curd", "0.15", "LITRE")]],
    ]);
    const [item] = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 20);
    expect(item!.unit).toBe("LITRE");
    expect(item!.orderedQty).toBe(3);
  });

  it("a zero headcount orders zero rather than dropping the line", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-rice")]],
      [dishesTable, [dish("d-rice")]],
      [perResidentRuleTable, [rule("d-rice", "0.2")]],
    ]);
    expect(await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 0)).toEqual([
      { dishId: "d-rice", unit: "KG", orderedQty: 0, personsCount: 0 },
    ]);
  });
});

describe("computeOrderItems — dishes with no portion rule", () => {
  it("drops the unpriced dish and keeps every priced one", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-rice", 0), cell("d-pickle", 1), cell("d-dal", 2)]],
      [dishesTable, [dish("d-rice"), dish("d-pickle"), dish("d-dal")]],
      [perResidentRuleTable, [rule("d-rice", "0.2"), rule("d-dal", "0.1")]],
    ]);
    const items = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 10);
    expect(items.map((i) => i.dishId)).toEqual(["d-rice", "d-dal"]);
  });

  it("an INACTIVE rule is no rule — the dish is dropped, not priced at zero", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-pickle")]],
      [dishesTable, [dish("d-pickle")]],
      [perResidentRuleTable, [{ ...rule("d-pickle", "0.02"), isActive: false }]],
    ]);
    expect(await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 10)).toEqual([]);
  });

  it("records the drop — the property advertises a dish the kitchen is never told to cook", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-pickle")]],
      [dishesTable, [dish("d-pickle")]],
      [perResidentRuleTable, []],
    ]);
    await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0]![0] as { dishes: string[] }).dishes).toEqual(["Dish d-pickle"]);
  });

  it("stays quiet when every dish on the plate is priced", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-rice")]],
      [dishesTable, [dish("d-rice")]],
      [perResidentRuleTable, [rule("d-rice", "0.2")]],
    ]);
    await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 10);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns [] with no kitchen — menus are defined per kitchen", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-rice")]],
      [dishesTable, [dish("d-rice")]],
      [perResidentRuleTable, [rule("d-rice", "0.2")]],
    ]);
    expect(await computeOrderItems(null, BRAND, MEAL, MONDAY, 10)).toEqual([]);
  });
});

/**
 * A quantity-locked dish is ordered for its own pinned headcount, never the
 * meal's. `personsCount` on the LINE is what callers must persist — persisting
 * the order-wide headcount instead loses the pin the moment the row is inserted,
 * and the next recompute silently multiplies the whole property by the rule.
 */
describe("computeOrderItems — isQtyLocked overrides the meal headcount", () => {
  it("prices a locked dish for lockedPersons and reports that count on the line", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-sweet")]],
      [dishesTable, [dish("d-sweet", { isQtyLocked: true, lockedPersons: 5 })]],
      [perResidentRuleTable, [rule("d-sweet", "0.05")]],
    ]);
    expect(await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 200)).toEqual([
      { dishId: "d-sweet", unit: "KG", orderedQty: 0.25, personsCount: 5 },
    ]);
  });

  it("locks only the locked dish — the rest of the plate still follows the headcount", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-sweet", 0), cell("d-rice", 1)]],
      [
        dishesTable,
        [dish("d-sweet", { isQtyLocked: true, lockedPersons: 5 }), dish("d-rice")],
      ],
      [perResidentRuleTable, [rule("d-sweet", "0.05"), rule("d-rice", "0.2")]],
    ]);
    const items = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 100);
    expect(items).toEqual([
      { dishId: "d-sweet", unit: "KG", orderedQty: 0.25, personsCount: 5 },
      { dishId: "d-rice", unit: "KG", orderedQty: 20, personsCount: 100 },
    ]);
  });

  it("a lock with no pinned count falls back to the headcount rather than to zero", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-sweet")]],
      [dishesTable, [dish("d-sweet", { isQtyLocked: true, lockedPersons: null })]],
      [perResidentRuleTable, [rule("d-sweet", "0.05")]],
    ]);
    expect(await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 40)).toEqual([
      { dishId: "d-sweet", unit: "KG", orderedQty: 2, personsCount: 40 },
    ]);
  });

  it("lockedPersons is honoured when it is LARGER than the meal headcount", async () => {
    seedDb([
      [foodMenuRotationTable, [cell("d-sweet")]],
      [dishesTable, [dish("d-sweet", { isQtyLocked: true, lockedPersons: 50 })]],
      [perResidentRuleTable, [rule("d-sweet", "0.1")]],
    ]);
    const [item] = await computeOrderItems(KITCHEN, BRAND, MEAL, MONDAY, 4);
    expect(item).toEqual({ dishId: "d-sweet", unit: "KG", orderedQty: 5, personsCount: 50 });
  });
});
