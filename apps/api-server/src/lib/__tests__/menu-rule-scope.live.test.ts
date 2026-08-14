/**
 * Live round-trip for the property → kitchen → brand resolution chain.
 *
 * Opt-in: it writes to a real database, so `pnpm test` skips it and stays
 * hermetic. Everything it writes is namespaced with a fixed prefix and removed
 * in afterAll, including on failure.
 *
 *   set -a; . ./.env.api; set +a
 *   LIVE_DB_TESTS=1 pnpm --filter @workspace/api-server exec vitest run menu-rule-scope.live
 *
 * Gated on its OWN flag rather than on DATABASE_URL, because vitest.config.ts
 * injects a dummy connection string when none is set — so DATABASE_URL is never
 * absent here and could never gate anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LIVE = process.env["LIVE_DB_TESTS"] === "1";
const P = "test-menu-scope";

// Gated with a plain `if`, not describe.skipIf: vitest still runs a skipped
// suite's beforeAll, and this one connects to Postgres in its first line.
if (!LIVE) {
  describe.skip("scoped menu rules (live DB)", () => {
    it("needs LIVE_DB_TESTS=1", () => undefined);
  });
} else {
describe("scoped menu rules (live DB)", async () => {
  const { db, menuCompositionRuleTable, menuCompositionSlotTable, menuRuleOverrideTable, propertiesTable, kitchensTable } =
    await import("@workspace/db");
  const { resolveCompositionRule, resolveMenuRuleSettings } = await import("../food-service.js");
  const { eq, like } = await import("drizzle-orm");

  const kitchenId = `${P}-kitchen`;
  const propertyId = `${P}-property`;
  const brand = "UNILIV";

  /** Insert a rule at one scope with a single distinguishing slot count. */
  const seedRule = async (id: string, scope: { kitchenId?: string; propertyId?: string }, minCount: number) => {
    await db.insert(menuCompositionRuleTable).values({
      id, brand, mealType: "LUNCH" as never,
      kitchenId: scope.kitchenId ?? null, propertyId: scope.propertyId ?? null,
      name: id, isActive: true, updatedAt: new Date(),
    });
    await db.insert(menuCompositionSlotTable).values({
      id: `${id}-slot`, ruleId: id, slotLabel: "Sabzi", component: "SABZI" as never,
      preparation: null, minCount, maxCount: null, sortOrder: 0, updatedAt: new Date(),
    });
  };

  const cleanup = async () => {
    await db.delete(menuRuleOverrideTable).where(eq(menuRuleOverrideTable.propertyId, propertyId));
    await db.delete(menuRuleOverrideTable).where(eq(menuRuleOverrideTable.kitchenId, kitchenId));
    await db.delete(menuCompositionSlotTable).where(like(menuCompositionSlotTable.ruleId, `${P}%`));
    await db.delete(menuCompositionRuleTable).where(like(menuCompositionRuleTable.id, `${P}%`));
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));
    await db.delete(kitchensTable).where(eq(kitchensTable.id, kitchenId));
  };

  beforeAll(async () => {
    await cleanup();
    await db.insert(kitchensTable).values({
      id: kitchenId, name: `${P} kitchen`, code: `${P}-code`, updatedAt: new Date(),
    } as never);
    await db.insert(propertiesTable).values({
      id: propertyId, name: `${P} property`, code: `${P}-pcode`,
      // properties has a wide NOT NULL floor; these are filler, not fixtures.
      address: "n/a", city: "n/a", state: "n/a", pincode: "000000", totalBeds: 0,
      brand, kitchenId, updatedAt: new Date(),
    } as never);
    // minCount is the fingerprint: 1 = brand default, 2 = kitchen, 3 = property.
    await seedRule(`${P}-brand`, {}, 1);
    await seedRule(`${P}-kitchen-rule`, { kitchenId }, 2);
    await seedRule(`${P}-property-rule`, { propertyId }, 3);
  });

  afterAll(cleanup);

  const minCountFor = async (k: string | null, p: string | null) =>
    (await resolveCompositionRule(brand, "LUNCH", k, p))?.slots[0]?.minCount ?? null;

  it("resolves the property rule when a property is named", async () => {
    expect(await minCountFor(kitchenId, propertyId)).toBe(3);
  });

  it("falls back to the kitchen rule with no property", async () => {
    expect(await minCountFor(kitchenId, null)).toBe(2);
  });

  it("falls back to the brand default with no scope", async () => {
    expect(await minCountFor(null, null)).toBe(1);
  });

  it("does not apply one property's rule to a different property", async () => {
    // An unknown property inherits the kitchen/brand answer, never the private row.
    expect(await minCountFor(kitchenId, `${P}-other`)).toBe(2);
  });

  it("layers switch overrides property over kitchen over global", async () => {
    const base = await resolveMenuRuleSettings();

    await db.insert(menuRuleOverrideTable).values({
      id: `${P}-ov-kitchen`, kitchenId, propertyId: null,
      flagRepeats: false, ingredientClashBlocks: null, repeatWithinDays: 7, updatedAt: new Date(),
    });
    const atKitchen = await resolveMenuRuleSettings(kitchenId, null);
    expect(atKitchen.flagRepeats).toBe(false);
    expect(atKitchen.repeatWithinDays).toBe(7);
    // Null column = inherit, so the untouched switch still tracks the global value.
    expect(atKitchen.ingredientClashBlocks).toBe(base.ingredientClashBlocks);

    await db.insert(menuRuleOverrideTable).values({
      id: `${P}-ov-property`, propertyId, kitchenId: null,
      flagRepeats: true, ingredientClashBlocks: null, repeatWithinDays: null, updatedAt: new Date(),
    });
    const atProperty = await resolveMenuRuleSettings(kitchenId, propertyId);
    // Property wins where it speaks...
    expect(atProperty.flagRepeats).toBe(true);
    // ...and the kitchen still supplies what the property left null.
    expect(atProperty.repeatWithinDays).toBe(7);

    // The global answer is untouched by either override.
    expect(await resolveMenuRuleSettings()).toEqual(base);
  });

  it("clamps an out-of-range window stored by hand", async () => {
    await db.update(menuRuleOverrideTable)
      .set({ repeatWithinDays: 99 })
      .where(eq(menuRuleOverrideTable.kitchenId, kitchenId));
    expect((await resolveMenuRuleSettings(kitchenId, null)).repeatWithinDays).toBe(14);
  });
});
}
