/**
 * Access-control introspection (Access Controls PRD §31).
 *
 * "View Access As User" is the admin tool the PRD asks for by name, and its
 * stated purpose is resolving access issues WITHOUT engineering. That only holds
 * if it reports what enforcement actually does, so every answer here comes from
 * the same decide() the authorize() middleware calls. There is no second
 * implementation to drift.
 *
 * It is READ-ONLY and never impersonates: no token is minted, no session is
 * switched, nothing is written on the subject's behalf.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db, usersTable, orgNodesTable, accessGrantsTable, rolesTable,
  roleFunctionalitiesTable, privilegesTable, userRolesTable,
} from "@workspace/db";
import { and, inArray, isNull, or, sql, lte, gt } from "drizzle-orm";
import { newId } from "../lib/id.js";
import {
  matrixVersion, matrixSource, bumpMatrixVersion, cellsForRole, isManifestCell, SYSTEM_ROLES, matrixCan,
} from "../lib/access/matrix.js";
import { assertNoCrossRoleConflict } from "../lib/access/sod.js";
import { assertMatrixChangeAllowed, assertAccessControlReachable, PROTECTED_FUNCTIONALITIES, type CellChange } from "../lib/access/matrix-guards.js";
import { assertGrantIsSafe } from "../lib/access/grant-guards.js";
import { assertPrivilegeIsSafe } from "../lib/access/privilege-guards.js";
import { invalidatePrivileges, invalidateAllPrivileges } from "../lib/access/privileges.js";
import { readRoles, invalidateRoles as invalidateAllRoles } from "../lib/access/roles.js";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";
import {
  httpError,
  forbidden,
  ROLE_RANK,
  isSuperAdmin,
  assertCanAssignRole,
  sendAuthzError,
} from "../lib/authz.js";
import { resolveAccess } from "../lib/access.js";
import { storeApproval, approvalUrl, type ApprovalFile } from "../lib/approval-file.js";
import { decide, decideModule } from "../lib/access/decide.js";
import {
  can,
  canAny,
  ALL_MODULES,
  ALL_FUNCTIONALITIES,
  actionDef,
  namedActionsFor,
  permissionName,
  functionalitiesOf,
  moduleOf,
  moduleLabel,
  functionalityLabel,
  MODULE_DESCRIPTION,
  type Module,
  type Functionality,
  type NamedAction,
} from "../lib/permissions.js";
import { descendantIdsOfType } from "../lib/org-tree.js";

const router: IRouter = Router();

/**
 * The static vocabulary: the whole three-level tree, in display order.
 *
 * Served as a TREE rather than a flat list plus a grouping key. The editor
 * renders modules and drills into functionalities, so handing it the shape it
 * displays removes the client-side regrouping step that used to be the only
 * place the hierarchy existed.
 *
 * `functionalities` is also flattened alongside it: a few screens (the privilege
 * picker, the preview filter) legitimately want one list, and deriving it
 * client-side twice is how the two fall out of order.
 */
router.get("/manifest", authenticate, authorize("ACCESS_CONTROL", "view_access"), (_req, res) => {
  const functionality = (f: Functionality) => ({
    key: f,
    // The UI leads with the label and keeps the key as mono subtext — 56
    // SCREAMING_SNAKE keys as primary labels is what made this unreadable.
    label: functionalityLabel(f),
    module: moduleOf(f),
    /**
     * The actions THIS functionality defines, each with the one line the UI puts
     * in front of whoever is granting it. Not a shared verb list: "Record
     * answers" and "Add property" are different permissions, and a reader cannot
     * tell what a tick under "Update" would allow.
     */
    actions: namedActionsFor(f).map((a) => ({
      key: a.key,
      label: a.label,
      description: a.description,
      id: permissionName(f, a.key),
    })),
    protected: PROTECTED_FUNCTIONALITIES.has(f),
  });

  res.json({
    success: true,
    data: {
      modules: ALL_MODULES.map((m) => ({
        key: m,
        label: moduleLabel(m),
        description: MODULE_DESCRIPTION[m],
        functionalities: functionalitiesOf(m).map(functionality),
      })),
      functionalities: ALL_FUNCTIONALITIES.map(functionality),
    },
  });
});

/**
 * GET /access/preview/:userId
 *
 * Renders the subject's ENTIRE resolved surface, denials included with a reason.
 * PRD §31's mock shows "Approve ✗" as a row and "Payroll → No Access ✗" as a
 * line, so an omitted entry is not an acceptable rendering of a denial: an admin
 * needs to see that a thing was considered and refused, and why.
 *
 * `?nodeId=` re-runs the whole matrix against one node, which answers the single
 * most common support question — "they can approve at Property A but not B".
 */
