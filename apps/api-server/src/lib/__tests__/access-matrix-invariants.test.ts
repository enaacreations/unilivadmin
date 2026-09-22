/**
 * Invariants the capability matrix must hold BEFORE action implication or a
 * DB-backed matrix can be switched on.
 *
 * These are the assertions that license the next phase. Each one, if it fails,
 * means a specific downstream change would silently grant something.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_PERMISSIONS,
  ALL_MODULES,
  ALL_ACTIONS,
  IMPLIES,
  actionsFor,
  type Module,
  type Action,
  type UserRole,
} from "../permissions.js";

const ROLES = Object.keys(ROLE_PERMISSIONS) as UserRole[];
const granted = (role: UserRole, module: Module, action: Action): boolean =>
  (ROLE_PERMISSIONS[role] as Record<string, Record<string, boolean> | undefined>)[module]?.[action] === true;

describe("capability matrix invariants", () => {
  it("has no write granted without the matching read", () => {
    // THE gate for action implication. IMPLIES maps every write to `view`, so if
    // any cell today holds edit/create/delete WITHOUT view, switching implication
    // on would retroactively hand that role a read it was never given.
    const offenders: string[] = [];
    for (const role of ROLES) {
      for (const module of ALL_MODULES) {
        for (const action of ["create", "edit", "delete"] as Action[]) {
          if (granted(role, module, action) && !granted(role, module, "view")) {
            offenders.push(`${role}.${module}.${action} without view`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("maps every implication onto a real action", () => {
    for (const [from, tos] of Object.entries(IMPLIES)) {
      expect(ALL_ACTIONS).toContain(from as Action);
      for (const to of tos ?? []) expect(ALL_ACTIONS).toContain(to);
    }
  });

  it("never implies a write", () => {
    // An implication that conferred edit/delete/configure would turn a read
    // grant into a write grant. Keep the edges read-only, forever.
    const writes: Action[] = ["create", "edit", "delete", "configure", "approve", "reject"];
    for (const [from, tos] of Object.entries(IMPLIES)) {
      for (const to of tos ?? []) {
        expect(writes, `${from} must not imply the write "${to}"`).not.toContain(to);
      }
    }
  });

  it("declares an action set for every module, containing the legacy four where used", () => {
    // A module whose action set omits an action some role already holds would
    // silently revoke it the moment actionsFor() starts gating the matrix.
    const lost: string[] = [];
    for (const module of ALL_MODULES) {
      const allowed = new Set(actionsFor(module));
      for (const role of ROLES) {
        for (const action of ["view", "create", "edit", "delete"] as Action[]) {
          if (granted(role, module, action) && !allowed.has(action)) {
            lost.push(`${role}.${module}.${action} is granted but not in actionsFor(${module})`);
          }
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it("keeps Permission a strict subset of Action", () => {
    for (const p of ["view", "create", "edit", "delete"]) expect(ALL_ACTIONS).toContain(p as Action);
  });
});
