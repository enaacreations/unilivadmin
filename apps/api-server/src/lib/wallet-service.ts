// ─────────────────────────────────────────────────────────────────────────────
// UNILIV Wallet — Service Layer
// All atomic operations run inside a caller-supplied db.transaction() context.
// ─────────────────────────────────────────────────────────────────────────────
import {
  db,
  walletsTable,
  walletTransactionsTable,
  walletConfigTable,
  auditLogTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { newId } from "./id.js";
import { logger } from "./logger.js";

// ── Transaction client type ────────────────────────────────────────────────
export type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Shared meta for every wallet transaction row ───────────────────────────
export interface WalletTxMeta {
  description: string;
  recordedBy: string;
  propertyId: string | null;
  notes?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  reversalOf?: string | null;
}

// ── Money rounding ─────────────────────────────────────────────────────────
// Invariant: nothing but a 2-decimal value is ever written to a money column.
// Balances are JS floats persisted into unbounded `numeric` columns, so an
// un-rounded intermediate (0.1 + 0.2) would be stored verbatim and leak into
// staff-facing text such as the checkout refund instruction. Every computed
// amount/balance goes through this at the point of write.
export function roundMoney(value: number): number {
  return (Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100)) / 100;
}

// ── Unique-violation detection ─────────────────────────────────────────────
// Every idempotency guard on a money path is a SELECT-then-INSERT plus a unique
// index; the index is what holds under concurrency, so each writer has to
// recognise its violation and translate it into "already applied". Lives here
// so the webhook and the wallet router share one definition of that check.
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ── Transaction direction ──────────────────────────────────────────────────
// Invariant: direction is a property of the type, never inferred from an ad-hoc
// membership list at the call site. `REFUND_WITHDRAWAL` is a DEBIT (checkout
// hands cash back and drains the wallet) — treating it as a credit made the
// reversal path debit a second time. `REVERSAL` is deliberately null: its sign
// is that of the transaction it reverses, so callers must resolve it from the
// original row's type instead.
export type WalletTxnDirection = "CREDIT" | "DEBIT";

export type CreditTxnType = "TOPUP" | "ADJUSTMENT_CREDIT" | "REVERSAL";

export type DebitTxnType =
  | "PAYMENT"
  | "PARTIAL_PAYMENT"
  | "ADJUSTMENT_DEBIT"
  | "REFUND_WITHDRAWAL"
  | "REVERSAL";

export type WalletTxnType = CreditTxnType | DebitTxnType;

export const WALLET_TXN_DIRECTION: Record<WalletTxnType, WalletTxnDirection | null> = {
  TOPUP: "CREDIT",
  ADJUSTMENT_CREDIT: "CREDIT",
  PAYMENT: "DEBIT",
  PARTIAL_PAYMENT: "DEBIT",
  ADJUSTMENT_DEBIT: "DEBIT",
  REFUND_WITHDRAWAL: "DEBIT",
  REVERSAL: null,
};

/** Direction a stored transaction type moves money; null for REVERSAL (see above). */
export function txnDirection(type: string): WalletTxnDirection | null {
  return WALLET_TXN_DIRECTION[type as WalletTxnType] ?? null;
}

// ── Lazy wallet creation (outside a transaction is fine for reads) ─────────
export async function getOrCreateWallet(residentId: string) {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.residentId, residentId));
  if (existing) return existing;
  const [created] = await db
    .insert(walletsTable)
    .values({ id: newId(), residentId, balance: "0", isActive: true })
    .returning();
  return created!;
}

// ── Wallet config with safe defaults ──────────────────────────────────────
export async function getWalletConfig(propertyId: string) {
  const [cfg] = await db
    .select()
    .from(walletConfigTable)
    .where(eq(walletConfigTable.propertyId, propertyId));
  return {
    minimumBalance: cfg ? Number(cfg.minimumBalance) : -100,
    lowBalanceAlert: cfg ? Number(cfg.lowBalanceAlert) : 200,
    isEnabled: cfg?.isEnabled ?? true,
  };
}

// ── Atomic credit (TOPUP / ADJUSTMENT_CREDIT / REVERSAL) ───────────────────
// Must be called inside a db.transaction().
// The union is CreditTxnType so a debit-only type (REFUND_WITHDRAWAL) cannot be
// credited by mistake — the compiler enforces the direction map above.
export async function creditWallet(
  walletId: string,
  amount: number,
  type: CreditTxnType,
  meta: WalletTxMeta,
  tx: TxClient
) {
  const [wallet] = await tx
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.id, walletId))
    .for("update");
  if (!wallet) throw new Error("Wallet not found");

  const creditAmount = roundMoney(amount);
  const balanceBefore = roundMoney(Number(wallet.balance));
  const balanceAfter = roundMoney(balanceBefore + creditAmount);

  await tx
    .update(walletsTable)
    .set({ balance: String(balanceAfter), updatedAt: new Date() })
    .where(eq(walletsTable.id, walletId));

  const [txn] = await tx
    .insert(walletTransactionsTable)
    .values({
      id: newId(),
      walletId,
      residentId: wallet.residentId,
      type,
      amount: String(creditAmount),
      balanceBefore: String(balanceBefore),
      balanceAfter: String(balanceAfter),
      description: meta.description,
      recordedBy: meta.recordedBy,
      propertyId: meta.propertyId,
      notes: meta.notes ?? null,
      referenceId: meta.referenceId ?? null,
      referenceType: meta.referenceType ?? null,
      reversalOf: meta.reversalOf ?? null,
    })
    .returning();

  return { txn: txn!, balanceAfter, balanceBefore };
}

