import { beforeEach, describe, expect, it, vi } from "vitest";
import { foodBrandsTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";

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

import {
  HOME_PERIODS,
  ORDER_STATUSES,
  REPORT_PERIODS,
  WASTE_GRANULARITIES,
  invalidBrandParam,
  invalidEnumParam,
  invalidWindowParams,
} from "../../routes/food-ops.js";
import { isActiveBrand, isKnownBrand } from "../food-service.js";

/**
 * The report/analytics/export filter gates (L6).
 *
 * The defect these close: `?status=bogus` on the orders export reached
 * `eq(orders.status, … as never)`, Postgres raised 22P02 and the handler's
 * generic catch answered 500 — while GET /food/reports already answered 400 for
 * the very same value. `?brand=bogus` never raised anything at all: brand is a
 * TEXT column, so it matched no row and every report answered 200 with an empty
 * dataset, which reads as "no data" rather than "there is no such brand".
 *
 * So the assertions below are about the ANSWER, not the plumbing: a value that
 * names nothing must be refused with a 400 that repeats the value back, and a
 * value that names something (including a RETIRED brand, whose orders are still
 * reportable) must pass through untouched.
 */

/** Minimal express-ish res that records the status/body a gate wrote. */
function fakeRes() {
  const rec: { code?: number; body?: any } = {};
  return {
    rec,
    status(code: number) {
      rec.code = code;
      return { json: (body: unknown) => { rec.body = body; } };
    },
  };
}

const brand = (code: string, isActive: boolean) => ({
  id: `br-${code}`, code, name: code, isActive, updatedAt: new Date("2026-01-01T00:00:00Z"),
});

beforeEach(() => {
  resetDb();
  // HUDDLE is live; WHOLESOME was retired (DELETE /brands is a soft delete) and
  // still owns historical orders.
  seedDb([[foodBrandsTable, [brand("UNILIV", true), brand("HUDDLE", true), brand("WHOLESOME", false)]]]);
});

describe("invalidEnumParam — enum-typed query params 400 instead of 500", () => {
  it("refuses an order status the enum does not have, naming the value AND the valid ones", () => {
    // The valid list is part of the contract: these params are not in
    // openapi.yaml, so the refusal is the only place a caller can learn the
    // spelling. Asserted by membership, not as a frozen string, so adding a
    // status to the enum does not break this test.
    const res = fakeRes();
    expect(invalidEnumParam(res, "status", "bogus", ORDER_STATUSES)).toBe(true);
    expect(res.rec.code).toBe(400);
    expect(res.rec.body.success).toBe(false);
    expect(res.rec.body.error).toContain("Invalid status: bogus");
    for (const s of ORDER_STATUSES) expect(res.rec.body.error).toContain(s);
  });

  it("passes a real status through without writing a response", () => {
    const res = fakeRes();
    expect(invalidEnumParam(res, "status", "DELIVERED", ORDER_STATUSES)).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("treats an absent or empty param as no filter at all (handler default applies)", () => {
    const res = fakeRes();
    expect(invalidEnumParam(res, "status", undefined, ORDER_STATUSES)).toBe(false);
    expect(invalidEnumParam(res, "status", "", ORDER_STATUSES)).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("gates the window keywords each surface actually speaks", () => {
    // The two surfaces have DIFFERENT vocabularies — "fq" is a home-dashboard
    // period and was silently answered with the reports' 30-day window.
    expect(invalidEnumParam(fakeRes(), "period", "quarter", REPORT_PERIODS)).toBe(false);
    expect(invalidEnumParam(fakeRes(), "period", "fq", REPORT_PERIODS)).toBe(true);
    expect(invalidEnumParam(fakeRes(), "period", "fq", HOME_PERIODS)).toBe(false);
    expect(invalidEnumParam(fakeRes(), "period", "quarter", HOME_PERIODS)).toBe(true);
    expect(invalidEnumParam(fakeRes(), "granularity", "month", WASTE_GRANULARITIES)).toBe(false);
    expect(invalidEnumParam(fakeRes(), "granularity", "weekly", WASTE_GRANULARITIES)).toBe(true);
  });

  it("covers every label the DB enum holds (the allowlist is read off the enum)", () => {
    for (const s of ORDER_STATUSES) {
      expect(invalidEnumParam(fakeRes(), "status", s, ORDER_STATUSES)).toBe(false);
    }
    expect(ORDER_STATUSES).toContain("DELIVERED");
  });
});

describe("invalidWindowParams — the report window is period + from/to, gated together", () => {
  const req = (query: Record<string, unknown>) => ({ query });

  it("accepts a window the surface speaks", () => {
    const res = fakeRes();
    expect(invalidWindowParams(req({ period: "month", from: "2026-07-01", to: "2026-07-31" }), res, REPORT_PERIODS)).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("accepts an omitted window (the handler's own default applies)", () => {
    expect(invalidWindowParams(req({}), fakeRes(), REPORT_PERIODS)).toBe(false);
  });

  it("refuses an unparseable date instead of silently reporting the default window", () => {
    const res = fakeRes();
    expect(invalidWindowParams(req({ from: "last-tuesday" }), res, REPORT_PERIODS)).toBe(true);
    expect(res.rec.body).toEqual({ success: false, error: "Invalid from: last-tuesday" });
    const res2 = fakeRes();
    expect(invalidWindowParams(req({ to: "31/07/2026-ish" }), res2, REPORT_PERIODS)).toBe(true);
    expect(res2.rec.body).toEqual({ success: false, error: "Invalid to: 31/07/2026-ish" });
  });

  it("refuses a period from the other surface's vocabulary", () => {
    expect(invalidWindowParams(req({ period: "fy" }), fakeRes(), REPORT_PERIODS)).toBe(true);
    expect(invalidWindowParams(req({ period: "fy" }), fakeRes(), HOME_PERIODS)).toBe(false);
  });
});

describe("invalidBrandParam — the brand filter is checked against the live master", () => {
  it("refuses a brand code no master row has, naming the value", async () => {
    const res = fakeRes();
    expect(await invalidBrandParam(res, "bogus")).toBe(true);
    expect(res.rec.code).toBe(400);
    expect(res.rec.body).toEqual({ success: false, error: "Invalid brand: bogus" });
  });

  it("passes an active brand", async () => {
    const res = fakeRes();
    expect(await invalidBrandParam(res, "HUDDLE")).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("passes a RETIRED brand — its historical orders are still reportable", async () => {
    // This is why the read gate is isKnownBrand and not isActiveBrand: a soft
    // deleted brand must not become unexportable.
    const res = fakeRes();
    expect(await invalidBrandParam(res, "WHOLESOME")).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("treats an absent brand as no filter", async () => {
    const res = fakeRes();
    expect(await invalidBrandParam(res, undefined)).toBe(false);
    expect(await invalidBrandParam(res, "")).toBe(false);
    expect(res.rec.code).toBeUndefined();
  });

  it("is not a hardcoded list — a brand an admin adds is accepted immediately", async () => {
    expect(await invalidBrandParam(fakeRes(), "NEWCO")).toBe(true);
    seedDb([[foodBrandsTable, [brand("UNILIV", true), brand("NEWCO", true)]]]);
    expect(await invalidBrandParam(fakeRes(), "NEWCO")).toBe(false);
  });
});

/**
 * The two gates are one function apart and mean opposite things, so the pair is
 * asserted together: both routers (food.ts mounts first at /food and owns the
 * shared paths; food-ops.ts holds the rest) now read this single implementation,
 * and collapsing one into the other is the regression this guards.
 */
describe("isKnownBrand vs isActiveBrand — the READ gate and the WRITE gate differ", () => {
  it("agree on a live brand and on a code that names nothing", async () => {
    expect(await isKnownBrand("HUDDLE")).toBe(true);
    expect(await isActiveBrand("HUDDLE")).toBe(true);
    expect(await isKnownBrand("bogus")).toBe(false);
    expect(await isActiveBrand("bogus")).toBe(false);
  });

  it("diverge on a RETIRED brand: still filterable, no longer writable", async () => {
    // The whole reason there are two. A soft-deleted brand still owns every
    // order it ever took, so a report must accept it; a new order must not.
    expect(await isKnownBrand("WHOLESOME")).toBe(true);
    expect(await isActiveBrand("WHOLESOME")).toBe(false);
  });

  it("both refuse an empty or absent code rather than matching everything", async () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(await isKnownBrand(v)).toBe(false);
      expect(await isActiveBrand(v)).toBe(false);
    }
  });
});
