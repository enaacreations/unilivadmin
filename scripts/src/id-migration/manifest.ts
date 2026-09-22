/**
 * The id surface of this database, classified — the machine-readable half of
 * ID_MIGRATION_PLAN.md §4.
 *
 * Every entry here was derived from REAL DEV DATA (see `id:json-audit`, which
 * regenerates the evidence) or, where a column holds no rows yet, from the
 * writer code that populates it. Each carries an `evidence` field saying which,
 * so a reader never has to guess whether a classification was observed or
 * assumed.
 *
 * Three surfaces, not one. §4 of the plan inventories only the first:
 *
 *   1. JSON_COLUMNS      — entity ids nested inside json/jsonb payloads.
 *   2. POINTER_COLUMNS   — plain text columns holding an entity id with NO
 *                          foreign key constraint. FK analysis cannot see these;
 *                          there are 60 of them carrying data in dev, against
 *                          177 constrained edges.
 *   3. DERIVED_KEYS      — ids interpolated into composite strings that are then
 *                          used as IDEMPOTENCY keys. These are the dangerous
 *                          ones: nothing errors, the key simply stops matching
 *                          and the guarded operation runs a second time.
 *
 * The verdicts mean:
 *
 *   REWRITE   live config / live state — the value is looked up. Point it at the
 *             new id or the lookup silently stops matching.
 *   PRESERVE  a historical record, a hash-chain input, or an opaque token.
 *             Rewriting it is falsification, not migration. It keeps its legacy
 *             id and resolves through the retained `legacy_id` column.
 *   NO_IDS    verified to contain no entity ids at all.
 *   BLOCKED   known to be able to hold ids, but no data has ever been observed
 *             and the shape is not statically knowable. `id:migrate` ABORTS if
 *             it finds a uuid here rather than guessing at a path.
 *
 * Fail-closed, deliberately: the migration re-derives surfaces 2 and 3 from the
 * live catalogue at run time and refuses to proceed if it meets a uuid-bearing
 * column this file does not classify. A column added after this file was written
 * is therefore a loud abort, not a silent omission.
 */

/** Whole-value uuid. Anchored — see EMBEDDED_UUID for the substring form. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unanchored, for ids embedded in a larger string (`/food/orders/<uuid>`). */
export const EMBEDDED_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type Verdict = "REWRITE" | "PRESERVE" | "NO_IDS" | "BLOCKED";
export type Evidence = "VERIFIED-FROM-DATA" | "STILL-INFERRED";

/**
 * A JSON location, in the subset of JSONPath this migration needs:
 *
 *   `$.ids[*]`            every element of the `ids` array
 *   `$.within.{*}`        every KEY of the `within` object — see note below
 *   `$.within.{*}[*]`     every element of every array under `within`
 *   `$.{*}.{*}`           two levels of wildcard keys, value at the leaf
 *
 * `{*}` matching a KEY rather than a value is not decoration. `scope_json`
 * stores its narrowing map as `{within: {"<anchorId>": ["<roomId>", …]}}`, so
 * half the ids in that column are object keys. A rewriter that walks values
 * only leaves every anchor id as a stale uuid and the map resolves to nothing.
 */
export interface JsonPathRule {
  path: string;
  /** `key` rewrites the matched object key; `value` rewrites the leaf value. */
  kind: "key" | "value";
  /** Table the id points at — documentation, and what id:verify reports. */
  target: string;
  /**
   * When true, a value that does not resolve to a known row is left as-is
   * instead of failing. For client-supplied lists that mix ids with other
   * strings (emails, free text).
   */
  lenient?: boolean;
}

export interface JsonColumnRule {
  table: string;
  column: string;
  verdict: Verdict;
  evidence: Evidence;
  /** Rows sampled when evidence is VERIFIED-FROM-DATA. */
  sampled?: number;
  /** Non-null, non-empty rows in dev at audit time. */
  populated?: number;
  /**
   * Id-shaped strings actually observed in the sample. Only meaningful for
   * PRESERVE columns, where id:verify uses it to assert the ids are STILL
   * there afterwards — a column that never held any (audit_responses.answer_json)
   * must not be asserted on, or every clean run reports a false falsification.
   */
  observedIds?: number;
  paths: JsonPathRule[];
  note: string;
}

