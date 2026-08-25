/**
 * Meal config resolves property-first, and the enabled filter comes LAST.
 *
 * INVARIANT: a `food_meal_config` row naming a property overrides the org-wide
 * (null-property) row for that meal at that property, and nowhere else. The
 * winning row supplies the label AND the ordering, so a property that overrides
 * a meal owns how it is named and where it sits in the day.
 *
 * The subtle half is the ORDER of the two operations. Filtering `is_enabled` in
 * SQL — which is what every one of these call sites used to do, back when the
 * table was an org-wide singleton and the filter was harmless — silently breaks
 * the override in both directions once property rows exist:
 *
 *   - org SNACKS disabled, property re-enables it: the disabled global row is
 *     filtered out before resolution, so the property's enabled row is all that
 *     remains and it happens to work — by luck, not design.
 *   - org SNACKS enabled, property disables it: the property's disabled row is
 *     filtered out FIRST, the global enabled row survives with nothing to
 *     override it, and the property is offered the meal it just switched off.
 *
 * That second case is the bug, and it is the one a reader is least likely to
 * spot, so it gets a test of its own below. Resolution first, filter after.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { foodMealConfigTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";

vi.hoisted(() => {
  // routes/food-ops.ts pulls in config/env.ts, which fails closed on a weak
  // secret outside development. Set one before the module graph loads.
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

import { loadMealConfigResolver, resolveMealConfig } from "../../routes/food-ops.js";

const BLR = "p-blr-1";
const DEL = "p-del-1";

const cfg = (
  mealType: string,
  propertyId: string | null,
  o: { label?: string; sortOrder?: number; isEnabled?: boolean } = {},
) => ({
  id: `mc-${mealType}-${propertyId ?? "global"}`,
  mealType,
  propertyId,
  displayLabel: o.label ?? mealType,
  brand: null,
  sortOrder: o.sortOrder ?? 0,
  isEnabled: o.isEnabled ?? true,
});

/** The org-wide set every property inherits until it says otherwise. */
const ORG = [
  cfg("BREAKFAST", null, { label: "Breakfast", sortOrder: 1 }),
  cfg("LUNCH", null, { label: "Lunch", sortOrder: 2 }),
  cfg("SNACKS", null, { label: "Snacks", sortOrder: 3 }),
  cfg("DINNER", null, { label: "Dinner", sortOrder: 4 }),
];

const labels = (rows: Array<{ displayLabel: string }>) => rows.map((r) => r.displayLabel);
const meals = (rows: Array<{ mealType: string }>) => rows.map((r) => r.mealType);

beforeEach(() => resetDb());

describe("resolveMealConfig — a property inherits until it overrides", () => {
  it("gives a property with no rows of its own the org-wide set", async () => {
    seedDb([[foodMealConfigTable, ORG]]);
    expect(labels(await resolveMealConfig(BLR))).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
  });

  it("prefers the property's row for the label", async () => {
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { label: "High Tea", sortOrder: 3 })]]]);
    expect(labels(await resolveMealConfig(BLR))).toEqual(["Breakfast", "Lunch", "High Tea", "Dinner"]);
  });

  it("takes the ordering from the winning row, not the org default", async () => {
    // The property serves its snacks before lunch; the org does not.
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { label: "High Tea", sortOrder: 0 })]]]);
    expect(meals(await resolveMealConfig(BLR))).toEqual(["SNACKS", "BREAKFAST", "LUNCH", "DINNER"]);
    // …and the org-wide view is untouched by that.
    expect(meals(await resolveMealConfig())).toEqual(["BREAKFAST", "LUNCH", "SNACKS", "DINNER"]);
  });

  it("does not leak one property's override to another", async () => {
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { label: "High Tea" })]]]);
    expect(labels(await resolveMealConfig(DEL))).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
  });

  it("ignores every override when no property is named", async () => {
    // Browsing a brand's menu directly: no site is in play, so no override can
    // apply — and a property's rows must not bleed into the org-wide answer.
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { label: "High Tea" })]]]);
    expect(labels(await resolveMealConfig())).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
    expect(labels(await resolveMealConfig(null))).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
  });
});

describe("resolveMealConfig — enabled is filtered AFTER resolution", () => {
  it("lets a property switch off a meal the org serves", async () => {
    // The regression guard. A SQL-level `is_enabled` filter drops the property's
    // disabled row first, leaving the enabled global row to win — and the
    // property is offered the meal it just switched off.
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { isEnabled: false })]]]);
    expect(meals(await resolveMealConfig(BLR))).toEqual(["BREAKFAST", "LUNCH", "DINNER"]);
    // Every other property still gets it.
    expect(meals(await resolveMealConfig(DEL))).toContain("SNACKS");
  });

  it("lets a property switch on a meal the org does not serve", async () => {
    const orgNoSnacks = ORG.map((r) => (r.mealType === "SNACKS" ? { ...r, isEnabled: false } : r));
    seedDb([[foodMealConfigTable, [...orgNoSnacks, cfg("SNACKS", BLR, { label: "High Tea", sortOrder: 3 })]]]);
    expect(labels(await resolveMealConfig(BLR))).toEqual(["Breakfast", "Lunch", "High Tea", "Dinner"]);
    expect(meals(await resolveMealConfig(DEL))).toEqual(["BREAKFAST", "LUNCH", "DINNER"]);
  });

  it("drops a meal the org disabled and nobody re-enabled", async () => {
    const orgNoSnacks = ORG.map((r) => (r.mealType === "SNACKS" ? { ...r, isEnabled: false } : r));
    seedDb([[foodMealConfigTable, orgNoSnacks]]);
    expect(meals(await resolveMealConfig(BLR))).toEqual(["BREAKFAST", "LUNCH", "DINNER"]);
  });
});

describe("loadMealConfigResolver — one read, resolved per property", () => {
  it("answers each property with its own set", async () => {
    seedDb([[foodMealConfigTable, [
      ...ORG,
      cfg("SNACKS", BLR, { label: "High Tea", sortOrder: 3 }),
      cfg("SNACKS", DEL, { isEnabled: false }),
    ]]]);
    const resolver = await loadMealConfigResolver([BLR, DEL]);
    expect(labels(resolver(BLR))).toEqual(["Breakfast", "Lunch", "High Tea", "Dinner"]);
    expect(meals(resolver(DEL))).toEqual(["BREAKFAST", "LUNCH", "DINNER"]);
  });

  it("matches resolveMealConfig for the same property", async () => {
    seedDb([[foodMealConfigTable, [...ORG, cfg("LUNCH", BLR, { label: "Thali", sortOrder: 0 })]]]);
    const resolver = await loadMealConfigResolver([BLR]);
    expect(resolver(BLR)).toEqual(await resolveMealConfig(BLR));
  });

  it("gives an unknown property the org-wide set rather than nothing", async () => {
    // The board is built from accessible properties; one that has never been
    // configured must still show the meals it actually serves.
    seedDb([[foodMealConfigTable, [...ORG, cfg("SNACKS", BLR, { label: "High Tea" })]]]);
    const resolver = await loadMealConfigResolver([BLR]);
    expect(labels(resolver("p-unconfigured"))).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
  });

  it("falls back to the org-wide set when the board has no properties", async () => {
    seedDb([[foodMealConfigTable, ORG]]);
    const resolver = await loadMealConfigResolver([]);
    expect(labels(resolver(BLR))).toEqual(["Breakfast", "Lunch", "Snacks", "Dinner"]);
  });
});
