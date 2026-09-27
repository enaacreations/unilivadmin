import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable, announcementsTable, userRolesTable, privilegesTable, rolesTable, accessGrantsTable, orgNodesTable } from "@workspace/db";
import { eq, sql, ilike, and, inArray, isNull, gt, or, lte } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, assertCanAssignRole, ROLE_RANK, isSuperAdmin, scopedPropertyIds, assertPropertyAccess, badRequest, forbidden, httpError } from "../lib/authz.js";
import { pinWriteProperty } from "../lib/scoped-query.js";
import { readRoles, rolesFor, invalidateRoles } from "../lib/access/roles.js";
import { invalidatePrivileges } from "../lib/access/privileges.js";
import { assertPrivilegeIsSafe } from "../lib/access/privilege-guards.js";
import { assertNoCrossRoleConflict } from "../lib/access/sod.js";
import { matrixCan } from "../lib/access/matrix.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { writeAuditLog } from "../lib/wallet-service.js";

function sanitizeUser(u: typeof usersTable.$inferSelect) {
  const { passwordHash: _, ...rest } = u;
  return rest;
}

/** Render a thrown HttpError (e.g. forbidden() from assertCanAssignRole) with its
 *  real status instead of letting the local catch mask it as a 500. */
function sendAuthzError(err: unknown, res: import("express").Response): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") {
    const message = (err as { message?: string }).message || "Forbidden";
    res.status(status).json({ success: false, error: message });
    return true;
  }
  return false;
}

/** Only these columns may be set from a request body. Never accept auth-state
 *  fields (currentSessionId, isActive's bypasses, failedLoginAttempts, lockedUntil,
 *  passwordHash, lastLogin, …) — that would be a mass-assignment privilege escalation.
 *  role/isActive are legitimately editable here (USERS module). */
const WRITABLE_USER_FIELDS = [
  "name", "email", "username", "designation", "phone", "role", "propertyId", "isActive",
  // UAM additions. `role` stays writable for now as the legacy primary; the
  // roles endpoints below are the real assignment surface.
  "userType", "dob", "gender",
] as const;

export const usersRouter = Router();
/**
 * WHERE a set of roles applies, for one person — validated, then written.
 *
 * A role never names a place: "Cluster Manager" is one role and which cluster
 * is a fact about the holder. So the node arrives with the assignment and is
 * stored on the GRANT, keyed by the role it was given for. The grant holds the
 * ANCHOR alone — everything beneath resolves through the closure at read time,
 * which is what makes a property added to that cluster next month appear
 * without re-tagging anybody.
 *
 * Split in two on purpose. Creating an account inserts the person, their role
 * memberships and their places in that order, so a place rejected at the end
 * would leave a half-made account behind — someone who exists, holds a role,
 * and reaches nothing. `planRolePlaces` does every check that can fail and
 * touches nothing; the caller runs it BEFORE the first insert.
 */
interface RolePlacePlan {
  roleKey: string;
  nodeIds: string[];
}

async function planRolePlaces(roleKeys: string[], raw: unknown): Promise<RolePlacePlan[]> {
  if (!raw || typeof raw !== "object") return [];
  const byRole = raw as Record<string, unknown>;
  const plan: RolePlacePlan[] = [];

  for (const roleKey of roleKeys) {
    const list = byRole[roleKey];
    if (!Array.isArray(list)) continue;
    const nodeIds = [...new Set(list.map((n) => String(n)))].filter(Boolean);
    if (!nodeIds.length) continue;

    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, roleKey));
    if (!role) throw badRequest(`Unknown role ${roleKey}`, { code: "UNKNOWN_ROLE" });

    const nodes = await db
      .select({ id: orgNodesTable.id, nodeType: orgNodesTable.nodeType, name: orgNodesTable.name })
      .from(orgNodesTable)
      .where(inArray(orgNodesTable.id, nodeIds));
    if (nodes.length !== nodeIds.length) throw badRequest("Unknown place", { code: "UNKNOWN_NODE" });

    // The anchor level is the role's contract. Accepting a property for a role
    // handed out at cluster level would quietly create a second meaning for the
    // same role, which is the thing anchorLevel exists to prevent.
    if (role.anchorLevel) {
      const wrong = nodes.find((n) => n.nodeType !== role.anchorLevel);
      if (wrong) {
        throw httpError(
          422,
          `${role.label} is given a ${role.anchorLevel.toLowerCase()}, but ${wrong.name} is a ${wrong.nodeType.toLowerCase()}`,
          { code: "WRONG_ANCHOR_LEVEL" },
        );
      }
    }

    plan.push({ roleKey, nodeIds });
  }
  return plan;
}