// ── Atomic debit (PAYMENT / PARTIAL_PAYMENT / ADJUSTMENT_DEBIT / REVERSAL) ─
// Must be called inside a db.transaction().
// Throws a 422-tagged error if projected balance < minimumBalance.
export async function debitWallet(
  walletId: string,
  amount: number,
  type: DebitTxnType,
  meta: WalletTxMeta,
  config: { minimumBalance: number },
  tx: TxClient
) {
  const [wallet] = await tx
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.id, walletId))
    .for("update");
  if (!wallet) throw new Error("Wallet not found");

  const debitAmount = roundMoney(amount);
  const balanceBefore = roundMoney(Number(wallet.balance));
  const balanceAfter = roundMoney(balanceBefore - debitAmount);

  if (balanceAfter < config.minimumBalance) {
    const err: Error & {
      statusCode?: number;
      details?: Record<string, number>;
    } = new Error("Insufficient wallet balance");
    err.statusCode = 422;
    err.details = {
      currentBalance: balanceBefore,
      requestedDebit: debitAmount,
      minimumBalance: config.minimumBalance,
      maxAllowedDebit: roundMoney(balanceBefore - config.minimumBalance),
    };
    throw err;
  }

  await tx
    .update(walletsTable)
    .set({ balance: String(balanceAfter), updatedAt: new Date() })
    .where(eq(walletsTable.id, walletId));

  const [txn] = await tx
    .insert(walletTransactionsTable)
    .values({
      id: newId(),
      walletId,
      residentId: wallet.residentId,
      type,
      amount: String(debitAmount),
      balanceBefore: String(balanceBefore),
      balanceAfter: String(balanceAfter),
      description: meta.description,
      recordedBy: meta.recordedBy,
      propertyId: meta.propertyId,
      notes: meta.notes ?? null,
      referenceId: meta.referenceId ?? null,
      referenceType: meta.referenceType ?? null,
      reversalOf: meta.reversalOf ?? null,
    })
    .returning();

  return { txn: txn!, balanceAfter, balanceBefore };
}

// ── Reversal ──────────────────────────────────────────────────────────────
// Invariant: a reversal moves the ORIGINAL amount in the OPPOSITE direction to
// the original transaction, and that direction comes from WALLET_TXN_DIRECTION —
// never from a membership list at the call site. `REFUND_WITHDRAWAL` reads like
// a credit but drains the wallet, and reversing it as a credit-reversal debited
// the resident a second time (C2). Lives here, not in the route handler, so the
// arithmetic is testable without HTTP and so a second caller cannot re-derive it.
export async function reverseTransaction(
  walletId: string,
  original: { id: string; type: string; amount: string | number },
  meta: Omit<WalletTxMeta, "reversalOf">,
  tx: TxClient
) {
  // A reversal has no direction of its own (its sign is borrowed from the row it
  // reverses), so reversing one is undefined rather than merely disallowed.
  if (original.type === "REVERSAL") {
    throw badRequest("A reversal transaction cannot be reversed");
  }
  const direction = txnDirection(original.type);
  if (!direction) throw badRequest("Transaction type cannot be reversed");

  const originalAmount = Number(original.amount);
  const reversalMeta: WalletTxMeta = { ...meta, reversalOf: original.id };

  if (direction === "CREDIT") {
    // Original was a credit → the reversal is a debit. A reversal is allowed to
    // push the wallet negative (the money it undoes is already gone), so the
    // minimum-balance floor is opened rather than the write hand-rolled — that
    // keeps every balance write going through debitWallet's rounding.
    const r = await debitWallet(
      walletId,
      originalAmount,
      "REVERSAL",
      reversalMeta,
      { minimumBalance: Number.NEGATIVE_INFINITY },
      tx
    );
    return { ...r, originalAmount, direction };
  }
  // Original was a debit → the reversal is a credit.
  const r = await creditWallet(walletId, originalAmount, "REVERSAL", reversalMeta, tx);
  return { ...r, originalAmount, direction };
}

/** 400 in the shape routes/wallet.ts's catch already understands. */
function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

// ── Audit log (fire-and-forget; never throws) ─────────────────────────────
export async function writeAuditLog(
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  changes: Record<string, unknown>
) {
  try {
    await db.insert(auditLogTable).values({
      id: newId(),
      userId,
      action,
      entity,
      entityId,
      changes,
    });
  } catch (err) {
    logger.warn({ err }, "wallet audit log write failed");
  }
}
