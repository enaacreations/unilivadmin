import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildSheet, parseSheet } from "../sheet";

/** The dish import template — key/label pairs, same list the catalogue passes. */
const DISH_COLUMNS = [
  { key: "name", label: "name" },
  { key: "component", label: "component" },
  { key: "unit", label: "unit" },
  { key: "brands", label: "brands" },
  { key: "preparations", label: "preparations" },
  { key: "ingredients", label: "ingredients" },
  { key: "isQtyLocked", label: "isQtyLocked" },
  { key: "isActive", label: "isActive" },
];

/** Write a workbook out and read it straight back, as download-then-upload does. */
const roundTrip = (
  headers: string[],
  rows: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string }>,
  bookType: "csv" | "xlsx",
) => {
  const buf = XLSX.write(buildSheet(headers, rows), { type: "array", bookType });
  return parseSheet(buf as ArrayBuffer, columns);
};

/** What the Dishes catalogue builds for an export. */
const exportedDish = {
  name: "Aloo Jeera",
  component: "SABZI",
  unit: "SERVING",
  brands: "UNILIV, HUDDLE",
  preparations: "VEG, JAIN",
  ingredients: "Aloo, Jeera, Haldi",
  isQtyLocked: "false",
  isActive: "true",
};

describe("sheet round trip", () => {
  const headers = DISH_COLUMNS.map((c) => c.label);

  for (const bookType of ["csv", "xlsx"] as const) {
    it(`returns an exported dish row unchanged through ${bookType}`, () => {
      const out = roundTrip(headers, [exportedDish], DISH_COLUMNS, bookType);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(exportedDish);
    });

    it(`keeps every row of a multi-row export through ${bookType}`, () => {
      const rows = [
        exportedDish,
        { ...exportedDish, name: "Dal Tadka", component: "DAL", ingredients: "Toor Dal, Jeera" },
        { ...exportedDish, name: "Jeera Rice", component: "RICE", isActive: "false" },
      ];
      const out = roundTrip(headers, rows, DISH_COLUMNS, bookType);
      expect(out).toEqual(rows);
    });
  }

  it("preserves a comma-separated cell as one value, not several columns", () => {
    const out = roundTrip(headers, [exportedDish], DISH_COLUMNS, "csv");
    expect(out[0]?.["ingredients"]).toBe("Aloo, Jeera, Haldi");
    expect(out[0]?.["brands"]).toBe("UNILIV, HUDDLE");
  });

  it("keeps a dish with no ingredients as a blank cell rather than dropping the row", () => {
    const bare = { ...exportedDish, ingredients: "", brands: "" };
    const out = roundTrip(headers, [bare], DISH_COLUMNS, "csv");
    expect(out).toHaveLength(1);
    expect(out[0]?.["ingredients"]).toBe("");
  });

  it("writes column order from the header list, not from the row object", () => {
    const scrambled = { isActive: "true", name: "Aloo Jeera", unit: "SERVING", component: "SABZI" };
    const cols = DISH_COLUMNS.slice(0, 3);
    const buf = XLSX.write(buildSheet(cols.map((c) => c.label), [scrambled]), {
      type: "array", bookType: "csv",
    });
    const text = new TextDecoder().decode(buf as ArrayBuffer);
    expect(text.split("\n")[0]).toBe("name,component,unit");
  });
});

describe("parseSheet", () => {
  const headers = DISH_COLUMNS.map((c) => c.label);

  it("reads back only the header row from a template, giving no data rows", () => {
    expect(roundTrip(headers, [], DISH_COLUMNS, "csv")).toEqual([]);
    expect(roundTrip(headers, [], DISH_COLUMNS, "xlsx")).toEqual([]);
  });

  it("ignores columns the template does not define", () => {
    const withExtra = { ...exportedDish, notes: "ignore me" };
    const out = roundTrip([...headers, "notes"], [withExtra], DISH_COLUMNS, "csv");
    expect(out[0]).toEqual(exportedDish);
    expect(out[0]).not.toHaveProperty("notes");
  });

  it("maps a label that differs from its key back onto the key", () => {
    const cols = [{ key: "isQtyLocked", label: "Quantity locked" }];
    const out = roundTrip(["Quantity locked"], [{ "Quantity locked": "true" }], cols, "csv");
    expect(out[0]).toEqual({ isQtyLocked: "true" });
  });

  it("drops a fully blank row", () => {
    const out = roundTrip(headers, [exportedDish, Object.fromEntries(headers.map((h) => [h, ""]))], DISH_COLUMNS, "csv");
    expect(out).toHaveLength(1);
  });
});
