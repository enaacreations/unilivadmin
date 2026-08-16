/**
 * An idempotency key identifies ONE request — replaying it with a DIFFERENT
 * body is a conflict, never a success report.
 *
 * The bug this pins was observed live against the running server: two POSTs to
 * /wallet/residents/:id/pay with the SAME Idempotency-Key but different
 * `ledgerEntryIds` both answered HTTP 200, and the second one returned the FIRST
 * call's payment object with entriesPaid:1 — while the ledger entry it actually
 * asked for stayed is_paid=false and the wallet balance never moved. The replay
 * branch keyed only on wallet + referenceType + notes and never looked at the
 * payload, so "this key has been seen" was treated as "this work has been done".
 * A caller told an entry was settled has no reason to retry it; the charge just
 * silently survives.
 *
 * So the assertions below are on RUPEES AND `is_paid`, not on a status code
 * alone: a 409 that still left the second entry unpaid is the point, and a
 * genuine retry of the IDENTICAL request must still be answered from the
 * original result rather than debiting twice.
 *
 * topup and adjust share the shape (same key, different amount) and are checked
 * here too — a guard on one sibling and not the others is not a fix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

// The outbound-notification pipeline is not part of this invariant and would
// reach for Redis on import; the wallet paths under test never call it.
vi.mock("@workspace/notify-core", () => ({
  enqueueDelivery: async () => false,
  processDeliveryInline: async () => {},
  queueEnabled: () => false,
}));

// RBAC is asserted by permissions-sync.test.ts. This file is about replay
// semantics, so the chain is opened and the caller is set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const {
  ledgerEntriesTable,
  paymentsTable,
  residentsTable,
  walletsTable,
  walletTransactionsTable,
  walletConfigTable,
  auditLogTable,
} = await import("@workspace/db");
const { fakeDb, resetDb, seedDb } = await import("./helpers/fake-db.js");
const { callRoute } = await import("./helpers/call-route.js");
const { walletRouter } = await import("../../routes/wallet.js");

const RESIDENT = "res-1";
const PROPERTY = "prop-1";
const WALLET = "wal-1";
const ENTRY_A = "led-a";
const ENTRY_B = "led-b";
const KEY = "key-abc";

const USER = { id: "user-1", email: "admin@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

function seed(openingBalance: string): void {
  seedDb([
    [residentsTable, [{ id: RESIDENT, propertyId: PROPERTY, name: "R", email: "r@x.io", phone: "9", walletEnabled: true, status: "ACTIVE" }]],
    [walletsTable, [{ id: WALLET, residentId: RESIDENT, balance: openingBalance, isActive: true }]],
    [walletTransactionsTable, []],
    [walletConfigTable, []],
    [paymentsTable, []],
    [auditLogTable, []],
    [ledgerEntriesTable, [
      { id: ENTRY_A, residentId: RESIDENT, type: "RENT", amount: "100", description: "A", isPaid: false },
      { id: ENTRY_B, residentId: RESIDENT, type: "FOOD", amount: "250", description: "B", isPaid: false },
    ]],
  ]);
}

const pay = (body: unknown, key?: string) =>
  callRoute(walletRouter, {
    method: "POST",
    url: `/wallet/residents/${RESIDENT}/pay`,
    body,
    user: USER,
    headers: key ? { "idempotency-key": key } : {},
  });

const post = (path: string, body: unknown, key?: string) =>
  callRoute(walletRouter, {
    method: "POST",
    url: `/wallet/residents/${RESIDENT}/${path}`,
    body,
    user: USER,
    headers: key ? { "idempotency-key": key } : {},
  });

async function balance(): Promise<number> {
  const [w] = await fakeDb.select().from(walletsTable).where(eq(walletsTable.id, WALLET));
  return Number((w as Record<string, unknown>)["balance"]);
}

async function entry(id: string): Promise<Record<string, unknown>> {
  const [e] = await fakeDb.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.id, id));
  return e as Record<string, unknown>;
}

async function walletTxns(): Promise<Array<Record<string, unknown>>> {
  return (await fakeDb
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.walletId, WALLET))) as Array<Record<string, unknown>>;
}

async function payments(): Promise<Array<Record<string, unknown>>> {
  return (await fakeDb
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.residentId, RESIDENT))) as Array<Record<string, unknown>>;
}

describe("POST /wallet/residents/:id/pay — idempotency replay", () => {
  beforeEach(() => {
    resetDb();
    seed("1000");
  });

  it("settles the requested entry on the first call", async () => {
    const res = await pay({ ledgerEntryIds: [ENTRY_A] }, KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.entriesPaid).toBe(1);
    expect(await balance()).toBe(900);
    expect((await entry(ENTRY_A))["isPaid"]).toBe(true);
  });

  it("refuses the same key with a DIFFERENT entry, and leaves that entry unpaid", async () => {
    await pay({ ledgerEntryIds: [ENTRY_A] }, KEY);

    const replay = await pay({ ledgerEntryIds: [ENTRY_B] }, KEY);

    // The whole defect in one assertion: this used to be 200 + entriesPaid:1.
    expect(replay.status).toBe(409);
    expect(replay.body.success).toBe(false);
    expect(replay.body.data).toBeUndefined();

    // …and nothing about entry B moved, which is what the 200 had claimed.
    expect((await entry(ENTRY_B))["isPaid"]).toBe(false);
    expect(await balance()).toBe(900);
    expect(await payments()).toHaveLength(1);
    expect(await walletTxns()).toHaveLength(1);
  });

  it("refuses the same key when only the note differs", async () => {
    await pay({ ledgerEntryIds: [ENTRY_A], notes: "cash desk" }, KEY);

    const replay = await pay({ ledgerEntryIds: [ENTRY_A], notes: "front office" }, KEY);

    expect(replay.status).toBe(409);
    expect(await walletTxns()).toHaveLength(1);
  });

  it("replays an IDENTICAL retry from the original result without debiting twice", async () => {
    const first = await pay({ ledgerEntryIds: [ENTRY_A], notes: "cash desk" }, KEY);
    const retry = await pay({ ledgerEntryIds: [ENTRY_A], notes: "cash desk" }, KEY);

    expect(retry.status).toBe(200);
    expect(retry.body.data.payment.id).toBe(first.body.data.payment.id);
    expect(retry.body.data.walletTransaction.id).toBe(first.body.data.walletTransaction.id);
    // Exactly one debit, one payment row — the money moved once.
    expect(await balance()).toBe(900);
    expect(await walletTxns()).toHaveLength(1);
    expect(await payments()).toHaveLength(1);
  });

  it("treats the same entry set in a different order as the same request", async () => {
    const first = await pay({ ledgerEntryIds: [ENTRY_A, ENTRY_B] }, KEY);
    const retry = await pay({ ledgerEntryIds: [ENTRY_B, ENTRY_A] }, KEY);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.data.payment.id).toBe(first.body.data.payment.id);
    expect(await balance()).toBe(650);
  });

  it("keeps two different keys independent", async () => {
    await pay({ ledgerEntryIds: [ENTRY_A] }, KEY);
    const second = await pay({ ledgerEntryIds: [ENTRY_B] }, "key-other");

    expect(second.status).toBe(200);
    expect((await entry(ENTRY_B))["isPaid"]).toBe(true);
    expect(await balance()).toBe(650);
  });
});

describe("sibling money paths — same key, different body", () => {
  beforeEach(() => {
    resetDb();
    seed("1000");
  });

  it("topup refuses a replay with a different amount and credits only once", async () => {
    const first = await post("topup", { amount: 500 }, KEY);
    expect(first.status).toBe(200);
    expect(await balance()).toBe(1500);

    const replay = await post("topup", { amount: 5000 }, KEY);

    expect(replay.status).toBe(409);
    expect(await balance()).toBe(1500);
    expect(await walletTxns()).toHaveLength(1);
  });

  it("topup replays an identical retry", async () => {
    const first = await post("topup", { amount: 500 }, KEY);
    const retry = await post("topup", { amount: 500 }, KEY);

    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await balance()).toBe(1500);
    expect(await walletTxns()).toHaveLength(1);
  });

  it("adjust refuses a replay with a different amount and adjusts only once", async () => {
    const body = { type: "ADJUSTMENT_CREDIT", amount: 200, description: "goodwill" };
    const first = await post("adjust", body, KEY);
    expect(first.status).toBe(200);
    expect(await balance()).toBe(1200);

    const replay = await post("adjust", { ...body, amount: 900 }, KEY);

    expect(replay.status).toBe(409);
    expect(await balance()).toBe(1200);
    expect(await walletTxns()).toHaveLength(1);
  });

  it("adjust refuses a replay that flips the direction", async () => {
    await post("adjust", { type: "ADJUSTMENT_CREDIT", amount: 200, description: "goodwill" }, KEY);

    const replay = await post(
      "adjust",
      { type: "ADJUSTMENT_DEBIT", amount: 200, description: "goodwill" },
      KEY,
    );

    expect(replay.status).toBe(409);
    expect(await balance()).toBe(1200);
  });
});
