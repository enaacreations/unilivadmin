import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  ROLE_PERMISSIONS as BACKEND,
  ALL_MODULES as BACKEND_ALL_MODULES,
  FOOD_MODULES as BACKEND_FOOD_MODULES,
  AUDIT_MODULES as BACKEND_AUDIT_MODULES,
  type Module,
  type Permission,
  type UserRole,
} from "../permissions.js";

/** The shape both copies of the matrix must expose. */
interface PermissionsModule {
  ROLE_PERMISSIONS: Record<string, Partial<Record<Module, Partial<Record<Permission, boolean>>>>>;
  ALL_MODULES: Module[];
  FOOD_MODULES: Module[];
  AUDIT_MODULES: Module[];
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
const FRONTEND = web.ROLE_PERMISSIONS;
const FRONTEND_ALL_MODULES = web.ALL_MODULES;
const FRONTEND_FOOD_MODULES = web.FOOD_MODULES;
const FRONTEND_AUDIT_MODULES = web.AUDIT_MODULES;

const PERMISSIONS: Permission[] = ["view", "create", "edit", "delete"];
/** Anything beyond `view` — the permissions that let a principal change data. */
const WRITE_PERMISSIONS: Permission[] = ["create", "edit", "delete"];

const roles = Object.keys(BACKEND) as UserRole[];
const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * Every module key either matrix actually mentions — the union of both
 * ALL_MODULES lists AND every key written into either ROLE_PERMISSIONS.
 *
 * Invariant: a grant is compared no matter where it was declared. Iterating
 * BACKEND_ALL_MODULES alone left a blind spot — a grant written against a
 * module key that is in neither ALL_MODULES list (a typo'd module in one
 * matrix, or a module added to one side's grants but to no list) was never
 * compared, so the drift these tests exist to catch could hide in it.
 */
const COMPARED_MODULES = [
  ...new Set<Module>([
    ...BACKEND_ALL_MODULES,
    ...FRONTEND_ALL_MODULES,
    ...roles.flatMap((r) => [
      ...(Object.keys(BACKEND[r] ?? {}) as Module[]),
      ...(Object.keys(FRONTEND[r] ?? {}) as Module[]),
    ]),
  ]),
];

const granted = (
  matrix: Record<string, Partial<Record<Module, Partial<Record<Permission, boolean>>>>>,
  role: string,
  module: Module,
  perm: Permission,
) => matrix[role]?.[module]?.[perm] === true;

describe("RBAC matrix — backend/frontend sync", () => {
  it("declares the same roles on both sides", () => {
    expect(sorted(Object.keys(FRONTEND))).toEqual(sorted(Object.keys(BACKEND)));
  });

  it("declares the same module lists on both sides", () => {
    expect(sorted(FRONTEND_ALL_MODULES)).toEqual(sorted(BACKEND_ALL_MODULES));
    expect(sorted(FRONTEND_FOOD_MODULES)).toEqual(sorted(BACKEND_FOOD_MODULES));
    expect(sorted(FRONTEND_AUDIT_MODULES)).toEqual(sorted(BACKEND_AUDIT_MODULES));
  });

  it("has no duplicate entries in ALL_MODULES", () => {
    expect(new Set(BACKEND_ALL_MODULES).size).toBe(BACKEND_ALL_MODULES.length);
    expect(new Set(FRONTEND_ALL_MODULES).size).toBe(FRONTEND_ALL_MODULES.length);
  });

  // Privilege escalation: a write the API allows but the UI never shows is a
  // capability nobody reviewed. This is the direction that actually hurts, so
  // it gets its own assertion with a readable failure message.
  it("grants no backend write that the frontend does not also grant", () => {
    const escalations: string[] = [];
    for (const role of roles) {
      for (const module of COMPARED_MODULES) {
        for (const perm of WRITE_PERMISSIONS) {
          if (granted(BACKEND, role, module, perm) && !granted(FRONTEND, role, module, perm)) {
            escalations.push(`${role}.${module}.${perm}`);
          }
        }
      }
    }
    expect(escalations).toEqual([]);
  });

  // The two matrices are meant to be identical, not merely compatible: a UI
  // that offers what the API refuses is a broken flow, the mirror-image defect.
  it("resolves every role × module × permission identically on both sides", () => {
    const divergences: string[] = [];
    for (const role of roles) {
      for (const module of COMPARED_MODULES) {
        for (const perm of PERMISSIONS) {
          const be = granted(BACKEND, role, module, perm);
          const fe = granted(FRONTEND, role, module, perm);
          if (be !== fe) divergences.push(`${role}.${module}.${perm}: api=${be} web=${fe}`);
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  // The everything-granted roles are built from ALL_MODULES on both sides, so a
  // module added to the union but not to that list would leave admins locked out.
  it("gives the parity roles every module", () => {
    for (const role of ["SUPER_ADMIN", "OPS_EXCELLENCE", "AUDIT_READONLY"] as UserRole[]) {
      const missing = BACKEND_ALL_MODULES.filter((m) => !granted(BACKEND, role, m, "view"));
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
    for (const matrix of [BACKEND, FRONTEND]) {
      const both = roles.filter(
        (r) =>
          !BREAK_GLASS.includes(r) &&
          granted(matrix, r, "FOOD_DISPATCH", "edit") &&
          granted(matrix, r, "FOOD_CONFIRM_DELIVERY", "edit"),
      );
      expect(both).toEqual([]);
    }
  });

  it("keeps the kitchen roles on the shipping side", () => {
    for (const role of ["FNB_SUPERVISOR", "FNB_MANAGER", "FNB_ZONAL_HEAD"] as UserRole[]) {
      expect(granted(BACKEND, role, "FOOD_DISPATCH", "edit")).toBe(true);
      expect(granted(BACKEND, role, "FOOD_CONFIRM_DELIVERY", "edit")).toBe(false);
    }
  });

  it("keeps the receiving roles on the certifying side", () => {
    for (const role of ["UNIT_LEAD", "CLUSTER_MANAGER"] as UserRole[]) {
      expect(granted(BACKEND, role, "FOOD_CONFIRM_DELIVERY", "edit")).toBe(true);
      expect(granted(BACKEND, role, "FOOD_DISPATCH", "edit")).toBe(false);
    }
  });
});

describe("RBAC matrix — the former menu-planning personas", () => {
  // Menu Planning and Recipes were removed product-wide, taking the
  // MENU_PLANNING / RECIPES modules and the generate-indent route with them.
  // These two roles owned that page, so they are the ones whose cells the
  // removal touched — both assertions below are about what must NOT come back
  // with a future kitchen feature.
  const OWNERS: UserRole[] = ["KITCHEN_MANAGER", "FNB_MANAGER"];

  it("does NOT give the former menu-planning owners the PROPERTIES module", () => {
    // PROPERTIES:view also opens /properties/assignable-unit-leads, which has no
    // scoping and returns the name, email and role of every unit lead in the org.
    // If GET /properties 403s for these roles, widen that ONE route with
    // authorizeAny — not this cell.
    for (const role of OWNERS) {
      expect(granted(BACKEND, role, "PROPERTIES", "view")).toBe(false);
    }
  });

  it("leaves the former menu-planning owners no indent access at all", () => {
    // They held INDENTS:create solely for POST /menu-plans/:id/generate-indent,
    // which minted a procurement document. That route is gone, so the grant has
    // no remaining purpose and must not be reinstated without one.
    for (const role of OWNERS) {
      expect(granted(BACKEND, role, "INDENTS", "create")).toBe(false);
      expect(granted(BACKEND, role, "INDENTS", "view")).toBe(false);
      expect(granted(BACKEND, role, "INDENTS", "edit")).toBe(false);
      expect(granted(BACKEND, role, "INDENTS", "delete")).toBe(false);
    }
  });
});
