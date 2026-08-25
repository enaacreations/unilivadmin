import { pgTable, text, timestamp, boolean, json, integer, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable, propertiesTable } from "./core";

/** Channels the outbound dispatch service can send through (Persona st.17/18/22/23). */
export const notificationChannelEnum = pgEnum("notification_channel", [
  "EMAIL",
  "SMS",
  "PUSH",
  "WHATSAPP",
  "IN_APP",
]);

/** Delivery status for an outbox row. */
export const notificationSendStatusEnum = pgEnum("notification_send_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

export const notificationsTable = pgTable("notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  title: text("title").notNull(),
  body: text("body"),
  type: text("type").notNull(),
  link: text("link"),
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditLogTable = pgTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => usersTable.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  changes: json("changes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const slaConfigTable = pgTable("sla_config", {
  id: text("id").primaryKey(),
  category: text("category").notNull().unique(),
  slaHours: integer("sla_hours").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const complaintRoutingTable = pgTable("complaint_routing", {
  id: text("id").primaryKey(),
  propertyId: text("property_id").notNull().references(() => propertiesTable.id),
  category: text("category").notNull(),
  assignedTo: text("assigned_to").notNull().references(() => usersTable.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const integrationStatusTable = pgTable("integration_status", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  enabled: boolean("enabled").default(false).notNull(),
  config: json("config"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Key/value config for behaviours the PRD/Persona call "configurable" — OTP
 * resend/attempt limits, lockout window, feature flags (Persona st.5/6).
 */
export const systemConfigTable = pgTable("system_config", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: json("value"),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Multi-channel send queue + delivery audit (Persona st.17/18/22/23). The bell
 * keeps reading notificationsTable; this drives EMAIL/SMS/PUSH with retry and
 * provider message IDs. payload carries context (e.g. order id, item list).
 */
export const notificationOutboxTable = pgTable("notification_outbox", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => usersTable.id),
  channel: notificationChannelEnum("channel").notNull(),
  toAddress: text("to_address"),
  templateKey: text("template_key"),
  subject: text("subject"),
  body: text("body"),
  payload: json("payload"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  status: notificationSendStatusEnum("status").default("PENDING").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  providerMessageId: text("provider_message_id"),
  scheduledFor: timestamp("scheduled_for"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // Drains the notification outbox: sweepPendingOutbox + notify-service reconcile
  // both scan PENDING rows past a created_at cutoff, oldest first, once a minute.
  index("notification_outbox_status_created_at_idx").on(table.status, table.createdAt),
]);

/** Browser web-push subscriptions for real push instead of polling (Persona st.17). */
export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh"),
  auth: text("auth"),
  userAgent: text("user_agent"),
  isActive: boolean("is_active").default(true).notNull(),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Per-user channel preferences (optional; Persona st.36 notification control). */
export const notificationPreferencesTable = pgTable("notification_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  eventType: text("event_type").notNull(),
  emailEnabled: boolean("email_enabled").default(true).notNull(),
  pushEnabled: boolean("push_enabled").default(true).notNull(),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Deliverability suppression list. Addresses that hard-bounced, complained, or
 * unsubscribed are skipped before every send (fed by provider webhooks — SES/SNS
 * bounce & complaint, MSG91 DLR). Unique per (channel, address).
 */
export const notificationSuppressionsTable = pgTable(
  "notification_suppressions",
  {
    id: text("id").primaryKey(),
    channel: notificationChannelEnum("channel").notNull(),
    address: text("address").notNull(),
    /** HARD_BOUNCE | COMPLAINT | UNSUBSCRIBED | INVALID */
    reason: text("reason").notNull(),
    detail: text("detail"),
    /**
     * A row blocks delivery only while `is_active AND (expires_at IS NULL OR
     * expires_at > now())`. Without these two a single transient bounce silences
     * an address forever, with no way back other than a manual DELETE that also
     * destroys the bounce history. `isActive` is the operator's clear switch;
     * `expiresAt` is a self-lapsing TTL (null = holds until cleared).
     */
    isActive: boolean("is_active").default(true).notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    /**
     * A unique INDEX, not a table constraint: drizzle-kit cannot round-trip a
     * named `unique()` constraint here, so every `push` DROPped and re-ADDed it —
     * a window with no suppression uniqueness on each deploy, and a permanent
     * false positive in the "push says nothing to do" drift signal. An index is
     * an equally valid ON CONFLICT target for `recordSuppression`
     * (lib/notify-core/src/suppression.ts) and diffs cleanly.
     */
    uniqChannelAddress: uniqueIndex("notification_suppressions_channel_address_uq").on(t.channel, t.address),
  }),
);

/** Async export jobs for large XLS/PDF generation (optional; Persona st.34/47). */
export const reportJobsTable = pgTable("report_jobs", {
  id: text("id").primaryKey(),
  requestedById: text("requested_by_id").references(() => usersTable.id),
  kind: text("kind").notNull(),
  format: text("format").notNull(),
  params: json("params"),
  status: text("status").default("PENDING").notNull(),
  fileUrl: text("file_url"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

/**
 * Server-side copy of an in-progress form so a half-filled form survives closing
 * the app — and follows the user to another device. The client also mirrors every
 * draft into localStorage; that copy is the one that catches the last keystroke
 * before the tab dies, while this table is written on a debounce and is what the
 * app reads back on a fresh device/browser.
 *
 * `formKey` identifies both the form and the record it edits ("vendor-form:new",
 * "vendor-form:<id>"), so a create draft and an edit draft never overwrite each
 * other. Rows are owned by exactly one user and are only ever read/written by
 * that user — there is no RBAC module here on purpose, `authenticate` plus the
 * userId filter is the whole authorization story.
 */
export const formDraftsTable = pgTable(
  "form_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.id),
    formKey: text("form_key").notNull(),
    /** `{ values, extra }` — opaque to the server; the owning form defines the shape. */
    payload: json("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // uniqueIndex rather than unique() — same drizzle-kit round-trip reason as
    // notification_suppressions above, and it is the ON CONFLICT target for the
    // upsert in routes/form-drafts.ts.
    uniqUserForm: uniqueIndex("form_drafts_user_form_key_uq").on(t.userId, t.formKey),
    byUser: index("form_drafts_user_idx").on(t.userId),
  }),
);

export type SystemConfig = typeof systemConfigTable.$inferSelect;
export type FormDraft = typeof formDraftsTable.$inferSelect;
export type NewFormDraft = typeof formDraftsTable.$inferInsert;
export type NotificationOutbox = typeof notificationOutboxTable.$inferSelect;
export type NewNotificationOutbox = typeof notificationOutboxTable.$inferInsert;
export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;
export type NotificationSuppression = typeof notificationSuppressionsTable.$inferSelect;
