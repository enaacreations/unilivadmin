/**
 * Rules 3 and 4 — the two variety flags, and how they differ from the window.
 *
 * The reason these are separate switches rather than settings on the existing
 * ±N-day window is arithmetic, and it is worth pinning rather than re-deriving:
 * `cycleGap` measures the SHORT way round a 28-day circle, so in a 4-week
 * rotation the six same-weekday pairs sit at gaps of 7 and 14 —
 *
 *   W1↔W2: 7    W1↔W3: 14   W1↔W4: 7   (W4 Mon is 7 days before the next cycle)
 *   W2↔W3: 7    W2↔W4: 14   W3↔W4: 7
 *
 * — so no window value means "same weekday only": 4 catches none of them, 7
 * catches four of six and 12 unrelated cells besides, and 14 catches every cell
 * in the cycle. The first describe below pins exactly that, because it is the
 * claim the whole design rests on.
 *
 * All three rules are HINTS. Nothing on the save path reads them.
 */
import { describe, expect, it } from "vitest";
import {
  REPEAT_WITHIN_DAYS_MAX, anyRepeatRuleOn, cellRepeats, cycleGap, cycleIndex, cycleKey,
  type CycleCells, type RepeatRuleSet,
} from "../menu-lib";

const WINDOW_ONLY = (withinDays: number): RepeatRuleSet =>
  ({ withinDays, sameWeek: false, sameWeekday: false });
const SAME_WEEK: RepeatRuleSet = { withinDays: null, sameWeek: true, sameWeekday: false };
const SAME_WEEKDAY: RepeatRuleSet = { withinDays: null, sameWeek: false, sameWeekday: true };

/** Put `dishId` on (week, day) for a meal (LUNCH unless stated). */
const cells = (
  ...at: Array<[week: number, day: number, dishId: string, meal?: string]>
): CycleCells => {
  const m: CycleCells = new Map();
  for (const [w, d, id, meal] of at) {
    const k = cycleKey(w, d, meal ?? "LUNCH");
    m.set(k, [...(m.get(k) ?? []), id]);
  }
  return m;
};
const flagged = (c: CycleCells, week: number, day: number, rules: RepeatRuleSet) =>
  cellRepeats(c, week, day, "LUNCH", rules).map((r) => r.dishId);

describe("why the window cannot express rule 4", () => {
  it("puts every same-weekday pair at a gap of 7 or 14", () => {
    const gaps = [];
    for (let a = 1; a <= 4; a++) for (let b = a + 1; b <= 4; b++)
      gaps.push(cycleGap(cycleIndex(a, 1), cycleIndex(b, 1)));
    expect(gaps).toEqual([7, 14, 7, 7, 14, 7]);
  });

  it("catches NONE of them at a 4-day window", () => {
    const c = cells([1, 5, "paneer"], [2, 5, "paneer"], [3, 5, "paneer"], [4, 5, "paneer"]);
    expect(flagged(c, 1, 5, WINDOW_ONLY(4))).toEqual([]);
  });

  it("still misses the two-weeks-apart pair at a 7-day window", () => {
    // W1 Fri vs W3 Fri is gap 14 — outside 7, so the pair the client's example
    // is about (same Friday, a fortnight later) goes unflagged.
    const c = cells([1, 5, "paneer"], [3, 5, "paneer"]);
    expect(flagged(c, 1, 5, WINDOW_ONLY(7))).toEqual([]);
    expect(flagged(c, 1, 5, SAME_WEEKDAY)).toEqual(["paneer"]);
  });

  it("only reaches all of them at the maximum, where it flags everything", () => {
    const c = cells([1, 5, "paneer"], [3, 5, "paneer"], [1, 2, "paneer"]);
    expect(flagged(c, 1, 5, WINDOW_ONLY(REPEAT_WITHIN_DAYS_MAX))).toEqual(["paneer"]);
    // …but it has also swept in the Tuesday, which rule 4 says nothing about.
    const onlyTuesday = cells([1, 5, "paneer"], [1, 2, "paneer"]);
    expect(flagged(onlyTuesday, 1, 5, WINDOW_ONLY(REPEAT_WITHIN_DAYS_MAX))).toEqual(["paneer"]);
    expect(flagged(onlyTuesday, 1, 5, SAME_WEEKDAY)).toEqual([]);
  });
});

