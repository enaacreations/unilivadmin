/**
 * The money primitives, pinned.
 *
 * Everything in wallet-service is one of two invariants, and both have already
 * been broken in production:
 *
 *   1. DIRECTION IS A PROPERTY OF THE TYPE. `REFUND_WITHDRAWAL` reads like a
 *      credit but drains the wallet, so a reversal of it must CREDIT. Deriving
 *      the sign from an ad-hoc membership list got that backwards and debited a
 *      resident a SECOND time (C2). The map is therefore asserted MECHANICALLY
 *      against the pg enum: a new transaction type added to lib/db/src/schema/
 *      wallet.ts fails this file instead of silently falling through to `null`
 *      and being refused — or worse, being classified by omission.
 *
 *   2. NOTHING BUT A 2-DECIMAL VALUE IS WRITTEN TO A MONEY COLUMN. Balances are
 *      JS floats; `roundMoney` is the only thing standing between 0.1 + 0.2 and
 *      a staff-facing "₹0.30000000000000004". It has to be applied to `amount`,
 *      `balanceBefore` AND `balanceAfter` — rounding two of the three leaves a
 *      ledger that does not sum to its own balance.
 *
 * The reversal arithmetic is exercised through `reverseTransaction` rather than
 * through the HTTP route, against the in-memory fake db, so the assertions are
 * on RUPEES IN THE WALLET and not on a status code. "It ran" is not an assertion.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  walletTransactionTypeEnum,
  walletTransactionsTable,
  walletsTable,
} from "@workspace/db";
import { fakeDb, resetDb, seedDb } from "./helpers/fake-db.js";
import {
  WALLET_TXN_DIRECTION,
  creditWallet,
  debitWallet,
  reverseTransaction,
  roundMoney,
  txnDirection,
  type CreditTxnType,
  type DebitTxnType,
  type TxClient,
  type WalletTxnDirection,
} from "../wallet-service.js";

const WALLET = "wal-1";
const RESIDENT = "res-1";
const PROPERTY = "prop-1";

/** The fake db doubles as the transaction client: both are just a query builder. */
const tx = fakeDb as unknown as TxClient;

const meta = (over: Record<string, unknown> = {}) => ({
  description: "test",
  recordedBy: "user-1",
  propertyId: PROPERTY,
  ...over,
});

function seedWallet(balance: string): void {
  seedDb([
    [walletsTable, [{ id: WALLET, residentId: RESIDENT, balance, isActive: true }]],
    [walletTransactionsTable, []],
  ]);
}

async function walletRow(): Promise<Record<string, any>> {
  const [w] = await fakeDb.select().from(walletsTable).where(eq(walletsTable.id, WALLET));
  return w as Record<string, any>;
}

const balance = async (): Promise<number> => Number((await walletRow())["balance"]);

async function ledger(): Promise<Array<Record<string, any>>> {
  return (await fakeDb
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.walletId, WALLET))) as Array<Record<string, any>>;
}

