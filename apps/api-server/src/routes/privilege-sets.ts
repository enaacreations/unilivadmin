/**
 * Privilege SETS — named groups of primitive permissions.
 *
 * The unit people actually reason about. Nobody asks for
 * `audits.audit_execution.close_audit`; they ask to let somebody cover the night
 * audit, which is six permissions that must travel together. Handing them out
 * one at a time is how a person ends up with five of the six.
 *
 * Assignment stores a POINTER, never a copy — see the comment on
 * `privilegeSetsTable`. Editing a set therefore changes everyone holding it,
 * which is the point and also the danger, so every write here reports how many
 * people it reaches and the trail records it.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  privilegeSetsTable,
  privilegeSetItemsTable,
  privilegeSetAssignmentsTable,
  usersTable,
} from "@workspace/db";
import { newId } from "../lib/id.js";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { recordActivity, activityCtx } from "../lib/activity/record.js";
import { invalidatePrivileges, invalidateAllPrivileges } from "../lib/access/privileges.js";
import { assertPrivilegeIsSafe } from "../lib/access/privilege-guards.js";
import { httpError } from "../lib/authz.js";
import {
  actionDef, functionalityLabel, moduleOf, permissionName,
  type Functionality,
} from "../lib/permissions.js";
import { storeApproval, approvalUrl, type ApprovalFile } from "../lib/approval-file.js";

const router: IRouter = Router();

/** A set item, decorated with the words every screen shows for it. */
function describeItem(functionality: string, action: string) {
  const def = actionDef(functionality as Functionality, action);
  return {
    functionality,
    action,
    functionalityLabel: functionalityLabel(functionality as Functionality),
    module: moduleOf(functionality as Functionality),
    label: def?.label ?? action,
    description: def?.description ?? "",
    id: permissionName(functionality as Functionality, action),
    /**
     * false = the manifest no longer names this permission. The item is kept and
     * shown struck through rather than dropped: a set that silently loses a
     * member is a set nobody can audit.
     */
    inManifest: def != null,
  };
}

/** How many live assignments a set has — the blast radius of editing it. */
async function reachOf(setIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!setIds.length) return out;
  const rows = await db
    .select({ setId: privilegeSetAssignmentsTable.setId })
    .from(privilegeSetAssignmentsTable)
    .where(and(inArray(privilegeSetAssignmentsTable.setId, setIds), isNull(privilegeSetAssignmentsTable.revokedAt)));
  for (const r of rows) out.set(r.setId, (out.get(r.setId) ?? 0) + 1);
  return out;
}

/** GET /access/privilege-sets — every set, with its members and its reach. */
router.get("/privilege-sets", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (_req, res) => {
  const sets = await db.select().from(privilegeSetsTable).orderBy(desc(privilegeSetsTable.createdAt));
  const ids = sets.map((s) => s.id);
  const items = ids.length
    ? await db.select().from(privilegeSetItemsTable).where(inArray(privilegeSetItemsTable.setId, ids))
    : [];
  const reach = await reachOf(ids);

  const bySet = new Map<string, typeof items>();
  for (const it of items) bySet.set(it.setId, [...(bySet.get(it.setId) ?? []), it]);

  res.json({
    success: true,
    data: sets.map((s) => ({
      ...s,
      items: (bySet.get(s.id) ?? []).map((i) => describeItem(i.functionality, i.action)),
      holders: reach.get(s.id) ?? 0,
    })),
  });
});

