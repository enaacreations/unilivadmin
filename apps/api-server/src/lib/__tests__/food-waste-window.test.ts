import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  dishesTable,
  foodAdditionalOrderItemsTable,
  foodOrderEventsTable,
  foodOrderItemsTable,
  foodOrdersTable,
  systemConfigTable,
} from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { callRoute } from "./helpers/call-route.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

// The RBAC gates are asserted by permissions-sync.test.ts; this file is about
// the window, so the chain is opened and the caller is set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { foodRouter } from "../../routes/food.js";

const ORDER = "ord-1";
const ITEM = "itm-1";
const PROPERTY = "p-blr-1";
const DELIVERED_AT = new Date("2026-08-10T07:00:00Z");
/** The window CLOSES here: deliveredAt + the configured 60 minutes. */
const WINDOW_CLOSES_AT = new Date("2026-08-10T08:00:00Z");

/** An org-wide caller, so property scoping resolves to "all" and stays out of the way. */
const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

const at = (iso: string) => vi.setSystemTime(new Date(iso));

function seedDelivered(over: Partial<Record<string, unknown>> = {}) {
  seedDb([
    [
      foodOrdersTable,
      [
        {
          id: ORDER,
          propertyId: PROPERTY,
          brand: "UNILIV",
          mealType: "LUNCH",
          status: "DELIVERED",
          deliveredAt: DELIVERED_AT,
          wasteEditableUntil: WINDOW_CLOSES_AT,
          ...over,
        },
      ],
    ],
    [
      foodOrderItemsTable,
      [
        {
          id: ITEM,
          orderId: ORDER,
          dishId: "d-rice",
          unit: "KG",
          orderedQty: "10.000",
          receivedQty: "10.000",
          wastedQty: null,
          updatedAt: DELIVERED_AT,
        },
      ],
    ],
    [foodAdditionalOrderItemsTable, []],
    [dishesTable, [{ id: "d-rice", name: "Jeera Rice" }]],
    [foodOrderEventsTable, []],
    [systemConfigTable, []],
  ]);
}

const postWaste = (wastedQty = 1.5) =>
  callRoute(foodRouter, {
    method: "POST",
    url: `/orders/${ORDER}/waste`,
    body: { items: [{ itemId: ITEM, wastedQty }] },
    user: USER,
  });

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/**
 * M20 — `wasteEditableUntil` is a CLOSING bound. Wastage is logged WITHIN one
 * hour of delivery: the window OPENS at delivery and CLOSES at that stamp
 * (Persona-Unit-Lead.md:91, and the DELIVERED notification says exactly this).
 *
 * The check used to be the exact inverse — it rejected everything BEFORE the
 * stamp and accepted everything after — so the notification walked the unit lead
 * into a guaranteed 422 during the only hour they could have counted the food.
 * These cases pin the direction from both sides: reintroducing the inversion
 * fails the open-window cases AND the closed-window ones, not just one.
 */
describe("POST /orders/:id/waste — the window opens at delivery", () => {
  it("accepts waste at the moment of delivery, the instant the old check refused", async () => {
    seedDelivered();
    at(DELIVERED_AT.toISOString());
    const res = await postWaste(2);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].wastedQty).toBe(2);
  });

  it("accepts waste in the middle of the window and persists the quantity", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z"); // 30 minutes after delivery
    const res = await postWaste(1.5);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].wastedQty).toBe(1.5);
  });

  it("accepts waste at the closing instant itself — the bound is inclusive", async () => {
    seedDelivered();
    at(WINDOW_CLOSES_AT.toISOString());
    expect((await postWaste(1)).status).toBe(200);
  });

  it("records what was logged in the order trail", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z");
    await postWaste(1.5);
    const [event] = await db.select().from(foodOrderEventsTable);
    expect(event).toMatchObject({ orderId: ORDER, status: "DELIVERED" });
    expect(String(event!.note)).toBe("Waste recorded: Jeera Rice — → 1.5 KG");
  });
});

describe("POST /orders/:id/waste — the window closes at wasteEditableUntil", () => {
  it("rejects one second after the closing instant", async () => {
    seedDelivered();
    at("2026-08-10T08:00:01Z");
    const res = await postWaste(1.5);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "The wastage window for this order has closed — it can only be logged within the hour after delivery",
    );
  });

  it("writes nothing once the window has closed", async () => {
    seedDelivered();
    at("2026-08-10T09:00:00Z");
    await postWaste(1.5);
    const [item] = await db.select().from(foodOrderItemsTable);
    expect(item!.wastedQty).toBeNull();
    expect(await db.select().from(foodOrderEventsTable)).toEqual([]);
  });

  it("rejects a day later, when the old check would have started accepting", async () => {
    seedDelivered();
    at("2026-08-11T07:30:00Z");
    expect((await postWaste(1.5)).status).toBe(422);
  });
});

describe("POST /orders/:id/waste — orders delivered before the stamp existed", () => {
  it("falls back to deliveredAt + the configured window rather than locking the lead out", async () => {
    seedDelivered({ wasteEditableUntil: null });
    seedDb([[systemConfigTable, [{ id: "sc-1", key: "food_waste_edit_window_minutes", value: 30 }]]]);
    at("2026-08-10T07:29:00Z"); // 29 minutes in, window is 30
    expect((await postWaste(1)).status).toBe(200);
  });

  it("still closes at deliveredAt + the configured window", async () => {
    seedDelivered({ wasteEditableUntil: null });
    seedDb([[systemConfigTable, [{ id: "sc-1", key: "food_waste_edit_window_minutes", value: 30 }]]]);
    at("2026-08-10T07:31:00Z");
    expect((await postWaste(1)).status).toBe(422);
  });

  it("an order with neither stamp nor delivery time has no deadline to enforce", async () => {
    // Nothing to measure the window from; the DELIVERED gate is the only control
    // left, and it is better to accept the count than to lose it.
    seedDelivered({ wasteEditableUntil: null, deliveredAt: null });
    at("2027-01-01T00:00:00Z");
    expect((await postWaste(1)).status).toBe(200);
  });
});

/** The guards standing beside the window, asserted so a fix here can't drop them. */
describe("POST /orders/:id/waste — the guards around the window", () => {
  it("refuses waste on an order that has not been delivered", async () => {
    seedDelivered({ status: "DISPATCHED", deliveredAt: null, wasteEditableUntil: null });
    at("2026-08-10T07:30:00Z");
    const res = await postWaste(1);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Waste can only be recorded for DELIVERED orders");
  });

  it("caps waste at what was actually received", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z");
    const res = await postWaste(10.5);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cannot exceed what was received");
  });

  it("rejects a negative quantity", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z");
    expect((await postWaste(-1)).status).toBe(400);
  });

  it("accepts a zero-waste count inside the window", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z");
    const res = await postWaste(0);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].wastedQty).toBe(0);
  });

  it("404s for an order that does not exist", async () => {
    seedDelivered();
    at("2026-08-10T07:30:00Z");
    const res = await callRoute(foodRouter, {
      method: "POST",
      url: "/orders/ord-missing/waste",
      body: { items: [] },
      user: USER,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
  });
});
