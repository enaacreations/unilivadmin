/**
 * Dish colour — the two rules that make a free-form hex safe to draw.
 *
 * Both exist because the colour is chosen in one place and drawn in another.
 * The clamp is what stops a colour picked against the white card from vanishing
 * on the dark one; the near-miss check is what stops 200 dishes coloured one at
 * a time from drifting into six purples nobody can tell apart on a 3px rail.
 *
 * INVARIANT throughout: the stored hex is never rewritten. Both rules run at
 * render/validate time, so the colour that was picked is the colour that comes
 * back out of the picker.
 */
import { describe, expect, it } from "vitest";
import {
  colorsTooClose, hexToHsl, nearMissDish, normalizeHex, railColors, resolveDishColor,
} from "../dish-color";
import type { Dish } from "@/lib/food-api";

const dish = (id: string, color: string | null, component = "SABZI"): Dish => ({
  id, name: id, component, unit: "KG", brands: ["UNILIV"], preparations: ["VEG"],
  photoUrl: null, color, isActive: true,
} as Dish);

describe("normalizeHex", () => {
  it("accepts any casing and the 3-digit shorthand", () => {
    expect(normalizeHex("#7A4EA3")).toBe("#7a4ea3");
    expect(normalizeHex("  #7a4ea3 ")).toBe("#7a4ea3");
    expect(normalizeHex("#abc")).toBe("#aabbcc");
  });

  it("rejects anything that is not a hex colour", () => {
    // Bare names and rgb() would round-trip through the picker as garbage.
    expect(normalizeHex("purple")).toBeNull();
    expect(normalizeHex("7a4ea3")).toBeNull();
    expect(normalizeHex("#7a4ea")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex("")).toBeNull();
  });
});

describe("resolveDishColor", () => {
  it("prefers the dish's own colour", () => {
    expect(resolveDishColor(dish("d", "#7a4ea3"))).toBe("#7a4ea3");
  });

  it("falls back to the course colour, so no dish is ever colourless", () => {
    const sabzi = resolveDishColor(dish("d", null, "SABZI"));
    const dal = resolveDishColor(dish("d", null, "DAL"));
    expect(sabzi).toMatch(/^#[0-9a-f]{6}$/);
    // The fallback has to DISTINGUISH courses or the board reads as one colour.
    expect(sabzi).not.toBe(dal);
  });

  it("still answers for an unknown course and for no dish at all", () => {
    expect(resolveDishColor(dish("d", null, "NOT_A_COURSE"))).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolveDishColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("railColors", () => {
  it("keeps a near-black legible on the light card and a near-white on the dark one", () => {
    // The whole point: both are picked against ONE background and drawn on two.
    const navy = railColors("#2f2a6b");
    const cream = railColors("#f5e9b8");
    expect(hexToHsl(navy.dark).l).toBeGreaterThanOrEqual(54);
    expect(hexToHsl(cream.light).l).toBeLessThanOrEqual(63);
  });

  it("leaves a colour already inside both ranges alone-ish", () => {
    const mid = railColors("#4e9f5b");
    const src = hexToHsl("#4e9f5b");
    // Hue and saturation are the part the person chose — only lightness moves.
    for (const v of [mid.light, mid.dark]) {
      expect(Math.abs(hexToHsl(v).h - src.h)).toBeLessThan(2);
      expect(Math.abs(hexToHsl(v).s - src.s)).toBeLessThan(2);
    }
  });

  it("returns drawable hexes for pure black and pure white", () => {
    for (const hex of ["#000000", "#ffffff"]) {
      const { light, dark } = railColors(hex);
      expect(light).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark).toMatch(/^#[0-9a-f]{6}$/);
      // Neither may come back as the card it sits on.
      expect(light).not.toBe("#ffffff");
      expect(dark).not.toBe("#000000");
    }
  });
});

describe("the course palette", () => {
  // Every course a dish can carry. Most of the board is drawn in these, since
  // only a deliberately overridden dish wears anything else.
  const COURSES = [
    "HOT_FOOD", "SABZI", "DAL", "RICE", "BREAD", "SALAD", "CURD_RAITA", "DESSERT",
    "PAPAD_PICKLE", "CHUTNEY", "PICKLE", "FRUITS", "BAKERY", "BEVERAGE", "SNACK", "MILK", "OTHER",
  ];

  it("holds no pair the app would itself warn about", () => {
    // The first palette had hot food, bread, snack, papad, bakery and pickle all
    // inside 40° of hue — six near-identical rails on one breakfast plate. This
    // is the same rule that warns the F&B manager, so shipping a palette that
    // fails it would mean asking them to avoid a clash we ship with.
    const clashes: string[] = [];
    for (let i = 0; i < COURSES.length; i++) {
      for (let j = i + 1; j < COURSES.length; j++) {
        const a = resolveDishColor(dish("a", null, COURSES[i]!));
        const b = resolveDishColor(dish("b", null, COURSES[j]!));
        if (colorsTooClose(a, b)) clashes.push(`${COURSES[i]} ~ ${COURSES[j]}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("gives every course a colour of its own", () => {
    const seen = COURSES.map((c) => resolveDishColor(dish("d", null, c)));
    expect(new Set(seen).size).toBe(COURSES.length);
  });
});

describe("colorsTooClose", () => {
  it("flags two purples six hue-degrees apart", () => {
    expect(colorsTooClose("#7a4ea3", "#7b51a6")).toBe(true);
  });

  it("clears colours from different hue families", () => {
    expect(colorsTooClose("#7a4ea3", "#4e9f5b")).toBe(false);
    expect(colorsTooClose("#d9a62e", "#2c6fa8")).toBe(false);
  });

  it("clears one hue at two clearly different depths", () => {
    // Same green family, but nobody confuses these two on a rail.
    expect(colorsTooClose("#2f7a44", "#9cb33a")).toBe(false);
  });

  it("compares greys by depth, since a grey's hue means nothing", () => {
    expect(colorsTooClose("#8c8c8c", "#909090")).toBe(true);
    expect(colorsTooClose("#3a3a3a", "#d0d0d0")).toBe(false);
  });
});

describe("nearMissDish", () => {
  const catalogue = [
    dish("paneer", "#7a4ea3"),
    dish("chole", "#4e9f5b"),
    dish("uncoloured", null),
  ];

  it("names the dish a near-identical colour would be confused with", () => {
    expect(nearMissDish("#7b51a6", catalogue, null)?.id).toBe("paneer");
  });

  it("stays silent on an EXACTLY equal colour", () => {
    // Colouring every paneer dish the same purple is a deliberate scheme, not
    // the accident this guard exists for.
    expect(nearMissDish("#7a4ea3", catalogue, null)).toBeNull();
  });

  it("never flags a dish against itself", () => {
    expect(nearMissDish("#7a4ea3", catalogue, "paneer")).toBeNull();
  });

  it("ignores dishes with no colour of their own", () => {
    // They wear a COURSE colour, which is shared by design — warning about it
    // would fire on almost every save and train people to ignore the warning.
    const courseColored = [dish("other-sabzi", null, "SABZI")];
    expect(nearMissDish(resolveDishColor(dish("x", null, "SABZI")), courseColored, null)).toBeNull();
  });

  it("ignores retired dishes and answers null for no colour", () => {
    const retired = [{ ...dish("old", "#7a4ea3"), isActive: false }];
    expect(nearMissDish("#7b51a6", retired, null)).toBeNull();
    expect(nearMissDish(null, catalogue, null)).toBeNull();
  });
});
