import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  numeric,
  pgEnum,
  json,
  index,
  uniqueIndex,
  bigserial,
} from "drizzle-orm/pg-core";
import { usersTable, propertiesTable, roomsTable } from "./core";
import { auditNcSeverityEnum, auditRatingScalesTable } from "./audit-config";

/* ────────────────────────────────────────────────────────────────────────────
 * Audit & Inspection — domain tables (spec §3/§10, FRD v1.2.2).
 * Value chain: question bank → versioned templates → schedules → audits →
 * responses/evidence → scoring → NCs → CAPAs → review → closure → reports,
 * with a hash-chained audit_events trail (FRD-TRL-01).
 * ──────────────────────────────────────────────────────────────────────────── */

/** UL = Unit Lead (room), CM = Cluster Manager, CX = Customer Experience (D-10). */
export const auditTypeEnum = pgEnum("audit_type", ["UL", "CM", "CX"]);

export const auditTargetTypeEnum = pgEnum("audit_target_type", [
  "PROPERTY",
  "ROOM",
]);

/** 10 answerable types + non-scored INSTRUCTION display items (FRD-TAU-03). */
export const auditQuestionTypeEnum = pgEnum("audit_question_type", [
  "YES_NO_NA",
  "PASS_FAIL",
  "RATING",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
  "NUMERIC",
  "TEXT",
  "PHOTO",
  "SIGNATURE",
  "DATE",
  "INSTRUCTION",
]);

export const auditEvidenceRuleEnum = pgEnum("audit_evidence_rule", [
  "NONE",
  "OPTIONAL",
  "REQUIRED_ON_FAIL",
  "ALWAYS_REQUIRED",
]);

/** TemplateVersion lifecycle (spec §5.7). Published versions are immutable. */
export const auditTemplateLifecycleEnum = pgEnum("audit_template_lifecycle", [
  "DRAFT",
  "PENDING_APPROVAL",
  "PUBLISHED",
  "DEPRECATED",
  "ARCHIVED",
]);

/** Audit lifecycle (spec §4.1). Overdue is a derived flag, never a state. */
export const auditStateEnum = pgEnum("audit_state", [
  "DRAFT",
  "SCHEDULED",
  "IN_PROGRESS",
  "PAUSED",
  "SUBMITTED",
  "UNDER_REVIEW",
  "REJECTED",
  "APPROVED",
  "CLOSED",
  "CANCELLED",
]);

/** Non-conformance lifecycle (spec §4.2). */
export const auditNcStateEnum = pgEnum("audit_nc_state", [
  "OPEN",
  "IN_PROGRESS",
  "EXTENSION_REQUESTED",
  "RESOLVED",
  "VERIFIED",
  "REOPENED",
  "WAIVED",
  "CLOSED",
]);

export const auditResultEnum = pgEnum("audit_result", ["PASS", "FAIL"]);

export const auditScheduleFrequencyEnum = pgEnum("audit_schedule_frequency", [
  "EVERY_N_DAYS",
  "WEEKLY",
  "FORTNIGHTLY",
  "MONTHLY",
  "QUARTERLY",
  "HALF_YEARLY",
  "ANNUALLY",
  "CRON",
]);

export const auditEvidenceKindEnum = pgEnum("audit_evidence_kind", [
  "AUDIT",
  "RESPONSE",
  "NC",
  "CAPA",
  "SUBMISSION_PROOF",
]);

export const auditEventKindEnum = pgEnum("audit_event_kind", [
  "STATE_CHANGE",
  "ASSIGNMENT",
  "SCORE_FREEZE",
  "CONFIG_CHANGE",
  "GRANT_CHANGE",
  "NOTIFY",
  "REMINDER",
  "ESCALATION",
  "SHARE",
  "DENIED_ATTEMPT",
  "COMMENT",
]);

export const auditReportStatusEnum = pgEnum("audit_report_status", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);

/* ── Question bank ─────────────────────────────────────────────────────────── */

/**
 * Curated reusable questions (FRD-QBK-01). Inserted into templates by COPY —
 * later bank edits never mutate any template version (FRD-QBK-03).
 * Archive, never hard-delete once used.
 */
