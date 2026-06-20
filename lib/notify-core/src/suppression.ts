import crypto from "node:crypto";
import { db, notificationSuppressionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { Channel } from "./types.js";

export type SuppressionReason = "HARD_BOUNCE" | "COMPLAINT" | "UNSUBSCRIBED" | "INVALID";

/** Is this address blocked for this channel (hard bounce / complaint / opt-out)? */
export async function isSuppressed(channel: Channel, address: string | null): Promise<boolean> {
  if (!address) return false;
  const [row] = await db
    .select({ id: notificationSuppressionsTable.id })
    .from(notificationSuppressionsTable)
    .where(
      and(
        eq(notificationSuppressionsTable.channel, channel),
        sql`lower(${notificationSuppressionsTable.address}) = ${address.toLowerCase()}`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Add an address to the suppression list (idempotent on channel+address). */
export async function suppress(
  channel: Channel,
  address: string,
  reason: SuppressionReason,
  detail?: string,
): Promise<void> {
  await db
    .insert(notificationSuppressionsTable)
    .values({ id: crypto.randomUUID(), channel, address: address.toLowerCase(), reason, detail: detail ?? null })
    .onConflictDoNothing();
}