export interface PointerRule {
  table: string;
  column: string;
  verdict: Verdict;
  evidence: Evidence;
  /** Table the value points at, or null when it is not an entity pointer. */
  target: string | null;
  note: string;
}

export interface DerivedKeyRule {
  table: string;
  column: string;
  verdict: Verdict;
  evidence: Evidence;
  /** Only rows matching this are touched; null = every row. */
  whereSql: string | null;
  note: string;
}

/* ───────────────────────────────────────────────────────────────────────────
 * 1. JSON columns
 * ─────────────────────────────────────────────────────────────────────────── */

export const JSON_COLUMNS: JsonColumnRule[] = [
  /* ---- live config: rewrite ---- */
  {
    table: "audit_schedules",
    column: "scope_json",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 2,
    populated: 2,
    paths: [
      { path: "$.ids[*]", kind: "value", target: "properties|org entities" },
      { path: "$.within.{*}", kind: "key", target: "anchor entity (properties)" },
      { path: "$.within.{*}[*]", kind: "value", target: "rooms|narrowed entities" },
    ],
    note:
      "Re-resolved at every occurrence, so it is live config. The plan lists " +
      "`ids[]` only; the data also carries `within`, whose OBJECT KEYS are " +
      "anchor ids (3 room ids observed under one property key).",
  },
  {
    table: "audit_schedules",
    column: "assignee_rule",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    sampled: 7,
    populated: 7,
    paths: [{ path: "$.userId", kind: "value", target: "users" }],
    note:
      "All 7 dev rows are {kind:'ROLE_AT_TARGET', role} and carry NO id. The " +
      "{kind:'USER', userId} branch is declared at schema/audit.ts:380 but has " +
      "never been written here, so the path is inferred from the type.",
  },
  {
    table: "audit_schedules",
    column: "subset_json",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [
      { path: "$.sectionIds[*]", kind: "value", target: "audit_sections" },
      { path: "$.questionIds[*]", kind: "value", target: "audit_questions" },
    ],
    note: "NULL in all 7 dev rows. Shape from schema/audit.ts:382 + audit-service.ts:247.",
  },
  {
    table: "audits",
    column: "subset_json",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [
      { path: "$.sectionIds[*]", kind: "value", target: "audit_sections" },
      { path: "$.questionIds[*]", kind: "value", target: "audit_questions" },
    ],
    note: "NULL in all 33 dev rows. Copied from the schedule at materialization.",
  },
  {
    table: "menu_plans",
    column: "slots",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 10,
    populated: 10,
    paths: [{ path: "$.{*}.{*}", kind: "value", target: "recipes" }],
    note:
      "NOT IN THE PLAN. {DAY: {MEAL: recipeId}} — 30 recipe ids across 10 rows, " +
      "every one resolving to a live recipes row. Live config: the kitchen plan " +
      "renders from it.",
  },
  {
    table: "daily_production",
    column: "dispatches",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 30,
    populated: 30,
    paths: [{ path: "$[*].recipeId", kind: "value", target: "recipes" }],
    note: "NOT IN THE PLAN. 30/30 rows carry a resolving recipe id.",
  },
  {
    table: "daily_production",
    column: "wastage",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 30,
    populated: 30,
    paths: [{ path: "$[*].recipeId", kind: "value", target: "recipes" }],
    note: "NOT IN THE PLAN. 30/30 rows carry a resolving recipe id.",
  },
  {
    table: "daily_production",
    column: "receivings",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [{ path: "$[*].recipeId", kind: "value", target: "recipes" }],
    note:
      "NOT IN THE PLAN. Empty in all 30 dev rows; classified by symmetry with " +
      "its two sibling columns, which are verified.",
  },
  {
    table: "food_menu_shares",
    column: "recipients",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [{ path: "$[*]", kind: "value", target: "residents", lenient: true }],
    note:
      "Both dev rows are []. RESOLVED FROM CODE (food-ops.ts:3230): for " +
      "recipientType GUESTS the server writes residents.id — NOT user ids as " +
      "the plan says. For CUSTOM the array is whatever the client posted through " +
      "a .passthrough() schema, so elements may be emails or free text: lenient, " +
      "rewrite only what resolves to a residents row.",
  },

  /* ---- historical record: preserve ---- */
  {
    table: "audit_events",
    column: "before_json",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 36,
    populated: 36,
    observedIds: 30,
    paths: [],
    note:
      "Hash-chain input. 30 uuid leaves observed, including a nested copy of " +
      "scope_json complete with its `within` anchor keys.",
  },
  {
    table: "audit_events",
    column: "after_json",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 85,
    populated: 85,
    observedIds: 38,
    paths: [],
    note: "Hash-chain input. 38 uuid leaves observed.",
  },
  {
    table: "audit_log",
    column: "changes",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 61,
    populated: 61,
    observedIds: 10,
    paths: [],
    note:
      "Point-in-time before/after record. 10 uuid leaves at $.after.id, " +
      "$.before.id, $.residentId, $.reversalOf.",
  },
  {
    table: "audit_responses",
    column: "answer_json",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 500,
    populated: 701,
    paths: [],
    note:
      "Frozen post-submit. Also contains no ids at all: $.optionId is a slug " +
      "('audit-opt-poor'), $.score a number, $.value a number or free text. " +
      "0 uuids in 500 sampled rows.",
  },
  {
    table: "audit_template_versions",
    column: "rating_scale_snapshot",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 17,
    populated: 17,
    observedIds: 6,
    paths: [],
    note:
      "An explicit snapshot — but it DOES hold a real entity id, which the plan " +
      "does not say: $.scaleId defaults to the version's own id " +
      "(audit-templates.ts:579) and 6/17 dev rows carry a uuid there. Nothing " +
      "ever looks it up, so preserving it is safe; id:verify must whitelist the " +
      "path rather than flag it as a missed rewrite.",
  },
  {
    table: "communication_logs",
    column: "recipient_filter",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 500,
    populated: 533,
    observedIds: 1391,
    paths: [],
    note:
      "THE PLAN HAS THIS WRONG TWICE. It is on communication_logs, not " +
      "message_templates (which has no such column), and it is a historical " +
      "record, not live config: each row is one already-sent message, holding " +
      "{residentId, ruleId, ledgerEntryId, fallback} — the ids that triggered " +
      "that send. 1391 uuid leaves across 500 rows.",
  },

  {
    table: "notification_outbox",
    column: "payload",
    verdict: "NO_IDS",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 0,
    populated: 0,
    paths: [],
    note:
      "THE PLAN LISTS THIS AS LIVE CONFIG TO REWRITE. It is NULL in all 535 dev " +
      "rows, and the only writer (notification-service.ts:68-86) never sets it — " +
      "a dead column, and a candidate for drop-dead-columns.ts. The deep-link " +
      "ids the plan is thinking of are in notification_outbox.entity_id and " +
      "notifications.link; both are classified below.",
  },
  {
    table: "access_grants",
    column: "qualifiers",
    verdict: "NO_IDS",
    evidence: "VERIFIED-FROM-DATA",
    sampled: 24,
    populated: 24,
    paths: [],
    note:
      "Added by the in-flight access-control work, after the plan was written. " +
      "Role codes (['UL','CM','CX']), no ids.",
  },

  /* ---- opaque: blocked ---- */
  {
    table: "food_order_drafts",
    column: "payload",
    verdict: "BLOCKED",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [],
    note:
      "'Opaque frontend draft state' (schema/food.ts:979) — the server never " +
      "reads its shape, so no path can be derived. Empty in dev. Drafts are a " +
      "transient UI convenience: --drop-drafts deletes them, which is the only " +
      "honest treatment.",
  },
  {
    table: "form_drafts",
    column: "payload",
    verdict: "BLOCKED",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [],
    note:
      "'{values, extra} — opaque to the server' (schema/system.ts:202). Table " +
      "does not exist in dev yet. Same treatment as food_order_drafts.",
  },
  {
    table: "bank_statement_lines",
    column: "suggestion_payload",
    verdict: "BLOCKED",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [],
    note:
      "NOT IN THE PLAN. A pending reconciliation suggestion — live state an " +
      "operator acts on, and its siblings matched_ledger_entry_id / " +
      "matched_payment_id are unconstrained id pointers. NULL in all 50 dev " +
      "rows, so no path is observable. Abort rather than guess at money.",
  },
  {
    table: "report_jobs",
    column: "params",
    verdict: "BLOCKED",
    evidence: "STILL-INFERRED",
    sampled: 0,
    populated: 0,
    paths: [],
    note:
      "NOT IN THE PLAN. Report filter params, almost certainly property/entity " +
      "ids. 0 rows in dev. Jobs are short-lived — drain the queue before the " +
      "swap and this is empty by construction.",
  },

  /* ---- verified to hold no ids ---- */
  ...(
    [
      ["announcements", "target_roles", 10, "role names"],
      ["audit_app_settings", "value_json", 10, "booleans, numbers, mode strings"],
      ["audit_comments", "attachments_json", 0, "storage keys, no ids (0 rows)"],
      ["audit_question_bank_items", "default_options_json", 3, "option ids are 'a'/'b'"],
      ["audit_question_bank_items", "tags", 459, "free-text tags"],
      ["audit_questions", "options_json", 3, "option ids are 'a'/'b'"],
      ["audit_role_grants", "audit_types", 26, "audit-type codes"],
      ["audit_schedules", "recurrence_json", 2, "freq/interval/byMonthDay"],
      ["billing_runs", "errors", 0, "{residentId, reason}[] — see POINTER note"],
      ["complaints", "photos", 0, "urls (0 populated rows)"],
      ["courses", "quiz", 0, "0 populated rows"],
      ["courses", "target_roles", 10, "role names"],
      ["esign_events", "payload", 13, "signerName only"],
      ["grns", "items", 10, "name/qty/unit"],
      ["grns", "photos", 0, "urls (0 populated rows)"],
      ["indents", "items", 20, "name/qty/unit/rate"],
      ["integration_status", "config", 0, "0 populated rows"],
      ["iot_devices", "config", 20, "interval/threshold numbers"],
      ["iot_readings", "raw_payload", 50, "raw/ts/unit"],
      ["kyc_events", "payload", 75, "note/rejectionReason free text"],
      ["kyc_requests", "provider_data", 0, "0 populated rows"],
      ["laundry_batches", "items", 50, "garment counts"],
      ["lead_activities", "meta", 0, "0 populated rows"],
      ["message_templates", "variables", 10, "variable names"],
      ["properties", "amenities", 5, "amenity names"],
      ["properties", "portfolio_attributes", 5, "capacity/rate/gender attributes"],
      ["property_leads", "documents", 0, "0 populated rows"],
      ["property_leads", "photos", 0, "0 populated rows"],
      ["property_leads", "viability_data", 0, "0 populated rows"],
      ["purchase_orders", "items", 20, "name/qty/rate/amount"],
      ["recipes", "allergens", 9, "allergen names"],
      ["recipes", "ingredients", 30, "name/qty/unit"],
      ["residents", "allergies", 0, "0 populated rows"],
      ["residents", "dietary_pref", 50, "diet codes"],
      ["system_config", "value", 7, "scalar settings"],
      ["vendors", "categories", 10, "category names"],
    ] as const
  ).map(([table, column, populated, note]): JsonColumnRule => ({
    table,
    column,
    verdict: "NO_IDS",
    // A column with zero populated rows has been verified only to the extent
    // that nothing is in it; the classification still rests on the shape.
    evidence: populated > 0 ? "VERIFIED-FROM-DATA" : "STILL-INFERRED",
    populated,
    sampled: populated,
    paths: [],
    note,
  })),
];

