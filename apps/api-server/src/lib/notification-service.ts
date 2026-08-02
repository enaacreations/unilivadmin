/**
 * Notification & outbound-message engine.
 *
 * Single entry point (`notify`) that:
 *   1. writes an in-app row (`notifications`) that the bell already polls, and
 *   2. enqueues an outbox row (`notification_outbox`) per external channel
 *      (EMAIL/SMS/PUSH) and attempts delivery through a pluggable transport.
 *
 * The outbox is the durable source of truth + audit; a real provider can be
 * wired by setting SMTP_/TWILIO_ env (see `deliver`). Absent credentials we run
 * a "log" transport that records the rendered message and marks it SENT so the
 * flow is fully exercised in dev without leaking anything.
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
import { enqueueDelivery, processDelivery, queueEnabled } from "@workspace/notify-core";
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
  if (queueEnabled()) {
    const queued = await enqueueDelivery(id);
    if (!queued) await processDelivery(id); // safety net if the queue refused the job
  } else {
    await processDelivery(id); // inline fallback — single attempt, no retry
  }
}

/**
 * Fan a single notification out to the bell + the requested external channels.
 * Best-effort and non-throwing: a delivery failure never breaks the caller's
 * request (it is recorded on the outbox row instead).
 */
export async function notify(input: NotifyInput): Promise<void> {
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
    }

    if (input.email || input.sms) {
      const [user] = await db
        .select({ email: usersTable.email, phone: usersTable.phone })
        .from(usersTable)
        .where(eq(usersTable.id, input.userId));

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
      }
    }
  } catch (err) {
    logger.error({ err }, "notify failed");
  }
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
}

const link = (id: string) => `/food/orders/${id}`;
const titleize = (s: string) =>
  s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

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
      body: `${ref} was delivered. Please record any wastage within 1 hour.`,
      subject: `Order ${ctx.orderNumber} delivered`,
      text: `Your ${meal} order ${ctx.orderNumber} was delivered${where}. You can record wastage for the next hour.`,
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
