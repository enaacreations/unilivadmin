/**
 * What privileges may be written, on whom, at which property, and by whom.
 *
 * A per-user override is the sharpest tool in the access plane: it detaches one
 * individual from the role everyone else is reviewed against. So the guards are
 * the same family the grant and matrix surfaces carry, plus the two that only
 * matter here — you cannot mint yourself a capability, and you cannot hand out
 * one you do not hold.
 */
import { eq } from "drizzle-orm";
import { db, usersTable, rolesTable, orgNodesTable } from "@workspace/db";
import { httpError, isSuperAdmin, assertCanAssignRole } from "../authz.js";
import { canAny, type NamedAction, type Functionality } from "../permissions.js";
import { readRoles } from "./roles.js";
import { resolveAccess } from "../access.js";
import { PROTECTED_FUNCTIONALITIES } from "./matrix-guards.js";
import { isManifestCell, SYSTEM_ROLES } from "./matrix.js";

export interface PrivilegeInput {
  subjectType: "USER" | "ROLE";
  subjectId: string;
  functionality: string;
  action: string;
  /** null = everywhere the subject can already reach. */
  nodeId?: string | null;
  /** INHERIT clears the row, returning the subject to the layer beneath. */
  effect: "GRANT" | "DENY" | "INHERIT";
  reason: string;
  effectiveFrom?: Date | null;
  expiresAt?: Date | null;
}

export interface PrivilegeSubject {
  id: string;
  /** Roles the subject holds (a USER), or the role itself (a ROLE). */
  roles: string[];
  /** For the activity trail. */
  label: string;
}

