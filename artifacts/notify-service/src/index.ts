/**
 * Notification delivery worker — the dedicated dispatch service.
 *
 * Consumes the BullMQ "notifications" queue and delivers each notification_outbox
 * row with retries + exponential backoff (BullMQ owns the schedule + DLQ). Also
 * runs a reconciliation sweep that re-enqueues rows the producer wrote while the
 * queue was briefly unavailable (or that a Redis restart dropped). Stateless, so
 * it scales horizontally — run N replicas against the same Redis.
 *
 * Run: tsx src/index.ts  (needs DATABASE_URL + REDIS_URL in the environment)
 */
import http from "node:http";
import { Worker, type Job } from "bullmq";
import { and, eq, lt } from "drizzle-orm";
import { db, notificationOutboxTable } from "@workspace/db";
import { QUEUE_NAME, processDelivery, enqueueDelivery, createConnection, type DeliveryJob } from "@workspace/notify-core";

const CONCURRENCY = Number(process.env["NOTIFY_WORKER_CONCURRENCY"] || 10);
const MAX_ATTEMPTS = 6;
const HEALTH_PORT = Number(process.env["NOTIFY_HEALTH_PORT"] || 8091);

const worker = new Worker<DeliveryJob>(
  QUEUE_NAME,
  async (job: Job<DeliveryJob>) => {
    const attemptNo = job.attemptsMade + 1;
    const isLastAttempt = attemptNo >= (job.opts.attempts ?? MAX_ATTEMPTS);
    await processDelivery(job.data.outboxId, { attemptNo, isLastAttempt });
  },
  { connection: await createConnection(), concurrency: CONCURRENCY },
);

worker.on("completed", (job) => console.info(`[notify-service] delivered ${job.data.outboxId}`));
worker.on("failed", (job, err) => console.warn(`[notify-service] attempt failed for ${job?.data?.outboxId}: ${err?.message}`));
worker.on("error", (err) => console.error(`[notify-service] worker error: ${err?.message}`));

/**
 * Re-enqueue rows still PENDING after a grace period. Covers a producer enqueue
 * that never reached Redis, or jobs lost to a Redis flush — the Postgres outbox
 * stays the durable source of truth.
 */
const RECONCILE_MS = 60_000;
const GRACE_MS = 2 * 60_000;
async function reconcile(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - GRACE_MS);
    const stuck = await db
      .select({ id: notificationOutboxTable.id })
      .from(notificationOutboxTable)
      .where(and(eq(notificationOutboxTable.status, "PENDING"), lt(notificationOutboxTable.createdAt, cutoff)))
      .limit(200);
    for (const row of stuck) await enqueueDelivery(row.id);
    if (stuck.length) console.info(`[notify-service] reconciled ${stuck.length} pending row(s)`);
  } catch (err) {
    console.warn(`[notify-service] reconcile error: ${(err as Error)?.message}`);
  }
}
const reconcileTimer = setInterval(reconcile, RECONCILE_MS);

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, queue: QUEUE_NAME, concurrency: CONCURRENCY }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(HEALTH_PORT, () => console.info(`[notify-service] up (concurrency=${CONCURRENCY}); health on :${HEALTH_PORT}; queue=${QUEUE_NAME}`));

async function shutdown(): Promise<void> {
  console.info("[notify-service] shutting down…");
  clearInterval(reconcileTimer);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
