import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  citiesTable,
  clustersTable,
  foodMenuRotationTable,
  kitchensTable,
  propertiesTable,
  userScopesTable,
} from "@workspace/db";
import { fakeDb, resetDb, seedDb } from "./helpers/fake-db.js";
import {
  resolveAccessiblePropertyIds,
  scopeRotationReadCondition,
  scopeRotationWriteCondition,
} from "../food-service.js";

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

/* ── the geo spine, seeded once ──────────────────────────────────────────────
 * Two real spines reach a property and they deliberately DISAGREE here, because
 * they disagree in live data: p-hyd-outsider hangs off the Hyderabad kitchen
 * while sitting in a Bangalore cluster. A test where both spines pick the same
 * properties would pass with either one of them deleted.
 *
 *   zone Z-SOUTH ─┬─ city C-BLR ─┬─ cluster CL-BLR-1 ─ p-blr-1, p-blr-2
 *                 │              └─ kitchen  K-BLR    ─ p-blr-1
 *                 └─ city C-HYD ─┬─ cluster CL-HYD-1 ─ p-hyd-1
 *                                └─ kitchen  K-HYD    ─ p-hyd-1, p-hyd-outsider
 *   zone Z-NORTH ─── city C-DEL ─┬─ cluster CL-DEL-1 ─ p-del-1
 *                                └─ kitchen  K-DEL    ─ p-del-1
 */
// `isActive` is NOT NULL on all three master tables, so every fixture row
// carries it: the spine walk refuses to traverse a DEACTIVATED node (grant-time
// already refuses to mint a grant on one — food.ts scopeTargetIsLive), and a
// fixture with the column missing models a row the database cannot hold.
const CITIES = [
  { id: "C-BLR", zoneId: "Z-SOUTH", isActive: true },
  { id: "C-HYD", zoneId: "Z-SOUTH", isActive: true },
  { id: "C-DEL", zoneId: "Z-NORTH", isActive: true },
];
const CLUSTERS = [
  { id: "CL-BLR-1", cityId: "C-BLR", isActive: true },
  { id: "CL-HYD-1", cityId: "C-HYD", isActive: true },
  { id: "CL-DEL-1", cityId: "C-DEL", isActive: true },
];
const KITCHENS = [
  { id: "K-BLR", cityId: "C-BLR", clusterId: "CL-BLR-1", isActive: true },
  { id: "K-HYD", cityId: "C-HYD", clusterId: "CL-HYD-1", isActive: true },
  { id: "K-DEL", cityId: "C-DEL", clusterId: "CL-DEL-1", isActive: true },
];
const PROPERTIES = [
  { id: "p-blr-1", clusterId: "CL-BLR-1", kitchenId: "K-BLR" },
  { id: "p-blr-2", clusterId: "CL-BLR-1", kitchenId: null },
  { id: "p-hyd-1", clusterId: "CL-HYD-1", kitchenId: "K-HYD" },
  { id: "p-hyd-outsider", clusterId: "CL-BLR-1", kitchenId: "K-HYD" },
  { id: "p-del-1", clusterId: "CL-DEL-1", kitchenId: "K-DEL" },
  { id: "p-orphan", clusterId: null, kitchenId: null },
];

type ScopeSeed = {
  scopeLevel: string;
  zoneId?: string | null;
  cityId?: string | null;
  clusterId?: string | null;
  kitchenId?: string | null;
  propertyId?: string | null;
  isActive?: boolean;
};

/** A grant row for user `u-1`; inactive is the soft-revoke state, not a delete. */
const grant = (s: ScopeSeed) => ({
  id: `s-${s.scopeLevel}-${s.zoneId ?? s.cityId ?? s.clusterId ?? s.kitchenId ?? s.propertyId ?? "x"}`,
  userId: "u-1",
  zoneId: null,
  cityId: null,
  clusterId: null,
  kitchenId: null,
  propertyId: null,
  isActive: true,
  ...s,
});

const user = (role: string, propertyId: string | null = null) => ({
  id: "u-1",
  email: "u1@uniliv.com",
  role,
  propertyId,
});

function seed(scopes: ReturnType<typeof grant>[], geo: Partial<{
  cities: typeof CITIES; clusters: typeof CLUSTERS; kitchens: typeof KITCHENS;
}> = {}) {
  seedDb([
    [userScopesTable, scopes],
    [citiesTable, geo.cities ?? CITIES],
    [clustersTable, geo.clusters ?? CLUSTERS],
    [kitchensTable, geo.kitchens ?? KITCHENS],
    [propertiesTable, PROPERTIES],
  ]);
}

/** The same spine with one node retired. */
const deactivate = <T extends { id: string }>(rows: T[], id: string): T[] =>
  rows.map((r) => (r.id === id ? { ...r, isActive: false } : r));

