/**
 * What may be changed in the permission matrix, and by whom (PRD §22/§25/§30).
 *
 * The matrix becoming editable removes the code review that used to stand
 * between an admin and a privilege change. These guards are what replaces it.
 * They are deliberately in code, not config — a rule that constrains
 * administrators must not itself be administrable.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, accessRolesTable, accessRolePermissionsTable, usersTable } from "@workspace/db";
import { httpError, isSuperAdmin, ROLE_RANK } from "../authz.js";
import { CAPABILITY_CONFLICTS } from "./sod.js";
import { isManifestCell, SYSTEM_ROLES, cellsForRole } from "./matrix.js";
import type { Action, Module } from "../permissions.js";

export interface CellChange {
  roleKey: string;
  module: string;
  action: string;
  allowed: boolean;
}

/**
 * Modules whose capabilities decide who else can do anything.
 *
 * Editable only by a parity role: granting ACCESS_CONTROL:configure to a
 * mid-tier role hands them the matrix itself, and FOOD_ORG:edit is what mints
 * scope rows, so either is a one-step route to everything.
 */
const PROTECTED_MODULES = new Set([
  "ACCESS_CONTROL", "USERS", "SETTINGS", "FOOD_ORG", "AUDIT_ADMIN",
]);

export async function assertMatrixChangeAllowed(
  actor: { id: string; role: string },
  changes: CellChange[],
  reason: string | null,
): Promise<void> {
  if (!changes.length) throw httpError(400, "No changes supplied");
  // Every matrix write lands on the tamper-evident ACCESS stream, and a change
  // with no stated reason is the one nobody can account for later.
  if (!reason || !reason.trim()) {
    throw httpError(400, "A reason is required for a permission change", { code: "REASON_REQUIRED" });
  }

  const superuser = isSuperAdmin(actor.role);
  const actorRank = ROLE_RANK[actor.role] ?? 0;
  const targetRoles = [...new Set(changes.map((c) => c.roleKey))];

  // 1. Ceiling: a cell outside the manifest does not exist and cannot be granted.
  for (const c of changes) {
    if (!isManifestCell(c.module, c.action)) {
      throw httpError(404, `No such capability: ${c.module}:${c.action}`, {
        code: "UNKNOWN_CELL", module: c.module, action: c.action,
      });
    }
  }

  // 2. System roles are COMPUTED. Refusing the write is what makes
  //    "an admin edits SUPER_ADMIN into powerlessness" impossible, rather than
  //    merely discouraged.
  for (const rk of targetRoles) {
    if (rk in SYSTEM_ROLES) {
      throw httpError(409, `${rk} is a system role — its capabilities are computed, not stored`, {
        code: "SYSTEM_ROLE_IMMUTABLE", roleKey: rk,
      });
    }
  }

  // 3. Protected modules: parity roles only.
  if (!superuser) {
    const hit = changes.find((c) => PROTECTED_MODULES.has(c.module));
    if (hit) {
      throw httpError(403, `${hit.module} may only be changed by a super administrator`, {
        code: "PROTECTED_MODULE", module: hit.module,
      });
    }
  }

  // 4. Rank: you may not rewrite a role above your own.
  if (!superuser) {
    const rows = await db
      .select({ key: accessRolesTable.key, rank: accessRolesTable.rank })
      .from(accessRolesTable)
      .where(inArray(accessRolesTable.key, targetRoles));
    for (const r of rows) {
      if (r.rank > actorRank) {
        throw httpError(403, `You cannot change ${r.key} — it ranks above your own role`, {
          code: "ROLE_OUTRANKS_ACTOR", roleKey: r.key,
        });
      }
    }
  }

  // 5. No privilege amplification: you may only GRANT a capability you hold.
  //    Without this the editor is a universal escalation primitive — grant
  //    yourself-adjacent role X the cell you lack, then assume X.
  if (!superuser) {
    const own = new Set((await cellsForRole(actor.role)).map((c) => `${c.module}:${c.action}`));
    const over = changes.find((c) => c.allowed && !own.has(`${c.module}:${c.action}`));
    if (over) {
      throw httpError(403, `You cannot grant ${over.module}:${over.action} — you do not hold it yourself`, {
        code: "PRIVILEGE_AMPLIFICATION", module: over.module, action: over.action,
      });
    }
  }

  // 6. Self-demotion: removing a capability from a role you hold locks you out
  //    mid-edit, and the usual way that is discovered is by losing the screen.
  if (!superuser) {
    const revoking = changes.filter((c) => !c.allowed && c.roleKey === actor.role);
    if (revoking.length) {
      throw httpError(409, "You cannot remove a capability from your own role", {
        code: "SELF_DEMOTION",
        cells: revoking.map((c) => `${c.module}:${c.action}`),
      });
    }
  }

  // 7. Separation of duties, static half: the resulting cell set must not hold
  //    both halves of a conflict pair. Checked against the POST-change state,
  //    not the request, so adding one half to a role that already holds the
  //    other is caught.
  for (const rk of targetRoles) {
    const after = new Set((await cellsForRole(rk)).map((c) => `${c.module}:${c.action}`));
    for (const c of changes.filter((x) => x.roleKey === rk)) {
      const k = `${c.module}:${c.action}`;
      if (c.allowed) after.add(k);
      else after.delete(k);
    }
    const violated = CAPABILITY_CONFLICTS.filter(
      (r) =>
        !r.exempt.includes(rk) &&
        after.has(`${r.a.module}:${r.a.perm}`) &&
        after.has(`${r.b.module}:${r.b.perm}`),
    );
    if (violated.length) {
      const r = violated[0]!;
      throw httpError(409, `Separation of duties: ${rk} may not hold both ${r.a.module}:${r.a.perm} and ${r.b.module}:${r.b.perm}`, {
        code: "SOD_CAPABILITY_CONFLICT",
        ruleId: r.id,
        // The rationale is the point: an admin hitting this needs to know WHY,
        // not just that they were refused.
        rationale: r.rationale,
        roleKey: rk,
      });
    }
  }
}

