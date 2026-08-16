/**
 * Audit & Inspection — calendar-style recurrence (FRD-SCH-02/03).
 *
 * The scheduling engine used to branch on eight hard-coded cadence buckets.
 * This module replaces that with an RFC 5545-shaped rule stored on the schedule
 * (`audit_schedules.recurrence_json`), while `legacyToRule` maps pre-rule rows
 * so they keep generating byte-identical occurrences.
 *
 * Times are server-local, which the deployment pins to the org timezone via
 * `TZ` in `.env.docker` (NFR-07).
 */
import type { RecurrenceRule } from "@workspace/db";

const DAY_MS = 86_400_000;
/** Bounds the period-stepping loops; far above any real schedule. */
const MAX_STEPS = 20_000;
/** Bounds the CRON minute scan (≈9 months of minutes). */
const MAX_CRON_MINUTES = 400_000;

/* ── Date helpers ──────────────────────────────────────────────────────────── */

export function atTimeOfDay(day: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h ?? 9, m ?? 0, 0, 0);
  return d;
}

/** Local YYYY-MM-DD — the key exclusion dates are matched on. */
export function localDateKey(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Last moment of the local day named by a YYYY-MM-DD string. */
function endOfLocalDay(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/**
 * A date-only value in the form this schema stores them.
 *
 * `timestamp` columns here hold UTC wall-clock — node-postgres serialises Dates
 * to UTC — so a date-only column must be built from `Date.UTC`, not local
 * midnight. Local midnight in a positive-offset timezone serialises to the
 * PREVIOUS day, which silently shifts the date by one.
 */
export function dateOnly(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/** The nth (1–4) or last (-1) `weekday` of a month, or null when it has none. */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  pos: number,
): Date | null {
  const total = daysInMonth(year, month);
  if (pos === -1) {
    for (let d = total; d >= 1; d--) {
      const dt = new Date(year, month, d);
      if (dt.getDay() === weekday) return dt;
    }
    return null;
  }
  let seen = 0;
  for (let d = 1; d <= total; d++) {
    const dt = new Date(year, month, d);
    if (dt.getDay() === weekday) {
      seen += 1;
      if (seen === pos) return dt;
    }
  }
  return null;
}

/* ── Cron (5-field: minute hour dom month dow, with * , - / ) ──────────────── */

export function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      if (rangePart!.includes("-")) {
        const [a, b] = rangePart!.split("-").map(Number);
        lo = a!;
        hi = b!;
      } else {
        lo = hi = Number(rangePart);
      }
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  return (
    cronFieldMatches(minute!, date.getMinutes(), 0, 59) &&
    cronFieldMatches(hour!, date.getHours(), 0, 23) &&
    cronFieldMatches(dom!, date.getDate(), 1, 31) &&
    cronFieldMatches(month!, date.getMonth() + 1, 1, 12) &&
    cronFieldMatches(dow!, date.getDay(), 0, 6)
  );
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((f) => /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/.test(f))
  );
}

/* ── Legacy bridge ─────────────────────────────────────────────────────────── */

export interface LegacyScheduleShape {
  frequency: string;
  intervalDays: number | null;
  dayOfWeek: number | null;
  cron: string | null;
  windowStart: Date;
  windowEnd: Date | null;
}

/**
 * Map a pre-rule row onto an equivalent rule. Deliberately reproduces the old
 * engine's quirks rather than correcting them, so materialization of existing
 * schedules does not shift: FORTNIGHTLY ignores `dayOfWeek` and anchors to the
 * weekday of `windowStart`, and monthly cadences anchor to its day-of-month.
 */
export function legacyToRule(s: LegacyScheduleShape): RecurrenceRule {
  const end: RecurrenceRule["end"] = s.windowEnd
    ? { kind: "ON", date: localDateKey(s.windowEnd) }
    : { kind: "NEVER" };
  const anchorDay = s.windowStart.getDate();

  switch (s.frequency) {
    case "EVERY_N_DAYS":
      return { freq: "DAILY", interval: Math.max(1, s.intervalDays ?? 1), end };
    case "WEEKLY":
      return {
        freq: "WEEKLY",
        interval: 1,
        byWeekday: [s.dayOfWeek ?? s.windowStart.getDay()],
        end,
      };
    case "FORTNIGHTLY":
      return { freq: "WEEKLY", interval: 2, byWeekday: [s.windowStart.getDay()], end };
    case "MONTHLY":
      return { freq: "MONTHLY", interval: 1, byMonthDay: anchorDay, end };
    case "QUARTERLY":
      return { freq: "MONTHLY", interval: 3, byMonthDay: anchorDay, end };
    case "HALF_YEARLY":
      return { freq: "MONTHLY", interval: 6, byMonthDay: anchorDay, end };
    case "ANNUALLY":
      return {
        freq: "YEARLY",
        interval: 1,
        byMonth: s.windowStart.getMonth() + 1,
        byMonthDay: anchorDay,
        end,
      };
    case "CRON":
      return { freq: "CRON", interval: 1, cron: s.cron, end };
    default:
      return { freq: "NONE", interval: 1, end };
  }
}

