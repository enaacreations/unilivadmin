import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, announcementsTable } from "@workspace/db";
import { eq, sql, ilike, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, assertCanAssignRole, ROLE_RANK, isSuperAdmin } from "../lib/authz.js";
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
const WRITABLE_USER_FIELDS = ["name", "email", "username", "designation", "phone", "role", "propertyId", "isActive"] as const;

export const usersRouter = Router();
usersRouter.get("/", authenticate, authorize("USERS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const role = req.query["role"] as string | undefined;
    const conditions = [];
    if (role) conditions.push(eq(usersTable.role, role as typeof usersTable.$inferSelect.role));
    if (search) conditions.push(ilike(usersTable.name, `%${search}%`));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(where);
    const rows = await db.select().from(usersTable).where(where).limit(limit).offset(offset).orderBy(usersTable.createdAt);
    res.json({ success: true, data: rows.map(sanitizeUser), meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
usersRouter.post("/", authenticate, authorize("USERS", "create"), async (req, res) => {
  try {
    const fields = pick(req.body, WRITABLE_USER_FIELDS);
    if (fields.role) assertCanAssignRole(req.user!.role, fields.role);
    const passwordHash = await bcrypt.hash(req.body?.password || "TempPass@123", 12);
    const [row] = await db.insert(usersTable).values({ id: newId(), ...fields, passwordHash, updatedAt: new Date() }).returning();
    // Audit (fire-and-forget; never blocks the create).
    void writeAuditLog(req.user!.id, "USER_CREATED", "user", row.id, {
      name: row.name, email: row.email, username: row.username, role: row.role, propertyId: row.propertyId,
    }).catch(() => {});
    res.status(201).json({ success: true, data: sanitizeUser(row) });
  } catch (err) { if (sendAuthzError(err, res)) return; req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
usersRouter.put("/:id", authenticate, authorize("USERS", "edit"), async (req, res) => {
  try {
    const fields = pick(req.body, WRITABLE_USER_FIELDS);
    const callerRole = req.user!.role;
    const isSelf = req.params["id"] === req.user!.id;
    // Load the target so a non-SUPER_ADMIN can't edit a user who out-ranks them.
    // Editing self or an equal-tier peer is allowed (HR_MANAGER manages peers and
    // its own profile); only editing a STRICTLY higher-ranked user is blocked.
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, req.params["id"]!));
    if (!target) { res.status(404).json({ success: false, error: "Not found" }); return; }
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
usersRouter.delete("/:id", authenticate, authorize("USERS", "delete"), async (req, res) => {
  try {
    const targetId = req.params["id"]!;
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
    await db.delete(usersTable).where(eq(usersTable.id, targetId));
    // Audit (fire-and-forget) — capture identifying fields before they're gone.
    void writeAuditLog(req.user!.id, "USER_DELETED", "user", targetId, {
      name: target?.name ?? null, email: target?.email ?? null, role: target?.role ?? null,
    }).catch(() => {});
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export const announcementsRouter = Router();
announcementsRouter.get("/", authenticate, authorize("COMMUNICATIONS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(announcementsTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(announcementsTable).where(where);
    const rows = await db.select().from(announcementsTable).where(where).limit(limit).offset(offset).orderBy(announcementsTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
announcementsRouter.post("/", authenticate, authorize("COMMUNICATIONS", "create"), async (req, res) => {
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
announcementsRouter.delete("/:id", authenticate, authorize("COMMUNICATIONS", "delete"), async (req, res) => {
  try {
    await db.delete(announcementsTable).where(eq(announcementsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