router.get("/preview/:userId", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  try {
    const targetId = req.params["userId"]!;
    const nodeId = (req.query["nodeId"] as string | undefined) ?? null;

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) throw httpError(404, "User not found");

    // Do not let a mid-tier admin enumerate a more privileged user's surface.
    const callerRole = req.user!.role;
    if (!isSuperAdmin(callerRole)) {
      const callerRank = ROLE_RANK[callerRole] ?? 0;
      const targetRank = ROLE_RANK[target.role] ?? 0;
      if (targetRank > callerRank) {
        throw forbidden("You cannot preview a user more privileged than yourself");
      }
    }

    const access = await resolveAccess({
      id: target.id,
      email: target.email,
      role: target.role,
      propertyId: target.propertyId,
      roleKey: target.role,
    } as never);

    const nodes = access.nodeIds === null
      ? null
      : await db
          .select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
          .from(orgNodesTable)
          .where(eq(orgNodesTable.isActive, true));

    /**
     * The resolved surface, as the tree. A module row carries `noAccess` so the
     * UI can collapse a wholly-denied module to one line (as the PRD mock does)
     * without walking its children, and `held` so it can say "4 of 8" — but
     * both are FOLDS over the per-functionality decisions below them, computed
     * by decideModule(), never resolved separately. A preview that decided the
     * module level on its own would be a second resolution path, which is the
     * drift the single decision function exists to prevent.
     */
    const modules = ALL_MODULES.map((module: Module) => {
      const roll = decideModule(access, { module, nodeId });
      const functionalities = functionalitiesOf(module).map((f) => {
        const actions = namedActionsFor(f).map(({ key: action, label, description }) => {
          const d = decide(access, { functionality: f, action, nodeId });
          // The label and the one-liner travel WITH the decision: the preview is
          // read to answer "why can they not do X", and an unlabelled key makes
          // the reader translate before they can answer.
          return {
            action, label, description, id: permissionName(f, action),
            allow: d.allow, reason: d.reason, detail: d.detail, via: d.via ?? null,
          };
        });
        return {
          key: f,
          label: functionalityLabel(f),
          noAccess: actions.every((a) => !a.allow),
          actions,
        };
      });
      return {
        key: module,
        label: moduleLabel(module),
        noAccess: functionalities.every((f) => f.noAccess),
        heldCount: roll.held.length,
        totalCount: functionalities.length,
        functionalities,
      };
    });

    // Reading another user's effective access is itself an access-control event:

    // it enumerates the org tree and their grants. Recorded on the chained

    // ACCESS stream so "who looked at whose permissions" stays answerable.

    recordActivity(activityCtx(req), {

      event: "ACCESS_PREVIEWED",

      entityId: target.id,

      entityLabel: target.email,

      // nodeId is resolved to a name by the trail reader (lib/activity/labels).
      // A null node means the preview was run without pinning one, which is a
      // statement, not a missing value — say it rather than rendering a dash.
      after: { previewedRole: target.role, atNode: nodeId ?? "Entire organization" },

    });

    res.json({
      success: true,
      data: {
        subject: {
          id: target.id,
          name: target.name,
          email: target.email,
          role: target.role,
          roleKey: target.role,
          isActive: target.isActive,
        },
        evaluatedAt: new Date().toISOString(),
        evaluatedAtNode: nodeId,
        scope: {
          unrestricted: access.nodeIds === null,
          nodeIds: access.nodeIds,
          propertyIds: access.propertyIds,
          kitchenIds: access.kitchenIds,
          dataScope: access.dataScope,
        },
        grants: access.grants,
        nodes: nodes
          ? nodes.filter((n) => access.nodeIds?.includes(n.id)).map((n) => ({ id: n.id, name: n.name, level: n.nodeType }))
          : null,
        modules,
      },
    });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * Users for the preview picker.
 *
 * Deliberately served from here rather than reusing /api/users: that endpoint is
 * gated on the USERS module, and the Access Control page should need exactly one
 * permission to be useful. Returns the minimum a picker needs — no phone, no
 * session state, nothing that widens the surface.
 */
router.get("/users", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        propertyId: usersTable.propertyId,
        isActive: usersTable.isActive,
      })
      .from(usersTable)
      .orderBy(usersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** Live grants, optionally for one subject, with their node resolved for display. */
router.get("/grants", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  try {
    const subjectId = req.query["subjectId"] as string | undefined;
    const rows = await db
      .select({
        id: accessGrantsTable.id,
        subjectType: accessGrantsTable.subjectType,
        subjectId: accessGrantsTable.subjectId,
        roleKey: accessGrantsTable.roleKey,
        nodeId: accessGrantsTable.nodeId,
        includeDescendants: accessGrantsTable.includeDescendants,
        followLinks: accessGrantsTable.followLinks,
        dataScope: accessGrantsTable.dataScope,
        qualifiers: accessGrantsTable.qualifiers,
        assignmentKind: accessGrantsTable.assignmentKind,
        effectiveFrom: accessGrantsTable.effectiveFrom,
        expiresAt: accessGrantsTable.expiresAt,
        revokedAt: accessGrantsTable.revokedAt,
        nodeName: orgNodesTable.name,
        nodeType: orgNodesTable.nodeType,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(accessGrantsTable)
      .leftJoin(orgNodesTable, eq(accessGrantsTable.nodeId, orgNodesTable.id))
      .leftJoin(usersTable, eq(accessGrantsTable.subjectId, usersTable.id))
      .where(subjectId ? eq(accessGrantsTable.subjectId, subjectId) : undefined)
      .limit(500);
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** The org tree, for grant/scope pickers. */
router.get("/nodes", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  try {
    const rows = await db
      .select({
        id: orgNodesTable.id,
        nodeType: orgNodesTable.nodeType,
        parentId: orgNodesTable.parentId,
        name: orgNodesTable.name,
        depth: orgNodesTable.depth,
        isActive: orgNodesTable.isActive,
      })
      .from(orgNodesTable);
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export { router as accessRouter };
export default router;

/* ── Matrix editor (PRD §22/§25/§30) ───────────────────────────────────────── */

/** Roles, with whether their cells are computed. */
router.get("/roles", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (_req, res) => {
  const rows = await db.select().from(rolesTable).orderBy(rolesTable.label);

  // How many live people hold each role. Without it an admin cannot tell a
  // theoretical change from one that moves twelve wardens tomorrow morning.
  //
  // Counted from user_roles, not users.role: a user holds a SET now, and the
  // legacy column only names one of them. Counting it made a role look empty
  // whenever everyone holding it held it as their second role — the opposite
  // of the reassurance this number exists to give.
  const counts = await db
    .select({ role: userRolesTable.roleKey, n: sql<number>`count(*)::int` })
    .from(userRolesTable)
    .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
    .where(and(eq(usersTable.isActive, true), eq(userRolesTable.isActive, true)))
    .groupBy(userRolesTable.roleKey);
  const byRole = new Map(counts.map((c) => [c.role as string, c.n]));

  const cellCounts = await db
    .select({ roleKey: roleFunctionalitiesTable.roleKey, n: sql<number>`count(*)::int` })
    .from(roleFunctionalitiesTable)
    .where(eq(roleFunctionalitiesTable.allowed, true))
    .groupBy(roleFunctionalitiesTable.roleKey);
  const byCells = new Map(cellCounts.map((c) => [c.roleKey, c.n]));

  res.json({
    success: true,
    data: rows.map((r) => ({
      ...r,
      computed: r.key in SYSTEM_ROLES,
      holders: byRole.get(r.key) ?? 0,
      cells: r.key in SYSTEM_ROLES ? null : (byCells.get(r.key) ?? 0),
    })),
  });
});

/**
 * The matrix, optionally for one role.
 *
 * Returns the CEILING alongside the cells: the editor needs to know which cells
 * could exist (so it can render an empty checkbox) as distinct from which are
 * held, and which it must not offer at all.
 */
router.get("/matrix", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const roleKey = req.query["roleKey"] as string | undefined;

  const modules = ALL_MODULES.map((m) => ({
    key: m,
    label: moduleLabel(m),
    functionalities: functionalitiesOf(m).map((f) => ({
      key: f,
      label: functionalityLabel(f),
      actions: namedActionsFor(f).map((a) => ({
        key: a.key, label: a.label, description: a.description, id: permissionName(f, a.key),
      })),
      protected: PROTECTED_FUNCTIONALITIES.has(f),
    })),
  }));

  const roles = roleKey ? [roleKey] : (await db.select({ key: rolesTable.key }).from(rolesTable)).map((r) => r.key);
  // A cell is (role, functionality, action). The module is derivable from the
  // functionality, so sending it would be a second copy of the tree the client
  // already has from `modules` above.
  const cells: Array<{ roleKey: string; functionality: string; action: string; computed: boolean }> = [];
  for (const rk of roles) {
    const computed = rk in SYSTEM_ROLES;
    for (const c of await cellsForRole(rk)) {
      cells.push({ roleKey: rk, functionality: c.functionality, action: c.action, computed });
    }
  }

  res.json({
    success: true,
    data: { version: matrixVersion(), source: matrixSource(), modules, cells },
  });
});

/**
 * Save matrix changes.
 *
 * Batched and version-checked: the editor sends every toggle in one request
 * with the version it loaded, so two admins editing at once conflict instead of
 * silently overwriting each other. Guards run BEFORE anything is written.
 */
router.put("/matrix", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const body = (req.body ?? {}) as { version?: number; reason?: string; changes?: CellChange[] };
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const reason = body.reason ?? null;

  if (typeof body.version !== "number") throw httpError(400, "version is required");
  if (body.version !== matrixVersion()) {
    throw httpError(409, "The matrix changed since you loaded it — reload and reapply", {
      code: "STALE_MATRIX_VERSION", yours: body.version, current: matrixVersion(),
    });
  }

  await assertMatrixChangeAllowed({ id: req.user!.id, role: req.user!.role }, changes, reason);
  await assertAccessControlReachable(changes);

  await db.transaction(async (tx) => {
    for (const c of changes) {
      if (c.allowed) {
        await tx
          .insert(roleFunctionalitiesTable)
          .values({
            id: newId(), roleKey: c.roleKey, functionality: c.functionality,
            action: c.action as never, allowed: true, updatedBy: req.user!.id,
          })
          .onConflictDoUpdate({
            target: [roleFunctionalitiesTable.roleKey, roleFunctionalitiesTable.functionality, roleFunctionalitiesTable.action],
            set: { allowed: true, updatedBy: req.user!.id, updatedAt: new Date() },
          });
      } else {
        await tx
          .delete(roleFunctionalitiesTable)
          .where(
            and(
              eq(roleFunctionalitiesTable.roleKey, c.roleKey),
              eq(roleFunctionalitiesTable.functionality, c.functionality),
              eq(roleFunctionalitiesTable.action, c.action as never),
            ),
          );
      }
    }
  });

  const version = await bumpMatrixVersion(req.user!.id);

  // Chained ACCESS event: a permission change is the edit most likely to be
  // questioned afterwards, so who/what/why is on the tamper-evident stream.
  recordActivity(activityCtx(req), {
    event: "MATRIX_CHANGED",
    entityId: [...new Set(changes.map((c) => c.roleKey))].join(","),
    entityLabel: `${changes.length} permission${changes.length === 1 ? "" : "s"}`,
    reason,
    after: { version, changes },
  });

  res.json({ success: true, data: { version, applied: changes.length } });
});

/**
 * The rungs a role may be handed out on.
 *
 * ROOM and BED are deliberately absent: nobody is given access "to room 101",
 * and COMPANY is absent because a role that spans the company needs no place at
 * all — that is what a null anchor means.
 */
const ANCHOR_LEVELS = ["ZONE", "CITY", "CLUSTER", "KITCHEN", "PROPERTY"] as const;

function normalizeAnchorLevel(v: unknown): "ZONE" | "CITY" | "CLUSTER" | "KITCHEN" | "PROPERTY" | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).toUpperCase();
  if (!(ANCHOR_LEVELS as readonly string[]).includes(s)) {
    throw httpError(400, `anchorLevel must be one of ${ANCHOR_LEVELS.join(", ")}, or empty for a role that carries no place`, { code: "BAD_ANCHOR_LEVEL" });
  }
  return s as "ZONE" | "CITY" | "CLUSTER" | "KITCHEN" | "PROPERTY";
}

/** Create a role, optionally cloning another's cells. */
router.post("/roles", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const b = (req.body ?? {}) as { key?: string; label?: string; cloneFrom?: string; reason?: string; anchorLevel?: string | null };
  if (!b.key || !/^[A-Z][A-Z0-9_.]*$/.test(b.key)) {
    throw httpError(400, "key must be SCREAMING_SNAKE_CASE");
  }
  if (!b.reason?.trim()) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });

  // A created role carries no seniority of its own: who may hand it out is
  // decided by ROLE_RANK in lib/authz.ts, which names the built-ins only. A new
  // role is therefore rank 0 — assignable by anyone who administers access, and
  // never a way to mint something more privileged than yourself.
  const anchorLevel = normalizeAnchorLevel(b.anchorLevel);

  const [role] = await db
    .insert(rolesTable)
    .values({ key: b.key, label: b.label ?? b.key, isSystem: false, anchorLevel })
    .onConflictDoNothing()
    .returning();
  if (!role) throw httpError(409, "A role with that key already exists");

  let cloned = 0;
  if (b.cloneFrom) {
    // Cloning is the biggest lever on "time to configure a new role" (a PRD
    // success metric) — but it must not copy a cell the actor lacks.
    const own = isSuperAdmin(req.user!.role)
      ? null
      : new Set((await cellsForRole(req.user!.role)).map((c) => `${c.functionality}:${c.action}`));
    for (const c of await cellsForRole(b.cloneFrom)) {
      if (!isManifestCell(c.functionality, c.action)) continue;
      if (own && !own.has(`${c.functionality}:${c.action}`)) continue;
      await db
        .insert(roleFunctionalitiesTable)
        .values({ id: newId(), roleKey: b.key, functionality: c.functionality, action: c.action as never, allowed: true, updatedBy: req.user!.id })
        .onConflictDoNothing();
      cloned++;
    }
  }

  const version = await bumpMatrixVersion(req.user!.id);
  recordActivity(activityCtx(req), {
    event: "MATRIX_CHANGED", entityId: b.key, entityLabel: `role created${b.cloneFrom ? ` (cloned from ${b.cloneFrom})` : ""}`,
    reason: b.reason, after: { roleKey: b.key, clonedCells: cloned, version },
  });

  res.status(201).json({ success: true, data: { role, clonedCells: cloned, version } });
});

