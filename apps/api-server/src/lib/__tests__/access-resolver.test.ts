/**
 * resolveAccess — the unified scope resolver.
 *
 * Runs against the in-memory fake-db, which EVALUATES the real drizzle condition
 * tree rather than stubbing returns, so the production query decides the answer.
 * No helper change was needed for this: the closure table answers descendants
 * with eq/inArray only, which is exactly why it was chosen over a path LIKE.
 *
 * The fixture's two spines disagree ON PURPOSE. `prop-hyd` sits under a Hyderabad
 * cluster but is SERVED by a Bengaluru kitchen — the same shape as
 * food-scope.test.ts's `p-hyd-outsider`, which exists because that disagreement
 * is real in live data. A test whose spines agree cannot catch a followLinks bug.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

const { orgNodesTable, orgNodeClosureTable, accessGrantsTable, employeesTable } =
  await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { resolveAccess } = await import("../access.js");

type NodeType = "COMPANY" | "ZONE" | "CITY" | "CLUSTER" | "KITCHEN" | "PROPERTY";

/** id → [type, parentId]. Order matters: a parent must precede its children. */
const TREE: Array<[string, NodeType, string | null]> = [
  ["comp", "COMPANY", null],
  ["zone-n", "ZONE", "comp"],
  ["city-blr", "CITY", "zone-n"],
  ["city-hyd", "CITY", "zone-n"],
  ["cluster-c1", "CLUSTER", "city-blr"],
  ["cluster-c2", "CLUSTER", "city-hyd"],
  ["kitchen-k1", "KITCHEN", "city-blr"],
  ["prop-a", "PROPERTY", "cluster-c1"],
  ["prop-b", "PROPERTY", "cluster-c1"],
  ["prop-hyd", "PROPERTY", "cluster-c2"],
];

/** kitchen-k1 serves prop-hyd — across the geographic spine, deliberately. */
const SERVES: Array<[string, string]> = [["kitchen-k1", "prop-hyd"]];

function buildFixture(opts: { inactive?: string[] } = {}) {
  const inactive = new Set(opts.inactive ?? []);
  const parentOf = new Map(TREE.map(([id, , parent]) => [id, parent]));

  const nodes = TREE.map(([id, nodeType, parentId]) => ({
    id, nodeType, parentId, path: `/${id}/`, depth: 0, name: id,
    code: null, isActive: !inactive.has(id),
  }));

  const closure: Array<{ ancestorId: string; descendantId: string; depth: number; pathKind: string }> = [];
  for (const [id] of TREE) {
    let cur: string | null = id;
    let depth = 0;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: id, depth, pathKind: "TREE" });
      cur = parentOf.get(cur) ?? null;
      depth++;
    }
  }
  // A SERVES edge attaches the served node to the server AND the server's own
  // ancestors, so a CITY grant with followLinks reaches it exactly as the food
  // resolver does today.
  for (const [serving, served] of SERVES) {
    let cur: string | null = serving;
    let depth = 1;
    while (cur) {
      closure.push({ ancestorId: cur, descendantId: served, depth, pathKind: "SERVES" });
      cur = parentOf.get(cur) ?? null;
      depth++;
    }
  }
  return { nodes, closure };
}

const FAR_PAST = new Date("2020-01-01");
const FAR_FUTURE = new Date("2099-01-01");

function grant(over: Record<string, unknown> = {}) {
  return {
    id: `g-${Math.random().toString(36).slice(2)}`,
    subjectType: "USER", subjectId: "u1", roleKey: "*",
    nodeId: null, includeDescendants: true, followLinks: false,
    dataScope: "ALL", qualifiers: [], assignmentKind: "GRANT",
    effectiveFrom: FAR_PAST, expiresAt: null, revokedAt: null, revokedBy: null,
    grantedBy: null, grantedAt: FAR_PAST, expiryEventAt: null,
    ...over,
  };
}

const user = (over: Record<string, unknown> = {}) =>
  ({ id: "u1", email: "w@x.com", role: "WARDEN", propertyId: null, ...over }) as never;

function seed(grants: Array<Record<string, unknown>>, opts: { inactive?: string[] } = {}) {
  const { nodes, closure } = buildFixture(opts);
  seedDb([
    [orgNodesTable, nodes],
    [orgNodeClosureTable, closure],
    [accessGrantsTable, grants],
    [employeesTable, []],
  ]);
}

const sorted = (a: string[] | null) => (a === null ? null : [...a].sort());