/** The legacy columns to persist alongside a rule — `frequency` is NOT NULL. */
export function ruleToLegacy(rule: RecurrenceRule): {
  frequency: string;
  intervalDays: number | null;
  dayOfWeek: number | null;
  cron: string | null;
} {
  const dayOfWeek = rule.byWeekday?.length ? rule.byWeekday[0]! : null;
  switch (rule.freq) {
    case "DAILY":
      return { frequency: "EVERY_N_DAYS", intervalDays: rule.interval, dayOfWeek: null, cron: null };
    case "WEEKLY":
      return {
        frequency: rule.interval === 2 ? "FORTNIGHTLY" : "WEEKLY",
        intervalDays: null,
        dayOfWeek,
        cron: null,
      };
    case "MONTHLY":
      return {
        frequency:
          rule.interval === 3 ? "QUARTERLY" : rule.interval === 6 ? "HALF_YEARLY" : "MONTHLY",
        intervalDays: null,
        dayOfWeek,
        cron: null,
      };
    case "YEARLY":
      return { frequency: "ANNUALLY", intervalDays: null, dayOfWeek: null, cron: null };
    case "CRON":
      return { frequency: "CRON", intervalDays: null, dayOfWeek: null, cron: rule.cron ?? null };
    default:
      return { frequency: "NONE", intervalDays: null, dayOfWeek: null, cron: null };
  }
}

/**
 * The `windowEnd` implied by a rule — NEVER and AFTER are open-ended.
 *
 * Denormalised for legacy readers and list queries; the rule's own end governs
 * enumeration, so this is stored as a plain date rather than an instant.
 */
export function ruleToWindowEnd(rule: RecurrenceRule): Date | null {
  return rule.end.kind === "ON" ? dateOnly(rule.end.date) : null;
}

/* ── Validation ────────────────────────────────────────────────────────────── */

/** Returns a human-readable problem, or null when the rule is usable. */
export function validateRule(rule: RecurrenceRule): string | null {
  const FREQS = ["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY", "CRON"];
  if (!FREQS.includes(rule.freq)) return `Unknown recurrence frequency "${rule.freq}"`;

  if (rule.freq !== "NONE" && rule.freq !== "CRON") {
    if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 365) {
      return "Repeat interval must be a whole number between 1 and 365";
    }
  }
  if (rule.freq === "WEEKLY") {
    if (!rule.byWeekday?.length) return "Pick at least one weekday for a weekly recurrence";
    if (rule.byWeekday.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return "Weekdays must be 0 (Sunday) to 6 (Saturday)";
    }
  }
  if (rule.freq === "MONTHLY") {
    if (rule.bySetPos != null) {
      if (![1, 2, 3, 4, -1].includes(rule.bySetPos)) {
        return "Monthly position must be 1st–4th or last";
      }
      if (!rule.byWeekday?.length) return "Pick a weekday for an nth-weekday monthly recurrence";
    } else if (rule.byMonthDay != null) {
      if (rule.byMonthDay !== -1 && (rule.byMonthDay < 1 || rule.byMonthDay > 31)) {
        return "Day of month must be 1–31, or -1 for the last day";
      }
    }
  }
  if (rule.freq === "YEARLY") {
    if (rule.byMonth != null && (rule.byMonth < 1 || rule.byMonth > 12)) {
      return "Month must be 1–12";
    }
    if (rule.byMonthDay != null && rule.byMonthDay !== -1) {
      if (rule.byMonthDay < 1 || rule.byMonthDay > 31) {
        return "Day of month must be 1–31, or -1 for the last day";
      }
    }
  }
  if (rule.freq === "CRON") {
    if (!rule.cron || !isValidCron(rule.cron)) return "Invalid cron expression (5 fields)";
    if (rule.end.kind === "AFTER") {
      // COUNT would require scanning the series from its start minute by minute.
      return "A cron recurrence cannot end after a fixed number of occurrences";
    }
  }

  if (rule.end.kind === "AFTER") {
    if (!Number.isInteger(rule.end.count) || rule.end.count < 1 || rule.end.count > 1000) {
      return "Occurrence count must be a whole number between 1 and 1000";
    }
  }
  if (rule.end.kind === "ON") {
    if (!endOfLocalDay(rule.end.date)) return "End date must be a YYYY-MM-DD date";
  }
  for (const ex of rule.exdates ?? []) {
    if (!endOfLocalDay(ex)) return `Skipped date "${ex}" must be a YYYY-MM-DD date`;
  }
  return null;
}