/* ── Grants: create / revoke / restore (PRD §24 · §30 "Scopes") ───────────── */

/**
 * Who a grant is FOR, as a person rather than an id.
 *
 * The trail headline is a stored string, so unlike the before/after payload it
 * cannot be resolved at read time — "WARDEN -> 0276b0ff-…" would stay a uuid
 * forever. One lookup on a config write is a fair price for a readable row.
 */
async function subjectLabel(subjectId: string): Promise<string> {
  const [u] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, subjectId));
  return u?.email ?? subjectId;
}

router.post("/grants", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    subjectId: String(b["subjectId"] ?? ""),
    roleKey: String(b["roleKey"] ?? "*"),
    nodeId: (b["nodeId"] as string | null) ?? null,
    includeDescendants: b["includeDescendants"] !== false,
    followLinks: b["followLinks"] === true,
    dataScope: String(b["dataScope"] ?? "ALL"),
    assignmentKind: String(b["assignmentKind"] ?? "GRANT"),
    effectiveFrom: b["effectiveFrom"] ? new Date(String(b["effectiveFrom"])) : null,
    expiresAt: b["expiresAt"] ? new Date(String(b["expiresAt"])) : null,
  };
  if (!input.subjectId) throw httpError(400, "subjectId is required");

  await assertGrantIsSafe({ id: req.user!.id, role: req.user!.role }, input);

  const [row] = await db
    .insert(accessGrantsTable)
    .values({
      id: newId(),
      subjectType: "USER",
      subjectId: input.subjectId,
      roleKey: input.roleKey,
      nodeId: input.nodeId,
      includeDescendants: input.includeDescendants,
      followLinks: input.followLinks,
      dataScope: input.dataScope as never,
      qualifiers: (b["qualifiers"] as string[]) ?? [],
      assignmentKind: input.assignmentKind as never,
      ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
      expiresAt: input.expiresAt,
      grantedBy: req.user!.id,
    })
    .returning();

  recordActivity(activityCtx(req), {
    event: "GRANT_CREATED",
    entityId: row!.id,
    entityLabel: `${input.roleKey} → ${await subjectLabel(input.subjectId)}`,
    nodeId: input.nodeId,
    after: input,
  });
  res.status(201).json({ success: true, data: row });
});

router.post("/grants/:id/revoke", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const reason = (req.body?.reason as string | undefined)?.trim();
  // GRANT_REVOKED is reasonRequired in the registry; check here too so the
  // caller gets a 400 about the field rather than one about the trail.
  if (!reason) throw httpError(400, "A reason is required to revoke a grant", { code: "REASON_REQUIRED" });

  const [existing] = await db
    .select()
    .from(accessGrantsTable)
    .where(eq(accessGrantsTable.id, req.params["id"] as string));
  if (!existing) throw httpError(404, "Grant not found");
  if (existing.revokedAt) throw httpError(409, "Grant is already revoked");

  const [row] = await db
    .update(accessGrantsTable)
    .set({ revokedAt: new Date(), revokedBy: req.user!.id })
    .where(eq(accessGrantsTable.id, existing.id))
    .returning();

  recordActivity(activityCtx(req), {
    event: "GRANT_REVOKED",
    entityId: existing.id,
    entityLabel: `${existing.roleKey} → ${await subjectLabel(existing.subjectId)}`,
    nodeId: existing.nodeId,
    reason,
    before: { revokedAt: null },
    after: { revokedAt: row!.revokedAt, revokedBy: row!.revokedBy },
  });
  res.json({ success: true, data: row });
});

/** Restore a revoked grant — the un-revoke path the audit screen never had. */
router.post("/grants/:id/restore", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const reason = (req.body?.reason as string | undefined)?.trim();
  if (!reason) throw httpError(400, "A reason is required to restore a grant", { code: "REASON_REQUIRED" });

  const [existing] = await db
    .select()
    .from(accessGrantsTable)
    .where(eq(accessGrantsTable.id, req.params["id"] as string));
  if (!existing) throw httpError(404, "Grant not found");
  if (!existing.revokedAt) throw httpError(409, "Grant is not revoked");

  // Re-run the guards: the world may have moved since it was revoked — the node
  // deactivated, the subject disabled, an equivalent grant created.
  await assertGrantIsSafe({ id: req.user!.id, role: req.user!.role }, {
    subjectId: existing.subjectId, roleKey: existing.roleKey, nodeId: existing.nodeId,
    includeDescendants: existing.includeDescendants, followLinks: existing.followLinks,
    dataScope: existing.dataScope, assignmentKind: existing.assignmentKind,
    effectiveFrom: existing.effectiveFrom, expiresAt: existing.expiresAt,
  });

  const [row] = await db
    .update(accessGrantsTable)
    .set({ revokedAt: null, revokedBy: null })
    .where(eq(accessGrantsTable.id, existing.id))
    .returning();

  recordActivity(activityCtx(req), {
    event: "GRANT_CREATED",
    entityId: existing.id,
    entityLabel: `restored ${existing.roleKey} → ${await subjectLabel(existing.subjectId)}`,
    nodeId: existing.nodeId,
    reason,
    before: { revokedAt: existing.revokedAt },
    after: { revokedAt: null },
  });
  res.json({ success: true, data: row });
});

/* ── Property assignments (PRD §27 · §30 "Property assignments") ──────────── */

/** A person's home property and the ones they also work at. */
router.get("/assignments/:userId", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const rows = await db
    .select({
      id: accessGrantsTable.id,
      nodeId: accessGrantsTable.nodeId,
      kind: accessGrantsTable.assignmentKind,
      nodeName: orgNodesTable.name,
    })
    .from(accessGrantsTable)
    .leftJoin(orgNodesTable, eq(accessGrantsTable.nodeId, orgNodesTable.id))
    .where(and(eq(accessGrantsTable.subjectId, userId), isNull(accessGrantsTable.revokedAt)));

  res.json({
    success: true,
    data: {
      primary: rows.find((r) => r.kind === "PRIMARY") ?? null,
      secondary: rows.filter((r) => r.kind === "SECONDARY"),
    },
  });
});

/**
 * Set a person's primary + secondary properties in one call.
 *
 * Writes BOTH sides for the primary: the grant the new resolver reads AND
 * `users.propertyId`, which the legacy helper still reads. Writing only one
 * leaves the person scoped under one engine and not the other — and a null
 * propertyId reads as UNRESTRICTED to isPropertyScoped(), so the half-fix is
 * worse than none.
 */
