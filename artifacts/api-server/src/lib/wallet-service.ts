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

// ── Atomic credit (TOPUP / ADJUSTMENT_CREDIT / REFUND_WITHDRAWAL / REVERSAL)
// Must be called inside a db.transaction().
export async function creditWallet(
  walletId: string,
  amount: number,
  type:
    | "TOPUP"
    | "ADJUSTMENT_CREDIT"
    | "REFUND_WITHDRAWAL"
    | "REVERSAL",
  meta: WalletTxMeta,
  tx: TxClient
) {
  const [wallet] = await tx
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.id, walletId))
    .for("update");
  if (!wallet) throw new Error("Wallet not found");

  const balanceBefore = Number(wallet.balance);
  const balanceAfter = balanceBefore + amount;

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
      amount: String(amount),
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
  type:
    | "PAYMENT"
    | "PARTIAL_PAYMENT"
    | "ADJUSTMENT_DEBIT"
    | "REFUND_WITHDRAWAL"
    | "REVERSAL",
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

  const balanceBefore = Number(wallet.balance);
  const balanceAfter = balanceBefore - amount;

  if (balanceAfter < config.minimumBalance) {
    const err: Error & {
      statusCode?: number;
      details?: Record<string, number>;
    } = new Error("Insufficient wallet balance");
    err.statusCode = 422;
    err.details = {
      currentBalance: balanceBefore,
      requestedDebit: amount,
      minimumBalance: config.minimumBalance,
      maxAllowedDebit: balanceBefore - config.minimumBalance,
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
      amount: String(amount),
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
