/**
 * Which way a wallet transaction moved money.
 *
 * Invariant: the sign shown to staff is the sign the ledger actually recorded.
 * Reading it off a membership list of type names got REFUND_WITHDRAWAL wrong —
 * checkout hands cash back and DRAINS the wallet, so it is a debit — and the
 * green +₹5,000 that produced was what convinced staff to "correct" it with a
 * reversal that debited a second time (C2). REVERSAL has no intrinsic sign at
 * all: it inherits the direction of whatever it reverses.
 *
 * So the row's own balance delta is the source of truth, and the type map is
 * only the fallback for a payload that does not carry balances. The map mirrors
 * WALLET_TXN_DIRECTION in apps/api-server/src/lib/wallet-service.ts — keep the
 * two in step.
 */
export type WalletTxnDirection = "CREDIT" | "DEBIT";

/** null = no intrinsic direction (REVERSAL); resolve from the balance delta. */
export const WALLET_TXN_DIRECTION: Record<string, WalletTxnDirection | null> = {
  TOPUP: "CREDIT",
  ADJUSTMENT_CREDIT: "CREDIT",
  PAYMENT: "DEBIT",
  PARTIAL_PAYMENT: "DEBIT",
  ADJUSTMENT_DEBIT: "DEBIT",
  REFUND_WITHDRAWAL: "DEBIT",
  REVERSAL: null,
};

export interface WalletTxnLike {
  type: string;
  balanceBefore?: number | string | null;
  balanceAfter?: number | string | null;
}

/**
 * CREDIT when the balance went up, DEBIT when it went down. Falls back to the
 * type map (then to DEBIT) when the row carries no usable balances — a
 * zero-value row has no direction to show, and DEBIT is the cautious default.
 */
export function walletTxnDirection(txn: WalletTxnLike): WalletTxnDirection {
  const before = Number(txn.balanceBefore);
  const after = Number(txn.balanceAfter);
  if (Number.isFinite(before) && Number.isFinite(after) && after !== before) {
    return after > before ? "CREDIT" : "DEBIT";
  }
  return WALLET_TXN_DIRECTION[txn.type] ?? "DEBIT";
}

/** `true` when the row increased the wallet balance. */
export function isWalletCredit(txn: WalletTxnLike): boolean {
  return walletTxnDirection(txn) === "CREDIT";
}

/** Tailwind text colour for the signed amount. */
export function walletAmountClass(txn: WalletTxnLike): string {
  return isWalletCredit(txn) ? "text-green-600" : "text-red-600";
}

/** "+" / "−" prefix for the signed amount. */
export function walletAmountSign(txn: WalletTxnLike, minus = "−"): string {
  return isWalletCredit(txn) ? "+" : minus;
}
