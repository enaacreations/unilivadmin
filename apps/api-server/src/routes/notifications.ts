import { Router } from "express";
import { db, notificationsTable, refreshTokensTable, notificationChannelEnum } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { isSuperAdmin } from "../lib/authz.js";
import { newId } from "../lib/id.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { onNotification, emitNotification } from "../lib/notification-events.js";
import { listSuppressions, clearSuppression, type Channel } from "@workspace/notify-core";

export const notificationsRouter = Router();

/**
 * The values Postgres accepts on `notification_suppressions.channel`, read off
 * the enum itself so the two can never drift (L6). Both handlers below cast a
 * query param straight into an enum comparison, and an unknown value comes back
 * as an opaque 500 instead of a 400 that names it. Same pattern as food.ts's
 * invalidEnumParam.
 */
const CHANNELS: readonly string[] = notificationChannelEnum.enumValues;

/** true (and answers 400) when a supplied enum-typed param is not a member. */
function invalidChannel(res: import("express").Response, v: string | undefined): boolean {
  if (v == null || CHANNELS.includes(v)) return false;
  res.status(400).json({ success: false, error: `Invalid channel '${v}' — expected one of ${CHANNELS.join(", ")}` });
  return true;
}

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

/* ────────────────────────────────────────────────────────────────────────────
 * Deliverability — the suppression list (H3)
 *
 * A hard bounce or a spam complaint (webhooks.ts, via SES/SNS) suppresses the
 * address so the worker never sends to it again. That is the right default and
 * it is also invisible: a resident who mistyped their email once, or whose
 * mailbox was full for a day, silently stops receiving payment links for ever,
 * and nothing in the product could show it — let alone undo it. These two
 * endpoints are that surface. Admin-only: it is a list of people's email
 * addresses and phone numbers.
 * ──────────────────────────────────────────────────────────────────────────── */

notificationsRouter.get("/suppressions", authenticate, async (req, res) => {
  try {
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" }); return;
    }
    const channel = req.query["channel"] as Channel | undefined;
    if (invalidChannel(res, channel)) return;
    const address = req.query["address"] as string | undefined;
    const limitRaw = Number(req.query["limit"]);
    const data = await listSuppressions({
      ...(channel ? { channel } : {}),
      ...(address ? { address } : {}),
      includeCleared: req.query["includeCleared"] === "true",
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
    });
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

notificationsRouter.delete("/suppressions", authenticate, async (req, res) => {
  try {
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" }); return;
    }
    const src = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
    const channel = src["channel"] as Channel | undefined;
    const address = src["address"] as string | undefined;
    if (!channel || !address) {
      res.status(400).json({ success: false, error: "channel and address are required" }); return;
    }
    if (invalidChannel(res, channel)) return;
    const cleared = await clearSuppression(channel, address);
    if (cleared === 0) { res.status(404).json({ success: false, error: "No active suppression for that address" }); return; }
    res.json({ success: true, data: { cleared } });
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