/**
 * Apply a validated plan. Replaces each named role's places rather than adding
 * to them, so the plan is the whole truth for every role in it; roles absent
 * from it keep whatever they had.
 */
async function applyRolePlaces(userId: string, plan: RolePlacePlan[], actorId: string): Promise<void> {
  for (const { roleKey, nodeIds } of plan) {
    await db.transaction(async (tx) => {
      await tx.delete(accessGrantsTable).where(and(
        eq(accessGrantsTable.subjectType, "USER"),
        eq(accessGrantsTable.subjectId, userId),
        eq(accessGrantsTable.roleKey, roleKey),
      ));
      for (const nodeId of nodeIds) {
        await tx.insert(accessGrantsTable).values({
          id: newId(), subjectType: "USER", subjectId: userId, roleKey,
          nodeId, includeDescendants: true, followLinks: false,
          dataScope: "ALL", qualifiers: [], assignmentKind: "GRANT", grantedBy: actorId,
        });
      }
    });
  }
}

usersRouter.get("/", authenticate, authorize("USERS", "view_user"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const role = req.query["role"] as string | undefined;
    const conditions = [];
    if (role) conditions.push(eq(usersTable.role, role as typeof usersTable.$inferSelect.role));
    if (search) conditions.push(ilike(usersTable.name, `%${search}%`));
    // A property-bound caller administers only their own property's users.
    // Without this, USERS:view listed every account in the company — including
    // the org-wide roles, whose existence and email are themselves a target.
    // Org-wide callers are unaffected (scopedPropertyIds returns null for them).
    const userScope = await scopedPropertyIds(req);
    if (userScope) conditions.push(inArray(usersTable.propertyId, userScope));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(where);
    const rows = await db.select().from(usersTable).where(where).limit(limit).offset(offset).orderBy(usersTable.createdAt);
    res.json({ success: true, data: rows.map(sanitizeUser), meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
usersRouter.post("/", authenticate, authorize("USERS", "add_user"), async (req, res) => {
  try {
    const fields = pick(req.body, WRITABLE_USER_FIELDS);
    if (fields.dob) fields.dob = new Date(String(fields.dob));
    if (fields.role) assertCanAssignRole(req.user!.role, fields.role);

    const roles: string[] = Array.isArray(req.body?.roles) ? req.body.roles.map(String) : [];
    // Every role is rank-checked, not just the legacy primary — otherwise the
    // roles array is a way around assertCanAssignRole.
    for (const r of roles) assertCanAssignRole(req.user!.role, r);
    // The combination, not just each half: multi-role lets a conflicting pair
    // be split across two individually-innocent roles.
    assertNoCrossRoleConflict(roles, (rk, m, perm) => matrixCan(rk, m, perm as never));
    // Keep the legacy column consistent with the set until it is dropped.
    //
    // An account can be created with no roles at all — basic details now, roles
    // and places later. `users.role` is NOT NULL, so that case needs a value
    // that grants nothing; UNASSIGNED is a disabled role, so readRoles() gives
    // an empty set and every gate refuses. The first real role assigned
    // replaces it.
    if (!fields.role) fields.role = roles.length ? roles[0] : "UNASSIGNED";

    // Pin the new account to the creator's property when they are scoped —
    // otherwise a warden could mint a user at another property (or an
    // unscoped one, which reads as org-wide to isPropertyScoped).
    const createScope = await scopedPropertyIds(req);
    pinWriteProperty(createScope, fields);
    if (!createScope && fields.propertyId) await assertPropertyAccess(req, fields.propertyId);

    // Validate the places BEFORE anything is written. A bad node or a node at
    // the wrong rung must fail the whole request, not leave behind a person who
    // exists, holds a role and reaches nothing.
    const placePlan = await planRolePlaces(roles, req.body?.roleNodes);

    // A password nobody chose is a password everybody knows. This used to
    // default silently to a literal, which meant every account created without
    // one shared the same credential.
    const supplied = typeof req.body?.password === "string" ? req.body.password.trim() : "";
    if (supplied && supplied.length < 8) {
      throw badRequest("Password must be at least 8 characters", { code: "WEAK_PASSWORD" });
    }
    const generated = supplied ? null : `${randomBytes(9).toString("base64url")}Aa1!`;
    const passwordHash = await bcrypt.hash(supplied || generated!, 12);

    const [row] = await db.insert(usersTable).values({ id: newId(), ...fields, passwordHash, updatedAt: new Date() }).returning();

    if (roles.length) {
      await db.insert(userRolesTable).values(
        roles.map((roleKey) => ({ id: newId(), userId: row.id, roleKey, assignedBy: req.user!.id })),
      ).onConflictDoNothing();
      invalidateRoles(row.id);
    }

    // WHERE each role applies, taken at creation rather than left for a second
    // trip to the person's page. A role never names a place, so an anchored
    // role handed out with no node reaches nothing — an account that looks
    // configured and is not, which is the failure this whole step exists to
    // prevent.
    await applyRolePlaces(row.id, placePlan, req.user!.id);

    // The home property, written to BOTH engines. `users.propertyId` is what
    // the legacy property-scoped helpers read; the PRIMARY grant is what the
    // resolver reads. Writing only the column left the two disagreeing, and a
    // null propertyId reads as UNRESTRICTED to isPropertyScoped().
    if (fields.propertyId) {
      await db.insert(accessGrantsTable).values({
        id: newId(), subjectType: "USER", subjectId: row.id, roleKey: "*",
        nodeId: fields.propertyId as string, includeDescendants: true, followLinks: false,
        dataScope: "ALL", qualifiers: [], assignmentKind: "PRIMARY", grantedBy: req.user!.id,
      }).onConflictDoNothing();
    }

    // "Same access as X" — the request onboarding actually makes. Copies the
    // privileges only; roles and placement are explicit above, because copying
    // those silently is how someone inherits a property nobody meant to give.
    const copyFrom = typeof req.body?.copyPrivilegesFrom === "string" ? req.body.copyPrivilegesFrom : null;
    let copied = 0;
    if (copyFrom) {
      const source = await db.select().from(privilegesTable).where(and(
        eq(privilegesTable.subjectType, "USER"),
        eq(privilegesTable.subjectId, copyFrom),
      ));
      for (const p of source) {
        await assertPrivilegeIsSafe({ id: req.user!.id, role: req.user!.role }, {
          subjectType: "USER", subjectId: row.id, functionality: p.functionality, action: p.action,
          nodeId: p.nodeId, effect: p.effect as "GRANT" | "DENY",
          reason: `Copied at onboarding from ${copyFrom}`,
        });
        await db.insert(privilegesTable).values({
          id: newId(), subjectType: "USER", subjectId: row.id,
          functionality: p.functionality, action: p.action, nodeId: p.nodeId, effect: p.effect,
          expiresAt: p.expiresAt, grantedBy: req.user!.id,
          reason: `Copied at onboarding from ${copyFrom}`,
        }).onConflictDoNothing();
        copied++;
      }
      invalidatePrivileges(row.id);
    }

    // The trail, not just the legacy audit log: an account being minted with a
    // role set and a placement is the first entry its History tab should show,
    // and every later change to it (roles, exceptions, deactivation) lands on
    // the same chain.
    recordActivity(activityCtx(req), {
      event: "USER_CREATED",
      entityId: row.id,
      entityLabel: row.email,
      propertyId: row.propertyId ?? null,
      reason: typeof req.body?.reason === "string" ? req.body.reason : `Account created by ${req.user!.email}`,
      after: { roles, propertyId: row.propertyId, userType: row.userType, copiedPrivileges: copied },
    });

    // Audit (fire-and-forget; never blocks the create).
    void writeAuditLog(req.user!.id, "USER_CREATED", "user", row.id, {
      name: row.name, email: row.email, username: row.username, role: row.role,
      roles, propertyId: row.propertyId, copiedPrivileges: copied,
    }).catch(() => {});

    res.status(201).json({
      success: true,
      // The generated password is returned ONCE, on creation, so the admin can
      // hand it over. It is never stored in plaintext and never returned again.
      data: { ...sanitizeUser(row), roles, copiedPrivileges: copied, ...(generated ? { generatedPassword: generated } : {}) },
    });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

usersRouter.put("/:id", authenticate, authorize("USERS", "edit_user"), async (req, res) => {
  try {
    const fields = pick(req.body, WRITABLE_USER_FIELDS);
    const callerRole = req.user!.role;
    const isSelf = req.params["id"] === req.user!.id;
    // Load the target so a non-SUPER_ADMIN can't edit a user who out-ranks them.
    // Editing self or an equal-tier peer is allowed (HR_MANAGER manages peers and
    // its own profile); only editing a STRICTLY higher-ranked user is blocked.
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, req.params["id"]!));
    if (!target) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Editing rights on a user you can see must not become rights over one you
    // cannot: refuse a target outside scope, and refuse moving one out of it.
    const editScope = await scopedPropertyIds(req);
    if (editScope && (!target.propertyId || !editScope.includes(target.propertyId)) && !isSelf) {
      res.status(404).json({ success: false, error: "Not found" }); return;
    }
    if (fields.propertyId !== undefined && fields.propertyId !== target.propertyId) {
      await assertPropertyAccess(req, fields.propertyId);
    }

    // PRD §29 names both of these explicitly, and both demand a reason: a role
    // change and a property reassignment are the two edits that silently
    // redefine what someone can reach.
    const reason = (req.body?.reason as string | undefined) ?? null;
    if (fields.role !== undefined && fields.role !== target.role) {
      recordActivity(activityCtx(req), {
        event: "ROLE_CHANGED", entityId: target.id, entityLabel: target.email,
        fromState: target.role, toState: fields.role as string,
        before: { role: target.role }, after: { role: fields.role },
        reason: reason ?? `Role changed by ${req.user!.email}`,
      });
    }
    if (fields.propertyId !== undefined && fields.propertyId !== target.propertyId) {
      recordActivity(activityCtx(req), {
        event: "PROPERTY_ASSIGNMENT_CHANGED", entityId: target.id, entityLabel: target.email,
        propertyId: (fields.propertyId as string | null) ?? null,
        before: { propertyId: target.propertyId }, after: { propertyId: fields.propertyId },
        reason: reason ?? `Property reassigned by ${req.user!.email}`,
      });
    }
    if (!isSuperAdmin(callerRole) && !isSelf) {
      const callerRank = ROLE_RANK[callerRole] ?? 0;
      const targetRank = ROLE_RANK[target.role] ?? 0;
      if (targetRank > callerRank) { res.status(403).json({ success: false, error: "Cannot edit a user above your privilege level" }); return; }
    }
    // If the body changes the role, the new role must be one the caller may grant.
    if (fields.role) assertCanAssignRole(callerRole, fields.role);
    const roleChanged = fields.role !== undefined && fields.role !== target.role;
    const wasActive = target.isActive;
    const [row] = await db.update(usersTable).set({ ...fields, updatedAt: new Date() }).where(eq(usersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Turning an account back on is exactly as consequential as turning it off,
    // and DELETE already trails the off direction. Without this the trail shows
    // access being taken away and never shows it coming back.
    if (fields.isActive !== undefined && fields.isActive !== wasActive) {
      recordActivity(activityCtx(req), {
        event: "USER_UPDATED", entityId: row.id, entityLabel: row.email,
        before: { isActive: wasActive }, after: { isActive: row.isActive },
        reason: reason ?? `${row.isActive ? "Reactivated" : "Deactivated"} by ${req.user!.email}`,
      });
    }
    // Identity edits land on the trail too. `email` IS the sign-in credential,
    // so "who changed it to that, and when" is a security question — and the
    // legacy audit log alone is not what anyone reads on a person's History.
    const IDENTITY = ["name", "email", "username", "designation", "phone", "userType", "dob", "gender"] as const;
    const changedIdentity = IDENTITY.filter(
      (k) => fields[k] !== undefined && String(fields[k] ?? "") !== String((target as Record<string, unknown>)[k] ?? ""),
    );
    if (changedIdentity.length) {
      recordActivity(activityCtx(req), {
        event: "USER_UPDATED",
        entityId: row.id,
        entityLabel: row.email,
        reason: reason ?? `Details edited by ${req.user!.email}`,
        before: Object.fromEntries(changedIdentity.map((k) => [k, (target as Record<string, unknown>)[k] ?? null])),
        after: Object.fromEntries(changedIdentity.map((k) => [k, (row as Record<string, unknown>)[k] ?? null])),
      });
    }

    // Audit (fire-and-forget). A role change is logged distinctly (ROLE_CHANGED)
    // for compliance; a deactivation (isActive true→false) is logged as a
    // dedicated USER_DEACTIVATED event in addition to the generic update.
    void writeAuditLog(req.user!.id, roleChanged ? "ROLE_CHANGED" : "USER_UPDATED", "user", row.id, {
      changed: Object.keys(fields),
      ...(roleChanged ? { oldRole: target.role, newRole: row.role } : {}),
    }).catch(() => {});
    if (fields.isActive === false && wasActive) {
      void writeAuditLog(req.user!.id, "USER_DEACTIVATED", "user", row.id, { oldStatus: "active", newStatus: "inactive" }).catch(() => {});
    }
    res.json({ success: true, data: sanitizeUser(row) });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
/**
 * GET /users/:id — the detail view.
 *
 * Returns the person plus the two things every UAM screen needs beside them:
 * the roles they hold and the privileges written against them. There was no
 * detail endpoint at all before, which is why the old screen could only ever be
 * a table with a dialog.
 */
usersRouter.get("/:id", authenticate, authorize("USERS", "view_user"), async (req, res) => {
  try {
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // A property-bound caller gets the same 404 as for a nonexistent user, so
    // probing ids across properties tells them nothing.
    const scope = await scopedPropertyIds(req);
    if (scope && (!row.propertyId || !scope.includes(row.propertyId)) && row.id !== req.user!.id) {
      res.status(404).json({ success: false, error: "Not found" }); return;
    }

    const now = new Date();
    const roleRows = await db
      .select({
        roleKey: userRolesTable.roleKey,
        label: rolesTable.label,
        isActive: rolesTable.isActive,
        assignedAt: userRolesTable.assignedAt,
        expiresAt: userRolesTable.expiresAt,
        held: userRolesTable.isActive,
        revokedAt: userRolesTable.revokedAt,
        revokedReason: userRolesTable.revokedReason,
      })
      .from(userRolesTable)
      .leftJoin(rolesTable, eq(rolesTable.key, userRolesTable.roleKey))
      .where(eq(userRolesTable.userId, row.id));

    const privileges = await db
      .select()
      .from(privilegesTable)
      .where(and(eq(privilegesTable.subjectType, "USER"), eq(privilegesTable.subjectId, row.id)));

    res.json({
      success: true,
      data: {
        ...sanitizeUser(row),
        roles: roleRows.map((r) => ({
          ...r,
          // `live` is what the resolver would say: the membership must be on
          // AND the role itself enabled AND inside its window.
          live: r.held && (!r.expiresAt || r.expiresAt > now) && r.isActive !== false,
        })),
        privileges,
      },
    });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * POST /users/:id/roles — assign a role.
 *
 * The real assignment surface now that a user holds a set. Rank-guarded per
 * role, because the set is exactly as escalation-prone as the single column was.
 */
usersRouter.post("/:id/roles", authenticate, authorize("USERS", "edit_user"), async (req, res) => {
  try {
    const userId = req.params["id"]!;
    const roleKey = String(req.body?.roleKey ?? "");
    if (!roleKey) throw badRequest("roleKey is required");
    if (userId === req.user!.id) {
      throw forbidden("You cannot change your own roles");
    }

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!target) { res.status(404).json({ success: false, error: "Not found" }); return; }

    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, roleKey));
    if (!role) throw httpError(404, "Role not found", { code: "UNKNOWN_ROLE" });
    if (!role.isActive) throw httpError(422, "That role is disabled", { code: "ROLE_DISABLED" });

    // You may not hand out a role above your own tier, nor edit someone above it.
    assertCanAssignRole(req.user!.role, roleKey);
    assertCanAssignRole(req.user!.role, target.role);

    const expiresAt = req.body?.expiresAt ? new Date(String(req.body.expiresAt)) : null;
    if (expiresAt && expiresAt < new Date()) {
      throw badRequest("That assignment would already be expired", { code: "WINDOW_IN_PAST" });
    }

    // The set this assignment would PRODUCE, checked before it exists.
    const resulting = [...new Set([...(await readRoles(userId)), roleKey])];
    assertNoCrossRoleConflict(resulting, (rk, m, perm) => matrixCan(rk, m, perm as never));

    // A revoked membership is still a row, so onConflictDoNothing would have
    // silently refused to re-grant a role someone used to hold. The conflict
    // IS the re-grant: flip it live and clear the revocation.
    await db.insert(userRolesTable).values({
      id: newId(), userId, roleKey, assignedBy: req.user!.id, expiresAt,
    }).onConflictDoUpdate({
      target: [userRolesTable.userId, userRolesTable.roleKey],
      set: {
        isActive: true, revokedAt: null, revokedBy: null, revokedReason: null,
        assignedBy: req.user!.id, assignedAt: new Date(), expiresAt,
      },
    });
    invalidateRoles(userId);

    // WHERE this role applies, asked for at the moment it is handed out.
    //
    // A role never names a place, so the place arrives with the assignment: a
    // Cluster Manager is given a cluster, a Unit Lead one or more properties.
    // The grant stores that anchor and nothing beneath it — everything under it
    // resolves through the closure at read time, which is what makes a property
    // added to the cluster next month appear without re-tagging anyone.
    const rawNodeIds: unknown[] = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : [];
    const nodeIds: string[] = [...new Set(rawNodeIds.map((n) => String(n)))].filter(Boolean);
    await applyRolePlaces(userId, await planRolePlaces([roleKey], { [roleKey]: nodeIds }), req.user!.id);

    // Promote the legacy primary off the placeholder. An account created with
    // basic details only carries UNASSIGNED; the first real role is what it
    // was waiting for, and leaving it behind would keep the person reading as
    // "Unassigned" on every screen that still shows a single role.
    // Cast: UNASSIGNED is a DB-level placeholder that is deliberately absent
    // from the code-owned UserRole manifest — being outside it is exactly
    // what makes it grant nothing.
    if ((target.role as string) === "UNASSIGNED") {
      await db.update(usersTable).set({ role: roleKey as never, updatedAt: new Date() }).where(eq(usersTable.id, userId));
    }

    const roles = await readRoles(userId);
    recordActivity(activityCtx(req), {
      event: "ROLE_CHANGED",
      entityId: userId,
      entityLabel: target.email,
      reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
      after: { added: roleKey, roles, nodeIds },
    });
    res.status(201).json({ success: true, data: { roles, nodeIds } });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * DELETE /users/:id/roles/:roleKey — revoke a role, keeping the row.
 *
 * A hard delete erased the fact that someone ever held it, and "did she have
 * Warden in March?" is exactly the question asked after an incident. The row
 * survives carrying who revoked it, when, and why.
 *
 * The reason is REQUIRED here. Taking access away is the change most likely to
 * be questioned later, and an unexplained revocation is indistinguishable from
 * a mistake.
 *
 * Refuses to remove the last live one: a user with no roles resolves to no
 * capability at all, which looks like a broken account rather than a decision.
 * Deactivate the person instead.
 */
usersRouter.delete("/:id/roles/:roleKey", authenticate, authorize("USERS", "edit_user"), async (req, res) => {
  try {
    const userId = req.params["id"]!;
    const roleKey = req.params["roleKey"]!;
    if (userId === req.user!.id) throw forbidden("You cannot change your own roles");

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!target) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertCanAssignRole(req.user!.role, target.role);
    assertCanAssignRole(req.user!.role, roleKey);

    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 4) {
      throw badRequest("Say why this role is being taken away", { code: "REASON_REQUIRED" });
    }

    const current = await readRoles(userId);
    if (current.length <= 1 && current.includes(roleKey)) {
      throw httpError(409, "That is this user's only role — deactivate the user instead", {
        code: "LAST_ROLE",
      });
    }

    await db.update(userRolesTable).set({
      isActive: false,
      revokedAt: new Date(),
      revokedBy: req.user!.id,
      revokedReason: reason,
    }).where(and(
      eq(userRolesTable.userId, userId),
      eq(userRolesTable.roleKey, roleKey),
    ));
    invalidateRoles(userId);

    // The placement was granted FOR this role, so it dies with it. Leaving the
    // grant behind would keep the person inside a cluster's data with no role
    // explaining why — an orphan nobody would think to look for. '*' grants are
    // untouched: those are the person's own placement, not this role's.
    await db.delete(accessGrantsTable).where(and(
      eq(accessGrantsTable.subjectType, "USER"),
      eq(accessGrantsTable.subjectId, userId),
      eq(accessGrantsTable.roleKey, roleKey),
    ));

    const roles = await readRoles(userId);
    // Keep the legacy primary pointing at a role the user still holds.
    if (target.role === roleKey && roles.length) {
      await db.update(usersTable).set({ role: roles[0] as never, updatedAt: new Date() }).where(eq(usersTable.id, userId));
    }

    recordActivity(activityCtx(req), {
      event: "ROLE_CHANGED",
      entityId: userId,
      entityLabel: target.email,
      reason,
      after: { removed: roleKey, roles },
    });
    res.json({ success: true, data: { roles } });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/**
 * DELETE /users/:id — DEACTIVATE, not destroy.
 *
 * This used to be a hard delete with no rank check and no scope check — the
 * weakest endpoint in the file. Residents, audits, orders and wallet rows all
 * reference users, so the row must survive; and "remove this person's access"
 * is what the caller actually means. Reversible, and the trail keeps the why.
 */
usersRouter.delete("/:id", authenticate, authorize("USERS", "delete_user"), async (req, res) => {
  try {
    const targetId = req.params["id"]!;
    if (targetId === req.user!.id) throw forbidden("You cannot deactivate your own account");

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // Required, not optional. Turning an account off is the change most likely
    // to be questioned later, and the form is not the only way in here.
    const why = String(req.body?.reason ?? "").trim();
    if (why.length < 4) {
      throw badRequest("Say why this account is being deactivated", { code: "REASON_REQUIRED" });
    }

    // The guards the hard delete never had.
    const scope = await scopedPropertyIds(req);
    if (scope && (!target.propertyId || !scope.includes(target.propertyId))) {
      res.status(404).json({ success: false, error: "Not found" }); return;
    }
    assertCanAssignRole(req.user!.role, target.role);

    const [row] = await db
      .update(usersTable)
      .set({ isActive: false, currentSessionId: null, updatedAt: new Date() })
      .where(eq(usersTable.id, targetId))
      .returning();
    invalidateRoles(targetId);
    invalidatePrivileges(targetId);

    recordActivity(activityCtx(req), {
      event: "USER_UPDATED",
      entityId: targetId,
      entityLabel: target.email,
      reason: why,
      before: { isActive: true },
      after: { isActive: false },
    });
    void writeAuditLog(req.user!.id, "USER_DEACTIVATED", "user", targetId, {
      name: target.name, email: target.email, role: target.role,
    }).catch(() => {});

    res.json({ success: true, data: sanitizeUser(row!), message: "User deactivated" });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export const announcementsRouter = Router();
announcementsRouter.get("/", authenticate, authorize("COMMUNICATIONS", "view_communication"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(announcementsTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(announcementsTable).where(where);
    const rows = await db.select().from(announcementsTable).where(where).limit(limit).offset(offset).orderBy(announcementsTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
announcementsRouter.post("/", authenticate, authorize("COMMUNICATIONS", "add_communication"), async (req, res) => {
  try {
    const b = req.body ?? {};
    const [row] = await db.insert(announcementsTable).values({
      id: newId(),
      title: b.title,
      content: b.content,
      propertyId: b.propertyId ?? null,
      targetRoles: Array.isArray(b.targetRoles) ? b.targetRoles : [],
      createdBy: req.user!.id, // server-controlled — never from the body
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
announcementsRouter.delete("/:id", authenticate, authorize("COMMUNICATIONS", "delete_communication"), async (req, res) => {
  try {
    await db.delete(announcementsTable).where(eq(announcementsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
