/**
 * Shared authorization helpers used by route handlers on top of the RBAC
 * `authorize(module, perm)` middleware:
 *
 *  - pick()                 — allow-list a request body (anti mass-assignment)
 *  - isPropertyScoped()     — is THIS user limited to a property at all?
 *  - scopedPropertyIds()    — EVERY property they may act on, or null (= unrestricted)
 *  - assertPropertyAccess() — 403 if a scoped user reaches outside their property
 *  - forbidden()/badRequest() — typed errors the central error handler renders
 *
 * Object-level scoping policy (deliberately conservative): only roles that are
 * genuinely bound to one property/site (e.g. WARDEN, UNIT_LEAD) are filtered to
 * their own propertyId. Org-wide roles (SUPER_ADMIN, OPERATIONS_MANAGER, FINANCE,
 * AUDIT_READONLY, regional/cluster heads, …) are unrestricted, so adding scoping
 * never changes what those roles already see.
 */
import type { Request } from "express";

/** Roles that operate across ALL properties — never row-filtered by propertyId. */
const ORG_WIDE_ROLES = new Set<string>([
  "SUPER_ADMIN",
  "AUDIT_READONLY",
  "OPERATIONS_MANAGER",
  "FINANCE",
  "HR_MANAGER",
  "PROCUREMENT_MANAGER",
  // The functional admins in the role list are "All properties" by scope.
  "RM_MANAGER",
  "HOUSEKEEPING_MANAGER",
  "CUSTOMER_EXPERIENCE",
  "CARE_DESK_AGENT",
  "SALES_ADMIN",
  "FINANCE_EXECUTIVE",
  // Food org/regional roles manage many properties; the food module does its own
  // hierarchy-based scoping, so treat them as org-wide for the generic helper.
  "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT",
  "CLUSTER_MANAGER",
  "CITY_HEAD",
  "ZONAL_HEAD",
  "FNB_SUPERVISOR",
  "FNB_MANAGER",
  "FNB_MANAGER",
  // Customer Experience conducts ad-hoc CX audits across the estate, and its
  // audit grant is org-wide. It was in NEITHER this set nor ROLE_RANK, so it
  // was unrestricted only by accident (a null propertyId makes
  // isPropertyScoped return false) and ranked 0, i.e. the least privileged role
  // in the system — meaning nobody could be assigned it. Making both explicit
  // changes no live behaviour: the one CX account has no propertyId today.
  "CUSTOMER_EXPERIENCE",
]);

/**
 * The org-wide role set as an array, for the access backfill: each holder gets
 * an explicit ORGANIZATION-scoped grant so "org-wide" stops being a hard-coded
 * constant and becomes a revocable row.
 */
export const ORG_WIDE_ROLES_LIST: string[] = [...ORG_WIDE_ROLES];

export interface HttpError extends Error {
  statusCode: number;
  details?: unknown;
}

export function httpError(statusCode: number, message: string, details?: unknown): HttpError {
  const e = new Error(message) as HttpError;
  e.statusCode = statusCode;
  if (details !== undefined) e.details = details;
  return e;
}

export const forbidden = (msg = "Forbidden") => httpError(403, msg);
export const badRequest = (msg = "Bad request", details?: unknown) => httpError(400, msg, details);

/**
 * Render a thrown HttpError from inside a handler's own try/catch, returning
 * true when it did. For the older routers that catch everything and answer 500:
 * without this an `assertPropertyAccess` 403 is swallowed and reported as an
 * internal error, which reads as a bug rather than a refusal.
 *
 * Newer routers (the audit files) throw straight through to the central handler
 * in app.ts and need none of this. Use it only where a try/catch already exists.
 *
 * NOTE: five route files (residents, bookings, users, bulk, properties) carry a
 * hand-copied version of this; properties.ts's copy handles only 403/400 and all
 * five drop `details`. They are left alone here deliberately — consolidating them
 * is a mechanical cleanup that belongs in its own change, not in a security fix.
 */
export function sendAuthzError(err: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }): boolean {
  const e = err as { statusCode?: number; message?: string; details?: unknown } | null;
  if (typeof e?.statusCode !== "number") return false;
  const body: Record<string, unknown> = { success: false, error: e.message || "Forbidden" };
  if (e.details != null) body["details"] = e.details;
  res.status(e.statusCode).json(body);
  return true;
}

/**
 * Privilege tiers used to gate role assignment (anti privilege-escalation).
 * Higher number = more privileged. A caller may grant roles of EQUAL or LOWER
 * tier than their own, never higher; only SUPER_ADMIN (the sole rank-100 role)
 * can grant SUPER_ADMIN. Any role not listed here defaults to 0 (lowest) via the
 * lookup in assertCanAssignRole().
 */
