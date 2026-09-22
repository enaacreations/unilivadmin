import { Request, Response, NextFunction, RequestHandler } from "express";
import { can, type Action, type Module, type UserRole } from "../lib/permissions.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";
import { overridesFor, overrideKey, type OverrideMap } from "../lib/access/overrides.js";
import { SYSTEM_ROLES } from "../lib/access/matrix.js";

/**
 * A refusal is itself an access-control event (PRD §29).
 *
 * Fire-and-forget: a trail write must never turn a clean 403 into a 500.
 * Recorded at the GATE rather than per-route so no handler can forget it.
 */
function recordDenial(req: Request, modules: Module[], perm: Action): void {
  try {
    recordActivity(activityCtx(req), {
      event: "ACCESS_DENIED",
      entityId: modules.join(","),
      entityLabel: modules.join(","),
      after: { modules, perm, role: req.user?.role ?? null },
    });
  } catch {
    // never block the 403
  }
}

/**
 * Introspection tag stamped on every gate this module returns.
 *
 * Express keeps middleware as opaque functions, so a coverage sweep over
 * `router.stack` cannot otherwise tell an authorized route from an open one —
 * which is exactly how `POST /food/orders/:id/cancel` read as unauthorized when
 * it was gated inline all along. Tagging makes the gate a fact a test can
 * assert on rather than something inferred from source text.
 */
export interface AuthzTag {
  modules: Module[];
  perm: Action;
  anyOf: boolean;
}
export type TaggedHandler = RequestHandler & { __authz?: AuthzTag };

/** The tag on a handler, or undefined when it is not one of our gates. */
export function authzTagOf(h: unknown): AuthzTag | undefined {
  return (h as TaggedHandler | undefined)?.__authz;
}


/**
 * Does this CALLER hold module:perm, counting their personal overrides?
 *
 * Mirrors decide()'s order exactly — DENY beats GRANT beats the role — because
 * a gate that disagrees with the preview is the failure mode the whole access
 * plane is built to avoid. The gate still checks capability only; WHERE the
 * caller may act is enforced by the handlers' scope helpers, unchanged.
 *
 * System roles skip overrides entirely, matching both decide()'s short-circuit
 * and the write guard that refuses to store one against them. A DENY that the
 * gate honoured and the resolver ignored would be worse than no DENY at all.
 */
function holdsWithOverrides(
  overrides: OverrideMap,
  role: UserRole,
  module: Module,
  perm: Action,
): boolean {
  if (role in SYSTEM_ROLES) return can(role, module, perm);
  const effect = overrides.get(overrideKey(module, perm));
  if (effect === "DENY") return false;
  if (effect === "GRANT") return true;
  return can(role, module, perm);
}

export function authorize(module: Module, perm: Action = "view"): TaggedHandler {
  const mw: TaggedHandler = async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role as UserRole | undefined;
    if (!role) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    // Cached per user with a short TTL, and an empty map for the overwhelming
    // majority who carry no exceptions — so this is a lookup, not a query.
    const overrides = await overridesFor(req.user!.id);
    if (!holdsWithOverrides(overrides, role, module, perm)) {
      recordDenial(req, [module], perm);
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
  mw.__authz = { modules: [module], perm, anyOf: false };
  return mw;
}

/**
 * Passes when the role holds `perm` on ANY of the listed modules. Used by
 * shared endpoints that legitimately serve several surfaces — e.g. the
 * order-list feeds the All Orders page (FOOD_ALL_ORDERS), the Dispatch queue
 * (FOOD_DISPATCH) and the Kitchen board (FOOD_KITCHEN_SUMMARY). Gating on a
 * single module would lock operational roles (F&B managers) out of data they
 * must see, while granting them the "All Orders" module would wrongly light up
 * that page in their nav. An any-of gate keeps page access and data access
 * decoupled.
 */
export function authorizeAny(modules: Module[], perm: Action = "view"): TaggedHandler {
  const mw: TaggedHandler = async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role as UserRole | undefined;
    if (!role) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    const overrides = await overridesFor(req.user!.id);
    // Per module: a DENY on one of several modules narrows the gate without
    // closing it, which is what an any-of gate means.
    if (!modules.some((m) => holdsWithOverrides(overrides, role, m, perm))) {
      recordDenial(req, modules, perm);
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
  mw.__authz = { modules, perm, anyOf: true };
  return mw;
}
