import { describe, it, expect } from "vitest";
import type { RecurrenceRule } from "@workspace/db";
import {
  addExdate,
  describeRule,
  endRuleBefore,
  enumerateFromRule,
  legacyToRule,
  previousDateKey,
  removeExdate,
  ruleToLegacy,
  ruleToWindowEnd,
  validateRule,
} from "../audit-recurrence.js";

/** Local Date from a YYYY-MM-DD (+ optional HH:mm), avoiding UTC parsing. */
function d(iso: string, time = "00:00"): Date {
  const [y, m, day] = iso.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y!, m! - 1, day!, h!, min!, 0, 0);
}

/** Upper bound that includes the whole named day, occurrence times and all. */
const endOfDay = (iso: string) => d(iso, "23:59");

const keys = (dates: Date[]) =>
  dates.map((x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`);

const NEVER = { kind: "NEVER" } as const;
const WIDE_FROM = d("2000-01-01");
const rule = (r: Partial<RecurrenceRule>): RecurrenceRule =>
  ({ freq: "DAILY", interval: 1, end: NEVER, ...r }) as RecurrenceRule;

describe("enumerateFromRule — NONE", () => {
  it("emits exactly one occurrence at the start", () => {
    const out = enumerateFromRule(rule({ freq: "NONE" }), "09:00", d("2026-08-07"), WIDE_FROM, d("2027-01-01"));
    expect(keys(out)).toEqual(["2026-08-07"]);
    expect(out[0]!.getHours()).toBe(9);
  });

  it("is empty once the window has passed it", () => {
    const out = enumerateFromRule(rule({ freq: "NONE" }), "09:00", d("2026-08-07"), d("2026-08-08"), d("2027-01-01"));
    expect(out).toEqual([]);
  });
});

describe("enumerateFromRule — DAILY", () => {
  it("steps by the interval, uncapped beyond the old 6-day limit", () => {
    const out = enumerateFromRule(rule({ interval: 10 }), "09:00", d("2026-08-07"), WIDE_FROM, d("2026-09-07"));
    expect(keys(out)).toEqual(["2026-08-07", "2026-08-17", "2026-08-27", "2026-09-06"]);
  });

  it("holds the time of day across a month boundary", () => {
    const out = enumerateFromRule(rule({ interval: 1 }), "17:30", d("2026-08-30"), WIDE_FROM, d("2026-09-02"));
    expect(out.every((x) => x.getHours() === 17 && x.getMinutes() === 30)).toBe(true);
  });
});

describe("enumerateFromRule — WEEKLY", () => {
  it("fires on every selected weekday (Mon+Wed+Fri)", () => {
    // 2026-08-07 is a Friday.
    const out = enumerateFromRule(
      rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 3, 5] }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      endOfDay("2026-08-21"),
    );
    expect(keys(out)).toEqual([
      "2026-08-07", "2026-08-10", "2026-08-12", "2026-08-14",
      "2026-08-17", "2026-08-19", "2026-08-21",
    ]);
  });

  it("never emits a selected weekday that falls before the start", () => {
    // Monday 2026-08-03 precedes a Friday start in the same week.
    const out = enumerateFromRule(
      rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 5] }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      d("2026-08-12"),
    );
    expect(keys(out)).toEqual(["2026-08-07", "2026-08-10"]);
  });

  it("skips whole weeks when the interval is > 1", () => {
    const out = enumerateFromRule(
      rule({ freq: "WEEKLY", interval: 2, byWeekday: [5] }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      d("2026-09-20"),
    );
    expect(keys(out)).toEqual(["2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18"]);
  });

  it("expresses 'every weekday' as Mon–Fri", () => {
    const out = enumerateFromRule(
      rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 2, 3, 4, 5] }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      endOfDay("2026-08-14"),
    );
    expect(keys(out)).toEqual([
      "2026-08-07", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
    ]);
  });
});

describe("enumerateFromRule — MONTHLY", () => {
  it("clamps a day-31 rule into short months rather than skipping them", () => {
    const out = enumerateFromRule(
      rule({ freq: "MONTHLY", interval: 1, byMonthDay: 31 }),
      "09:00",
      d("2026-01-31"),
      WIDE_FROM,
      d("2026-05-01"),
    );
    expect(keys(out)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("resolves the last day of the month for byMonthDay = -1", () => {
    const out = enumerateFromRule(
      rule({ freq: "MONTHLY", interval: 1, byMonthDay: -1 }),
      "09:00",
      d("2028-01-31"),
      WIDE_FROM,
      d("2028-04-01"),
    );
    // 2028 is a leap year — February resolves to the 29th.
    expect(keys(out)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  });

  it("resolves the nth weekday of the month (first Friday)", () => {
    const out = enumerateFromRule(
      rule({ freq: "MONTHLY", interval: 1, bySetPos: 1, byWeekday: [5] }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      d("2026-11-30"),
    );
    expect(keys(out)).toEqual(["2026-08-07", "2026-09-04", "2026-10-02", "2026-11-06"]);
  });

  it("resolves the last weekday of the month", () => {
    const out = enumerateFromRule(
      rule({ freq: "MONTHLY", interval: 1, bySetPos: -1, byWeekday: [1] }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      d("2026-10-31"),
    );
    expect(keys(out)).toEqual(["2026-08-31", "2026-09-28", "2026-10-26"]);
  });

  it("steps quarterly when the interval is 3", () => {
    const out = enumerateFromRule(
      rule({ freq: "MONTHLY", interval: 3, byMonthDay: 15 }),
      "09:00",
      d("2026-01-15"),
      WIDE_FROM,
      d("2027-01-01"),
    );
    expect(keys(out)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });
});

describe("enumerateFromRule — YEARLY", () => {
  it("fires annually on the anchored month and day", () => {
    const out = enumerateFromRule(
      rule({ freq: "YEARLY", interval: 1, byMonth: 8, byMonthDay: 7 }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      d("2029-01-01"),
    );
    expect(keys(out)).toEqual(["2026-08-07", "2027-08-07", "2028-08-07"]);
  });
});

describe("enumerateFromRule — end conditions", () => {
  it("NEVER runs to the end of the requested range", () => {
    const out = enumerateFromRule(rule({ interval: 1 }), "09:00", d("2026-08-01"), WIDE_FROM, endOfDay("2026-08-05"));
    expect(out).toHaveLength(5);
  });

  it("ON stops at the end of the named day, inclusive", () => {
    const out = enumerateFromRule(
      rule({ interval: 1, end: { kind: "ON", date: "2026-08-03" } }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      d("2026-12-31"),
    );
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("AFTER stops after N occurrences", () => {
    const out = enumerateFromRule(
      rule({ interval: 1, end: { kind: "AFTER", count: 3 } }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      d("2026-12-31"),
    );
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("counts AFTER from the series start, not from the query window", () => {
    // The materializer asks about a sliding window near the horizon. If COUNT
    // were applied from `fromExclusive`, the series would never terminate.
    const r = rule({ interval: 1, end: { kind: "AFTER", count: 3 } });
    const out = enumerateFromRule(r, "09:00", d("2026-08-01"), d("2026-08-02", "23:59"), d("2026-12-31"));
    expect(keys(out)).toEqual(["2026-08-03"]);

    const past = enumerateFromRule(r, "09:00", d("2026-08-01"), d("2026-08-10"), d("2026-12-31"));
    expect(past).toEqual([]);
  });

  it("AFTER counts weekly occurrences across weekday expansion", () => {
    const out = enumerateFromRule(
      rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 3, 5], end: { kind: "AFTER", count: 4 } }),
      "09:00",
      d("2026-08-03"),
      WIDE_FROM,
      d("2026-12-31"),
    );
    expect(keys(out)).toEqual(["2026-08-03", "2026-08-05", "2026-08-07", "2026-08-10"]);
  });
});

describe("enumerateFromRule — exclusions", () => {
  it("omits excluded dates", () => {
    const out = enumerateFromRule(
      rule({ interval: 1, exdates: ["2026-08-02", "2026-08-04"] }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      endOfDay("2026-08-05"),
    );
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-03", "2026-08-05"]);
  });

  it("still consumes an AFTER slot for an excluded date (RFC 5545)", () => {
    const out = enumerateFromRule(
      rule({ interval: 1, end: { kind: "AFTER", count: 3 }, exdates: ["2026-08-02"] }),
      "09:00",
      d("2026-08-01"),
      WIDE_FROM,
      d("2026-12-31"),
    );
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-03"]);
  });
});

describe("enumerateFromRule — CRON", () => {
  it("matches a weekday-morning expression", () => {
    const out = enumerateFromRule(
      rule({ freq: "CRON", cron: "0 9 * * 1-5" }),
      "09:00",
      d("2026-08-07"),
      WIDE_FROM,
      d("2026-08-11", "23:59"),
    );
    expect(keys(out)).toEqual(["2026-08-07", "2026-08-10", "2026-08-11"]);
  });
});

describe("legacyToRule — pre-rule rows keep their occurrences", () => {
  const base = { intervalDays: null, dayOfWeek: null, cron: null, windowEnd: null };

  it("maps EVERY_N_DAYS", () => {
    const r = legacyToRule({ ...base, frequency: "EVERY_N_DAYS", intervalDays: 3, windowStart: d("2026-08-01") });
    expect(r).toMatchObject({ freq: "DAILY", interval: 3 });
  });

  it("maps FORTNIGHTLY to the windowStart weekday, ignoring dayOfWeek as the old engine did", () => {
    const r = legacyToRule({ ...base, frequency: "FORTNIGHTLY", dayOfWeek: 2, windowStart: d("2026-08-07") });
    expect(r).toMatchObject({ freq: "WEEKLY", interval: 2, byWeekday: [5] }); // Friday
  });

  it("maps QUARTERLY to a 3-month rule anchored on the start day", () => {
    const r = legacyToRule({ ...base, frequency: "QUARTERLY", windowStart: d("2026-02-15") });
    expect(r).toMatchObject({ freq: "MONTHLY", interval: 3, byMonthDay: 15 });
  });

  it("maps ANNUALLY to a yearly rule on the start month and day", () => {
    const r = legacyToRule({ ...base, frequency: "ANNUALLY", windowStart: d("2026-08-07") });
    expect(r).toMatchObject({ freq: "YEARLY", interval: 1, byMonth: 8, byMonthDay: 7 });
  });

  it("turns windowEnd into an ON end condition", () => {
    const r = legacyToRule({ ...base, frequency: "MONTHLY", windowStart: d("2026-01-10"), windowEnd: d("2026-06-30") });
    expect(r.end).toEqual({ kind: "ON", date: "2026-06-30" });
  });

  it("reproduces the old monthly clamp for a 31st anchor", () => {
    const r = legacyToRule({ ...base, frequency: "MONTHLY", windowStart: d("2026-01-31") });
    const out = enumerateFromRule(r, "09:00", d("2026-01-31"), WIDE_FROM, d("2026-04-01"));
    expect(keys(out)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });
});

describe("ruleToLegacy — keeps the NOT NULL frequency column meaningful", () => {
  it("round-trips the cadence buckets", () => {
    expect(ruleToLegacy(rule({ freq: "DAILY", interval: 2 })).frequency).toBe("EVERY_N_DAYS");
    expect(ruleToLegacy(rule({ freq: "WEEKLY", interval: 1, byWeekday: [5] })).frequency).toBe("WEEKLY");
    expect(ruleToLegacy(rule({ freq: "WEEKLY", interval: 2, byWeekday: [5] })).frequency).toBe("FORTNIGHTLY");
    expect(ruleToLegacy(rule({ freq: "MONTHLY", interval: 3 })).frequency).toBe("QUARTERLY");
    expect(ruleToLegacy(rule({ freq: "MONTHLY", interval: 6 })).frequency).toBe("HALF_YEARLY");
    expect(ruleToLegacy(rule({ freq: "YEARLY", interval: 1 })).frequency).toBe("ANNUALLY");
    expect(ruleToLegacy(rule({ freq: "NONE" })).frequency).toBe("NONE");
  });
});

describe("validateRule", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRule(rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 3] }))).toBeNull();
  });

  it("rejects a weekly rule with no weekday", () => {
    expect(validateRule(rule({ freq: "WEEKLY", interval: 1, byWeekday: [] }))).toMatch(/weekday/i);
  });

  it("rejects an out-of-range interval", () => {
    expect(validateRule(rule({ interval: 0 }))).toMatch(/interval/i);
    expect(validateRule(rule({ interval: 400 }))).toMatch(/interval/i);
  });

  it("rejects a bad nth-weekday position", () => {
    expect(validateRule(rule({ freq: "MONTHLY", interval: 1, bySetPos: 7, byWeekday: [1] }))).toMatch(/1st/i);
  });

  it("rejects a cron rule that ends after N occurrences", () => {
    expect(
      validateRule(rule({ freq: "CRON", cron: "0 9 * * *", end: { kind: "AFTER", count: 5 } })),
    ).toMatch(/cron/i);
  });

  it("rejects a malformed end date", () => {
    expect(validateRule(rule({ end: { kind: "ON", date: "next friday" } }))).toMatch(/YYYY-MM-DD/);
  });
});

describe("describeRule", () => {
  it("names the calendar presets the way the picker does", () => {
    expect(describeRule(rule({ freq: "NONE" }))).toBe("Does not repeat");
    expect(describeRule(rule({ freq: "DAILY", interval: 1 }))).toBe("Daily");
    expect(describeRule(rule({ freq: "WEEKLY", interval: 1, byWeekday: [5] }))).toBe("Every week on Friday");
    expect(describeRule(rule({ freq: "WEEKLY", interval: 1, byWeekday: [1, 2, 3, 4, 5] }))).toBe(
      "Every weekday (Monday to Friday)",
    );
    expect(describeRule(rule({ freq: "MONTHLY", interval: 1, bySetPos: 1, byWeekday: [5] }))).toBe(
      "Every month on the first Friday",
    );
  });

  it("appends the end condition", () => {
    expect(describeRule(rule({ interval: 1, end: { kind: "AFTER", count: 5 } }))).toBe("Daily, 5 times");
    expect(describeRule(rule({ interval: 1, end: { kind: "ON", date: "2026-12-31" } }))).toBe(
      "Daily, until 2026-12-31",
    );
  });
});

describe("per-occurrence edits", () => {
  const daily = (over: Partial<RecurrenceRule> = {}) =>
    rule({ freq: "DAILY", interval: 1, ...over });

  it("previousDateKey steps back across a month boundary", () => {
    expect(previousDateKey("2026-08-01")).toBe("2026-07-31");
    expect(previousDateKey("2028-03-01")).toBe("2028-02-29"); // leap year
    expect(previousDateKey("not-a-date")).toBeNull();
  });

  it("addExdate removes just that occurrence and keeps the rest", () => {
    const skipped = addExdate(daily(), "2026-08-03");
    const out = enumerateFromRule(skipped, "09:00", d("2026-08-01"), WIDE_FROM, endOfDay("2026-08-05"));
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-02", "2026-08-04", "2026-08-05"]);
  });

  it("addExdate is idempotent and keeps the list sorted", () => {
    const once = addExdate(daily(), "2026-08-03");
    const twice = addExdate(addExdate(once, "2026-08-01"), "2026-08-03");
    expect(twice.exdates).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("removeExdate restores the occurrence", () => {
    const restored = removeExdate(addExdate(daily(), "2026-08-03"), "2026-08-03");
    const out = enumerateFromRule(restored, "09:00", d("2026-08-01"), WIDE_FROM, endOfDay("2026-08-03"));
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("endRuleBefore truncates the series to the day before the split", () => {
    const truncated = endRuleBefore(daily(), "2026-08-04");
    expect(truncated.end).toEqual({ kind: "ON", date: "2026-08-03" });
    const out = enumerateFromRule(truncated, "09:00", d("2026-08-01"), WIDE_FROM, endOfDay("2026-08-10"));
    expect(keys(out)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("endRuleBefore converts an AFTER end, so the tail moves to the successor", () => {
    const truncated = endRuleBefore(daily({ end: { kind: "AFTER", count: 10 } }), "2026-08-04");
    expect(truncated.end).toEqual({ kind: "ON", date: "2026-08-03" });
  });

  it("endRuleBefore never extends a series that already stops earlier", () => {
    const already = daily({ end: { kind: "ON", date: "2026-08-02" } });
    expect(endRuleBefore(already, "2026-08-10").end).toEqual({ kind: "ON", date: "2026-08-02" });
  });

  it("a split covers the original series exactly once, with no gap or overlap", () => {
    // "This and following" from 2026-08-04: the head stops on the 3rd and the
    // tail starts on the 4th, so together they reproduce the whole series.
    const head = endRuleBefore(daily(), "2026-08-04");
    const headOut = enumerateFromRule(head, "09:00", d("2026-08-01"), WIDE_FROM, endOfDay("2026-08-06"));
    const tailOut = enumerateFromRule(daily(), "09:00", d("2026-08-04"), WIDE_FROM, endOfDay("2026-08-06"));
    expect([...keys(headOut), ...keys(tailOut)]).toEqual([
      "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
    ]);
  });
});

describe("date-only persistence", () => {
  it("ruleToWindowEnd stores the named calendar date, not a shifted instant", () => {
    // `timestamp` columns here hold UTC wall-clock. Building local midnight in a
    // positive-offset timezone (the deployment pins TZ=Asia/Kolkata) would
    // serialise to the PREVIOUS day and silently move the end date.
    const end = ruleToWindowEnd(rule({ end: { kind: "ON", date: "2026-08-18" } }))!;
    expect(end.toISOString()).toBe("2026-08-18T00:00:00.000Z");
  });

  it("is null for open-ended rules", () => {
    expect(ruleToWindowEnd(rule({ end: { kind: "NEVER" } }))).toBeNull();
    expect(ruleToWindowEnd(rule({ end: { kind: "AFTER", count: 5 } }))).toBeNull();
  });
});
