/**
 * The role × functionality × action matrix, as data (PRD §22/§25/§30).
 *
 * A CELL is (role, functionality, action) — never (role, module, action). The
 * module is derived from the functionality by the code manifest, so it is not
 * stored here and cannot drift from it. See the vocabulary note at the top of
 * ../permissions.ts.
 *
 * HYBRID, deliberately. The *vocabulary and ceiling* stay in code — which
 * functionalities and actions exist, and which cells may ever be granted. Only WHICH
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
import { db, roleFunctionalitiesTable, rolesTable, accessMatrixVersionTable } from "@workspace/db";
import { logger } from "../logger.js";
import { newId } from "../id.js";
import {
  ROLE_PERMISSIONS, ALL_FUNCTIONALITIES, actionDef, readActionOf, expandCell,
  namedActionsFor,
  type Cell, type NamedAction, type Functionality, type Module, type UserRole,
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
 * "AUDIT.AUDITOR" confers access inside the AUDITS module only, and deliberately
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
/*
 * `module` is a MODULE key, and now actually is one. Two of these rows used to
 * say "AUDIT_ADMIN" — a functionality — while the other four said "AUDITS",
 * which under the flat vocabulary were the same kind of string and so nobody
 * noticed. A module persona is scoped to the module; which functionalities it
 * confers inside it is the adapter's business.
 */
export const MODULE_ROLES: Array<{ key: string; label: string; module: Module; rank: number; description: string }> = [
  /*
   * EMPTY as of 2026-09-29, deliberately.
   *
   * Six AUDIT.* personas lived here — Auditor, Auditee, Reviewer, Scheduler,
   * Admin, Viewer — on the premise that the Audits module carried its own role
   * system. It does not. Audit is a MODULE with functionalities and actions
   * like any other, and the business roles are granted those; who may conduct
   * or review a particular audit is a per-audit-type grant (see
   * audit-adapter.ts), not a separate identity.
   *
   * The array stays because the CONCEPT is still sound — a persona scoped to
   * one module, in code because adding one deserves a review rather than an
   * admin form — and because `generalGrantPredicate` reads it to tell a module
   * persona's grant from a general one. With none defined, every role is
   * general, which is the correct answer now.
   */
];

/**
 * Roles that exist but are DISABLED on purpose.
 *
 * RESIDENT is the external-user role the Uniliv team asked for. Residents are
 * records today, not principals — no credentials, no session, no link to users
 * — so the role is seeded inactive: readRoles joins on isActive, which means it
 * grants nothing and cannot be assigned by accident before the authentication
 * work that would make it mean something.
 */
export const SEEDED_DISABLED_ROLES: Array<{ key: string; label: string; description: string; rank: number }> = [
  {
    key: "RESIDENT",
    label: "Resident",
    description: "External user — a person living in the estate. Disabled until resident authentication exists.",
    rank: 0,
  },
  {
    // The placeholder for an account created before its roles were decided.
    //
    // `users.role` is NOT NULL and is still the legacy primary, so an account
    // with no memberships needs SOMETHING in that column — and every existing
    // candidate was wrong: the roles with no stored cells are SUPER_ADMIN,
    // OPS_EXCELLENCE and the audit personas, whose cells are COMPUTED rather
    // than absent. Defaulting to one of those would have handed a brand-new
    // empty account the whole estate.
    //
    // Disabled on purpose: readRoles() filters on isActive, so this resolves to
    // an empty role set and grants nothing, and it never appears in a picker.
    key: "UNASSIGNED",
    label: "Unassigned",
    description: "Holds nothing. Given to an account created before its roles were chosen, and replaced by the first real role assigned.",
    rank: 0,
  },
];

/** A module role is scoped to one module; a platform role is not. */
export const isModuleRole = (key: string) => key.includes(".");

type Cells = Map<string, Set<string>>; // roleKey -> "FUNCTIONALITY:action"
interface Snapshot { cells: Cells; version: number; source: "db" | "code" }

let snapshot: Snapshot | null = null;

