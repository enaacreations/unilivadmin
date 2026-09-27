import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, can, type UserRole } from "../permissions.js";

/**
 * FOOD_CATALOGUE splits the definitional half of Service Set — ingredients,
 * dishes and the menu-composition rules — away from FOOD_SETTINGS, so a role
 * can build the rotation from an agreed catalogue without editing it.
 *
 * The matrix is duplicated in apps/uniliv-admin/src/lib/permissions.ts and the
 * two must agree; this pins the backend half, which is the one that actually
 * refuses a request.
 */
describe("FOOD_CATALOGUE", () => {
  it("is withheld from F&B managers", () => {
    for (const perm of ["view_service_catalogue", "add_service_catalogue", "edit_service_catalogue", "delete_service_catalogue"] as const) {
      expect(can("FNB_MANAGER", "FOOD_CATALOGUE", perm), perm).toBe(false);
    }
  });

  it("leaves the F&B manager's other Service Set access intact", () => {
    // The Menu, Meal Types and Cut-offs tabs, plus Masters, share this gate.
    expect(can("FNB_MANAGER", "FOOD_SETTINGS", "view_food_setting")).toBe(true);
    expect(can("FNB_MANAGER", "FOOD_SETTINGS", "edit_food_setting")).toBe(true);
  });

  it("is held by every role that holds FOOD_SETTINGS, bar the F&B manager", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as UserRole[];
    const withSettings = roles.filter((r) => can(r, "FOOD_SETTINGS", "edit_food_setting"));
    // Guard against the list silently emptying and the assertion passing.
    expect(withSettings.length).toBeGreaterThan(1);
    for (const r of withSettings) {
      expect(can(r, "FOOD_CATALOGUE", "edit_service_catalogue"), r).toBe(r !== "FNB_MANAGER");
    }
  });

  it("is not granted to a role that has no food access at all", () => {
    expect(can("HR_MANAGER", "FOOD_CATALOGUE", "view_service_catalogue")).toBe(false);
  });

  it("still lets Super Admin and Ops Excellence edit the catalogue", () => {
    for (const r of ["SUPER_ADMIN", "OPS_EXCELLENCE"] as UserRole[]) {
      expect(can(r, "FOOD_CATALOGUE", "add_service_catalogue"), r).toBe(true);
      expect(can(r, "FOOD_CATALOGUE", "delete_service_catalogue"), r).toBe(true);
    }
  });
});
