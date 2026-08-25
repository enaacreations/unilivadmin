/**
 * Notification & outbound-message engine.
 *
 * Single entry point (`notify`) that:
 *   1. writes an in-app row (`notifications`) that the bell already polls, and
 *   2. enqueues an outbox row (`notification_outbox`) per external channel
 *      (EMAIL/SMS/PUSH) and attempts delivery through a pluggable transport.
 *
 * The outbox is the durable source of truth + audit; a real provider can be
 * wired by setting SES/SMTP_/TWILIO_ env (see `deliver`). In development only,
 * absent credentials fall back to a "log" transport that records the rendered
 * message so the flow is exercised without leaking anything; in any other
 * environment an unconfigured channel fails closed and the row records FAILED —
 * the outbox must never claim a delivery that never happened.
 */
import { db } from "@workspace/db";
import {
  notificationsTable,
  notificationOutboxTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { newId } from "./id.js";
import { logger } from "./logger.js";
import { istParts } from "./tz.js";
import { enqueueDelivery, processDeliveryInline, queueEnabled } from "@workspace/notify-core";
import { emitNotification } from "./notification-events.js";
import { pushToUser } from "./web-push.js";

type Channel = "EMAIL" | "SMS" | "PUSH";

export interface EmailPayload {
  subject: string;
  /** Plain-text body (always provided; html optional). */
  text: string;
  html?: string;
}

export interface NotifyInput {
  /** Recipient user id (in-app + email/phone resolved from this user). */
  userId: string;
  /** In-app bell title. */
  title: string;
  /** In-app bell body. */
  body?: string;
  /** Free-form category, e.g. "FOOD_ORDER". */
  type: string;
  /** Deep link the bell navigates to, e.g. "/food/orders/<id>". */
  link?: string;
  /** Domain entity for outbox audit. */
  entityType?: string;
  entityId?: string;
  /** When present (and the user has an email), an EMAIL outbox row is sent. */
  email?: EmailPayload;
  /** When present (and the user has a phone), an SMS outbox row is sent. */
  sms?: string;
  /** Skip the in-app row (e.g. pure transactional email). Default false. */
  skipInApp?: boolean;
}

/**
 * Persists an outbox row (durable, PENDING) and hands it to the async dispatcher.
 * Delivery itself — transport selection, retries, status updates — lives in the
 * notify-service worker (via @workspace/notify-core). When no queue is configured
 * (REDIS_URL unset / worker not running) we deliver inline so the app still works.
 */
async function enqueueAndSend(input: {
  userId: string;
  channel: Channel;
  toAddress: string;
  subject: string | null;
  body: string;
  entityType?: string;
  entityId?: string;
}): Promise<void> {
  const id = newId();
  await db.insert(notificationOutboxTable).values({
    id,
    userId: input.userId,
    channel: input.channel,
    toAddress: input.toAddress,
    subject: input.subject,
    body: input.body,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    status: "PENDING",
  });
  // Invariant: a row that reached the outbox always gets a delivery attempt.
  // enqueueDelivery only *returns* false when REDIS_URL is unset — an unreachable
  // Redis (or bullmq missing from the slim bundle) THROWS, and an uncaught throw
  // here used to disable delivery entirely for the whole deployment.
  let queued = false;
  if (queueEnabled()) {
    try {
      queued = await enqueueDelivery(id);
    } catch (err) {
      logger.warn({ err, outboxId: id }, "notification enqueue failed — delivering inline");
    }
  }
  if (!queued) {
    // Inline fallback: bounded retry, and never terminal — a row that still fails
    // stays PENDING so the worker's reconciliation sweep can pick it up later.
    try {
      await processDeliveryInline(id);
    } catch (err) {
      logger.error({ err, outboxId: id, channel: input.channel }, "inline notification delivery failed");
    }
  }
}

/** Why a requested channel produced no outbox row at all. */
export type UnresolvedReason = "USER_NOT_FOUND" | "NO_EMAIL" | "NO_PHONE" | "ERROR";

/**
 * What `notify` actually managed to do. External channels resolve the contact
 * from `users`, so a recipient with no app user — or a user with no email/phone
 * on file — is delivered to NOBODY. Callers that publish a recipient count must
 * read `unresolved` rather than counting the rows they intended to reach.
 */
export interface NotifyResult {
  /** The in-app bell row was written. */
  inApp: boolean;
  /** Channels an outbox row was enqueued for. */
  queued: Channel[];
  /** Requested channels that resolved to no deliverable contact. */
  unresolved: Array<{ channel: Channel; reason: UnresolvedReason }>;
}

/**
 * Fan a single notification out to the bell + the requested external channels.
 * Best-effort and non-throwing: a delivery failure never breaks the caller's
 * request (it is recorded on the outbox row instead). The returned NotifyResult
 * reports what could not be resolved so the caller can be honest about it.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const result: NotifyResult = { inApp: false, queued: [], unresolved: [] };
  try {
    if (!input.skipInApp) {
      const id = newId();
      const createdAt = new Date();
      await db.insert(notificationsTable).values({
        id,
        userId: input.userId,
        title: input.title,
        body: input.body ?? null,
        type: input.type,
        link: input.link ?? null,
        isRead: false,
        createdAt,
      });
      // Live-push to any open bell (SSE) + the user's web-push subscriptions.
      emitNotification(input.userId, {
        id,
        title: input.title,
        body: input.body ?? null,
        type: input.type,
        link: input.link ?? null,
        createdAt: createdAt.toISOString(),
      });
      void pushToUser(input.userId, { title: input.title, body: input.body ?? null, link: input.link ?? null, type: input.type });
      result.inApp = true;
    }

    if (input.email || input.sms) {
      const [user] = await db
        .select({ email: usersTable.email, phone: usersTable.phone })
        .from(usersTable)
        .where(eq(usersTable.id, input.userId));

      // Contacts come from `users` only — there is no resident/guest directory
      // here, so an id that is not an app user reaches nobody. Say so.
      if (!user) {
        if (input.email) result.unresolved.push({ channel: "EMAIL", reason: "USER_NOT_FOUND" });
        if (input.sms) result.unresolved.push({ channel: "SMS", reason: "USER_NOT_FOUND" });
      } else {
        if (input.email && !user.email) result.unresolved.push({ channel: "EMAIL", reason: "NO_EMAIL" });
        if (input.sms && !user.phone) result.unresolved.push({ channel: "SMS", reason: "NO_PHONE" });
      }

      if (input.email && user?.email) {
        await enqueueAndSend({
          userId: input.userId,
          channel: "EMAIL",
          toAddress: user.email,
          subject: input.email.subject,
          body: input.email.text,
          entityType: input.entityType,
          entityId: input.entityId,
        });
        result.queued.push("EMAIL");
      }
      if (input.sms && user?.phone) {
        await enqueueAndSend({
          userId: input.userId,
          channel: "SMS",
          toAddress: user.phone,
          subject: null,
          body: input.sms,
          entityType: input.entityType,
          entityId: input.entityId,
        });
        result.queued.push("SMS");
      }
    }
  } catch (err) {
    logger.error({ err }, "notify failed");
    if (input.email && !result.queued.includes("EMAIL")) result.unresolved.push({ channel: "EMAIL", reason: "ERROR" });
    if (input.sms && !result.queued.includes("SMS")) result.unresolved.push({ channel: "SMS", reason: "ERROR" });
  }
  return result;
}

/** Per-recipient outcome of a fan-out (see `notifyAll`). */
export interface NotifyFanoutResult {
  /** Users an in-app row or an outbox row was actually written for. */
  reached: string[];
  /** Users the notification could not be delivered to, with the reason. */
  unresolved: Array<{ userId: string; reason: UnresolvedReason }>;
}

/**
 * Fan one notification out to many users and report who it actually reached.
 * A caller that publishes a recipient count (e.g. POST /menu/share) must report
 * `reached.length` — the ids it started from include people with no app user or
 * no contact on file, and those are delivered to nobody.
 */
export async function notifyAll(
  userIds: string[],
  input: Omit<NotifyInput, "userId">,
): Promise<NotifyFanoutResult> {
  const out: NotifyFanoutResult = { reached: [], unresolved: [] };
  const wantsExternal = !!(input.email || input.sms);
  for (const userId of userIds) {
    const res = await notify({ ...input, userId });
    const delivered = wantsExternal ? res.queued.length > 0 : res.inApp;
    if (delivered) out.reached.push(userId);
    else out.unresolved.push({ userId, reason: res.unresolved[0]?.reason ?? "ERROR" });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Order-lifecycle templates (Persona st.17/18/22/23)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OrderNotifyContext {
  unitLeadId: string;
  orderId: string;
  orderNumber: string;
  propertyName?: string | null;
  mealType: string;
  brand: string;
  /** Item lines for the dispatch email (Persona st.23). */
  items?: Array<{ name: string; qty: number | string; unit: string }>;
  /** Extra context for dispatch notification. */
  vehicleNumber?: string | null;
  driverName?: string | null;
  etaText?: string | null;
  reason?: string | null;
  /**
   * The order's `wasteEditableUntil` — the instant the wastage window CLOSES.
   * Quoted verbatim in the DELIVERED message so the unit lead is told the real
   * deadline instead of a relative hour they have to compute (pass it from the
   * order row; omitted falls back to "within 1 hour").
   */
  wasteWindowEndsAt?: Date | null;
}

const link = (id: string) => `/food/orders/${id}`;
const titleize = (s: string) =>
  s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** IST wall-clock 'HH:MM' for an instant — host-tz independent (see lib/tz.ts). */
function istClock(d: Date): string {
  const p = istParts(d);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")} IST`;
}

function itemsTable(items?: OrderNotifyContext["items"]): string {
  if (!items?.length) return "";
  const lines = items.map((i) => `  • ${i.name}: ${i.qty} ${i.unit}`);
  return `\n\nDispatched items:\n${lines.join("\n")}`;
}

type OrderEvent =
  | "PLACED"
  | "ACCEPTED"
  | "REJECTED"
  | "DISPATCHED"
  | "DELIVERED"
  | "CANCELLED";

/** Builds + sends the right notification for an order lifecycle transition. */
export async function notifyOrderEvent(
  event: OrderEvent,
  ctx: OrderNotifyContext,
): Promise<void> {
  const meal = titleize(ctx.mealType);
  const where = ctx.propertyName ? ` at ${ctx.propertyName}` : "";
  const ref = `${ctx.orderNumber} (${meal})`;
  // Wastage must be logged WITHIN the window that closes at wasteEditableUntil
  // (Persona-Unit-Lead.md:91) — name the instant when we know it.
  const wasteBy = ctx.wasteWindowEndsAt ? istClock(ctx.wasteWindowEndsAt) : null;

  const map: Record<OrderEvent, { title: string; body: string; subject: string; text: string }> = {
    PLACED: {
      title: "Order placed",
      body: `${ref} has been placed${where}.`,
      subject: `Order ${ctx.orderNumber} placed`,
      text: `Your ${meal} order ${ctx.orderNumber} has been placed${where}. You'll be notified as it progresses.`,
    },
    ACCEPTED: {
      title: "Order accepted",
      body: `${ref} was accepted by the kitchen.`,
      subject: `Order ${ctx.orderNumber} accepted`,
      text: `Good news — your ${meal} order ${ctx.orderNumber} was accepted by the kitchen.`,
    },
    REJECTED: {
      title: "Order rejected",
      body: `${ref} was rejected${ctx.reason ? `: ${ctx.reason}` : ""}.`,
      subject: `Order ${ctx.orderNumber} rejected`,
      text: `Your ${meal} order ${ctx.orderNumber} was rejected${ctx.reason ? `: ${ctx.reason}` : ""}. Please contact the kitchen.`,
    },
    DISPATCHED: {
      title: "Order dispatched",
      body: `${ref} is on the way${ctx.etaText ? ` — ETA ${ctx.etaText}` : ""}.`,
      subject: `Order ${ctx.orderNumber} dispatched`,
      text:
        `Your ${meal} order ${ctx.orderNumber} has been dispatched${where}.` +
        (ctx.vehicleNumber ? `\nVehicle: ${ctx.vehicleNumber}` : "") +
        (ctx.driverName ? `\nDriver: ${ctx.driverName}` : "") +
        (ctx.etaText ? `\nEstimated arrival: ${ctx.etaText}` : "") +
        itemsTable(ctx.items),
    },
    DELIVERED: {
      title: "Order delivered",
      body: `${ref} was delivered. Please record any wastage ${wasteBy ? `by ${wasteBy}` : "within 1 hour"}.`,
      subject: `Order ${ctx.orderNumber} delivered`,
      text: `Your ${meal} order ${ctx.orderNumber} was delivered${where}. You can record wastage ${wasteBy ? `until ${wasteBy}` : "for the next hour"}.`,
    },
    CANCELLED: {
      title: "Order cancelled",
      body: `${ref} was cancelled${ctx.reason ? `: ${ctx.reason}` : ""}.`,
      subject: `Order ${ctx.orderNumber} cancelled`,
      text: `Your ${meal} order ${ctx.orderNumber} was cancelled${ctx.reason ? `: ${ctx.reason}` : ""}.`,
    },
  };

  const m = map[event];
  await notify({
    userId: ctx.unitLeadId,
    title: m.title,
    body: m.body,
    type: "FOOD_ORDER",
    link: link(ctx.orderId),
    entityType: "FOOD_ORDER",
    entityId: ctx.orderId,
    email: { subject: m.subject, text: m.text },
  });
}

/**
 * A placed order was CHANGED before the cut-off (PUT /food/orders/:id).
 *
 * This is the one order message that does not go to the unit lead: they are the
 * one who just made the change. It goes to the kitchen side, because the numbers
 * they were given to cook have moved and nothing else tells them — the cook plan
 * simply reads differently the next time it is opened.
 *
 * `userIds` comes from resolveKitchenNotifyUserIds(); an empty list is a no-op,
 * so a kitchen with no scoped login costs nothing and never throws.
 */
export async function notifyOrderEdited(
  userIds: string[],
  ctx: OrderNotifyContext & { changeSummary: string },
): Promise<void> {
  if (!userIds.length) return;
  const meal = titleize(ctx.mealType);
  const ref = `${ctx.orderNumber} (${meal})`;
  const where = ctx.propertyName ? ` at ${ctx.propertyName}` : "";
  await notifyAll(userIds, {
    title: "Order updated",
    body: `${ref}${where} was updated — ${ctx.changeSummary}.`,
    type: "FOOD_ORDER",
    link: link(ctx.orderId),
    entityType: "FOOD_ORDER",
    entityId: ctx.orderId,
    email: {
      subject: `Order ${ctx.orderNumber} updated`,
      text: `${ref}${where} was updated before the cut-off.\n\n${ctx.changeSummary}.\n\nCook to the order's current quantities.`,
    },
  });
}
