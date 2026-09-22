/**
 * The role × module × action matrix, as data (PRD §22/§25/§30).
 *
 * HYBRID, deliberately. The *vocabulary and ceiling* stay in code — which
 * modules and actions exist, and which cells may ever be granted. Only WHICH
 * cells a role holds becomes editable. Fully DB-driven would turn privilege
 * escalation into a single authenticated POST; today it takes a code review by
 * someone who reads ROLE_PERMISSIONS' hundred lines of load-bearing comments,
 * and no admin form conveys those.
 *
 * SYNCHRONOUS BY CONSTRUCTION. `can()` is called from ~200 sites, most of them
 * inside express middleware that cannot await. So the database is read into a
 * process snapshot and refreshed out of band; `can()` never does I/O.
 *
 * FAIL-CLOSED, NEVER FAIL-OPEN. An unloaded or empty table falls back to the
 * code matrix — a fresh database or a failed seed must not lock everyone out —
 * but a load failure AFTER a successful load keeps the last good snapshot
 * rather than silently widening or narrowing access.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, accessRolePermissionsTable, accessRolesTable, accessMatrixVersionTable } from "@workspace/db";
import { logger } from "../logger.js";
import { newId } from "../id.js";
import {
  ROLE_PERMISSIONS, ALL_MODULES, actionsFor, IMPLIES,
  type Action, type Module, type UserRole,
} from "../permissions.js";

/** Roles whose cells are COMPUTED, never stored — the real lockout backstop. */
export const SYSTEM_ROLES: Record<string, "ALL" | "VIEW"> = {
  SUPER_ADMIN: "ALL",
  OPS_EXCELLENCE: "ALL",
  AUDIT_READONLY: "VIEW",
};

/**
 * MODULE roles — the personas that live inside one module, not across the app.
 *
 * These are what a grant's `roleKey` names when it is not the `*` sentinel:
 * "AUDIT.AUDITOR" confers access inside the audit module only, and deliberately
 * does not widen the general scope. The audit module has carried them as an
 * enum (`audit_module_role`) since it shipped; this is the same vocabulary as
 * rows, so the grant UI can offer and label them instead of asking an admin to
 * type a dotted string from memory.
 *
 * They hold NO matrix cells, by design: capability comes from the person's
 * platform role, and a module role answers "which persona inside this module",
 * which the module's own adapter reads. The matrix editor therefore skips them —
 * a row of empty cells that can never be filled is worse than no row.
 *
 * In code for the same reason the matrix ceiling is: adding a module persona is
 * a decision that deserves a code review, not an admin form.
 */
export const MODULE_ROLES: Array<{ key: string; label: string; module: string; rank: number; description: string }> = [
  { key: "AUDIT.ADMIN", label: "Audit Admin", module: "AUDIT_ADMIN", rank: 80, description: "Configures audit types, templates and grants" },
  { key: "AUDIT.SCHEDULER", label: "Audit Scheduler", module: "AUDIT_ADMIN", rank: 50, description: "Plans and schedules audit runs" },
  { key: "AUDIT.AUDITOR", label: "Auditor", module: "AUDITS", rank: 20, description: "Conducts audits at the granted nodes" },
  { key: "AUDIT.REVIEWER", label: "Audit Reviewer", module: "AUDITS", rank: 50, description: "Reviews and signs off completed audits" },
  { key: "AUDIT.AUDITEE", label: "Auditee", module: "AUDITS", rank: 20, description: "The audited party — sees their own results" },
  { key: "AUDIT.VIEWER", label: "Audit Viewer", module: "AUDITS", rank: 20, description: "Read-only access to audit results" },
];

/** A module role is scoped to one module; a platform role is not. */
export const isModuleRole = (key: string) => key.includes(".");

type Cells = Map<string, Set<string>>; // roleKey -> "MODULE:action"
interface Snapshot { cells: Cells; version: number; source: "db" | "code" }

let snapshot: Snapshot | null = null;

const cellKey = (m: string, a: string) => `${m}:${a}`;

/** The ceiling: a cell outside the manifest can never be granted. */
export function isManifestCell(module: string, action: string): boolean {
  return (
    (ALL_MODULES as readonly string[]).includes(module) &&
    (actionsFor(module as Module) as readonly string[]).includes(action)
  );
}

/** Build the fallback snapshot from the code matrix. */
function codeSnapshot(): Snapshot {
  const cells: Cells = new Map();
  for (const [role, matrix] of Object.entries(ROLE_PERMISSIONS)) {
    const set = new Set<string>();
    for (const [module, perms] of Object.entries(matrix ?? {})) {
      for (const [action, allowed] of Object.entries(perms ?? {})) {
        if (allowed === true) set.add(cellKey(module, action));
      }
    }
    cells.set(role, set);
  }
  return { cells, version: 0, source: "code" };
}

/**
 * Refresh the snapshot from the database.
 *
 * Called at boot and after every matrix write. Never throws: a failure keeps
 * whatever is already loaded.
 */