beforeEach(() => {
  resetDb();
  seedWallet("0");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The direction map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The expected sign of every stored type. Hand-written ON PURPOSE — this table
 * is the specification — but it is cross-checked against the pg enum below, so
 * it cannot silently fall out of date with the schema the way the ad-hoc call-site
 * lists did.
 */
const EXPECTED_DIRECTION: Record<string, WalletTxnDirection | null> = {
  TOPUP: "CREDIT",
  ADJUSTMENT_CREDIT: "CREDIT",
  PAYMENT: "DEBIT",
  PARTIAL_PAYMENT: "DEBIT",
  ADJUSTMENT_DEBIT: "DEBIT",
  // C2: checkout hands the resident cash and DRAINS the wallet. It is a DEBIT.
  // Classifying it as a credit made the reversal path debit a second time. Do
  // not "simplify" this back into a name-suffix rule — REFUND_ reads like money
  // coming in and it is money going out.
  REFUND_WITHDRAWAL: "DEBIT",
  // No intrinsic sign: a reversal borrows the direction of the row it reverses,
  // which is why reverseTransaction resolves it from the ORIGINAL type.
  REVERSAL: null,
};

const ENUM_TYPES = [...walletTransactionTypeEnum.enumValues] as string[];

describe("WALLET_TXN_DIRECTION", () => {
  it("is total over the wallet_transaction_type pg enum, with no stray entries", () => {
    // Mechanical, not against a copied list: adding a type to the schema enum
    // fails HERE rather than defaulting to null at runtime. This is the exact
    // shape of C2 — a type the direction logic had never been told about.
    expect(Object.keys(WALLET_TXN_DIRECTION).sort()).toEqual([...ENUM_TYPES].sort());
  });

  it("the expectation table in this file covers exactly the same enum", () => {
    expect(Object.keys(EXPECTED_DIRECTION).sort()).toEqual([...ENUM_TYPES].sort());
  });

  it.each(ENUM_TYPES)("classifies %s correctly", (type) => {
    expect(WALLET_TXN_DIRECTION[type as keyof typeof WALLET_TXN_DIRECTION]).toBe(
      EXPECTED_DIRECTION[type],
    );
    expect(txnDirection(type)).toBe(EXPECTED_DIRECTION[type]);
  });

  it("REFUND_WITHDRAWAL is a DEBIT (C2)", () => {
    expect(txnDirection("REFUND_WITHDRAWAL")).toBe("DEBIT");
  });

  it("returns null for a type the ledger has never stored", () => {
    expect(txnDirection("NOT_A_TYPE")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. roundMoney
// ─────────────────────────────────────────────────────────────────────────────

describe("roundMoney", () => {
  it.each([
    // The canonical float artefacts. Left un-rounded these reach a money column
    // verbatim (the column is numeric(12,2) now, but the value also reaches
    // staff-facing text before it is ever stored).
    [0.1 + 0.2, 0.3],
    [0.30000000000000004, 0.3],
    [1.005, 1.01],
    [2.675, 2.68],
    [1.0000000000001, 1],
    // Below the half-paisa: rounds down, no creeping gain.
    [1.004, 1],
    [1.0049999, 1],
    [0.005, 0.01],
    // Already-clean values are untouched.
    [0, 0],
    [1234.56, 1234.56],
    // Large values still land on 2 decimals (99,999,999.999 → 1e8 exactly).
    [12345678.905, 12345678.91],
    [99999999.999, 100000000],
  ])("rounds %d to %d", (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
  });

  it.each([
    // Negatives round AWAY from zero, symmetrically with their positive twin —
    // Math.round alone rounds -1.005 to -1.00, so a refund and its reversal
    // would differ by a paisa and the ledger would stop balancing.
    [-1.005, -1.01],
    [-0.005, -0.01],
    [-(0.1 + 0.2), -0.3],
    [-2.675, -2.68],
    [-1234.56, -1234.56],
  ])("rounds %d to %d", (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
    expect(roundMoney(input)).toBe(-roundMoney(-input));
  });

  it("never produces more than 2 decimal places", () => {
    for (const v of [0.1 + 0.2, 1.005, 1 / 3, 2 / 3, 1e6 / 7, -1 / 3]) {
      const decimals = (String(roundMoney(v)).split(".")[1] ?? "").length;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. roundMoney is applied to all three money columns, on both primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A wallet whose stored balance is already a float artefact (the state a
 * pre-fix row leaves behind). Both primitives must round the balance they READ
 * as well as the one they write, or the artefact is copied forward into
 * balanceBefore forever.
 */
const DIRTY_BALANCE = "0.30000000000000004";

describe("creditWallet / debitWallet money rounding", () => {
  it("rounds amount, balanceBefore and balanceAfter on a credit", async () => {
    seedWallet(DIRTY_BALANCE);
    const r = await creditWallet(WALLET, 0.1 + 0.2, "TOPUP", meta(), tx);

    expect(r.txn.amount).toBe("0.3");
    expect(r.txn.balanceBefore).toBe("0.3");
    expect(r.txn.balanceAfter).toBe("0.6");
    expect(r.balanceBefore).toBe(0.3);
    expect(r.balanceAfter).toBe(0.6);
    expect(await balance()).toBe(0.6);
  });

  it("rounds amount, balanceBefore and balanceAfter on a debit", async () => {
    seedWallet(DIRTY_BALANCE);
    const r = await debitWallet(WALLET, 0.1 + 0.2, "PAYMENT", meta(), { minimumBalance: -100 }, tx);

    expect(r.txn.amount).toBe("0.3");
    expect(r.txn.balanceBefore).toBe("0.3");
    expect(r.txn.balanceAfter).toBe("0");
    expect(r.balanceAfter).toBe(0);
    expect(await balance()).toBe(0);
  });

  it("keeps the ledger summing to the balance across a run of dirty amounts", async () => {
    seedWallet("0");
    for (let i = 0; i < 10; i++) await creditWallet(WALLET, 0.1, "TOPUP", meta(), tx);
    // 0.1 accumulated ten times is 0.9999999999999999 in raw floating point;
    // rounding at every write is what keeps the stored balance at exactly 1.
    expect(await balance()).toBe(1);

    const rows = await ledger();
    expect(rows).toHaveLength(10);
    // Every row is a clean 2-decimal value AND continues the previous one — the
    // ledger reconstructs the balance rather than merely tracking it loosely.
    let running = 0;
    for (const r of rows) {
      expect(Number(r["balanceBefore"])).toBe(running);
      running = roundMoney(running + Number(r["amount"]));
      expect(Number(r["balanceAfter"])).toBe(running);
      for (const col of ["amount", "balanceBefore", "balanceAfter"]) {
        expect(Number(r[col])).toBe(roundMoney(Number(r[col])));
      }
    }
    expect(running).toBe(await balance());
  });

  it("refuses a debit that would breach the minimum balance, and writes nothing", async () => {
    seedWallet("50");
    await expect(
      debitWallet(WALLET, 500, "PAYMENT", meta(), { minimumBalance: -100 }, tx),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await balance()).toBe(50);
    expect(await ledger()).toHaveLength(0);
  });

  it("reports the 422 headroom in rounded rupees", async () => {
    seedWallet(DIRTY_BALANCE);
    await expect(
      debitWallet(WALLET, 1000, "PAYMENT", meta(), { minimumBalance: -100 }, tx),
    ).rejects.toMatchObject({
      details: {
        currentBalance: 0.3,
        requestedDebit: 1000,
        minimumBalance: -100,
        maxAllowedDebit: 100.3,
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The reversal path (C2)
// ─────────────────────────────────────────────────────────────────────────────

describe("reverseTransaction", () => {
  it("reversing a CREDIT debits the wallet back to where it started", async () => {
    seedWallet("100");
    const topup = await creditWallet(WALLET, 500, "TOPUP", meta(), tx);
    expect(await balance()).toBe(600);

    const rev = await reverseTransaction(WALLET, topup.txn, meta(), tx);

    expect(rev.direction).toBe("CREDIT"); // direction OF THE ORIGINAL
    expect(rev.txn.type).toBe("REVERSAL");
    expect(rev.txn.amount).toBe("500");
    expect(Number(rev.txn.balanceAfter)).toBeLessThan(Number(rev.txn.balanceBefore));
    expect(rev.txn.reversalOf).toBe(topup.txn.id);
    expect(await balance()).toBe(100);
  });

  it("reversing a DEBIT credits the wallet back to where it started", async () => {
    seedWallet("600");
    const payment = await debitWallet(
      WALLET,
      500,
      "PAYMENT",
      meta(),
      { minimumBalance: -100 },
      tx,
    );
    expect(await balance()).toBe(100);

    const rev = await reverseTransaction(WALLET, payment.txn, meta(), tx);

    expect(rev.direction).toBe("DEBIT");
    expect(Number(rev.txn.balanceAfter)).toBeGreaterThan(Number(rev.txn.balanceBefore));
    expect(await balance()).toBe(600);
  });

  it("reversing a REFUND_WITHDRAWAL CREDITS the wallet — it does not debit twice (C2)", async () => {
    // The defect, exactly: checkout drained ₹5,000, staff saw a green +₹5,000 in
    // the history and "corrected" it with a reversal, and the reversal debited
    // again — the resident ended at −₹5,000 instead of back at ₹5,000.
    seedWallet("5000");
    const refund = await debitWallet(
      WALLET,
      5000,
      "REFUND_WITHDRAWAL",
      meta(),
      { minimumBalance: -100 },
      tx,
    );
    expect(await balance()).toBe(0);

    const rev = await reverseTransaction(WALLET, refund.txn, meta(), tx);

    expect(rev.balanceAfter).toBe(5000);
    expect(await balance()).toBe(5000);
    expect(await balance()).not.toBe(-5000);
  });

  it("reverses the ORIGINAL amount, rounded, not the amount passed by the caller", async () => {
    seedWallet("0");
    const topup = await creditWallet(WALLET, 0.1 + 0.2, "TOPUP", meta(), tx);
    const rev = await reverseTransaction(WALLET, topup.txn, meta(), tx);
    expect(rev.txn.amount).toBe("0.3");
    expect(await balance()).toBe(0);
  });

  it("may push the wallet below the minimum balance (the money it undoes is gone)", async () => {
    seedWallet("0");
    const topup = await creditWallet(WALLET, 500, "TOPUP", meta(), tx);
    await debitWallet(WALLET, 500, "PAYMENT", meta(), { minimumBalance: -100 }, tx);
    expect(await balance()).toBe(0);

    // Reversing the top-up now takes the wallet to −500, well past the −100
    // floor. It must still succeed, and it must still go through debitWallet so
    // the write is rounded like every other.
    const rev = await reverseTransaction(WALLET, topup.txn, meta(), tx);
    expect(rev.balanceAfter).toBe(-500);
    expect(await balance()).toBe(-500);
  });

  it("refuses to reverse a REVERSAL, before touching the wallet", async () => {
    seedWallet("100");
    const topup = await creditWallet(WALLET, 500, "TOPUP", meta(), tx);
    const rev = await reverseTransaction(WALLET, topup.txn, meta(), tx);
    const rowsBefore = (await ledger()).length;

    await expect(reverseTransaction(WALLET, rev.txn, meta(), tx)).rejects.toMatchObject({
      statusCode: 400,
    });
    // A refusal that had already moved money would be worse than the bug.
    expect(await balance()).toBe(100);
    expect(await ledger()).toHaveLength(rowsBefore);
  });

  it("refuses a type the direction map does not know, before touching the wallet", async () => {
    seedWallet("100");
    await expect(
      reverseTransaction(WALLET, { id: "t-x", type: "NOT_A_TYPE", amount: "10" }, meta(), tx),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await balance()).toBe(100);
    expect(await ledger()).toHaveLength(0);
  });

  it("round-trips every reversible type back to the starting balance", async () => {
    // The generic form of C2: whatever the type, original + reversal = 0.
    for (const type of ENUM_TYPES.filter((t) => EXPECTED_DIRECTION[t] !== null)) {
      resetDb();
      seedWallet("1000");
      const direction = EXPECTED_DIRECTION[type]!;
      const original =
        direction === "CREDIT"
          ? await creditWallet(WALLET, 250.55, type as CreditTxnType, meta(), tx)
          : await debitWallet(
              WALLET,
              250.55,
              type as DebitTxnType,
              meta(),
              { minimumBalance: -100 },
              tx,
            );
      expect(await balance()).toBe(direction === "CREDIT" ? 1250.55 : 749.45);

      await reverseTransaction(WALLET, original.txn, meta(), tx);
      expect(await balance(), `${type} did not round-trip`).toBe(1000);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The compile-time half of the same invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("credit/debit type unions (compile-time guard)", () => {
  it("CreditTxnType excludes every debit-only type", () => {
    // These are @ts-expect-error assertions, checked by `pnpm run typecheck`
    // (tsconfig includes src/**, and this file lives under src). If someone
    // widens CreditTxnType to the full enum, the directive becomes unused and
    // the typecheck FAILS — which is the point: the compiler is what stops
    // creditWallet(…, "REFUND_WITHDRAWAL") from ever being written again.
    // @ts-expect-error REFUND_WITHDRAWAL drains the wallet; it can never be credited (C2)
    const refund: CreditTxnType = "REFUND_WITHDRAWAL";
    // @ts-expect-error PAYMENT is debit-only
    const payment: CreditTxnType = "PAYMENT";
    // @ts-expect-error PARTIAL_PAYMENT is debit-only
    const partial: CreditTxnType = "PARTIAL_PAYMENT";
    // @ts-expect-error ADJUSTMENT_DEBIT is debit-only
    const adjDebit: CreditTxnType = "ADJUSTMENT_DEBIT";
    expect([refund, payment, partial, adjDebit]).toHaveLength(4);
  });

  it("DebitTxnType excludes every credit-only type", () => {
    // @ts-expect-error TOPUP is credit-only
    const topup: DebitTxnType = "TOPUP";
    // @ts-expect-error ADJUSTMENT_CREDIT is credit-only
    const adjCredit: DebitTxnType = "ADJUSTMENT_CREDIT";
    expect([topup, adjCredit]).toHaveLength(2);
  });

  it("REVERSAL is the only type both unions admit", () => {
    const asCredit: CreditTxnType = "REVERSAL";
    const asDebit: DebitTxnType = "REVERSAL";
    // Because its sign is borrowed, reverseTransaction can dispatch it either way.
    expect([asCredit, asDebit]).toEqual(["REVERSAL", "REVERSAL"]);
  });
});