const sorted = (ids: string[] | null) => (ids === null ? null : [...ids].sort());

beforeEach(resetDb);

/**
 * `null` means UNRESTRICTED — every property in the network. `[]` means NOTHING.
 * They are the two ends of the multi-tenancy boundary, they are one character
 * apart, and `scopeOrdersCondition` turns the first into "no WHERE clause" and
 * the second into `false`. A regression that returns `null` where `[]` belongs
 * hands one property's operator every property's orders and every test that only
 * checks "the right ids come back for a configured user" still passes. Hence
 * this file asserts the distinction directly and by identity, not by length.
 */
describe("resolveAccessiblePropertyIds — null means ALL, [] means NOTHING", () => {
  it.each(["SUPER_ADMIN", "OPS_EXCELLENCE", "SENIOR_VICE_PRESIDENT", "AUDIT_READONLY"])(
    "%s is org-wide by role and returns null without reading a single grant",
    async (role) => {
      seed([]);
      expect(await resolveAccessiblePropertyIds(user(role))).toBeNull();
    },
  );

  it("a GLOBAL scope row returns null for a role that is not org-wide by title", async () => {
    seed([grant({ scopeLevel: "GLOBAL" })]);
    expect(await resolveAccessiblePropertyIds(user("CITY_HEAD"))).toBeNull();
  });

  it("a scoped role whose grants resolve to nothing returns [] and NOT null", async () => {
    // A CLUSTER grant pointing at a cluster with no properties tagged to it: the
    // grant exists, it is active, and it resolves to zero properties. That user
    // sees nothing. Falling back to null here would promote a misconfiguration
    // into org-wide access.
    seed([grant({ scopeLevel: "CLUSTER", clusterId: "CL-EMPTY" })]);
    const ids = await resolveAccessiblePropertyIds(user("CLUSTER_MANAGER"));
    expect(ids).not.toBeNull();
    expect(ids).toEqual([]);
  });

  it("a grant with a null geo id resolves to [] rather than matching everything", async () => {
    seed([grant({ scopeLevel: "CITY", cityId: null })]);
    expect(await resolveAccessiblePropertyIds(user("CITY_HEAD"))).toEqual([]);
  });
});

/**
 * The former BROAD_FALLBACK roles. These five fell open to every property when
 * the user had no scope rows, so revoking a head's last grant PROMOTED them from
 * one zone to the whole network. Zero rows now means zero properties for every
 * role outside ALWAYS_GLOBAL, whatever its title.
 */
describe("no grants means no properties — revoking can never escalate", () => {
  it.each(["ZONAL_HEAD", "CITY_HEAD", "CLUSTER_MANAGER", "FNB_ZONAL_HEAD", "FNB_SUPERVISOR"])(
    "%s with zero scope rows returns [] and NOT null",
    async (role) => {
      seed([]);
      const ids = await resolveAccessiblePropertyIds(user(role));
      expect(ids).not.toBeNull();
      expect(ids).toEqual([]);
    },
  );

  it("revoking the last grant narrows a city head to nothing, never to everything", async () => {
    const revoked = grant({ scopeLevel: "CITY", cityId: "C-BLR", isActive: false });
    seed([revoked]);
    const ids = await resolveAccessiblePropertyIds(user("CITY_HEAD"));
    expect(ids).not.toBeNull();
    expect(ids).toEqual([]);
  });

  it("an inactive grant is ignored while an active one beside it still resolves", async () => {
    seed([
      grant({ scopeLevel: "PROPERTY", propertyId: "p-blr-1" }),
      grant({ scopeLevel: "PROPERTY", propertyId: "p-del-1", isActive: false }),
    ]);
    expect(await resolveAccessiblePropertyIds(user("CLUSTER_MANAGER"))).toEqual(["p-blr-1"]);
  });
});

