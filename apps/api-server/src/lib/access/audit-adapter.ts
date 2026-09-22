/**
 * EffectiveAccess -> AuditAccess.
 *
 * The audit module consumes a different shape (module roles, audit types,
 * per-grant property sets) at ~15 call sites. Rather than rewrite those, this
 * adapter reproduces the shape exactly, so the cutover for audit is a one-line
 * change to resolveAuditAccess's body and nothing downstream moves.
 *
 * The drop rules below are audit-access.ts's, copied on purpose: a grant with no
 * recognised audit type, or one that covers no property, is dropped ENTIRELY
 * rather than contributing an empty set. Getting that backwards would turn a
 * malformed grant into either a silent denial of everything or a silent grant of
 * everything, depending on which way the empty set was read.
 */
import type {
  AuditAccess,
  AuditModuleRole,
  AuditType,
  GrantScope,
} from "../audit-access.js";
import type { EffectiveAccess } from "../access.js";

const MODULE_ROLES: AuditModuleRole[] = [
  "ADMIN", "SCHEDULER", "AUDITOR", "AUDITEE", "REVIEWER", "VIEWER",
];
const ROLE_SET = new Set<string>(MODULE_ROLES);
// Declared locally rather than imported: audit-access.ts imports THIS module
// once the cutover lands, and a runtime value import would close that cycle.
// audit-equivalence.test.ts fails if the two lists ever drift.
const TYPE_SET = new Set<string>(["UL", "CM", "CX"]);

/** Audit grants carry roleKey "AUDIT.<moduleRole>"; everything else is not ours. */
const AUDIT_PREFIX = "AUDIT.";

export function toAuditAccess(access: EffectiveAccess): AuditAccess {
  if (access.isGlobalAdmin) {
    return { isGlobalAdmin: true, userId: access.userId, byRole: new Map() };
  }

  const byRole = new Map<AuditModuleRole, GrantScope[]>();

  for (const g of access.grants) {
    if (!g.roleKey.startsWith(AUDIT_PREFIX)) continue;
    const moduleRole = g.roleKey.slice(AUDIT_PREFIX.length);
    if (!ROLE_SET.has(moduleRole)) continue;

    // Fail closed on a malformed qualifier list, exactly as resolveAuditAccess
    // does — an audit grant naming no valid type grants nothing.
    const auditTypes = (g.qualifiers ?? []).filter((t): t is AuditType => TYPE_SET.has(t));
    if (!auditTypes.length) continue;

    // null = GLOBAL. A non-null but EMPTY property set means the grant resolved
    // to no property at all (a node with nothing under it), which audit drops.
    const propertyIds = g.propertyIds;
    if (propertyIds !== null && propertyIds.length === 0) continue;

    const list = byRole.get(moduleRole as AuditModuleRole) ?? [];
    list.push({ auditTypes, propertyIds });
    byRole.set(moduleRole as AuditModuleRole, list);
  }

  return { isGlobalAdmin: false, userId: access.userId, byRole };
}
