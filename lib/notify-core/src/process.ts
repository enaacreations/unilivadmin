import { db, notificationOutboxTable } from "@workspace/db";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { deliver, isNonRetryable } from "./providers.js";
import { DEFAULT_JOB_OPTS, enqueueDelivery, queueEnabled } from "./queue.js";
import { isSuppressed } from "./suppression.js";
import type { OutboxRow } from "./types.js";

/**
 * Total delivery attempts a single outbox row ever gets, across every retry path
 * (queue worker, request-path inline retry, api sweep). Invariant: one shared
 * attempt budget, so a row that can never be delivered reaches a TERMINAL state
 * instead of being re-attempted by every sweep forever. Same number as the
 * worker's BullMQ budget so the two paths give up at the same point.
 */
export const MAX_DELIVERY_ATTEMPTS = DEFAULT_JOB_OPTS.attempts;

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

/** Bounded retry for the inline (no-queue) path. */
export interface InlineRetryPolicy {
  attempts: number;
  /** First backoff step; doubled per attempt. */
  baseDelayMs: number;
}

/**
 * Deliberately tighter than the worker's DEFAULT_JOB_OPTS (6 × 30s exponential):
 * these attempts run inside the caller's request, so the worst case is ~1.2s.
 */
export const DEFAULT_INLINE_RETRY: InlineRetryPolicy = { attempts: 3, baseDelayMs: 400 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deliver inline with retry/backoff, for deployments with no queue (or when the
 * queue is unreachable). Invariant: the request path is never terminal — every
 * attempt passes isLastAttempt:false so a failed row stays PENDING and remains
 * retryable by the sweep, which owns the terminal decision once the shared
 * MAX_DELIVERY_ATTEMPTS budget is spent. Rethrows the last error so the caller
 * can log it.
 */
export async function processDeliveryInline(
  outboxId: string,
  policy: InlineRetryPolicy = DEFAULT_INLINE_RETRY,
): Promise<void> {
  for (let attemptNo = 1; ; attemptNo++) {
    try {
      await processDelivery(outboxId, { attemptNo, isLastAttempt: false });
      return;
    } catch (err) {
      // A deterministic failure (no provider configured for the channel) cannot
      // become success by waiting. Retrying it added ~1.2s of blocking backoff
      // and ~9 queries to EVERY order accept/reject/dispatch/deliver in the
      // fail-closed default deployment — and ~48s to a 40-resident menu share.
      // The row stays PENDING either way, so the sweep still owns the retry.
      if (isNonRetryable(err) || attemptNo >= policy.attempts) throw err;
      await sleep(policy.baseDelayMs * 2 ** (attemptNo - 1));
    }
  }
}

/** Hard ceiling on rows touched per sweep, so a backlog can never unbound one pass. */
const MAX_SWEEP_BATCH = 500;

/** How long a PENDING row is left to the producer/worker before a sweep claims it. */
export const DEFAULT_SWEEP_GRACE_MS = 2 * 60_000;

/**
 * The `created_at <` bound for "PENDING for longer than graceMs".
 *
 * Invariant: the grace window is exactly graceMs, whatever the database's
 * timezone is. `notification_outbox.created_at` is `timestamp` WITHOUT time zone
 * and is filled by the column's own `DEFAULT now()`, which renders in the DB
 * SESSION timezone — pinned to UTC in lib/db/src/index.ts, the same clock
 * Drizzle serialises a JS `Date` onto.
 *
 * `localtimestamp` is therefore not a correction for a skew any more (the pin
 * removed it); it stays because it keeps the comparison on the DB side of the
 * wire, as a plain timestamp/timestamp expression, so the
 * notification_outbox(status, created_at) index is still usable. Do not "simplify"
 * it to a JS-side Date: that is only equivalent while the pin holds, and it
 * re-introduces the original bug the moment a session sets another TimeZone.
 * (Before the pin the session was Asia/Kolkata and the two clocks were 5h30m
 * apart, making the real grace 5h32m — the outbox went unswept for most of a shift.)
 */
export function outboxAgeCutoff(graceMs: number) {
  const secs = Math.max(graceMs, 0) / 1000;
  return sql`localtimestamp - make_interval(secs => ${secs}::double precision)`;
}

/**
 * Re-attempt outbox rows still PENDING after a grace period — the drain the
 * outbox pattern needs to actually be durable. Invariant: a committed PENDING
 * row is always retried by SOMEONE. The notify-service worker sweeps when it is
 * running; this is the same sweep for the api process (wired into the
 * RUN_SCHEDULERS block in apps/api-server/src/index.ts) so a deployment without
 * the worker still delivers. Re-enqueues when a queue is configured, otherwise
 * delivers it here. Never throws — returns how many rows it acted on.
 *
 * Bounded on every axis, because this runs once a minute forever:
 *  - oldest-first ORDER BY, so a backlog drains deterministically instead of
 *    letting Postgres re-serve the same arbitrary page each pass;
 *  - one attempt per row per pass, charged against MAX_DELIVERY_ATTEMPTS, after
 *    which the row is marked FAILED (terminal) with its lastError preserved;
 *  - a batch cap, so one pass can never grow without bound.
 */
export async function sweepPendingOutbox(
  opts: { graceMs?: number; limit?: number } = {},
): Promise<number> {
  const cutoff = outboxAgeCutoff(opts.graceMs ?? DEFAULT_SWEEP_GRACE_MS);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), MAX_SWEEP_BATCH);
  // Invariant: "never throws" — the only caller is a setInterval tick in
  // apps/api-server/src/index.ts with no .catch(), so a rejection here (an
  // unreachable database is the realistic one) is an unhandled rejection that
  // can take the api process down. The per-row work below is already guarded;
  // this select was not.
  let stuck: { id: string; attempts: number }[];
  try {
    stuck = await db
      .select({ id: notificationOutboxTable.id, attempts: notificationOutboxTable.attempts })
      .from(notificationOutboxTable)
      .where(and(eq(notificationOutboxTable.status, "PENDING"), lt(notificationOutboxTable.createdAt, cutoff)))
      // Deterministic oldest-first (id breaks ties); needs the
      // notification_outbox(status, created_at) index to stay cheap.
      .orderBy(asc(notificationOutboxTable.createdAt), asc(notificationOutboxTable.id))
      .limit(limit);
  } catch (err) {
    console.warn(`[notify] outbox sweep query failed: ${(err as Error)?.message ?? err}`);
    return 0;
  }

  let acted = 0;
  for (const row of stuck) {
    try {
      // Budget spent → terminal. Guarded on status so it can never overwrite a
      // SENT/SKIPPED row a concurrent worker just settled.
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await db
          .update(notificationOutboxTable)
          .set({ status: "FAILED" })
          .where(and(eq(notificationOutboxTable.id, row.id), eq(notificationOutboxTable.status, "PENDING")));
        acted++;
        continue;
      }

      // A queued row is the worker's problem: BullMQ owns its own bounded retry
      // schedule and marks the row FAILED on its last attempt, so re-enqueuing
      // (idempotent — jobId is the outbox id) must NOT also spend sweep budget.
      if (queueEnabled()) {
        try {
          if (await enqueueDelivery(row.id)) {
            acted++;
            continue;
          }
        } catch {
          // Redis unreachable — deliver inline rather than skip the row.
        }
      }

      // Atomic claim: bump attempts only if the row is still PENDING with the
      // attempt count we read. Two sweepers (api + worker, or two api replicas)
      // therefore cannot both deliver the same row.
      const attemptNo = row.attempts + 1;
      const claimed = await db
        .update(notificationOutboxTable)
        .set({ attempts: attemptNo })
        .where(
          and(
            eq(notificationOutboxTable.id, row.id),
            eq(notificationOutboxTable.status, "PENDING"),
            eq(notificationOutboxTable.attempts, row.attempts),
          ),
        )
        .returning({ id: notificationOutboxTable.id });
      if (!claimed.length) continue;
      acted++;
      // One attempt per pass — the sweep interval IS the backoff, so there is no
      // reason to also sleep inside the request-free scheduler tick.
      await processDelivery(row.id, { attemptNo, isLastAttempt: attemptNo >= MAX_DELIVERY_ATTEMPTS });
    } catch {
      // Recorded on the row (status + lastError); the next sweep picks it up
      // until the shared attempt budget runs out.
    }
  }
  return acted;
}
