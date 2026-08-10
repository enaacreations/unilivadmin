import { describe, expect, it } from "vitest";
import {
  REPEAT_WITHIN_DAYS,
  REPEAT_WITHIN_DAYS_MAX,
  cellRepeats,
  cycleKey,
  type CycleCells,
} from "../menu-lib";

/** Put `dishId` on (week, day) for LUNCH. */
const cells = (...at: Array<[week: number, day: number, dishId: string]>): CycleCells => {
  const m: CycleCells = new Map();
  for (const [w, d, id] of at) {
    const k = cycleKey(w, d, "LUNCH");
    m.set(k, [...(m.get(k) ?? []), id]);
  }
  return m;
};

const flagged = (c: CycleCells, week: number, day: number, days?: number) =>
  cellRepeats(c, week, day, "LUNCH", days).map((r) => r.dishId);

describe("repeat window", () => {
  it("defaults to the window the rule shipped with", () => {
    expect(REPEAT_WITHIN_DAYS).toBe(3);
  });

  it("flags a dish served inside the window", () => {
    // Mon and Thu of week 1 are 3 days apart.
    const c = cells([1, 1, "dal"], [1, 4, "dal"]);
    expect(flagged(c, 1, 1, 3)).toEqual(["dal"]);
  });

  it("does not flag one served just outside it", () => {
    // Mon and Fri are 4 days apart.
    const c = cells([1, 1, "dal"], [1, 5, "dal"]);
    expect(flagged(c, 1, 1, 3)).toEqual([]);
  });

  it("narrowing the window stops flagging what a wider one caught", () => {
    const c = cells([1, 1, "dal"], [1, 3, "dal"]); // 2 days apart
    expect(flagged(c, 1, 1, 3)).toEqual(["dal"]);
    expect(flagged(c, 1, 1, 1)).toEqual([]);
  });

  it("widening it catches what a narrower one missed", () => {
    const c = cells([1, 1, "dal"], [1, 6, "dal"]); // 5 days apart
    expect(flagged(c, 1, 1, 3)).toEqual([]);
    expect(flagged(c, 1, 1, 5)).toEqual(["dal"]);
  });

  it("measures the gap the short way round the cycle", () => {
    // W4 Sun is the last day of the cycle; W1 Mon is the next day after it.
    const c = cells([4, 7, "dal"], [1, 1, "dal"]);
    expect(flagged(c, 1, 1, 1)).toEqual(["dal"]);
  });

  it("at the widest window flags the dish anywhere else in the cycle", () => {
    // Furthest apart two days can be: 14 the short way round.
    const c = cells([1, 1, "dal"], [3, 1, "dal"]);
    expect(flagged(c, 1, 1, REPEAT_WITHIN_DAYS_MAX)).toEqual(["dal"]);
    expect(flagged(c, 1, 1, 13)).toEqual([]);
  });

  it("never counts a dish as a repeat of itself", () => {
    const c = cells([1, 1, "dal"]);
    expect(flagged(c, 1, 1, REPEAT_WITHIN_DAYS_MAX)).toEqual([]);
  });

  it("only compares the same meal", () => {
    const c: CycleCells = new Map([
      [cycleKey(1, 1, "LUNCH"), ["dal"]],
      [cycleKey(1, 2, "DINNER"), ["dal"]],
    ]);
    expect(flagged(c, 1, 1, 3)).toEqual([]);
  });

  it("falls back to the default window when none is passed", () => {
    const c = cells([1, 1, "dal"], [1, 4, "dal"]); // exactly 3 apart
    expect(cellRepeats(c, 1, 1, "LUNCH").map((r) => r.dishId)).toEqual(["dal"]);
  });
});
