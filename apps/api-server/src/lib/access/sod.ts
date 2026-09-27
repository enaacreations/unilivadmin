/**
 * Separation of duties (PRD §33).
 *
 * Two different rules get conflated under this heading, and they need different
 * machinery:
 *
 *  - STATIC  — capability pairs no single ROLE may hold ("the party that ships
 *              must not be the party that certifies receipt").
 *  - DYNAMIC — the actual §33 ask: the same PERSON must not approve the record
 *              they created, even when their role legitimately permits both.
 *
 * Both live in code, not config. Making them runtime-editable would hand an
 * administrator a switch that turns off the control constraining administrators
 * — which is the one control that must not be self-administered.
 */
import type { Request, RequestHandler } from "express";
import { httpError, isSuperAdmin } from "../authz.js";
import { recordActivity, activityCtx } from "../activity/record.js";
import type { Functionality, NamedAction } from "../permissions.js";

/* ── Static: capability pairs ──────────────────────────────────────────────── */

export interface ConflictRule {
  id: string;
  /**
   * A conflict is between two FUNCTIONALITIES, never two modules. Both halves
   * of the shipping/receiving rule live inside the FOOD module, so a
   * module-level rule could not express it at all.
   */
  a: { functionality: Functionality; perm: NamedAction };
  b: { functionality: Functionality; perm: NamedAction };
  /** Break-glass parity roles permitted to hold both. */
  exempt: readonly string[];
  /** Surfaced in the 409 body and (later) the matrix editor's tooltip. */
  rationale: string;
}

const PARITY = ["SUPER_ADMIN", "OPS_EXCELLENCE"] as const;

/**
 * The invariant was previously a 20-line comment in two files plus three
 * hardcoded assertions in permissions-sync.test.ts — unenforceable the moment
 * the matrix moves into the database. As data it is checked from ONE definition
 * in three places: the matrix editor, the grant guards, and sod.test.ts.
 */
export const CAPABILITY_CONFLICTS: readonly ConflictRule[] = [
  {
    id: "FOOD_SHIP_VS_RECEIVE",
    a: { functionality: "FOOD_DISPATCH", perm: "edit" },
    b: { functionality: "FOOD_CONFIRM_DELIVERY", perm: "edit" },
    exempt: PARITY,
    rationale:
      "The party that SHIPS must never be the party that CERTIFIES RECEIPT. A 403 here means a dispatch path is trying to confirm its own delivery; the route is what has to change, not the grant.",
  },
];

/** Conflicts a role would violate, given a predicate for what it holds. */
export function staticConflicts(
  roleKey: string,
  holds: (functionality: Functionality, perm: NamedAction) => boolean,
): ConflictRule[] {
  return CAPABILITY_CONFLICTS.filter(
    (r) =>
      !r.exempt.includes(roleKey) &&
      holds(r.a.functionality, r.a.perm) &&
      holds(r.b.functionality, r.b.perm),
  );
}

/**
 * Conflicts a SET of roles would violate together.
 *
 * Multi-role opened a hole the single-role check could not see: the pair may be
 * split ACROSS two roles, each innocent on its own. "Dispatch" holds one half,
 * "Delivery" the other, and nobody holding just one ever trips the rule — but
 * the person holding both ships and certifies their own shipment.
 *
 * Exemption is deliberately ALL-or-nothing: a rule is waived only when every
 * held role is exempt. Holding one parity role does not licence the
 * combination, because the point of a break-glass exemption is that the person
 * is operating AS that role, not that they happen to also have it.
 */
export function crossRoleConflicts(
  roleKeys: string[],
  holds: (roleKey: string, functionality: Functionality, perm: NamedAction) => boolean,
): Array<ConflictRule & { via: [string, string] }> {
  const out: Array<ConflictRule & { via: [string, string] }> = [];
  for (const rule of CAPABILITY_CONFLICTS) {
    if (roleKeys.length && roleKeys.every((r) => rule.exempt.includes(r))) continue;
    const aHolders = roleKeys.filter((r) => holds(r, rule.a.functionality, rule.a.perm));
    const bHolders = roleKeys.filter((r) => holds(r, rule.b.functionality, rule.b.perm));
    if (!aHolders.length || !bHolders.length) continue;
    // Prefer naming two DIFFERENT roles — that is the case the single-role
    // check already misses, and the one an administrator will not expect.
    const split = aHolders.find((a) => bHolders.some((b) => b !== a));
    const via: [string, string] = split
      ? [split, bHolders.find((b) => b !== split)!]
      : [aHolders[0]!, bHolders[0]!];
    out.push({ ...rule, via });
  }
  return out;
}

/**
 * Refuse a role assignment that would complete a conflicting pair.
 *
 * Checked at ASSIGNMENT rather than at decide(), because the combination is
 * what is forbidden — refusing it at request time would leave a person
 * configured with an impossible role set and an error they cannot act on.
 */
