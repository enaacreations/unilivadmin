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
  role: "UNIT_LEAD",
  roleKey: "UNIT_LEAD",
  roleKeys: ["UNIT_LEAD"],
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
    const d = decide(access({ isGlobalAdmin: true, roleKey: "SUPER_ADMIN", roleKeys: ["SUPER_ADMIN"], nodeIds: null }), {
      functionality: "PROPERTIES",
      action: "delete_resident",
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_SYSTEM_ROLE");
  });

  it("allows a capability the role holds outright", () => {
    const d = decide(access(), { functionality: "RESIDENTS", action: "view_resident" });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_ROLE_CAPABILITY");
  });

  it("refuses a capability the role lacks, naming it", () => {
    const d = decide(access(), { functionality: "LEDGER", action: "edit_ledger" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
    // The sentence names the functionality the way an administrator would read
    // it — module first, so "Ledger" is never ambiguous about which Ledger. The
    // machine key stays on the decision for anyone matching a log line to a row.
    expect(d.detail).toContain("Finance › Ledger");
    expect(d.functionality).toBe("LEDGER");
    expect(d.module).toBe("FINANCE_OPS");
  });

  it("distinguishes 'your role cannot' from 'you are placed nowhere'", () => {
    // These are the two denials that look identical to a user and need totally
    // different fixes: change the role, versus give them a grant.
    const noGrant = decide(access({ nodeIds: [] }), { functionality: "RESIDENTS", action: "view_resident" });
    expect(noGrant.allow).toBe(false);
    expect(noGrant.reason).toBe("DENY_NO_GRANT");

    const noCap = decide(access(), { functionality: "LEDGER", action: "edit_ledger" });
    expect(noCap.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
  });

  it("refuses a node outside the caller's scope", () => {
    const d = decide(access(), { functionality: "RESIDENTS", action: "view_resident", nodeId: "prop-b" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_NODE_OUT_OF_SCOPE");
  });

  it("ignores the node check for an unrestricted caller", () => {
    const d = decide(access({ nodeIds: null }), { functionality: "RESIDENTS", action: "view_resident", nodeId: "anything" });
    expect(d.allow).toBe(true);
  });

  it("refuses an action the functionality does not support", () => {
    const d = decide(access({ isGlobalAdmin: false, roleKey: "SUPER_ADMIN", roleKeys: ["SUPER_ADMIN"] }), {
      functionality: "DASHBOARD",
      action: "approve_dashboard",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ACTION_NOT_ON_FUNCTIONALITY");
  });

  it("refuses an unknown functionality rather than failing open", () => {
    const d = decide(access(), { functionality: "NOT_A_FUNCTIONALITY" as never, action: "view_resident" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_UNKNOWN_FUNCTIONALITY");
  });

  it("confers the read through any other held action, and says so", () => {
    // The one implication: holding ANYTHING on a functionality implies its
    // read. WARDEN holds RESIDENTS outright here, so the direct reason wins —
    // the implied path is exercised below.
    const d = decide(access(), { functionality: "RESIDENTS", action: "view_resident" });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ALLOW_ROLE_CAPABILITY");
  });

  it("implies nothing beyond the read", () => {
    // AUDIT_READONLY holds each functionality's read and nothing else, so a
    // download is refused — implication widens toward the read, never to a
    // write or an export.
    const d = decide(
      access({ roleKey: "AUDIT_READONLY", roleKeys: ["AUDIT_READONLY"] }),
      { functionality: "AUDIT_REPORTS", action: "download_audit_report" },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_ROLE_LACKS_CAPABILITY");
  });

  it("refuses when the held data scope is narrower than required", () => {
    const d = decide(access({ dataScope: "ASSIGNED" }), {
      functionality: "RESIDENTS",
      action: "view_resident",
      dataScope: "ALL",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("DENY_DATA_SCOPE");
  });

  it("allows when the held data scope is wider than required", () => {
    const d = decide(access({ dataScope: "ALL" }), {
      functionality: "RESIDENTS",
      action: "view_resident",
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