export const ROLE_RANK: Record<string, number> = {
  // ── Tier 4: top of the org ──────────────────────────────────────────────
  SUPER_ADMIN: 100,
  // B3-24: OPS_EXCELLENCE has full super-admin parity, so it ranks alongside it.
  OPS_EXCELLENCE: 100,
  // ── Tier 3: org-wide leadership / functional admins ─────────────────────
  SENIOR_VICE_PRESIDENT: 80,
  AUDIT_READONLY: 80,
  OPERATIONS_MANAGER: 80,
  FINANCE: 80,
  HR_MANAGER: 80,
  PROCUREMENT_MANAGER: 80,
  ZONAL_HEAD: 80,
  // The functional admins own their domain across every property, which is a
  // tier-3 reach even though each one is narrow.
  RM_MANAGER: 80,
  HOUSEKEEPING_MANAGER: 80,
  CUSTOMER_EXPERIENCE: 80,
  SALES_ADMIN: 80,
  // ── Tier 2: mid-level / regional managers ────────────────────────────────
  CITY_HEAD: 50,
  CLUSTER_MANAGER: 50,
  SALES_MANAGER: 50,
  FNB_MANAGER: 50,
  FNB_SUPERVISOR: 50,
  FINANCE_EXECUTIVE: 50,
  // Org-wide by scope, but junior: raises and routes, does not close.
  CARE_DESK_AGENT: 50,
  // ── Tier 1: property / line roles ────────────────────────────────────────
  UNIT_LEAD: 20,
  RM_SUPERVISOR: 20,
  HOUSEKEEPING_SUPERVISOR: 20,
  SALES_EXECUTIVE: 20,
  KITCHEN_MANAGER: 20,
};

/**
 * Throw 403 unless `callerRole` is permitted to assign `targetRole`.
 * Rule: SUPER_ADMIN may assign anything; everyone else may grant roles of EQUAL
 * OR LOWER rank than their own (lateral peer management is allowed — e.g. an
 * HR_MANAGER onboarding another tier-3 manager) but NEVER a higher tier. Since
 * SUPER_ADMIN is the sole rank-100 role, this still makes escalation to
 * SUPER_ADMIN impossible for anyone who isn't already SUPER_ADMIN. Unknown roles
 * rank 0 (lowest).
 */
/**
 * True for the top-tier admin roles that are treated identically everywhere.
 * B3-24 granted OPS_EXCELLENCE full parity with SUPER_ADMIN, so every former
 * `role === "SUPER_ADMIN"` privilege gate should use this instead.
 */
export function isSuperAdmin(role: string | undefined | null): boolean {
  return role === "SUPER_ADMIN" || role === "OPS_EXCELLENCE";
}

export function assertCanAssignRole(callerRole: string, targetRole: string): void {
  if (isSuperAdmin(callerRole)) return;
  const callerRank = ROLE_RANK[callerRole] ?? 0;
  const targetRank = ROLE_RANK[targetRole] ?? 0;
  if (targetRank <= callerRank) return;
  throw forbidden("You cannot assign a role above your own privilege level");
}

/* ── Multi-role folds ──────────────────────────────────────────────────────
 *
 * A user holds a SET of roles. Each helper below has to decide how a set
 * collapses to one answer, and the two folds pull in opposite directions:
 *
 *   rank      → MAX   (your strongest role decides what you may assign)
 *   org-wide  → ANY   (your broadest role decides your reach)
 *
 * Both amount to "the strongest role wins", which is the only fold that never
 * silently strips access someone was deliberately granted. The alternative —
 * intersecting — would mean assigning a second role could REDUCE what a person
 * can do, which no administrator would predict.
 * ────────────────────────────────────────────────────────────────────────── */

/** The highest-ranked role in a set — the one shown wherever one role is shown. */
export function primaryRoleOf(roles: string[] | undefined): string | null {
  if (!roles?.length) return null;
  return [...roles].sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0] ?? null;
}

/** The effective rank of a set: the highest any member carries. */
export function rankOf(roles: string[] | undefined): number {
  if (!roles?.length) return 0;
  return Math.max(...roles.map((r) => ROLE_RANK[r] ?? 0));
}

/** Any parity role in the set makes the holder a parity user. */
export function isSuperAdminAny(roles: string[] | undefined): boolean {
  return !!roles?.some((r) => isSuperAdmin(r));
}

/** Any org-wide role in the set unscopes the holder. */
export function isOrgWideAny(roles: string[] | undefined): boolean {
  return !!roles?.some((r) => ORG_WIDE_ROLES.has(r));
}

/**
 * Multi-role form of assertCanAssignRole: compares the caller's HIGHEST rank
 * against the target's highest. Without the max fold, holding a junior role
 * alongside a senior one would quietly strip the senior one's authority.
 */
export function assertCanAssignRoles(callerRoles: string[], targetRoles: string[]): void {
  if (isSuperAdminAny(callerRoles)) return;
  const callerRank = rankOf(callerRoles);
  for (const target of targetRoles) {
    if ((ROLE_RANK[target] ?? 0) > callerRank) {
      throw forbidden("You cannot assign a role above your own privilege level");
    }
  }
}

/** True when the caller is bound to a property (e.g. WARDEN / UNIT_LEAD). */
export function isPropertyScoped(req: Request): boolean {
  const role = req.user?.role;
  return !!role && !ORG_WIDE_ROLES.has(role) && !!req.user?.propertyId;
}

