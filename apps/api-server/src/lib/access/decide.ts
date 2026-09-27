/**
 * The single decision function (Access Controls PRD §32, and G4 of the plan).
 *
 * Every allow/deny in the system resolves here. `authorize()` is a thin wrapper
 * over it, and so is the "View Access As User" preview — which is the whole
 * point: a preview that RE-IMPLEMENTS resolution drifts from enforcement, and
 * the only durable fix is that there is nothing separate to drift from.
 *
 * Every denial carries a machine ReasonCode. The same code goes out in a real
 * 403's `details.reason` and appears in the preview, so support can match a
 * user's screenshot of a refusal to the preview row that explains it — PRD §31's
 * stated purpose ("resolve access issues without engineering intervention").
 */
import {
  canAny,
  actionDef,
  ALL_FUNCTIONALITIES,
  functionalitiesOf,
  functionalityPath,
  type Functionality,
  type Module,

  type NamedAction,
  readActionOf,
  namedActionsFor,} from "../permissions.js";
import type { EffectiveAccess, DataScope } from "../access.js";
import { privilegeOn } from "./privileges.js";
import { FUNCTIONALITY_MODULE } from "../permissions.js";

export type ReasonCode =
  | "ALLOW_SYSTEM_ROLE"
  | "ALLOW_ROLE_CAPABILITY"
  | "ALLOW_IMPLIED_CAPABILITY"
  /** Held because of a per-person exception, not because of the role. */
  | "ALLOW_USER_OVERRIDE"
  /** Held because of a privilege on one of the roles, often at one property. */
  | "ALLOW_ROLE_PRIVILEGE"
  | "DENY_UNKNOWN_FUNCTIONALITY"
  | "DENY_ACTION_NOT_ON_FUNCTIONALITY"
  | "DENY_ROLE_LACKS_CAPABILITY"
  /** Removed from ONE person whose role does carry it. */
  | "DENY_USER_OVERRIDE"
  /** Removed from a role, often at one property. */
  | "DENY_ROLE_PRIVILEGE"
  | "DENY_NO_GRANT"
  | "DENY_NODE_OUT_OF_SCOPE"
  | "DENY_DATA_SCOPE";

export interface Decision {
  allow: boolean;
  reason: ReasonCode;
  /** Human sentence, assembled server-side so the 403 body and the preview agree verbatim. */
  detail: string;
  functionality: Functionality;
  /** The module the functionality belongs to — derived, carried for display. */
  module: Module;
  action: NamedAction;
  nodeId?: string | null;
  /** The action actually held, when the grant came via implication. */
  via?: string;
}

export interface DecisionQuery {
  functionality: Functionality;
  action: NamedAction;
  nodeId?: string | null;
  dataScope?: DataScope;
}

const FUNCTIONALITIES = new Set<string>(ALL_FUNCTIONALITIES);

/**
 * Does the role hold `action`, or something that implies it?
 *
 * One implication, stated once: holding ANY action on a functionality implies
 * its READ. You cannot approve, submit or reassign a thing you are not allowed
 * to look at, so a role granted only `close_audit` can still open the audit.
 *
 * This replaced a twelve-edge verb table (create⇒view, approve⇒view, …) which
 * said the same thing twelve times and stopped being expressible once actions
 * were named per functionality. Implication only ever WIDENS, and only toward
 * the read — nothing here can confer a write.
 */
function capability(roleKeys: string[], functionality: Functionality, action: NamedAction): { held: boolean; via?: string } {
  if (canAny(roleKeys, functionality, action)) return { held: true };

  if (action === readActionOf(functionality)) {
    const other = namedActionsFor(functionality).find(
      (d) => d.key !== action && canAny(roleKeys, functionality, d.key),
    );
    if (other) return { held: true, via: other.key };
  }
  return { held: false };
}

