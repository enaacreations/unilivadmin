/**
 * Shared authorization helpers used by route handlers on top of the RBAC
 * `authorize(module, perm)` middleware:
 *
 *  - pick()                 — allow-list a request body (anti mass-assignment)
 *  - isPropertyScoped()     — is THIS user limited to a single property?
 *  - scopedPropertyId()     — that property id, or null (= unrestricted)
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
  "KITCHEN_MANAGER",
  "PROJECTS_MANAGER",
  "PROPERTY_ACQUISITION",
  "SALES_EXECUTIVE",
  // Food org/regional roles manage many properties; the food module does its own
  // hierarchy-based scoping, so treat them as org-wide for the generic helper.
  "OPS_EXCELLENCE",
  "SENIOR_VICE_PRESIDENT",
  "CLUSTER_MANAGER",
  "CITY_HEAD",
  "ZONAL_HEAD",
  "FNB_SUPERVISOR",
  "FNB_MANAGER",
  "FNB_ZONAL_HEAD",
]);

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
  // ── Tier 3: org-wide leadership / cross-property heads ───────────────────
  SENIOR_VICE_PRESIDENT: 80,
  AUDIT_READONLY: 80,
  FINANCE: 80,
  HR_MANAGER: 80,
  OPERATIONS_MANAGER: 80,
  PROCUREMENT_MANAGER: 80,
  PROJECTS_MANAGER: 80,
  PROPERTY_ACQUISITION: 80,
  FNB_ZONAL_HEAD: 80,
  ZONAL_HEAD: 80,
  // ── Tier 2: mid-level / regional managers ────────────────────────────────
  CITY_HEAD: 50,
  CLUSTER_MANAGER: 50,
  FNB_MANAGER: 50,
  FNB_SUPERVISOR: 50,
  // ── Tier 1: property / line roles ────────────────────────────────────────
  WARDEN: 20,
  UNIT_LEAD: 20,
  SALES_EXECUTIVE: 20,
  KITCHEN_MANAGER: 20,
  VENDOR_RESTRICTED: 20,
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

/** True when the caller is bound to a single property (e.g. WARDEN / UNIT_LEAD). */
export function isPropertyScoped(req: Request): boolean {
  const role = req.user?.role;
  return !!role && !ORG_WIDE_ROLES.has(role) && !!req.user?.propertyId;
}

/** The property a scoped caller is limited to, or null when unrestricted. */
export function scopedPropertyId(req: Request): string | null {
  return isPropertyScoped(req) ? req.user?.propertyId ?? null : null;
}

/**
 * Throw 403 if a property-scoped caller targets a property that isn't theirs.
 * A no-op for org-wide roles. Pass the propertyId the request is acting on.
 */
export function assertPropertyAccess(req: Request, propertyId: string | null | undefined): void {
  const scope = scopedPropertyId(req);
  if (scope && propertyId && propertyId !== scope) {
    throw forbidden("Outside your property scope");
  }
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
