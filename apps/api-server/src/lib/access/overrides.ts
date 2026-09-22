/**
 * Per-employee permission overrides — the exception layer above the role matrix.
 *
 * The matrix answers "what may a WARDEN do?". This answers "what may THIS
 * warden do that other wardens may not?", without cloning the role and without
 * detaching the person from future role edits: every cell not listed here still
 * resolves from the role, so adding `approve` to WARDEN tomorrow still reaches
 * someone who carries an unrelated override today.
 *
 * CACHED, for the same reason the matrix is: `authorize()` runs on every
 * request, and an extra round trip per request to read a table that changes a
 * few times a month is not a trade worth making. The cache is per process with
 * a short TTL plus explicit invalidation on write — so a single-instance deploy
 * sees a change immediately, and a multi-instance one within the TTL.
 *
 * FAIL-CLOSED on a read failure: an unreadable override table yields NO
 * overrides, which means everyone falls back to their role. That loses a DENY
 * override, so the load error is logged loudly — but the alternative (denying
 * everything on a transient error) locks the product out over a hiccup.
 */
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db, accessUserPermissionsTable } from "@workspace/db";
import { logger } from "../logger.js";
import type { Action, Module } from "../permissions.js";

export type OverrideEffect = "GRANT" | "DENY";

/** "MODULE:action" → effect. The same key shape the matrix snapshot uses. */
export type OverrideMap = Map<string, OverrideEffect>;

export const overrideKey = (module: string, action: string) => `${module}:${action}`;

interface Entry {
  at: number;
  map: OverrideMap;
}

const TTL_MS = 30_000;
const cache = new Map<string, Entry>();

/** Drop one user's cached overrides. Called by every writer in this process. */
export function invalidateOverrides(userId: string): void {
  cache.delete(userId);
}

/** Drop everything — used by tests and by the clone path, which touches two users. */
export function invalidateAllOverrides(): void {
  cache.clear();
}

/** Live-row predicate: in its window. Rows are deleted, not revoked, so no revokedAt. */
function liveWindow(now: Date) {
  return and(
    lte(accessUserPermissionsTable.effectiveFrom, now),
    or(isNull(accessUserPermissionsTable.expiresAt), gt(accessUserPermissionsTable.expiresAt, now)),
  );
}

/** Read one user's live overrides straight from the database, bypassing the cache. */
export async function readOverrides(userId: string, now = new Date()): Promise<OverrideMap> {
  const rows = await db
    .select({
      module: accessUserPermissionsTable.module,
      action: accessUserPermissionsTable.action,
      effect: accessUserPermissionsTable.effect,
    })
    .from(accessUserPermissionsTable)
    .where(and(eq(accessUserPermissionsTable.userId, userId), liveWindow(now)));

  const map: OverrideMap = new Map();
  for (const r of rows) map.set(overrideKey(r.module, r.action), r.effect as OverrideEffect);
  return map;
}

/**
 * One user's live overrides, cached.
 *
 * Note the empty-map cache entry: most people have no overrides at all, and
 * caching that fact is what keeps this from being a per-request query for the
 * 99% who are ordinary members of their role.
 */
export async function overridesFor(userId: string): Promise<OverrideMap> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  try {
    const map = await readOverrides(userId);
    cache.set(userId, { at: Date.now(), map });
    return map;
  } catch (err) {
    logger.error({ err, userId }, "override load failed — falling back to role-only permissions");
    // Do NOT cache a failure: the next request should try again rather than
    // spend the whole TTL with a DENY override silently not applying.
    return hit?.map ?? new Map();
  }
}

/** The effect on one cell, or undefined when the person follows their role. */
export function overrideOn(
  map: OverrideMap | undefined,
  module: Module,
  action: Action,
): OverrideEffect | undefined {
  return map?.get(overrideKey(module, action));
}
