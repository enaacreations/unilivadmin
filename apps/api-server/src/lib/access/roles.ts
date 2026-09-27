/**
 * Role membership — the many-to-many that replaced users.role.
 *
 * A user holds a SET of roles and their capability is the union. Two folds in
 * the taxonomy helpers deserve stating, because they pull in opposite
 * directions and both are deliberate:
 *
 *   rank      → MAX of the held roles   (your strongest role decides what you may assign)
 *   org-wide  → ANY held role is org-wide (your broadest role decides your reach)
 *
 * Both mean "the strongest role wins", which is the only fold that does not
 * silently strip privilege someone was deliberately given.
 *
 * ONE DELIBERATE SEMANTIC CHANGE, recorded here because it is security-relevant
 * and invisible otherwise: AUDIT_READONLY used to be a CAP. As the sole role it
 * limited its holder to `view`. Under a union it can no longer cap anything —
 * if you also hold WARDEN you get WARDEN's writes, because a role that grants
 * less cannot take away what another role grants. Capping is now the job of a
 * DENY privilege, which says so explicitly and carries a reason. `AUDIT_READONLY`
 * alone behaves exactly as before.
 *
 * CACHED like the matrix and privileges: authorize() runs on every request.
 */
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { db, userRolesTable, rolesTable } from "@workspace/db";
import { logger } from "../logger.js";

interface Entry { at: number; roles: string[] }

const TTL_MS = 30_000;
const cache = new Map<string, Entry>();

export function invalidateRoles(userId?: string): void {
  if (!userId) { cache.clear(); return; }
  cache.delete(userId);
}

/** Live membership: inside its window, and naming a role that is still enabled. */
export async function readRoles(userId: string, now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ roleKey: userRolesTable.roleKey })
    .from(userRolesTable)
    .innerJoin(rolesTable, eq(rolesTable.key, userRolesTable.roleKey))
    .where(
      and(
        eq(userRolesTable.userId, userId),
        // The membership must be live AND the role itself enabled: revoking
        // one person's Warden and disabling Warden for everyone are different
        // decisions, and both have to stop capability.
        eq(userRolesTable.isActive, true),
        eq(rolesTable.isActive, true),
        lte(userRolesTable.effectiveFrom, now),
        or(isNull(userRolesTable.expiresAt), gt(userRolesTable.expiresAt, now)),
      ),
    );
  return [...new Set(rows.map((r) => r.roleKey))];
}

/**
 * One user's live roles, cached.
 *
 * `fallback` is the user's legacy users.role column. It is used ONLY when the
 * membership table returns nothing, which happens for a user created before the
 * backfill or in the window before one lands. Returning [] there would lock a
 * real person out of everything; falling back keeps them exactly as they were.
 */
export async function rolesFor(userId: string, fallback?: string | null): Promise<string[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.roles;

  try {
    const roles = await readRoles(userId);
    // Cache only a REAL membership read. The fallback is derived from an
    // argument that is not part of the cache key, so caching it would serve one
    // caller's fallback to the next — and would keep serving the legacy column
    // for a full TTL after the first membership row is written.
    if (roles.length) {
      cache.set(userId, { at: Date.now(), roles });
      return roles;
    }
    return fallback ? [fallback] : [];
  } catch (err) {
    logger.error({ err, userId }, "role membership load failed — falling back to the legacy column");
    return hit?.roles ?? (fallback ? [fallback] : []);
  }
}

/** Who holds a role — for the roles screen and the lockout backstop. */
export async function holdersOf(roleKeys: string[], now = new Date()): Promise<Map<string, string[]>> {
  if (!roleKeys.length) return new Map();
  const rows = await db
    .select({ roleKey: userRolesTable.roleKey, userId: userRolesTable.userId })
    .from(userRolesTable)
    .where(
      and(
        inArray(userRolesTable.roleKey, roleKeys),
        lte(userRolesTable.effectiveFrom, now),
        or(isNull(userRolesTable.expiresAt), gt(userRolesTable.expiresAt, now)),
      ),
    );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.roleKey, [...(out.get(r.roleKey) ?? []), r.userId]);
  return out;
}
