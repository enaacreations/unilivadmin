import { describe, expect, it } from "vitest";
import {
  dishRowSchema,
  ingredientRowSchema,
  menuRowSchema,
  normalizeToken,
  parseDay,
  splitList,
} from "../bulk-food-rows.js";

/** A minimally-valid dish row, as the sheet parser hands it over (all strings). */
const dishRow = (over: Record<string, unknown> = {}) => ({
  name: "Aloo Jeera",
  component: "SABZI",
  unit: "SERVING",
  ...over,
});

describe("normalizeToken", () => {
  it("folds case, spaces and hyphens into the enum form", () => {
    expect(normalizeToken(" curd raita ")).toBe("CURD_RAITA");
    expect(normalizeToken("Papad-Pickle")).toBe("PAPAD_PICKLE");
    expect(normalizeToken("SABZI")).toBe("SABZI");
  });
});

describe("splitList", () => {
  it("splits a single cell on comma, semicolon or pipe and trims", () => {
    expect(splitList("Aloo, Pyaaz ;Tomato|Jeera")).toEqual(["Aloo", "Pyaaz", "Tomato", "Jeera"]);
  });

  it("treats a blank or missing cell as an empty list", () => {
    expect(splitList("")).toEqual([]);
    expect(splitList("   ")).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
    expect(splitList(null)).toEqual([]);
  });

  it("drops empty segments from trailing separators", () => {
    expect(splitList("Aloo,,Pyaaz,")).toEqual(["Aloo", "Pyaaz"]);
  });

  it("passes an already-array value through", () => {
    expect(splitList(["Aloo", " Pyaaz "])).toEqual(["Aloo", "Pyaaz"]);
  });
});