router.put("/assignments/:userId", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const b = (req.body ?? {}) as { primaryNodeId?: string | null; secondaryNodeIds?: string[]; reason?: string };
  const reason = b.reason?.trim();
  if (!reason) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });

  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!before) throw httpError(404, "User not found");

  const secondary = [...new Set(b.secondaryNodeIds ?? [])].filter((n) => n !== b.primaryNodeId);

  for (const nodeId of [b.primaryNodeId, ...secondary].filter(Boolean) as string[]) {
    await assertGrantIsSafe({ id: req.user!.id, role: req.user!.role }, {
      subjectId: userId, roleKey: "*", nodeId,
      includeDescendants: true, followLinks: false,
      dataScope: "ALL", assignmentKind: "GRANT",
    }).catch((e) => {
      // A duplicate is fine here — reassignment is idempotent by nature.
      if ((e as { details?: Record<string, unknown> }).details?.["code"] === "DUPLICATE_GRANT") return;
      throw e;
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(accessGrantsTable)
      .where(and(
        eq(accessGrantsTable.subjectId, userId),
        inArray(accessGrantsTable.assignmentKind, ["PRIMARY", "SECONDARY"] as never),
      ));

    if (b.primaryNodeId) {
      await tx.insert(accessGrantsTable).values({
        id: newId(), subjectType: "USER", subjectId: userId, roleKey: "*",
        nodeId: b.primaryNodeId, includeDescendants: true, followLinks: false,
        dataScope: "ALL", qualifiers: [], assignmentKind: "PRIMARY", grantedBy: req.user!.id,
      });
    }
    for (const nodeId of secondary) {
      await tx.insert(accessGrantsTable).values({
        id: newId(), subjectType: "USER", subjectId: userId, roleKey: "*",
        nodeId, includeDescendants: true, followLinks: false,
        dataScope: "ALL", qualifiers: [], assignmentKind: "SECONDARY", grantedBy: req.user!.id,
      });
    }
    await tx.update(usersTable).set({ propertyId: b.primaryNodeId ?? null, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  });

  recordActivity(activityCtx(req), {
    event: "PROPERTY_ASSIGNMENT_CHANGED",
    entityId: userId,
    entityLabel: before.email,
    propertyId: b.primaryNodeId ?? null,
    reason,
    before: { propertyId: before.propertyId },
    after: { propertyId: b.primaryNodeId ?? null, secondary },
  });

  res.json({ success: true, data: { primaryNodeId: b.primaryNodeId ?? null, secondary } });
});

/* ── Privileges: property-scoped access rights, for users and roles ───────── */

/**
 * GET /access/privileges?subjectType=USER|ROLE&subjectId=…
 *
 * Every privilege the subject carries — live, scheduled or expired — with the
 * property it applies at and the reason it was written for. Expired rows are
 * returned rather than hidden: "she had it until last Friday" is the answer to
 * half the questions this screen exists to answer.
 *
 * For a USER subject the roles they hold are included too, so the screen can
 * show inherited role privileges beside the person's own without a second call.
 */
router.get("/privileges", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const subjectType = String(req.query["subjectType"] ?? "USER") as "USER" | "ROLE";
  const subjectId = String(req.query["subjectId"] ?? "");
  if (!subjectId) throw httpError(400, "subjectId is required");
  if (subjectType !== "USER" && subjectType !== "ROLE") {
    throw httpError(400, "subjectType must be USER or ROLE", { code: "BAD_SUBJECT_TYPE" });
  }

  const heldRoles = subjectType === "USER" ? await readRoles(subjectId) : [];
  const subjects: Array<{ type: "USER" | "ROLE"; id: string }> = [
    { type: subjectType, id: subjectId },
    ...heldRoles.map((r) => ({ type: "ROLE" as const, id: r })),
  ];

  const rows = await db
    .select()
    .from(privilegesTable)
    .where(
      or(
        ...subjects.map((sub) =>
          and(eq(privilegesTable.subjectType, sub.type), eq(privilegesTable.subjectId, sub.id))!,
        ),
      )!,
    )
    .orderBy(privilegesTable.functionality, privilegesTable.action);

  const nodeIds = [...new Set(rows.map((r) => r.nodeId).filter(Boolean) as string[])];
  const nodes = nodeIds.length
    ? await db.select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
        .from(orgNodesTable).where(inArray(orgNodesTable.id, nodeIds))
    : [];
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));
  const nodeType = new Map(nodes.map((n) => [n.id, n.nodeType]));

  const now = new Date();
  res.json({
    success: true,
    data: {
      heldRoles,
      /*
       * No field mapping any more: the columns are `functionality` and `action`,
       * and so is the wire contract, so a spread cannot leak a name the client
       * does not expect. The previous rename left the column saying
       * `functionality` while the contract said `action`, and two endpoints that
       * spread the raw row emitted neither — invisible to typecheck, and it took
       * the Privileges tab down through the error boundary. Keeping the two
       * vocabularies identical is what retires that whole class of bug.
       */
      privileges: await Promise.all(rows.map(async (r) => ({
        ...r,
        label: functionalityLabel(r.functionality as Functionality),
        module: moduleOf(r.functionality as Functionality),
        moduleLabel: moduleLabel(moduleOf(r.functionality as Functionality)),
        // The permission's own words, from the manifest — the same label, id and
        // one-liner every other screen shows for this cell.
        actionLabel: actionDef(r.functionality as Functionality, r.action)?.label ?? r.action,
        actionDescription: actionDef(r.functionality as Functionality, r.action)?.description ?? "",
        permissionId: permissionName(r.functionality as Functionality, r.action),
        // A short-lived link, minted per request. The stored key is never sent:
        // it would outlive the reader's right to it.
        approvalUrl: await approvalUrl(r.approvalKey),
        nodeName: r.nodeId ? nodeName.get(r.nodeId) ?? null : null,
        nodeType: r.nodeId ? nodeType.get(r.nodeId) ?? null : null,
        /** True when the row belongs to a role the user holds, not the user. */
        inherited: r.subjectType === "ROLE" && subjectType === "USER",
        // Computed server-side so the list and the resolver agree on "live"
        // rather than each applying its own idea of the window.
        live: r.effectiveFrom <= now && (!r.expiresAt || r.expiresAt > now),
      }))),
    },
  });
});

/**
 * GET /access/privilege-catalogue — every permission the system defines.
 *
 * The Privileges tab's list. The manifest is the source of what EXISTS; this
 * adds what is USED — how many roles grant each permission, and how many
 * exceptions are written against it. A permission granted by nothing and
 * exercised by nobody is the interesting row: either it is dead, or somebody
 * needs it and has been working around its absence.
 */
router.get("/privilege-catalogue", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (_req, res) => {
  const [roleCells, privRows] = await Promise.all([
    db.select({
      functionality: roleFunctionalitiesTable.functionality,
      action: roleFunctionalitiesTable.action,
      roleKey: roleFunctionalitiesTable.roleKey,
    }).from(roleFunctionalitiesTable),
    db.select({
      functionality: privilegesTable.functionality,
      action: privilegesTable.action,
    }).from(privilegesTable),
  ]);

  const cellKey = (f: string, a: string) => `${f}:${a}`;
  const roles = new Map<string, Set<string>>();
  for (const c of roleCells) {
    const k = cellKey(c.functionality, c.action);
    roles.set(k, (roles.get(k) ?? new Set()).add(c.roleKey));
  }
  const exceptions = new Map<string, number>();
  for (const p of privRows) {
    const k = cellKey(p.functionality, p.action);
    exceptions.set(k, (exceptions.get(k) ?? 0) + 1);
  }

  const permissions = ALL_FUNCTIONALITIES.flatMap((f) =>
    namedActionsFor(f).map((a) => {
      const k = cellKey(f, a.key);
      return {
        id: permissionName(f, a.key),
        functionality: f,
        functionalityLabel: functionalityLabel(f),
        module: moduleOf(f),
        moduleLabel: moduleLabel(moduleOf(f)),
        action: a.key,
        label: a.label,
        description: a.description,
        roles: [...(roles.get(k) ?? [])].sort(),
        exceptions: exceptions.get(k) ?? 0,
      };
    }),
  );

  res.json({ success: true, data: { permissions, total: permissions.length } });
});

/**
 * PUT /access/privileges — set or clear ONE cell, for one subject, at one place.
 *
 * One cell per call, deliberately. A bulk form would make "what exactly changed,
 * and why" a diff someone has to reconstruct, and the reason attached to a batch
 * is never the reason for each row in it.
 *
 * effect INHERIT deletes the row: the subject falls back to the layer beneath —
 * a user to their roles, a role to its matrix — which is the state we want most
 * subjects in most of the time.
 */
