/**
 * Rule 2 — the per-ingredient daily limit, as a FLAG.
 *
 * It blocked saves once, and that was a deadlock. The check asked "is the day
 * legal AFTER this save?", so on a day already over the limit every step of a
 * fix was still over it:
 *
 *   remove the aloo dish from lunch (3 → 2)   → refused
 *   clear lunch entirely            (3 → 2)   → refused
 *   edit snacks, which had no aloo   (3 → 3)  → refused
 *
 * No edit reached a legal day, and on real data 54 days / 192 cells were
 * unreachable. The block is gone; the board and plate composer draw the warning
 * instead, and the numbers still live on the ingredients.
 *
 * INVARIANT: nothing on the save path reads this setting. The last describe
 * pins that — re-wiring it into a save guard, for symmetry with the
 * shared-ingredient block next door, would restore the deadlock exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingredientsTable, systemConfigTable, menuRuleOverrideTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { callRoute } from "./helpers/call-route.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_r: unknown, _s: unknown, n: () => void) => n(),
  authorize: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_r: unknown, _s: unknown, n: () => void) => n(),
  authorizeAny: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));

import * as foodService from "../food-service.js";
import { resolveMenuRuleSettings, isIngredientDayCapRuleOn } from "../food-service.js";
import { foodOpsRouter } from "../../routes/food-ops.js";

const KITCHEN = "k-1";
const USER = { id: "u-1", email: "u@x.com", role: "SUPER_ADMIN", propertyId: null };

const seedFlags = (flags: Record<string, boolean>) =>
  seedDb([[systemConfigTable, Object.entries(flags).map(([key, value]) => ({
    id: `cfg-${key}`, key, value, description: null, updatedAt: new Date(),
  }))]]);

const putRules = (body: unknown) =>
  callRoute(foodOpsRouter, { method: "PUT", url: "/system-config/menu-rules", user: USER, body });
const getRules = () =>
  callRoute(foodOpsRouter, { method: "GET", url: "/system-config/menu-rules", user: USER });

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

describe("the switch", () => {
  it("is OFF by default", async () => {
    expect(await isIngredientDayCapRuleOn()).toBe(false);
    expect((await resolveMenuRuleSettings()).flagIngredientDayCap).toBe(false);
  });

  it("turns on and off without disturbing its neighbours", async () => {
    expect((await putRules({ flagIngredientDayCap: true })).status).toBe(200);
    const s = await resolveMenuRuleSettings();
    expect(s).toMatchObject({
      flagIngredientDayCap: true,
      ingredientClashBlocks: true, flagRepeats: true, repeatWithinDays: 3,
      starDishRequired: false, flagSameWeekRepeats: false, flagSameWeekdayRepeats: false,
    });
  });

  it("reports on the read", async () => {
    seedFlags({ food_rule_ingredient_day_cap: true });
    expect((await getRules()).body.data).toMatchObject({ flagIngredientDayCap: true });
  });

  it("resolves a kitchen override in both directions", async () => {
    seedFlags({ food_rule_ingredient_day_cap: true });
    seedDb([[menuRuleOverrideTable, [{
      id: "o-1", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: null, flagSameWeekRepeats: null, flagSameWeekdayRepeats: null,
      flagIngredientDayCap: false, createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).flagIngredientDayCap).toBe(false);
    expect((await resolveMenuRuleSettings()).flagIngredientDayCap).toBe(true);
  });
});

describe("the limit is data, not code", () => {
  it("lives on the ingredient, where any ingredient can carry one", async () => {
    seedDb([[ingredientsTable, [
      { id: "i-aloo", name: "Aloo (Potato)", unit: "KG", maxPerDay: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "i-paneer", name: "Paneer", unit: "KG", maxPerDay: 2, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "i-oil", name: "Cooking Oil", unit: "LITRE", maxPerDay: null, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]]]);
    const { db } = await import("@workspace/db");
    const rows = await db.select().from(ingredientsTable);
    expect(rows.filter((r) => r.maxPerDay != null).map((r) => r.name).sort())
      .toEqual(["Aloo (Potato)", "Paneer"]);
  });
});

describe("flag-only — the deadlock must not come back", () => {
  /**
   * The enforcement helper is GONE, not merely unused. A dangling
   * `ingredientDayCapError` would be an invitation to re-wire it into a save
   * guard, which is precisely what deadlocked 192 cells.
   */
  it("exports no day-cap enforcement helper at all", () => {
    expect("ingredientDayCapError" in foodService).toBe(false);
  });

  it("the surviving save guards take dish ids and nothing else", async () => {
    seedFlags({ food_rule_ingredient_day_cap: true });
    expect((await resolveMenuRuleSettings()).flagIngredientDayCap).toBe(true);
    // No cell, no day, no rotation context — there is no channel through which a
    // per-DAY rule could reach a 422 from here.
    expect(foodService.ingredientClashError.length).toBe(1);
    expect(await foodService.ingredientClashError([])).toBeNull();
  });
});
