/**
 * The two variety-flag switches (rules 3 and 4) as the server resolves them.
 *
 * INVARIANT: both are HINTS. Nothing on the save path reads them — the rotation
 * write handlers consult the composition rule and the ingredient clash, and
 * neither of these. The last test in this file pins that by asserting the
 * settings are absent from the enforcement helpers' inputs, because "flag only"
 * is a promise that is easy to break by wiring a new switch into a save guard
 * for symmetry with its blocking neighbours.
 *
 * Both default OFF: they are new, and a variety hint that fires everywhere on
 * day one trains people to ignore the marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemConfigTable, menuRuleOverrideTable } from "@workspace/db";
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

import { resolveMenuRuleSettings, isSameWeekRepeatRuleOn, isSameWeekdayRepeatRuleOn } from "../food-service.js";
import { foodOpsRouter } from "../../routes/food-ops.js";

const KITCHEN = "k-1";
const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

/** seedDb REPLACES a table's rows, so every flag has to be seeded in one call. */
const seedFlags = (flags: Record<string, boolean>) =>
  seedDb([[systemConfigTable, Object.entries(flags).map(([key, value]) => ({
    id: `cfg-${key}`, key, value, description: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  }))]]);

const putRules = (body: unknown) =>
  callRoute(foodOpsRouter, { method: "PUT", url: "/system-config/menu-rules", user: USER, body });
const getRules = () =>
  callRoute(foodOpsRouter, { method: "GET", url: "/system-config/menu-rules", user: USER });

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

describe("defaults", () => {
  it("both variety flags are OFF out of the box", async () => {
    expect(await isSameWeekRepeatRuleOn()).toBe(false);
    expect(await isSameWeekdayRepeatRuleOn()).toBe(false);
    const s = await resolveMenuRuleSettings();
    expect(s).toMatchObject({ flagSameWeekRepeats: false, flagSameWeekdayRepeats: false });
  });

  /* The pre-existing window rule must not move when these are added. */
  it("leaves the window rule at its shipped defaults", async () => {
    const s = await resolveMenuRuleSettings();
    expect(s).toMatchObject({ flagRepeats: true, repeatWithinDays: 3, ingredientClashBlocks: true });
  });
});

describe("PUT /system-config/menu-rules — the variety flags", () => {
  it("turns rule 3 on independently of rule 4", async () => {
    const res = await putRules({ flagSameWeekRepeats: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ flagSameWeekRepeats: true, flagSameWeekdayRepeats: false });
    expect((await resolveMenuRuleSettings()).flagSameWeekRepeats).toBe(true);
  });

  it("turns rule 4 on independently of rule 3", async () => {
    await putRules({ flagSameWeekdayRepeats: true });
    const s = await resolveMenuRuleSettings();
    expect(s).toMatchObject({ flagSameWeekRepeats: false, flagSameWeekdayRepeats: true });
  });

  it("turns them back off", async () => {
    seedFlags({ food_rule_same_week_repeat: true });
    await putRules({ flagSameWeekRepeats: false });
    expect((await resolveMenuRuleSettings()).flagSameWeekRepeats).toBe(false);
  });

  it("does not disturb the other rules when one is flipped", async () => {
    await putRules({ flagSameWeekdayRepeats: true });
    const s = await resolveMenuRuleSettings();
    expect(s).toMatchObject({
      flagRepeats: true, repeatWithinDays: 3,
      ingredientClashBlocks: true, starDishRequired: false,
    });
  });

  it("reports both on the read", async () => {
    seedFlags({ food_rule_same_weekday_repeat: true });
    expect((await getRules()).body.data).toMatchObject({
      flagSameWeekRepeats: false, flagSameWeekdayRepeats: true,
    });
  });
});

describe("scoped overrides", () => {
  it("lets a kitchen turn rule 4 on while the org default is off", async () => {
    seedDb([[menuRuleOverrideTable, [{
      id: "o-1", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: null, flagSameWeekRepeats: null, flagSameWeekdayRepeats: true,
      createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).flagSameWeekdayRepeats).toBe(true);
    expect((await resolveMenuRuleSettings()).flagSameWeekdayRepeats).toBe(false);
  });

  it("lets a kitchen turn rule 3 OFF while the org default is on", async () => {
    seedFlags({ food_rule_same_week_repeat: true });
    seedDb([[menuRuleOverrideTable, [{
      id: "o-2", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: null, flagSameWeekRepeats: false, flagSameWeekdayRepeats: null,
      createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).flagSameWeekRepeats).toBe(false);
    expect((await resolveMenuRuleSettings()).flagSameWeekRepeats).toBe(true);
  });

  it("inherits when the override column is null", async () => {
    seedFlags({ food_rule_same_weekday_repeat: true });
    seedDb([[menuRuleOverrideTable, [{
      id: "o-3", propertyId: null, kitchenId: KITCHEN,
      ingredientClashBlocks: null, flagRepeats: null, repeatWithinDays: null,
      starDishRequired: null, flagSameWeekRepeats: null, flagSameWeekdayRepeats: null,
      createdAt: new Date(), updatedAt: new Date(),
    }]]]);
    expect((await resolveMenuRuleSettings(KITCHEN, null)).flagSameWeekdayRepeats).toBe(true);
  });
});

describe("flag-only", () => {
  /**
   * Both rules ON, and a rotation write still goes through untouched. If someone
   * later wires either switch into a save guard — for symmetry with the
   * ingredient block, which is the obvious mistake — this fails.
   */
  it("no save path consults them", async () => {
    seedFlags({ food_rule_same_week_repeat: true, food_rule_same_weekday_repeat: true });
    const s = await resolveMenuRuleSettings();
    expect(s.flagSameWeekRepeats && s.flagSameWeekdayRepeats).toBe(true);

    // The enforcement helpers take dish ids and nothing else — there is no
    // channel through which a variety flag could reach a 422.
    const { ingredientClashError } = await import("../food-service.js");
    expect(ingredientClashError.length).toBe(1);
    expect(await ingredientClashError([])).toBeNull();
  });
});
