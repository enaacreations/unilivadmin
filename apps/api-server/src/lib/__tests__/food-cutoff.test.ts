import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foodCutoffsTable, residentsTable, systemConfigTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { ymdToIstDayStart } from "../tz.js";

vi.hoisted(() => {
  // routes/food-ops.ts pulls in config/env.ts, which fails closed on a weak
  // secret outside development. Set one before the module graph loads.
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

import { checkOrderCutoff, residentsCapForProperty } from "../../routes/food-ops.js";

const BRAND = "UNILIV";
const PROPERTY = "p-blr-1";

/**
 * Every case runs against a FROZEN clock. `checkOrderCutoff` reads `new Date()`
 * internally and every comparison it makes is against an IST wall-clock instant,
 * so a test on the real clock would pass or fail depending on the hour it ran.
 */
const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** A service date as the callers build it: the IST day-start instant of a ymd. */
const serviceDay = (ymd: string) => ymdToIstDayStart(ymd);

const cutoff = (cutoffTime: string, propertyId: string | null = null) => ({
  id: `co-${propertyId ?? "global"}`,
  brand: BRAND,
  propertyId,
  cutoffTime,
  isActive: true,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("checkOrderCutoff — the cut-off is anchored on the day BEFORE service", () => {
  beforeEach(() => seedDb([[foodCutoffsTable, [cutoff("09:00")]], [systemConfigTable, []]]));

  it("allows tomorrow before today's cut-off", async () => {
    at("2026-08-10T03:00:00Z"); // 08:30 IST, before the 09:00 cut-off
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toBeNull();
  });

  it("closes tomorrow once today's cut-off has passed", async () => {
    at("2026-08-10T04:00:00Z"); // 09:30 IST
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toBe(
      "Ordering for 11/08/2026 is closed — the 09:00 cut-off has passed.",
    );
  });

  it("rejects at the cut-off instant itself only once it is strictly past", async () => {
    at("2026-08-10T03:30:00Z"); // exactly 09:00 IST — the deadline, not past it
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toBeNull();
    at("2026-08-10T03:30:01Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toContain("is closed");
  });

  it("rejects a service day that has already gone by", async () => {
    at("2026-08-10T04:00:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-09"))).toBe(
      "Cannot place an order for a past date.",
    );
  });

  it("refuses to pre-order past the next orderable day", async () => {
    at("2026-08-10T03:00:00Z"); // before cut-off, so tomorrow (11th) is the next day
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-12"))).toBe(
      "Orders can only be placed for the next service day (11/08/2026).",
    );
  });

  it("rolls the next orderable day forward once tomorrow's cut-off has passed", async () => {
    at("2026-08-10T04:00:00Z"); // after cut-off: the 11th is closed, the 12th opens
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-12"))).toBeNull();
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-13"))).toBe(
      "Orders can only be placed for the next service day (12/08/2026).",
    );
  });
});

/**
 * The IST calendar day rolls at 18:30 UTC. Every comparison in the cut-off path
 * is on IST wall-clock days, so the same two-minute window either side of that
 * instant has to land on different service days — reading the day off the host
 * clock (H9) or off a raw UTC timestamp (M8) puts the boundary in the wrong
 * place and silently opens or closes a day of ordering.
 */
describe("checkOrderCutoff — the IST day boundary at 18:30 UTC", () => {
  beforeEach(() => seedDb([[foodCutoffsTable, [cutoff("09:00")]], [systemConfigTable, []]]));

  it("18:29 UTC is still the 10th in IST, so the 10th is not yet a past date", async () => {
    at("2026-08-10T18:29:00Z"); // 23:59 IST on the 10th
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-10"))).not.toBe(
      "Cannot place an order for a past date.",
    );
  });

  it("18:31 UTC is already the 11th in IST, so the 10th has become a past date", async () => {
    at("2026-08-10T18:31:00Z"); // 00:01 IST on the 11th
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-10"))).toBe(
      "Cannot place an order for a past date.",
    );
  });

  it("the next orderable day advances across the same boundary", async () => {
    // 23:59 IST on the 10th: today is the 10th, its 09:00 cut-off is long past,
    // so the next orderable day is the 12th and the 13th is out of reach.
    at("2026-08-10T18:29:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-12"))).toBeNull();
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-13"))).toContain(
      "(12/08/2026)",
    );
    // 00:01 IST on the 11th: today is the 11th, its cut-off has NOT passed, so
    // the 12th is tomorrow and the 13th is still out of reach.
    at("2026-08-10T18:31:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-12"))).toBeNull();
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-13"))).toContain(
      "(12/08/2026)",
    );
  });

  it("a late-evening cut-off resolves against the IST evening, not the UTC one", async () => {
    // 21:00 IST cut-off, checked at 20:30 IST (15:00 UTC) on the 10th: still open
    // for the 11th. Reading 15:00 as the wall clock would have closed it.
    seedDb([[foodCutoffsTable, [cutoff("21:00")]], [systemConfigTable, []]]);
    at("2026-08-10T15:00:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toBeNull();
    at("2026-08-10T15:31:00Z"); // 21:01 IST
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toContain("21:00");
  });
});

