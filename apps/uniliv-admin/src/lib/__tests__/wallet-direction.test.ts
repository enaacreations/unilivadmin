import { describe, expect, it } from "vitest";
import { WalletTransactionDtoType } from "@workspace/api-client-react";
import {
  WALLET_TXN_DIRECTION,
  isWalletCredit,
  walletAmountSign,
  walletTxnDirection,
  type WalletTxnDirection,
} from "@/lib/wallet-direction";

/**
 * The web half of C2. `WALLET_TXN_DIRECTION` here mirrors the map in
 * apps/api-server/src/lib/wallet-service.ts, and it is the half that actually
 * rendered the green +₹5,000 staff "corrected" with a second debit — yet it had
 * zero direct coverage. These are the same MECHANICAL checks as the API-side
 * `WALLET_TXN_DIRECTION` describe block in
 * apps/api-server/src/lib/__tests__/wallet-service.test.ts.
 *
 * The map is typed `Record<string, …>` rather than keyed to the enum, so a
 * missing entry is invisible to the compiler and silently falls through to the
 * `?? "DEBIT"` default. Totality therefore has to be asserted at runtime.
 */
const ENUM_TYPES = Object.values(WalletTransactionDtoType) as string[];

/**
 * The expected sign of every stored type. Hand-written ON PURPOSE — this table
 * is the specification — but cross-checked against the generated enum below so
 * it cannot silently fall out of date with the contract.
 */
const EXPECTED_DIRECTION: Record<string, WalletTxnDirection | null> = {
  TOPUP: "CREDIT",
  ADJUSTMENT_CREDIT: "CREDIT",
  PAYMENT: "DEBIT",
  PARTIAL_PAYMENT: "DEBIT",
  ADJUSTMENT_DEBIT: "DEBIT",
  // C2: checkout hands the resident cash and DRAINS the wallet. It is a DEBIT.
  // Do not "simplify" this into a name-suffix rule — REFUND_ reads like money
  // coming in and it is money going out.
  REFUND_WITHDRAWAL: "DEBIT",
  // No intrinsic sign: a reversal borrows the direction of the row it reverses.
  REVERSAL: null,
};

describe("WALLET_TXN_DIRECTION (web mirror)", () => {
  it("is total over the wallet transaction type contract, with no stray entries", () => {
    // Mechanical, not against a copied list: adding a type to the API contract
    // fails HERE rather than defaulting to DEBIT at runtime. That is the exact
    // shape of C2 — a type the direction logic had never been told about.
    expect(Object.keys(WALLET_TXN_DIRECTION).sort()).toEqual([...ENUM_TYPES].sort());
  });

  it("the expectation table in this file covers exactly the same enum", () => {
    expect(Object.keys(EXPECTED_DIRECTION).sort()).toEqual([...ENUM_TYPES].sort());
  });

  it("agrees with the server's map on every type", () => {
    // Pins the mirror itself: the two maps must not drift apart.
    for (const type of ENUM_TYPES) {
      expect(WALLET_TXN_DIRECTION[type]).toBe(EXPECTED_DIRECTION[type]);
    }
  });

  it("REFUND_WITHDRAWAL is a DEBIT (C2)", () => {
    expect(WALLET_TXN_DIRECTION["REFUND_WITHDRAWAL"]).toBe("DEBIT");
  });

  it("REVERSAL carries no intrinsic direction", () => {
    expect(WALLET_TXN_DIRECTION["REVERSAL"]).toBeNull();
  });
});

describe("walletTxnDirection — precedence", () => {
  it("reads the balance delta in preference to the type map", () => {
    // The delta is the ledger's own record of what happened; the map is a guess
    // from a name. Where they disagree, the delta wins — a REFUND_WITHDRAWAL row
    // whose balance went UP really was a credit, whatever it is called.
    expect(walletTxnDirection({ type: "REFUND_WITHDRAWAL", balanceBefore: 100, balanceAfter: 600 }))
      .toBe("CREDIT");
    expect(walletTxnDirection({ type: "TOPUP", balanceBefore: 600, balanceAfter: 100 }))
      .toBe("DEBIT");
  });

  it("resolves REVERSAL from the delta in both directions", () => {
    expect(walletTxnDirection({ type: "REVERSAL", balanceBefore: 0, balanceAfter: 500 }))
      .toBe("CREDIT");
    expect(walletTxnDirection({ type: "REVERSAL", balanceBefore: 500, balanceAfter: 0 }))
      .toBe("DEBIT");
  });

  it("accepts numeric strings, as the API serialises them", () => {
    expect(walletTxnDirection({ type: "REVERSAL", balanceBefore: "0.00", balanceAfter: "500.00" }))
      .toBe("CREDIT");
    expect(walletTxnDirection({ type: "REVERSAL", balanceBefore: "500.00", balanceAfter: "0.00" }))
      .toBe("DEBIT");
  });

  it("falls back to the type map only when balances are absent or unusable", () => {
    expect(walletTxnDirection({ type: "TOPUP" })).toBe("CREDIT");
    expect(walletTxnDirection({ type: "REFUND_WITHDRAWAL" })).toBe("DEBIT");
    expect(walletTxnDirection({ type: "PAYMENT", balanceBefore: null, balanceAfter: null }))
      .toBe("DEBIT");
    expect(walletTxnDirection({ type: "TOPUP", balanceBefore: "n/a", balanceAfter: "n/a" }))
      .toBe("CREDIT");
  });

  it("falls back to DEBIT for REVERSAL when balances are absent", () => {
    // REVERSAL maps to null, so the `?? "DEBIT"` default decides. DEBIT is the
    // cautious answer: overstating a credit is what C2 did.
    expect(walletTxnDirection({ type: "REVERSAL" })).toBe("DEBIT");
  });

  it("falls back to DEBIT for a type the map has never heard of", () => {
    expect(walletTxnDirection({ type: "SOMETHING_NEW" })).toBe("DEBIT");
  });

  it("treats a zero-delta row as having no direction and uses the map", () => {
    expect(walletTxnDirection({ type: "TOPUP", balanceBefore: 100, balanceAfter: 100 }))
      .toBe("CREDIT");
    expect(walletTxnDirection({ type: "REVERSAL", balanceBefore: 100, balanceAfter: 100 }))
      .toBe("DEBIT");
  });
});

describe("display helpers follow the resolved direction", () => {
  it("signs a REFUND_WITHDRAWAL as money leaving the wallet (C2)", () => {
    const refund = { type: "REFUND_WITHDRAWAL", balanceBefore: 5000, balanceAfter: 0 };
    expect(isWalletCredit(refund)).toBe(false);
    expect(walletAmountSign(refund)).toBe("−");
  });

  it("signs a topup as money arriving", () => {
    const topup = { type: "TOPUP", balanceBefore: 0, balanceAfter: 5000 };
    expect(isWalletCredit(topup)).toBe(true);
    expect(walletAmountSign(topup)).toBe("+");
  });
});