/* ── Per-occurrence edits ──────────────────────────────────────────────────── */

/** The local date one day before `dateKey` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function previousDateKey(dateKey: string): string | null {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return null;
  const prev = new Date(y, m - 1, d);
  prev.setDate(prev.getDate() - 1);
  return localDateKey(prev);
}

/** Skip a single occurrence — "delete this event" in calendar terms. */
export function addExdate(rule: RecurrenceRule, dateKey: string): RecurrenceRule {
  const exdates = new Set(rule.exdates ?? []);
  exdates.add(dateKey);
  return { ...rule, exdates: [...exdates].sort() };
}

/** Restore a previously skipped occurrence. */
export function removeExdate(rule: RecurrenceRule, dateKey: string): RecurrenceRule {
  const exdates = (rule.exdates ?? []).filter((d) => d !== dateKey);
  return { ...rule, exdates };
}

/**
 * Truncate a rule so its last occurrence falls before `dateKey` — the first
 * half of a calendar "this and following" edit, where the caller then creates a
 * successor schedule starting at `dateKey`.
 *
 * An AFTER end becomes an ON end: the original series no longer runs to its
 * count, and the remaining occurrences belong to the successor.
 */
export function endRuleBefore(rule: RecurrenceRule, dateKey: string): RecurrenceRule {
  const until = previousDateKey(dateKey);
  if (!until) return rule;
  // Never extend a series that already stops earlier.
  if (rule.end.kind === "ON" && rule.end.date <= until) return rule;
  return { ...rule, end: { kind: "ON", date: until } };
}

/* ── Enumeration ───────────────────────────────────────────────────────────── */

/**
 * All occurrence datetimes with `fromExclusive < t <= toInclusive`.
 *
 * The series is always generated from `dtstart`, never from `fromExclusive` —
 * an `end: AFTER` rule has to count from the beginning to know where it stops,
 * and the materializer only ever asks about a sliding window near the horizon.
 * Excluded dates consume a count slot but are not emitted, matching RFC 5545.
 */
