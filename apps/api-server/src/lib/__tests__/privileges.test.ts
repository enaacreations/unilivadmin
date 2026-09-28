/**
 * Privileges — the property-scoped exception layer, and the ladder that ranks it.
 *
 * Three contracts, all load-bearing:
 *
 *  1. THE LADDER — user beats role, node beats global, deeper node beats
 *     shallower, and only at EQUAL specificity does DENY beat GRANT. decide(),
 *     the authorize() gate and the /auth/me blob all implement this, so a change
 *     here is a change to what the product enforces.
 *
 *  2. INHERITANCE — a person with an exception on one cell still tracks their
 *     roles on every other cell, and a role privilege reaches every holder. If
 *     that stops holding, the feature has become "copy the role and drift",
 *     which is what it exists to avoid.
 *
 *  3. SCOPE IS NOT CAPABILITY — a GRANT supplies what, never where. An
 *     overridden cell is still checked against the person's grants.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../access/decide.js";
import { privilegeOn, privilegeKey, type PrivilegeMap, type ResolvedPrivilege } from "../access/privileges.js";
import type { EffectiveAccess } from "../access.js";

/** Build a privilege the way resolveAccess would, with its node already expanded. */
const priv = (
  p: {
    functionality: string; action: string; effect: "GRANT" | "DENY";
    fromUser?: boolean; nodeId?: string | null; depth?: number; covers?: string[];
    subjectId?: string; roleKey?: string;
  },
): [string, ResolvedPrivilege] => [
  privilegeKey(p.functionality, p.action),
  {
    effect: p.effect,
    fromUser: p.fromUser ?? true,
    nodeId: p.nodeId ?? null,
    depth: p.nodeId ? p.depth ?? 4 : -1,
    covers: p.nodeId ? new Set(p.covers ?? [p.nodeId]) : null,
    reason: "test",
    subjectId: p.subjectId ?? "u1",
    roleKey: p.roleKey ?? "*",
  },
];

const map = (...entries: Array<[string, ResolvedPrivilege]>): PrivilegeMap => {
  const m: PrivilegeMap = new Map();
  for (const [k, v] of entries) m.set(k, [...(m.get(k) ?? []), v]);
  return m;
};

const access = (over: Partial<EffectiveAccess> = {}): EffectiveAccess => ({
  userId: "u1",
  role: "UNIT_LEAD",
  roleKey: "UNIT_LEAD",
  roleKeys: ["UNIT_LEAD"],
  isGlobalAdmin: false,
  nodeIds: ["prop-a", "prop-b"],
  propertyIds: ["prop-a", "prop-b"],
  kitchenIds: [],
  grants: [],
  dataScope: "ALL",
  employeeId: null,
  teamEmployeeIds: async () => [],
  ...over,
});

describe("the privilege ladder", () => {
  it("lets a user privilege beat a role privilege on the same cell", () => {
    const p = map(
      priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "DENY", fromUser: false, subjectId: "UNIT_LEAD" }),
      priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "GRANT", fromUser: true }),
    );
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", null)?.effect).toBe("GRANT");
  });

  it("lets a node privilege beat a global one", () => {
    const p = map(
      priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "DENY" }),
      priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "GRANT", nodeId: "prop-a" }),
    );
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", "prop-a")?.effect).toBe("GRANT");
    // …and the global rule still governs everywhere else.
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", "prop-b")?.effect).toBe("DENY");
  });

  it("lets a deeper node beat a shallower one", () => {
    // A city rule that reaches the property, and a property rule that disagrees.
    const p = map(
      priv({ functionality: "RESIDENTS", action: "delete_resident", effect: "DENY", nodeId: "city-1", depth: 2, covers: ["city-1", "prop-a"] }),
      priv({ functionality: "RESIDENTS", action: "delete_resident", effect: "GRANT", nodeId: "prop-a", depth: 4 }),
    );
    expect(privilegeOn(p, "RESIDENTS", "delete_resident", "prop-a")?.effect).toBe("GRANT");
  });

  it("prefers DENY only at equal specificity", () => {
    const p = map(
      priv({ functionality: "RESIDENTS", action: "delete_resident", effect: "GRANT" }),
      priv({ functionality: "RESIDENTS", action: "delete_resident", effect: "DENY" }),
    );
    expect(privilegeOn(p, "RESIDENTS", "delete_resident", null)?.effect).toBe("DENY");
  });

  it("ignores a node privilege when no node is in hand", () => {
    // The gate and the nav blob ask without a node. A rule written for one
    // property must not open an endpoint everywhere.
    const p = map(priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "GRANT", nodeId: "prop-a" }));
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", null)).toBeUndefined();
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", "prop-a")?.effect).toBe("GRANT");
  });

  it("does not apply a node privilege outside the nodes it covers", () => {
    const p = map(priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "GRANT", nodeId: "prop-a" }));
    expect(privilegeOn(p, "COMPLAINT_TICKETS", "assign_complaint", "prop-b")).toBeUndefined();
  });
});

