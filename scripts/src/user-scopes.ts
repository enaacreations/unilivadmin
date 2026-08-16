/**
 * Reconcile a seeded user's access grants the way the APPLICATION does.
 *
 * `user_scopes` revocation is a SOFT flag (`is_active`), not a row deletion —
 * H5, and `DELETE /api/food/scopes/:id` flips the flag rather than deleting.
 * The reason is not tidiness: the fail-closed resolver
 * (`resolveAccessiblePropertyIds`) treats "no live grant" as "sees nothing", so
 * a revoked row is the only record that distinguishes a deliberate access
 * decision from an account nobody has configured yet. A hard DELETE erases that
 * distinction, and with it who lost what and when.
 *
 * The seeds used to `DELETE FROM user_scopes WHERE user_id = ANY(...)` and
 * re-insert. Harmless on a scratch database — they recreate what they delete —
 * but pointed at a database with real revocations it silently destroys them,
 * and a re-granted row loses its original id, so an audit entry naming that id
 * dangles. This helper is the seed-side twin of `POST /api/food/scopes`:
 *
 *   • a wanted grant that already exists LIVE   → left alone (id preserved)
 *   • a wanted grant that exists REVOKED        → reactivated in place, exactly
 *     as the app's re-grant path does (the uq_user_scopes_grant_* partial
 *     indexes ignore is_active, so a second INSERT would 23505 instead)
 *   • a wanted grant that does not exist        → inserted
 *   • a live grant that is no longer wanted     → SOFT-revoked (is_active=false)
 *
 * It only ever touches the users it is given, so grants an admin created for
 * anyone else on a shared dev/e2e box survive a re-seed untouched.
 */
import { db, userScopesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

type ScopeInsert = typeof userScopesTable.$inferInsert;

/** A grant the seed wants to exist, without an id — identity is the geo tuple. */
export type DesiredGrant = Omit<ScopeInsert, "id" | "isActive" | "createdAt">;

export interface ScopeSyncResult {
  inserted: number;
  reactivated: number;
  unchanged: number;
  revoked: number;
}

/**
 * The identity of a grant, matching the app's own duplicate check in
 * `POST /food/scopes`: (user, level, and every geo column). A stored grant
 * carries exactly one non-null geo id, so comparing all five is the same as
 * comparing "the one that matters" while still telling apart two malformed
 * rows that differ only in a leftover column.
 */
const grantKey = (g: {
  userId: string; scopeLevel: string;
  zoneId?: string | null; cityId?: string | null; clusterId?: string | null;
  kitchenId?: string | null; propertyId?: string | null;
}) =>
  [g.userId, g.scopeLevel, g.zoneId ?? "", g.cityId ?? "", g.clusterId ?? "",
    g.kitchenId ?? "", g.propertyId ?? ""].join("|");

/**
 * Make `desired` the complete set of LIVE grants for `userIds`. Every id in
 * `desired` must be in `userIds` — the caller states the population it owns, so
 * that a user with no desired grant still gets their stale grants revoked
 * rather than silently kept.
 *
 * `opts.levels` narrows the revoke half to those scope levels, for a caller
 * that owns only one level of a user's access (seed-food-extra re-points a unit
 * lead's PROPERTY grant and has no opinion about any other level it finds).
 * Leaving it unset means "these users' grants are entirely mine".
 */
export async function syncUserScopes(
  userIds: string[],
  desired: DesiredGrant[],
  opts?: { levels?: string[] },
): Promise<ScopeSyncResult> {
  const out: ScopeSyncResult = { inserted: 0, reactivated: 0, unchanged: 0, revoked: 0 };
  if (!userIds.length) return out;

  const owned = new Set(userIds);
  for (const g of desired) {
    if (!owned.has(g.userId)) {
      throw new Error(`syncUserScopes: grant for ${g.userId} is outside the declared user set`);
    }
  }

  const existing = await db.select().from(userScopesTable).where(inArray(userScopesTable.userId, userIds));
  const byKey = new Map(existing.map((r) => [grantKey(r), r]));
  const wanted = new Set<string>();

  const toInsert: ScopeInsert[] = [];
  for (const g of desired) {
    const key = grantKey(g);
    if (wanted.has(key)) continue; // caller listed the same grant twice
    wanted.add(key);
    const row = byKey.get(key);
    if (!row) {
      toInsert.push({ id: randomUUID(), ...g });
      out.inserted++;
    } else if (row.isActive) {
      out.unchanged++;
    } else {
      await db.update(userScopesTable).set({ isActive: true }).where(eq(userScopesTable.id, row.id));
      out.reactivated++;
    }
  }
  if (toInsert.length) await db.insert(userScopesTable).values(toInsert);

  const revokeLevels = opts?.levels ? new Set(opts.levels) : null;
  for (const row of existing) {
    if (!row.isActive || wanted.has(grantKey(row))) continue;
    if (revokeLevels && !revokeLevels.has(row.scopeLevel)) continue;
    // Soft revoke — never DELETE. See the header.
    await db.update(userScopesTable).set({ isActive: false }).where(eq(userScopesTable.id, row.id));
    out.revoked++;
  }
  return out;
}

/** One-line summary for seed output: "3 new, 1 restored, 18 kept, 0 revoked". */
export const describeScopeSync = (r: ScopeSyncResult) =>
  `${r.inserted} new, ${r.reactivated} restored, ${r.unchanged} kept, ${r.revoked} revoked`;
