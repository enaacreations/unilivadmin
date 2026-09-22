/**
 * THE CUTOVER GATE.
 *
 * The rollout is big-bang per phase — there is no production shadow period in
 * which divergences would surface harmlessly. This test is what stands in for
 * it: the new resolver must return EXACTLY what the live food resolver returns,
 * for the same user against the same estate, or the cutover silently changes who
 * can see what.
 *
 * The fixture is food-scope.test.ts's, deliberately: its two spines DISAGREE
 * (p-hyd-outsider sits in a Bangalore cluster but is served by the Hyderabad
 * kitchen), which is the shape live data actually has. A fixture whose spines
 * agree would pass with either spine deleted.
 *
 * `["*"]` is the sentinel for "unrestricted". Comparing raw values would let
 * null (no filter at all) and [] (match nothing) compare equal after a
 * `?? []`, and conflating those two is precisely the BROAD_FALLBACK bug that
 * once promoted a head from one zone to the entire network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

const {
  citiesTable, clustersTable, kitchensTable, propertiesTable, userScopesTable,
  orgNodesTable, orgNodeClosureTable, accessGrantsTable, employeesTable,
} = await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { resolveAccessiblePropertyIds } = await import("../food-service.js");
const { resolveAccess } = await import("../access.js");

/* ── the shared estate ──────────────────────────────────────────────────────
 *   zone Z-SOUTH ─┬─ city C-BLR ─┬─ cluster CL-BLR-1 ─ p-blr-1, p-blr-2, p-hyd-outsider
 *                 │              └─ kitchen  K-BLR    ─ serves p-blr-1
 *                 └─ city C-HYD ─┬─ cluster CL-HYD-1 ─ p-hyd-1
 *                                └─ kitchen  K-HYD    ─ serves p-hyd-1, p-hyd-outsider
 *   zone Z-NORTH ─── city C-DEL ─┬─ cluster CL-DEL-1 ─ p-del-1
 *                                └─ kitchen  K-DEL    ─ serves p-del-1
 */
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
const ZONES = [
  { id: "Z-SOUTH", isActive: true },
  { id: "Z-NORTH", isActive: true },
];

const ROOT = "org-root";

interface ScopeSeed {
  scopeLevel: string;
  zoneId?: string | null; cityId?: string | null; clusterId?: string | null;
  kitchenId?: string | null; propertyId?: string | null;
}

/** The legacy user_scopes row. */
const legacyScope = (s: ScopeSeed) => ({
  id: `s-${s.scopeLevel}-${s.zoneId ?? s.cityId ?? s.clusterId ?? s.kitchenId ?? s.propertyId ?? "g"}`,
  userId: "u-1",
  zoneId: null, cityId: null, clusterId: null, kitchenId: null, propertyId: null,
  isActive: true,
  ...s,
});

/**
 * Project the estate into org_nodes + closure, mirroring syncOrgNodes() exactly.
 * Written out here rather than imported so that a change to the projection which
 * breaks equivalence fails THIS test rather than being papered over by sharing
 * the same possibly-wrong code on both sides.
 */
function projectEstate() {
  const parentOf = new Map<string, string | null>();
  const nodes: Array<Record<string, unknown>> = [];
  const add = (id: string, nodeType: string, parentId: string | null) => {
    parentOf.set(id, parentId);
    nodes.push({ id, nodeType, parentId, path: `/${id}/`, depth: 0, name: id, code: null, isActive: true });
  };

  add(ROOT, "COMPANY", null);
  for (const z of ZONES) add(z.id, "ZONE", ROOT);
  for (const c of CITIES) add(c.id, "CITY", c.zoneId ?? ROOT);
  for (const cl of CLUSTERS) add(cl.id, "CLUSTER", cl.cityId);
  for (const k of KITCHENS) add(k.id, "KITCHEN", k.cityId);
  // An unclustered property attaches to the root — and is therefore reachable by
  // nothing below it, which is what "in no cluster" already means today.
  for (const p of PROPERTIES) add(p.id, "PROPERTY", p.clusterId ?? ROOT);

  const closure: Array<Record<string, unknown>> = [];
  for (const n of nodes) {
    let cur: string | null = n["id"] as string;
    let depth = 0;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: n["id"], depth, pathKind: "TREE" });
      cur = parentOf.get(cur) ?? null;
      depth++;
    }
  }
  // SERVES: the kitchen spine, attached to the kitchen AND its ancestors.
  for (const p of PROPERTIES) {
    if (!p.kitchenId) continue;
    let cur: string | null = p.kitchenId;
    let depth = 1;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: p.id, depth, pathKind: "SERVES" });
      cur = parentOf.get(cur) ?? null;
      depth++;
    }
  }
  return { nodes, closure };
}

