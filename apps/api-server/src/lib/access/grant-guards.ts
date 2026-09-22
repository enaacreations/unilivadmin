/**
 * What may be granted, and by whom (PRD §24/§27/§30).
 *
 * The union of the guards `POST /food/scopes` has carried since it shipped and
 * the ones `POST /audit/admin/grants` was missing entirely — plus the two
 * neither had. A grant surface without these is the cheapest privilege
 * escalation path in a product, because it mints access rather than using it.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, accessGrantsTable, orgNodesTable, usersTable } from "@workspace/db";
import { httpError, isSuperAdmin, assertCanAssignRole } from "../authz.js";
import { resolveAccess } from "../access.js";

export interface GrantInput {
  subjectId: string;
  roleKey: string;
  nodeId: string | null;
  includeDescendants: boolean;
  followLinks: boolean;
  dataScope: string;
  assignmentKind: string;
  effectiveFrom?: Date | null;
  expiresAt?: Date | null;
}

export async function assertGrantIsSafe(
  granter: { id: string; role: string },
  input: GrantInput,
): Promise<void> {
  const superuser = isSuperAdmin(granter.role);

  // 1. No self-grant. Otherwise any holder widens their own reach in one
  //    request, and the trail shows them doing it to themselves.
  if (input.subjectId === granter.id && !superuser) {
    throw httpError(403, "You cannot grant access to yourself", { code: "SELF_GRANT" });
  }

  // 2. The subject must exist and be active — a grant that activates silently
  //    when a dormant account is re-enabled is not a grant anyone reviewed.
  const [subject] = await db
    .select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, input.subjectId));
  if (!subject) throw httpError(404, "User not found");
  if (!subject.isActive) throw httpError(422, "User is inactive", { code: "SUBJECT_INACTIVE" });

  // 3. Org-wide is everything: parity roles only.
  if (input.nodeId === null && !superuser) {
    throw httpError(403, "Only a super administrator may grant organization-wide access", {
      code: "ORG_WIDE_RESTRICTED",
    });
  }

  // 4. The node must exist AND be live. Granting on a deactivated node creates
  //    a grant that resolves to nothing today and silently springs to life if
  //    the node is ever reactivated.
  if (input.nodeId) {
    const [node] = await db
      .select({ id: orgNodesTable.id, nodeType: orgNodesTable.nodeType, isActive: orgNodesTable.isActive })
      .from(orgNodesTable)
      .where(eq(orgNodesTable.id, input.nodeId));
    if (!node) throw httpError(404, "No such org node", { code: "UNKNOWN_NODE" });
    if (!node.isActive) {
      throw httpError(422, "That node is deactivated — scope expansion stops there", { code: "NODE_INACTIVE" });
    }
    // 5. A subtree grant on a leaf is meaningless and usually a mis-click; on a
    //    ROOM or BED it is how "specific room" silently becomes "everything
    //    beneath", which §24 distinguishes deliberately.
    if (input.includeDescendants && (node.nodeType === "ROOM" || node.nodeType === "BED")) {
      throw httpError(400, `A ${node.nodeType.toLowerCase()} grant cannot include descendants`, {
        code: "LEAF_SUBTREE", nodeType: node.nodeType,
      });
    }
  }

  // 6. No privilege escalation by proxy.
  assertCanAssignRole(granter.role, subject.role);

  // 7. You may only place someone where you can reach yourself.
  if (!superuser && input.nodeId) {
    const own = await resolveAccess({ id: granter.id, role: granter.role } as never);
    if (own.nodeIds !== null && !own.nodeIds.includes(input.nodeId)) {
      throw httpError(403, "You cannot grant access at a node outside your own scope", {
        code: "NODE_OUT_OF_SCOPE", nodeId: input.nodeId,
      });
    }
  }

  // 8. A live duplicate is a 409, not a second row — the paired partial unique
  //    would reject it anyway, but a bare constraint error reads as a bug.
  const dupe = await db
    .select({ id: accessGrantsTable.id })
    .from(accessGrantsTable)
    .where(
      and(
        eq(accessGrantsTable.subjectId, input.subjectId),
        eq(accessGrantsTable.roleKey, input.roleKey),
        input.nodeId ? eq(accessGrantsTable.nodeId, input.nodeId) : isNull(accessGrantsTable.nodeId),
        isNull(accessGrantsTable.revokedAt),
      ),
    );
  if (dupe.length) {
    throw httpError(409, "That grant already exists and is live", { code: "DUPLICATE_GRANT", id: dupe[0]!.id });
  }

  // 9. A window that has already closed grants nothing and hides the mistake.
  if (input.effectiveFrom && input.expiresAt && input.effectiveFrom >= input.expiresAt) {
    throw httpError(400, "The grant expires before it takes effect", { code: "INVALID_WINDOW" });
  }
  if (input.expiresAt && input.expiresAt < new Date()) {
    throw httpError(400, "That grant would already be expired", { code: "WINDOW_IN_PAST" });
  }
}
