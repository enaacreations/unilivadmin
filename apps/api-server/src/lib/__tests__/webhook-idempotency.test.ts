/**
 * Razorpay webhook idempotency — the money path, pinned.
 *
 * C1 has been "fixed" three times because nothing held it still. The defect is
 * never that the handler throws; it is that it credits the WRONG TOTAL when the
 * two events Razorpay may deliver (`payment.captured` and `payment_link.paid`)
 * arrive in an order, a combination or a repetition the code did not anticipate.
 * So every case here drives real event payloads through `correlationFromEntity`
 * (which decides how the two shapes are read — half of what has been wrong) into
 * the real settle functions, and asserts the EXACT rupees in the wallet / the
 * exact number of SUCCESS payment rows. "It ran" is not an assertion.
 *
 * The database is the in-memory fake, which evaluates the real drizzle condition
 * trees against seeded rows — so the queries under test decide the answers, and
 * no query is stubbed out. Concurrency is out of scope here: two simultaneous
 * deliveries are held apart by the unique indexes and the isUniqueViolation
 * catch, which needs a real Postgres to exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ledgerEntriesTable,
  paymentsTable,
  residentsTable,
  walletTransactionsTable,
  walletsTable,
} from "@workspace/db";
import { fakeDb, resetDb, seedDb } from "./helpers/fake-db.js";

vi.hoisted(() => {
  // routes/webhooks.ts pulls in config/env.ts, which fails closed on a weak
  // secret outside development. Set one before the module graph loads.
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

import {
  correlationFromEntity,
  settleResidentDues,
  settleWalletTopup,
} from "../../routes/webhooks.js";

const RESIDENT = "res-1";
const PROPERTY = "prop-1";
const LINK = "plink_1";

const topupNotes = (linkRef: string | null) => ({
  kind: "WALLET_TOPUP",
  residentId: RESIDENT,
  propertyId: PROPERTY,
  ...(linkRef ? { linkRef } : {}),
});

const duesNotes = (linkRef: string | null, propertyId: string | null = PROPERTY) => ({
  kind: "RESIDENT_DUES",
  residentId: RESIDENT,
  ...(propertyId ? { propertyId } : {}),
  ...(linkRef ? { linkRef } : {}),
});

/** `payment.captured`: ONE instalment, carrying the link's notes copied onto it. */
const captured = (payId: string, rupees: number, notes: Record<string, unknown>) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: payId, amount: rupees * 100, notes } } },
});

/**
 * `payment_link.paid`: the link TOTAL in `amount_paid`, with only the FINAL
 * instalment nested. `nested: null` is the legitimate shape where the payment
 * entity is absent — the contract makes it optional.
 */
const linkPaid = (
  linkId: string,
  totalRupees: number,
  nested: { id: string; rupees: number } | null,
  notes: Record<string, unknown>,
) => ({
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { id: linkId, amount_paid: totalRupees * 100, notes } },
    ...(nested ? { payment: { entity: { id: nested.id, amount: nested.rupees * 100, notes } } } : {}),
  },
});

/** One webhook delivery, routed exactly as the route routes it. */
const deliver = (ev: { event: string; payload: unknown }) => {
  const c = correlationFromEntity(ev.payload, ev.event);
  return c.kind === "RESIDENT_DUES" ? settleResidentDues(c) : settleWalletTopup(c);
};

/* ── state readers ───────────────────────────────────────────────────────── */

const rows = async (table: Parameters<typeof fakeDb.select>[0] extends never ? never : any) =>
  (await fakeDb.select().from(table)) as Array<Record<string, any>>;

const walletBalance = async () => Number((await rows(walletsTable))[0]!["balance"]);
const credits = async () => await rows(walletTransactionsTable);
const payments = async () => await rows(paymentsTable);
const paidEntries = async () => (await rows(ledgerEntriesTable)).filter((r) => r["isPaid"] === true);

const seedWallet = () =>
  seedDb([
    [walletsTable, [{ id: "w-1", residentId: RESIDENT, balance: "0", isActive: true }]],
    [walletTransactionsTable, []],
  ]);

beforeEach(() => resetDb());

