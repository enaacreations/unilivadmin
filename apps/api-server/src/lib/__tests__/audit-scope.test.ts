import { describe, expect, it } from "vitest";
import type { AuditScopeRule } from "@workspace/db";
import { SCOPE_LEVELS, describeScope, validateScope } from "../audit-scope.js";

const scope = (over: Partial<AuditScopeRule>): AuditScopeRule =>
  ({ level: "CLUSTER", ids: ["c1"], ...over }) as AuditScopeRule;

describe("validateScope", () => {
  it("accepts every level with ids", () => {
    for (const level of SCOPE_LEVELS) {
      if (level === "ORG") continue;
      expect(validateScope(scope({ level, ids: ["x"] }))).toBeNull();
    }
  });

  it("accepts ORG with no ids — it means the whole estate", () => {
    expect(validateScope(scope({ level: "ORG", ids: [] }))).toBeNull();
  });

  it("rejects a non-ORG level with an empty selection", () => {
    // Otherwise the schedule would silently generate nothing, forever.
    expect(validateScope(scope({ level: "CLUSTER", ids: [] }))).toMatch(/cluster/i);
    expect(validateScope(scope({ level: "PROPERTY", ids: [] }))).toMatch(/property/i);
  });

  it("rejects an unknown level", () => {
    expect(validateScope({ level: "PLANET", ids: ["x"] } as unknown as AuditScopeRule)).toMatch(/unknown/i);
  });
});

describe("describeScope", () => {
  it("names the whole estate", () => {
    expect(describeScope(scope({ level: "ORG", ids: [] }))).toBe("Whole estate");
  });

  it("pluralises per level, including the irregular one", () => {
    expect(describeScope(scope({ level: "CLUSTER", ids: ["a"] }))).toBe("1 cluster");
    expect(describeScope(scope({ level: "CLUSTER", ids: ["a", "b"] }))).toBe("2 clusters");
    expect(describeScope(scope({ level: "CITY", ids: ["a"] }))).toBe("1 city");
    expect(describeScope(scope({ level: "CITY", ids: ["a", "b"] }))).toBe("2 cities");
    expect(describeScope(scope({ level: "ROOM", ids: ["a", "b", "c"] }))).toBe("3 rooms");
  });
});