router.put("/privileges", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    subjectType: String(b["subjectType"] ?? "USER") as "USER" | "ROLE",
    subjectId: String(b["subjectId"] ?? ""),
    functionality: String(b["functionality"] ?? ""),
    action: String(b["action"] ?? ""),
    nodeId: (b["nodeId"] as string | null) ?? null,
    effect: String(b["effect"] ?? "") as "GRANT" | "DENY" | "INHERIT",
    reason: String(b["reason"] ?? ""),
    expiresAt: b["expiresAt"] ? new Date(String(b["expiresAt"])) : null,
  };
  if (!["GRANT", "DENY", "INHERIT"].includes(input.effect)) {
    throw httpError(400, "effect must be GRANT, DENY or INHERIT", { code: "BAD_EFFECT" });
  }

  const subject = await assertPrivilegeIsSafe({ id: req.user!.id, role: req.user!.role }, input);

  // Stored BEFORE the row is written, so a rejected file cannot leave a
  // privilege standing that claims paperwork it does not have.
  const approval = await storeApproval(b["approval"] as ApprovalFile | undefined, `privileges/${input.subjectId}`);

  const whereCell = and(
    eq(privilegesTable.subjectType, input.subjectType),
    eq(privilegesTable.subjectId, input.subjectId),
    eq(privilegesTable.functionality, input.functionality),
    eq(privilegesTable.action, input.action as never),
    input.nodeId ? eq(privilegesTable.nodeId, input.nodeId) : isNull(privilegesTable.nodeId),
  );
  const [existing] = await db.select().from(privilegesTable).where(whereCell);

  // What the layer BENEATH says, so the trail records whether this privilege
  // actually changed the answer or merely restated it.
  const baseRoles = input.subjectType === "USER" ? await readRoles(input.subjectId) : [input.subjectId];
  const baseAnswer = canAny(baseRoles, input.functionality as Functionality, input.action as never);

  let row: typeof existing | null = null;
  if (input.effect === "INHERIT") {
    if (!existing) throw httpError(404, "No privilege set on that cell", { code: "NO_PRIVILEGE" });
    await db.delete(privilegesTable).where(eq(privilegesTable.id, existing.id));
  } else if (existing) {
    [row] = await db
      .update(privilegesTable)
      .set({
        effect: input.effect,
        reason: input.reason.trim(),
        expiresAt: input.expiresAt,
        grantedBy: req.user!.id,
        updatedAt: new Date(),
        // Only overwritten when a NEW file came with this edit: re-saving a
        // privilege must not silently drop the approval it was granted on.
        ...(approval
          ? {
              approvalKey: approval.key,
              approvalFilename: approval.filename,
              approvalSize: approval.size,
              approvalUploadedBy: req.user!.id,
              approvalUploadedAt: new Date(),
            }
          : {}),
      })
      .where(eq(privilegesTable.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(privilegesTable)
      .values({
        id: newId(),
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        functionality: input.functionality,
        action: input.action as never,
        nodeId: input.nodeId,
        effect: input.effect,
        reason: input.reason.trim(),
        expiresAt: input.expiresAt,
        grantedBy: req.user!.id,
        approvalKey: approval?.key ?? null,
        approvalFilename: approval?.filename ?? null,
        approvalSize: approval?.size ?? null,
        approvalUploadedBy: approval ? req.user!.id : null,
        approvalUploadedAt: approval ? new Date() : null,
      })
      .returning();
  }

  // The cache is what authorize() reads, so a write that does not invalidate it
  // is a change the gate keeps ignoring for up to the TTL. A ROLE privilege
  // reaches every holder, so that one clears the whole cache.
  if (input.subjectType === "USER") invalidatePrivileges(input.subjectId);
  else invalidateAllPrivileges();

  recordActivity(activityCtx(req), {
    event: "PERMISSION_OVERRIDDEN",
    entityId: input.subjectId,
    entityLabel: subject.label,
    reason: input.reason.trim(),
    before: { permission: `${input.functionality}:${input.action}`, effect: existing?.effect ?? "INHERIT", atNode: existing?.nodeId ?? "Everywhere" },
    after: {
      permission: `${input.functionality}:${input.action}`,
      effect: input.effect,
      subject: `${input.subjectType} ${input.subjectId}`,
      atNode: input.nodeId ?? "Everywhere",
      baseAllows: baseAnswer,
      expiresAt: row?.expiresAt ?? null,
    },
  });

  res.json({
    success: true,
    data: { ...input, baseAllows: baseAnswer, row },
  });
});

/* ── Copy one person's access onto another ────────────────────────────────── */

/**
 * What "the same access as X" actually consists of.
 *
 * Three things, because access is three things: the ROLE decides capabilities,
 * the GRANTS decide where, and the OVERRIDES are the personal exceptions. Copy
 * one without the others and you get a person who looks right on one screen and
 * is broken on another — a warden with no property, or a property with no
 * capability to use it.
 */
async function accessSurfaceOf(userId: string) {
  const [user] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, propertyId: usersTable.propertyId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) throw httpError(404, "User not found");

  const grants = await db
    .select()
    .from(accessGrantsTable)
    .where(and(
      eq(accessGrantsTable.subjectType, "USER"),
      eq(accessGrantsTable.subjectId, userId),
      isNull(accessGrantsTable.revokedAt),
    ));

  const overrides = await db
    .select()
    .from(privilegesTable)
    .where(and(eq(privilegesTable.subjectType, "USER"), eq(privilegesTable.subjectId, userId)));

  // The role SET, not users.role. A handover means "take on what they do",
  // and under multi-role what they do is every membership they hold.
  const roles = await readRoles(userId);

  return { user, grants, overrides, roles };
}

/**
 * GET /access/clone-access/:fromUserId/:toUserId — the DRY RUN.
 *
 * Writes nothing. Onboarding "copy Priya's access" is a request made from
 * memory of what Priya does, not from knowledge of what she holds — so the
 * admin gets to see the exact list, and what it would replace, before any of it
 * is real. Every destructive part is named: this is where "and it will remove
 * their current property" becomes visible instead of surprising.
 */
router.get("/clone-access/:fromUserId/:toUserId", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const from = await accessSurfaceOf(req.params["fromUserId"] as string);
  const to = await accessSurfaceOf(req.params["toUserId"] as string);

  const nodeIds = [...new Set([...from.grants, ...to.grants].map((g) => g.nodeId).filter(Boolean) as string[])];
  const nodes = nodeIds.length
    ? await db.select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
        .from(orgNodesTable).where(inArray(orgNodesTable.id, nodeIds))
    : [];
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

  const describeGrant = (g: typeof from.grants[number]) => ({
    roleKey: g.roleKey,
    nodeId: g.nodeId,
    nodeName: g.nodeId ? nodeName.get(g.nodeId) ?? null : "Entire organization",
    assignmentKind: g.assignmentKind,
    dataScope: g.dataScope,
    includeDescendants: g.includeDescendants,
    expiresAt: g.expiresAt,
  });

  res.json({
    success: true,
    data: {
      from: { id: from.user.id, name: from.user.name, email: from.user.email, role: from.user.role },
      to: { id: to.user.id, name: to.user.name, email: to.user.email, role: to.user.role },
      role: {
        current: to.roles,
        incoming: from.roles,
        changes: [...to.roles].sort().join(",") !== [...from.roles].sort().join(","),
      },
      grants: { incoming: from.grants.map(describeGrant), replacing: to.grants.map(describeGrant) },
      overrides: {
        incoming: from.overrides.map((o) => ({ functionality: o.functionality, label: functionalityLabel(o.functionality as Functionality), module: moduleOf(o.functionality as Functionality), action: o.action, effect: o.effect, reason: o.reason, expiresAt: o.expiresAt })),
        replacing: to.overrides.map((o) => ({ functionality: o.functionality, label: functionalityLabel(o.functionality as Functionality), module: moduleOf(o.functionality as Functionality), action: o.action, effect: o.effect })),
      },
    },
  });
});

/**
 * POST /access/clone-access — apply it.
 *
 * REPLACES rather than merges. "Give her the same access as Priya" means the
 * same, and a merge would leave whatever the target already had silently added
 * on top — which is how a transfer quietly accumulates the access of every desk
 * someone ever sat at. What gets replaced is shown by the dry run above.
 *
 * Every copied row is re-validated against the ACTOR's own authority, never
 * trusted because it exists on the source. Otherwise cloning becomes the
 * escalation path around every guard on the grant and override surfaces: copy
 * from someone more privileged than you and inherit their reach.
 */
