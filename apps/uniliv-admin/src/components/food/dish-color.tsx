/**
 * Dish colour — what turns a dish into a colour on the menu board.
 *
 * A dish carries an optional `color` (see dishesTable.color). Where it has none,
 * the board falls back to its COURSE colour, so the whole catalogue reads as
 * coloured from the day this shipped and the stored column only ever holds a
 * deliberate override.
 *
 * Two things here exist because a hex someone picked is not a hex that can be
 * drawn:
 *
 *  - `railColors` returns a light-theme and a dark-theme variant. The portal
 *    ships both themes and a colour is chosen against exactly one of them, so a
 *    navy picked on the white card would vanish on the dark one (and a cream the
 *    other way round). Only LIGHTNESS is clamped — hue and saturation are the
 *    part the person actually chose. The raw hex is what gets stored, so this
 *    rule can be retuned later without having lost anything.
 *
 *  - `nearMissDish` catches the failure mode a free picker has: 200 dishes
 *    coloured one at a time drift into six purples nobody can tell apart on a
 *    3px rail. An EQUAL colour is deliberate ("every paneer dish is purple") and
 *    never warned about; a near-miss is the accident.
 */
import * as React from "react";
import type { Dish } from "@/lib/food-api";

/**
 * The fast path in the dish drawer. 24 is already past the point where the eye
 * separates two rails at 3px — the custom picker exists for the rest, so this
 * list is chosen for spread (8 hue families × 3 depths), not for coverage.
 */
export const DISH_COLOR_SWATCHES = [
  "#b3261e", "#e2685e", "#c4571f", "#e0873c", "#a67c10", "#d9a62e", "#6e7a18", "#9cb33a",
  "#2f7a44", "#4e9f5b", "#199170", "#3fb894", "#1b7e86", "#3f9c9c", "#2c6fa8", "#6e8fd1",
  "#4b4fa6", "#8e7cc3", "#8a3e8f", "#b96fbf", "#a83a6b", "#d2699b", "#7a5a3c", "#8c7a6b",
];

/**
 * Course → colour, the fallback for every dish with no override — and in
 * practice what MOST of the board is drawn in, since only deliberately
 * overridden dishes carry anything else.
 *
 * Laid out around the hue wheel at 25–30° spacing rather than by what the food
 * looks like. The first cut coloured hot food, bread, snack, papad, bakery and
 * pickle all as warm browns — appetising in a list, and six near-identical
 * rails on a breakfast plate, which is most of a breakfast plate.
 *
 * The four staples that have no colour of their own (bread, papad, rice, other)
 * are separated by LIGHTNESS instead, which is the other axis colorsTooClose
 * measures: bread is a dark crust brown against dal's bright yellow at nearly
 * the same hue.
 *
 * Verified: no two entries here trip colorsTooClose. Re-check that when editing
 * one — the rule below is the same one that warns the F&B manager, so a palette
 * that fails it is asking them to avoid a clash the app itself ships with.
 */
const COURSE_COLOR: Record<string, string> = {
  FRUITS: "#ce3b3b",
  HOT_FOOD: "#c57320",
  DAL: "#dbc624",
  BAKERY: "#778d35",
  CHUTNEY: "#4b8d35",
  SABZI: "#429457",
  SALAD: "#38947d",
  PICKLE: "#287a8a",
  MILK: "#477ac2",
  CURD_RAITA: "#7069bf",
  BEVERAGE: "#8c56b3",
  SNACK: "#b143a8",
  DESSERT: "#cb4d8c",
  // Separated from their hue neighbours by depth, not by hue.
  BREAD: "#6b4d19",
  PAPAD_PICKLE: "#6d2c32",
  RICE: "#8d7c6d",
  OTHER: "#b0aba6",
};

/** Course with no entry, and the rail for a dish the catalogue could not resolve. */
const UNKNOWN_COLOR = "#98928c";

/** Lightness the rail is held inside, per theme. Below/above these it stops
 *  reading as a colour against the card it sits on. */
const LIGHT_RANGE = [30, 62] as const;
const DARK_RANGE = [55, 85] as const;

export type Hsl = { h: number; s: number; l: number };

/**
 * `#rrggbb` from any casing, with the 3-digit shorthand expanded. Null when the
 * string is not a hex colour at all — mirrors zDishColor on the server, which is
 * what decides whether a value can be saved.
 */
