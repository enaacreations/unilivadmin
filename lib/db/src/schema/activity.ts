import { pgTable, text, timestamp, json, bigserial, index } from "drizzle-orm/pg-core";

/* ────────────────────────────────────────────────────────────────────────────
 * Platform activity trail (PRD §29).
 *
 * A THIRD table, deliberately, because neither existing trail can take this on:
 *
 *  - `audit_log` (system.ts) has no indexes, no `reason`, no before/after split
 *    (one opaque `changes` blob) and no property scoping. Adding all of that is
 *    a new table wearing an old name, and its ~20 call sites would need their
 *    payloads reshaped anyway.
 *
 *  - `audit_events` (audit.ts) is hash-chained through ONE global advisory lock
 *    (pg_advisory_xact_lock(74441001)) taken inside every caller's transaction.
 *    Routing org-wide event families through it makes that lock the write mutex
 *    of the whole product, and verifyChain() would walk all of history. Its
 *    `kind` is also a pg enum, so each new event family becomes a schema
 *    deploy — precisely the "13 bespoke edits that rot" this is meant to avoid.
 *
 * So `audit_events` stays the Audit module's compliance-grade chain, `audit_log`
 * is read through an adapter during migration, and this is the platform trail.
 * ──────────────────────────────────────────────────────────────────────────── */

export const activityEventsTable = pgTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    /** Ordering only; gaps from aborted transactions are harmless. */
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),

    // ── WHO ──
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    actorIp: text("actor_ip"),

    // ── WHAT ──
    // `event` and `category` are plain TEXT, not pg enums. A new event family
    // must be a code-registry entry, never an ALTER TYPE + deploy. This is the
    // lesson of audit_events.kind, learned the expensive way.
    event: text("event").notNull(),
    category: text("category").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Denormalised: entities get renamed and deleted, the log must still read. */
    entityLabel: text("entity_label"),

    // ── WHERE — the scoping audit_log never had ──
    nodeId: text("node_id"),
    propertyId: text("property_id"),

    // ── THE CHANGE ──
    fromState: text("from_state"),
    toState: text("to_state"),
    beforeJson: json("before_json"),
    afterJson: json("after_json"),
    changedKeys: json("changed_keys").$type<string[]>(),
    /** PRD §29's "Reason where required" — enforced by the event registry. */
    reason: text("reason"),

    // ── CORRELATION ──
    requestId: text("request_id"),

    // ── OPTIONAL PER-STREAM TAMPER EVIDENCE ──
    // Null for ordinary rows. When set, the writer takes a lock keyed on THIS
    // stream rather than one global lock, so an ACCESS chain never serialises
    // against LIFECYCLE traffic.
    chainKey: text("chain_key"),
    prevHash: text("prev_hash"),
    hash: text("hash"),
  },
  (t) => [
    index("activity_events_occurred_idx").on(t.occurredAt),
    index("activity_events_actor_idx").on(t.actorId, t.occurredAt),
    index("activity_events_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("activity_events_event_idx").on(t.event, t.occurredAt),
    index("activity_events_property_idx").on(t.propertyId, t.occurredAt),
    index("activity_events_category_idx").on(t.category, t.occurredAt),
    index("activity_events_chain_idx").on(t.chainKey, t.seq),
  ],
);
