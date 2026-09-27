/**
 * Who a role change would actually reach.
 *
 * Disabling a role is instant and silent from the holder's side: they keep the
 * membership row and simply stop getting anything from it. The screen used to
 * say "this reaches 4 people" and nothing more, which is the count you already
 * guessed — what an operator needs before clicking is WHICH people, and which
 * of them have nothing else to fall back on.
 *
 * Lives in its own file rather than in access.ts on purpose: that file is large,
 * heavily edited, and this is a self-contained read.
 */
import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, usersTable, userRolesTable, rolesTable } from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError, primaryRoleOf } from "../lib/authz.js";

const router: IRouter = Router();

export interface RoleHolderImpact {
  id: string;
  name: string;
  email: string;
  /** The person's own account state — a deactivated holder is not a live risk. */
  isActive: boolean;
  /**
   * True when this role is the one the system resolves as their primary — the
   * highest-ranked of everything they hold. That is the role their account
   * reads as everywhere a single role is still shown.
   */
  isPrimary: boolean;
  /** Every OTHER live role they hold; what they would be left with. */
  otherRoles: string[];
  /** Nothing else to fall back on: disabling this leaves them with no capability. */
  losesEverything: boolean;
}

/**
 * GET /access/roles/:key/impact
 *
 * Live holders only. A revoked membership already grants nothing, so listing it
 * would inflate every number on the confirmation and train people to ignore it.
 */
router.get("/roles/:key/impact", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const key = req.params["key"] as string;

  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, key));
  if (!role) throw httpError(404, "Role not found");

  const holderRows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      isActive: usersTable.isActive,
    })
    .from(userRolesTable)
    .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
    .where(and(eq(userRolesTable.roleKey, key), eq(userRolesTable.isActive, true)));

  // Everything those people hold, in one query rather than one per person.
  const ids = holderRows.map((h) => h.id);
  const allRoles = ids.length
    ? await db
        .select({ userId: userRolesTable.userId, roleKey: userRolesTable.roleKey })
        .from(userRolesTable)
        .innerJoin(rolesTable, eq(rolesTable.key, userRolesTable.roleKey))
        .where(and(
          inArray(userRolesTable.userId, ids),
          eq(userRolesTable.isActive, true),
          // A role that is already disabled gives nothing, so it is not a
          // fallback — counting it would under-report who gets stranded.
          eq(rolesTable.isActive, true),
        ))
    : [];

  const byUser = new Map<string, string[]>();
  for (const r of allRoles) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.roleKey]);

  const holders: RoleHolderImpact[] = holderRows
    .map((h) => {
      const held = byUser.get(h.id) ?? [key];
      const otherRoles = held.filter((r) => r !== key).sort();
      return {
        id: h.id,
        name: h.name,
        email: h.email,
        isActive: h.isActive,
        isPrimary: primaryRoleOf(held) === key,
        otherRoles,
        losesEverything: otherRoles.length === 0,
      };
    })
    .sort((a, b) => {
      // The people the decision is actually about, first: those left with
      // nothing, then those for whom this is the primary role.
      if (a.losesEverything !== b.losesEverything) return a.losesEverything ? -1 : 1;
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  res.json({
    success: true,
    data: {
      roleKey: key,
      label: role.label,
      isActive: role.isActive,
      isSystem: role.isSystem,
      counts: {
        holders: holders.length,
        primary: holders.filter((h) => h.isPrimary).length,
        losesEverything: holders.filter((h) => h.losesEverything).length,
        activeHolders: holders.filter((h) => h.isActive).length,
      },
      holders,
    },
  });
});

export { router as roleImpactRouter };
export default router;
