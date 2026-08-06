import {
  pgTable,
  pgEnum,
  text,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  /**
   * Namespace for `referenceId` (e.g. RAZORPAY_PAYMENT). Without it the webhook
   * replay guard compares bare provider ids across event types and two ids for
   * one settlement cannot dedupe against each other.
   */
  referenceType: text("reference_type"),
  reversalOf: text("reversal_of"),
  recordedBy: text("recorded_by").notNull(),
  notes: text("notes"),
  propertyId: text("property_id").references(() => propertiesTable.id, {
    onDelete: "restrict",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  /**
   * The webhook idempotency guard, enforced by the database rather than by a
   * SELECT-then-INSERT that two concurrent Razorpay deliveries both pass. Partial
   * because most ledger rows (manual top-ups, adjustments) carry no reference.
   * Paired on referenceType being NULL so the untyped legacy idempotency keys
   * (wallet.ts topup/adjust) are covered too — Postgres treats NULLs as distinct,
   * so a single two-column index would let those through.
   */
  referenceUniq: uniqueIndex("uq_wallet_transactions_reference")
    .on(t.referenceType, t.referenceId)
    .where(sql`reference_id is not null and reference_type is not null`),
  referenceUniqUntyped: uniqueIndex("uq_wallet_transactions_reference_untyped")
    .on(t.referenceId)
    .where(sql`reference_id is not null and reference_type is null`),
  /**
   * Every read of this table is per-wallet: the history endpoint, and the
   * per-link accounting SUM the top-up webhook now runs on EVERY Razorpay
   * delivery (webhooks.ts linkAccounting, which aggregates over wallet_id +
   * notes). Both seq-scanned the whole ledger without this.
   */
  walletNotesIdx: index("wallet_transactions_wallet_id_notes_idx").on(t.walletId, t.notes),
}));

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