/** Mirror of backfillAccessGrants for the food side: followLinks TRUE. */
function grantFromScope(s: ScopeSeed) {
  const node = s.propertyId ?? s.clusterId ?? s.kitchenId ?? s.cityId ?? s.zoneId ?? null;
  return {
    id: `g-${s.scopeLevel}-${node ?? "global"}`,
    subjectType: "USER", subjectId: "u-1", roleKey: "*",
    nodeId: s.scopeLevel === "GLOBAL" ? null : node,
    includeDescendants: true, followLinks: true,
    dataScope: "ALL", qualifiers: [], assignmentKind: "GRANT",
    effectiveFrom: new Date("2020-01-01"), expiresAt: null,
    revokedAt: null, revokedBy: null, grantedBy: null,
    grantedAt: new Date("2020-01-01"), expiryEventAt: null,
  };
}

const user = (role: string, propertyId: string | null = null) =>
  ({ id: "u-1", email: "u1@uniliv.com", role, propertyId }) as never;

function seedBoth(scopes: ScopeSeed[]) {
  const { nodes, closure } = projectEstate();
  seedDb([
    [citiesTable, CITIES],
    [clustersTable, CLUSTERS],
    [kitchensTable, KITCHENS],
    [propertiesTable, PROPERTIES],
    [userScopesTable, scopes.map(legacyScope)],
    [orgNodesTable, nodes],
    [orgNodeClosureTable, closure],
    [accessGrantsTable, scopes.map(grantFromScope)],
    [employeesTable, []],
  ]);
}

/** null (unrestricted) survives as a distinguishable sentinel. */
const norm = (ids: string[] | null) => (ids === null ? ["*"] : [...ids].sort());

async function assertEquivalent(u: never) {
  const legacy = await resolveAccessiblePropertyIds(u);
  const next = (await resolveAccess(u)).propertyIds;
  expect(norm(next)).toEqual(norm(legacy));
  return norm(legacy);
}

describe("resolveAccess ≡ resolveAccessiblePropertyIds", () => {
  beforeEach(() => resetDb());

  it("agrees for an always-global role", async () => {
    seedBoth([]);
    expect(await assertEquivalent(user("SUPER_ADMIN"))).toEqual(["*"]);
  });

  it("agrees for an explicit GLOBAL scope row", async () => {
    seedBoth([{ scopeLevel: "GLOBAL" }]);
    expect(await assertEquivalent(user("CLUSTER_MANAGER"))).toEqual(["*"]);
  });

  it("agrees when a user has no scope at all — both fail closed", async () => {
    seedBoth([]);
    expect(await assertEquivalent(user("UNIT_LEAD"))).toEqual([]);
  });

  it("agrees on a PROPERTY grant", async () => {
    seedBoth([{ scopeLevel: "PROPERTY", propertyId: "p-blr-2" }]);
    expect(await assertEquivalent(user("UNIT_LEAD"))).toEqual(["p-blr-2"]);
  });

  it("agrees on a CLUSTER grant", async () => {
    seedBoth([{ scopeLevel: "CLUSTER", clusterId: "CL-BLR-1" }]);
    expect(await assertEquivalent(user("CLUSTER_MANAGER")))
      .toEqual(["p-blr-1", "p-blr-2", "p-hyd-outsider"]);
  });

  it("agrees on a CITY grant — BOTH spines, which is where they disagree", async () => {
    // C-HYD reaches p-hyd-1 down the cluster spine and p-hyd-outsider down the
    // KITCHEN spine. If followLinks were off, the new resolver would drop the
    // outsider and this assertion is what catches it.
    seedBoth([{ scopeLevel: "CITY", cityId: "C-HYD" }]);
    expect(await assertEquivalent(user("CITY_HEAD")))
      .toEqual(["p-hyd-1", "p-hyd-outsider"]);
  });

  it("agrees on a KITCHEN grant", async () => {
    seedBoth([{ scopeLevel: "KITCHEN", kitchenId: "K-HYD" }]);
    expect(await assertEquivalent(user("FNB_MANAGER")))
      .toEqual(["p-hyd-1", "p-hyd-outsider"]);
  });

  it("agrees on a ZONE grant spanning two cities", async () => {
    seedBoth([{ scopeLevel: "ZONE", zoneId: "Z-SOUTH" }]);
    expect(await assertEquivalent(user("ZONAL_HEAD")))
      .toEqual(["p-blr-1", "p-blr-2", "p-hyd-1", "p-hyd-outsider"]);
  });

  it("agrees when several grants union", async () => {
    seedBoth([
      { scopeLevel: "PROPERTY", propertyId: "p-del-1" },
      { scopeLevel: "CLUSTER", clusterId: "CL-HYD-1" },
    ]);
    expect(await assertEquivalent(user("CLUSTER_MANAGER")))
      .toEqual(["p-del-1", "p-hyd-1"]);
  });

  it("agrees that an unclustered property is reachable by nothing above it", async () => {
    seedBoth([{ scopeLevel: "ZONE", zoneId: "Z-SOUTH" }]);
    const ids = await assertEquivalent(user("ZONAL_HEAD"));
    expect(ids).not.toContain("p-orphan");
  });

  it("agrees on the home-property seed for a property-bound user", async () => {
    seedBoth([]);
    expect(await assertEquivalent(user("UNIT_LEAD", "p-blr-1"))).toEqual(["p-blr-1"]);
  });
});
