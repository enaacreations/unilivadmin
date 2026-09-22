/**
 * Per-employee permission overrides.
 *
 * Two contracts are asserted here, and both are load-bearing:
 *
 *  1. RESOLUTION — DENY beats GRANT beats the role, an override supplies
 *     capability but never scope, and system roles are untouchable. These are
 *     the rules decide(), the authorize() gate and the /auth/me blob all three
 *     implement, so a change here is a change to what the product enforces.
 *
 *  2. INHERITANCE — the point of an override table rather than a cloned role is
 *     that a person with an exception on one cell still tracks their role on
 *     every other cell. If that stops holding, the feature has quietly become
 *     "copy the role and drift", which is what it exists to avoid.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../access/decide.js";
import { overrideKey, overrideOn, type OverrideMap } from "../access/overrides.js";
import type { EffectiveAccess } from "../access.js";

const map = (...pairs: Array<[string, "GRANT" | "DENY"]>): OverrideMap =>
  new Map(pairs.map(([k, v]) => [k, v]));

const access = (over: Partial<EffectiveAccess> = {}): EffectiveAccess => ({
  userId: "u1",
  role: "WARDEN",
  roleKey: "WARDEN",
  isGlobalAdmin: false,
  nodeIds: ["prop-a"],
  propertyIds: ["prop-a"],
  kitchenIds: [],
  grants: [],
  dataScope: "ALL",
  employeeId: null,
  teamEmployeeIds: async () => [],
  ...over,
});

describe("override resolution", () => {
  it("grants a capability the role does not carry", () => {
    // A warden cannot assign complaints. This one can.
    const before = decide(access(), { module: "COMPLAINTS", action: "assign" });
    expect(before.allow).toBe(false);

    const after = decide(
      access({ overrides: map([overrideKey("COMPLAINTS", "assign"), "GRANT"]) }),
      { module: "COMPLAINTS", action: "assign" },
    );
    expect(after.allow).toBe(true);
    expect(after.reason).toBe("ALLOW_USER_OVERRIDE");
  });

  it("withholds a capability the role does carry", () => {
    const before = decide(access(), { module: "RESIDENTS", action: "view" });
    expect(before.allow).toBe(true);

    const after = decide(
      access({ overrides: map([overrideKey("RESIDENTS", "view"), "DENY"]) }),
      { module: "RESIDENTS", action: "view" },
    );
    expect(after.allow).toBe(false);
    expect(after.reason).toBe("DENY_USER_OVERRIDE");
  });

  it("leaves every OTHER cell resolving from the role", () => {
    // The whole reason this is an exception table and not a cloned role.
    const a = access({ overrides: map([overrideKey("RESIDENTS", "view"), "DENY"]) });
    expect(decide(a, { module: "RESIDENTS", action: "view" }).allow).toBe(false);
    expect(decide(a, { module: "COMPLAINTS", action: "view" }).reason).toBe("ALLOW_ROLE_CAPABILITY");
  });

  it("does not let a GRANT override reach outside the person's scope", () => {
    // An override says WHAT, never WHERE. A granted capability is still checked
    // against the grants — otherwise the override becomes a scope bypass.
    const d = decide(
      access({ overrides: map([overrideKey("COMPLAINTS", "assign"), "GRANT"]) }),
      { module: "COMPLAINTS", action: "assign", nodeId: "prop-b" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_NODE_OUT_OF_SCOPE");
  });

  it("does not let a GRANT override stand in for having no grant at all", () => {
    const d = decide(
      access({ nodeIds: [], overrides: map([overrideKey("COMPLAINTS", "assign"), "GRANT"]) }),
      { module: "COMPLAINTS", action: "assign" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_NO_GRANT");
  });

  it("cannot invent an action the module does not define", () => {
    // The manifest ceiling is checked BEFORE overrides, so a stale row for a
    // cell that no longer exists grants nothing.
    const d = decide(
      access({ overrides: map([overrideKey("DASHBOARD", "approve"), "GRANT"]) }),
      { module: "DASHBOARD", action: "approve" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ACTION_NOT_ON_MODULE");
  });

  it("cannot be used to take anything away from a system role", () => {
    // decide() short-circuits global admins before it reads overrides, and the
    // write guard refuses to store one against them. Both halves matter: a DENY
    // the UI displayed and the server ignored would be worse than none.
    const d = decide(
      access({
        isGlobalAdmin: true,
        roleKey: "SUPER_ADMIN",
        nodeIds: null,
        overrides: map([overrideKey("PROPERTIES", "delete"), "DENY"]),
      }),
      { module: "PROPERTIES", action: "delete" },
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_SYSTEM_ROLE");
  });

  it("reads an absent map as 'no exceptions', not as a denial", () => {
    expect(overrideOn(undefined, "RESIDENTS", "view")).toBeUndefined();
    expect(decide(access({ overrides: undefined }), { module: "RESIDENTS", action: "view" }).allow).toBe(true);
  });
});
