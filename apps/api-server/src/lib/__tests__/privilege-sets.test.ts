/**
 * Privilege SETS resolve as a LIVE REFERENCE.
 *
 * The behaviour the whole design rests on: an assignment stores a pointer, and
 * the permissions it stands for are read at resolution time. Add a permission to
 * "Night audit cover" and everyone covering the night audit has it on their next
 * request, with no backfill and no drift.
 *
 * The alternative — copying the members into privilege rows at assignment time —
 * is easy to implement and wrong in a way that only shows up months later, when
 * a set has been edited three times and no two holders have the same access.
 * These tests exist so that shortcut cannot be taken back quietly.
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

// The node closure is a real query; every case here is "everywhere", so the
// expansion never runs — stubbed so the suite needs no database.
vi.mock("../org-tree.js", () => ({ descendantIds: async () => [] }));

const {
  privilegeSetsTable, privilegeSetItemsTable, privilegeSetAssignmentsTable, privilegesTable,
} = await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { readPrivileges, privilegeOn } = await import("../access/privileges.js");

const USER = "u-warden";
const SET = "set-night-cover";

function setRow(isActive = true) {
  return {
    id: SET, key: "night-audit-cover", name: "Night audit cover",
    description: "Covers the overnight audit.", effect: "GRANT", isActive,
    createdBy: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

/** The set, its members, and one live assignment to USER. */
function seedSet(items: Array<{ functionality: string; action: string }>, extra: Record<string, unknown> = {}) {
  seedDb([
    [privilegeSetsTable, [setRow()]],
    [privilegeSetItemsTable, items.map((i, n) => ({ id: `i${n}`, setId: SET, ...i }))],
    [privilegeSetAssignmentsTable, [{
      id: "a1", setId: SET, subjectType: "USER", subjectId: USER, roleKey: "*",
      nodeId: null, reason: "Covering the night audit",
      approvalKey: null, approvalFilename: null, approvalSize: null,
      effectiveFrom: new Date(Date.now() - 1000), expiresAt: null,
      grantedBy: "admin", grantedAt: new Date(), revokedAt: null,
      ...extra,
    }]],
    [privilegesTable, []],
  ]);
}

const holds = async (action: string, roles: string[] = ["WARDEN"]) => {
  const map = await readPrivileges(USER, roles);
  return privilegeOn(map, "AUDIT_EXECUTION" as never, action, null)?.effect;
};

describe("privilege sets", () => {
  beforeEach(() => resetDb());

  it("grants every permission in the set", async () => {
    seedSet([
      { functionality: "AUDIT_EXECUTION", action: "start_audit" },
      { functionality: "AUDIT_EXECUTION", action: "close_audit" },
    ]);
    expect(await holds("start_audit")).toBe("GRANT");
    expect(await holds("close_audit")).toBe("GRANT");
  });

  it("grants nothing the set does not contain", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }]);
    expect(await holds("discard_audit")).toBeUndefined();
  });

  /** The live reference, stated as a test: no reassignment, new permission. */
  it("picks up a permission ADDED to the set, with no reassignment", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }]);
    expect(await holds("close_audit")).toBeUndefined();

    seedDb([[privilegeSetItemsTable, [
      { id: "i0", setId: SET, functionality: "AUDIT_EXECUTION", action: "start_audit" },
      { id: "i1", setId: SET, functionality: "AUDIT_EXECUTION", action: "close_audit" },
    ]]]);

    expect(await holds("close_audit")).toBe("GRANT");
  });

  it("drops a permission REMOVED from the set, with no revocation", async () => {
    seedSet([
      { functionality: "AUDIT_EXECUTION", action: "start_audit" },
      { functionality: "AUDIT_EXECUTION", action: "close_audit" },
    ]);
    expect(await holds("close_audit")).toBe("GRANT");

    seedDb([[privilegeSetItemsTable, [
      { id: "i0", setId: SET, functionality: "AUDIT_EXECUTION", action: "start_audit" },
    ]]]);

    expect(await holds("close_audit")).toBeUndefined();
  });

  it("stops granting once the assignment is revoked", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }], { revokedAt: new Date() });
    expect(await holds("start_audit")).toBeUndefined();
  });

  it("stops granting once the assignment expires", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }], {
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await holds("start_audit")).toBeUndefined();
  });

  it("grants nothing while the set is disabled, without unpicking who holds it", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }]);
    seedDb([[privilegeSetsTable, [setRow(false)]]]);
    expect(await holds("start_audit")).toBeUndefined();
  });

  /**
   * A set hung under a role dies with the membership, exactly as a role-scoped
   * privilege does — otherwise revoking somebody's role leaves them holding a
   * bundle nobody can account for.
   */
  it("ignores a set scoped to a role the person no longer holds", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }], { roleKey: "AUDITOR" });
    expect(await holds("start_audit", ["WARDEN"])).toBeUndefined();
    expect(await holds("start_audit", ["WARDEN", "AUDITOR"])).toBe("GRANT");
  });

  it("names the set in the reason, so the answer to 'why' is the set", async () => {
    seedSet([{ functionality: "AUDIT_EXECUTION", action: "start_audit" }]);
    const map = await readPrivileges(USER, ["WARDEN"]);
    expect(privilegeOn(map, "AUDIT_EXECUTION" as never, "start_audit", null)?.reason)
      .toContain("Night audit cover");
  });
});
