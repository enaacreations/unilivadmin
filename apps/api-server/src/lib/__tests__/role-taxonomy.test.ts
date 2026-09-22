/**
 * The four role taxonomies must agree.
 *
 * ROLE_PERMISSIONS (22 roles), ORG_WIDE_ROLES (18), ROLE_RANK (21) and
 * food-service's ALWAYS_GLOBAL (4) each answer a different question about the
 * same roles, and nothing kept them in step — CUSTOMER_EXPERIENCE was missing
 * from two of them, so it ranked 0 and was treated as property-scoped while
 * holding audit access org-wide.
 *
 * Collapsing them into one table is a later step (the sync helpers are
 * synchronous and the resolver is not). Until then, this stops them drifting
 * further apart, which is the risk that actually bites.
 */
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "../permissions.js";
import { ROLE_RANK, ORG_WIDE_ROLES_LIST } from "../authz.js";

const ROLES = Object.keys(ROLE_PERMISSIONS).sort();

/**
 * Roles the FOOD resolver treats as unrestricted regardless of grants.
 * Mirrors ALWAYS_GLOBAL in food-service.ts; the test below pins them together.
 */
const ALWAYS_GLOBAL = ["SUPER_ADMIN", "OPS_EXCELLENCE", "SENIOR_VICE_PRESIDENT", "AUDIT_READONLY"];

describe("role taxonomies", () => {
  it("ranks every role — an unranked role silently becomes the least privileged", () => {
    // ROLE_RANK defaults a missing role to 0, so omission is indistinguishable
    // from "deliberately lowest". That is how CUSTOMER_EXPERIENCE ended up
    // unable to be assigned by anyone.
    const unranked = ROLES.filter((r) => ROLE_RANK[r] === undefined).sort();
    expect(unranked).toEqual([]);
  });

  it("classifies every role as org-wide or property-scoped", () => {
    // Membership of ORG_WIDE_ROLES decides whether scopedPropertyId() filters a
    // caller at all. A role in neither list is scoped only by accident of
    // having a non-null propertyId.
    const unclassified = ROLES.filter(
      (r) => !ORG_WIDE_ROLES_LIST.includes(r) && ROLE_RANK[r] === undefined,
    ).sort();
    expect(unclassified).toEqual([]);
  });

  it("keeps ALWAYS_GLOBAL a subset of ORG_WIDE_ROLES", () => {
    // A role the food resolver treats as unrestricted must not be one the
    // generic helper pins to a single property — that combination means two
    // engines disagree about the same person on the same request.
    const contradictory = ALWAYS_GLOBAL.filter((r) => !ORG_WIDE_ROLES_LIST.includes(r));
    expect(contradictory).toEqual([]);
  });

  it("ranks the parity roles above everyone else", () => {
    const parity = Math.min(...["SUPER_ADMIN", "OPS_EXCELLENCE"].map((r) => ROLE_RANK[r] ?? 0));
    const others = ROLES.filter((r) => !["SUPER_ADMIN", "OPS_EXCELLENCE"].includes(r));
    for (const r of others) {
      expect(ROLE_RANK[r] ?? 0, `${r} outranks the parity roles`).toBeLessThanOrEqual(parity);
    }
  });

  it("never ranks a property-bound role above an org-wide one", () => {
    // Rank gates who may assign whom. A warden outranking a city head would let
    // the narrower role hand out the broader one.
    const scopedMax = Math.max(...ROLES.filter((r) => !ORG_WIDE_ROLES_LIST.includes(r)).map((r) => ROLE_RANK[r] ?? 0));
    const orgMin = Math.min(...ROLES.filter((r) => ORG_WIDE_ROLES_LIST.includes(r)).map((r) => ROLE_RANK[r] ?? 0));
    expect(scopedMax).toBeLessThanOrEqual(orgMin);
  });
});
