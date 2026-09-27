import { Request, Response, NextFunction, RequestHandler } from "express";
import {
  canAny, functionalitiesOf, functionalityPath, readActionOf, permissionName,
  type ActionOf, type Functionality, type Module, type NamedAction,
} from "../lib/permissions.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";
import { privilegesFor, privilegeOn, type PrivilegeMap } from "../lib/access/privileges.js";
import { rolesFor } from "../lib/access/roles.js";
import { SYSTEM_ROLES } from "../lib/access/matrix.js";

/**
 * A refusal is itself an access-control event (PRD §29).
 *
 * Fire-and-forget: a trail write must never turn a clean 403 into a 500.
 * Recorded at the GATE rather than per-route so no handler can forget it.
 */
function recordDenial(req: Request, functionalities: Functionality[], perm: string): void {
  try {
    recordActivity(activityCtx(req), {
      event: "ACCESS_DENIED",
      entityId: functionalities.join(","),
      entityLabel: functionalities.map((f) => functionalityPath(f)).join(", "),
      after: { functionalities, perm, role: req.user?.role ?? null },
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
/**
 * One permission: a functionality and an action that functionality defines.
 *
 * Built through `on()` rather than written as a bare tuple so the pair is
 * checked — `on("FOOD_ORG", "submit_audit")` does not compile.
 */
export type ActionPair = readonly [Functionality, NamedAction];

/** One checked (functionality, action) pair for an any-of gate. */
export function on<F extends Functionality>(f: F, a: ActionOf<F>): ActionPair {
  return [f, a as NamedAction];
}

/**
 * "May read any of these surfaces" — each functionality paired with its OWN
 * read action.
 *
 * This is what the eleven `authorizeAny(FOOD_FUNCTIONALITIES, "view")` gates
 * actually meant. Spelling it out as fifteen inline pairs would bury the intent
 * in noise, and flattening it back to one `"view"` is the nomenclature being
 * removed — so the expansion is computed from the manifest instead. A
 * functionality added to the list tomorrow contributes its own read action, not
 * a verb assumed to exist.
 */
export function reads(functionalities: readonly Functionality[]): ActionPair[] {
  return functionalities.map((f) => {
    const read = readActionOf(f);
    if (!read) throw new Error(`${f} defines no actions`);
    return [f, read] as ActionPair;
  });
}

export interface AuthzTag {
  /** The functionalities this gate accepts — the enforced unit. */
  functionalities: Functionality[];
  /**
   * Every (functionality, action) pair this gate accepts, each a real permission
   * id. An any-of gate spanning fifteen surfaces has fifteen DIFFERENT read
   * actions, so there is no single verb to record — the old shape had to flatten
   * them to "view", which is exactly the nomenclature being removed.
   */
  pairs: ActionPair[];
  /** @deprecated Read `pairs`. Kept so the first pair still reads as the gate's action. */
  perm: NamedAction;
  anyOf: boolean;
  /**
   * Set when the gate was written as `authorizeModule(m)` — the module whose
   * functionalities `functionalities` was expanded from. Carried so a coverage
   * sweep can report the gate the way it was written, and so the expansion is
   * visible rather than looking like a hand-listed any-of.
   */
  module?: Module;
}
export type TaggedHandler = RequestHandler & { __authz?: AuthzTag };

/** The tag on a handler, or undefined when it is not one of our gates. */
export function authzTagOf(h: unknown): AuthzTag | undefined {
  return (h as TaggedHandler | undefined)?.__authz;
}


/**
 * Does this CALLER hold functionality:perm, counting their personal overrides?
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
function holdsWithPrivileges(
  privileges: PrivilegeMap,
  roles: string[],
  functionality: Functionality,
  perm: NamedAction,
): boolean {
  // System roles resolve by rule and decide() short-circuits them, so a
  // privilege stored against one would be shown by the UI and ignored by the
  // server. The write guard refuses to store one; this honours that.
  if (roles.some((r) => r in SYSTEM_ROLES)) return canAny(roles, functionality, perm);

  // No node in hand at the gate — it guards capability, not place, and the
  // handlers' scope helpers decide WHERE. privilegeOn() with a null node
  // therefore considers only global rules, so a privilege written for one
  // property cannot open an endpoint everywhere.
  const priv = privilegeOn(privileges, functionality, perm, null);
  if (priv?.effect === "DENY") return false;
  if (priv?.effect === "GRANT") return true;
  return canAny(roles, functionality, perm);
}

/**
 * The gate. Names ONE functionality, because a screen or an endpoint is one
 * capability — "may see something in Audits" is not "may review an audit".
 *
 * For an endpoint that serves a whole module, use `authorizeModule` rather than
 * widening this one.
 */
/**
 * `perm` is `ActionOf<F>` — the actions THIS functionality defines — and has no
 * default. Widening it to accept any named action (or a legacy verb) would make
 * the generic decorative: `authorize("PROPERTIES", "submit_audit")` would
 * compile and then refuse everyone at runtime. Demanding the exact pair is what
 * makes a permission id one thing rather than a noun and a verb that happen to
 * be adjacent.
 */
export function authorize<F extends Functionality>(functionality: F, perm: ActionOf<F>): TaggedHandler {
  const mw: TaggedHandler = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    // Both cached per user with a short TTL, and empty for the overwhelming
    // majority who carry no exceptions — so this is two lookups, not two queries.
    const roles = await rolesFor(req.user.id, req.user.role);
    const privileges = await privilegesFor(req.user.id, roles);
    if (!holdsWithPrivileges(privileges, roles, functionality, perm)) {
      recordDenial(req, [functionality], perm);
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
  mw.__authz = { functionalities: [functionality], pairs: [on(functionality, perm)], perm, anyOf: false };
  return mw;
}

/**
 * Passes when the role holds `perm` on ANY of the listed functionalities. Used
 * by shared endpoints that legitimately serve several surfaces — e.g. the
 * order-list feeds the All Orders page (FOOD_ALL_ORDERS), the Dispatch queue
 * (FOOD_DISPATCH) and the Kitchen board (FOOD_KITCHEN_SUMMARY). Gating on a
 * single functionality would lock operational roles (F&B managers) out of data
 * they must see, while granting them the "All Orders" functionality would
 * wrongly light up that page in their nav. An any-of gate keeps page access and
 * data access decoupled.
 *
 * Prefer `authorizeModule` when the list happens to be every functionality of
 * one module: it says so, and it cannot fall out of date when one is added.
 */
export function authorizeAny(pairs: readonly ActionPair[]): TaggedHandler {
  const functionalities = [...new Set(pairs.map(([f]) => f))];
  const mw: TaggedHandler = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    const roles = await rolesFor(req.user.id, req.user.role);
    const privileges = await privilegesFor(req.user.id, roles);
    // Per PAIR: a DENY on one of several narrows the gate without closing it,
    // which is what an any-of gate means.
    if (!pairs.some(([f, a]) => holdsWithPrivileges(privileges, roles, f, a))) {
      recordDenial(req, functionalities, pairs.map(([f, a]) => permissionName(f, a)).join(" | "));
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
  mw.__authz = { functionalities, pairs: [...pairs], perm: pairs[0]?.[1] ?? "view", anyOf: true };
  return mw;
}

/**
 * Passes when the caller holds `perm` on ANY functionality of `module`.
 *
 * For the handful of endpoints that genuinely serve a whole module rather than
 * one screen — a module-wide search, a launcher summary, a shared reference
 * list. It is `authorizeAny` over `functionalitiesOf(module)`, which is the
 * point: there is no module-level grant to look up, so this gate cannot
 * disagree with the functionality rows it folds over, and a functionality added
 * to the module is included automatically.
 *
 * Do NOT reach for this to clear a 403 on a screen-specific endpoint. That the
 * caller holds something in the module says nothing about whether they may do
 * THIS; widening the gate that way is how page access and data access drift
 * apart.
 */
export function authorizeModule(module: Module, pick: (fs: readonly Functionality[]) => ActionPair[] = reads): TaggedHandler {
  const functionalities = functionalitiesOf(module);
  const pairs = pick(functionalities);
  const inner = authorizeAny(pairs);
  const mw: TaggedHandler = (req, res, next) => inner(req, res, next);
  mw.__authz = { functionalities, pairs, perm: pairs[0]?.[1] ?? "view", anyOf: true, module };
  return mw;
}