describe("ingredientRowSchema", () => {
  it("accepts a filled-in template row", () => {
    const r = ingredientRowSchema.safeParse({ name: "Aloo", unit: "KG", isActive: "true" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ name: "Aloo", unit: "KG", isActive: true });
  });

  it("accepts a lowercase unit and trims the name", () => {
    const r = ingredientRowSchema.safeParse({ name: "  Pyaaz  ", unit: "kg" });
    expect(r.success && r.data.name).toBe("Pyaaz");
    expect(r.success && r.data.unit).toBe("KG");
  });

  it("leaves isActive undefined when the cell is blank, so the default applies", () => {
    const r = ingredientRowSchema.safeParse({ name: "Aloo", unit: "KG", isActive: "" });
    expect(r.success && r.data.isActive).toBeUndefined();
  });

  it('reads the word "false" as false — z.coerce.boolean would say true', () => {
    for (const cell of ["false", "FALSE", "no", "N", "0", "inactive"]) {
      const r = ingredientRowSchema.safeParse({ name: "Aloo", unit: "KG", isActive: cell });
      expect(r.success && r.data.isActive, cell).toBe(false);
    }
  });

  it("reads the affirmative words as true", () => {
    for (const cell of ["true", "Yes", "y", "1", "ACTIVE"]) {
      const r = ingredientRowSchema.safeParse({ name: "Aloo", unit: "KG", isActive: cell });
      expect(r.success && r.data.isActive, cell).toBe(true);
    }
  });

  it("rejects a blank name", () => {
    const r = ingredientRowSchema.safeParse({ name: "   ", unit: "KG" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toBe("name is required");
  });

  it("rejects an unknown unit and names the accepted values", () => {
    const r = ingredientRowSchema.safeParse({ name: "Aloo", unit: "sacks" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toContain("unit must be one of");
  });

  it("rejects an unreadable boolean rather than guessing", () => {
    expect(ingredientRowSchema.safeParse({ name: "Aloo", unit: "KG", isActive: "maybe" }).success).toBe(false);
  });
});

describe("dishRowSchema", () => {
  it("accepts a filled-in template row", () => {
    const r = dishRowSchema.safeParse(dishRow({
      brands: "UNILIV, HUDDLE",
      preparations: "VEG",
      ingredients: "Aloo, Jeera",
      isQtyLocked: "false",
    }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.component).toBe("SABZI");
    expect(r.success && r.data.isQtyLocked).toBe(false);
  });

  it("accepts a course typed in prose casing", () => {
    const r = dishRowSchema.safeParse(dishRow({ component: "curd raita", unit: "plate" }));
    expect(r.success && r.data.component).toBe("CURD_RAITA");
    expect(r.success && r.data.unit).toBe("PLATE");
  });

  it("rejects an unknown course and names the accepted values", () => {
    const r = dishRowSchema.safeParse(dishRow({ component: "STARTER" }));
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toContain("component must be one of");
  });

  it("leaves the list cells untouched for the handler to resolve", () => {
    const r = dishRowSchema.safeParse(dishRow({ ingredients: "Aloo, Pyaaz" }));
    expect(r.success && splitList(r.data.ingredients)).toEqual(["Aloo", "Pyaaz"]);
  });

  it("leaves both optional flags undefined when their cells are blank", () => {
    const r = dishRowSchema.safeParse(dishRow({ isActive: "", isQtyLocked: "" }));
    expect(r.success && r.data.isActive).toBeUndefined();
    expect(r.success && r.data.isQtyLocked).toBeUndefined();
  });

  // The web app exports dishes under the import template's own columns so a
  // download can be edited and uploaded back. This is the server half of that
  // contract: the exact cell values an export writes must parse.
  it("parses a row exactly as the Dishes export writes it", () => {
    const r = dishRowSchema.safeParse({
      name: "Aloo Jeera",
      component: "SABZI",
      unit: "SERVING",
      brands: "UNILIV, HUDDLE",
      preparations: "VEG, JAIN",
      ingredients: "Aloo, Jeera, Haldi",
      isQtyLocked: "false",
      isActive: "true",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.isQtyLocked).toBe(false);
    expect(r.success && r.data.isActive).toBe(true);
    expect(r.success && splitList(r.data.preparations)).toEqual(["VEG", "JAIN"]);
    expect(r.success && splitList(r.data.brands)).toEqual(["UNILIV", "HUDDLE"]);
  });

  it("parses an exported dish that has no ingredients or brands", () => {
    const r = dishRowSchema.safeParse({
      name: "Plain Rice", component: "RICE", unit: "SERVING",
      brands: "", preparations: "VEG", ingredients: "", isQtyLocked: "false", isActive: "true",
    });
    expect(r.success).toBe(true);
    expect(r.success && splitList(r.data.ingredients)).toEqual([]);
  });

  it("requires name, component and unit", () => {
    expect(dishRowSchema.safeParse({ component: "SABZI", unit: "SERVING" }).success).toBe(false);
    expect(dishRowSchema.safeParse({ name: "Aloo", unit: "SERVING" }).success).toBe(false);
    expect(dishRowSchema.safeParse({ name: "Aloo", component: "SABZI" }).success).toBe(false);
  });
});

/** A minimally-valid menu row, as the sheet parser hands it over. */
const menuRow = (over: Record<string, unknown> = {}) => ({
  kitchen: "Central Kitchen",
  brand: "UNILIV",
  week: "1",
  day: "MON",
  meal: "LUNCH",
  dish: "Dal Tadka",
  ...over,
});

describe("parseDay", () => {
  it("reads the short day names, any casing", () => {
    expect(parseDay("MON")).toBe(1);
    expect(parseDay(" tue ")).toBe(2);
    expect(parseDay("Sun")).toBe(7);
  });

  it("reads full day names", () => {
    expect(parseDay("Monday")).toBe(1);
    expect(parseDay("WEDNESDAY")).toBe(3);
    expect(parseDay("Saturday")).toBe(6);
  });

  it("reads 1–7 with 1 = Monday, as food_menu_rotation stores it", () => {
    expect(parseDay(1)).toBe(1);
    expect(parseDay("7")).toBe(7);
  });

  it("rejects anything that is not a day", () => {
    expect(parseDay("Funday")).toBeNull();
    expect(parseDay(0)).toBeNull();
    expect(parseDay(8)).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay(null)).toBeNull();
  });
});

describe("menuRowSchema", () => {
  it("accepts a filled-in template row", () => {
    const r = menuRowSchema.safeParse(menuRow({ slotLabel: "Veg 2", sides: "Bhature, Achaar" }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.week).toBe(1);
    expect(r.success && r.data.day).toBe(1);
    expect(r.success && r.data.meal).toBe("LUNCH");
    expect(r.success && splitList(r.data.sides)).toEqual(["Bhature", "Achaar"]);
  });

  it("accepts a meal and day typed in prose casing", () => {
    const r = menuRowSchema.safeParse(menuRow({ meal: "dinner", day: "Thursday" }));
    expect(r.success && r.data.meal).toBe("DINNER");
    expect(r.success && r.data.day).toBe(4);
  });

  it("rejects a week outside the 4-week cycle", () => {
    const r = menuRowSchema.safeParse(menuRow({ week: "5" }));
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toContain("week must be one of");
  });

  it("rejects an unreadable day and says what it wanted", () => {
    const r = menuRowSchema.safeParse(menuRow({ day: "Funday" }));
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toBe("day must be Mon–Sun or 1–7");
  });

  it("rejects an unknown meal and names the accepted values", () => {
    const r = menuRowSchema.safeParse(menuRow({ meal: "BRUNCH" }));
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toContain("meal must be one of");
  });

  it("requires kitchen, brand, week, day, meal and dish", () => {
    for (const k of ["kitchen", "brand", "week", "day", "meal", "dish"]) {
      const row = menuRow();
      delete (row as Record<string, unknown>)[k];
      expect(menuRowSchema.safeParse(row).success, k).toBe(false);
    }
  });

  it("treats a blank sides cell as no accompaniments", () => {
    const r = menuRowSchema.safeParse(menuRow({ sides: "" }));
    expect(r.success && splitList(r.data.sides)).toEqual([]);
  });

  // The Menu tab exports the whole cycle in these columns so a download can be
  // edited and uploaded back; this is the server half of that contract.
  it("parses a row exactly as the Menu export writes it", () => {
    const r = menuRowSchema.safeParse({
      kitchen: "Central Kitchen", brand: "UNILIV", week: "2", day: "Wed",
      meal: "LUNCH", dish: "Chole", slotLabel: "Veg", sides: "Bhature",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.week).toBe(2);
    expect(r.success && r.data.day).toBe(3);
  });
});