describe("checkOrderCutoff — which cut-off row applies", () => {
  it("a property override beats the brand-wide row", async () => {
    seedDb([
      [foodCutoffsTable, [cutoff("09:00"), cutoff("18:00", PROPERTY)]],
      [systemConfigTable, []],
    ]);
    at("2026-08-10T04:00:00Z"); // 09:30 IST — past the global cut-off, not the property's
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toBeNull();
  });

  it("another property's override does not apply", async () => {
    seedDb([
      [foodCutoffsTable, [cutoff("09:00"), cutoff("18:00", "p-other")]],
      [systemConfigTable, []],
    ]);
    at("2026-08-10T04:00:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toContain("09:00");
  });

  it("an inactive cut-off row is ignored and the configured default applies", async () => {
    seedDb([
      [foodCutoffsTable, [{ ...cutoff("18:00"), isActive: false }]],
      [systemConfigTable, [{ id: "sc-1", key: "food_default_cutoff", value: "07:00" }]],
    ]);
    at("2026-08-10T02:00:00Z"); // 07:30 IST — past the 07:00 default
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toContain(
      "the 07:00 cut-off has passed",
    );
  });

  it("falls back to 09:00 when nothing is configured at all", async () => {
    seedDb([[foodCutoffsTable, []], [systemConfigTable, []]]);
    at("2026-08-10T04:00:00Z");
    expect(await checkOrderCutoff(BRAND, PROPERTY, serviceDay("2026-08-11"))).toContain(
      "the 09:00 cut-off has passed",
    );
  });
});

/**
 * The ordering cap. Residents are the capped population; a property with no
 * ACTIVE residents may not order resident meals at all (staff are separate and
 * uncapped), so cap 0 is a real answer and not a missing one. The headroom above
 * occupancy is the admin-tunable FOOD_ORDER_HEADROOM_PCT — 100% by default, so
 * an unseeded config caps at double.
 */
describe("residentsCapForProperty — occupancy + configured headroom", () => {
  const resident = (id: string, propertyId: string, status = "ACTIVE") => ({
    id,
    propertyId,
    name: id,
    status,
  });

  /** Seed the headroom setting. Omit to exercise the 100% default. */
  const seedHeadroom = (pct: number) =>
    seedDb([[systemConfigTable, [{
      id: "cfg-headroom",
      key: "FOOD_ORDER_HEADROOM_PCT",
      value: pct,
      description: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    }]]]);

  it("defaults to 100% headroom — occupancy doubles", async () => {
    seedDb([
      [residentsTable, Array.from({ length: 7 }, (_, i) => resident(`r${i}`, PROPERTY))],
    ]);
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 7, cap: 14, mult: 2 });
  });

  it("rounds up to a whole resident", async () => {
    seedHeadroom(20);
    seedDb([
      [residentsTable, Array.from({ length: 7 }, (_, i) => resident(`r${i}`, PROPERTY))],
    ]);
    // 7 × 1.2 = 8.4 → 9: the fraction rounds in the property's favour.
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 7, cap: 9, mult: 1.2 });
  });

  it("0% headroom caps at occupancy exactly", async () => {
    seedHeadroom(0);
    seedDb([
      [residentsTable, Array.from({ length: 7 }, (_, i) => resident(`r${i}`, PROPERTY))],
    ]);
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 7, cap: 7, mult: 1 });
  });

  it("counts ACTIVE residents only", async () => {
    seedDb([
      [
        residentsTable,
        [
          resident("r1", PROPERTY),
          resident("r2", PROPERTY),
          resident("r3", PROPERTY, "EXITED"),
          resident("r4", PROPERTY, "PENDING"),
        ],
      ],
    ]);
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 2, cap: 4, mult: 2 });
  });

  it("counts only the property asked for", async () => {
    seedDb([
      [residentsTable, [resident("r1", PROPERTY), resident("r2", "p-other"), resident("r3", "p-other")]],
    ]);
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 1, cap: 2, mult: 2 });
  });

  it("a property with no active residents has cap 0, not an uncapped one", async () => {
    seedDb([[residentsTable, [resident("r1", PROPERTY, "EXITED")]]]);
    expect(await residentsCapForProperty(PROPERTY)).toEqual({ occupancy: 0, cap: 0, mult: 2 });
  });
});
