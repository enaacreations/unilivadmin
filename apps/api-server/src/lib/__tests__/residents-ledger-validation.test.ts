/**
 * Bad input on a money write answers 400, never 500.
 *
 * POST /residents/:id/ledger validated only `amount` and passed `body.type`
 * straight into the insert. `ledger_type` has exactly 8 labels, so any other
 * string reached the driver as a 22P02 and a missing one as a NOT NULL
 * violation — both of which the handler's generic catch reported as
 * "Internal server error". This is the endpoint that CREATES the charge
 * /wallet/residents/:id/pay later settles, so an operator who mistypes a charge
 * type is told the server is broken and has no idea the row was never written.
 *
 * The assertions are therefore on the status AND on the table: a 400 that still
 * inserted a row, or a rejection that also blocked a legitimate charge, would
 * both pass a status-only check. The allowed labels are read off the pg enum in
 * the handler, so adding a label to lib/db/src/schema/core.ts widens both at
 * once and cannot drift.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

vi.mock("@workspace/notify-core", () => ({
  enqueueDelivery: async () => false,
  processDeliveryInline: async () => {},
  queueEnabled: () => false,
}));

vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { ledgerEntriesTable, paymentsTable, residentsTable } = await import("@workspace/db");
const { fakeDb, resetDb, seedDb } = await import("./helpers/fake-db.js");
const { callRoute } = await import("./helpers/call-route.js");
const residentsRouter = (await import("../../routes/residents.js")).default;

const RESIDENT = "res-1";
const PROPERTY = "prop-1";
const USER = { id: "user-1", email: "admin@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

const postLedger = (body: unknown) =>
  callRoute(residentsRouter, { method: "POST", url: `/${RESIDENT}/ledger`, body, user: USER });

const postPayment = (body: unknown) =>
  callRoute(residentsRouter, { method: "POST", url: `/${RESIDENT}/payments`, body, user: USER });

const ledgerRows = async () => await fakeDb.select().from(ledgerEntriesTable);
const paymentRows = async () => await fakeDb.select().from(paymentsTable);

beforeEach(() => {
  resetDb();
  seedDb([
    [residentsTable, [{ id: RESIDENT, propertyId: PROPERTY, name: "R", email: "r@x.io", phone: "9", walletEnabled: true, status: "ACTIVE" }]],
    [ledgerEntriesTable, []],
    [paymentsTable, []],
  ]);
});

describe("POST /residents/:id/ledger — type validation", () => {
  it("rejects a type outside the ledger_type enum with 400 and writes nothing", async () => {
    const res = await postLedger({ type: "GARBAGE", amount: 100, description: "Late fee" });

    expect(res.status).toBe(400); // was 500 (22P02 invalid input value for enum)
    expect(res.body.error).toContain("type");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("rejects a missing type with 400 rather than a NOT NULL violation", async () => {
    const res = await postLedger({ amount: 100, description: "Late fee" });

    expect(res.status).toBe(400); // was 500 (23502 null value in column "type")
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("rejects a lower-case label — pg enums are case sensitive", async () => {
    const res = await postLedger({ type: "rent", amount: 100, description: "Rent" });

    expect(res.status).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("rejects a missing description (the other NOT NULL column) with 400", async () => {
    const res = await postLedger({ type: "RENT", amount: 100 });

    expect(res.status).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("rejects an unparseable dueDate with 400 instead of storing an Invalid Date", async () => {
    const res = await postLedger({ type: "RENT", amount: 100, description: "Rent", dueDate: "not-a-date" });

    expect(res.status).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("still accepts a valid charge", async () => {
    const res = await postLedger({ type: "RENT", amount: 100, description: "Rent for July" });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(100);
    expect(res.body.data.type).toBe("RENT");
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("still accepts a collection credit, which defaults type and description", async () => {
    const res = await postLedger({ entryType: "CREDIT", amount: 250 });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("ADJUSTMENT");
    expect(res.body.data.isPaid).toBe(true);
  });

  it("rejects a bad type on the collection branch too", async () => {
    const res = await postLedger({ entryType: "CREDIT", amount: 250, type: "GARBAGE" });

    expect(res.status).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("keeps rejecting a non-positive amount", async () => {
    const res = await postLedger({ type: "RENT", amount: 0, description: "Rent" });

    expect(res.status).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });
});

describe("POST /residents/:id/payments — the sibling on the same invariant", () => {
  it("rejects a missing mode with 400 rather than a NOT NULL violation", async () => {
    const res = await postPayment({ amount: 100 });

    expect(res.status).toBe(400);
    expect(await paymentRows()).toHaveLength(0);
  });

  it("rejects a mode outside payment_mode with 400", async () => {
    const res = await postPayment({ amount: 100, mode: "BITCOIN" });

    expect(res.status).toBe(400);
    expect(await paymentRows()).toHaveLength(0);
  });

  it("rejects a status outside payment_status with 400", async () => {
    const res = await postPayment({ amount: 100, mode: "CASH", status: "MAYBE" });

    expect(res.status).toBe(400);
    expect(await paymentRows()).toHaveLength(0);
  });

  it("still accepts a valid payment", async () => {
    const res = await postPayment({ amount: 100, mode: "CASH", status: "SUCCESS" });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(100);
    expect(await paymentRows()).toHaveLength(1);
  });
});