/**
 * Refuse a change that would leave nobody able to administer access.
 *
 * Runs against the POST-change world, inside the write transaction. The system
 * roles make this near-impossible already (SUPER_ADMIN's cells are computed),
 * but "near-impossible" is not the same as checked.
 */
export async function assertAccessControlReachable(changes: CellChange[]): Promise<void> {
  const losing = changes.filter(
    (c) => !c.allowed && c.module === "ACCESS_CONTROL" && c.action === "configure",
  );
  if (!losing.length) return;

  const stillHolding = await db
    .select({ key: accessRolePermissionsTable.roleKey })
    .from(accessRolePermissionsTable)
    .where(
      and(
        eq(accessRolePermissionsTable.module, "ACCESS_CONTROL"),
        eq(accessRolePermissionsTable.action, "configure" as Action),
        eq(accessRolePermissionsTable.allowed, true),
      ),
    );
  const remaining = stillHolding.map((r) => r.key).filter((k) => !losing.some((c) => c.roleKey === k));

  // System roles always hold it, and cannot be edited away — but assert an
  // actual live human has it, not merely that a role definition does.
  const systemHolders = Object.keys(SYSTEM_ROLES).filter((r) => SYSTEM_ROLES[r] === "ALL");
  const holders = [...new Set([...remaining, ...systemHolders])];
  if (!holders.length) {
    throw httpError(409, "This change would leave no role able to administer access");
  }

  const [someone] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.role, holders as never), eq(usersTable.isActive, true)))
    .limit(1);
  if (!someone) {
    throw httpError(409, "This change would leave no ACTIVE user able to administer access", {
      code: "WOULD_LOCK_OUT", rolesThatWouldRemain: holders,
    });
  }
}

export { PROTECTED_MODULES };
export type { Module };
