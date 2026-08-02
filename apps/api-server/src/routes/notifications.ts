import { Router } from "express";
import { db, notificationsTable, refreshTokensTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { newId } from "../lib/id.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { onNotification, emitNotification } from "../lib/notification-events.js";

export const notificationsRouter = Router();

/**
 * Live notification stream (Server-Sent Events). EventSource can't send an
 * Authorization header, so this authenticates via the httpOnly refresh cookie
 * (sent automatically, same-origin) rather than a token in the URL — which would
 * otherwise leak into access logs.
 */
notificationsRouter.get("/stream", async (req, res) => {
  try {
    const token = req.cookies?.["refreshToken"];
    if (!token) { res.status(401).end(); return; }
    const [rt] = await db.select().from(refreshTokensTable).where(eq(refreshTokensTable.token, token));
    if (!rt || rt.expiresAt < new Date()) { res.status(401).end(); return; }
    const userId = rt.userId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // don't let nginx buffer the stream
    });
    res.write("event: ready\ndata: {}\n\n");

    const off = onNotification(userId, (n) => res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`));
    const keepalive = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { clearInterval(keepalive); off(); res.end(); });
  } catch (err) {
    req.log.error(err);
    res.status(500).end();
  }
});

notificationsRouter.get("/", authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const owned = eq(notificationsTable.userId, req.user!.id);

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(owned)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit)
      .offset(offset);

    // Count over the FULL owned set, not just the returned page.
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(notificationsTable)
      .where(owned);
    const [{ unreadCount }] = await db
      .select({ unreadCount: sql<number>`count(*)::int` })
      .from(notificationsTable)
      .where(and(owned, eq(notificationsTable.isRead, false)));

    res.json({
      success: true,
      data: rows,
      meta: { ...buildMeta(total, page, limit), unreadCount },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

notificationsRouter.patch("/:id/read", authenticate, async (req, res) => {
  try {
    await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(and(eq(notificationsTable.id, req.params["id"] as string), eq(notificationsTable.userId, req.user!.id)));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

notificationsRouter.patch("/read-all", authenticate, async (req, res) => {
  try {
    await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(eq(notificationsTable.userId, req.user!.id));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export async function createNotification(
  userId: string,
  data: { title: string; body?: string; type: string; link?: string },
) {
  const id = newId();
  const createdAt = new Date();
  await db.insert(notificationsTable).values({
    id,
    userId,
    title: data.title,
    body: data.body || null,
    type: data.type,
    link: data.link || null,
    isRead: false,
    createdAt,
  });
  emitNotification(userId, {
    id,
    title: data.title,
    body: data.body || null,
    type: data.type,
    link: data.link || null,
    createdAt: createdAt.toISOString(),
  });
}
