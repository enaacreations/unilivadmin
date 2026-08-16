import crypto from "node:crypto";
import { db, notificationSuppressionsTable, type NotificationSuppression } from "@workspace/db";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Channel } from "./types.js";

export type SuppressionReason = "HARD_BOUNCE" | "COMPLAINT" | "UNSUBSCRIBED" | "INVALID";

/**
 * Invariant: an entry only blocks delivery while it is ACTIVE and UNEXPIRED. One
 * provider bounce must not silence an address forever with no way back — an
 * operator can clear it (`clearSuppression`) or it can lapse on its own TTL.
 */
const blocking = () =>
  and(
    eq(notificationSuppressionsTable.isActive, true),
    or(isNull(notificationSuppressionsTable.expiresAt), gt(notificationSuppressionsTable.expiresAt, new Date())),
  );

/** Case-insensitive match on the stored (lower-cased) address. */
const sameAddress = (address: string) =>
  sql`lower(${notificationSuppressionsTable.address}) = ${address.toLowerCase()}`;

/** Is this address blocked for this channel (hard bounce / complaint / opt-out)? */
export async function isSuppressed(channel: Channel, address: string | null): Promise<boolean> {
  if (!address) return false;
  const [row] = await db
    .select({ id: notificationSuppressionsTable.id })
    .from(notificationSuppressionsTable)
    .where(and(eq(notificationSuppressionsTable.channel, channel), sameAddress(address), blocking()))
    .limit(1);
  return !!row;
}

/**
 * Add an address to the suppression list (idempotent on channel+address). A
 * repeat bounce re-activates a previously cleared entry — otherwise the unique
 * constraint would silently keep a cleared address deliverable forever.
 * `expiresAt` gives the entry a TTL; null (default) means it holds until cleared.
 */
export async function suppress(
  channel: Channel,
  address: string,
  reason: SuppressionReason,
  detail?: string,
  expiresAt?: Date | null,
): Promise<void> {
  await db
    .insert(notificationSuppressionsTable)
    .values({
      id: crypto.randomUUID(),
      channel,
      address: address.toLowerCase(),
      reason,
      detail: detail ?? null,
      expiresAt: expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [notificationSuppressionsTable.channel, notificationSuppressionsTable.address],
      set: { reason, detail: detail ?? null, expiresAt: expiresAt ?? null, isActive: true },
    });
}

/**
 * Operator surface: the suppression list. Defaults to entries that are actually
 * blocking right now; `includeCleared` also returns cleared/expired history.
 */
export async function listSuppressions(opts: {
  channel?: Channel;
  address?: string;
  includeCleared?: boolean;
  limit?: number;
} = {}): Promise<NotificationSuppression[]> {
  const filters = [
    opts.channel ? eq(notificationSuppressionsTable.channel, opts.channel) : undefined,
    opts.address ? sameAddress(opts.address) : undefined,
    opts.includeCleared ? undefined : blocking(),
  ].filter(Boolean);
  return db
    .select()
    .from(notificationSuppressionsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(notificationSuppressionsTable.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));
}

/**
 * Operator surface: lift a suppression so the address can receive again. The row
 * is deactivated rather than deleted, so the bounce history survives the clear.
 * Returns the number of entries cleared (0 = nothing was blocking).
 */
export async function clearSuppression(channel: Channel, address: string): Promise<number> {
  const cleared = await db
    .update(notificationSuppressionsTable)
    .set({ isActive: false })
    .where(
      and(
        eq(notificationSuppressionsTable.channel, channel),
        sameAddress(address),
        eq(notificationSuppressionsTable.isActive, true),
      ),
    )
    .returning({ id: notificationSuppressionsTable.id });
  return cleared.length;
}
