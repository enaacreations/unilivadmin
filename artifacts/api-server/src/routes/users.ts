import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, announcementsTable } from "@workspace/db";
import { eq, sql, ilike, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

function sanitizeUser(u: typeof usersTable.$inferSelect) {
  const { passwordHash: _, ...rest } = u;
  return rest;
}

export const usersRouter = Router();
usersRouter.get("/", authenticate, async (req, res) => {
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
usersRouter.post("/", authenticate, async (req, res) => {
  try {
    const { password, id: _ignoredId, passwordHash: _ignoredHash, ...body } = req.body ?? {};
    const passwordHash = await bcrypt.hash(password || "TempPass@123", 12);
    const [row] = await db.insert(usersTable).values({ id: newId(), ...body, passwordHash, updatedAt: new Date() }).returning();
    res.status(201).json({ success: true, data: sanitizeUser(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
usersRouter.put("/:id", authenticate, async (req, res) => {
  try {
    const { password: _ignoredPw, id: _ignoredId, passwordHash: _ignoredHash, ...body } = req.body ?? {};
    const [row] = await db.update(usersTable).set({ ...body, updatedAt: new Date() }).where(eq(usersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: sanitizeUser(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
usersRouter.delete("/:id", authenticate, async (req, res) => {
  try {
    await db.delete(usersTable).where(eq(usersTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export const announcementsRouter = Router();
announcementsRouter.get("/", authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(announcementsTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(announcementsTable).where(where);
    const rows = await db.select().from(announcementsTable).where(where).limit(limit).offset(offset).orderBy(announcementsTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
announcementsRouter.post("/", authenticate, async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.insert(announcementsTable).values({ id: newId(), ...body, targetRoles: body.targetRoles || [], createdBy: req.user!.id }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
announcementsRouter.delete("/:id", authenticate, async (req, res) => {
  try {
    await db.delete(announcementsTable).where(eq(announcementsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
