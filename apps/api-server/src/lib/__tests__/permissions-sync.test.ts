import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  expandCell as BACKEND_EXPAND,
  FUNCTIONALITY_ACTIONS as BACKEND_ACTIONS,
  ROLE_PERMISSIONS as BACKEND,
  ALL_FUNCTIONALITIES as BACKEND_ALL_FUNCTIONALITIES,
  ALL_MODULES as BACKEND_ALL_MODULES,
  MODULE_FUNCTIONALITIES as BACKEND_TREE,
  FOOD_FUNCTIONALITIES as BACKEND_FOOD_FUNCTIONALITIES,
  AUDIT_FUNCTIONALITIES as BACKEND_AUDIT_FUNCTIONALITIES,
  type Functionality,
  type Cell,
  type Module,
  type UserRole,
} from "../permissions.js";

/** The shape both copies of the vocabulary must expose. */
interface PermissionsModule {
  ROLE_PERMISSIONS: Record<string, Partial<Record<Functionality, Cell>>>;
  ALL_FUNCTIONALITIES: Functionality[];
  ALL_MODULES: Module[];
  MODULE_FUNCTIONALITIES: Record<Module, Functionality[]>;
  FOOD_FUNCTIONALITIES: Functionality[];
  AUDIT_FUNCTIONALITIES: Functionality[];
  FUNCTIONALITY_ACTIONS: Record<Functionality, ReadonlyArray<{ key: string; label: string; description: string }>>;
  expandCell: (f: Functionality, cell: Cell) => string[];
}

/**
 * The RBAC matrix is duplicated on both sides (CLAUDE.md § RBAC) and the two
 * copies are only as trustworthy as something that compares them — so we load
 * the web app's copy from source rather than snapshotting it, because a
 * snapshot goes stale exactly when the drift it exists to catch happens.
 *
 * It cannot be a plain `import`: api-server's tsconfig sets rootDir to its own
 * src, and a relative import across the app boundary fails typecheck with
 * TS6059. Reading + transpiling keeps the comparison honest without loosening
 * that boundary. The web copy is a leaf module with no imports of its own, so
 * the `require` shim below is a tripwire, not a stub.
 */
function loadWebMatrix(): PermissionsModule {
  const path = fileURLToPath(
    new URL("../../../../uniliv-admin/src/lib/permissions.ts", import.meta.url),
  );
  const cjs = transformSync(readFileSync(path, "utf8"), { loader: "ts", format: "cjs" }).code;
  const module = { exports: {} as PermissionsModule };
  const require = (id: string) => {
    throw new Error(
      `${path} gained an import of "${id}"; permissions-sync.test.ts must be taught to resolve it.`,
    );
  };
  new Function("exports", "module", "require", cjs)(module.exports, module, require);
  return module.exports;
}

const web = loadWebMatrix();
/**
 * Each side as a self-contained module: its own matrix AND its own expander.
 * Comparing through a single shared expander would hide a drifted manifest,
 * which is half of what this file exists to catch.
 */
const FRONTEND = web;
const BACKEND_MOD = {
  ROLE_PERMISSIONS: BACKEND as PermissionsModule["ROLE_PERMISSIONS"],
  expandCell: BACKEND_EXPAND,
} as PermissionsModule;
const FRONTEND_ALL_FUNCTIONALITIES = web.ALL_FUNCTIONALITIES;
const FRONTEND_ALL_MODULES = web.ALL_MODULES;
const FRONTEND_TREE = web.MODULE_FUNCTIONALITIES;
const FRONTEND_FOOD_FUNCTIONALITIES = web.FOOD_FUNCTIONALITIES;
const FRONTEND_AUDIT_FUNCTIONALITIES = web.AUDIT_FUNCTIONALITIES;

/**
 * Compared per functionality, because that is where actions now live. The read
 * is the first declared action; everything else is a write for the purposes of
 * the escalation check below.
 */
const actionsOf = (f: Functionality): string[] =>
  BACKEND_ACTIONS[f].map((d) => d.key);
const readOf = (f: Functionality): string => BACKEND_ACTIONS[f][0]!.key;
/** Anything beyond `view` — the permissions that let a principal change data. */