/* ═══════════════════════════════════════════════════════════════════════════
 * WALLET TOP-UP — links accept partial payment (wallet.ts), so one link can
 * produce several instalments and the two events overlap.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("settleWalletTopup — one link, one payment (₹500)", () => {
  beforeEach(seedWallet);

  const pay = () => captured("pay_1", 500, topupNotes("lref-1"));
  const link = () => linkPaid(LINK, 500, { id: "pay_1", rupees: 500 }, topupNotes("lref-1"));

  it("credits ₹500 when only payment.captured is delivered", async () => {
    const r = await deliver(pay());
    expect(r.credited).toBe(500);
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
  });

  it("credits ₹500 when only payment_link.paid is delivered", async () => {
    const r = await deliver(link());
    expect(r.credited).toBe(500);
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
  });

  it("credits ₹500 total when both are delivered, captured first", async () => {
    await deliver(pay());
    const second = await deliver(link());
    expect(second.credited).toBe(0);
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
  });

  it("credits ₹500 total when both are delivered, link first", async () => {
    await deliver(link());
    const second = await deliver(pay());
    expect(second.credited).toBe(0);
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
  });

  it("credits ₹500 total when the same event is redelivered", async () => {
    await deliver(pay());
    await deliver(pay());
    await deliver(link());
    await deliver(link());
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
  });
});

describe("settleWalletTopup — one link, two instalments (₹200 + ₹300)", () => {
  beforeEach(seedWallet);

  const first = () => captured("pay_1", 200, topupNotes("lref-1"));
  const second = () => captured("pay_2", 300, topupNotes("lref-1"));
  /** amount_paid is the link TOTAL; only the FINAL instalment is nested. */
  const link = () => linkPaid(LINK, 500, { id: "pay_2", rupees: 300 }, topupNotes("lref-1"));

  it("credits ₹500 once when every captured plus the link event is delivered", async () => {
    await deliver(first());
    await deliver(second());
    const r = await deliver(link());
    expect(r.credited).toBe(0);
    expect(r.reason).toBe("link already fully credited");
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(2);
  });

  it("credits ₹500 on a link-only subscription — the earlier instalment is the shortfall", async () => {
    const r = await deliver(link());
    expect(r.credited).toBe(500); // ₹300 nested instalment + ₹200 link reconciliation
    expect(await walletBalance()).toBe(500);
    const rows = await credits();
    expect(rows.map((x) => x["referenceType"]).sort()).toEqual(["RAZORPAY_LINK", "RAZORPAY_PAYMENT"]);
  });

  it("does NOT re-credit a late captured that the link reconciliation already absorbed", async () => {
    await deliver(link()); // reconciles the whole ₹500
    const late = await deliver(first()); // the ₹200 instalment, arriving afterwards
    expect(late.credited).toBe(0);
    expect(late.reason).toBe("instalment already covered by the link reconciliation");
    expect(await walletBalance()).toBe(500);
  });

  it("credits ₹500 regardless of the order the instalments arrive in", async () => {
    await deliver(second());
    await deliver(first());
    await deliver(link());
    await deliver(link());
    expect(await walletBalance()).toBe(500);
  });
});

describe("settleWalletTopup — legacy link with no notes.linkRef", () => {
  beforeEach(seedWallet);

  const pay = () => captured("pay_1", 500, topupNotes(null));
  const link = () => linkPaid(LINK, 500, { id: "pay_1", rupees: 500 }, topupNotes(null));

  it("credits ₹500 once from either event, and does not alarm", async () => {
    await deliver(pay());
    const r = await deliver(link());
    expect(await walletBalance()).toBe(500);
    expect(await credits()).toHaveLength(1);
    expect(r.status).toBe("settled");
    expect(r.unaccounted).toBe(0);
    expect(r.unverified).toBe(0);
  });

  it("does not raise manual reconciliation on a partial link whose instalments are already credited", async () => {
    // The regression: with `unaccounted = collected - instalment` this reported
    // ₹200 missing and escalated to an error, while the wallet held all ₹500.
    await deliver(captured("pay_1", 200, topupNotes(null)));
    await deliver(captured("pay_2", 300, topupNotes(null)));
    const r = await deliver(linkPaid(LINK, 500, { id: "pay_2", rupees: 300 }, topupNotes(null)));
    expect(await walletBalance()).toBe(500);
    expect(r.status).toBe("settled");
    expect(r.unaccounted).toBe(0);
    expect(r.unverified).toBe(200); // reported, but as unverifiable — not as a gap
  });

  it("still refuses to credit an unattributable remainder rather than risk doubling it", async () => {
    const r = await deliver(linkPaid(LINK, 500, { id: "pay_2", rupees: 300 }, topupNotes(null)));
    expect(r.credited).toBe(300);
    expect(await walletBalance()).toBe(300);
    expect(r.unverified).toBe(200);
  });
});

