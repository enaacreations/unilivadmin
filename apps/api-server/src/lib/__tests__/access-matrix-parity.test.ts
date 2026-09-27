/**
 * The DB matrix must resolve identically to the code matrix.
 *
 * This is the acceptance test for making the matrix editable: `can()` reads the
 * database, so if the seeded cells disagree with ROLE_PERMISSIONS even once,
 * flipping it silently changes who can do what across 518 routes.
 *
 * Verified against the live dev database at seed time (4752 legacy cells, 0
 * divergences); this keeps it true as the code matrix changes.
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

const { roleFunctionalitiesTable, accessMatrixVersionTable } = await import("@workspace/db");
const { resetDb, seedDb } = await import("./helpers/fake-db.js");
const { loadMatrix, matrixCan, isManifestCell, SYSTEM_ROLES } = await import("../access/matrix.js");
const { ROLE_PERMISSIONS, ALL_FUNCTIONALITIES, namedActionsFor, expandCell, can } =
  await import("../permissions.js");

/** Expand ROLE_PERMISSIONS into rows exactly as seedMatrix() does. */
function seedRows() {
  const rows: Array<Record<string, unknown>> = [];
  let i = 0;
  for (const [roleKey, matrix] of Object.entries(ROLE_PERMISSIONS)) {
    if (roleKey in SYSTEM_ROLES) continue; // computed, never stored
    for (const [functionality, cell] of Object.entries(matrix ?? {})) {
      for (const action of expandCell(functionality as never, cell as never)) {
        if (!isManifestCell(functionality, action)) continue;
        rows.push({ id: `c-${i++}`, roleKey, functionality, action, allowed: true, updatedBy: null });
      }
    }
  }
  return rows;
}

describe("DB matrix ≡ code matrix", () => {
  beforeEach(async () => {
    resetDb();
    seedDb([
      [roleFunctionalitiesTable, seedRows()],
      [accessMatrixVersionTable, [{ id: "singleton", version: 1, updatedBy: null }]],
    ]);
    await loadMatrix();
  });

  it("resolves every role × permission identically", () => {
    // Every declared action of every functionality, not a fixed verb list —
    // the two copies must agree on the whole surface, including the actions
    // only some functionalities have.
    const diffs: string[] = [];
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      for (const f of ALL_FUNCTIONALITIES) {
        for (const d of namedActionsFor(f)) {
          if (can(role as never, f, d.key) !== matrixCan(role, f, d.key)) {
            diffs.push(`${role} ${f}.${d.key}`);
          }
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it("computes the system roles rather than storing them", () => {
    // The real lockout backstop: no edit can take these away, because there is
    // nothing to edit. SUPER_ADMIN holds every manifest cell by construction.
    expect(matrixCan("SUPER_ADMIN", "PROPERTIES", "delete_property")).toBe(true);
    expect(matrixCan("OPS_EXCELLENCE", "AUDIT_ADMIN", "configure_audit_admin")).toBe(true);
    // AUDIT_READONLY is view-everywhere and nothing else.
    expect(matrixCan("AUDIT_READONLY", "PROPERTIES", "view_property")).toBe(true);
    expect(matrixCan("AUDIT_READONLY", "PROPERTIES", "edit_property")).toBe(false);
  });

  it("refuses a stored cell outside the manifest ceiling", async () => {
    // A row that survived a module being removed, or names an action that is
    // not valid for its module, must grant nothing — the ceiling is enforced on
    // READ, not only at write time.
    resetDb();
    seedDb([
      [roleFunctionalitiesTable, [
        { id: "x1", roleKey: "WARDEN", module: "NOT_A_MODULE", functionality: "view", allowed: true },
        { id: "x2", roleKey: "WARDEN", module: "DASHBOARD", functionality: "configure", allowed: true },
      ]],
      [accessMatrixVersionTable, [{ id: "singleton", version: 1 }]],
    ]);
    await loadMatrix();
    expect(matrixCan("WARDEN", "NOT_A_MODULE" as never, "view_dashboard")).toBe(false);
    // A dashboard declares no `configure_*`, so a row naming one is inert —
    // the ceiling is enforced on READ, not only at write time.
    expect(namedActionsFor("DASHBOARD").map((d) => d.key)).not.toContain("configure_dashboard");
    expect(matrixCan("WARDEN", "DASHBOARD", "configure_dashboard")).toBe(false);
  });

  it("falls back to the code matrix when the table is empty, never to deny-all", async () => {
    // A fresh database or a failed seed must not lock everyone out.
    resetDb();
    seedDb([[roleFunctionalitiesTable, []], [accessMatrixVersionTable, []]]);
    await loadMatrix();
    expect(matrixCan("WARDEN", "RESIDENTS", "view_resident"))
      .toBe(can("WARDEN" as never, "RESIDENTS", "view_resident"));
  });
});