/* ───────────────────────────────────────────────────────────────────────────
 * 2. Unconstrained pointer columns
 *
 * Text columns holding an entity id with no FK constraint — invisible to the
 * plan's 177-edge analysis. 60 of them carry uuids in dev today.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * (table, column) → the table its values resolve to. All verified from data.
 *
 * Note the four at the end. They hold NO uuid-shaped value at all — their ids
 * are readable seeded strings (`cluster_blr_koramangala`, `user_food_ops`) —
 * so a uuid-pattern sweep reports them as clean and a migration driven by one
 * leaves `properties.cluster_id` and `properties.kitchen_id` pointing at
 * nothing. They were found only once preflight started testing membership in
 * the live id set instead of testing shape.
 */
const RESOLVING_POINTERS: [string, string, string][] = [
  ["announcements", "created_by", "users"],
  ["announcements", "property_id", "properties"],
  ["audit_app_settings", "updated_by", "users"],
  ["audit_evidence", "uploaded_by", "users"],
  ["audit_question_bank_items", "created_by", "users"],
  ["audit_responses", "answered_by", "users"],
  ["audit_reviews", "reviewer_id", "users"],
  ["audit_schedules", "created_by", "users"],
  ["audit_template_versions", "created_by", "users"],
  ["audit_template_versions", "published_by", "users"],
  ["audit_templates", "created_by", "users"],
  ["audits", "created_by", "users"],
  ["audits", "start_evidence_id", "audit_evidence"],
  ["audits", "submission_evidence_id", "audit_evidence"],
  ["billing_runs", "triggered_by", "users"],
  ["bookings", "created_by", "users"],
  ["candidates", "job_requisition_id", "job_requisitions"],
  ["complaint_events", "actor_id", "users"],
  ["complaints", "resident_id", "residents"],
  ["course_enrollments", "employee_id", "employees"],
  ["daily_production", "property_id", "properties"],
  ["electricity_readings", "recorded_by", "users"],
  ["employees", "property_id", "properties"],
  ["escalations", "escalated_to", "users"],
  ["exit_clearances", "cleared_by", "users"],
  ["facility_logs", "vendor_id", "vendors"],
  ["facility_schedules", "vendor_id", "vendors"],
  ["grns", "po_id", "purchase_orders"],
  ["grns", "property_id", "properties"],
  ["grns", "received_by", "users"],
  ["indents", "created_by", "users"],
  ["indents", "property_id", "properties"],
  ["inventory", "property_id", "properties"],
  ["laundry_batches", "created_by", "users"],
  ["lead_activities", "created_by", "users"],
  ["leads", "assigned_to", "users"],
  ["leads", "property_id", "properties"],
  ["ledger_entries", "created_by", "users"],
  ["leaves", "approved_by", "users"],
  ["menu_plans", "property_id", "properties"],
  ["message_templates", "created_by", "users"],
  ["out_passes", "approver_id", "users"],
  ["out_passes", "created_by", "users"],
  ["payments", "property_id", "properties"],
  ["performance_notes", "added_by", "users"],
  ["purchase_orders", "indent_id", "indents"],
  ["purchase_orders", "property_id", "properties"],
  ["recipe_feedback", "property_id", "properties"],
  ["reminder_logs", "triggered_by", "users"],
  ["resident_attendance", "marked_by", "users"],
  ["residents", "room_id", "rooms"],
  ["stock_movements", "created_by", "users"],
  ["users", "property_id", "properties"],
  ["wallet_transactions", "recorded_by", "users"],
  ["wallet_transactions", "reversal_of", "wallet_transactions"],
  // Found by id-set membership, not by uuid shape — see the note above.
  ["properties", "cluster_id", "clusters"],
  ["properties", "kitchen_id", "kitchens"],
  ["audit_role_grants", "revoked_by", "users"],
  ["audit_report_shares", "created_by", "users"],
];

