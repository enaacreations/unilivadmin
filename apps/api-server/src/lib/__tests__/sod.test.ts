/**
 * Separation of duties (PRD §33) — both halves.
 *
 * The static half replaces three hardcoded assertions in permissions-sync.test.ts
 * that named FOOD_DISPATCH / FOOD_CONFIRM_DELIVERY and six roles by hand. Driving
 * it off CAPABILITY_CONFLICTS means a new rule is covered the moment it is added,
 * rather than needing its own bespoke test nobody remembers to write.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CONFLICTS,
  staticConflicts,
  assertNotSelfApproval,
  type SodSubject,
} from "../access/sod.js";

const subject = (actors: Record<string, string | null>): SodSubject => ({
  type: "audit", id: "a-1", actors,
});

describe("static capability conflicts", () => {
  it("declares the ship-vs-receive rule the food module documents in prose", () => {
    const rule = CAPABILITY_CONFLICTS.find((r) => r.id === "FOOD_SHIP_VS_RECEIVE");
    expect(rule).toBeDefined();
    expect(rule!.a.module).toBe("FOOD_DISPATCH");
    expect(rule!.b.module).toBe("FOOD_CONFIRM_DELIVERY");
    // The rationale is not decoration: it is what the matrix editor will show
    // an admin about to create the violation.
    expect(rule!.rationale).toMatch(/certifies receipt/i);
  });

  it("flags a role holding both halves", () => {
    const holds = () => true;
    expect(staticConflicts("FNB_MANAGER", holds).map((r) => r.id)).toEqual(["FOOD_SHIP_VS_RECEIVE"]);
  });

  it("clears a role holding only one half", () => {
    const holds = (m: string) => m === "FOOD_DISPATCH";
    expect(staticConflicts("FNB_MANAGER", holds as never)).toEqual([]);
  });

  it("exempts the break-glass parity roles, and only those", () => {
    const holds = () => true;
    expect(staticConflicts("SUPER_ADMIN", holds)).toEqual([]);
    expect(staticConflicts("OPS_EXCELLENCE", holds)).toEqual([]);
    expect(staticConflicts("SENIOR_VICE_PRESIDENT", holds)).toHaveLength(1);
  });
});

describe("assertNotSelfApproval", () => {
  it("passes when the approver had no prior part", () => {
    expect(assertNotSelfApproval("u-2", "OPERATIONS_MANAGER", subject({ submittedBy: "u-1" }), "approve"))
      .toEqual({ overridden: false });
  });

  it("refuses approving what you submitted", () => {
    try {
      assertNotSelfApproval("u-1", "OPERATIONS_MANAGER", subject({ submittedBy: "u-1" }), "approve");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { statusCode?: number; details?: Record<string, unknown> };
      expect(err.statusCode).toBe(409);
      expect(err.details?.["code"]).toBe("SOD_SELF_APPROVAL");
      expect(err.details?.["conflictingActor"]).toBe("submittedBy");
    }
  });

  it("ignores a null actor — an unassigned record traps nobody", () => {
    expect(assertNotSelfApproval("u-1", "OPERATIONS_MANAGER", subject({ submittedBy: null, createdBy: null }), "approve"))
      .toEqual({ overridden: false });
  });

  it("narrows to the named parts when conflictsWith is given", () => {
    // Confirming delivery conflicts with having DISPATCHED it, not with having
    // created the order — the receiving unit legitimately does both of those.
    const s = subject({ createdBy: "u-1", dispatchedBy: "u-9" });
    expect(assertNotSelfApproval("u-1", "UNIT_LEAD", s, "confirm", { conflictsWith: ["dispatchedBy"] }))
      .toEqual({ overridden: false });
  });

  it("lets a parity role override WITH a reason, and reports it for logging", () => {
    const r = assertNotSelfApproval("u-1", "SUPER_ADMIN", subject({ submittedBy: "u-1" }), "approve", {
      overrideReason: "sole reviewer on site",
    });
    expect(r).toEqual({ overridden: true, conflictingActor: "submittedBy", reason: "sole reviewer on site" });
  });

  it("refuses a parity role override WITHOUT a reason", () => {
    // An override that leaves no trace is not an override, it is a hole.
    expect(() =>
      assertNotSelfApproval("u-1", "SUPER_ADMIN", subject({ submittedBy: "u-1" }), "approve"),
    ).toThrow(/Separation of duties/);
  });

  it("refuses a NON-parity role even with a reason", () => {
    expect(() =>
      assertNotSelfApproval("u-1", "FNB_MANAGER", subject({ submittedBy: "u-1" }), "approve", {
        overrideReason: "trust me",
      }),
    ).toThrow(/Separation of duties/);
  });
});