export function enumerateFromRule(
  rule: RecurrenceRule,
  timeOfDay: string,
  dtstart: Date,
  fromExclusive: Date,
  toInclusive: Date,
): Date[] {
  const until = rule.end.kind === "ON" ? endOfLocalDay(rule.end.date) : null;
  const hardEnd = until && until < toInclusive ? until : toInclusive;
  const seriesStart = atTimeOfDay(dtstart, timeOfDay);
  if (seriesStart > hardEnd) return [];

  const maxCount = rule.end.kind === "AFTER" ? Math.max(1, rule.end.count) : Infinity;
  const exdates = new Set(rule.exdates ?? []);
  const out: Date[] = [];
  let generated = 0;

  /** Record an occurrence; returns false once the series is exhausted. */
  const emit = (d: Date): boolean => {
    if (d < seriesStart) return true; // before DTSTART — not an occurrence yet
    if (d > hardEnd) return false;
    generated += 1;
    if (generated > maxCount) return false;
    if (d > fromExclusive && !exdates.has(localDateKey(d))) out.push(d);
    return generated < maxCount;
  };

  if (rule.freq === "NONE") {
    emit(seriesStart);
    return out;
  }

  if (rule.freq === "CRON") {
    if (!rule.cron) return out;
    const cursor = new Date(Math.max(seriesStart.getTime(), fromExclusive.getTime()));
    cursor.setSeconds(0, 0);
    let scanned = 0;
    for (let t = cursor.getTime(); t <= hardEnd.getTime(); t += 60_000) {
      if (++scanned > MAX_CRON_MINUTES) break;
      const d = new Date(t);
      if (cronMatches(rule.cron, d) && !emit(d)) break;
    }
    return out;
  }

  const interval = Math.max(1, Math.floor(rule.interval || 1));

  if (rule.freq === "DAILY") {
    let d = new Date(seriesStart);
    for (let i = 0; i < MAX_STEPS && d <= hardEnd; i++) {
      if (!emit(d)) break;
      d = atTimeOfDay(new Date(d.getTime() + interval * DAY_MS), timeOfDay);
    }
    return out;
  }

  if (rule.freq === "WEEKLY") {
    const weekdays = [...new Set(rule.byWeekday?.length ? rule.byWeekday : [seriesStart.getDay()])]
      .filter((d) => d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (!weekdays.length) return out;

    // Anchor to the Sunday of the week containing DTSTART, then step whole weeks.
    let weekStart = new Date(seriesStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    for (let i = 0; i < MAX_STEPS; i++) {
      let exhausted = false;
      for (const wd of weekdays) {
        const d = atTimeOfDay(
          new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd),
          timeOfDay,
        );
        if (!emit(d)) {
          exhausted = true;
          break;
        }
      }
      if (exhausted) break;
      weekStart = new Date(
        weekStart.getFullYear(),
        weekStart.getMonth(),
        weekStart.getDate() + interval * 7,
      );
      if (atTimeOfDay(weekStart, timeOfDay) > hardEnd) break;
    }
    return out;
  }

  if (rule.freq === "MONTHLY") {
    let year = seriesStart.getFullYear();
    let month = seriesStart.getMonth();
    for (let i = 0; i < MAX_STEPS; i++) {
      const d = monthlyOccurrence(year, month, rule, seriesStart, timeOfDay);
      // A missing nth-weekday (e.g. a 5th Monday) simply skips that month.
      if (d && !emit(d)) break;
      month += interval;
      year += Math.floor(month / 12);
      month = ((month % 12) + 12) % 12;
      if (new Date(year, month, 1) > hardEnd) break;
    }
    return out;
  }

  if (rule.freq === "YEARLY") {
    const month = (rule.byMonth ?? seriesStart.getMonth() + 1) - 1;
    const wanted = rule.byMonthDay ?? seriesStart.getDate();
    for (let year = seriesStart.getFullYear(), i = 0; i < MAX_STEPS; year += interval, i++) {
      const dim = daysInMonth(year, month);
      const day = wanted === -1 ? dim : Math.min(wanted, dim);
      const d = atTimeOfDay(new Date(year, month, day), timeOfDay);
      if (d > hardEnd) break;
      if (!emit(d)) break;
    }
    return out;
  }

  return out;
}

function monthlyOccurrence(
  year: number,
  month: number,
  rule: RecurrenceRule,
  seriesStart: Date,
  timeOfDay: string,
): Date | null {
  if (rule.bySetPos != null && rule.byWeekday?.length) {
    const dt = nthWeekdayOfMonth(year, month, rule.byWeekday[0]!, rule.bySetPos);
    return dt ? atTimeOfDay(dt, timeOfDay) : null;
  }
  const dim = daysInMonth(year, month);
  const wanted = rule.byMonthDay ?? seriesStart.getDate();
  // CLAMP, not RFC's SKIP — "day 31" fires on 28 Feb. See the schema comment.
  const day = wanted === -1 ? dim : Math.min(wanted, dim);
  return atTimeOfDay(new Date(year, month, day), timeOfDay);
}

/* ── Description ───────────────────────────────────────────────────────────── */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** Human sentence for a rule, e.g. "Monthly on the first Friday, until 31 Dec". */
export function describeRule(rule: RecurrenceRule): string {
  const every = rule.interval > 1 ? `${rule.interval} ` : "";
  let base: string;
  switch (rule.freq) {
    case "NONE":
      return "Does not repeat";
    case "CRON":
      return `Cron: ${rule.cron ?? "—"}`;
    case "DAILY":
      base = rule.interval > 1 ? `Every ${rule.interval} days` : "Daily";
      break;
    case "WEEKLY": {
      const days = (rule.byWeekday ?? []).map((d) => WEEKDAY_NAMES[d] ?? "?");
      const isWeekdays =
        days.length === 5 && [1, 2, 3, 4, 5].every((d) => rule.byWeekday?.includes(d));
      base = isWeekdays
        ? "Every weekday (Monday to Friday)"
        : `Every ${every}week${rule.interval > 1 ? "s" : ""} on ${days.join(", ") || "—"}`;
      break;
    }
    case "MONTHLY":
      base =
        rule.bySetPos != null && rule.byWeekday?.length
          ? `Every ${every}month on the ${ORDINALS[rule.bySetPos] ?? "?"} ${WEEKDAY_NAMES[rule.byWeekday[0]!] ?? "?"}`
          : `Every ${every}month on day ${rule.byMonthDay === -1 ? "last" : (rule.byMonthDay ?? "?")}`;
      break;
    case "YEARLY":
      base = `Every ${every}year`;
      break;
    default:
      base = "Custom";
  }
  if (rule.end.kind === "ON") return `${base}, until ${rule.end.date}`;
  if (rule.end.kind === "AFTER") return `${base}, ${rule.end.count} times`;
  return base;
}
