import { pgTable, text, timestamp, boolean, json, integer, pgEnum } from "drizzle-orm/pg-core";
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
});

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

export type SystemConfig = typeof systemConfigTable.$inferSelect;
export type NotificationOutbox = typeof notificationOutboxTable.$inferSelect;
export type NewNotificationOutbox = typeof notificationOutboxTable.$inferInsert;
export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;