describe("each scope level resolves to its exact property set", () => {
  it("PROPERTY grants resolve to themselves and to nothing else", async () => {
    seed([
      grant({ scopeLevel: "PROPERTY", propertyId: "p-blr-2" }),
      grant({ scopeLevel: "PROPERTY", propertyId: "p-del-1" }),
    ]);
    expect(sorted(await resolveAccessiblePropertyIds(user("UNIT_LEAD")))).toEqual(["p-blr-2", "p-del-1"]);
  });

  it("a home property is additive to whatever the grants resolve", async () => {
    seed([grant({ scopeLevel: "PROPERTY", propertyId: "p-del-1" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("UNIT_LEAD", "p-orphan")))).toEqual([
      "p-del-1",
      "p-orphan",
    ]);
  });

  it("a unit lead with no grants still sees their own property", async () => {
    seed([]);
    expect(await resolveAccessiblePropertyIds(user("UNIT_LEAD", "p-blr-1"))).toEqual(["p-blr-1"]);
  });

  it("KITCHEN resolves through properties.kitchenId — the F&B spine", async () => {
    seed([grant({ scopeLevel: "KITCHEN", kitchenId: "K-HYD" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("FNB_MANAGER")))).toEqual([
      "p-hyd-1",
      "p-hyd-outsider",
    ]);
  });

  it("CLUSTER resolves through properties.clusterId — the org spine", async () => {
    // p-hyd-outsider is in this cluster and served by the Hyderabad kitchen; the
    // cluster grant reaches it, the kitchen it eats from is irrelevant.
    seed([grant({ scopeLevel: "CLUSTER", clusterId: "CL-BLR-1" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("CLUSTER_MANAGER")))).toEqual([
      "p-blr-1",
      "p-blr-2",
      "p-hyd-outsider",
    ]);
  });

  it("CITY resolves down BOTH spines and unions them", async () => {
    // Bangalore's cluster holds p-blr-1, p-blr-2 and the outsider; its kitchen
    // holds p-blr-1 alone. Either spine on its own is wrong — a city head owns
    // every property in the city however that property happens to be wired.
    seed([grant({ scopeLevel: "CITY", cityId: "C-BLR" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("CITY_HEAD")))).toEqual([
      "p-blr-1",
      "p-blr-2",
      "p-hyd-outsider",
    ]);
  });

  it("CITY still reaches properties tied to its kitchen but sitting in another cluster", async () => {
    // Hyderabad's cluster holds only p-hyd-1; its KITCHEN also feeds
    // p-hyd-outsider, which the cluster spine alone would miss. This is the
    // assertion that fails the moment the kitchen spine is dropped in favour of
    // audit-access.ts's cluster-only walk.
    seed([grant({ scopeLevel: "CITY", cityId: "C-HYD" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("CITY_HEAD")))).toEqual([
      "p-hyd-1",
      "p-hyd-outsider",
    ]);
  });

  it("ZONE fans out to every city in the zone, down both spines", async () => {
    seed([grant({ scopeLevel: "ZONE", zoneId: "Z-SOUTH" })]);
    expect(sorted(await resolveAccessiblePropertyIds(user("ZONAL_HEAD")))).toEqual([
      "p-blr-1",
      "p-blr-2",
      "p-hyd-1",
      "p-hyd-outsider",
    ]);
  });

  /* ── deactivated spine nodes are not traversed ─────────────────────────────
   * POST /food/scopes refuses to MINT a grant on an inactive zone/city/cluster/
   * kitchen (food.ts scopeTargetIsLive). Resolve-time has to apply the same rule
   * or a node retired from the org spine keeps conferring access that no admin
   * can see, re-create, or reason about. A DIRECT grant is governed by its own
   * row instead — that is what user_scopes.isActive is for (H5's soft revoke).
   */
  it("a deactivated cluster drops off the city walk", async () => {
    seed([grant({ scopeLevel: "CITY", cityId: "C-BLR" })], {
      clusters: deactivate(CLUSTERS, "CL-BLR-1"),
    });
    // Only the kitchen spine survives: K-BLR still feeds p-blr-1.
    expect(sorted(await resolveAccessiblePropertyIds(user("CITY_HEAD")))).toEqual(["p-blr-1"]);
  });

  it("a deactivated kitchen drops off the city walk", async () => {
    seed([grant({ scopeLevel: "CITY", cityId: "C-HYD" })], {
      kitchens: deactivate(KITCHENS, "K-HYD"),
    });
    // Only the cluster spine survives: CL-HYD-1 holds p-hyd-1 alone.
    expect(sorted(await resolveAccessiblePropertyIds(user("CITY_HEAD")))).toEqual(["p-hyd-1"]);
  });

  it("a deactivated city is not fanned out to from its zone", async () => {
    seed([grant({ scopeLevel: "ZONE", zoneId: "Z-SOUTH" })], {
      cities: deactivate(CITIES, "C-HYD"),
    });
    // Bangalore only. p-hyd-outsider sits in a Bangalore cluster, so it stays.
    expect(sorted(await resolveAccessiblePropertyIds(user("ZONAL_HEAD")))).toEqual([
      "p-blr-1", "p-blr-2", "p-hyd-outsider",
    ]);
  });

  it("a DIRECT grant on a deactivated kitchen still resolves — user_scopes.isActive is its revoke", async () => {
    seed([grant({ scopeLevel: "KITCHEN", kitchenId: "K-HYD" })], {
      kitchens: deactivate(KITCHENS, "K-HYD"),
    });
    expect(sorted(await resolveAccessiblePropertyIds(user("FNB_MANAGER")))).toEqual([
      "p-hyd-1", "p-hyd-outsider",
    ]);
  });

  it("ZONE stops at the zone boundary — the north is not visible from the south", async () => {
    seed([grant({ scopeLevel: "ZONE", zoneId: "Z-SOUTH" })]);
    const ids = await resolveAccessiblePropertyIds(user("ZONAL_HEAD"));
    expect(ids).not.toBeNull();
    expect(ids).not.toContain("p-del-1");
    expect(ids).not.toContain("p-orphan");
  });

  it("grants at different levels are additive, never intersecting", async () => {
    seed([
      grant({ scopeLevel: "KITCHEN", kitchenId: "K-DEL" }),
      grant({ scopeLevel: "PROPERTY", propertyId: "p-blr-2" }),
    ]);
    expect(sorted(await resolveAccessiblePropertyIds(user("FNB_ZONAL_HEAD")))).toEqual([
      "p-blr-2",
      "p-del-1",
    ]);
  });

  it("a property reachable down both spines is returned once", async () => {
    seed([
      grant({ scopeLevel: "CLUSTER", clusterId: "CL-DEL-1" }),
      grant({ scopeLevel: "KITCHEN", kitchenId: "K-DEL" }),
    ]);
    expect(await resolveAccessiblePropertyIds(user("CITY_HEAD"))).toEqual(["p-del-1"]);
  });
});

/* ── the rotation READ/WRITE asymmetry, pinned ───────────────────────────────
 *
 * scopeRotationCondition used to be ONE helper and that was the bug: menu
 * rotation rows carry a NULLABLE kitchenId, where NULL means "brand-wide
 * template every kitchen is built from". A SQL IN-list never matches NULL, so
 * the single strict helper blanked the rotation board and its export for every
 * kitchen-scoped planner (on the dev DB all 385 rotation rows are brand-wide,
 * and 11 of the 12 FNB_MANAGER accounts are KITCHEN-scoped — they resolved 0).
 *
 * The two directions therefore have OPPOSITE requirements and the split is the
 * whole point:
 *   READ  must include the brand-wide rows — you cannot plan a menu you are not
 *         allowed to look at.
 *   WRITE must exclude them — one kitchen's manager rewriting a brand-wide row
 *         rewrites the menu the entire network serves. That is the same
 *         invariant assertKitchenAccess enforces on the single-row path.
 *
 * Nothing else pins the difference, and it is one word apart in either
 * direction, so these tests assert it by the ROWS each condition selects rather
 * than by the shape of the SQL. Do not "simplify" the two back into one: making
 * READ strict re-blanks the board, and making WRITE permissive hands a single
 * kitchen the network's menu.
 */
describe("menu-rotation scope — read sees the brand-wide templates, write must not", () => {
  const ROTATION = [
    { id: "r-blr", kitchenId: "K-BLR" },
    { id: "r-del", kitchenId: "K-DEL" },
    { id: "r-brand", kitchenId: null }, // brand-wide template
  ];

  /** Which rotation rows a condition actually selects, decided by the fake db. */
  const selected = async (cond: unknown): Promise<string[]> => {
    seedDb([[foodMenuRotationTable, ROTATION]]);
    const rows = await fakeDb
      .select({ id: foodMenuRotationTable.id })
      .from(foodMenuRotationTable)
      .where(cond);
    return rows.map((r) => r.id as string).sort();
  };

  it("an org-wide caller (null) is unrestricted in BOTH directions", () => {
    // undefined = "no WHERE clause at all", the only value that means every row.
    expect(scopeRotationReadCondition(null)).toBeUndefined();
    expect(scopeRotationWriteCondition(null)).toBeUndefined();
  });

  it("READ matches the caller's kitchens PLUS the brand-wide (kitchen_id IS NULL) rows", async () => {
    expect(await selected(scopeRotationReadCondition(["K-BLR"]))).toEqual(["r-blr", "r-brand"]);
  });

  it("WRITE matches the caller's kitchens and NOT the brand-wide rows", async () => {
    // The IN-list not matching NULL is the guard here, not an accident.
    expect(await selected(scopeRotationWriteCondition(["K-BLR"]))).toEqual(["r-blr"]);
  });

  it("neither direction reaches another kitchen's rows", async () => {
    expect(await selected(scopeRotationReadCondition(["K-BLR"]))).not.toContain("r-del");
    expect(await selected(scopeRotationWriteCondition(["K-BLR"]))).not.toContain("r-del");
  });

  it("an empty scope set fails CLOSED in both directions — a condition, never undefined", async () => {
    // `[]` is "sees nothing" (resolveAccessibleKitchenIds returns it for an
    // unresolvable grant); returning undefined here would turn that into "sees
    // everything", which is the same one-character escalation the resolver tests
    // above guard on the property side.
    expect(scopeRotationReadCondition([])).toBeDefined();
    expect(scopeRotationWriteCondition([])).toBeDefined();
    expect(await selected(scopeRotationReadCondition([]))).toEqual([]);
    expect(await selected(scopeRotationWriteCondition([]))).toEqual([]);
  });
});
