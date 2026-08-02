import { describe, expect, it } from "vitest";
import { canonicalJson } from "../audit-events.js";

describe("canonicalJson (hash-chain payload determinism)", () => {
  it("sorts object keys recursively so key order never changes the hash input", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("preserves array order (arrays are data, not sets)", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("normalizes undefined to null so optional fields hash stably", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});
