/**
 * Property-scope enforcement (Access Controls PRD, §24/§32).
 *
 * These cover the two helpers every scoped route now routes through, plus one
 * route-level proof that a scoped caller cannot reach another property's row.
 *
 * The behaviours asserted here were all previously holes:
 *   - assertPropertyAccess(req, null) was a silent no-op, so a create whose body
 *     omitted propertyId sailed through the very check meant to catch it.
 *   - list handlers read ?propertyId straight off the query and fell back to
 *     "no filter" — i.e. every property — when the caller simply omitted it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { assertPropertyAccess, effectivePropertyFilter } from "../authz.js";

/** Minimal req stand-in: the helpers only read req.user.{role,propertyId}. */
const asReq = (role: string, propertyId: string | null): Request =>
  ({ user: { id: "u1", email: "u@x.com", role, propertyId } }) as unknown as Request;

// WARDEN is absent from ORG_WIDE_ROLES, so a WARDEN with a propertyId is scoped.
const warden = asReq("WARDEN", "prop-a");
// OPERATIONS_MANAGER is in ORG_WIDE_ROLES — unrestricted regardless of propertyId.
const orgWide = asReq("OPERATIONS_MANAGER", "prop-a");

describe("assertPropertyAccess", () => {
  it("allows a scoped caller inside their own property", () => {
    expect(() => assertPropertyAccess(warden, "prop-a")).not.toThrow();
  });

  it("refuses a scoped caller reaching another property", () => {
    expect(() => assertPropertyAccess(warden, "prop-b")).toThrow(/Outside your property scope/);
    try {
      assertPropertyAccess(warden, "prop-b");
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(403);
    }
  });

  it("refuses a NULL target from a scoped caller instead of passing it", () => {
    // The regression this exists for: it used to return silently, which let an
    // unscoped write through the check that was supposed to stop it.
    for (const missing of [null, undefined, ""]) {
      expect(() => assertPropertyAccess(warden, missing as string | null)).toThrow(/propertyId is required/);
    }
    try {
      assertPropertyAccess(warden, null);
    } catch (e) {
      const err = e as { statusCode?: number; details?: { code?: string } };
      expect(err.statusCode).toBe(400);
      expect(err.details?.code).toBe("SCOPE_REQUIRED");
    }
  });

  it("still lets an org-wide caller pass null — for them it means every property", () => {
    // announcements.propertyId and electricity tariffs are legitimately null.
    expect(() => assertPropertyAccess(orgWide, null)).not.toThrow();
    expect(() => assertPropertyAccess(orgWide, "prop-b")).not.toThrow();
  });

  it("treats a scoped role with no propertyId as unrestricted, as today", () => {
    // Documents current behaviour rather than endorsing it: isPropertyScoped()
    // requires a non-null req.user.propertyId, so a WARDEN row with a null
    // propertyId is NOT scoped. Closing that is a data fix (every such user
    // needs a grant) and is tracked as R5 in the access-control plan — doing it
    // here would silently take those users from "everything" to "nothing".
    expect(() => assertPropertyAccess(asReq("WARDEN", null), "prop-b")).not.toThrow();
  });
});

describe("effectivePropertyFilter", () => {
  it("pins a scoped caller to their own property when they ask for nothing", () => {
    // The leak: the old `propertyId ? eq(...) : undefined` returned every row.
    expect(effectivePropertyFilter(warden, undefined)).toBe("prop-a");
    expect(effectivePropertyFilter(warden, null)).toBe("prop-a");
  });

  it("lets a scoped caller re-state their own property", () => {
    expect(effectivePropertyFilter(warden, "prop-a")).toBe("prop-a");
  });

  it("refuses a scoped caller filtering for another property", () => {
    expect(() => effectivePropertyFilter(warden, "prop-b")).toThrow(/Outside your property scope/);
  });

  it("passes an org-wide caller through untouched", () => {
    expect(effectivePropertyFilter(orgWide, undefined)).toBeNull();
    expect(effectivePropertyFilter(orgWide, "prop-b")).toBe("prop-b");
  });
});

// ── Route level ──────────────────────────────────────────────────────────────

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

// Authentication and the RBAC module gate are not what is under test here; the
// property boundary is. Both are asserted elsewhere.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { roomsTable } = await import("@workspace/db");
const { fakeDb, resetDb, seedDb } = await import("./helpers/fake-db.js");
const { callRoute } = await import("./helpers/call-route.js");
const roomsRouter = (await import("../../routes/rooms.js")).default;

void fakeDb;

describe("GET /rooms/:id — cross-property isolation", () => {
  beforeEach(() => {
    resetDb();
    seedDb([
      [roomsTable, [
        { id: "room-a", propertyId: "prop-a", number: "101", floor: 1, wing: null, type: "SINGLE", capacity: 1, status: "VACANT" },
        { id: "room-b", propertyId: "prop-b", number: "201", floor: 2, wing: null, type: "DOUBLE", capacity: 2, status: "VACANT" },
      ]],
    ]);
  });

  const wardenUser = { id: "u1", email: "w@x.com", role: "WARDEN", propertyId: "prop-a" };

  it("serves a room inside the caller's property", async () => {
    const r = await callRoute(roomsRouter, { method: "GET", url: "/room-a", user: wardenUser });
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe("room-a");
  });

  it("answers 404 — not 403 — for a room in another property", async () => {
    // 404 rather than 403 on purpose: a 403 would confirm the id exists, letting
    // a warden enumerate another property's room ids by probing status codes.
    const r = await callRoute(roomsRouter, { method: "GET", url: "/room-b", user: wardenUser });
    expect(r.status).toBe(404);
  });

  it("serves both to an org-wide caller", async () => {
    const ops = { id: "u2", email: "o@x.com", role: "OPERATIONS_MANAGER", propertyId: null };
    expect((await callRoute(roomsRouter, { method: "GET", url: "/room-a", user: ops })).status).toBe(200);
    expect((await callRoute(roomsRouter, { method: "GET", url: "/room-b", user: ops })).status).toBe(200);
  });
});