const roles = Object.keys(BACKEND) as UserRole[];
const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * Every functionality key either matrix actually mentions — the union of both
 * ALL_FUNCTIONALITIES lists AND every key written into either ROLE_PERMISSIONS.
 *
 * Invariant: a grant is compared no matter where it was declared. Iterating
 * BACKEND_ALL_FUNCTIONALITIES alone left a blind spot — a grant written against
 * a key that is in neither list (a typo in one matrix, or one added to one
 * side's grants but to no list) was never compared, so the drift these tests
 * exist to catch could hide in it.
 */
const COMPARED_FUNCTIONALITIES = [
  ...new Set<Functionality>([
    ...BACKEND_ALL_FUNCTIONALITIES,
    ...FRONTEND_ALL_FUNCTIONALITIES,
    ...roles.flatMap((r) => [
      ...(Object.keys(BACKEND[r] ?? {}) as Functionality[]),
      ...(Object.keys(FRONTEND.ROLE_PERMISSIONS[r] ?? {}) as Functionality[]),
    ]),
  ]),
];

/**
 * Whether `matrix` grants one permission.
 *
 * A cell is a LEVEL or an explicit list, so this expands it the way the runtime
 * does. Each side expands with ITS OWN copy of the manifest — comparing through
 * one shared expander would hide a manifest that had drifted, which is half of
 * what this file exists to catch.
 */
const granted = (
  mod: PermissionsModule,
  role: string,
  functionality: Functionality,
  perm: string,
) => {
  const cell = mod.ROLE_PERMISSIONS[role]?.[functionality];
  return cell != null && mod.expandCell(functionality, cell).includes(perm);
};

describe("RBAC matrix — backend/frontend sync", () => {
  it("declares the same roles on both sides", () => {
    expect(sorted(Object.keys(FRONTEND.ROLE_PERMISSIONS))).toEqual(sorted(Object.keys(BACKEND)));
  });

  it("declares the same functionality lists on both sides", () => {
    expect(sorted(FRONTEND_ALL_FUNCTIONALITIES)).toEqual(sorted(BACKEND_ALL_FUNCTIONALITIES));
    expect(sorted(FRONTEND_FOOD_FUNCTIONALITIES)).toEqual(sorted(BACKEND_FOOD_FUNCTIONALITIES));
    expect(sorted(FRONTEND_AUDIT_FUNCTIONALITIES)).toEqual(sorted(BACKEND_AUDIT_FUNCTIONALITIES));
  });

  /**
   * The TREE itself has to match, not just the flat lists.
   *
   * Two copies could agree on all 54 functionalities and still disagree about
   * which module owns one — and because the module level is derived from this
   * map on both sides, that single disagreement would put a functionality in the
   * Audits section of the sidebar and the Operations card of the launcher. Order
   * is compared too: it drives display, and a tree that renders in two orders is
   * one nobody can scan twice.
   */
  it("declares the same module tree, in the same order, on both sides", () => {
    expect(FRONTEND_ALL_MODULES).toEqual(BACKEND_ALL_MODULES);
    for (const m of BACKEND_ALL_MODULES) {
      expect(FRONTEND_TREE[m], `module ${m}`).toEqual(BACKEND_TREE[m]);
    }
  });

  it("has no duplicate entries in ALL_FUNCTIONALITIES", () => {
    expect(new Set(BACKEND_ALL_FUNCTIONALITIES).size).toBe(BACKEND_ALL_FUNCTIONALITIES.length);
    expect(new Set(FRONTEND_ALL_FUNCTIONALITIES).size).toBe(FRONTEND_ALL_FUNCTIONALITIES.length);
  });

  /**
   * The partition, asserted from the outside.
   *
   * permissions.ts throws at import if this is broken, so this test is a
   * second line rather than the only one — but it is the line that names WHICH
   * key is wrong when the throw would only say a module is missing.
   */
  it("assigns every functionality to exactly one module, and shares no key between the levels", () => {
    const owners = new Map<string, Module[]>();
    for (const m of BACKEND_ALL_MODULES) {
      for (const f of BACKEND_TREE[m]) owners.set(f, [...(owners.get(f) ?? []), m]);
    }
    expect([...owners].filter(([, ms]) => ms.length !== 1)).toEqual([]);
    expect(sorted([...owners.keys()])).toEqual(sorted(BACKEND_ALL_FUNCTIONALITIES));
    expect(BACKEND_ALL_MODULES.filter((m) => owners.has(m))).toEqual([]);
  });

  // Privilege escalation: a write the API allows but the UI never shows is a
  // capability nobody reviewed. This is the direction that actually hurts, so
  // it gets its own assertion with a readable failure message.
  it("grants no backend write that the frontend does not also grant", () => {
    const escalations: string[] = [];
    for (const role of roles) {
      for (const f of COMPARED_FUNCTIONALITIES) {
        for (const perm of actionsOf(f).filter((a) => a !== readOf(f))) {
          if (granted(BACKEND_MOD, role, f, perm) && !granted(FRONTEND, role, f, perm)) {
            escalations.push(`${role}.${f}.${perm}`);
          }
        }
      }
    }
    expect(escalations).toEqual([]);
  });

  // The two matrices are meant to be identical, not merely compatible: a UI
  // that offers what the API refuses is a broken flow, the mirror-image defect.
  it("resolves every role × functionality × permission identically on both sides", () => {
    const divergences: string[] = [];
    for (const role of roles) {
      for (const f of COMPARED_FUNCTIONALITIES) {
        for (const perm of actionsOf(f)) {
          const be = granted(BACKEND_MOD, role, f, perm);
          const fe = granted(FRONTEND, role, f, perm);
          if (be !== fe) divergences.push(`${role}.${f}.${perm}: api=${be} web=${fe}`);
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  // The everything-granted roles are built from ALL_FUNCTIONALITIES on both
  // sides, so a functionality added to the union but not to the tree would leave
  // admins locked out of it.
  it("gives the parity roles every functionality", () => {
    for (const role of ["SUPER_ADMIN", "OPS_EXCELLENCE", "AUDIT_READONLY"] as UserRole[]) {
      const missing = BACKEND_ALL_FUNCTIONALITIES.filter((f) => !granted(BACKEND_MOD, role, f, readOf(f)));
      expect(missing).toEqual([]);
    }
  });
});

describe("RBAC matrix — food separation of duties (C3)", () => {
  // The party that ships must not be the party that certifies receipt. Only the
  // two break-glass parity roles may hold both edits; every operational role
  // sits on exactly one side of the handover. Widening FOOD_CONFIRM_DELIVERY to
  // clear a 403 on a dispatch path re-opens C3, so this test fails loudly on it.
  const BREAK_GLASS: UserRole[] = ["SUPER_ADMIN", "OPS_EXCELLENCE"];

  it("lets no operational role both dispatch and confirm delivery", () => {
    for (const matrix of [BACKEND_MOD, FRONTEND]) {
      const both = roles.filter(
        (r) =>
          !BREAK_GLASS.includes(r) &&
          // The SHIPPING action and the CERTIFYING action by name. Checking
          // "edit" on each was a translation of the old verbs and tested a
          // weaker pair: amending a delivery record is not certifying receipt,
          // and marking dispatched is the act the handover separates.
          granted(matrix, r, "FOOD_DISPATCH", "mark_dispatched") &&
          granted(matrix, r, "FOOD_CONFIRM_DELIVERY", "confirm_receipt"),
      );
      expect(both).toEqual([]);
    }
  });

  it("keeps the kitchen roles on the shipping side", () => {
    for (const role of ["FNB_SUPERVISOR", "FNB_MANAGER"] as UserRole[]) {
      expect(granted(BACKEND_MOD, role, "FOOD_DISPATCH", "mark_dispatched")).toBe(true);
      expect(granted(BACKEND_MOD, role, "FOOD_CONFIRM_DELIVERY", "confirm_receipt")).toBe(false);
    }
  });

  it("keeps the receiving roles on the certifying side", () => {
    for (const role of ["UNIT_LEAD", "CLUSTER_MANAGER"] as UserRole[]) {
      expect(granted(BACKEND_MOD, role, "FOOD_CONFIRM_DELIVERY", "confirm_receipt")).toBe(true);
      expect(granted(BACKEND_MOD, role, "FOOD_DISPATCH", "mark_dispatched")).toBe(false);
    }
  });
});

describe("RBAC matrix — the former menu-planning personas", () => {
  // Menu Planning and Recipes were removed product-wide, taking the
  // MENU_PLANNING / RECIPES modules and the generate-indent route with them.
  // These two roles owned that page, so they are the ones whose cells the
  // removal touched — both assertions below are about what must NOT come back
  // with a future kitchen feature.
  //
  // KITCHEN_MANAGER has since become "F&B Store" — a central kitchen and store
  // that receives goods against its own indents — so the reason this test
  // demanded ("must not be reinstated without one") now exists for it, and it
  // holds INDENTS and GRN deliberately. It stays in the PROPERTIES assertion
  // below, which is about a different and still-live leak.
  const OWNERS: UserRole[] = ["KITCHEN_MANAGER", "FNB_MANAGER"];
  const INDENT_OWNERS: UserRole[] = ["FNB_MANAGER"];

  it("does NOT give the former menu-planning owners the PROPERTIES module", () => {
    // PROPERTIES:view also opens /properties/assignable-unit-leads, which has no
    // scoping and returns the name, email and role of every unit lead in the org.
    // If GET /properties 403s for these roles, widen that ONE route with
    // authorizeAny — not this cell.
    for (const role of OWNERS) {
      expect(granted(BACKEND_MOD, role, "PROPERTIES", "view_property")).toBe(false);
    }
  });

  it("leaves the former menu-planning owners no indent access at all", () => {
    // They held INDENTS:create solely for POST /menu-plans/:id/generate-indent,
    // which minted a procurement document. That route is gone, so the grant has
    // no remaining purpose and must not be reinstated without one.
    for (const role of INDENT_OWNERS) {
      expect(granted(BACKEND_MOD, role, "INDENTS", "add_indent")).toBe(false);
      expect(granted(BACKEND_MOD, role, "INDENTS", "view_indent")).toBe(false);
      expect(granted(BACKEND_MOD, role, "INDENTS", "edit_indent")).toBe(false);
      expect(granted(BACKEND_MOD, role, "INDENTS", "delete")).toBe(false);
    }
  });
});

describe("named actions — both copies", () => {
  const web = loadWebMatrix();

  /**
   * Deep-compared including label and description, not just the keys.
   *
   * The description is what the UI puts in front of whoever is granting the
   * access — "Remove a property for good". If the two copies disagree about it,
   * the sentence the granter reads is not the permission the server enforces,
   * which is worse than no sentence at all.
   */
  it("agree on every action, label and description", () => {
    expect(web.FUNCTIONALITY_ACTIONS).toEqual(BACKEND_ACTIONS);
  });

  it("agree on the functionalities that have actions", () => {
    expect(Object.keys(web.FUNCTIONALITY_ACTIONS).sort())
      .toEqual(Object.keys(BACKEND_ACTIONS).sort());
  });
});
