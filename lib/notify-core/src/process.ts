import { db, notificationOutboxTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { deliver } from "./providers.js";
import { isSuppressed } from "./suppression.js";
import type { OutboxRow } from "./types.js";

export interface AttemptCtx {
  /** 1-based attempt number, recorded on the outbox row. */
  attemptNo: number;
  /** When true, a failure marks the row FAILED (terminal) rather than PENDING. */
  isLastAttempt: boolean;
}

/**
 * Loads an outbox row, delivers it, and records the outcome. Idempotent — a row
 * already SENT/SKIPPED is a no-op (safe for retries and at-least-once queues).
 * Throws on delivery failure so a queue worker can retry; only the final attempt
 * marks the row FAILED.
 */
export async function processDelivery(
  outboxId: string,
  ctx: AttemptCtx = { attemptNo: 1, isLastAttempt: true },
): Promise<void> {
  const [row] = await db.select().from(notificationOutboxTable).where(eq(notificationOutboxTable.id, outboxId));
  if (!row) return;
  if (row.status === "SENT" || row.status === "SKIPPED") return;

  // Deliverability: never send to a hard-bounced / complained / opted-out address.
  if (await isSuppressed(row.channel, row.toAddress)) {
    await db
      .update(notificationOutboxTable)
      .set({ status: "SKIPPED", lastError: "recipient suppressed", attempts: ctx.attemptNo })
      .where(eq(notificationOutboxTable.id, outboxId));
    return;
  }

  try {
    const providerMessageId = await deliver(row as OutboxRow);
    await db
      .update(notificationOutboxTable)
      .set({ status: "SENT", providerMessageId, sentAt: new Date(), attempts: ctx.attemptNo })
      .where(eq(notificationOutboxTable.id, outboxId));
  } catch (err) {
    await db
      .update(notificationOutboxTable)
      .set({
        status: ctx.isLastAttempt ? "FAILED" : "PENDING",
        lastError: String((err as Error)?.message ?? err),
        attempts: ctx.attemptNo,
      })
      .where(eq(notificationOutboxTable.id, outboxId));
    throw err;
  }
}
