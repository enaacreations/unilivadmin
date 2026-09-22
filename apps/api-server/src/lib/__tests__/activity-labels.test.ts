import { describe, it, expect } from "vitest";
import { collectIds, isIdLike } from "../activity/labels.js";

/**
 * The scanner that decides which before/after values get a name in the trail.
 * Kept honest here because the cost of being wrong is asymmetric: missing an id
 * shows the reviewer a uuid (annoying), while matching something that ISN'T an
 * id risks labelling an unrelated value with a stranger's name.
 */
describe("activity label id scanning", () => {
  const ID = "7300ab1d-96e1-4676-9ab1-f77c97b3da20";

  it("accepts a uuid and rejects near-misses", () => {
    expect(isIdLike(ID)).toBe(true);
    expect(isIdLike(ID.toUpperCase())).toBe(true);
    expect(isIdLike(ID.slice(0, 8))).toBe(false);          // the truncated form we render
    expect(isIdLike(`${ID} `)).toBe(false);                 // no partial matching
    expect(isIdLike("Entire organization")).toBe(false);
    expect(isIdLike("WARDEN")).toBe(false);
    expect(isIdLike(42)).toBe(false);
    expect(isIdLike(null)).toBe(false);
  });

  it("finds ids in values, arrays and nested objects", () => {
    const found = new Set<string>();
    collectIds({ atNode: ID, role: "WARDEN", secondary: [ID], meta: { scope: { nodeId: ID } } }, found);
    expect([...found]).toEqual([ID]);
  });

  it("stops descending before a pathological payload walks forever", () => {
    // 6 levels deep — past the depth cap, so the id is not collected. A trail
    // row is a flat diff; anything this nested is not a value a human reads.
    const deep = { a: { b: { c: { d: { e: { f: ID } } } } } };
    const found = new Set<string>();
    collectIds(deep, found);
    expect(found.size).toBe(0);
  });
});
