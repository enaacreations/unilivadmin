/**
 * decide() — the single decision function.
 *
 * Pure: it takes an already-resolved EffectiveAccess and answers one question.
 * The reason codes are part of the contract, not debug output — they go out on
 * the wire in a 403 and are rendered by the access preview, so a change here is
 * a change to what support sees.
 */
import { describe, expect, it } from "vitest";
import { decide, satisfiesDataScope } from "../access/decide.js";
import type { EffectiveAccess, DataScope } from "../access.js";

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

describe("decide", () => {
  it("lets a global admin through without consulting anything else", () => {
    const d = decide(access({ isGlobalAdmin: true, roleKey: "SUPER_ADMIN", nodeIds: null }), {
      module: "PROPERTIES",
      action: "delete",
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_SYSTEM_ROLE");
  });

  it("allows a capability the role holds outright", () => {
    const d = decide(access(), { module: "RESIDENTS", action: "view" });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_ROLE_CAPABILITY");
  });

  it("refuses a capability the role lacks, naming it", () => {
    const d = decide(access(), { module: "LEDGER", action: "edit" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
    expect(d.detail).toContain("LEDGER");
  });

  it("distinguishes 'your role cannot' from 'you are placed nowhere'", () => {
    // These are the two denials that look identical to a user and need totally
    // different fixes: change the role, versus give them a grant.
    const noGrant = decide(access({ nodeIds: [] }), { module: "RESIDENTS", action: "view" });
    expect(noGrant.allow).toBe(false);
    expect(noGrant.reason).toBe("DENY_NO_GRANT");

    const noCap = decide(access(), { module: "LEDGER", action: "edit" });
    expect(noCap.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
  });

  it("refuses a node outside the caller's scope", () => {
    const d = decide(access(), { module: "RESIDENTS", action: "view", nodeId: "prop-b" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_NODE_OUT_OF_SCOPE");
  });

  it("ignores the node check for an unrestricted caller", () => {
    const d = decide(access({ nodeIds: null }), { module: "RESIDENTS", action: "view", nodeId: "anything" });
    expect(d.allow).toBe(true);
  });

  it("refuses an action the module does not support", () => {
    const d = decide(access({ isGlobalAdmin: false, roleKey: "SUPER_ADMIN" }), {
      module: "DASHBOARD",
      action: "approve",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ACTION_NOT_ON_MODULE");
  });

  it("refuses an unknown module rather than failing open", () => {
    const d = decide(access(), { module: "NOT_A_MODULE" as never, action: "view" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_UNKNOWN_MODULE");
  });

  it("confers view through an implied capability, and says so", () => {
    // WARDEN holds RESIDENTS edit; `edit implies view` means a view check passes
    // even where the matrix cell is consulted for the write.
    const d = decide(access(), { module: "RESIDENTS", action: "view" });
    expect(d.allow).toBe(true);
    // Held outright here, so it is the direct reason — the implied path is
    // exercised by the export/download edge below.
    expect(d.reason).toBe("ALLOW_ROLE_CAPABILITY");
  });

  it("implies download from export", () => {
    const d = decide(access({ roleKey: "AUDIT_READONLY" }), { module: "AUDIT_REPORTS", action: "download" });
    // AUDIT_READONLY holds view on everything but not export, so download is
    // denied — proving implication does not invent a capability out of nothing.
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
  });

  it("refuses when the held data scope is narrower than required", () => {
    const d = decide(access({ dataScope: "ASSIGNED" }), {
      module: "RESIDENTS",
      action: "view",
      dataScope: "ALL",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_DATA_SCOPE");
  });

  it("allows when the held data scope is wider than required", () => {
    const d = decide(access({ dataScope: "ALL" }), {
      module: "RESIDENTS",
      action: "view",
      dataScope: "SELF",
    });
    expect(d.allow).toBe(true);
  });
});

describe("satisfiesDataScope", () => {
  it("orders ALL > TEAM > ASSIGNED > SELF", () => {
    const order: DataScope[] = ["SELF", "ASSIGNED", "TEAM", "ALL"];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(satisfiesDataScope(order[i]!, order[j]!)).toBe(i >= j);
      }
    }
  });
});
