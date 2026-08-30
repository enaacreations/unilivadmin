/**
 * The star-dish menu rule: the switch, the slot it synthesises, and the refusal.
 *
 * Two invariants that the pure-function tests in food-star-dish.test.ts cannot
 * reach, because both are about where the slot COMES FROM:
 *
 *  1. The star slot is synthesised at resolve time, never stored. Materialising
 *     it into every composition rule when the switch flips would mean a rule
 *     created afterwards silently lacks it — "star dish required" would quietly
 *     not apply there — and turning the switch off would leave orphan slots
 *     behind. So: it appears on every meal while the switch is on, including on
 *     meals with no composition rule of their own, and vanishes when it is off.
 *
 *  2. The switch cannot be turned on while the catalogue holds no star dish.
 *     That state is unrecoverable from the screen the switch is on — every plate
 *     becomes invalid at once and the fix lives in the dish catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dishesTable, systemConfigTable, menuCompositionRuleTable, menuCompositionSlotTable,
  menuRuleOverrideTable,
} from "@workspace/db";
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
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { resolveCompositionRule, resolveRuleForValidation, resolveMenuRuleSettings } from "../food-service.js";
import { foodOpsRouter } from "../../routes/food-ops.js";

const BRAND = "UNILIV";
const KITCHEN = "k-1";
const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

/** Turn the star rule on/off at org level, as the PUT handler stores it. */
const seedSwitch = (on: boolean) =>
  seedDb([[systemConfigTable, [{
    id: "cfg-star", key: "food_rule_star_dish_required", value: on,
    description: null, updatedAt: new Date("2026-01-01T00:00:00Z"),
  }]]]);

const seedStarDish = (isStarDish = true, isActive = true) =>
  seedDb([[dishesTable, [{
    id: "d-star", name: "Paneer Tikka", component: "SABZI", unit: "KG",
    brands: [BRAND], preparations: ["VEG"], photoUrl: null,
    isQtyLocked: false, lockedPersons: null, isStarDish, isActive,
    createdAt: new Date(), updatedAt: new Date(),
  }]]]);

/** A brand-wide LUNCH rule with a single stored SABZI slot. */
const seedRule = () => {
  seedDb([[menuCompositionRuleTable, [{
    id: "r-1", brand: BRAND, mealType: "LUNCH", kitchenId: null, propertyId: null,
    name: "Lunch", isActive: true, createdAt: new Date(), updatedAt: new Date(),
  }]]]);
  seedDb([[menuCompositionSlotTable, [{
    id: "s-1", ruleId: "r-1", slotLabel: null, component: "SABZI", preparation: null,
    isStar: false, minCount: 1, maxCount: 2, sortOrder: 0,
    createdAt: new Date(), updatedAt: new Date(),
  }]]]);
};

const putRules = (body: unknown) =>
  callRoute(foodOpsRouter, { method: "PUT", url: "/system-config/menu-rules", user: USER, body });

const getRules = () =>
  callRoute(foodOpsRouter, { method: "GET", url: "/system-config/menu-rules", user: USER });

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

describe("the synthesised star slot", () => {
  it("is absent while the switch is off", async () => {
    seedRule();
    const rule = await resolveCompositionRule(BRAND, "LUNCH", null);
    expect(rule!.slots.map((s) => s.component)).toEqual(["SABZI"]);
    expect(rule!.slots.some((s) => s.isStar)).toBe(false);
  });

  it("appears on an existing rule when the switch is on, leading the plate", async () => {
    seedRule();
    seedSwitch(true);
    const rule = await resolveCompositionRule(BRAND, "LUNCH", null);
    expect(rule!.slots[0]).toMatchObject({ isStar: true, minCount: 1, maxCount: 1, sortOrder: -1 });
    // The stored slot is untouched beside it.
    expect(rule!.slots.filter((s) => !s.isStar).map((s) => s.component)).toEqual(["SABZI"]);
  });

  it("is not persisted — the slot table still holds only the stored slot", async () => {
    seedRule();
    seedSwitch(true);
    await resolveCompositionRule(BRAND, "LUNCH", null);
    const rows = await (await import("@workspace/db")).db.select().from(menuCompositionSlotTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isStar).toBe(false);
  });

  /* "Star dish should be for every meal" — including the meals nobody has
   * written a composition rule for. resolveCompositionRule answers null there
   * and validateMenuAgainstRule treats null as "nothing to check", so without
   * resolveRuleForValidation this is the one meal the rule would not reach. */
  it("still applies to a meal with NO composition rule at all", async () => {
    seedSwitch(true);
    expect(await resolveCompositionRule(BRAND, "DINNER", null)).toBeNull();
    const forValidation = await resolveRuleForValidation(BRAND, "DINNER", null);
    expect(forValidation!.slots).toHaveLength(1);
    expect(forValidation!.slots[0]!.isStar).toBe(true);
  });

  it("leaves a ruleless meal unconstrained when the switch is off", async () => {
    expect(await resolveRuleForValidation(BRAND, "DINNER", null)).toBeNull();
  });

  it("honours a kitchen override that turns the rule off", async () => {
    seedRule();
    seedSwitch(true);
    seedDb([[menuRuleOverrideTable, [{
      id: "o-1", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: false, createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).starDishRequired).toBe(false);
    const rule = await resolveCompositionRule(BRAND, "LUNCH", KITCHEN);
    expect(rule!.slots.some((s) => s.isStar)).toBe(false);
  });
});

describe("PUT /system-config/menu-rules — the star switch", () => {
  it("refuses to turn on with no star dish, naming the reason", async () => {
    seedStarDish(false); // a dish exists, but it is not starred
    const res = await putRules({ starDishRequired: true });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: "NO_STAR_DISH" });
    // And the switch really is still off — not merely reported as refused.
    expect((await resolveMenuRuleSettings()).starDishRequired).toBe(false);
  });

  it("refuses when the only star dish is retired", async () => {
    seedStarDish(true, false);
    expect((await putRules({ starDishRequired: true })).status).toBe(422);
  });

  it("turns on once a star dish exists", async () => {
    seedStarDish();
    const res = await putRules({ starDishRequired: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ starDishRequired: true, hasStarDish: true });
    expect((await resolveMenuRuleSettings()).starDishRequired).toBe(true);
  });

  /* Turning it OFF must never be gated on the catalogue — otherwise deleting the
   * last star dish would trap the rule on with no way back. */
  it("can always be turned off, even with no star dish left", async () => {
    seedStarDish();
    await putRules({ starDishRequired: true });
    resetDb();
    seedSwitch(true);
    const res = await putRules({ starDishRequired: false });
    expect(res.status).toBe(200);
    expect((await resolveMenuRuleSettings()).starDishRequired).toBe(false);
  });

  it("applies the same refusal to a kitchen-scoped override", async () => {
    const res = await putRules({ starDishRequired: true, kitchenId: KITCHEN });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: "NO_STAR_DISH" });
  });

  it("reports hasStarDish on the read, so the editor can explain itself", async () => {
    expect((await getRules()).body.data).toMatchObject({ starDishRequired: false, hasStarDish: false });
    seedStarDish();
    expect((await getRules()).body.data.hasStarDish).toBe(true);
  });
});