export function normalizeHex(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function hexToHsl(hex: string): Hsl {
  const v = normalizeHex(hex) ?? UNKNOWN_COLOR;
  const r = parseInt(v.slice(1, 3), 16) / 255;
  const g = parseInt(v.slice(3, 5), 16) / 255;
  const b = parseInt(v.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6
    : max === g ? (b - r) / d + 2
    : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = lig - c / 2;
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r1!)}${to(g1!)}${to(b1!)}`;
}

/**
 * The two colours the rail is actually drawn in. Both are handed to CSS as
 * custom properties and the theme picks between them (see `.dish-rail` in
 * index.css) — that way switching theme needs no re-render and no listener.
 */
export function railColors(hex: string): { light: string; dark: string } {
  const hsl = hexToHsl(hex);
  return {
    light: hslToHex({ ...hsl, l: Math.min(LIGHT_RANGE[1], Math.max(LIGHT_RANGE[0], hsl.l)) }),
    dark: hslToHex({ ...hsl, l: Math.min(DARK_RANGE[1], Math.max(DARK_RANGE[0], hsl.l)) }),
  };
}

/**
 * Anything that can be drawn as a coloured dish. Deliberately looser than `Dish`
 * — the drawer previews an unsaved draft, and the public shared-menu payload
 * carries only these two fields.
 */
export type ColorableDish = { color?: string | null; component?: string };

/**
 * How much of the row the tint fills. Dark needs more than light: the same
 * alpha over #221A16 lands far closer to the card than it does over white.
 */
const TINT_LIGHT = 0.1;
const TINT_DARK = 0.18;

/** `rgba()` at the tint alpha, from the theme's own clamped rail colour. */
function tintColors(hex: string): { light: string; dark: string } {
  const { light, dark } = railColors(hex);
  const rgba = (h: string, a: number) =>
    `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, ${a})`;
  return { light: rgba(light, TINT_LIGHT), dark: rgba(dark, TINT_DARK) };
}

/**
 * Props for a row that carries its dish's colour as a background wash.
 *
 * A 3px rail alone is ~40px of colour on a whole plate, which reads as "nearly
 * no colour". The wash is what makes the plate legible at a glance; the rail
 * stays because a 10% tint is too faint to identify a colour BY, and together
 * they give one strong edge and one large area.
 *
 * Deliberately tints the ROW rather than wrapping the dish name: a pill around
 * the text truncates names earlier in a ~120px week cell, and the name is the
 * thing actually being read.
 *
 *   <div {...dishTintProps(dish, "flex items-center gap-1.5")}>
 */
export function dishTintProps(
  dish: ColorableDish | undefined,
  className = "",
): { className: string; style: React.CSSProperties } {
  const { light, dark } = tintColors(resolveDishColor(dish));
  return {
    className: `dish-tint ${className}`,
    style: { "--dish-tint-light": light, "--dish-tint-dark": dark } as React.CSSProperties,
  };
}

/** The colour a dish is drawn in: its own if it has one, else its course's. */
export function resolveDishColor(dish: ColorableDish | undefined | null): string {
  if (!dish) return UNKNOWN_COLOR;
  return normalizeHex(dish.color) ?? COURSE_COLOR[dish.component ?? ""] ?? UNKNOWN_COLOR;
}

/** Shortest distance between two hues, in degrees (0–180). */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Below this saturation a colour reads as grey and its hue means nothing. */
const GREY_SAT = 15;

/**
 * Close enough that two 3px rails read as the same colour. Hue AND lightness
 * both have to be near: two greens far apart in lightness stay tellable, and
 * comparing hue alone flagged those as clashes.
 */
export function colorsTooClose(a: string, b: string): boolean {
  const A = hexToHsl(a);
  const B = hexToHsl(b);
  if (A.s <= GREY_SAT || B.s <= GREY_SAT) {
    // Two greys differ only by how dark they are.
    return Math.abs(A.s - B.s) <= GREY_SAT && Math.abs(A.l - B.l) <= 12;
  }
  return hueGap(A.h, B.h) <= 20 && Math.abs(A.l - B.l) <= 18;
}

/**
 * The dish this colour would be mistaken for, or null. Only dishes carrying an
 * explicit colour are compared — a course fallback is shared by design and
 * warning about it would fire on almost every save.
 *
 * An EXACTLY equal colour is not a near miss: colouring every paneer dish the
 * same purple is a legitimate thing to want, and the accident this catches is
 * the near-identical one.
 */
export function nearMissDish(
  color: string | null | undefined,
  dishes: Dish[],
  selfId: string | null,
): Dish | null {
  const hex = normalizeHex(color);
  if (!hex) return null;
  return dishes.find((d) => {
    if (d.id === selfId || !d.isActive) return false;
    const other = normalizeHex(d.color);
    return !!other && other !== hex && colorsTooClose(hex, other);
  }) ?? null;
}

/**
 * The dish's colour, as a thin rail before its name.
 *
 * A rail rather than a second dot: PrepDot already owns the dot shape on this
 * line, and two dots side by side read as noise. It costs 5px of a ~120px week
 * cell, which a tinted pill behind the name would not — that truncates dish
 * names, and the name is the thing being read.
 *
 * Decorative: every rail sits beside the dish's own name, so the colour is never
 * the only carrier of anything.
 *
 * Lives here rather than beside PrepDot in plate-composer because the public
 * shared-menu page renders it too, and that page must not pull the whole plate
 * composer into its bundle.
 */
export function DishRail({ dish, className = "h-3.5" }: {
  dish: ColorableDish | undefined;
  className?: string;
}) {
  const { light, dark } = railColors(resolveDishColor(dish));
  return (
    <span
      aria-hidden
      className={`dish-rail inline-block w-1 shrink-0 rounded-full ${className}`}
      style={{ "--dish-rail-light": light, "--dish-rail-dark": dark } as React.CSSProperties}
    />
  );
}
