import { Router } from "express";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { newId } from "../lib/id.js";
import { vapidPublicKey, webPushEnabled } from "../lib/web-push.js";

export const pushRouter = Router();

/** The VAPID public key the browser needs to subscribe (null when push is off). */
pushRouter.get("/vapid-public-key", authenticate, (_req, res) => {
  res.json({ success: true, data: { enabled: webPushEnabled(), publicKey: webPushEnabled() ? vapidPublicKey() : null } });
});

/** Register (or re-activate) a browser push subscription for the current user. */
pushRouter.post("/subscribe", authenticate, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ success: false, error: "Invalid subscription" });
      return;
    }
    await db
      .insert(pushSubscriptionsTable)
      .values({
        id: newId(),
        userId: req.user!.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: (req.headers["user-agent"] as string) ?? null,
        isActive: true,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.endpoint,
        set: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth, isActive: true, lastUsedAt: new Date() },
      });
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** Deactivate a subscription (on opt-out or when the browser drops it). */
pushRouter.post("/unsubscribe", authenticate, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) {
      await db
        .update(pushSubscriptionsTable)
        .set({ isActive: false })
        .where(and(eq(pushSubscriptionsTable.endpoint, endpoint), eq(pushSubscriptionsTable.userId, req.user!.id)));
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});
