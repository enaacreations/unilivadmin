import { db, pushSubscriptionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";

const PUBLIC = process.env["VAPID_PUBLIC_KEY"] || "";
const PRIVATE = process.env["VAPID_PRIVATE_KEY"] || "";
const SUBJECT = process.env["VAPID_SUBJECT"] || "mailto:ops@uniliv.com";

export function webPushEnabled(): boolean {
  return !!(PUBLIC && PRIVATE);
}
export function vapidPublicKey(): string {
  return PUBLIC;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  link?: string | null;
  type?: string;
}

/**
 * Best-effort web push to all of a user's active subscriptions. Never throws.
 * web-push is imported lazily so it is only loaded when VAPID_* are configured,
 * but the specifier MUST stay a LITERAL string: the runtime image ships no
 * node_modules, so a variable specifier (`const pkg = "web-push"`) leaves the
 * import unbundled and every push dies as a swallowed ERR_MODULE_NOT_FOUND.
 * See REQUIRED_IN_BUNDLE in build.mjs. Dead subscriptions (404/410) are deactivated.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!webPushEnabled()) return;
  try {
    const subs = await db
      .select()
      .from(pushSubscriptionsTable)
      .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.isActive, true)));
    if (!subs.length) return;

    const mod: any = await import("web-push");
    const webpush = mod.default ?? mod;
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body ?? "",
      link: payload.link ?? "/",
      type: payload.type ?? "",
    });

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh ?? "", auth: s.auth ?? "" } }, body);
          await db.update(pushSubscriptionsTable).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptionsTable.id, s.id));
        } catch (err: any) {
          const code = err?.statusCode;
          if (code === 404 || code === 410) {
            // Subscription is gone — stop trying.
            await db.update(pushSubscriptionsTable).set({ isActive: false }).where(eq(pushSubscriptionsTable.id, s.id));
          } else {
            logger.warn({ err: err?.message, sub: s.id }, "web push send failed");
          }
        }
      }),
    );
  } catch (err) {
    logger.error({ err }, "pushToUser failed");
  }
}
