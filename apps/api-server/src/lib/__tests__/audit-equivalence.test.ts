/**
 * The audit half of the cutover gate.
 *
 * toAuditAccess(resolveAccess(u)) must equal resolveAuditAccess(u) for the same
 * user and estate — otherwise flipping resolveAuditAccess's body silently
 * changes which audits ~15 call sites will show.
 *
 * Audit's org spine is the geographic one ONLY: it never follows the kitchen
 * spine, which is why its backfilled grants carry followLinks:false. The
 * p-hyd-outsider case below is the assertion that keeps it that way — if audit
 * grants ever started following kitchens, an auditor scoped to Hyderabad would
 * silently gain a Bangalore property.
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
  citiesTable, clustersTable, propertiesTable, auditRoleGrantsTable,
  orgNodesTable, orgNodeClosureTable, accessGrantsTable, employeesTable,
} = await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { resolveAuditAccess } = await import("../audit-access.js");
const { resolveAccess } = await import("../access.js");
const { toAuditAccess } = await import("../access/audit-adapter.js");

const ROOT = "org-root";
const CITIES = [
  { id: "C-BLR", zoneId: "Z-SOUTH", isActive: true },
  { id: "C-HYD", zoneId: "Z-SOUTH", isActive: true },
];
const CLUSTERS = [
  { id: "CL-BLR-1", cityId: "C-BLR", isActive: true },
  { id: "CL-HYD-1", cityId: "C-HYD", isActive: true },
];
const PROPERTIES = [
  { id: "p-blr-1", clusterId: "CL-BLR-1", kitchenId: "K-HYD" },
  { id: "p-blr-2", clusterId: "CL-BLR-1", kitchenId: null },
  { id: "p-hyd-1", clusterId: "CL-HYD-1", kitchenId: "K-HYD" },
];

const FAR_PAST = new Date("2020-01-01");

interface GrantSeed {
  moduleRole: string;
  auditTypes: string[];
  scopeLevel: string;
  zoneId?: string | null; cityId?: string | null;
  clusterId?: string | null; propertyId?: string | null;
}

const legacyGrant = (g: GrantSeed, i: number) => ({
  id: `ag-${i}`, userId: "u-1", moduleRole: g.moduleRole, auditTypes: g.auditTypes,
  scopeLevel: g.scopeLevel,
  zoneId: g.zoneId ?? null, cityId: g.cityId ?? null,
  clusterId: g.clusterId ?? null, propertyId: g.propertyId ?? null,
  effectiveFrom: FAR_PAST, expiresAt: null, grantedBy: null, grantedAt: FAR_PAST,
  revokedAt: null, revokedBy: null, expiryEventAt: null,
});

/** Mirror of backfillAccessGrants' audit branch: followLinks FALSE. */
const newGrant = (g: GrantSeed, i: number) => ({
  id: `g-${i}`, subjectType: "USER", subjectId: "u-1",
  roleKey: `AUDIT.${g.moduleRole}`,
  nodeId: g.scopeLevel === "GLOBAL"
    ? null
    : (g.propertyId ?? g.clusterId ?? g.cityId ?? g.zoneId ?? null),
  includeDescendants: true, followLinks: false,
  dataScope: "ALL", qualifiers: g.auditTypes, assignmentKind: "GRANT",
  effectiveFrom: FAR_PAST, expiresAt: null, revokedAt: null, revokedBy: null,
  grantedBy: null, grantedAt: FAR_PAST, expiryEventAt: null,
});

