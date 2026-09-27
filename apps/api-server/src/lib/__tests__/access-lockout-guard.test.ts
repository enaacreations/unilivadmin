/**
 * The lockout guard must actually fire.
 *
 * `assertAccessControlReachable` refuses a change that would leave nobody able
 * to administer access. It used to compare the incoming cell to the literal
 * `"configure"`. When actions became named per functionality that string
 * stopped being reachable — the cell is `administer_access` — so the filter
 * matched nothing and the guard silently became a no-op while every caller
 * still read as protected.
 *
 * Nothing caught that, because the guard's passing case and its dead case look
 * identical from the outside: both return without throwing. So this asserts the
 * REFUSAL, which is the only observable proof it is still wired up.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

const { roleFunctionalitiesTable, usersTable, userRolesTable } = await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { assertAccessControlReachable } = await import("../access/matrix-guards.js");

/** One role holding the admin cell, so removing it is what empties the set. */
function seedSoleAdmin(action: string) {
  resetDb();
  seedDb([[roleFunctionalitiesTable, [{
    id: "rf1", roleKey: "OPS_ADMIN", functionality: "ACCESS_CONTROL",
    action, allowed: true, updatedBy: null, updatedAt: new Date(),
  }]]]);
}

const revoke = (action: string) => [{
  roleKey: "OPS_ADMIN", functionality: "ACCESS_CONTROL", action, allowed: false,
}];

describe("assertAccessControlReachable", () => {
  it("refuses a change that removes the last administrator", async () => {
    seedSoleAdmin("administer_access");
    await expect(assertAccessControlReachable(revoke("administer_access"))).rejects.toThrow();
  });

  it("ignores a spelling the functionality does not declare", () => {
    // The old global verbs are gone. A caller sending one is not naming this
    // cell, so it is not a removal of it — and must not be treated as one.
    seedSoleAdmin("administer_access");
    return expect(assertAccessControlReachable(revoke("configure"))).resolves.toBeUndefined();
  });

  it("allows a change that leaves a real person holding it", async () => {
    resetDb();
    seedDb([
      [roleFunctionalitiesTable, [
        { id: "rf1", roleKey: "OPS_ADMIN", functionality: "ACCESS_CONTROL", action: "administer_access", allowed: true, updatedBy: null, updatedAt: new Date() },
        { id: "rf2", roleKey: "SEC_ADMIN", functionality: "ACCESS_CONTROL", action: "administer_access", allowed: true, updatedBy: null, updatedAt: new Date() },
      ]],
      [usersTable, [{ id: "u1", email: "sec@x.com", name: "Sec", role: "SEC_ADMIN", propertyId: null, isActive: true }]],
      [userRolesTable, [{ id: "ur1", userId: "u1", roleKey: "SEC_ADMIN", isActive: true }]],
    ]);
    await expect(assertAccessControlReachable(revoke("administer_access"))).resolves.toBeUndefined();
  });

  it("still refuses when the surviving role has no live holder", async () => {
    resetDb();
    seedDb([[roleFunctionalitiesTable, [
      { id: "rf1", roleKey: "OPS_ADMIN", functionality: "ACCESS_CONTROL", action: "administer_access", allowed: true, updatedBy: null, updatedAt: new Date() },
      { id: "rf2", roleKey: "SEC_ADMIN", functionality: "ACCESS_CONTROL", action: "administer_access", allowed: true, updatedBy: null, updatedAt: new Date() },
    ]]]);
    await expect(assertAccessControlReachable(revoke("administer_access"))).rejects.toThrow(/no ACTIVE user/i);
  });

  it("ignores changes to other cells entirely", async () => {
    seedSoleAdmin("administer_access");
    await expect(assertAccessControlReachable([
      { roleKey: "OPS_ADMIN", functionality: "ACCESS_CONTROL", action: "view_access", allowed: false },
      { roleKey: "OPS_ADMIN", functionality: "PROPERTIES", action: "delete_property", allowed: false },
    ])).resolves.toBeUndefined();
  });
});
