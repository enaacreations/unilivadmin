import { describe, expect, it } from "vitest";
import { csvEsc, toCsv, toXls, type ExportTable } from "../export-service.js";

/**
 * Regression cover for the wastage-report defect: quantities are numeric(12,3)
 * and are routinely fractional, but every exported cell was String-typed. In
 * Excel a wasted 0.3 kg arrived as left-aligned TEXT that could not be summed,
 * sorted by size or charted — the file looked like it had lost the decimals the
 * client had entered — and in CSV the formula-injection guard turned a negative
 * variance into the literal `'-2.5`.
 *
 * The rule these tests pin: a finite NUMBER is emitted as a number, everything
 * else keeps the injection hardening exactly as it was.
 */

const table = (rows: ExportTable["rows"]): ExportTable => ({
  title: "Food Waste by Dish",
  headers: ["Dish", "Unit", "Wasted"],
  rows,
  exportDate: new Date("2026-08-30T10:00:00Z"),
});

describe("csvEsc — numbers stay numeric, text stays hardened", () => {
  it("emits a finite number verbatim, including decimals and negatives", () => {
    expect(csvEsc(0.3)).toBe("0.3");
    expect(csvEsc(0.125)).toBe("0.125");
    // The `-` formula trigger used to prefix this into the text `'-2.5`.
    expect(csvEsc(-2.5)).toBe("-2.5");
    expect(csvEsc(0)).toBe("0");
  });

  it("still neutralises formula triggers on TEXT cells", () => {
    expect(csvEsc("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvEsc("+1234")).toBe("'+1234");
    expect(csvEsc("@SUM(A1)")).toBe("'@SUM(A1)");
    // A numeric-looking STRING is still text, so it keeps the guard.
    expect(csvEsc("-2.5")).toBe("'-2.5");
  });

  it("still RFC-4180 quotes text containing a comma or quote", () => {
    expect(csvEsc("Paneer, diced")).toBe('"Paneer, diced"');
    expect(csvEsc('say "hi"')).toBe('"say ""hi"""');
  });

  it("does not let a non-finite number escape the text path", () => {
    expect(csvEsc(NaN)).toBe("NaN");
    expect(csvEsc(Infinity)).toBe("Infinity");
  });
});

describe("toCsv — decimal quantities survive the round trip", () => {
  it("writes fractional quantities unquoted and unrounded", () => {
    const csv = toCsv(table([["Dal Tadka", "KG", 0.3], ["Jeera Rice", "KG", 0.125]]));
    expect(csv).toContain("Dal Tadka,KG,0.3");
    expect(csv).toContain("Jeera Rice,KG,0.125");
  });
});

describe("toXls — quantities are Number cells, labels are String cells", () => {
  it("types a finite quantity as ss:Type=\"Number\"", () => {
    const xml = toXls(table([["Dal Tadka", "KG", 0.3]]));
    expect(xml).toContain('<Data ss:Type="Number">0.3</Data>');
    expect(xml).toContain('<Data ss:Type="String">Dal Tadka</Data>');
    // The decimal must not have been stringified into a text cell.
    expect(xml).not.toContain('<Data ss:Type="String">0.3</Data>');
  });

  it("keeps a formula-looking dish name String-typed and escaped", () => {
    const xml = toXls(table([["=HYPERLINK(\"http://x\")", "KG", 1]]));
    expect(xml).toContain('<Data ss:Type="String">=HYPERLINK(&quot;http://x&quot;)</Data>');
    expect(xml).not.toContain('ss:Type="Number">=');
  });

  it("routes a non-finite number to the String path rather than emitting bare NaN", () => {
    const xml = toXls(table([["Broken", "KG", NaN]]));
    expect(xml).toContain('<Data ss:Type="String">NaN</Data>');
    expect(xml).not.toContain('<Data ss:Type="Number">NaN</Data>');
  });

  it("emits negative and zero quantities as numbers", () => {
    const xml = toXls(table([["Variance", "KG", -2.5], ["Zero", "KG", 0]]));
    expect(xml).toContain('<Data ss:Type="Number">-2.5</Data>');
    expect(xml).toContain('<Data ss:Type="Number">0</Data>');
  });
});