export const POINTER_COLUMNS: PointerRule[] = [
  ...RESOLVING_POINTERS.map(([table, column, target]): PointerRule => ({
    table,
    column,
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    target,
    note: `Unconstrained pointer to ${target}. Values resolve to live rows in dev.`,
  })),

  {
    table: "access_grants",
    column: "subject_id",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    target: "users",
    note:
      "Added by the in-flight access-control work. Polymorphic on subject_type " +
      "(only USER exists today); all 70 dev rows resolve to a users row. NOTE: " +
      "only 11 of the 70 are uuid-shaped — the rest are seeded ids like " +
      "'user_food_unit2', which is why every rewriter here keys off the id map " +
      "rather than a uuid pattern.",
  },

  /* ---- hash-chain inputs: preserving these IS the chain ---- */
  {
    table: "audit_events",
    column: "entity_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: "polymorphic",
    note:
      "THE PLAN UNDERSTATES THIS. appendAuditEvent hashes entityId, auditId and " +
      "actorId alongside beforeJson/afterJson (audit-events.ts:104-117), so " +
      "rewriting any of the three breaks verifyChain() exactly as badly as " +
      "rewriting the JSON. 278/292 rows carry a uuid here.",
  },
  {
    table: "audit_events",
    column: "audit_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: "audits",
    note: "Hash-chain input. No FK constraint, so a blanket *_id rewrite would hit it.",
  },
  {
    table: "audit_events",
    column: "actor_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: "users",
    note: "Hash-chain input.",
  },
  {
    table: "audit_log",
    column: "entity_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: "polymorphic",
    note:
      "Historical log, polymorphic (some rows are composite: `ROUTING:<id>`, " +
      "`<mealType>:<propertyId>`). Resolves through legacy_id in the log UI.",
  },
  {
    table: "notification_outbox",
    column: "entity_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: "polymorphic",
    note:
      "THE PLAN LOOKS IN THE WRONG PLACE. §4 lists 'notification_outbox " +
      "payloads'; payload is NULL in all 535 dev rows and no writer ever sets it " +
      "(notification-service.ts:68-86 is the only insert). The ids are here, in " +
      "a plain column: 79 FOOD_ORDER uuids. A sent notification is a historical " +
      "record.",
  },

  /* ---- not entity ids at all ---- */
  {
    table: "otp_challenges",
    column: "verification_token",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: null,
    note: "A randomUUID() SECRET, not an id. 421 rows. Resolves to nothing; rewriting it would invalidate live challenges.",
  },
  {
    table: "users",
    column: "current_session_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: null,
    note: "JWT session id (`sid`), not a row id. Rewriting it logs out every user.",
  },
  {
    table: "food_menu_shares",
    column: "share_token",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    target: null,
    note:
      "The public /m/<token> secret. The plan's claim that share links use a " +
      "separate token column is correct — and that is exactly why it must not " +
      "be rewritten.",
  },
  {
    table: "complaints",
    column: "order_id",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    target: "food_orders",
    note:
      "2 dev rows, neither resolving — clear:food-orders deleted the orders and " +
      "left the pointer dangling, which is itself proof there is no FK here. " +
      "Rewrite what resolves; a dangling value keeps its legacy id.",
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * 3. Derived composite keys
 *
 * The quietest failure mode in the whole migration: an id interpolated into a
 * string that is then used to answer "have I already done this?". Change the id
 * and the answer flips to no.
 * ─────────────────────────────────────────────────────────────────────────── */

export const DERIVED_KEYS: DerivedKeyRule[] = [
  {
    table: "ledger_entries",
    column: "reference",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: "reference LIKE 'AUTO:%' OR reference LIKE 'BANK:%'",
    note:
      "NOT IN THE PLAN, AND IT BILLS PEOPLE. `AUTO:<billing_cycle.id>:<period>` " +
      "is the billing run's idempotency key: finance.ts:170 skips a resident " +
      "whose ledger already holds that exact string. Leave it and the first " +
      "post-swap run computes AUTO:<bigint>:<period>, matches nothing, and " +
      "re-bills every resident for the current period. 230 dev rows.",
  },
  {
    table: "audits",
    column: "occurrence_key",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note:
      "NOT IN THE PLAN. `<schedule.id>:<occurrenceISO>:<targetId>` with " +
      "onConflictDoNothing (audit-jobs.ts:323,367). Leave it and the " +
      "materializer re-creates every occurrence still inside its catch-up " +
      "window — duplicate audits, assignments and reminders. 23 dev rows.",
  },
  {
    table: "wallet_transactions",
    column: "reference_id",
    verdict: "REWRITE",
    evidence: "STILL-INFERRED",
    whereSql: "reference_type = 'IDEMPOTENCY'",
    note:
      "NOT IN THE PLAN, AND IT IS MONEY. `<wallet.id>:<clientKey>` under " +
      "uq_wallet_transactions_reference (wallet.ts:114,357,547,784,1236). A " +
      "client retrying a topup or payment across the cutover presents the same " +
      "key, the scoped key no longer matches, and the credit is written twice — " +
      "the identical failure migrate-wallet-reference-namespace.ts exists to " +
      "prevent. No IDEMPOTENCY rows in dev, so the pattern is from code.",
  },
  {
    table: "org_nodes",
    column: "path",
    verdict: "REWRITE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note:
      "NOT IN THE PLAN — it postdates it, from the in-flight access-control " +
      "work. `${parentPath}${node.id}/` (org-tree.ts:115) is a MATERIALIZED " +
      "ancestry path, queried with LIKE '<ancestorPath>%'. 55 of 80 dev rows " +
      "embed a property uuid, precisely because G1 makes an org node's id the " +
      "entity's id. Leave it and every descendant query resolves to nothing. " +
      "§5 says G1 survives the swap intact; it does, but this derived string " +
      "does not survive on its own.",
  },
  {
    table: "notifications",
    column: "link",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note:
      "217 dev rows hold `/food/orders/<uuid>`. A delivered notification is a " +
      "historical record, and idFilter() resolves the legacy uuid in the route " +
      "param — this column is the plan's own argument for retaining legacy_id.",
  },
  {
    table: "notification_outbox",
    column: "provider_message_id",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note: "`log-<uuid>` — the delivery provider's id, not ours. 535 rows.",
  },
  {
    table: "audit_events",
    column: "reason",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note: "Free text that happens to quote an id in 5 rows. Hash-chain input.",
  },
  {
    table: "wallet_transactions",
    column: "description",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note: "Free text quoting an id in 1 row. A ledger narration is historical.",
  },
  {
    table: "electricity_tariffs",
    column: "name",
    verdict: "PRESERVE",
    evidence: "VERIFIED-FROM-DATA",
    whereSql: null,
    note: "5 seeded rows whose name embeds a uuid. A display label, not a key.",
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * Lookups
 * ─────────────────────────────────────────────────────────────────────────── */

const key = (t: string, c: string) => `${t}.${c}`;

export const jsonRule = (t: string, c: string): JsonColumnRule | undefined =>
  JSON_COLUMNS.find((r) => key(r.table, r.column) === key(t, c));

export const pointerRule = (t: string, c: string): PointerRule | undefined =>
  POINTER_COLUMNS.find((r) => key(r.table, r.column) === key(t, c));

export const derivedKeyRule = (t: string, c: string): DerivedKeyRule | undefined =>
  DERIVED_KEYS.find((r) => key(r.table, r.column) === key(t, c));

/**
 * Paths whose uuids are EXPECTED to survive the migration, so id:verify does not
 * report them as a missed rewrite. Only snapshots that legitimately hold an id.
 */
export const PRESERVED_JSON_PATHS = new Set([
  "audit_template_versions.rating_scale_snapshot:$.scaleId",
]);
