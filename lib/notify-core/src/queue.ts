import { QUEUE_NAME } from "./types.js";

const REDIS_URL = process.env["REDIS_URL"];

/** Is the async queue configured? When false, callers deliver inline (fallback). */
export function queueEnabled(): boolean {
  return !!REDIS_URL;
}

// bullmq + ioredis are loaded LAZILY (variable specifier → esbuild leaves them
// external and never bundles a top-level require). The production api image runs
// a bundled file with no node_modules, so these must never be imported there;
// with REDIS_URL unset the queue is off and neither module is ever loaded. Only
// the notify-service worker (full node_modules) actually pulls them in.

/** A fresh ioredis connection. BullMQ requires maxRetriesPerRequest: null. */
export async function createConnection(): Promise<any> {
  const pkg = "ioredis";
  const mod: any = await import(pkg);
  const IORedis = mod.default ?? mod;
  return new IORedis(REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
}

let queue: any = null;
async function getQueue(): Promise<any> {
  if (!REDIS_URL) return null;
  if (!queue) {
    const pkg = "bullmq";
    const mod: any = await import(pkg);
    queue = new mod.Queue(QUEUE_NAME, { connection: await createConnection() });
  }
  return queue;
}

/** Retry policy for every delivery job (BullMQ owns the backoff schedule + DLQ). */
export const DEFAULT_JOB_OPTS = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * Enqueue a delivery job. The jobId is the outbox id, so re-enqueuing the same
 * row (e.g. from the reconciliation sweep) is idempotent. Returns false when no
 * queue is configured, signalling the caller to deliver inline instead.
 */
export async function enqueueDelivery(outboxId: string): Promise<boolean> {
  const q = await getQueue();
  if (!q) return false;
  await q.add("deliver", { outboxId }, { ...DEFAULT_JOB_OPTS, jobId: outboxId });
  return true;
}
