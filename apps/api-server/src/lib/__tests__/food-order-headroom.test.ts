/**
 * The ordering headroom setting — GET/PUT /food/settings/order-headroom.
 *
 * INVARIANT: the one percentage that bounds every "you may order above the
 * derived number" check is org-wide, so only a super-admin-parity role may move
 * it. That is SUPER_ADMIN and OPS_EXCELLENCE, which is deliberately NOT the same
 * set as FOOD_SETTINGS:edit — a kitchen- or property-scoped settings holder must
 * not be able to lift the ordering ceiling for every property at once.
 *
 * The write gate here is `isSuperAdmin(req.user.role)` INSIDE the handler, not
 * an authorize() middleware, which is why these cases survive the middleware
 * mocks below: mocking the RBAC chain open is exactly what makes the in-handler
 * check the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemConfigTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { callRoute } from "./helpers/call-route.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

// The coarse RBAC chain is asserted by permissions-sync.test.ts; this file is
// about the in-handler super-admin gate, so the chain is opened and the caller
// is set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { foodOpsRouter } from "../../routes/food-ops.js";

const user = (role: string) => ({ id: `u-${role}`, email: `${role}@uniliv.com`, role, propertyId: null });

const get = (role: string) =>
  callRoute(foodOpsRouter, { method: "GET", url: "/settings/order-headroom", user: user(role) });

const put = (role: string, body: unknown) =>
  callRoute(foodOpsRouter, { method: "PUT", url: "/settings/order-headroom", user: user(role), body });

const seedHeadroom = (pct: unknown) =>
  seedDb([[systemConfigTable, [{
    id: "cfg-headroom",
    key: "FOOD_ORDER_HEADROOM_PCT",
    value: pct,
    description: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  }]]]);

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

describe("GET /food/settings/order-headroom", () => {
  it("defaults to 100% when nothing is stored", async () => {
    const res = await get("UNIT_LEAD");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ pct: 100, multiplier: 2, defaultPct: 100 });
  });

  it("returns the stored value with the multiplier pre-applied", async () => {
    seedHeadroom(35);
    const res = await get("UNIT_LEAD");
    expect(res.body.data).toMatchObject({ pct: 35, multiplier: 1.35 });
  });

  /* The grid draws its own +/- ceilings from this, so a unit lead who cannot
   * read it would be stopped by a 422 the UI never showed a limit for. */
  it("is readable by the operational roles that place orders", async () => {
    for (const role of ["UNIT_LEAD", "FNB_MANAGER", "SUPER_ADMIN", "OPS_EXCELLENCE"]) {
      expect((await get(role)).status).toBe(200);
    }
  });
});

describe("PUT /food/settings/order-headroom", () => {
  it("lets OPS_EXCELLENCE change it — the whole point of the setting", async () => {
    const res = await put("OPS_EXCELLENCE", { pct: 250 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ pct: 250, multiplier: 3.5 });
    // Read back through a second request: the row was persisted, not echoed.
    expect((await get("UNIT_LEAD")).body.data.pct).toBe(250);
  });

  it("lets SUPER_ADMIN change it", async () => {
    expect((await put("SUPER_ADMIN", { pct: 0 })).status).toBe(200);
    expect((await get("UNIT_LEAD")).body.data).toMatchObject({ pct: 0, multiplier: 1 });
  });

  it("refuses every role without super-admin parity", async () => {
    for (const role of ["UNIT_LEAD", "FNB_MANAGER", "WARDEN", "AUDIT_READONLY"]) {
      const res = await put(role, { pct: 500 });
      expect(res.status, `${role} must not move the org-wide ordering ceiling`).toBe(403);
    }
    // And nothing was written on the way to those 403s.
    expect((await get("UNIT_LEAD")).body.data.pct).toBe(100);
  });

  it("rejects a value past the maximum rather than storing an uncapped one", async () => {
    const res = await put("OPS_EXCELLENCE", { pct: 99999 });
    expect(res.status).toBe(400);
    expect((await get("UNIT_LEAD")).body.data.pct).toBe(100);
  });

  it("rejects negatives and fractions — the ceiling is a whole percent", async () => {
    expect((await put("OPS_EXCELLENCE", { pct: -1 })).status).toBe(400);
    expect((await put("OPS_EXCELLENCE", { pct: 12.5 })).status).toBe(400);
    expect((await put("OPS_EXCELLENCE", { pct: "abc" })).status).toBe(400);
  });
});