export async function assertPrivilegeIsSafe(
  actor: { id: string; role: string },
  input: PrivilegeInput,
): Promise<PrivilegeSubject> {
  const superuser = isSuperAdmin(actor.role);

  // 1. Never yourself — not even a super admin. Self-service capability editing
  //    makes every other guard here decorative, since the escalation is one
  //    request away and the trail shows you doing it to yourself. A ROLE the
  //    actor holds is the same escalation wearing a hat, so that is blocked too.
  if (input.subjectType === "USER" && input.subjectId === actor.id) {
    throw httpError(403, "You cannot change your own permissions", { code: "SELF_OVERRIDE" });
  }
  const actorRoles = await readRoles(actor.id);
  if (input.subjectType === "ROLE" && actorRoles.includes(input.subjectId) && !superuser) {
    throw httpError(403, "You cannot change the privileges of a role you hold yourself", {
      code: "SELF_ROLE_PRIVILEGE",
    });
  }

  // 2. A reason is the whole reason this is reviewable later.
  if (!input.reason || input.reason.trim().length < 4) {
    throw httpError(400, "A reason is required to change a person's permissions", {
      code: "REASON_REQUIRED",
    });
  }

  // The subject, and the roles whose capability it resolves against.
  let subject: PrivilegeSubject;
  if (input.subjectType === "USER") {
    const [u] = await db
      .select({ id: usersTable.id, role: usersTable.role, email: usersTable.email, name: usersTable.name, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, input.subjectId));
    if (!u) throw httpError(404, "User not found");
    if (!u.isActive) throw httpError(422, "User is inactive", { code: "SUBJECT_INACTIVE" });

    const roles = await readRoles(u.id);
    const held = roles.length ? roles : [u.role];

    // 3. System roles resolve their cells by COMPUTATION, and decide() answers
    //    for them before it ever reads a privilege. Writing a row here would
    //    produce a permission the UI shows and the server ignores — the worst
    //    possible outcome for a screen whose job is to explain access.
    const systemRole = held.find((r) => r in SYSTEM_ROLES);
    if (systemRole) {
      throw httpError(422, `${systemRole} resolves its permissions by rule; privileges do not apply to it`, {
        code: "SYSTEM_ROLE_SUBJECT",
      });
    }
    // 4. Rank: you may not rewrite someone above your own tier.
    for (const r of held) assertCanAssignRole(actor.role, r);
    subject = { id: u.id, roles: held, label: u.email };
  } else {
    const [r] = await db
      .select({ key: rolesTable.key, label: rolesTable.label, isSystem: rolesTable.isSystem, isActive: rolesTable.isActive })
      .from(rolesTable)
      .where(eq(rolesTable.key, input.subjectId));
    if (!r) throw httpError(404, "Role not found");
    if (!r.isActive) throw httpError(422, "Role is disabled", { code: "SUBJECT_INACTIVE" });
    if (r.isSystem || r.key in SYSTEM_ROLES) {
      throw httpError(422, `${r.key} resolves its permissions by rule; privileges do not apply to it`, {
        code: "SYSTEM_ROLE_SUBJECT",
      });
    }
    // A role privilege reaches every holder at once, so the rank check is
    // against the role itself.
    assertCanAssignRole(actor.role, r.key);
    subject = { id: r.key, roles: [r.key], label: r.label };
  }

  // 4. Rank: you may not rewrite someone above your own tier.
  // Clearing a privilege only ever returns the subject to the layer beneath, so the
  // capability-level checks below (which exist to stop escalation) do not apply.
  if (input.effect === "INHERIT") return subject;

  // 5. The ceiling still holds: an override cannot invent a cell the manifest
  //    does not define. Without this, "approve on a module with no approve"
  //    becomes a row that silently never matches.
  if (!isManifestCell(input.functionality, input.action)) {
    throw httpError(400, `${input.functionality} does not support the action ${input.action}`, {
      code: "NOT_A_MANIFEST_CELL",
    });
  }

  // 6. The access plane governs itself: only a super admin may hand out
  //    capabilities on the functionalities that mint access.
  if (!superuser && PROTECTED_FUNCTIONALITIES.has(input.functionality)) {
    throw httpError(403, `${input.functionality} may only be changed by a super administrator`, {
      code: "PROTECTED_FUNCTIONALITY", functionality: input.functionality,
    });
  }

  // 7. You cannot grant what you do not hold. A DENY is exempt: taking a
  //    capability away from someone is not escalation, and a manager who cannot
  //    approve should still be able to stop a report from approving.
  if (input.effect === "GRANT" && !superuser && !canAny([actor.role, ...actorRoles], input.functionality as Functionality, input.action as NamedAction)) {
    throw httpError(403, "You cannot grant a permission you do not hold yourself", {
      code: "GRANTER_LACKS_CAPABILITY", functionality: input.functionality, action: input.action,
    });
  }

  // 8. The node must exist and be live. A privilege on a deactivated node
  //    resolves to nothing today and springs silently to life if it is ever
  //    reactivated — the same trap the grant surface refuses.
  if (input.nodeId) {
    const [node] = await db
      .select({ id: orgNodesTable.id, isActive: orgNodesTable.isActive })
      .from(orgNodesTable)
      .where(eq(orgNodesTable.id, input.nodeId));
    if (!node) throw httpError(404, "No such org node", { code: "UNKNOWN_NODE" });
    if (!node.isActive) {
      throw httpError(422, "That node is deactivated — a privilege there resolves to nothing", {
        code: "NODE_INACTIVE",
      });
    }
    // 9. You may only write a privilege where you can reach yourself.
    if (!superuser) {
      const own = await resolveAccess({ id: actor.id, role: actor.role } as never);
      if (own.nodeIds !== null && !own.nodeIds.includes(input.nodeId)) {
        throw httpError(403, "You cannot set a privilege at a node outside your own scope", {
          code: "NODE_OUT_OF_SCOPE", nodeId: input.nodeId,
        });
      }
    }
  }

  // 10. A window that has already closed grants nothing and hides the mistake —
  //    same rule the grant surface applies.
  if (input.effectiveFrom && input.expiresAt && input.effectiveFrom >= input.expiresAt) {
    throw httpError(400, "The override expires before it takes effect", { code: "INVALID_WINDOW" });
  }
  if (input.expiresAt && input.expiresAt < new Date()) {
    throw httpError(400, "That override would already be expired", { code: "WINDOW_IN_PAST" });
  }

  return subject;
}
