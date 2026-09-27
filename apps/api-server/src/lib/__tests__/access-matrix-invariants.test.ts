/**
 * Invariants the capability matrix must hold, whatever anyone edits into it.
 *
 * These were written against the old global-verb model (does any cell hold
 * `edit` without `view`? is `Permission` a subset of `Action`?). Those
 * questions no longer exist: actions are declared per functionality, and a cell
 * is a LEVEL expanded through the manifest. The invariants that survive are the
 * ones that were never really about verbs.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_PERMISSIONS,
  ALL_FUNCTIONALITIES,
  actionDef,
  expandCell,
  namedActionsFor,
  readActionOf,
  type Cell,
  type Functionality,
  type UserRole,
} from "../permissions.js";

const ROLES = Object.keys(ROLE_PERMISSIONS) as UserRole[];
const cellOf = (role: UserRole, f: Functionality): Cell | undefined =>
  (ROLE_PERMISSIONS[role] as Partial<Record<Functionality, Cell>>)[f];

describe("capability matrix invariants", () => {
  /**
   * The read-implication in decide() and matrixCan() widens toward the read.
   * It cannot do that if a cell grants a write on a functionality whose read it
   * does not also grant — the holder would be able to act on something they
   * cannot open. FULL and VIEW make this true by construction; an explicit list
   * is where somebody can get it wrong.
   */
  it("grants no action without the matching read", () => {
    const offenders: string[] = [];
    for (const role of ROLES) {
      for (const f of ALL_FUNCTIONALITIES) {
        const cell = cellOf(role, f);
        if (!cell) continue;
        const held = expandCell(f, cell);
        const read = readActionOf(f);
        if (held.length && read && !held.includes(read)) {
          offenders.push(`${role}.${f} holds [${held.join(", ")}] without ${read}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * An explicit list is the one cell shape that can name a permission that does
   * not exist. `expandCell` filters those out, so a typo grants nothing — but
   * silently, which is how a role ends up with less than its author intended.
   */
  it("names only real permissions in explicit cells", () => {
    const unknown: string[] = [];
    for (const role of ROLES) {
      for (const f of ALL_FUNCTIONALITIES) {
        const cell = cellOf(role, f);
        if (!Array.isArray(cell)) continue;
        for (const a of cell) {
          if (!actionDef(f, a)) unknown.push(`${role}.${f}.${a}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("gives every functionality at least one action to grant", () => {
    for (const f of ALL_FUNCTIONALITIES) {
      expect(namedActionsFor(f).length, f).toBeGreaterThan(0);
      expect(readActionOf(f), f).toBeTruthy();
    }
  });

  it("expands the levels to what they say", () => {
    // FULL is everything the functionality declares; VIEW is its read alone.
    expect(expandCell("PROPERTIES", "FULL")).toEqual(
      namedActionsFor("PROPERTIES").map((d) => d.key),
    );
    expect(expandCell("PROPERTIES", "VIEW")).toEqual(["view_property"]);
    expect(expandCell("AUDIT_EXECUTION", "VIEW")).toEqual(["view_audit"]);
  });
});