describe("rule 3 — no repeat within the same week", () => {
  it("flags a dish used twice in one rotation week", () => {
    const c = cells([1, 1, "dal"], [1, 6, "dal"]); // Mon and Sat, 5 days apart
    expect(flagged(c, 1, 1, SAME_WEEK)).toEqual(["dal"]);
  });

  it("ignores the same dish in a DIFFERENT week", () => {
    const c = cells([1, 1, "dal"], [2, 3, "dal"]);
    expect(flagged(c, 1, 1, SAME_WEEK)).toEqual([]);
  });

  /* The window can't stand in for this: a 3-day window misses Mon↔Sat inside
   * one week, and a 6-day window reaches into the next week. */
  it("catches an in-week pair the default window misses", () => {
    const c = cells([1, 1, "dal"], [1, 6, "dal"]);
    expect(flagged(c, 1, 1, WINDOW_ONLY(3))).toEqual([]);
    expect(flagged(c, 1, 1, SAME_WEEK)).toEqual(["dal"]);
  });

  it("does not flag a dish against itself", () => {
    expect(flagged(cells([1, 1, "dal"]), 1, 1, SAME_WEEK)).toEqual([]);
  });
});

describe("rule 4 — no repeat on the same weekday", () => {
  it("flags the client's example: Friday, then Friday again", () => {
    const c = cells([1, 5, "paneer"], [3, 5, "paneer"]);
    expect(flagged(c, 1, 5, SAME_WEEKDAY)).toEqual(["paneer"]);
  });

  it("reaches every other week, including the wrap-around one", () => {
    for (const w of [2, 3, 4]) {
      const c = cells([1, 5, "paneer"], [w, 5, "paneer"]);
      expect(flagged(c, 1, 5, SAME_WEEKDAY), `W1 vs W${w}`).toEqual(["paneer"]);
    }
  });

  it("ignores a different weekday, however close", () => {
    const c = cells([1, 5, "paneer"], [2, 4, "paneer"]);
    expect(flagged(c, 1, 5, SAME_WEEKDAY)).toEqual([]);
  });

  it("ignores the same weekday in the SAME week — that is the cell itself", () => {
    expect(flagged(cells([1, 5, "paneer"]), 1, 5, SAME_WEEKDAY)).toEqual([]);
  });
});

describe("the three rules compose", () => {
  it("flags the union, not the intersection", () => {
    // All three sit on the cell under test (W1 Mon) — cellRepeats reports a
    // cell's OWN dishes that also appear elsewhere — each with one echo that
    // only one rule can see.
    const c = cells(
      [1, 1, "a"], [1, 1, "b"], [1, 1, "c"],
      [1, 2, "a"],   // Tue, 1 day off Mon      → window only
      [1, 6, "b"],   // Sat, same week          → rule 3 only
      [3, 1, "c"],   // Mon of W3               → rule 4 only
    );
    const all: RepeatRuleSet = { withinDays: 3, sameWeek: true, sameWeekday: true };
    expect(flagged(c, 1, 1, all).sort()).toEqual(["a", "b", "c"]);
    expect(flagged(c, 1, 1, WINDOW_ONLY(3))).toEqual(["a"]);
    expect(flagged(c, 1, 1, SAME_WEEK).sort()).toEqual(["a", "b"]); // Tue is also this week
    expect(flagged(c, 1, 1, SAME_WEEKDAY)).toEqual(["c"]);
  });

  it("is silent with every rule off, without scanning", () => {
    const off: RepeatRuleSet = { withinDays: null, sameWeek: false, sameWeekday: false };
    expect(anyRepeatRuleOn(off)).toBe(false);
    expect(flagged(cells([1, 1, "dal"], [1, 2, "dal"]), 1, 1, off)).toEqual([]);
  });

  it("stays per-meal — a lunch dish is never compared with dinner", () => {
    const c = cells([1, 1, "dal", "LUNCH"], [1, 3, "dal", "DINNER"]);
    const all: RepeatRuleSet = { withinDays: 3, sameWeek: true, sameWeekday: true };
    expect(flagged(c, 1, 1, all)).toEqual([]);
  });

  it("labels where the repeat is: bare day in-week, W-prefixed across weeks", () => {
    const c = cells([1, 1, "dal"], [1, 3, "dal"]);
    expect(cellRepeats(c, 1, 1, "LUNCH", SAME_WEEK)[0]!.where).toBe("Wed");
    const d = cells([1, 5, "paneer"], [3, 5, "paneer"]);
    expect(cellRepeats(d, 1, 5, "LUNCH", SAME_WEEKDAY)[0]!.where).toBe("W3 Fri");
  });
});