/** Shared parse + validation for a set write. */
function readSetBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b["name"] ?? "").trim();
  const description = String(b["description"] ?? "").trim();
  const effect = String(b["effect"] ?? "GRANT");
  const rawItems = Array.isArray(b["items"]) ? (b["items"] as Array<Record<string, unknown>>) : [];

  if (name.length < 3) throw httpError(400, "A set needs a name", { code: "NAME_REQUIRED" });
  // Not optional: a set is offered to people who did not create it, and a name
  // alone ("Night cover") does not say what it lets somebody do.
  if (description.length < 8) {
    throw httpError(400, "Say what this set is for — it is shown wherever the set is offered", {
      code: "DESCRIPTION_REQUIRED",
    });
  }
  if (!["GRANT", "DENY"].includes(effect)) {
    throw httpError(400, "effect must be GRANT or DENY", { code: "BAD_EFFECT" });
  }

  const items = rawItems.map((i) => ({
    functionality: String(i["functionality"] ?? ""),
    action: String(i["action"] ?? ""),
  }));
  if (!items.length) throw httpError(400, "A set with no permissions grants nothing", { code: "EMPTY_SET" });

  // The manifest is the ceiling here exactly as it is at the gate: a set must not
  // be able to hold a permission that does not exist, or it becomes a place
  // where typos live on looking like access.
  const unknown = items.filter((i) => !actionDef(i.functionality as Functionality, i.action));
  if (unknown.length) {
    throw httpError(400, `No such permission: ${unknown.map((u) => `${u.functionality}.${u.action}`).join(", ")}`, {
      code: "UNKNOWN_PERMISSION",
    });
  }
  return { name, description, effect: effect as "GRANT" | "DENY", items };
}

/** POST /access/privilege-sets — create one. */
router.post("/privilege-sets", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const input = readSetBody(req.body);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const key = String(b["key"] ?? input.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const [existing] = await db.select().from(privilegeSetsTable).where(eq(privilegeSetsTable.key, key));
  if (existing) throw httpError(409, `A set called ${key} already exists`, { code: "SET_EXISTS" });

  const setId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(privilegeSetsTable).values({
      id: setId, key, name: input.name, description: input.description,
      effect: input.effect, createdBy: req.user!.id,
    });
    await tx.insert(privilegeSetItemsTable).values(
      input.items.map((i) => ({ id: newId(), setId, functionality: i.functionality, action: i.action })),
    );
  });

  recordActivity(activityCtx(req), {
    event: "PRIVILEGE_SET_CREATED",
    entityId: setId,
    entityLabel: input.name,
    after: { key, effect: input.effect, items: input.items.map((i) => permissionName(i.functionality as Functionality, i.action)) },
    reason: input.description,
  });

  res.status(201).json({ success: true, data: { id: setId, key } });
});

/**
 * PUT /access/privilege-sets/:id — rename it, or change what is in it.
 *
 * A live reference, so this reaches everyone holding the set. The response says
 * how many that was, and the trail records the before and after membership —
 * "who gained what, when" has to be answerable from the trail alone.
 */
router.put("/privilege-sets/:id", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const id = req.params["id"] as string;
  const [set] = await db.select().from(privilegeSetsTable).where(eq(privilegeSetsTable.id, id));
  if (!set) throw httpError(404, "No such privilege set");

  const input = readSetBody(req.body);
  const before = await db.select().from(privilegeSetItemsTable).where(eq(privilegeSetItemsTable.setId, id));
  const reach = (await reachOf([id])).get(id) ?? 0;

  await db.transaction(async (tx) => {
    await tx.update(privilegeSetsTable).set({
      name: input.name, description: input.description, effect: input.effect,
      isActive: (req.body as Record<string, unknown>)["isActive"] !== false,
      updatedAt: new Date(),
    }).where(eq(privilegeSetsTable.id, id));
    // Replaced wholesale rather than diffed: the set IS its membership, and a
    // partial apply would leave it in a state nobody asked for.
    await tx.delete(privilegeSetItemsTable).where(eq(privilegeSetItemsTable.setId, id));
    await tx.insert(privilegeSetItemsTable).values(
      input.items.map((i) => ({ id: newId(), setId: id, functionality: i.functionality, action: i.action })),
    );
  });

  // Every holder's resolved privileges just changed, and the gate reads the
  // cache — so this clears all of it, not one user's.
  invalidateAllPrivileges();

  recordActivity(activityCtx(req), {
    event: "PRIVILEGE_SET_UPDATED",
    entityId: id,
    entityLabel: input.name,
    before: { items: before.map((i) => permissionName(i.functionality as Functionality, i.action)) },
    after: { items: input.items.map((i) => permissionName(i.functionality as Functionality, i.action)), reached: reach },
    reason: input.description,
  });

  res.json({ success: true, data: { id, holders: reach } });
});

