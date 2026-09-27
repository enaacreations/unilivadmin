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
import {
  assertPropertyAccess, effectivePropertyFilter, scopedPropertyIds,
  installPropertyScopeResolver,
} from "../authz.js";

/** Minimal req stand-in: the helpers only read req.user.{role,propertyId}. */
const asReq = (role: string, propertyId: string | null): Request =>
  ({ user: { id: "u1", email: "u@x.com", role, propertyId } }) as unknown as Request;

// WARDEN is absent from ORG_WIDE_ROLES, so a WARDEN with a propertyId is scoped.
const warden = asReq("WARDEN", "prop-a");
// OPERATIONS_MANAGER is in ORG_WIDE_ROLES — unrestricted regardless of propertyId.
const orgWide = asReq("OPERATIONS_MANAGER", "prop-a");

/**
 * Pretend the access engine resolved `ids` for everyone, for the length of one
 * test. Without an installed resolver the helpers fall back to the home
 * property alone, which is the old single-property behaviour — asserted below
 * as the safe default.
 */
function withResolvedScope<T>(ids: string[] | null, fn: () => Promise<T>): Promise<T> {
  installPropertyScopeResolver(async () => ids);
  // Clear it, don't replace it with one that answers null — null means
  // UNRESTRICTED, so leaving that installed would quietly unscope every test
  // that ran afterwards.
  return fn().finally(() => installPropertyScopeResolver(null));
}

describe("scopedPropertyIds", () => {
  it("falls back to the home property when no resolver is installed", async () => {
    // The safety property of injecting the resolver: an uninstalled one answers
    // exactly what the old single-property helper did, never "everything".
    await expect(scopedPropertyIds(warden)).resolves.toEqual(["prop-a"]);
  });

  it("returns every property the engine resolved, home included", async () => {
    await withResolvedScope(["prop-b", "prop-c"], async () => {
      const ids = await scopedPropertyIds(warden);
      expect(ids).toEqual(expect.arrayContaining(["prop-a", "prop-b", "prop-c"]));
      expect(ids).toHaveLength(3);
    });
  });

  it("stays unrestricted for an org-wide role", async () => {
    await expect(scopedPropertyIds(orgWide)).resolves.toBeNull();
  });

  it("treats an org-wide GRANT as unrestricted", async () => {
    await withResolvedScope(null, async () => {
      await expect(scopedPropertyIds(warden)).resolves.toBeNull();
    });
  });
});

describe("assertPropertyAccess", () => {
  it("allows a scoped caller inside their own property", async () => {
    await expect(assertPropertyAccess(warden, "prop-a")).resolves.toBeUndefined();
  });

  it("allows any property the engine resolved, not just the home one", async () => {
    // The requirement this whole change exists for: a Unit Lead placed at two
    // properties may act at both.
    await withResolvedScope(["prop-a", "prop-b"], async () => {
      await expect(assertPropertyAccess(warden, "prop-b")).resolves.toBeUndefined();
    });
  });

  it("refuses a scoped caller reaching another property", async () => {
    await expect(assertPropertyAccess(warden, "prop-b")).rejects.toThrow(/Outside your property scope/);
    await assertPropertyAccess(warden, "prop-b").catch((e) => {
      expect((e as { statusCode?: number }).statusCode).toBe(403);
    });
  });

  it("still refuses one outside a MULTI-property scope", async () => {
    await withResolvedScope(["prop-a", "prop-b"], async () => {
      await expect(assertPropertyAccess(warden, "prop-z")).rejects.toThrow(/Outside your property scope/);
    });
  });

  it("refuses a NULL target from a scoped caller instead of passing it", async () => {
    // The regression this exists for: it used to return silently, which let an
    // unscoped write through the check that was supposed to stop it.
    for (const missing of [null, undefined, ""]) {
      await expect(assertPropertyAccess(warden, missing as string | null)).rejects.toThrow(/propertyId is required/);
    }
    await assertPropertyAccess(warden, null).catch((e) => {
      const err = e as { statusCode?: number; details?: { code?: string } };
      expect(err.statusCode).toBe(400);
      expect(err.details?.code).toBe("SCOPE_REQUIRED");
    });
  });

  it("still lets an org-wide caller pass null — for them it means every property", async () => {
    // announcements.propertyId and electricity tariffs are legitimately null.
    await expect(assertPropertyAccess(orgWide, null)).resolves.toBeUndefined();
    await expect(assertPropertyAccess(orgWide, "prop-b")).resolves.toBeUndefined();
  });

  it("treats a scoped role with no propertyId as unrestricted, as today", async () => {
    // Documents current behaviour rather than endorsing it: isPropertyScoped()
    // requires a non-null req.user.propertyId, so a WARDEN row with a null
    // propertyId is NOT scoped. Closing that is a data fix (every such user
    // needs a grant) — doing it here would silently take those users from
    // "everything" to "nothing" on every scoped route at once.
    await expect(assertPropertyAccess(asReq("WARDEN", null), "prop-b")).resolves.toBeUndefined();
  });
});

describe("effectivePropertyFilter", () => {
  it("pins a scoped caller to their own properties when they ask for nothing", async () => {
    // The leak: the old `propertyId ? eq(...) : undefined` returned every row.
    await expect(effectivePropertyFilter(warden, undefined)).resolves.toEqual(["prop-a"]);
    await expect(effectivePropertyFilter(warden, null)).resolves.toEqual(["prop-a"]);
  });

  it("returns the whole set for a caller placed at several", async () => {
    await withResolvedScope(["prop-a", "prop-b"], async () => {
      const ids = await effectivePropertyFilter(warden, undefined);
      expect(ids).toEqual(expect.arrayContaining(["prop-a", "prop-b"]));
    });
  });

  it("narrows to ONE of their own when they ask for it", async () => {
    // Asking for one of yours is a legitimate filter, not an escalation.
    await withResolvedScope(["prop-a", "prop-b"], async () => {
      await expect(effectivePropertyFilter(warden, "prop-b")).resolves.toEqual(["prop-b"]);
    });
  });

  it("refuses a scoped caller filtering for another property", async () => {
    await expect(effectivePropertyFilter(warden, "prop-b")).rejects.toThrow(/Outside your property scope/);
  });

  it("passes an org-wide caller through untouched", async () => {
    await expect(effectivePropertyFilter(orgWide, undefined)).resolves.toBeNull();
    await expect(effectivePropertyFilter(orgWide, "prop-b")).resolves.toEqual(["prop-b"]);
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
  // The gate is stubbed open here, but the route files still CALL on()/reads()
  // at import time to build their pairs — so the mock has to provide them or
  // the module fails to load.
  on: (f: string, a: string) => [f, a],
  reads: (fs: readonly string[]) => fs.map((f) => [f, "view"]),
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
