/**
 * What may be overridden on one person, and by whom.
 *
 * A per-user override is the sharpest tool in the access plane: it detaches one
 * individual from the role everyone else is reviewed against. So the guards are
 * the same family the grant and matrix surfaces carry, plus the two that only
 * matter here — you cannot mint yourself a capability, and you cannot hand out
 * one you do not hold.
 */
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { httpError, isSuperAdmin, assertCanAssignRole } from "../authz.js";
import { can, type Action, type Module } from "../permissions.js";
import { PROTECTED_MODULES } from "./matrix-guards.js";
import { isManifestCell, SYSTEM_ROLES } from "./matrix.js";

export interface OverrideInput {
  userId: string;
  module: string;
  action: string;
  /** INHERIT clears the row and returns the person to their role's answer. */
  effect: "GRANT" | "DENY" | "INHERIT";
  reason: string;
  effectiveFrom?: Date | null;
  expiresAt?: Date | null;
}

export interface OverrideSubject {
  id: string;
  role: string;
  email: string;
  name: string;
}

export async function assertOverrideIsSafe(
  actor: { id: string; role: string },
  input: OverrideInput,
): Promise<OverrideSubject> {
  const superuser = isSuperAdmin(actor.role);

  // 1. Never yourself — not even a super admin. Self-service capability editing
  //    makes every other guard here decorative, since the escalation is one
  //    request away and the trail shows you doing it to yourself.
  if (input.userId === actor.id) {
    throw httpError(403, "You cannot change your own permissions", { code: "SELF_OVERRIDE" });
  }

  // 2. A reason is the whole reason this is reviewable later.
  if (!input.reason || input.reason.trim().length < 4) {
    throw httpError(400, "A reason is required to change a person's permissions", {
      code: "REASON_REQUIRED",
    });
  }

  const [subject] = await db
    .select({ id: usersTable.id, role: usersTable.role, email: usersTable.email, name: usersTable.name, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, input.userId));
  if (!subject) throw httpError(404, "User not found");
  if (!subject.isActive) throw httpError(422, "User is inactive", { code: "SUBJECT_INACTIVE" });

  // 3. System roles resolve their cells by COMPUTATION, and decide() answers for
  //    them before it ever reads an override. Writing a row here would produce
  //    a permission the UI shows and the server ignores — the worst possible
  //    outcome for a screen whose job is to explain access. Refuse instead.
  if (subject.role in SYSTEM_ROLES) {
    throw httpError(422, `${subject.role} resolves its permissions by rule; overrides do not apply to it`, {
      code: "SYSTEM_ROLE_SUBJECT",
    });
  }

  // 4. Rank: you may not rewrite someone above your own tier.
  assertCanAssignRole(actor.role, subject.role);

  // Clearing an override only ever returns someone to their role, so the
  // capability-level checks below (which exist to stop escalation) do not apply.
  if (input.effect === "INHERIT") return subject;

  // 5. The ceiling still holds: an override cannot invent a cell the manifest
  //    does not define. Without this, "approve on a module with no approve"
  //    becomes a row that silently never matches.
  if (!isManifestCell(input.module, input.action)) {
    throw httpError(400, `${input.module} does not support the action ${input.action}`, {
      code: "NOT_A_MANIFEST_CELL",
    });
  }

  // 6. The access plane governs itself: only a super admin may hand out
  //    capabilities on the modules that mint access.
  if (!superuser && PROTECTED_MODULES.has(input.module)) {
    throw httpError(403, `${input.module} may only be changed by a super administrator`, {
      code: "PROTECTED_MODULE", module: input.module,
    });
  }

  // 7. You cannot grant what you do not hold. A DENY is exempt: taking a
  //    capability away from someone is not escalation, and a manager who cannot
  //    approve should still be able to stop a report from approving.
  if (input.effect === "GRANT" && !superuser && !can(actor.role as never, input.module as Module, input.action as Action)) {
    throw httpError(403, "You cannot grant a permission you do not hold yourself", {
      code: "GRANTER_LACKS_CAPABILITY", module: input.module, action: input.action,
    });
  }

  // 8. A window that has already closed grants nothing and hides the mistake —
  //    same rule the grant surface applies.
  if (input.effectiveFrom && input.expiresAt && input.effectiveFrom >= input.expiresAt) {
    throw httpError(400, "The override expires before it takes effect", { code: "INVALID_WINDOW" });
  }
  if (input.expiresAt && input.expiresAt < new Date()) {
    throw httpError(400, "That override would already be expired", { code: "WINDOW_IN_PAST" });
  }

  return subject;
}