function projectEstate() {
  const parentOf = new Map<string, string | null>();
  const nodes: Array<Record<string, unknown>> = [];
  const add = (id: string, nodeType: string, parentId: string | null) => {
    parentOf.set(id, parentId);
    nodes.push({ id, nodeType, parentId, path: `/${id}/`, depth: 0, name: id, code: null, isActive: true });
  };
  add(ROOT, "COMPANY", null);
  add("Z-SOUTH", "ZONE", ROOT);
  for (const c of CITIES) add(c.id, "CITY", c.zoneId);
  for (const cl of CLUSTERS) add(cl.id, "CLUSTER", cl.cityId);
  add("K-HYD", "KITCHEN", "C-HYD");
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

function seedBoth(grants: GrantSeed[]) {
  const { nodes, closure } = projectEstate();
  seedDb([
    [citiesTable, CITIES],
    [clustersTable, CLUSTERS],
    [propertiesTable, PROPERTIES],
    [auditRoleGrantsTable, grants.map(legacyGrant)],
    [orgNodesTable, nodes],
    [orgNodeClosureTable, closure],
    [accessGrantsTable, grants.map(newGrant)],
    [employeesTable, []],
  ]);
}

const user = (role = "CUSTOMER_EXPERIENCE") =>
  ({ id: "u-1", email: "u1@uniliv.com", role, propertyId: null }) as never;

/** Comparable, order-independent snapshot of an AuditAccess. */
function snapshot(a: { isGlobalAdmin: boolean; userId: string; byRole: Map<string, Array<{ auditTypes: string[]; propertyIds: string[] | null }>> }) {
  const roles: Record<string, string[]> = {};
  for (const [role, scopes] of a.byRole) {
    roles[role] = scopes
      .map((s) => `${[...s.auditTypes].sort().join("|")}@${s.propertyIds === null ? "*" : [...s.propertyIds].sort().join(",")}`)
      .sort();
  }
  return { isGlobalAdmin: a.isGlobalAdmin, userId: a.userId, roles };
}

async function assertEquivalent(u: never) {
  const legacy = await resolveAuditAccess(u);
  const next = toAuditAccess(await resolveAccess(u));
  expect(snapshot(next)).toEqual(snapshot(legacy));
  return snapshot(legacy);
}

describe("toAuditAccess(resolveAccess) ≡ resolveAuditAccess", () => {
  beforeEach(() => resetDb());

  it("agrees for a super admin", async () => {
    seedBoth([]);
    const s = await assertEquivalent(user("SUPER_ADMIN"));
    expect(s.isGlobalAdmin).toBe(true);
  });

  it("agrees when the user holds no audit grant", async () => {
    seedBoth([]);
    const s = await assertEquivalent(user());
    expect(s.roles).toEqual({});
  });

  it("agrees on a GLOBAL grant", async () => {
    seedBoth([{ moduleRole: "VIEWER", auditTypes: ["UL"], scopeLevel: "GLOBAL" }]);
    const s = await assertEquivalent(user());
    expect(s.roles["VIEWER"]).toEqual(["UL@*"]);
  });

  it("agrees on a CLUSTER grant", async () => {
    seedBoth([{ moduleRole: "AUDITOR", auditTypes: ["UL", "CM"], scopeLevel: "CLUSTER", clusterId: "CL-BLR-1" }]);
    const s = await assertEquivalent(user());
    expect(s.roles["AUDITOR"]).toEqual(["CM|UL@p-blr-1,p-blr-2"]);
  });

  it("does NOT follow the kitchen spine — the audit/food difference", async () => {
    // p-blr-1 is served by K-HYD. A CITY C-HYD grant must NOT reach it: audit
    // scopes geographically only. If the backfill ever set followLinks:true for
    // audit, this is the assertion that fails.
    seedBoth([{ moduleRole: "AUDITOR", auditTypes: ["CX"], scopeLevel: "CITY", cityId: "C-HYD" }]);
    const s = await assertEquivalent(user());
    expect(s.roles["AUDITOR"]).toEqual(["CX@p-hyd-1"]);
  });

  it("agrees when one user holds several module roles", async () => {
    seedBoth([
      { moduleRole: "AUDITOR", auditTypes: ["UL"], scopeLevel: "CLUSTER", clusterId: "CL-BLR-1" },
      { moduleRole: "REVIEWER", auditTypes: ["CM"], scopeLevel: "CITY", cityId: "C-HYD" },
    ]);
    const s = await assertEquivalent(user());
    expect(Object.keys(s.roles).sort()).toEqual(["AUDITOR", "REVIEWER"]);
  });

  it("agrees that a grant with no recognised audit type is dropped whole", async () => {
    seedBoth([{ moduleRole: "AUDITOR", auditTypes: ["NOPE"], scopeLevel: "CLUSTER", clusterId: "CL-BLR-1" }]);
    const s = await assertEquivalent(user());
    expect(s.roles).toEqual({});
  });

  it("drops a grant naming a property that no longer exists — a DELIBERATE divergence", async () => {
    // The one place the two resolvers disagree, and it is intentional.
    //
    // Legacy expandGrantToPropertyIds trusts a PROPERTY-level grant blindly:
    // it returns [id] without checking the row exists, so a grant on a deleted
    // property survives carrying a dead id. The new resolver expands through the
    // closure table, finds no row, and drops the grant.
    //
    // Observably identical: a dead id in an IN-list matches nothing, so both
    // produce the same audits. The difference is shape only — which is why this
    // is safe to cut over on. Asserting the NEW behaviour rather than parity,
    // because parity here would mean preserving a bug.
    seedBoth([{ moduleRole: "AUDITOR", auditTypes: ["UL"], scopeLevel: "PROPERTY", propertyId: "ghost" }]);

    const legacy = await resolveAuditAccess(user());
    const next = toAuditAccess(await resolveAccess(user()));

    expect(snapshot(legacy).roles).toEqual({ AUDITOR: ["UL@ghost"] });
    expect(snapshot(next).roles).toEqual({});
  });

  it("keeps a live grant when a dangling one sits beside it", async () => {
    // The consequence that actually matters: dropping the dead grant must not
    // take the good one with it.
    seedBoth([
      { moduleRole: "AUDITOR", auditTypes: ["UL"], scopeLevel: "PROPERTY", propertyId: "ghost" },
      { moduleRole: "AUDITOR", auditTypes: ["UL"], scopeLevel: "CLUSTER", clusterId: "CL-HYD-1" },
    ]);
    const next = toAuditAccess(await resolveAccess(user()));
    expect(snapshot(next).roles["AUDITOR"]).toEqual(["UL@p-hyd-1"]);
  });
});
