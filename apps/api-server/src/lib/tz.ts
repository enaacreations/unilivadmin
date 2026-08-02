/**
 * IST (Asia/Kolkata) timezone helpers.
 *
 * All app date logic — most importantly the Place-Order cut-off — anchors to
 * India Standard Time, which is a FIXED UTC+5:30 offset with NO daylight-saving
 * transitions. These helpers let the cut-off math be correct in IST regardless
 * of the server/process timezone, instead of relying on Date#setHours/new Date()
 * which resolve to the host's local zone (e.g. UTC on a typical container host).
 *
 * The cut-off path treats a serviceDate as an IST CALENDAR date (a yyyy-MM-dd
 * wall-clock day), and builds absolute Date instants for IST wall-clock times so
 * comparisons against `new Date()` (an absolute instant) are timezone-safe.
 */

/** IST is a fixed offset; no DST. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60000;

/** Two-digit zero-pad. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Wall-clock parts of an instant as observed in IST.
 * Computed by shifting the absolute instant by the fixed +5:30 offset and reading
 * the resulting UTC fields (avoids any host-tz dependence).
 */
export function istParts(date: Date = new Date()): { y: number; m: number; d: number; h: number; min: number } {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1, // 1-based month
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    min: shifted.getUTCMinutes(),
  };
}

/** 'yyyy-MM-dd' for an instant in IST. */
export function istDayYmd(date: Date): string {
  const p = istParts(date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 'yyyy-MM-dd' for today in IST. */
export function todayIstYmd(): string {
  return istDayYmd(new Date());
}

/** Parse a 'yyyy-MM-dd' string into numeric {y, m, d} (m is 1-based). */
function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** The absolute Date instant of 00:00 IST on the given yyyy-MM-dd. */
export function ymdToIstDayStart(ymd: string): Date {
  return atIst(ymd, "00:00");
}

/**
 * The absolute Date instant for the IST wall-clock time `HH:MM` on the given
 * yyyy-MM-dd. e.g. atIst('2026-06-28', '09:00') is the instant that reads as
 * 09:00 in Asia/Kolkata (= 03:30 UTC).
 */
export function atIst(ymd: string, hhmm: string): Date {
  const { y, m, d } = parseYmd(ymd);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h || 0, min || 0, 0) - IST_OFFSET_MS);
}

/**
 * Shift a 'yyyy-MM-dd' calendar date by `n` days, returning 'yyyy-MM-dd'.
 * Pure calendar math via UTC (no host-tz dependence, IST-safe since IST has no DST).
 */
export function addDaysYmd(ymd: string, n: number): string {
  const { y, m, d } = parseYmd(ymd);
  const shifted = new Date(Date.UTC(y, m - 1, d + n, 0, 0, 0));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}
