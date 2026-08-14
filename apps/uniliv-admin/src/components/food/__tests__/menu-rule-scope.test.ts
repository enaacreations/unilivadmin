/**
 * Scope precedence for menu composition rules.
 *
 * This is the half of the contract the client owns: `ruleFor` MUST pick the
 * same rule `resolveCompositionRule` picks server-side, or the rotation board
 * grades a plate against one rule while the server saves it against another.
 * Before property scoping existed this file's first case failed — the client
 * preferred the brand default over a kitchen rule, the exact inverse of the
 * server. Keep the two in step.
 */
import { describe, expect, it } from "vitest";
import { ruleFor, scopeRank } from "../menu-lib";
import type { CompositionRule } from "@/lib/food-api";

const rule = (over: Partial<CompositionRule> = {}): CompositionRule => ({
  id: "r-brand",
  brand: "UNILIV",
  mealType: "LUNCH",
  kitchenId: null,
  propertyId: null,
  name: null,
  isActive: true,
  slots: [],
  ...over,
});

const BRAND = rule();
const KITCHEN = rule({ id: "r-kitchen", kitchenId: "k1" });
const PROPERTY = rule({ id: "r-property", propertyId: "p1" });

const pick = (rules: CompositionRule[], kitchenId?: string | null, propertyId?: string | null) =>
  ruleFor(rules, "UNILIV", "LUNCH", kitchenId, propertyId)?.id ?? null;

describe("scopeRank", () => {
  it("ranks property above kitchen above the brand default", () => {
    expect(scopeRank(PROPERTY, "k1", "p1")).toBeGreaterThan(scopeRank(KITCHEN, "k1", "p1"));
    expect(scopeRank(KITCHEN, "k1", "p1")).toBeGreaterThan(scopeRank(BRAND, "k1", "p1"));
  });

  it("does not credit a scope the caller did not ask for", () => {
    // Same row, no property in play — it cannot outrank the brand default.
    expect(scopeRank(PROPERTY, "k1", null)).toBe(scopeRank(BRAND, "k1", null));
  });
});

describe("ruleFor", () => {
  it("prefers a kitchen rule over the brand default", () => {
    expect(pick([BRAND, KITCHEN], "k1")).toBe("r-kitchen");
    // Order in the array must not decide it.
    expect(pick([KITCHEN, BRAND], "k1")).toBe("r-kitchen");
  });

  it("prefers a property rule over both", () => {
    expect(pick([BRAND, KITCHEN, PROPERTY], "k1", "p1")).toBe("r-property");
  });

  it("falls back to the brand default when the scope has no rule of its own", () => {
    expect(pick([BRAND], "k1", "p1")).toBe("r-brand");
    expect(pick([BRAND, KITCHEN], null, null)).toBe("r-brand");
  });

  it("never leaks another scope's rule", () => {
    // p2's lunch is governed by the brand default, NOT by p1's private rule —
    // picking r-property here would silently apply one property's spec to another.
    expect(pick([BRAND, PROPERTY], null, "p2")).toBe("r-brand");
    expect(pick([BRAND, KITCHEN], "k2", null)).toBe("r-brand");
    // With nothing applicable at all, there is no rule rather than a wrong one.
    expect(pick([PROPERTY], null, "p2")).toBeNull();
    expect(pick([KITCHEN], "k2", null)).toBeNull();
  });

  it("ignores inactive rules", () => {
    expect(pick([BRAND, { ...PROPERTY, isActive: false }], null, "p1")).toBe("r-brand");
  });

  it("does not cross brands or meals", () => {
    expect(ruleFor([rule({ brand: "HUDDLE" })], "UNILIV", "LUNCH")).toBeNull();
    expect(ruleFor([rule({ mealType: "DINNER" })], "UNILIV", "LUNCH")).toBeNull();
  });
});