describe("settleWalletTopup — money with nowhere to land", () => {
  it("reports the collection as unaccounted when the resident has no wallet", async () => {
    seedDb([[walletsTable, []], [walletTransactionsTable, []]]);
    const r = await deliver(linkPaid(LINK, 500, { id: "pay_1", rupees: 500 }, topupNotes("lref-1")));
    expect(r.status).toBe("unresolved");
    expect(r.unaccounted).toBe(500);
    expect(r.credited).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RESIDENT DUES — links do NOT accept partial payment (residents.ts), so one
 * link is exactly one collection and both events describe that same collection.
 * The blast radius of a duplicate is larger here than on the wallet: the ledger
 * auto-settle loop runs again and marks a SECOND batch of entries paid.
 * ═══════════════════════════════════════════════════════════════════════════ */

const seedDues = () =>
  seedDb([
    [paymentsTable, []],
    [residentsTable, [{ id: RESIDENT, propertyId: PROPERTY }]],
    [
      ledgerEntriesTable,
      [
        { id: "le-1", residentId: RESIDENT, amount: "3000", isPaid: false, dueDate: new Date("2026-01-01") },
        { id: "le-2", residentId: RESIDENT, amount: "2000", isPaid: false, dueDate: new Date("2026-02-01") },
        { id: "le-3", residentId: RESIDENT, amount: "4000", isPaid: false, dueDate: new Date("2026-03-01") },
      ],
    ],
  ]);

describe("settleResidentDues — link carrying notes.linkRef (₹5000)", () => {
  beforeEach(seedDues);

  const pay = () => captured("pay_1", 5000, duesNotes("lref-1"));
  const link = () => linkPaid(LINK, 5000, { id: "pay_1", rupees: 5000 }, duesNotes("lref-1"));
  /** The link event is allowed to arrive with no nested payment entity. */
  const linkBare = () => linkPaid(LINK, 5000, null, duesNotes("lref-1"));

  it("settles once from payment.captured alone", async () => {
    const r = await deliver(pay());
    expect(r.credited).toBe(5000);
    expect(await payments()).toHaveLength(1);
    expect((await paidEntries()).map((e) => e["id"])).toEqual(["le-1", "le-2"]);
  });

  it("settles once from payment_link.paid alone", async () => {
    await deliver(link());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once from a payment_link.paid that carries no nested payment", async () => {
    await deliver(linkBare());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when both are delivered, captured first", async () => {
    await deliver(pay());
    const second = await deliver(link());
    expect(second.credited).toBe(0);
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when both are delivered, link first", async () => {
    await deliver(link());
    await deliver(pay());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when the two events do not agree on a provider id", async () => {
    // The shape the collection key exists for: `plink_…` from the bare link
    // event, `pay_…` from its captured sibling, one collection.
    await deliver(linkBare());
    await deliver(pay());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when the same event is redelivered", async () => {
    await deliver(pay());
    await deliver(pay());
    await deliver(link());
    await deliver(link());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("treats a second instalment on the SAME dues link as the same collection", async () => {
    // Documented invariant, not an accident: dues links are created without
    // acceptPartial, so one link is one collection. Keying on the collection is
    // what makes the two event shapes dedupe; a second payment id under one
    // dues link would mean the link was created wrong.
    await deliver(pay());
    const r = await deliver(captured("pay_2", 5000, duesNotes("lref-1")));
    expect(r.credited).toBe(0);
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });
});

describe("settleResidentDues — legacy link with no notes.linkRef", () => {
  beforeEach(seedDues);

  const pay = () => captured("pay_1", 5000, duesNotes(null));
  const link = () => linkPaid(LINK, 5000, { id: "pay_1", rupees: 5000 }, duesNotes(null));
  const linkBare = () => linkPaid(LINK, 5000, null, duesNotes(null));

  it("settles once from payment.captured alone", async () => {
    await deliver(pay());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once from a bare payment_link.paid alone", async () => {
    await deliver(linkBare());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when both events carry the same payment id", async () => {
    await deliver(pay());
    await deliver(link());
    expect(await payments()).toHaveLength(1);
    expect(await paidEntries()).toHaveLength(2);
  });

  it("settles once when captured arrives before a bare link event", async () => {
    // The reproduced defect: `pay_1` and `plink_1` are two keys for one
    // collection, uq_payments_razorpay_pay_id cannot see that, so this inserted
    // a second SUCCESS row and marked le-3 paid as well — ₹4000 of real dues
    // silently forgiven.
    await deliver(pay());
    const r = await deliver(linkBare());
    expect(r.credited).toBe(0);
    expect(await payments()).toHaveLength(1);
    expect((await paidEntries()).map((e) => e["id"])).toEqual(["le-1", "le-2"]);
  });

  it("settles once when a bare link event arrives before captured", async () => {
    await deliver(linkBare());
    const r = await deliver(pay());
    expect(r.credited).toBe(0);
    expect(await payments()).toHaveLength(1);
    expect((await paidEntries()).map((e) => e["id"])).toEqual(["le-1", "le-2"]);
  });

  it("does NOT collapse two distinct legacy collections of different amounts", async () => {
    await deliver(captured("pay_1", 3000, duesNotes(null)));
    await deliver(linkPaid("plink_2", 2000, null, duesNotes(null)));
    expect(await payments()).toHaveLength(2);
  });

  it("does NOT collapse two distinct legacy collections keyed in the SAME namespace", async () => {
    // The guard never matches pay_→pay_: two captured events with different
    // payment ids are two collections, and the exact key already dedupes the
    // one case where they are not.
    await deliver(captured("pay_1", 5000, duesNotes(null)));
    await deliver(captured("pay_2", 5000, duesNotes(null)));
    expect(await payments()).toHaveLength(2);
  });
});

describe("settleResidentDues — collections that cannot be attributed", () => {
  it("reports the amount instead of inserting against an unknown resident", async () => {
    seedDb([[paymentsTable, []], [residentsTable, []], [ledgerEntriesTable, []]]);
    const r = await deliver(captured("pay_1", 5000, duesNotes("lref-1", null)));
    expect(r.status).toBe("unresolved");
    expect(r.unaccounted).toBe(5000);
    expect(await payments()).toHaveLength(0);
  });
});
