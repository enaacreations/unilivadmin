import {
  pgTable,
  pgEnum,
  text,
  numeric,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { residentsTable, propertiesTable } from "./core";

export const walletTransactionTypeEnum = pgEnum("wallet_transaction_type", [
  "TOPUP",
  "PAYMENT",
  "PARTIAL_PAYMENT",
  "ADJUSTMENT_CREDIT",
  "ADJUSTMENT_DEBIT",
  "REFUND_WITHDRAWAL",
  "REVERSAL",
]);

export const walletsTable = pgTable("wallets", {
  id: text("id").primaryKey(),
  residentId: text("resident_id")
    .notNull()
    .unique()
    .references(() => residentsTable.id, { onDelete: "restrict" }),
  balance: numeric("balance").notNull().default("0"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => walletsTable.id, { onDelete: "restrict" }),
  residentId: text("resident_id")
    .notNull()
    .references(() => residentsTable.id, { onDelete: "restrict" }),
  type: walletTransactionTypeEnum("type").notNull(),
  amount: numeric("amount").notNull(),
  balanceBefore: numeric("balance_before").notNull(),
  balanceAfter: numeric("balance_after").notNull(),
  description: text("description").notNull(),
  referenceId: text("reference_id"),
  referenceType: text("reference_type"),
  reversalOf: text("reversal_of"),
  recordedBy: text("recorded_by").notNull(),
  notes: text("notes"),
  propertyId: text("property_id").references(() => propertiesTable.id, {
    onDelete: "restrict",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const walletConfigTable = pgTable("wallet_config", {
  id: text("id").primaryKey(),
  propertyId: text("property_id")
    .notNull()
    .unique()
    .references(() => propertiesTable.id, { onDelete: "cascade" }),
  minimumBalance: numeric("minimum_balance").notNull().default("-100"),
  lowBalanceAlert: numeric("low_balance_alert").notNull().default("200"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  topupNotes: text("topup_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