export async function loadMatrix(): Promise<Snapshot> {
  try {
    const rows = await db
      .select({
        roleKey: accessRolePermissionsTable.roleKey,
        module: accessRolePermissionsTable.module,
        action: accessRolePermissionsTable.action,
      })
      .from(accessRolePermissionsTable)
      .where(eq(accessRolePermissionsTable.allowed, true));

    if (rows.length === 0) {
      // Empty table = not seeded yet. Fall back rather than deny everything.
      if (!snapshot) {
        logger.warn("access matrix table is empty — falling back to the code matrix");
        snapshot = codeSnapshot();
      }
      return snapshot;
    }

    const cells: Cells = new Map();
    for (const r of rows) {
      // Enforce the ceiling on READ too. A stale row for a module that has since
      // been removed, or an action no longer valid for it, must not grant
      // anything just because it survived in the table.
      if (!isManifestCell(r.module, r.action)) continue;
      const set = cells.get(r.roleKey) ?? new Set<string>();
      set.add(cellKey(r.module, r.action));
      cells.set(r.roleKey, set);
    }
    const [v] = await db.select({ version: accessMatrixVersionTable.version }).from(accessMatrixVersionTable).limit(1);
    snapshot = { cells, version: v?.version ?? 0, source: "db" };
    return snapshot;
  } catch (err) {
    logger.error({ err }, "access matrix load failed — keeping the last good snapshot");
    snapshot ??= codeSnapshot();
    return snapshot;
  }
}

/** Current snapshot, loading the code fallback if nothing is loaded yet. */
function current(): Snapshot {
  return (snapshot ??= codeSnapshot());
}

export function matrixVersion(): number {
  return current().version;
}
export function matrixSource(): "db" | "code" {
  return current().source;
}

/**
 * Does `roleKey` hold `module:action`?
 *
 * Resolution order: system roles are computed; then the exact cell; then any
 * action that IMPLIES the requested one. Implication only ever widens, along
 * documented edges (approve ⇒ view, export ⇒ download) — nothing else.
 */
export function matrixCan(roleKey: string | undefined, module: Module, action: Action): boolean {
  if (!roleKey) return false;

  const system = SYSTEM_ROLES[roleKey];
  if (system === "ALL") return isManifestCell(module, action);
  if (system === "VIEW") return action === "view" && isManifestCell(module, action);

  const set = current().cells.get(roleKey);
  if (!set) return false;
  if (set.has(cellKey(module, action))) return true;

  for (const [holder, implied] of Object.entries(IMPLIES)) {
    if (implied?.includes(action) && set.has(cellKey(module, holder))) return true;
  }
  return false;
}

/**
 * Seed `access_roles` + `access_role_permissions` from the code matrix.
 *
 * Idempotent. System roles get a row in `access_roles` (so the editor can list
 * them) but NO permission rows — their cells are computed, which is what makes
 * "an admin edits SUPER_ADMIN into powerlessness" impossible by construction.
 */
export async function seedMatrix(actorId: string | null = null): Promise<{
  roles: number; cells: number; skippedSystem: number;
}> {
  const report = { roles: 0, cells: 0, skippedSystem: 0 };
  const { ROLE_RANK } = await import("../authz.js");

  for (const roleKey of Object.keys(ROLE_PERMISSIONS)) {
    await db
      .insert(accessRolesTable)
      .values({
        key: roleKey,
        label: roleKey.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
        rank: ROLE_RANK[roleKey] ?? 0,
        isSystem: roleKey in SYSTEM_ROLES,
      })
      .onConflictDoNothing();
    report.roles++;

    if (roleKey in SYSTEM_ROLES) { report.skippedSystem++; continue; }

    const matrix = ROLE_PERMISSIONS[roleKey as UserRole] ?? {};
    for (const [module, perms] of Object.entries(matrix)) {
      for (const [action, allowed] of Object.entries(perms ?? {})) {
        if (allowed !== true) continue;
        if (!isManifestCell(module, action)) continue;
        await db
          .insert(accessRolePermissionsTable)
          .values({
            id: newId(), roleKey, module, action: action as Action,
            allowed: true, updatedBy: actorId,
          })
          .onConflictDoNothing();
        report.cells++;
      }
    }
  }

  // Module personas: rows so the grant UI can offer them, but no permission
  // cells — see MODULE_ROLES. Without these rows, 24 live grants referenced
  // roles that no screen could name.
  for (const r of MODULE_ROLES) {
    await db
      .insert(accessRolesTable)
      .values({
        key: r.key, label: r.label, description: r.description,
        scopeModule: r.module, rank: r.rank, isSystem: false,
      })
      .onConflictDoNothing();
    report.roles++;
  }

  await db
    .insert(accessMatrixVersionTable)
    .values({ id: "singleton", version: 1, updatedBy: actorId })
    .onConflictDoNothing();

  await loadMatrix();
  return report;
}

/** Bump the version and refresh, in one place so no writer forgets either. */
export async function bumpMatrixVersion(actorId: string | null): Promise<number> {
  await db
    .insert(accessMatrixVersionTable)
    .values({ id: "singleton", version: 1, updatedBy: actorId })
    .onConflictDoUpdate({
      target: accessMatrixVersionTable.id,
      set: { version: sql`${accessMatrixVersionTable.version} + 1`, updatedBy: actorId, updatedAt: new Date() },
    });
  const s = await loadMatrix();
  return s.version;
}

/** Cells currently held by a role, for the editor and the guard checks. */
export async function cellsForRole(roleKey: string): Promise<Array<{ module: string; action: string }>> {
  if (roleKey in SYSTEM_ROLES) {
    const all: Array<{ module: string; action: string }> = [];
    for (const m of ALL_MODULES) {
      for (const a of actionsFor(m)) {
        if (SYSTEM_ROLES[roleKey] === "VIEW" && a !== "view") continue;
        all.push({ module: m, action: a });
      }
    }
    return all;
  }
  return db
    .select({ module: accessRolePermissionsTable.module, action: accessRolePermissionsTable.action })
    .from(accessRolePermissionsTable)
    .where(and(eq(accessRolePermissionsTable.roleKey, roleKey), eq(accessRolePermissionsTable.allowed, true)));
}