export function assertNoCrossRoleConflict(
  roleKeys: string[],
  holds: (roleKey: string, functionality: Functionality, perm: NamedAction) => boolean,
): void {
  const violated = crossRoleConflicts(roleKeys, holds);
  if (!violated.length) return;
  const first = violated[0]!;
  throw httpError(409, `These roles together violate separation of duties: ${first.rationale}`, {
    code: "SOD_CONFLICT",
    rule: first.id,
    via: first.via,
    roles: roleKeys,
  });
}

/* ── Dynamic: creator ≠ approver, on THIS record ───────────────────────────── */

export type SodAction = "approve" | "reject" | "verify" | "complete" | "confirm";

/** Prior actors on the record, keyed by the part they played. */
export interface SodActors {
  createdBy?: string | null;
  submittedBy?: string | null;
  assignedBy?: string | null;
  dispatchedBy?: string | null;
  [role: string]: string | null | undefined;
}

export interface SodSubject {
  type: string;
  id: string;
  actors: SodActors;
}

/**
 * Throw 409 when the actor already played a conflicting part on this record.
 *
 * A super-admin override does NOT throw, but the caller is told to record it —
 * an override that leaves no trace is not an override, it is a hole. The
 * function returns the overridden rule so the caller can log it.
 */
export function assertNotSelfApproval(
  actorId: string,
  actorRole: string | undefined,
  subject: SodSubject,
  action: SodAction,
  opts?: { conflictsWith?: readonly string[]; overrideReason?: string | null },
): { overridden: false } | { overridden: true; conflictingActor: string; reason: string } {
  const keys = opts?.conflictsWith ?? Object.keys(subject.actors);
  const clash = keys.find((k) => {
    const v = subject.actors[k];
    return !!v && v === actorId;
  });
  if (!clash) return { overridden: false };

  // Break-glass: allowed, but only with a stated reason, and only for parity
  // roles. Everyone else is refused outright.
  if (isSuperAdmin(actorRole) && opts?.overrideReason) {
    return { overridden: true, conflictingActor: clash, reason: opts.overrideReason };
  }

  throw httpError(409, `Separation of duties: you cannot ${action} a record you ${clash.replace(/By$/, "")}`, {
    code: "SOD_SELF_APPROVAL",
    subjectType: subject.type,
    subjectId: subject.id,
    conflictingActor: clash,
    action,
  });
}

/* ── Middleware form ───────────────────────────────────────────────────────── */

export interface SodTag {
  entity: string;
  action: SodAction;
}
export type SodHandler = RequestHandler & { __sod?: SodTag };

/** The SoD tag on a handler, for the coverage sweep. */
export function sodTagOf(h: unknown): SodTag | undefined {
  return (h as SodHandler | undefined)?.__sod;
}

/**
 * Declare SoD next to `authorize(...)` in the route table rather than burying
 * it in a handler, so `sod-coverage.test.ts` can see it and a new approval
 * endpoint cannot ship without one.
 */
export function enforceSod(cfg: {
  entity: string;
  action: SodAction;
  load: (req: Request) => Promise<SodSubject | null>;
  conflictsWith?: readonly string[];
}): SodHandler {
  const mw: SodHandler = async (req, _res, next) => {
    try {
      const subject = await cfg.load(req);
      // A missing record is the handler's 404 to give, not ours.
      if (!subject) return next();
      const result = assertNotSelfApproval(
        req.user!.id,
        req.user?.role,
        subject,
        cfg.action,
        {
          ...(cfg.conflictsWith ? { conflictsWith: cfg.conflictsWith } : {}),
          overrideReason: (req.body?.sodOverrideReason as string | undefined) ?? null,
        },
      );
      if (result.overridden) {
        // A log line alone is not a record. This is a SECURITY-category event
        // on the chained ACCESS stream, because "who waived separation of
        // duties, on what, and why" is exactly what an auditor asks for.
        try {
          recordActivity(activityCtx(req), {
            event: "SOD_OVERRIDDEN",
            entityId: subject.id,
            entityLabel: `${cfg.entity}:${cfg.action}`,
            reason: result.reason,
            after: { conflictingActor: result.conflictingActor, entity: cfg.entity, action: cfg.action },
          });
        } catch { /* never block the action the override permitted */ }
        req.log?.warn(
          {
            sod: "OVERRIDDEN",
            actorId: req.user!.id,
            actorRole: req.user?.role,
            entity: cfg.entity,
            subjectId: subject.id,
            conflictingActor: result.conflictingActor,
            reason: result.reason,
          },
          "separation of duties overridden",
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
  mw.__sod = { entity: cfg.entity, action: cfg.action };
  return mw;
}