router.post("/clone-access", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fromUserId = String(b["fromUserId"] ?? "");
  const toUserId = String(b["toUserId"] ?? "");
  const reason = String(b["reason"] ?? "").trim();
  const parts = {
    role: b["role"] !== false,
    grants: b["grants"] !== false,
    overrides: b["overrides"] !== false,
  };

  if (!fromUserId || !toUserId) throw httpError(400, "fromUserId and toUserId are required");
  if (fromUserId === toUserId) throw httpError(400, "Those are the same person", { code: "SAME_SUBJECT" });
  if (reason.length < 4) throw httpError(400, "A reason is required to copy access", { code: "REASON_REQUIRED" });
  if (toUserId === req.user!.id) {
    throw httpError(403, "You cannot copy access onto yourself", { code: "SELF_CLONE" });
  }

  const from = await accessSurfaceOf(fromUserId);
  const to = await accessSurfaceOf(toUserId);

  // The role first: everything else is validated against the role the target
  // will HOLD, not the one they are leaving.
  if (parts.role) {
    // Every role on both sides is rank-checked: handing over a set must not be
    // a way around the guard that protects each one.
    for (const rk of new Set([...from.roles, ...to.roles])) assertCanAssignRole(req.user!.role, rk);
    assertNoCrossRoleConflict(from.roles, (rk, m, perm) => matrixCan(rk, m, perm as never));
  }

  // Re-run the real guards for every row, against the actor.
  if (parts.grants) {
    for (const g of from.grants) {
      await assertGrantIsSafe({ id: req.user!.id, role: req.user!.role }, {
        subjectId: toUserId, roleKey: g.roleKey, nodeId: g.nodeId,
        includeDescendants: g.includeDescendants, followLinks: g.followLinks,
        dataScope: g.dataScope, assignmentKind: g.assignmentKind,
      }).catch((e) => {
        // The target's own copy of a grant is not a conflict — it is about to be
        // replaced by the identical row.
        if ((e as { details?: Record<string, unknown> }).details?.["code"] === "DUPLICATE_GRANT") return;
        throw e;
      });
    }
  }
  if (parts.overrides) {
    for (const o of from.overrides) {
      await assertPrivilegeIsSafe({ id: req.user!.id, role: req.user!.role }, {
        subjectType: "USER", subjectId: toUserId, functionality: o.functionality, action: o.action,
        nodeId: o.nodeId, effect: o.effect as "GRANT" | "DENY", reason,
      });
    }
  }

  const applied = { role: false, grants: 0, overrides: 0, removedGrants: 0, removedOverrides: 0 };

  await db.transaction(async (tx) => {
    if (parts.role) {
      // Switch off what they hold now rather than deleting it — the record of
      // what someone held before a handover is exactly what gets asked for.
      await tx.update(userRolesTable).set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: req.user!.id,
        revokedReason: `${reason} (replaced by a copy of ${from.user.email})`,
      }).where(and(
        eq(userRolesTable.userId, toUserId),
        eq(userRolesTable.isActive, true),
      ));

      for (const rk of from.roles) {
        await tx.insert(userRolesTable)
          .values({ id: newId(), userId: toUserId, roleKey: rk, assignedBy: req.user!.id })
          .onConflictDoUpdate({
            target: [userRolesTable.userId, userRolesTable.roleKey],
            set: {
              isActive: true, revokedAt: null, revokedBy: null, revokedReason: null,
              assignedBy: req.user!.id, assignedAt: new Date(),
            },
          });
      }

      // Keep the legacy primary pointing at a role they now actually hold.
      await tx.update(usersTable)
        .set({ role: (from.roles[0] ?? from.user.role) as never, updatedAt: new Date() })
        .where(eq(usersTable.id, toUserId));
      applied.role = from.roles.length > 0;
    }

    if (parts.grants) {
      const removed = await tx.delete(accessGrantsTable)
        .where(and(
          eq(accessGrantsTable.subjectType, "USER"),
          eq(accessGrantsTable.subjectId, toUserId),
          isNull(accessGrantsTable.revokedAt),
        ))
        .returning({ id: accessGrantsTable.id });
      applied.removedGrants = removed.length;

      for (const g of from.grants) {
        await tx.insert(accessGrantsTable).values({
          id: newId(), subjectType: "USER", subjectId: toUserId, roleKey: g.roleKey,
          nodeId: g.nodeId, includeDescendants: g.includeDescendants, followLinks: g.followLinks,
          dataScope: g.dataScope, qualifiers: g.qualifiers ?? [], assignmentKind: g.assignmentKind,
          expiresAt: g.expiresAt, grantedBy: req.user!.id,
        });
        applied.grants++;
      }

      // users.propertyId is the legacy resolver's copy of the primary. Writing
      // only the grant leaves the two engines disagreeing about where this
      // person works — the same trap the assignments endpoint documents.
      const primary = from.grants.find((g) => g.assignmentKind === "PRIMARY");
      await tx.update(usersTable)
        .set({ propertyId: primary?.nodeId ?? from.user.propertyId ?? null, updatedAt: new Date() })
        .where(eq(usersTable.id, toUserId));
    }

    if (parts.overrides) {
      const removed = await tx.delete(privilegesTable)
        .where(and(eq(privilegesTable.subjectType, "USER"), eq(privilegesTable.subjectId, toUserId)))
        .returning({ id: privilegesTable.id });
      applied.removedOverrides = removed.length;

      for (const o of from.overrides) {
        await tx.insert(privilegesTable).values({
          id: newId(), subjectType: "USER", subjectId: toUserId,
          functionality: o.functionality, action: o.action, nodeId: o.nodeId,
          effect: o.effect, expiresAt: o.expiresAt, grantedBy: req.user!.id,
          // The copy's reason is the COPY's reason, not the original's — "copied
          // from Priya on her transfer" is the fact someone will need later.
          reason: `${reason} (copied from ${from.user.email})`,
        });
        applied.overrides++;
      }
    }
  });

  invalidatePrivileges(toUserId);
  invalidateAllRoles(toUserId);

  recordActivity(activityCtx(req), {
    event: "ACCESS_CLONED",
    entityId: toUserId,
    entityLabel: to.user.email,
    reason,
    before: {
      roles: to.roles,
      grants: to.grants.length,
      overrides: to.overrides.length,
    },
    after: {
      copiedFrom: from.user.email,
      roles: applied.role ? from.roles : to.roles,
      grants: applied.grants,
      overrides: applied.overrides,
    },
  });

  res.json({ success: true, data: applied });
});

/* ── Roles: detail, update, enable/disable ────────────────────────────────── */

/**
 * GET /access/roles/:key — one role, with everything the detail screen needs.
 *
 * Permissions (its matrix row), the people who hold it, and the scoped
 * privileges written against it — the three things "what does this role mean?"
 * actually decomposes into.
 */
router.get("/roles/:key", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const key = req.params["key"] as string;
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, key));
  if (!role) throw httpError(404, "Role not found");

  const cells = await cellsForRole(key);
  const holderRows = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, isActive: usersTable.isActive })
    .from(userRolesTable)
    .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
    .where(and(eq(userRolesTable.roleKey, key), eq(userRolesTable.isActive, true)));

  const privileges = await db
    .select()
    .from(privilegesTable)
    .where(and(eq(privilegesTable.subjectType, "ROLE"), eq(privilegesTable.subjectId, key)));

  const nodeIds = [...new Set(privileges.map((p) => p.nodeId).filter(Boolean) as string[])];
  const nodes = nodeIds.length
    ? await db.select({ id: orgNodesTable.id, name: orgNodesTable.name }).from(orgNodesTable).where(inArray(orgNodesTable.id, nodeIds))
    : [];
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

  res.json({
    success: true,
    data: {
      ...role,
      computed: key in SYSTEM_ROLES,
      permissions: cells.map((c) => ({
        ...c,
        label: functionalityLabel(c.functionality as Functionality),
        module: moduleOf(c.functionality as Functionality),
      })),
      holders: holderRows,
      /* Spread verbatim — see the note on GET /access/privileges: the columns and
         the wire contract now use the same two words, so there is nothing to map. */
      privileges: privileges.map((p) => ({
        ...p,
        label: functionalityLabel(p.functionality as Functionality),
        module: moduleOf(p.functionality as Functionality),
        nodeName: p.nodeId ? nodeName.get(p.nodeId) ?? null : null,
      })),
    },
  });
});

/**
 * PUT /access/roles/:key — rename, re-describe, re-anchor.
 *
 * The KEY is immutable: grants, privileges and user_roles all reference it, so
 * renaming it would orphan them silently. Everything else is presentation.
 * Rank is not presentation — it decides who may assign this role — so it is
 * rank-guarded like an assignment.
 */
router.put("/roles/:key", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const key = req.params["key"] as string;
  const b = (req.body ?? {}) as Record<string, unknown>;

  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, key));
  if (!role) throw httpError(404, "Role not found");
  if (role.isSystem || key in SYSTEM_ROLES) {
    throw httpError(422, `${key} is a system role — its definition is computed, not stored`, {
      code: "SYSTEM_ROLE",
    });
  }
  assertCanAssignRole(req.user!.role, key);

  const patch: Record<string, unknown> = { updatedBy: req.user!.id, updatedAt: new Date() };
  if (typeof b["label"] === "string" && b["label"].trim()) patch["label"] = b["label"].trim();
  if (typeof b["description"] === "string") patch["description"] = b["description"].trim() || null;
  if (b["anchorLevel"] !== undefined) {
    patch["anchorLevel"] = normalizeAnchorLevel(b["anchorLevel"] as string | null);
  }

  const [row] = await db.update(rolesTable).set(patch).where(eq(rolesTable.key, key)).returning();
  await bumpMatrixVersion(req.user!.id);

  recordActivity(activityCtx(req), {
    event: "MATRIX_CHANGED",
    entityId: key,
    entityLabel: `role updated`,
    reason: String(b["reason"] ?? "Role details updated"),
    before: { label: role.label, description: role.description, anchorLevel: role.anchorLevel },
    after: { label: row!.label, description: row!.description, anchorLevel: row!.anchorLevel },
  });
  res.json({ success: true, data: row });
});

