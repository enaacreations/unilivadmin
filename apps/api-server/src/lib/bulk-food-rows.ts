/**
 * Row shapes for the food master-data bulk imports (POST /bulk/dishes and
 * /bulk/ingredients).
 *
 * Everything arriving from a .csv/.xlsx is a string: enum values come in
 * whatever case the author typed, booleans as words, and a list of brands or
 * ingredients as one comma-separated cell. These schemas do that coercion so
 * the route handlers only deal with cross-row concerns (resolving names to
 * ids, rejecting duplicates).
 *
 * The schemas mirror the single-create handlers in routes/food.ts; anything
 * that needs a database lookup is deliberately left to the handler.
 */
import { z } from "zod";
import { dishComponentEnum, measurementUnitEnum, mealTypeEnum } from "@workspace/db";

/** `curd raita` / `Curd-Raita` -> `CURD_RAITA`. */
export const normalizeToken = (s: string): string =>
  s.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** Accepts any casing/spacing of a SCREAMING_SNAKE enum member. */
function enumLike<T extends string>(values: readonly [T, ...T[]], label: string) {
  return z.preprocess(
    (v) => (typeof v === "string" ? normalizeToken(v) : v),
    z.enum(values, { errorMap: () => ({ message: `${label} must be one of: ${values.join(", ")}` }) }),
  );
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "active"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "inactive"]);

/**
 * Boolean from a spreadsheet cell. Blank -> undefined, so the caller's default
 * applies. Deliberately not `z.coerce.boolean()`, which reads the string
 * "false" as true — the one answer someone filling in a template expects to
 * work.
 */
const csvBool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "") return undefined;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return v; // unrecognised word -> let z.boolean() reject the row
}, z.boolean().optional());

/** One cell holding a list: "Aloo, Pyaaz" -> ["Aloo", "Pyaaz"]. Blank -> []. */
export function splitList(v: unknown): string[] {
  const parts = typeof v === "string" ? v.split(/[,;|]/)
    : Array.isArray(v) ? v.map((x) => String(x))
    : v == null || v === "" ? []
    : [String(v)];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Mirrors POST /api/food/ingredients. */
export const ingredientRowSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(1000),
  unit: enumLike(measurementUnitEnum.enumValues, "unit"),
  isActive: csvBool,
});

/**
 * Mirrors POST /api/food/dishes, minus side options — pairing a dish with its
 * accompaniments relates two catalogue rows, which a flat sheet can't express
 * while the sides may themselves be later rows of the same import. Sides stay
 * in the dish drawer.
 *
 * `brands`, `preparations` and `ingredients` are one comma-separated cell each
 * and are validated in the handler, which has the master lists to check against.
 */
export const dishRowSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(1000),
  component: enumLike(dishComponentEnum.enumValues, "component"),
  unit: enumLike(measurementUnitEnum.enumValues, "unit"),
  brands: z.unknown().optional(),
  preparations: z.unknown().optional(),
  ingredients: z.unknown().optional(),
  photoUrl: z.string().max(2048).nullish(),
  isActive: csvBool,
  isQtyLocked: csvBool,
});

/** food_menu_rotation.dayOfWeek is 1-based Monday..Sunday. */
const DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** "MON" / "Monday" / "1" -> 1..7. Null when the cell is not a day. */
export function parseDay(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
  if (typeof v !== "string") return null;
  const s = normalizeToken(v);
  const i = DAY_NAMES.findIndex((d) => s === d || s.startsWith(d));
  return i >= 0 ? i + 1 : null;
}

/** The 4-week cycle the board renders — see ROTATION_WEEKS in menu-lib.ts. */
const ROTATION_WEEKS = [1, 2, 3, 4] as const;

/**
 * One line of the menu rotation: a single dish in one (kitchen, brand, week,
 * day, meal) slot, with the accompaniments chosen for it.
 *
 * Deliberately one row per DISH, not per slot: it is the shape the rotation is
 * already stored and exported in, and a slot's sides belong to a specific dish,
 * which a single "dishes" cell could not express. Rows are grouped back into
 * slots by the importer.
 */
export const menuRowSchema = z.object({
  kitchen: z.string().trim().min(1, "kitchen is required").max(256),
  brand: z.string().trim().min(1, "brand is required").max(128),
  week: z.coerce.number().int().refine(
    (w) => (ROTATION_WEEKS as readonly number[]).includes(w),
    { message: `week must be one of: ${ROTATION_WEEKS.join(", ")}` },
  ),
  day: z.preprocess(
    (v) => parseDay(v) ?? v,
    z.number({ errorMap: () => ({ message: "day must be Mon–Sun or 1–7" }) }).int().min(1).max(7),
  ),
  meal: enumLike(mealTypeEnum.enumValues, "meal"),
  dish: z.string().trim().min(1, "dish is required").max(1000),
  slotLabel: z.string().max(256).nullish(),
  sides: z.unknown().optional(),
});

export type IngredientRow = z.infer<typeof ingredientRowSchema>;
export type DishRow = z.infer<typeof dishRowSchema>;
export type MenuRow = z.infer<typeof menuRowSchema>;
