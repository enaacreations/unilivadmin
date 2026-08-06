import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  json,
  foreignKey,
} from "drizzle-orm/pg-core";
import { propertiesTable, residentsTable, ledgerEntriesTable, usersTable } from "./core";

// ─── Billing cycles ───────────────────────────────────────
export const billingCyclesTable = pgTable("billing_cycles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // null propertyId = global (applies to all properties)
  propertyId: text("property_id").references(() => propertiesTable.id),
  cadence: text("cadence").notNull().default("MONTHLY"), // MONTHLY | WEEKLY | CUSTOM_DAYS
  dayOfMonth: integer("day_of_month").default(1).notNull(), // 1..28 for MONTHLY
  customDays: integer("custom_days"), // for CUSTOM_DAYS
  ledgerType: text("ledger_type").notNull().default("RENT"),
  descriptionTemplate: text("description_template").notNull().default("Rent for {{month}}"),
  isActive: boolean("is_active").default(true).notNull(),
  lastRunAt: timestamp("last_run_at"),
  createdBy: text("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const billingRunsTable = pgTable("billing_runs", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").references(() => billingCyclesTable.id, { onDelete: "cascade" }),
  triggeredBy: text("triggered_by"), // userId or "SCHEDULER"
  periodLabel: text("period_label").notNull(),
  successCount: integer("success_count").default(0).notNull(),
  failedCount: integer("failed_count").default(0).notNull(),
  skippedCount: integer("skipped_count").default(0).notNull(),
  totalEligible: integer("total_eligible").default(0).notNull(),
  notes: text("notes"),
  errors: json("errors").$type<Array<{ residentId: string; reason: string }>>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Reminder rules ───────────────────────────────────────
export const reminderRulesTable = pgTable("reminder_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // offsetDays: negative=before due, 0=on due, positive=after due
  offsetDays: integer("offset_days").notNull().default(0),
  channel: text("channel").notNull().default("EMAIL"), // EMAIL | SMS | INAPP
  templateSubject: text("template_subject"),
  templateBody: text("template_body").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const reminderLogsTable = pgTable("reminder_logs", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").references(() => reminderRulesTable.id, { onDelete: "set null" }),
  ruleName: text("rule_name"),
  residentId: text("resident_id").notNull().references(() => residentsTable.id, { onDelete: "cascade" }),
  ledgerEntryId: text("ledger_entry_id").references(() => ledgerEntriesTable.id, { onDelete: "set null" }),
  channel: text("channel").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull().default("SENT"), // SENT | FAILED
  triggeredBy: text("triggered_by"), // userId or "SCHEDULER"
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Bank reconciliation ──────────────────────────────────
export const bankImportsTable = pgTable("bank_imports", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  accountLabel: text("account_label"),
  totalLines: integer("total_lines").default(0).notNull(),
  matchedLines: integer("matched_lines").default(0).notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | RECONCILED
  uploadedBy: text("uploaded_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bankStatementLinesTable = pgTable("bank_statement_lines", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => bankImportsTable.id, { onDelete: "cascade" }),
  txnDate: timestamp("txn_date").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),
  amount: numeric("amount").notNull(),
  direction: text("direction").notNull().default("CREDIT"), // CREDIT | DEBIT
  status: text("status").notNull().default("UNMATCHED"), // UNMATCHED | SUGGESTED | MATCHED | IGNORED
  matchedResidentId: text("matched_resident_id").references(() => residentsTable.id, { onDelete: "set null" }),
  matchedLedgerEntryId: text("matched_ledger_entry_id"),
  matchedPaymentId: text("matched_payment_id"),
  suggestionPayload: json("suggestion_payload").$type<Record<string, unknown>>(),
  reconciledAt: timestamp("reconciled_at"),
  reconciledBy: text("reconciled_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  /**
   * Named explicitly: the derived name
   * (`bank_statement_lines_matched_ledger_entry_id_ledger_entries_id_fk`) is 65
   * chars, so Postgres truncates it to 63 and every `push` re-emits DROP + ADD
   * for an unchanged constraint, which destroys "push says nothing to do" as a
   * drift signal.
   */
  foreignKey({
    columns: [t.matchedLedgerEntryId],
    foreignColumns: [ledgerEntriesTable.id],
    name: "bank_statement_lines_matched_ledger_entry_id_fk",
  }).onDelete("set null"),
]);

// ─── Expense management ───────────────────────────────────
export const expenseCategoriesTable = pgTable("expense_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const expensesTable = pgTable("expenses", {
  id: text("id").primaryKey(),
  categoryId: text("category_id").references(() => expenseCategoriesTable.id, { onDelete: "set null" }),
  propertyId: text("property_id").references(() => propertiesTable.id, { onDelete: "set null" }),
  vendor: text("vendor"),
  amount: numeric("amount").notNull(),
  expenseDate: timestamp("expense_date").notNull(),
  description: text("description"),
  reference: text("reference"),
  attachment: text("attachment"), // base64/data URL
  status: text("status").notNull().default("SUBMITTED"), // SUBMITTED | APPROVED | REJECTED | PAID
  rejectionReason: text("rejection_reason"),
  submittedBy: text("submitted_by").references(() => usersTable.id),
  reviewedBy: text("reviewed_by").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const expenseEventsTable = pgTable("expense_events", {
  id: text("id").primaryKey(),
  expenseId: text("expense_id").notNull().references(() => expensesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // CREATED | APPROVED | REJECTED | PAID | UPDATED
  actorId: text("actor_id").references(() => usersTable.id),
  actorName: text("actor_name"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