describe("resolveAccess", () => {
  beforeEach(() => resetDb());

  it("gives a super admin unrestricted access without reading any grant", () => {
    seed([]);
    return resolveAccess(user({ role: "SUPER_ADMIN" })).then((a) => {
      expect(a.isGlobalAdmin).toBe(true);
      expect(a.nodeIds).toBeNull();
      expect(a.propertyIds).toBeNull();
    });
  });

  it("fails CLOSED when a user has no grants at all", async () => {
    // The BROAD_FALLBACK regression in one assertion: "no grants" must mean
    // NOTHING, never org-wide. Getting this backwards once meant revoking a
    // head's last grant PROMOTED them to the whole network.
    seed([]);
    const a = await resolveAccess(user());
    expect(a.nodeIds).toEqual([]);
    expect(a.propertyIds).toEqual([]);
  });

  it("treats an org-wide grant (null node) as unrestricted", async () => {
    seed([grant({ nodeId: null })]);
    const a = await resolveAccess(user());
    expect(a.nodeIds).toBeNull();
    expect(a.propertyIds).toBeNull();
  });

  it("expands a cluster grant to the properties beneath it", async () => {
    seed([grant({ nodeId: "cluster-c1" })]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b"]);
    expect(a.nodeIds).toContain("cluster-c1");
  });

  it("honours includeDescendants:false as EXACTLY that node", async () => {
    // This is the PRD's "Specific Building / Floor / Room" scope.
    seed([grant({ nodeId: "cluster-c1", includeDescendants: false })]);
    const a = await resolveAccess(user());
    expect(a.nodeIds).toEqual(["cluster-c1"]);
    expect(a.propertyIds).toEqual([]);
  });

  it("does NOT cross the kitchen spine unless followLinks is set", async () => {
    // Defaulting followLinks true would have silently handed an audit CITY grant
    // every kitchen-served property outside its own geography.
    seed([grant({ nodeId: "city-blr" })]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b"]);
    expect(a.propertyIds).not.toContain("prop-hyd");
  });

  it("crosses the kitchen spine when followLinks is set", async () => {
    seed([grant({ nodeId: "city-blr", followLinks: true })]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b", "prop-hyd"]);
  });

  it("ignores revoked, expired and not-yet-effective grants", async () => {
    seed([
      grant({ nodeId: "cluster-c1", revokedAt: FAR_PAST }),
      grant({ nodeId: "cluster-c2", expiresAt: FAR_PAST }),
      grant({ nodeId: "city-blr", effectiveFrom: FAR_FUTURE }),
    ]);
    const a = await resolveAccess(user());
    expect(a.nodeIds).toEqual([]);
  });

  it("drops a grant that expands to nothing without discarding the others", async () => {
    // A stale grant on a deleted node must not blank out a user's real access.
    seed([grant({ nodeId: "cluster-c1" }), grant({ nodeId: "ghost-node" })]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b"]);
  });

  it("does not traverse an inactive node", async () => {
    // Matches expandZonesToCities: a retired cluster stops conferring access.
    seed([grant({ nodeId: "city-blr" })], { inactive: ["cluster-c1"] });
    const a = await resolveAccess(user());
    expect(a.propertyIds).not.toContain("prop-a");
  });

  it("seeds from the caller's home property so a pre-backfill user is not locked out", async () => {
    seed([]);
    const a = await resolveAccess(user({ propertyId: "prop-a" }));
    expect(a.propertyIds).toEqual(["prop-a"]);
  });

  it("separates kitchen ids from property ids", async () => {
    seed([grant({ nodeId: "city-blr" })]);
    const a = await resolveAccess(user());
    expect(a.kitchenIds).toEqual(["kitchen-k1"]);
    expect(a.propertyIds).not.toContain("kitchen-k1");
  });

  it("unions several grants and takes the widest data scope", async () => {
    seed([
      grant({ nodeId: "cluster-c1", dataScope: "ASSIGNED" }),
      grant({ nodeId: "cluster-c2", dataScope: "ALL" }),
    ]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b", "prop-hyd"]);
    expect(a.dataScope).toBe("ALL");
  });

  it("resolves a grant reaching the user through their ROLE", async () => {
    seed([grant({ subjectType: "ROLE", subjectId: "WARDEN", nodeId: "cluster-c1" })]);
    const a = await resolveAccess(user());
    expect(sorted(a.propertyIds)).toEqual(["prop-a", "prop-b"]);
  });
});