/**
 * EVERY property the caller may act on, or null when unrestricted.
 *
 * Resolved by the access engine — grants included — so a Cluster Manager given
 * a cluster gets every property under it, and a Unit Lead placed at two gets
 * both. `users.propertyId` alone could only ever answer with one, which is why
 * this is the read-side helper and `primaryPropertyId` is not.
 *
 * ── Why a resolver is injected rather than imported ────────────────────────
 * This module is a LEAF: lib/access.ts imports it, so importing lib/access.ts
 * back would be a cycle. The resolver is installed once at startup, and until
 * it is, this falls back to the home property — which is exactly the old
 * single-property behaviour, so an uninstalled resolver degrades to the
 * previous answer rather than to "everything".
 *
 * ── What this deliberately does NOT change ─────────────────────────────────
 * A caller with no property at all still reads as UNRESTRICTED here, because
 * `isPropertyScoped` is false for them. That is a pre-existing hole — 29 of the
 * 32 seeded accounts have no property — and closing it would flip those users
 * from "sees everything" to "sees nothing" on every legacy-scoped route at
 * once. It is called out rather than fixed in the same change that widens one
 * property to many.
 */
export type PropertyScopeResolver = (req: Request) => Promise<string[] | null>;

let propertyScopeResolver: PropertyScopeResolver | null = null;

/** Pass null to clear it — used by tests to get back to the home-property fallback. */
export function installPropertyScopeResolver(fn: PropertyScopeResolver | null): void {
  propertyScopeResolver = fn;
}

export async function scopedPropertyIds(req: Request): Promise<string[] | null> {
  if (!isPropertyScoped(req)) return null;
  const home = req.user?.propertyId ?? null;
  if (!propertyScopeResolver) return home ? [home] : null;

  const resolved = await propertyScopeResolver(req);
  // null from the resolver means an org-wide grant — genuinely unrestricted.
  if (resolved === null) return null;
  const ids = [...new Set([...resolved, ...(home ? [home] : [])])];
  // Never widen to "everything" because a resolve came back empty: the home
  // property is the floor, and an empty answer with no home is a real "nowhere".
  return ids.length ? ids : home ? [home] : [];
}

/**
 * Throw if a property-scoped caller targets a property that isn't theirs.
 * A no-op for org-wide roles. Pass the propertyId the request is acting on.
 *
 * A NULL target from a scoped caller is a 400, not a pass. It used to be a
 * silent no-op, which meant an unscoped write (a create whose body omitted
 * propertyId) sailed through the very check meant to catch it. Every existing
 * call site already guards the null case itself — an `if (!body.propertyId)`
 * 400, a `!== undefined` test, or a NOT NULL column — so this closes the hole
 * without changing any current behaviour. Org-wide callers keep passing null
 * freely: for them a null propertyId legitimately means "all properties"
 * (announcements, tariffs).
 */
export async function assertPropertyAccess(req: Request, propertyId: string | null | undefined): Promise<void> {
  const scope = await scopedPropertyIds(req);
  if (!scope) return;
  if (!propertyId) throw badRequest("propertyId is required", { code: "SCOPE_REQUIRED" });
  if (!scope.includes(propertyId)) throw forbidden("Outside your property scope");
}

/**
 * The propertyId a LIST query should filter on, folding the caller's own scope
 * into an optional `?propertyId=` filter.
 *
 *   org-wide caller  → whatever they asked for (null = every property)
 *   scoped caller    → always their own property; asking for another one is 403
 *
 * Use this wherever a handler does `const where = propertyId ? eq(t.propertyId,
 * propertyId) : undefined` — that pattern returns EVERY row when the caller
 * omits the filter, which is how a warden can list another property's rooms.
 */
export async function effectivePropertyFilter(
  req: Request,
  requested: string | null | undefined,
): Promise<string[] | null> {
  const scope = await scopedPropertyIds(req);
  if (!scope) return requested ? [requested] : null;
  if (requested) {
    if (!scope.includes(requested)) throw forbidden("Outside your property scope");
    // Narrowing to one of their own is legitimate — it is the filter they asked
    // for, inside the set they are allowed.
    return [requested];
  }
  return scope;
}

/**
 * Allow-list a body object to a fixed set of keys. Undefined values are dropped
 * so callers can't blank out columns by omission semantics. Use everywhere a
 * handler previously spread `...req.body` or iterated arbitrary keys into a DB
 * insert/update, to block privilege/field escalation (role, balance, id, …).
 */
// Returns/accepts `any` on purpose: callers pass the untyped Express req.body and
// spread the result straight into drizzle .values()/.set(), which needs
// column-compatible types. A generic Partial<T> resolves to an all-optional shape
// that fails drizzle's required-field overload — so we mirror the original
// `...req.body` (any) behavior while still restricting to the allow-listed keys.
export function pick(body: any, keys: readonly string[]): any {
  const out: Record<string, any> = {};
  if (!body || typeof body !== "object") return out;
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