/**
 * POST /access/roles/:key/disable · /enable
 *
 * Disable rather than delete: grants, privileges and memberships all reference
 * the key, so deleting one would leave rows pointing at nothing. A disabled
 * role stops contributing capability immediately (readRoles joins on isActive)
 * while its history stays intact and the decision stays reversible.
 */
for (const [verb, active] of [["disable", false], ["enable", true]] as const) {
  router.post(`/roles/:key/${verb}`, authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
    const key = req.params["key"] as string;
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });

    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, key));
    if (!role) throw httpError(404, "Role not found");
    if (role.isSystem || key in SYSTEM_ROLES) {
      throw httpError(422, `${key} is a system role and cannot be disabled`, { code: "SYSTEM_ROLE" });
    }
    assertCanAssignRole(req.user!.role, key);

    if (!active) {
      // Disabling a role removes capability from everyone holding it at once.
      // Refusing when that would leave nobody able to administer access is the
      // same backstop the matrix editor carries.
      // Disabling a role is that role losing every cell it holds, for everyone
      // holding it — express it as the cell the backstop actually cares about.
      await assertAccessControlReachable([
        { roleKey: key, functionality: "ACCESS_CONTROL", action: "configure", allowed: false },
      ]);
    }

    const [row] = await db
      .update(rolesTable)
      .set({ isActive: active, updatedBy: req.user!.id, updatedAt: new Date() })
      .where(eq(rolesTable.key, key))
      .returning();

    // Role state reaches every holder, so every cached role set is now suspect.
    invalidateAllRoles();
    invalidateAllPrivileges();

    recordActivity(activityCtx(req), {
      event: "MATRIX_CHANGED",
      entityId: key,
      entityLabel: active ? "role enabled" : "role disabled",
      reason,
      before: { isActive: role.isActive },
      after: { isActive: active },
    });
    res.json({ success: true, data: row });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The user's Roles tab: role → the places it was handed out at → what they may do
 *
 * Three endpoints behind one screen, because the screen is a tree that loads
 * lazily. Returning the whole thing in one payload would be 30 roles × N
 * properties × 46 modules × 4 verbs — most of it never opened.
 *
 * The shape encodes the rule the whole module turns on: a ROLE never names a
 * place. `roles` carries an anchorLevel (the RUNG it is handed out on, e.g.
 * CLUSTER) and the place itself lives on the user's grant. So "Cluster Manager"
 * is one role, and which cluster is a fact about the person holding it.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The nodes a role was handed out at, for one user.
 *
 * `'*'` grants are included on purpose: they predate per-role placement and
 * mean "wherever this person works, whatever they hold", so they legitimately
 * belong under every role. Marked so the UI can say which is which — one is a
 * deliberate assignment, the other is inherited from how the person was set up.
 */
async function roleAnchors(userId: string, roleKey: string, now = new Date()) {
  const rows = await db
    .select({
      id: orgNodesTable.id,
      name: orgNodesTable.name,
      nodeType: orgNodesTable.nodeType,
      grantRole: accessGrantsTable.roleKey,
      includeDescendants: accessGrantsTable.includeDescendants,
    })
    .from(accessGrantsTable)
    .innerJoin(orgNodesTable, eq(accessGrantsTable.nodeId, orgNodesTable.id))
    .where(and(
      eq(accessGrantsTable.subjectType, "USER"),
      eq(accessGrantsTable.subjectId, userId),
      // The SAME live window resolveAccess() applies. Without it the tree
      // cheerfully lists an anchor whose grant expired last week, and every
      // property under it — a screen that says someone reaches five properties
      // while the gate gives them one is worse than no screen.
      isNull(accessGrantsTable.revokedAt),
      lte(accessGrantsTable.effectiveFrom, now),
      or(isNull(accessGrantsTable.expiresAt), gt(accessGrantsTable.expiresAt, now)),
      or(eq(accessGrantsTable.roleKey, roleKey), eq(accessGrantsTable.roleKey, "*")),
    ));
  // One row per NODE, not per grant. A place can be covered twice — once by a
  // grant written for this role and once by an older '*' placement — and that
  // is one place, listed once. The role-scoped row wins, because it is the one
  // "Change places" edits and the one a revoke takes away.
  const byNode = new Map<string, { id: string; name: string; nodeType: string; includeDescendants: boolean; scopedToRole: boolean }>();
  for (const r of rows) {
    const scopedToRole = r.grantRole === roleKey;
    const seen = byNode.get(r.id);
    if (seen && !scopedToRole) continue;
    byNode.set(r.id, {
      id: r.id, name: r.name, nodeType: r.nodeType,
      includeDescendants: seen?.includeDescendants || r.includeDescendants,
      scopedToRole: seen?.scopedToRole || scopedToRole,
    });
  }
  return [...byNode.values()];
}

/**
 * Every property an anchor reaches, resolved through the closure AT READ TIME.
 *
 * This is what makes "new properties appear automatically" true: the grant
 * stores the cluster, never the list of properties under it, so a property
 * added tomorrow is in this answer tomorrow with nothing re-tagged.
 */
async function propertiesUnder(
  anchors: Array<{ id: string; name: string; nodeType: string; includeDescendants: boolean }>,
) {
  const out = new Map<string, { id: string; name: string; viaId: string; viaName: string; viaType: string }>();
  for (const a of anchors) {
    const ids = a.nodeType === "PROPERTY"
      ? [a.id]
      : a.includeDescendants
        ? await descendantIdsOfType([a.id], "PROPERTY")
        : [];
    if (!ids.length) continue;
    const names = await db
      .select({ id: orgNodesTable.id, name: orgNodesTable.name })
      .from(orgNodesTable)
      .where(and(inArray(orgNodesTable.id, ids), eq(orgNodesTable.isActive, true)));
    for (const n of names) {
      // First anchor wins: a property reachable two ways is still one property,
      // and the shallower route is the one that explains it.
      if (!out.has(n.id)) out.set(n.id, { id: n.id, name: n.name, viaId: a.id, viaName: a.name, viaType: a.nodeType });
    }
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** GET /access/users/:userId/tree — roles, their anchors, and the properties beneath. */
router.get("/users/:userId/tree", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw httpError(404, "User not found");

  const held = await readRoles(userId);
  const defs = held.length
    ? await db.select().from(rolesTable).where(inArray(rolesTable.key, held))
    : [];
  const byKey = new Map(defs.map((d) => [d.key, d]));

  const roles = [];
  for (const roleKey of held) {
    const def = byKey.get(roleKey);
    const anchors = await roleAnchors(userId, roleKey);
    roles.push({
      roleKey,
      label: def?.label ?? roleKey,
      anchorLevel: def?.anchorLevel ?? null,
      isSystem: def?.isSystem ?? false,
      anchors,
      properties: await propertiesUnder(anchors),
    });
  }

  res.json({ success: true, data: { user: { id: user.id, name: user.name, email: user.email }, roles } });
});

/**
 * GET /access/users/:userId/grid?roleKey=&nodeId= — what one person may do at
 * ONE property under ONE role, as module sections of functionality × action.
 *
 * Every cell comes from the same decide() the gate calls, so what the grid
 * shows and what a request actually gets cannot drift. `inManifest` is false
 * where the module simply has no such verb — LAUNDRY has no export — and the UI
 * greys those rather than offering a toggle that would be silently inert.
 */
router.get("/users/:userId/grid", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const nodeId = String(req.query["nodeId"] ?? "");
  const roleKey = String(req.query["roleKey"] ?? "");
  if (!nodeId) throw httpError(400, "nodeId is required");

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target) throw httpError(404, "User not found");
  const access = await resolveAccess({
    id: target.id, email: target.email, role: target.role,
    propertyId: target.propertyId, roleKey: target.role,
  } as never);

  // Module sections, each functionality carrying ITS OWN permissions.
  //
  // There is no module-wide column set any more, and that is the point: this
  // used to be a four-CRUD-verb grid, so the nine other verbs could be granted
  // by a privilege, enforced by the gate, and never once appear on the screen
  // that claims to show what someone may do here. Named actions remove the
  // question — a functionality lists exactly the permissions it has.
  const modules = ALL_MODULES.map((m) => {
    const functionalities = functionalitiesOf(m).map((functionality) => {
      const cells = namedActionsFor(functionality).map(({ key: action, label, description }) => {
        const d = decide(access, { functionality, action, nodeId });
        // Two answers, and the screen needs both. `roleAllows` is what THIS
        // role's matrix gives — what makes one role's grid differ from another's.
        // `allowed` is what the person actually gets here: the union across every
        // role they hold, plus any exception. A tick where the two disagree is
        // the exception, and the grid marks it.
        return {
          action,
          label,
          description,
          id: permissionName(functionality, action),
          // Retained although the server now enumerates only real permissions:
          // the client also renders cells built from STORED grants, which can
          // name an action the manifest has dropped.
          inManifest: true,
          roleAllows: roleKey ? canAny([roleKey], functionality, action) : d.allow,
          allowed: d.allow,
          reason: d.reason,
          detail: d.detail,
        };
      });
      return { functionality, label: functionalityLabel(functionality), cells };
    });
    return { key: m, label: moduleLabel(m), functionalities };
  }).filter((m) => m.functionalities.length > 0);

  res.json({ success: true, data: { userId, roleKey, nodeId, modules } });
});