/**
 * A cell is keyed by the NAMED action, whichever spelling it arrived in.
 *
 * Both vocabularies reach this file: stored rows say `add_property`, the code
 * matrix in ROLE_PERMISSIONS says `create`, and a caller may pass either. If the
 * key were taken verbatim, the two would land in different buckets and a role
 * would hold a cell nobody can look up — which is exactly what happened when the
 * stored rows were renamed and the resolver kept asking for verbs: every
 * non-system role resolved to zero permissions.
 */
const cellKey = (f: string, a: string) =>
  `${f}:${actionDef(f as Functionality, a)?.key ?? a}`;

/**
 * The ceiling: a cell outside the manifest can never be granted.
 *
 * Asks the named manifest, which also resolves a legacy verb — so a row written
 * before the rename is still a valid cell, while one the manifest has dropped
 * (`FOOD_DISPATCH.delete`) is not, and is filtered out of the snapshot rather
 * than silently granting.
 */
export function isManifestCell(functionality: string, action: string): boolean {
  return (
    (ALL_FUNCTIONALITIES as readonly string[]).includes(functionality) &&
    actionDef(functionality as Functionality, action) != null
  );
}

/** Build the fallback snapshot from the code matrix. */
function codeSnapshot(): Snapshot {
  const cells: Cells = new Map();
  for (const [role, matrix] of Object.entries(ROLE_PERMISSIONS)) {
    const set = new Set<string>();
    for (const [functionality, cell] of Object.entries(matrix ?? {})) {
      // A cell is a LEVEL (FULL/VIEW) or an explicit list; expandCell resolves
      // either through the manifest, so the snapshot holds named actions and
      // nothing here has to know what a level means.
      for (const action of expandCell(functionality as Functionality, cell as Cell)) {
        set.add(cellKey(functionality, action));
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
        roleKey: roleFunctionalitiesTable.roleKey,
        functionality: roleFunctionalitiesTable.functionality,
        action: roleFunctionalitiesTable.action,
      })
      .from(roleFunctionalitiesTable)
      .where(eq(roleFunctionalitiesTable.allowed, true));

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
      // Enforce the ceiling on READ too. A stale row for a functionality that
      // has since been removed, or an action no longer valid for it, must not
      // grant anything just because it survived in the table.
      if (!isManifestCell(r.functionality, r.action)) continue;
      const set = cells.get(r.roleKey) ?? new Set<string>();
      set.add(cellKey(r.functionality, r.action));
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
 * Does `roleKey` hold `functionality:action`?
 *
 * Resolution order: system roles are computed; then the exact cell; then any
 * action that implies the requested one. Implication only ever widens, along
 * documented edges (approve ⇒ view, export ⇒ download) — nothing else.
 */
export function matrixCan(roleKey: string | undefined, functionality: Functionality, action: NamedAction): boolean {
  if (!roleKey) return false;

  const system = SYSTEM_ROLES[roleKey];
  if (system === "ALL") return isManifestCell(functionality, action);
  // A read-only system role holds the functionality's READ action, whatever it
  // is named — `view_property`, `view_dispatch_queue` — so it is identified by
  // POSITION (the first action a functionality declares), never by spelling.
  if (system === "VIEW") {
    return action === readActionOf(functionality) && isManifestCell(functionality, action);
  }

  const set = current().cells.get(roleKey);
  if (!set) return false;
  if (set.has(cellKey(functionality, action))) return true;

  // One implication: holding ANY action on a functionality implies its READ.
  // You cannot approve or submit a thing you may not look at. Stated the same
  // way in decide(); it only ever widens toward the read, never to a write.
  if (action === readActionOf(functionality)) {
    return namedActionsFor(functionality).some((d) => set.has(cellKey(functionality, d.key)));
  }
  return false;
}

/**
 * Does ANY of these roles hold `functionality:action`?
 *
 * The union fold that makes multi-role work. Union rather than intersection
 * because roles are additive by nature: someone given both WARDEN and
 * CITY_HEAD was given both on purpose, and an intersection would leave them
 * able to do only what both happen to share — which is nobody's intent and
 * would silently strip access on the day a second role is assigned.
 *
 * See roles.ts for the one behaviour this changes: AUDIT_READONLY can no longer
 * cap a user who also holds an operational role.
 */
export function matrixCanAny(roleKeys: string[], functionality: Functionality, action: NamedAction): boolean {
  return roleKeys.some((r) => matrixCan(r, functionality, action));
}

/**
 * Seed `roles` + `role_functionalities` from the code matrix.
 *
 * Idempotent. System roles get a row in `access_roles` (so the editor can list
 * them) but NO permission rows — their cells are computed, which is what makes
 * "an admin edits SUPER_ADMIN into powerlessness" impossible by construction.
 */
export async function seedMatrix(actorId: string | null = null): Promise<{
  roles: number; cells: number; skippedSystem: number; unknown: string[];
}> {
  const report = { roles: 0, cells: 0, skippedSystem: 0, unknown: [] as string[] };
  const { ROLE_RANK } = await import("../authz.js");
  const { ROLE_ANCHOR, roleLabel } = await import("../permissions.js");

  for (const roleKey of Object.keys(ROLE_PERMISSIONS)) {
    const definition = {
      label: roleLabel(roleKey),
      rank: ROLE_RANK[roleKey] ?? 0,
      isSystem: roleKey in SYSTEM_ROLES,
      anchorLevel: ROLE_ANCHOR[roleKey as UserRole] ?? null,
    };
    // UPSERT, not insert-or-ignore. The code manifest is the definition of a
    // role, so a rename or a corrected anchor level has to reach a database that
    // already has the row — which insert-or-ignore silently would not.
    await db
      .insert(rolesTable)
      .values({ key: roleKey, ...definition })
      .onConflictDoUpdate({ target: rolesTable.key, set: definition });
    report.roles++;

    if (roleKey in SYSTEM_ROLES) { report.skippedSystem++; continue; }

    // Replaced wholesale per role: the matrix IS the role, so a cell removed
    // from the code must disappear here too. Insert-or-ignore would have let a
    // revoked permission live on in the database forever.
    await db.delete(roleFunctionalitiesTable).where(eq(roleFunctionalitiesTable.roleKey, roleKey));
    const matrix = ROLE_PERMISSIONS[roleKey as UserRole] ?? {};
    for (const [functionality, cell] of Object.entries(matrix)) {
      for (const action of expandCell(functionality as Functionality, cell as Cell)) {
        await db
          .insert(roleFunctionalitiesTable)
          .values({ id: newId(), roleKey, functionality, action, allowed: true, updatedBy: actorId })
          .onConflictDoNothing();
        report.cells++;
      }
    }
  }

  /*
   * Roles in the database that the manifest no longer defines are REPORTED,
   * never deleted.
   *
   * Deleting one would revoke it from whoever holds it, silently, during what
   * is meant to be a provisioning step. Retiring a role is a migration with a
   * decision behind it (see lib/db/migrations/2026-09-29_role_taxonomy.sql);
   * this only ever adds and corrects.
   */
  const known = new Set(Object.keys(ROLE_PERMISSIONS));
  for (const row of await db.select({ key: rolesTable.key }).from(rolesTable)) {
    if (!known.has(row.key) && row.key !== "UNASSIGNED") report.unknown.push(row.key);
  }

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
export async function cellsForRole(roleKey: string): Promise<Array<{ functionality: string; action: string }>> {
  if (roleKey in SYSTEM_ROLES) {
    const all: Array<{ functionality: string; action: string }> = [];
    for (const f of ALL_FUNCTIONALITIES) {
      for (const d of namedActionsFor(f)) {
        // A read-only system role holds each functionality's READ action —
        // the one it declares first. See readActionOf().
        if (SYSTEM_ROLES[roleKey] === "VIEW" && d.key !== readActionOf(f)) continue;
        all.push({ functionality: f, action: d.key });
      }
    }
    return all;
  }
  return db
    .select({ functionality: roleFunctionalitiesTable.functionality, action: roleFunctionalitiesTable.action })
    .from(roleFunctionalitiesTable)
    .where(and(eq(roleFunctionalitiesTable.roleKey, roleKey), eq(roleFunctionalitiesTable.allowed, true)));
}
