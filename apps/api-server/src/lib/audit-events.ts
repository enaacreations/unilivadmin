/**
 * Audit & Inspection — append-only, hash-chained event trail (FRD-TRL-01).
 *
 * Single global chain: every event stores the previous event's hash and its own
 * hash = sha256(prevHash + canonicalJson(payload)). Integrity comes from the
 * prevHash linkage — `seq` (bigserial) is ordering only, so sequence gaps from
 * aborted transactions are harmless. Appends run inside the caller's
 * transaction under a pg advisory xact lock that serializes the chain head.
 *
 * Every state transition, assignment, score freeze, config change, grant
 * change, notification/reminder/escalation send and share is appended here.
 * Config mutations funnel through writeConfigChange() (FR-AD-10).
 */
import { createHash } from "crypto";
import { sql, asc, gt } from "drizzle-orm";
import { db, auditEventsTable } from "@workspace/db";
import { newId } from "./id.js";

type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbLike = Db | Tx;

/** Arbitrary constant identifying the audit-events chain-head advisory lock. */
const CHAIN_LOCK_KEY = 744_410_01;

const GENESIS_HASH = "GENESIS";

export type AuditEventKind =
  | "STATE_CHANGE"
  | "ASSIGNMENT"
  | "SCORE_FREEZE"
  | "CONFIG_CHANGE"
  | "GRANT_CHANGE"
  | "NOTIFY"
  | "REMINDER"
  | "ESCALATION"
  | "SHARE"
  | "DENIED_ATTEMPT"
  | "COMMENT";

export interface AuditEventInput {
  entityType: string;
  entityId: string;
  /** Set when the event belongs to an audit's timeline (Activity tab). */
  auditId?: string | null;
  /** Null/undefined = system actor (P6). */
  actorId?: string | null;
  actorRole?: string | null;
  kind: AuditEventKind;
  fromState?: string | null;
  toState?: string | null;
  reason?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
}

/**
 * Deterministic JSON: the value is first round-tripped through JSON so the
 * hashed payload matches exactly what a json column stores and returns
 * (Dates → ISO strings, undefined dropped, class instances → plain objects),
 * then object keys are sorted recursively so key order never changes the hash.
 */
export function canonicalJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(sortValue(normalized));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}

function hashEvent(prevHash: string, payload: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalJson(payload))
    .digest("hex");
}

/**
 * Append one event to the chain. MUST be called inside a transaction — the
 * advisory xact lock serializes concurrent appends and releases on commit.
 */
export async function appendAuditEvent(
  tx: DbLike,
  input: AuditEventInput,
): Promise<{ id: string; hash: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`);

  const [head] = await tx
    .select({ hash: auditEventsTable.hash })
    .from(auditEventsTable)
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  const prevHash = head?.hash ?? GENESIS_HASH;

  const createdAt = new Date();
  const payload = {
    entityType: input.entityType,
    entityId: input.entityId,
    auditId: input.auditId ?? null,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    kind: input.kind,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    reason: input.reason ?? null,
    beforeJson: input.beforeJson ?? null,
    afterJson: input.afterJson ?? null,
    createdAt: createdAt.toISOString(),
  };

  const id = newId();
  const hash = hashEvent(prevHash, payload);
  await tx.insert(auditEventsTable).values({
    id,
    entityType: payload.entityType,
    entityId: payload.entityId,
    auditId: payload.auditId,
    actorId: payload.actorId,
    actorRole: payload.actorRole,
    kind: input.kind,
    fromState: payload.fromState,
    toState: payload.toState,
    reason: payload.reason,
    beforeJson: payload.beforeJson,
    afterJson: payload.afterJson,
    prevHash,
    hash,
    createdAt,
  });
  return { id, hash };
}

/**
 * Convenience wrapper for events outside an existing transaction (e.g. denied
 * attempts logged after a failed guard, reminder sends from jobs).
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, input);
  });
}

/**
 * Every FR-AD-01…08 mutation records actor + before/after (FR-AD-10); visible
 * in the trail explorer alongside state changes.
 */
export async function writeConfigChange(
  tx: DbLike,
  opts: {
    entityType: string;
    entityId: string;
    actorId: string | null;
    actorRole?: string | null;
    before: unknown;
    after: unknown;
    reason?: string | null;
    kind?: Extract<AuditEventKind, "CONFIG_CHANGE" | "GRANT_CHANGE">;
  },
): Promise<void> {
  await appendAuditEvent(tx, {
    entityType: opts.entityType,
    entityId: opts.entityId,
    actorId: opts.actorId,
    actorRole: opts.actorRole ?? null,
    kind: opts.kind ?? "CONFIG_CHANGE",
    reason: opts.reason ?? null,
    beforeJson: opts.before ?? null,
    afterJson: opts.after ?? null,
  });
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** seq of the first event whose prevHash/hash fails verification. */
  firstBrokenSeq?: number;
  verifiedAt: string;
}

/**
 * Walk the chain in seq order and recompute every hash (FR-AD-09 indicator).
 * Batched so a large trail doesn't need to fit in memory.
 */
export async function verifyChain(): Promise<ChainVerification> {
  const BATCH = 1000;
  let prevHash = GENESIS_HASH;
  let lastSeq = -1;
  let checked = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(auditEventsTable)
      .where(gt(auditEventsTable.seq, lastSeq))
      .orderBy(asc(auditEventsTable.seq))
      .limit(BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      const payload = {
        entityType: row.entityType,
        entityId: row.entityId,
        auditId: row.auditId,
        actorId: row.actorId,
        actorRole: row.actorRole,
        kind: row.kind,
        fromState: row.fromState,
        toState: row.toState,
        reason: row.reason,
        beforeJson: row.beforeJson ?? null,
        afterJson: row.afterJson ?? null,
        createdAt: row.createdAt.toISOString(),
      };
      const expected = hashEvent(prevHash, payload);
      if (row.prevHash !== prevHash || row.hash !== expected) {
        return {
          valid: false,
          checked,
          firstBrokenSeq: row.seq,
          verifiedAt: new Date().toISOString(),
        };
      }
      prevHash = row.hash;
      lastSeq = row.seq;
      checked += 1;
    }
    if (rows.length < BATCH) break;
  }

  return { valid: true, checked, verifiedAt: new Date().toISOString() };
}