/**
 * POST /access/privilege-sets/:id/assign — give a set to a person or a role.
 *
 * Runs the SAME guard a single privilege runs (`assertPrivilegeIsSafe`), once
 * per member. A set must not be a way around the checks that stop somebody
 * granting themselves a permission, out-ranking their own role, or editing a
 * protected cell — which is exactly what it would become if it were trusted as
 * one opaque bundle.
 */
router.post("/privilege-sets/:id/assign", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const id = req.params["id"] as string;
  const [set] = await db.select().from(privilegeSetsTable).where(eq(privilegeSetsTable.id, id));
  if (!set) throw httpError(404, "No such privilege set");

  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = {
    subjectType: String(b["subjectType"] ?? "USER") as "USER" | "ROLE",
    subjectId: String(b["subjectId"] ?? ""),
    roleKey: String(b["roleKey"] ?? "*"),
    nodeId: (b["nodeId"] as string | null) || null,
    reason: String(b["reason"] ?? "").trim(),
    expiresAt: b["expiresAt"] ? new Date(String(b["expiresAt"])) : null,
  };

  const items = await db.select().from(privilegeSetItemsTable).where(eq(privilegeSetItemsTable.setId, id));
  if (!items.length) throw httpError(400, "That set has no permissions in it", { code: "EMPTY_SET" });

  for (const it of items) {
    await assertPrivilegeIsSafe({ id: req.user!.id, role: req.user!.role }, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      functionality: it.functionality,
      action: it.action,
      nodeId: input.nodeId,
      effect: set.effect as "GRANT" | "DENY",
      reason: input.reason,
      expiresAt: input.expiresAt,
    });
  }

  /*
   * Already holds it?
   *
   * The paired partial uniques would catch this, but as a raw constraint
   * violation the error handler can only call "Internal server error" — which
   * tells the admin nothing and reads like a broken screen rather than a set
   * they already granted. Checked here so the refusal can say so.
   */
  const [dupe] = await db
    .select({ id: privilegeSetAssignmentsTable.id })
    .from(privilegeSetAssignmentsTable)
    .where(
      and(
        eq(privilegeSetAssignmentsTable.setId, id),
        eq(privilegeSetAssignmentsTable.subjectType, input.subjectType),
        eq(privilegeSetAssignmentsTable.subjectId, input.subjectId),
        eq(privilegeSetAssignmentsTable.roleKey, input.roleKey),
        input.nodeId
          ? eq(privilegeSetAssignmentsTable.nodeId, input.nodeId)
          : isNull(privilegeSetAssignmentsTable.nodeId),
        isNull(privilegeSetAssignmentsTable.revokedAt),
      ),
    );
  if (dupe) {
    throw httpError(409, `They already hold ${set.name}${input.nodeId ? " here" : ""}`, {
      code: "SET_ALREADY_HELD",
      assignmentId: dupe.id,
    });
  }

  const approval = await storeApproval(b["approval"] as ApprovalFile | undefined, `privilege-sets/${id}`);

  const [row] = await db
    .insert(privilegeSetAssignmentsTable)
    .values({
      id: newId(),
      setId: id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      roleKey: input.roleKey,
      nodeId: input.nodeId,
      reason: input.reason,
      approvalKey: approval?.key ?? null,
      approvalFilename: approval?.filename ?? null,
      approvalSize: approval?.size ?? null,
      expiresAt: input.expiresAt,
      grantedBy: req.user!.id,
    })
    .returning();

  if (input.subjectType === "USER") invalidatePrivileges(input.subjectId);
  else invalidateAllPrivileges();

  recordActivity(activityCtx(req), {
    event: "PRIVILEGE_SET_ASSIGNED",
    entityId: input.subjectId,
    entityLabel: set.name,
    after: {
      setKey: set.key, subjectType: input.subjectType, nodeId: input.nodeId,
      expiresAt: input.expiresAt, approval: approval?.filename ?? null,
    },
    reason: input.reason,
  });

  res.status(201).json({ success: true, data: { id: row!.id } });
});