export const auditQuestionBankItemsTable = pgTable("audit_question_bank_items", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  helpText: text("help_text"),
  type: auditQuestionTypeEnum("type").notNull(),
  defaultWeight: integer("default_weight").default(0).notNull(),
  defaultEvidenceRule: auditEvidenceRuleEnum("default_evidence_rule")
    .default("NONE")
    .notNull(),
  defaultAutoNcJson: json("default_auto_nc_json"),
  /** Single/multi choice: [{id, label, multiplierPct}] — copied to the
   *  question's optionsJson on insert (copy-on-insert, FRD-QBK-03). */
  defaultOptionsJson: json("default_options_json"),
  tags: json("tags").$type<string[]>().default([]).notNull(),
  numericUnit: text("numeric_unit"),
  numericMin: numeric("numeric_min"),
  numericMax: numeric("numeric_max"),
  createdBy: text("created_by"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Templates & versions ──────────────────────────────────────────────────── */

export const auditTemplatesTable = pgTable("audit_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** Every template belongs to exactly one audit type (D-10). */
  auditType: auditTypeEnum("audit_type").notNull(),
  targetType: auditTargetTypeEnum("target_type").notNull(),
  category: text("category"),
  description: text("description"),
  /**
   * Per-template access scoping (FR-TM-09 / TLB-09): restrict which org nodes
   * and platform roles may see/schedule this template. Null/empty = unrestricted.
   * {clusterIds?, cityIds?, roles?} — enforced in the library list + pickers.
   */
  accessScopeJson: json("access_scope_json").$type<{
    clusterIds?: string[];
    cityIds?: string[];
    roles?: string[];
  } | null>(),
  createdBy: text("created_by"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Immutable published snapshot of a template (FRD-TLB-03). Content mutations
 * are rejected unless lifecycle = DRAFT (service guard); contentHash (sha256
 * over canonicalized sections + questions + scale snapshot) is stamped at
 * publish for the hash-verifiable AC.
 */
export const auditTemplateVersionsTable = pgTable(
  "audit_template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => auditTemplatesTable.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    lifecycle: auditTemplateLifecycleEnum("lifecycle").default("DRAFT").notNull(),
    changelogNote: text("changelog_note"),
    passThresholdPct: numeric("pass_threshold_pct"),
    criticalFailGate: boolean("critical_fail_gate").default(false).notNull(),
    /** Per-template review toggle (D-2); snapshotted onto audits at creation. */
    reviewRequired: boolean("review_required").default(true).notNull(),
    /** Rating scale frozen at publish; execution & scoring read only this. */
    ratingScaleSnapshot: json("rating_scale_snapshot"),
    contentHash: text("content_hash"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at"),
    approvedBy: text("approved_by"),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at"),
    deprecatedAt: timestamp("deprecated_at"),
    archivedAt: timestamp("archived_at"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("audit_template_versions_template_version_uq").on(
      table.templateId,
      table.versionNo,
    ),
  ],
);

export const auditSectionsTable = pgTable(
  "audit_sections",
  {
    id: text("id").primaryKey(),
    templateVersionId: text("template_version_id")
      .notNull()
      .references(() => auditTemplateVersionsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").notNull(),
    /** Optional per-section audience metadata, e.g. "resident-interview" (spec B.4). */
    audience: text("audience"),
  },
  (table) => [
    index("audit_sections_template_version_id_idx").on(table.templateVersionId),
  ],
);

/**
 * Questions of a template version — plus ad-hoc items appended during
 * execution: version content rows have auditId NULL; ad-hoc rows carry the
 * audit id + adHoc=true and a fixed default weight from settings (X-7, D-6).
 */
export const auditQuestionsTable = pgTable(
  "audit_questions",
  {
    id: text("id").primaryKey(),
    sectionId: text("section_id")
      .notNull()
      .references(() => auditSectionsTable.id, { onDelete: "cascade" }),
    auditId: text("audit_id"),
    adHoc: boolean("ad_hoc").default(false).notNull(),
    prompt: text("prompt").notNull(),
    helpText: text("help_text"),
    type: auditQuestionTypeEnum("type").notNull(),
    weight: integer("weight").default(0).notNull(),
    mandatory: boolean("mandatory").default(false).notNull(),
    evidenceRule: auditEvidenceRuleEnum("evidence_rule").default("NONE").notNull(),
    /** Draft-time scale reference; execution reads the version's snapshot. */
    ratingScaleId: text("rating_scale_id").references(
      () => auditRatingScalesTable.id,
    ),
    /** Single/multi choice: [{id, label, multiplierPct, flagsNc}]. */
    optionsJson: json("options_json"),
    numericUnit: text("numeric_unit"),
    numericMin: numeric("numeric_min"),
    numericMax: numeric("numeric_max"),
    /** {onAnswers: string[], belowMultiplierPct?, severity, ownerRule: "AUDITEE_OF_TARGET"} */
    autoNcJson: json("auto_nc_json"),
    /** Copy-on-insert provenance (FRD-QBK-03). */
    bankItemId: text("bank_item_id").references(
      () => auditQuestionBankItemsTable.id,
    ),
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_questions_section_id_idx").on(table.sectionId),
    index("audit_questions_audit_id_idx").on(table.auditId),
  ],
);

/** Ad-hoc items queued as bank candidates for Admin accept/reject (D-4). */
export const auditBankCandidatesTable = pgTable("audit_bank_candidates", {
  id: text("id").primaryKey(),
  questionId: text("question_id")
    .notNull()
    .references(() => auditQuestionsTable.id, { onDelete: "cascade" }),
  auditId: text("audit_id").notNull(),
  proposedBy: text("proposed_by"),
  status: text("status").default("PENDING").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at"),
  resultingBankItemId: text("resulting_bank_item_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ── Scheduling ────────────────────────────────────────────────────────────── */

export const auditSchedulesTable = pgTable("audit_schedules", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  templateVersionId: text("template_version_id")
    .notNull()
    .references(() => auditTemplateVersionsTable.id),
  /** Denormalized from the template; service rejects CX schedules (C-3). */
  auditType: auditTypeEnum("audit_type").notNull(),
  frequency: auditScheduleFrequencyEnum("frequency").notNull(),
  intervalDays: integer("interval_days"),
  dayOfWeek: integer("day_of_week"),
  cron: text("cron"),
  /** Local time-of-day per occurrence, "HH:mm" in org timezone. */
  timeOfDay: text("time_of_day").notNull(),
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end"),
  reminderOffsetMinutes: integer("reminder_offset_minutes"),
  /** {kind:"USER", userId} | {kind:"ROLE_AT_TARGET", role} — resolved at materialization. */
  assigneeRule: json("assignee_rule").notNull(),
  /** Optional section/question subset: {sectionIds: [], questionIds: []} (FRD-SCH-01). */
  subsetJson: json("subset_json"),
  status: text("status").default("ACTIVE").notNull(),
  /** Materializer catch-up watermark (NFR-04). */
  lastMaterializedAt: timestamp("last_materialized_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const auditScheduleTargetsTable = pgTable(
  "audit_schedule_targets",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => auditSchedulesTable.id, { onDelete: "cascade" }),
    targetType: auditTargetTypeEnum("target_type").notNull(),
    propertyId: text("property_id").references(() => propertiesTable.id),
    roomId: text("room_id").references(() => roomsTable.id),
  },
  (table) => [
    uniqueIndex("audit_schedule_targets_uq").on(
      table.scheduleId,
      table.propertyId,
      table.roomId,
    ),
  ],
);

/* ── Audits (tickets) ──────────────────────────────────────────────────────── */

export const auditsTable = pgTable(
  "audits",
  {
    id: text("id").primaryKey(),
    /** Human-readable number per numbering scheme, e.g. UNI-AUD-4501. */
    ticketNo: text("ticket_no").notNull().unique(),
    auditType: auditTypeEnum("audit_type").notNull(),
    templateVersionId: text("template_version_id")
      .notNull()
      .references(() => auditTemplateVersionsTable.id),
    scheduleId: text("schedule_id").references(() => auditSchedulesTable.id),
    /** Idempotency key `${scheduleId}:${occurrenceISO}:${targetId}` (FRD-SCH-04). */
    occurrenceKey: text("occurrence_key").unique(),
    targetType: auditTargetTypeEnum("target_type").notNull(),
    /** Room audits also carry the parent property so org scoping always works. */
    propertyId: text("property_id")
      .notNull()
      .references(() => propertiesTable.id),
    roomId: text("room_id").references(() => roomsTable.id),
    title: text("title").notNull(),
    description: text("description"),
    state: auditStateEnum("state").default("DRAFT").notNull(),
    /** Derived flag set by the overdue job; never a state (spec §4.1). */
    isOverdue: boolean("is_overdue").default(false).notNull(),
    assigneeId: text("assignee_id").references(() => usersTable.id),
    scheduledFor: timestamp("scheduled_for"),
    dueAt: timestamp("due_at"),
    reminderOffsetMinutes: integer("reminder_offset_minutes"),
    reminderSentAt: timestamp("reminder_sent_at"),
    subsetJson: json("subset_json"),
    /** Snapshot of the version's review toggle at creation (D-2). */
    reviewRequired: boolean("review_required").default(true).notNull(),
    maxScore: numeric("max_score"),
    earnedScore: numeric("earned_score"),
    scorePct: numeric("score_pct"),
    result: auditResultEnum("result"),
    scoreBand: text("score_band"),
    /** Auto-captured, auditor-uneditable timings & location (FRD-EXE-14). */
    startedAt: timestamp("started_at"),
    startGeoLat: doublePrecision("start_geo_lat"),
    startGeoLng: doublePrecision("start_geo_lng"),
    submittedAt: timestamp("submitted_at"),
    submitGeoLat: doublePrecision("submit_geo_lat"),
    submitGeoLng: doublePrecision("submit_geo_lng"),
    durationSeconds: integer("duration_seconds"),
    /** Live geotagged submission photo slot (D-9 / FRD-EXE-13). */
    submissionEvidenceId: text("submission_evidence_id"),
    approvedAt: timestamp("approved_at"),
    closedAt: timestamp("closed_at"),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),
    reopenCount: integer("reopen_count").default(0).notNull(),
    /** Null = created by the system actor (materializer). */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("audits_assignee_state_idx").on(table.assigneeId, table.state),
    index("audits_property_id_idx").on(table.propertyId),
    index("audits_type_state_idx").on(table.auditType, table.state),
    index("audits_due_at_idx").on(table.dueAt),
    index("audits_schedule_id_idx").on(table.scheduleId),
  ],
);

/* ── Responses & evidence ──────────────────────────────────────────────────── */

/** One answer per question per audit; frozen post-submit (service guard). */
export const auditResponsesTable = pgTable(
  "audit_responses",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => auditsTable.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => auditQuestionsTable.id),
    answerJson: json("answer_json"),
    isNa: boolean("is_na").default(false).notNull(),
    /** Resolved multiplier % from the version's scale snapshot at answer time. */
    multiplierPct: numeric("multiplier_pct"),
    /** Frozen copy of the question weight at submit. */
    weight: numeric("weight"),
    /** Line-level earned, rounded half-up to 2dp at submit (FRD-SCR-01 AC). */
    earnedScore: numeric("earned_score"),
    maxScore: numeric("max_score"),
    notes: text("notes"),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("audit_responses_audit_question_uq").on(
      table.auditId,
      table.questionId,
    ),
  ],
);

export const auditEvidenceTable = pgTable(
  "audit_evidence",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => auditsTable.id, { onDelete: "cascade" }),
    kind: auditEvidenceKindEnum("kind").notNull(),
    responseId: text("response_id").references(() => auditResponsesTable.id),
    ncId: text("nc_id"),
    correctiveActionId: text("corrective_action_id"),
    /** S3 object key (see @workspace/storage); served via signed URLs (NFR-06). */
    storageKey: text("storage_key").notNull(),
    /** Client-generated downscaled thumbnail for PDF embedding (X-9). */
    thumbStorageKey: text("thumb_storage_key"),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    originalName: text("original_name"),
    geoLat: doublePrecision("geo_lat"),
    geoLng: doublePrecision("geo_lng"),
    geoAccuracyM: numeric("geo_accuracy_m"),
    /** Client-claimed capture time; server receipt time is createdAt. */
    capturedAt: timestamp("captured_at"),
    /** True only for in-page live camera captures (D-9; client-attested). */
    isLiveCapture: boolean("is_live_capture").default(false).notNull(),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_evidence_audit_id_idx").on(table.auditId),
    index("audit_evidence_nc_id_idx").on(table.ncId),
  ],
);

/* ── Non-conformances & CAPA ───────────────────────────────────────────────── */

export const auditNonConformancesTable = pgTable(
  "audit_non_conformances",
  {
    id: text("id").primaryKey(),
    ncNo: text("nc_no").notNull().unique(),
    auditId: text("audit_id")
      .notNull()
      .references(() => auditsTable.id, { onDelete: "cascade" }),
    responseId: text("response_id").references(() => auditResponsesTable.id),
    questionId: text("question_id"),
    severity: auditNcSeverityEnum("severity").notNull(),
    category: text("category"),
    description: text("description").notNull(),
    /** Responsible auditee; defaults to auditee-of-target (property's Unit Lead). */
    ownerId: text("owner_id")
      .notNull()
      .references(() => usersTable.id),
    /** Stamped from severity SLA at creation; re-stamped + evented on severity change (FRD-NCM-04). */
    dueAt: timestamp("due_at").notNull(),
    state: auditNcStateEnum("state").default("OPEN").notNull(),
    isOverdue: boolean("is_overdue").default(false).notNull(),
    source: text("source").default("AUTO").notNull(),
    waiverReason: text("waiver_reason"),
    waivedBy: text("waived_by"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at"),
    reopenCount: integer("reopen_count").default(0).notNull(),
    dueSoonNotifiedAt: timestamp("due_soon_notified_at"),
    breachNotifiedAt: timestamp("breach_notified_at"),
    /** Escalation-chain steps already sent (job dedupe). */
    escalationLevelSent: integer("escalation_level_sent").default(0).notNull(),
    createdBy: text("created_by"),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_ncs_owner_state_idx").on(table.ownerId, table.state),
    index("audit_ncs_audit_id_idx").on(table.auditId),
    index("audit_ncs_state_due_idx").on(table.state, table.dueAt),
  ],
);

export const auditCorrectiveActionsTable = pgTable("audit_corrective_actions", {
  id: text("id").primaryKey(),
  ncId: text("nc_id")
    .notNull()
    .references(() => auditNonConformancesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  completedAt: timestamp("completed_at"),
  submittedBy: text("submitted_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditNcExtensionRequestsTable = pgTable(
  "audit_nc_extension_requests",
  {
    id: text("id").primaryKey(),
    ncId: text("nc_id")
      .notNull()
      .references(() => auditNonConformancesTable.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by"),
    requestedDueAt: timestamp("requested_due_at").notNull(),
    justification: text("justification").notNull(),
    status: text("status").default("PENDING").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    decisionComment: text("decision_comment"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

/* ── Review, trail, comments, reports ──────────────────────────────────────── */

export const auditReviewsTable = pgTable("audit_reviews", {
  id: text("id").primaryKey(),
  auditId: text("audit_id")
    .notNull()
    .references(() => auditsTable.id, { onDelete: "cascade" }),
  reviewerId: text("reviewer_id").notNull(),
  verdict: text("verdict").notNull(),
  /** Required when verdict = REJECTED (service-enforced). */
  comments: text("comments"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Append-only, hash-chained module trail (FRD-TRL-01) — separate from the flat
 * host audit_log. Single global chain: hash = sha256(seq + prevHash +
 * canonicalJson(payload)), appended in-transaction under an advisory lock.
 * actorId null = system actor (P6).
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    auditId: text("audit_id"),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    kind: auditEventKindEnum("kind").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    reason: text("reason"),
    beforeJson: json("before_json"),
    afterJson: json("after_json"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
    index("audit_events_audit_id_idx").on(table.auditId),
  ],
);

/** Per-audit comment thread (FRD-EXE-10) with optional attachments. */
export const auditCommentsTable = pgTable("audit_comments", {
  id: text("id").primaryKey(),
  auditId: text("audit_id")
    .notNull()
    .references(() => auditsTable.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  /** [{storageKey, mime, thumbStorageKey?, originalName?}] — resolved to signed URLs on read. */
  attachmentsJson: json("attachments_json")
    .$type<{ storageKey: string; mime: string; thumbStorageKey?: string; originalName?: string }[]>()
    .default([])
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Generated PDF reports; reopen ⇒ new revision, prior revisions immutable (FRD-REV-06). */
export const auditReportsTable = pgTable(
  "audit_reports",
  {
    id: text("id").primaryKey(),
    reportNo: text("report_no").notNull().unique(),
    auditId: text("audit_id")
      .notNull()
      .references(() => auditsTable.id, { onDelete: "cascade" }),
    revision: integer("revision").default(1).notNull(),
    status: auditReportStatusEnum("status").default("PENDING").notNull(),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes"),
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    generatedAt: timestamp("generated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("audit_reports_audit_revision_uq").on(
      table.auditId,
      table.revision,
    ),
  ],
);

/** Expiring signed share links (D-5; WhatsApp channel deferred at launch). */
export const auditReportSharesTable = pgTable("audit_report_shares", {
  id: text("id").primaryKey(),
  reportId: text("report_id")
    .notNull()
    .references(() => auditReportsTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  channel: text("channel").default("LINK").notNull(),
  recipient: text("recipient"),
  expiresAt: timestamp("expires_at").notNull(),
  createdBy: text("created_by"),
  revokedAt: timestamp("revoked_at"),
  accessCount: integer("access_count").default(0).notNull(),
  lastAccessAt: timestamp("last_access_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