export function decide(access: EffectiveAccess, q: DecisionQuery): Decision {
  const { functionality, action } = q;
  // The module is never queried and never stored — it is looked up here purely
  // so the caller (a 403 body, the preview, a trail row) can say where the
  // refusal lives without re-deriving it.
  const base = {
    functionality,
    module: moduleOfSafe(functionality),
    action,
    nodeId: q.nodeId ?? null,
  };

  // Super-admin / OPS_EXCELLENCE short-circuit, matching resolveAuditAccess.
  if (access.isGlobalAdmin) {
    return { ...base, allow: true, reason: "ALLOW_SYSTEM_ROLE", detail: `Role ${access.roleKey} has unrestricted access` };
  }

  if (!FUNCTIONALITIES.has(functionality)) {
    return {
      ...base,
      allow: false,
      reason: "DENY_UNKNOWN_FUNCTIONALITY",
      detail: `No functionality named ${functionality}`,
    };
  }

  // The manifest ceiling on the ACTION, and the thing that makes a stored grant
  // the manifest no longer names inert rather than dangerous. Nothing deletes
  // such a row for you: `FOOD_DISPATCH.delete` can sit in the database, and this
  // is where it stops meaning anything. Resolves a legacy verb too, so a row
  // written before the named vocabulary landed is still honoured.
  if (!actionDef(functionality, action)) {
    return {
      ...base,
      allow: false,
      reason: "DENY_ACTION_NOT_ON_FUNCTIONALITY",
      detail: `${functionalityPath(functionality)} defines no action named ${action}`,
    };
  }

  // ── Privileges: the exception layer, applied AFTER the manifest ceiling and
  //    BEFORE scope.
  //
  // privilegeOn() picks the most specific rule that applies at this node —
  // user beats role, node beats global, deeper node beats shallower, and at
  // equal specificity DENY beats GRANT. The ladder lives there so that this
  // function, the gate and the capability blob cannot drift apart.
  //
  // A GRANT supplies capability but NEVER scope: an overridden cell is still
  // checked against the grants below, so a privilege cannot be used to reach a
  // property the person was never placed at.
  const priv = privilegeOn(access.privileges, functionality, action, q.nodeId ?? null);
  if (priv?.effect === "DENY") {
    const where = priv.nodeId ? "here" : "anywhere";
    return {
      ...base,
      allow: false,
      reason: priv.fromUser ? "DENY_USER_OVERRIDE" : "DENY_ROLE_PRIVILEGE",
      detail: priv.fromUser
        ? `${action} on ${functionalityPath(functionality)} is withheld from this user ${where}`
        : `${action} on ${functionalityPath(functionality)} is withheld from ${priv.subjectId} ${where}`,
    };
  }

  const cap = capability(access.roleKeys ?? [access.roleKey], functionality, action);
  if (!cap.held && priv?.effect !== "GRANT") {
    const held = (access.roleKeys ?? [access.roleKey]).join(", ");
    return {
      ...base,
      allow: false,
      reason: "DENY_ROLE_LACKS_CAPABILITY",
      detail: `No held role (${held}) includes ${action} on ${functionalityPath(functionality)}`,
    };
  }
  const viaPrivilege = !cap.held && priv?.effect === "GRANT" ? priv : null;

  // Scope. null = unrestricted; [] = the user holds the capability but has no
  // grant anywhere, which is a different and much more actionable answer than
  // "your role cannot do this" — hence its own reason code.
  if (access.nodeIds !== null) {
    if (access.nodeIds.length === 0) {
      return {
        ...base,
        allow: false,
        reason: "DENY_NO_GRANT",
        detail: `No active grant places this user anywhere in the organization`,
      };
    }
    if (q.nodeId && !access.nodeIds.includes(q.nodeId)) {
      return {
        ...base,
        allow: false,
        reason: "DENY_NODE_OUT_OF_SCOPE",
        detail: `Outside the caller's granted scope`,
      };
    }
  }

  // A narrower data scope than the query needs cannot be widened by a node grant:
  // "assigned tasks only" stays that way however large the property scope is.
  if (q.dataScope && !satisfiesDataScope(access.dataScope, q.dataScope)) {
    return {
      ...base,
      allow: false,
      reason: "DENY_DATA_SCOPE",
      detail: `Caller holds ${access.dataScope} data scope; ${q.dataScope} required`,
    };
  }

  if (viaPrivilege) {
    return {
      ...base,
      allow: true,
      reason: viaPrivilege.fromUser ? "ALLOW_USER_OVERRIDE" : "ALLOW_ROLE_PRIVILEGE",
      detail: viaPrivilege.fromUser
        ? `Granted to this user specifically${viaPrivilege.nodeId ? " at this property" : ""} — no held role includes ${action} on ${functionalityPath(functionality)}`
        : `Granted to ${viaPrivilege.subjectId}${viaPrivilege.nodeId ? " at this property" : ""} — the role's base permissions do not include ${action} on ${functionalityPath(functionality)}`,
    };
  }

  return cap.via
    ? {
        ...base,
        allow: true,
        reason: "ALLOW_IMPLIED_CAPABILITY",
        via: cap.via,
        detail: `Role ${access.roleKey} holds ${cap.via} on ${functionalityPath(functionality)}, which confers ${action}`,
      }
    : {
        ...base,
        allow: true,
        reason: "ALLOW_ROLE_CAPABILITY",
        detail: `Role ${access.roleKey} grants ${action} on ${functionalityPath(functionality)}`,
      };
}

const WIDTH: Record<DataScope, number> = { ALL: 3, TEAM: 2, ASSIGNED: 1, SELF: 0 };

/** Held scope satisfies a requirement when it is at least as wide. */
export function satisfiesDataScope(held: DataScope, required: DataScope): boolean {
  return WIDTH[held] >= WIDTH[required];
}

/**
 * `moduleOf` for a string that may not be a known functionality — decide() is
 * reached with whatever a route or an HTTP body supplied, and an unknown key
 * must produce DENY_UNKNOWN_FUNCTIONALITY rather than an undefined module.
 */
function moduleOfSafe(functionality: Functionality): Module {
  return FUNCTIONALITY_MODULE[functionality] ?? "PLATFORM";
}

/**
 * Every decision for one MODULE, plus the rollup.
 *
 * The module level asks a different question from the functionality level:
 * "may this person into Audits at all?" is a fold over the eight answers, and
 * it must be COMPUTED from them rather than decided separately — a second
 * decision path is exactly the drift decide() exists to prevent.
 *
 * `allow` here means "something in this module", which is what lights a nav
 * section or a launcher card. It is NEVER sufficient to open a screen: the
 * screen names its own functionality.
 */
export interface ModuleDecision {
  module: Module;
  allow: boolean;
  /** The functionalities the caller does hold `action` on. */
  held: Functionality[];
  /** Per-functionality answers, in manifest order, for the preview. */
  functionalities: Decision[];
}

export function decideModule(
  access: EffectiveAccess,
  q: { module: Module; action?: NamedAction; nodeId?: string | null; dataScope?: DataScope },
): ModuleDecision {
  const action = q.action ?? "view";
  const functionalities = functionalitiesOf(q.module)
    // A functionality that does not carry the action is not a refusal worth
    // reporting at module level — it simply is not part of the question.
    .filter((f) => actionDef(f, action) != null)
    .map((f) => decide(access, { functionality: f, action, nodeId: q.nodeId, dataScope: q.dataScope }));
  const held = functionalities.filter((d) => d.allow).map((d) => d.functionality);
  return { module: q.module, allow: held.length > 0, held, functionalities };
}