/** DELETE /access/privilege-set-assignments/:id — take a set back. */
router.delete("/privilege-set-assignments/:id", authenticate, authorize("ACCESS_CONTROL", "administer_access"), async (req, res) => {
  const id = req.params["id"] as string;
  const [row] = await db.select().from(privilegeSetAssignmentsTable).where(eq(privilegeSetAssignmentsTable.id, id));
  if (!row) throw httpError(404, "No such assignment");

  // Revoked, not deleted: "who had what, when" is the question this table exists
  // to answer, and a deleted row answers it wrongly rather than not at all.
  await db.update(privilegeSetAssignmentsTable)
    .set({ revokedAt: new Date() })
    .where(eq(privilegeSetAssignmentsTable.id, id));

  if (row.subjectType === "USER") invalidatePrivileges(row.subjectId);
  else invalidateAllPrivileges();

  recordActivity(activityCtx(req), {
    event: "PRIVILEGE_SET_REVOKED",
    entityId: row.subjectId,
    entityLabel: row.setId,
    before: { nodeId: row.nodeId, reason: row.reason },
    reason: String((req.body as Record<string, unknown> | undefined)?.["reason"] ?? "Revoked"),
  });

  res.json({ success: true });
});

/** GET /access/privilege-sets/held/:subjectId — the sets one subject holds. */
router.get("/privilege-sets/held/:subjectId", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const subjectId = req.params["subjectId"] as string;
  const rows = await db
    .select({ a: privilegeSetAssignmentsTable, set: privilegeSetsTable })
    .from(privilegeSetAssignmentsTable)
    .innerJoin(privilegeSetsTable, eq(privilegeSetsTable.id, privilegeSetAssignmentsTable.setId))
    .where(and(eq(privilegeSetAssignmentsTable.subjectId, subjectId), isNull(privilegeSetAssignmentsTable.revokedAt)));

  const items = rows.length
    ? await db.select().from(privilegeSetItemsTable)
        .where(inArray(privilegeSetItemsTable.setId, [...new Set(rows.map((r) => r.set.id))]))
    : [];
  const bySet = new Map<string, typeof items>();
  for (const it of items) bySet.set(it.setId, [...(bySet.get(it.setId) ?? []), it]);

  res.json({
    success: true,
    data: await Promise.all(rows.map(async (r) => ({
      assignmentId: r.a.id,
      setId: r.set.id,
      key: r.set.key,
      name: r.set.name,
      description: r.set.description,
      effect: r.set.effect,
      isActive: r.set.isActive,
      roleKey: r.a.roleKey,
      nodeId: r.a.nodeId,
      reason: r.a.reason,
      expiresAt: r.a.expiresAt,
      approvalFilename: r.a.approvalFilename,
      approvalUrl: await approvalUrl(r.a.approvalKey),
      items: (bySet.get(r.set.id) ?? []).map((i) => describeItem(i.functionality, i.action)),
    }))),
  });
});

/** GET /access/privilege-sets/:id/holders — who a set reaches, by name. */
router.get("/privilege-sets/:id/holders", authenticate, authorize("ACCESS_CONTROL", "view_access"), async (req, res) => {
  const id = req.params["id"] as string;
  const rows = await db
    .select({ a: privilegeSetAssignmentsTable, name: usersTable.name, email: usersTable.email })
    .from(privilegeSetAssignmentsTable)
    .leftJoin(usersTable, eq(usersTable.id, privilegeSetAssignmentsTable.subjectId))
    .where(and(eq(privilegeSetAssignmentsTable.setId, id), isNull(privilegeSetAssignmentsTable.revokedAt)));

  res.json({
    success: true,
    data: rows.map((r) => ({
      assignmentId: r.a.id,
      subjectType: r.a.subjectType,
      subjectId: r.a.subjectId,
      // A ROLE assignment has no user row — the subject IS the role key.
      name: r.a.subjectType === "ROLE" ? r.a.subjectId : r.name,
      email: r.a.subjectType === "ROLE" ? null : r.email,
      nodeId: r.a.nodeId,
      expiresAt: r.a.expiresAt,
    })),
  });
});

export { router as privilegeSetsRouter };
export default router;
