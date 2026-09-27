import { describe, expect, it } from "vitest";
import { describeScope, validateScope } from "../audit-scope.js";
import type { AuditScopeRule } from "@workspace/db";

const rule = (over: Partial<AuditScopeRule> = {}): AuditScopeRule => ({
  level: "CLUSTER",
  ids: ["cl_1"],
  ...over,
});

describe("validateScope", () => {
  it("accepts a rule with no narrowing — the pre-`within` shape still resolves", () => {
    expect(validateScope(rule())).toBeNull();
    expect(validateScope({ level: "ORG", ids: [] })).toBeNull();
  });

  it("requires ids at every level except ORG", () => {
    expect(validateScope(rule({ ids: [] }))).toMatch(/at least one cluster/i);
    expect(validateScope({ level: "ORG", ids: [] })).toBeNull();
  });

  it("accepts narrowing keyed by the id being narrowed", () => {
    expect(validateScope(rule({ within: { cl_1: ["p_1", "p_2"], p_1: ["r_1"] } }))).toBeNull();
  });

  it("rejects an empty narrowing list — that is an unchecked branch, not a scope", () => {
    expect(validateScope(rule({ within: { cl_1: [] } }))).toMatch(/uncheck it instead/i);
  });

  it("rejects narrowing that is not a map of id lists", () => {
    expect(validateScope(rule({ within: ["p_1"] as never }))).toMatch(/keyed by the id/i);
    expect(validateScope(rule({ within: { cl_1: [123] as never } }))).toMatch(/list of ids/i);
    expect(validateScope(rule({ within: { cl_1: [""] } }))).toMatch(/list of ids/i);
  });

  it("caps the map so a runaway rule cannot be re-expanded every materialization", () => {
    const many: Record<string, string[]> = {};
    for (let i = 0; i < 2_001; i++) many["k" + i] = ["c"];
    expect(validateScope(rule({ within: many }))).toMatch(/Too many narrowed branches/i);

    const wide = { cl_1: Array.from({ length: 5_001 }, (_, i) => "c" + i) };
    expect(validateScope(rule({ within: wide }))).toMatch(/limit is 5000/i);
  });
});

describe("describeScope", () => {
  it("names the anchor, pluralising city correctly", () => {
    expect(describeScope({ level: "ORG", ids: [] })).toBe("Whole estate");
    expect(describeScope(rule())).toBe("1 cluster");
    expect(describeScope({ level: "CITY", ids: ["a", "b"] })).toBe("2 cities");
  });

  it("flags narrowing — two rules with the same anchor can cover different estates", () => {
    expect(describeScope(rule({ within: { cl_1: ["p_1"] } }))).toBe("1 cluster, narrowed");
    expect(describeScope({ level: "ORG", ids: [], within: { z_1: ["ci_1"] } })).toBe(
      "Whole estate, narrowed",
    );
  });
});
