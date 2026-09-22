/**
 * The activity trail writer (PRD §29).
 *
 * Fire-and-forget by design, matching the contract the existing `writeAuditLog`
 * already states: a trail failure must never fail the mutation it records.
 * `recordActivityTx` is the in-transaction variant, required for chained
 * streams where the hash must be consistent with the write it describes.
 */
import { createHash } from "node:crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db, activityEventsTable } from "@workspace/db";
import { logger } from "../logger.js";
import { newId } from "../id.js";
import { httpError } from "../authz.js";
import { canonicalJson } from "../audit-events.js";
import { ACTIVITY_EVENTS, REDACT_KEYS, eventDef, type ActivityEventKey } from "./events.js";

const GENESIS = "GENESIS";

export interface ActivityCtx {
  actorId: string | null;
  actorRole: string | null;
  actorIp?: string | null;
  requestId?: string | null;
}

export function activityCtx(req: Request): ActivityCtx {
  return {
    actorId: req.user?.id ?? null,
    actorRole: req.user?.role ?? null,
    actorIp: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null,
    requestId: (req as { id?: string }).id ?? null,
  };
}

export interface ActivityInput {
  event: ActivityEventKey | (string & {});
  entityId?: string | null;
  entityLabel?: string | null;
  nodeId?: string | null;
  propertyId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Strip anything in REDACT_KEYS, recursively, before it reaches the trail. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

/** Shallow diff of the keys that actually moved. */
function changedKeys(before: unknown, after: unknown): string[] | null {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return null;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const moved = keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  return moved.length ? moved : null;
}

type Tx = Pick<typeof db, "select" | "insert" | "execute">;

async function buildRow(input: ActivityInput, ctx: ActivityCtx) {
  const def = eventDef(input.event);
  if (!def) {
    // Never silently drop: an unregistered event is a bug in dev/test and a
    // loud, still-recorded anomaly in production.
    if (process.env["NODE_ENV"] !== "production") {
      throw new Error(`activity: unregistered event "${input.event}" — add it to ACTIVITY_EVENTS`);
    }
    logger.warn({ event: input.event }, "activity: unregistered event");
  }
  if (def?.reasonRequired && !input.reason) {
    throw httpError(400, `A reason is required for ${input.event}`, { code: "REASON_REQUIRED" });
  }

  const before = input.before === undefined ? null : redact(input.before);
  const after = input.after === undefined ? null : redact(input.after);

  return {
    id: newId(),
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    actorIp: ctx.actorIp ?? null,
    event: input.event,
    category: def?.category ?? "DATA",
    entityType: def?.entityType ?? "unknown",
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? null,
    nodeId: input.nodeId ?? null,
    propertyId: input.propertyId ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    beforeJson: before,
    afterJson: after,
    changedKeys: changedKeys(input.before, input.after),
    reason: input.reason ?? null,
    requestId: ctx.requestId ?? null,
    chainKey: def?.chainKey ?? null,
  };
}

/**
 * In-transaction write. Required for chained streams: the lock is taken on the
 * caller's transaction, so the hash and the change it describes commit together
 * or not at all.
 */
export async function recordActivityTx(tx: Tx, ctx: ActivityCtx, input: ActivityInput): Promise<void> {
  const row = await buildRow(input, ctx);

  if (row.chainKey) {
    // PER-STREAM lock, not one global key. audit_events serialises every write
    // in the product behind pg_advisory_xact_lock(74441001); keying on the
    // stream means an ACCESS append never waits on unrelated traffic.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.chainKey}))`);
    const [head] = await tx
      .select({ hash: activityEventsTable.hash })
      .from(activityEventsTable)
      .where(sql`${activityEventsTable.chainKey} = ${row.chainKey}`)
      .orderBy(sql`${activityEventsTable.seq} DESC`)
      .limit(1);
    const prevHash = head?.hash ?? GENESIS;
    const hash = createHash("sha256")
      .update(prevHash + canonicalJson({ ...row, hash: undefined, prevHash: undefined }))
      .digest("hex");
    await tx.insert(activityEventsTable).values({ ...row, prevHash, hash });
    return;
  }

  await tx.insert(activityEventsTable).values(row);
}

/**
 * Fire-and-forget write. Never throws, never awaited by the caller — except for
 * a missing required reason, which IS the caller's bug and surfaces as a 400
 * before anything is written.
 */
export function recordActivity(ctx: ActivityCtx, input: ActivityInput): void {
  const def = eventDef(input.event);
  if (def?.reasonRequired && !input.reason) {
    throw httpError(400, `A reason is required for ${input.event}`, { code: "REASON_REQUIRED" });
  }
  void recordActivityTx(db as unknown as Tx, ctx, input).catch((err) => {
    logger.warn({ err, event: input.event }, "activity trail write failed");
  });
}

export { ACTIVITY_EVENTS };
