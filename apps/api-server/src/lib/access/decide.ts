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
  can,
  actionsFor,
  IMPLIES,
  ALL_MODULES,
  type Action,
  type Module,
  type UserRole,
} from "../permissions.js";
import type { EffectiveAccess, DataScope } from "../access.js";
import { overrideOn } from "./overrides.js";

export type ReasonCode =
  | "ALLOW_SYSTEM_ROLE"
  | "ALLOW_ROLE_CAPABILITY"
  | "ALLOW_IMPLIED_CAPABILITY"
  /** Held because of a per-person exception, not because of the role. */
  | "ALLOW_USER_OVERRIDE"
  | "DENY_UNKNOWN_MODULE"
  | "DENY_ACTION_NOT_ON_MODULE"
  | "DENY_ROLE_LACKS_CAPABILITY"
  /** Removed from ONE person whose role does carry it. */
  | "DENY_USER_OVERRIDE"
  | "DENY_NO_GRANT"
  | "DENY_NODE_OUT_OF_SCOPE"
  | "DENY_DATA_SCOPE";

export interface Decision {
  allow: boolean;
  reason: ReasonCode;
  /** Human sentence, assembled server-side so the 403 body and the preview agree verbatim. */
  detail: string;
  module: Module;
  action: Action;
  nodeId?: string | null;
  /** The action actually held, when the grant came via implication. */
  via?: Action;
}

export interface DecisionQuery {
  module: Module;
  action: Action;
  nodeId?: string | null;
  dataScope?: DataScope;
}

const MODULES = new Set<string>(ALL_MODULES);

/** Does the role hold `action` outright, or an action that implies it? */
function capability(roleKey: string, module: Module, action: Action): { held: boolean; via?: Action } {
  const role = roleKey as UserRole;
  if (can(role, module, action as never)) return { held: true };

  // Implication only ever widens, and only along read-only edges — an invariant
  // test asserts IMPLIES never confers a write, and that no role holds a write
  // without the matching read (which is what makes this safe to consult at all).
  for (const [from, tos] of Object.entries(IMPLIES) as Array<[Action, Action[]]>) {
    if (!tos.includes(action)) continue;
    if (can(role, module, from as never)) return { held: true, via: from };
  }
  return { held: false };
}

export function decide(access: EffectiveAccess, q: DecisionQuery): Decision {
  const { module, action } = q;
  const base = { module, action, nodeId: q.nodeId ?? null };

  // Super-admin / OPS_EXCELLENCE short-circuit, matching resolveAuditAccess.
  if (access.isGlobalAdmin) {
    return { ...base, allow: true, reason: "ALLOW_SYSTEM_ROLE", detail: `Role ${access.roleKey} has unrestricted access` };
  }

  if (!MODULES.has(module)) {
    return { ...base, allow: false, reason: "DENY_UNKNOWN_MODULE", detail: `No module named ${module}` };
  }

  if (!actionsFor(module).includes(action)) {
    return {
      ...base,
      allow: false,
      reason: "DENY_ACTION_NOT_ON_MODULE",
      detail: `${module} does not support the action ${action}`,
    };
  }

  // Per-person exceptions, applied AFTER the manifest checks and BEFORE scope.
  //
  // Order matters and is deliberate:
  //  - a DENY always wins, including over the person's own role. It is the only
  //    way to take one capability off one person, and a DENY that something
  //    else could outrank would not be worth writing;
  //  - a GRANT supplies the capability the role lacks, but grants NO scope. An
  //    override says what, never where — so an overridden capability is still
  //    checked against the grants below, and cannot be used to reach a property
  //    the person was never placed at.
  const override = overrideOn(access.overrides, module, action);
  if (override === "DENY") {
    return {
      ...base,
      allow: false,
      reason: "DENY_USER_OVERRIDE",
      detail: `${action} on ${module} is withheld from this user specifically`,
    };
  }

  const cap = capability(access.roleKey, module, action);
  if (!cap.held && override !== "GRANT") {
    return {
      ...base,
      allow: false,
      reason: "DENY_ROLE_LACKS_CAPABILITY",
      detail: `Role ${access.roleKey} does not include ${action} on ${module}`,
    };
  }
  const viaOverride = !cap.held && override === "GRANT";

  // Scope. null = unrestricted; [] = the user holds the capability but has no
  // grant anywhere, which is a different and much more actionable answer than
  // "your role cannot do this" — hence its own reason code.
  if (access.nodeIds !== null) {
    if (access.nodeIds.length === 0) {
      return {
        ...base,
        allow: false,
        reason: "DENY_NO_GRANT",
        detail: `No active grant places ${access.roleKey} anywhere in the organization`,
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

  if (viaOverride) {
    return {
      ...base,
      allow: true,
      reason: "ALLOW_USER_OVERRIDE",
      detail: `Granted to this user specifically — ${access.roleKey} does not include ${action} on ${module}`,
    };
  }

  return cap.via
    ? {
        ...base,
        allow: true,
        reason: "ALLOW_IMPLIED_CAPABILITY",
        via: cap.via,
        detail: `Role ${access.roleKey} holds ${cap.via} on ${module}, which confers ${action}`,
      }
    : {
        ...base,
        allow: true,
        reason: "ALLOW_ROLE_CAPABILITY",
        detail: `Role ${access.roleKey} grants ${action} on ${module}`,
      };
}

const WIDTH: Record<DataScope, number> = { ALL: 3, TEAM: 2, ASSIGNED: 1, SELF: 0 };

/** Held scope satisfies a requirement when it is at least as wide. */
export function satisfiesDataScope(held: DataScope, required: DataScope): boolean {
  return WIDTH[held] >= WIDTH[required];
}
