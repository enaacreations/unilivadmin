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
  db, usersTable, orgNodesTable, accessGrantsTable, accessRolesTable,
  accessRolePermissionsTable, accessUserPermissionsTable,
} from "@workspace/db";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "../lib/id.js";
import {
  matrixVersion, matrixSource, bumpMatrixVersion, cellsForRole, isManifestCell, SYSTEM_ROLES,
} from "../lib/access/matrix.js";
import { assertMatrixChangeAllowed, assertAccessControlReachable, PROTECTED_MODULES, type CellChange } from "../lib/access/matrix-guards.js";
import { assertGrantIsSafe } from "../lib/access/grant-guards.js";
import { assertOverrideIsSafe } from "../lib/access/override-guards.js";
import { invalidateOverrides } from "../lib/access/overrides.js";
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
import { decide } from "../lib/access/decide.js";
import {
  can,
  ALL_MODULES,
  ALL_ACTIONS,
  actionsFor,
  MODULE_FAMILY,
  FAMILY_ORDER,
  moduleLabel,
  type Module,
} from "../lib/permissions.js";

const router: IRouter = Router();

/** The static vocabulary: what modules and actions exist at all. */
router.get("/manifest", authenticate, authorize("ACCESS_CONTROL", "view"), (_req, res) => {
  res.json({
    success: true,
    data: {
      actions: ALL_ACTIONS,
      families: FAMILY_ORDER,
      modules: ALL_MODULES.map((m) => ({
        key: m,
        // The UI leads with the label and keeps the key as mono subtext — 53
        // SCREAMING_SNAKE keys as primary labels is what made this unreadable.
        label: moduleLabel(m),
        family: MODULE_FAMILY[m],
        actions: actionsFor(m),
        protected: PROTECTED_MODULES.has(m),
      })),
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
router.get("/preview/:userId", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
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
      roleKey: target.roleKey,
    } as never);

    const nodes = access.nodeIds === null
      ? null
      : await db
          .select({ id: orgNodesTable.id, name: orgNodesTable.name, nodeType: orgNodesTable.nodeType })
          .from(orgNodesTable)
          .where(eq(orgNodesTable.isActive, true));

    const modules = ALL_MODULES.map((module: Module) => {
      const actions = actionsFor(module).map((action) => {
        const d = decide(access, { module, action, nodeId });
        return { action, allow: d.allow, reason: d.reason, detail: d.detail, via: d.via ?? null };
      });
      return {
        key: module,
        // Lets the UI collapse a wholly-denied module to one line, as the PRD mock does.
        noAccess: actions.every((a) => !a.allow),
        actions,
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
          roleKey: target.roleKey ?? target.role,
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
router.get("/users", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        roleKey: usersTable.roleKey,
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
router.get("/grants", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
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
router.get("/nodes", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
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

/** Roles, with their rank and whether their cells are computed. */
router.get("/roles", authenticate, authorize("ACCESS_CONTROL", "view"), async (_req, res) => {
  const rows = await db.select().from(accessRolesTable).orderBy(accessRolesTable.rank);

  // How many live people hold each role. Without it an admin cannot tell a
  // theoretical change from one that moves twelve wardens tomorrow morning.
  const counts = await db
    .select({ role: usersTable.role, n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.isActive, true))
    .groupBy(usersTable.role);
  const byRole = new Map(counts.map((c) => [c.role as string, c.n]));

  const cellCounts = await db
    .select({ roleKey: accessRolePermissionsTable.roleKey, n: sql<number>`count(*)::int` })
    .from(accessRolePermissionsTable)
    .where(eq(accessRolePermissionsTable.allowed, true))
    .groupBy(accessRolePermissionsTable.roleKey);
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
router.get("/matrix", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
  const roleKey = req.query["roleKey"] as string | undefined;

  const modules = ALL_MODULES.map((m) => ({
    key: m,
    actions: actionsFor(m),
    protected: PROTECTED_MODULES.has(m),
  }));

  const roles = roleKey ? [roleKey] : (await db.select({ key: accessRolesTable.key }).from(accessRolesTable)).map((r) => r.key);
  const cells: Array<{ roleKey: string; module: string; action: string; computed: boolean }> = [];
  for (const rk of roles) {
    const computed = rk in SYSTEM_ROLES;
    for (const c of await cellsForRole(rk)) {
      cells.push({ roleKey: rk, module: c.module, action: c.action, computed });
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
router.put("/matrix", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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
          .insert(accessRolePermissionsTable)
          .values({
            id: newId(), roleKey: c.roleKey, module: c.module,
            action: c.action as never, allowed: true, updatedBy: req.user!.id,
          })
          .onConflictDoUpdate({
            target: [accessRolePermissionsTable.roleKey, accessRolePermissionsTable.module, accessRolePermissionsTable.action],
            set: { allowed: true, updatedBy: req.user!.id, updatedAt: new Date() },
          });
      } else {
        await tx
          .delete(accessRolePermissionsTable)
          .where(
            and(
              eq(accessRolePermissionsTable.roleKey, c.roleKey),
              eq(accessRolePermissionsTable.module, c.module),
              eq(accessRolePermissionsTable.action, c.action as never),
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

/** Create a role, optionally cloning another's cells. */
router.post("/roles", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
  const b = (req.body ?? {}) as { key?: string; label?: string; rank?: number; cloneFrom?: string; reason?: string };
  if (!b.key || !/^[A-Z][A-Z0-9_.]*$/.test(b.key)) {
    throw httpError(400, "key must be SCREAMING_SNAKE_CASE");
  }
  if (!b.reason?.trim()) throw httpError(400, "A reason is required", { code: "REASON_REQUIRED" });

  const actorRank = ROLE_RANK[req.user!.role] ?? 0;
  const rank = b.rank ?? 0;
  // You cannot mint a role more privileged than yourself and then assume it.
  if (!isSuperAdmin(req.user!.role) && rank > actorRank) {
    throw httpError(403, "You cannot create a role ranked above your own");
  }

  const [role] = await db
    .insert(accessRolesTable)
    .values({ key: b.key, label: b.label ?? b.key, rank, isSystem: false })
    .onConflictDoNothing()
    .returning();
  if (!role) throw httpError(409, "A role with that key already exists");

  let cloned = 0;
  if (b.cloneFrom) {
    // Cloning is the biggest lever on "time to configure a new role" (a PRD
    // success metric) — but it must not copy a cell the actor lacks.
    const own = isSuperAdmin(req.user!.role)
      ? null
      : new Set((await cellsForRole(req.user!.role)).map((c) => `${c.module}:${c.action}`));
    for (const c of await cellsForRole(b.cloneFrom)) {
      if (!isManifestCell(c.module, c.action)) continue;
      if (own && !own.has(`${c.module}:${c.action}`)) continue;
      await db
        .insert(accessRolePermissionsTable)
        .values({ id: newId(), roleKey: b.key, module: c.module, action: c.action as never, allowed: true, updatedBy: req.user!.id })
        .onConflictDoNothing();
      cloned++;
    }
  }

  const version = await bumpMatrixVersion(req.user!.id);
  recordActivity(activityCtx(req), {
    event: "MATRIX_CHANGED", entityId: b.key, entityLabel: `role created${b.cloneFrom ? ` (cloned from ${b.cloneFrom})` : ""}`,
    reason: b.reason, after: { roleKey: b.key, rank, clonedCells: cloned, version },
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

router.post("/grants", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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

router.post("/grants/:id/revoke", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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
router.post("/grants/:id/restore", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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
router.get("/assignments/:userId", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
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
router.put("/assignments/:userId", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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

/* ── Per-employee permission overrides ────────────────────────────────────── */

/**
 * GET /access/overrides/:userId
 *
 * Every exception this person carries, live or scheduled or expired, with the
 * reason each was written for. Expired rows are returned rather than hidden:
 * "she had it until last Friday" is the answer to half the questions this
 * screen exists to answer.
 */
router.get("/overrides/:userId", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const rows = await db
    .select()
    .from(accessUserPermissionsTable)
    .where(eq(accessUserPermissionsTable.userId, userId))
    .orderBy(accessUserPermissionsTable.module, accessUserPermissionsTable.action);

  const now = new Date();
  res.json({
    success: true,
    data: rows.map((r) => ({
      ...r,
      label: moduleLabel(r.module as Module),
      // Computed server-side so the list and the resolver agree on "live"
      // rather than each applying its own idea of the window.
      live: r.effectiveFrom <= now && (!r.expiresAt || r.expiresAt > now),
    })),
  });
});

/**
 * PUT /access/overrides/:userId — set or clear ONE cell for one person.
 *
 * One cell per call, deliberately. A bulk form would make "what exactly changed
 * for this person, and why" a diff someone has to reconstruct, and the reason
 * attached to a batch is never the reason for each row in it.
 *
 * effect INHERIT deletes the row: the person returns to their role's answer,
 * which is the state we want most people in most of the time.
 */
router.put("/overrides/:userId", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
  const userId = req.params["userId"] as string;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    userId,
    module: String(b["module"] ?? ""),
    action: String(b["action"] ?? ""),
    effect: String(b["effect"] ?? "") as "GRANT" | "DENY" | "INHERIT",
    reason: String(b["reason"] ?? ""),
    expiresAt: b["expiresAt"] ? new Date(String(b["expiresAt"])) : null,
  };
  if (!["GRANT", "DENY", "INHERIT"].includes(input.effect)) {
    throw httpError(400, "effect must be GRANT, DENY or INHERIT", { code: "BAD_EFFECT" });
  }

  const subject = await assertOverrideIsSafe({ id: req.user!.id, role: req.user!.role }, input);

  const [existing] = await db
    .select()
    .from(accessUserPermissionsTable)
    .where(and(
      eq(accessUserPermissionsTable.userId, userId),
      eq(accessUserPermissionsTable.module, input.module),
      eq(accessUserPermissionsTable.action, input.action as never),
    ));

  // What the ROLE says, so the trail records whether this override actually
  // changed the answer or merely restated it.
  const roleAnswer = can(subject.role as never, input.module as Module, input.action as never);

  let row: typeof existing | null = null;
  if (input.effect === "INHERIT") {
    if (!existing) throw httpError(404, "No override on that permission", { code: "NO_OVERRIDE" });
    await db.delete(accessUserPermissionsTable).where(eq(accessUserPermissionsTable.id, existing.id));
  } else {
    [row] = await db
      .insert(accessUserPermissionsTable)
      .values({
        id: newId(),
        userId,
        module: input.module,
        action: input.action as never,
        effect: input.effect,
        reason: input.reason.trim(),
        expiresAt: input.expiresAt,
        grantedBy: req.user!.id,
      })
      .onConflictDoUpdate({
        target: [accessUserPermissionsTable.userId, accessUserPermissionsTable.module, accessUserPermissionsTable.action],
        set: {
          effect: input.effect,
          reason: input.reason.trim(),
          expiresAt: input.expiresAt,
          grantedBy: req.user!.id,
          updatedAt: new Date(),
        },
      })
      .returning();
  }

  // The cache is what authorize() reads, so a write that does not invalidate it
  // is a change the gate keeps ignoring for up to the TTL.
  invalidateOverrides(userId);

  recordActivity(activityCtx(req), {
    event: "PERMISSION_OVERRIDDEN",
    entityId: userId,
    entityLabel: subject.email,
    reason: input.reason.trim(),
    before: { permission: `${input.module}:${input.action}`, effect: existing?.effect ?? "INHERIT" },
    after: {
      permission: `${input.module}:${input.action}`,
      effect: input.effect,
      roleAllows: roleAnswer,
      expiresAt: row?.expiresAt ?? null,
    },
  });

  res.json({
    success: true,
    data: { effect: input.effect, module: input.module, action: input.action, roleAllows: roleAnswer, row },
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
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, roleKey: usersTable.roleKey, propertyId: usersTable.propertyId })
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
    .from(accessUserPermissionsTable)
    .where(eq(accessUserPermissionsTable.userId, userId));

  return { user, grants, overrides };
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
router.get("/clone-access/:fromUserId/:toUserId", authenticate, authorize("ACCESS_CONTROL", "view"), async (req, res) => {
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
      role: { current: to.user.role, incoming: from.user.role, changes: to.user.role !== from.user.role },
      grants: { incoming: from.grants.map(describeGrant), replacing: to.grants.map(describeGrant) },
      overrides: {
        incoming: from.overrides.map((o) => ({ module: o.module, label: moduleLabel(o.module as Module), action: o.action, effect: o.effect, reason: o.reason, expiresAt: o.expiresAt })),
        replacing: to.overrides.map((o) => ({ module: o.module, label: moduleLabel(o.module as Module), action: o.action, effect: o.effect })),
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
router.post("/clone-access", authenticate, authorize("ACCESS_CONTROL", "configure"), async (req, res) => {
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
  if (parts.role && from.user.role !== to.user.role) {
    assertCanAssignRole(req.user!.role, from.user.role);
    assertCanAssignRole(req.user!.role, to.user.role);
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
      await assertOverrideIsSafe({ id: req.user!.id, role: req.user!.role }, {
        userId: toUserId, module: o.module, action: o.action,
        effect: o.effect as "GRANT" | "DENY", reason,
      });
    }
  }

  const applied = { role: false, grants: 0, overrides: 0, removedGrants: 0, removedOverrides: 0 };

  await db.transaction(async (tx) => {
    if (parts.role && from.user.role !== to.user.role) {
      await tx.update(usersTable)
        .set({ role: from.user.role as never, roleKey: from.user.roleKey, updatedAt: new Date() })
        .where(eq(usersTable.id, toUserId));
      applied.role = true;
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
      const removed = await tx.delete(accessUserPermissionsTable)
        .where(eq(accessUserPermissionsTable.userId, toUserId))
        .returning({ id: accessUserPermissionsTable.id });
      applied.removedOverrides = removed.length;

      for (const o of from.overrides) {
        await tx.insert(accessUserPermissionsTable).values({
          id: newId(), userId: toUserId, module: o.module, action: o.action,
          effect: o.effect, expiresAt: o.expiresAt, grantedBy: req.user!.id,
          // The copy's reason is the COPY's reason, not the original's — "copied
          // from Priya on her transfer" is the fact someone will need later.
          reason: `${reason} (copied from ${from.user.email})`,
        });
        applied.overrides++;
      }
    }
  });

  invalidateOverrides(toUserId);

  recordActivity(activityCtx(req), {
    event: "ACCESS_CLONED",
    entityId: toUserId,
    entityLabel: to.user.email,
    reason,
    before: {
      role: to.user.role,
      grants: to.grants.length,
      overrides: to.overrides.length,
    },
    after: {
      copiedFrom: from.user.email,
      role: applied.role ? from.user.role : to.user.role,
      grants: applied.grants,
      overrides: applied.overrides,
    },
  });

  res.json({ success: true, data: applied });
});