/**
 * PUT /access/users/:userId/grid — flip ONE cell, for one role, at one property.
 *
 * Writes a privilege rather than touching the matrix, because the matrix is the
 * role's meaning for EVERYONE and this is one person at one place. When the
 * requested answer already equals what the layers beneath say, the privilege is
 * deleted instead of written: an exception that changes nothing is noise in
 * every later "who has exceptions?" review.
 */
router.put("/users/:userId/grid", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const roleKey = String(b["roleKey"] ?? "*");
  const nodeId = String(b["nodeId"] ?? "");
  const functionality = String(b["functionality"] ?? "") as Functionality;
  const action = String(b["action"] ?? "") as NamedAction;
  const allowed = b["allowed"] === true;
  const reason = String(b["reason"] ?? "").trim();

  if (!nodeId) throw httpError(400, "nodeId is required");
  if (!reason) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });
  if (!isManifestCell(functionality, action)) {
    throw httpError(422, `${functionalityLabel(functionality)} has no ${action}`, { code: "NOT_A_MANIFEST_CELL" });
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target) throw httpError(404, "User not found");

  // A role-scoped rule is only meaningful while they hold the role.
  const held = await readRoles(userId);
  if (roleKey !== "*" && !held.includes(roleKey)) {
    throw httpError(422, "They do not hold that role", { code: "ROLE_NOT_HELD" });
  }

  await assertPrivilegeIsSafe({ id: req.user!.id, role: req.user!.role }, {
    subjectType: "USER", subjectId: userId, functionality, action,
    nodeId, effect: allowed ? "GRANT" : "DENY", reason,
  });

  const whereCell = and(
    eq(privilegesTable.subjectType, "USER"),
    eq(privilegesTable.subjectId, userId),
    eq(privilegesTable.roleKey, roleKey),
    eq(privilegesTable.functionality, functionality),
    eq(privilegesTable.action, action as never),
    eq(privilegesTable.nodeId, nodeId),
  );
  const [existing] = await db.select().from(privilegesTable).where(whereCell);

  // What the answer would be with no privilege of ours in the way. Computed by
  // temporarily disregarding this cell is not possible synchronously, so we ask
  // the role matrix directly — the layer a deleted privilege falls back to.
  const baseRoles = roleKey === "*" ? held : [roleKey];
  const baseAnswer = canAny(baseRoles, functionality, action as never);

  let outcome: "granted" | "denied" | "cleared";
  if (allowed === baseAnswer) {
    if (existing) await db.delete(privilegesTable).where(eq(privilegesTable.id, existing.id));
    outcome = "cleared";
  } else if (existing) {
    await db.update(privilegesTable)
      .set({ effect: allowed ? "GRANT" : "DENY", reason, grantedBy: req.user!.id, updatedAt: new Date() })
      .where(eq(privilegesTable.id, existing.id));
    outcome = allowed ? "granted" : "denied";
  } else {
    await db.insert(privilegesTable).values({
      id: newId(), subjectType: "USER", subjectId: userId, roleKey,
      functionality, action: action as never, nodeId,
      effect: allowed ? "GRANT" : "DENY", reason, grantedBy: req.user!.id,
    });
    outcome = allowed ? "granted" : "denied";
  }

  invalidatePrivileges(userId);

  recordActivity(activityCtx(req), {
    event: "PERMISSION_OVERRIDDEN",
    entityId: userId,
    entityLabel: target.email,
    reason,
    before: { permission: `${module}:${action}`, effect: existing?.effect ?? "INHERIT", atNode: nodeId, role: roleKey },
    after: { permission: `${module}:${action}`, effect: outcome === "cleared" ? "INHERIT" : (allowed ? "GRANT" : "DENY"), atNode: nodeId, role: roleKey, baseAllows: baseAnswer },
  });

  res.json({ success: true, data: { outcome, allowed, baseAllows: baseAnswer } });
});

/**
 * PUT /access/users/:userId/role-scope — change WHERE one role applies.
 *
 * The "a Unit Lead's properties can be changed after creation" requirement. It
 * replaces the node set for exactly one role and leaves every other role's
 * placement alone, which a single users.propertyId could never express.
 *
 * `users.propertyId` is kept in step with the first anchor that is a property,
 * because ~110 legacy call sites still scope off that column alone. Writing only
 * the grants would leave the person correct under the new resolver and wrong
 * everywhere else.
 */
router.put("/users/:userId/role-scope", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const roleKey = String(b["roleKey"] ?? "");
  const nodeIds = [...new Set((Array.isArray(b["nodeIds"]) ? b["nodeIds"] : []).map(String))].filter(Boolean);
  const reason = String(b["reason"] ?? "").trim();

  if (!roleKey) throw httpError(400, "roleKey is required");
  if (!reason) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target) throw httpError(404, "User not found");

  const held = await readRoles(userId);
  if (!held.includes(roleKey)) throw httpError(422, "They do not hold that role", { code: "ROLE_NOT_HELD" });

  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.key, roleKey));
  if (!role) throw httpError(404, "Role not found");

  // The anchor level is the role's contract: a Cluster Manager is given a
  // CLUSTER. Accepting a property here would quietly create a second meaning
  // for the same role, which is the thing anchorLevel exists to prevent.
  if (nodeIds.length) {
    const nodes = await db
      .select({ id: orgNodesTable.id, nodeType: orgNodesTable.nodeType, name: orgNodesTable.name })
      .from(orgNodesTable)
      .where(inArray(orgNodesTable.id, nodeIds));
    if (nodes.length !== nodeIds.length) throw httpError(400, "Unknown place", { code: "UNKNOWN_NODE" });
    if (role.anchorLevel) {
      const wrong = nodes.filter((n) => n.nodeType !== role.anchorLevel);
      if (wrong.length) {
        throw httpError(422, `${role.label} is given a ${role.anchorLevel.toLowerCase()}, but ${wrong[0]!.name} is a ${wrong[0]!.nodeType.toLowerCase()}`, { code: "WRONG_ANCHOR_LEVEL" });
      }
    }
    for (const nodeId of nodeIds) {
      await assertGrantIsSafe({ id: req.user!.id, role: req.user!.role }, {
        subjectId: userId, roleKey, nodeId,
        includeDescendants: true, followLinks: false,
        dataScope: "ALL", assignmentKind: "GRANT",
      }).catch((e) => {
        if ((e as { details?: Record<string, unknown> }).details?.["code"] === "DUPLICATE_GRANT") return;
        throw e;
      });
    }
  }

  const before = (await roleAnchors(userId, roleKey)).filter((a) => a.scopedToRole).map((a) => a.id);

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
        dataScope: "ALL", qualifiers: [], assignmentKind: "GRANT", grantedBy: req.user!.id,
      });
    }

    // Keep the legacy column pointing at a real property, so the ~110 call
    // sites that still read it agree with at least the primary placement.
    if (!target.propertyId && nodeIds.length) {
      const props = await propertiesUnder(
        (await tx.select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
          .from(orgNodesTable).where(inArray(orgNodesTable.id, nodeIds)))
          .map((n) => ({ ...n, includeDescendants: true })),
      );
      if (props[0]) {
        await tx.update(usersTable).set({ propertyId: props[0].id, updatedAt: new Date() }).where(eq(usersTable.id, userId));
      }
    }
  });

  invalidatePrivileges(userId);

  recordActivity(activityCtx(req), {
    event: "PROPERTY_ASSIGNMENT_CHANGED",
    entityId: userId,
    entityLabel: target.email,
    reason,
    before: { role: roleKey, nodeIds: before },
    after: { role: roleKey, nodeIds },
  });

  res.json({ success: true, data: { roleKey, nodeIds } });
});