describe("the requirement: same role, different functionality per property", () => {
  // One warden, the ledger at property A and vendors at property B — the
  // scenario the requirement asked for, expressed as two rows.
  //
  // Both functionalities are ones WARDEN holds NOTHING on, so the privilege is
  // what decides. Picked deliberately: cells the role already grants would pass
  // this test whether the privilege layer worked or not.
  const p = map(
    priv({ functionality: "LEDGER", action: "edit_ledger", effect: "GRANT", nodeId: "prop-a" }),
    priv({ functionality: "VENDORS", action: "edit_vendor", effect: "GRANT", nodeId: "prop-b" }),
  );
  const a = access({ privileges: p });

  it("allows the first functionality at the first property only", () => {
    expect(decide(a, { functionality: "LEDGER", action: "edit_ledger", nodeId: "prop-a" }).allow).toBe(true);
    expect(decide(a, { functionality: "LEDGER", action: "edit_ledger", nodeId: "prop-b" }).allow).toBe(false);
  });

  it("allows the second functionality at the second property only", () => {
    expect(decide(a, { functionality: "VENDORS", action: "edit_vendor", nodeId: "prop-b" }).allow).toBe(true);
    expect(decide(a, { functionality: "VENDORS", action: "edit_vendor", nodeId: "prop-a" }).allow).toBe(false);
  });

  it("leaves every other cell resolving from the role", () => {
    expect(decide(a, { functionality: "COMPLAINT_TICKETS", action: "view_complaint" }).reason).toBe("ALLOW_ROLE_CAPABILITY");
  });
});

describe("privileges in decide()", () => {
  it("reports a role privilege with its own reason code", () => {
    const d = decide(
      access({
        privileges: map(priv({
          functionality: "LEDGER", action: "edit_ledger", effect: "GRANT",
          fromUser: false, subjectId: "UNIT_LEAD", nodeId: "prop-a",
        })),
      }),
      { functionality: "LEDGER", action: "edit_ledger", nodeId: "prop-a" },
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_ROLE_PRIVILEGE");
  });

  it("withholds with a role reason code when the role is denied", () => {
    const d = decide(
      access({
        privileges: map(priv({
          functionality: "RESIDENTS", action: "view_resident", effect: "DENY",
          fromUser: false, subjectId: "UNIT_LEAD",
        })),
      }),
      { functionality: "RESIDENTS", action: "view_resident" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ROLE_PRIVILEGE");
  });

  it("does not let a GRANT reach outside the person's scope", () => {
    // A privilege says WHAT, never WHERE — the grants still decide reach.
    const d = decide(
      access({
        nodeIds: ["prop-a"],
        privileges: map(priv({ functionality: "COMPLAINT_TICKETS", action: "assign_complaint", effect: "GRANT" })),
      }),
      { functionality: "COMPLAINT_TICKETS", action: "assign_complaint", nodeId: "prop-z" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_NODE_OUT_OF_SCOPE");
  });

  it("cannot invent an action the functionality does not define", () => {
    const d = decide(
      access({ privileges: map(priv({ functionality: "DASHBOARD", action: "approve_dashboard", effect: "GRANT" })) }),
      { functionality: "DASHBOARD", action: "approve_dashboard" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ACTION_NOT_ON_FUNCTIONALITY");
  });

  it("cannot take anything away from a system role", () => {
    const d = decide(
      access({
        isGlobalAdmin: true, roleKey: "SUPER_ADMIN", roleKeys: ["SUPER_ADMIN"], nodeIds: null,
        privileges: map(priv({ functionality: "PROPERTIES", action: "delete_property", effect: "DENY" })),
      }),
      { functionality: "PROPERTIES", action: "delete_property" },
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_SYSTEM_ROLE");
  });

  it("reads an absent map as 'no exceptions', not as a denial", () => {
    expect(privilegeOn(undefined, "RESIDENTS", "view_resident", null)).toBeUndefined();
    expect(decide(access({ privileges: undefined }), { functionality: "RESIDENTS", action: "view_resident" }).allow).toBe(true);
  });
});

describe("multi-role capability is a union", () => {
  it("holds a cell that any single held role holds", () => {
    // KITCHEN_MANAGER does not manage residents; WARDEN does.
    const single = decide(access({ roleKeys: ["KITCHEN_MANAGER"], roleKey: "KITCHEN_MANAGER" }), {
      functionality: "RESIDENTS", action: "edit_resident",
    });
    expect(single.allow).toBe(false);

    const both = decide(access({ roleKeys: ["KITCHEN_MANAGER", "UNIT_LEAD"], roleKey: "UNIT_LEAD" }), {
      functionality: "RESIDENTS", action: "edit_resident",
    });
    expect(both.allow).toBe(true);
  });

  it("names every held role when it refuses", () => {
    const d = decide(access({ roleKeys: ["UNIT_LEAD", "KITCHEN_MANAGER"] }), {
      functionality: "PROPERTIES", action: "delete_property",
    });
    expect(d.allow).toBe(false);
    expect(d.detail).toContain("UNIT_LEAD");
    expect(d.detail).toContain("KITCHEN_MANAGER");
  });
});
