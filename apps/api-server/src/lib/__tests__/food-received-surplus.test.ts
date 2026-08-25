import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  dishesTable,
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
// the received-quantity bounds, so the chain is opened and the caller is set on
// the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Delivery fans out to the broker; this file is about what the handler accepts
// and writes, and a Redis connection is not part of that.
vi.mock("../../lib/notification-service.js", () => ({
  notifyOrderEvent: async () => {},
  notifyOrderEdited: async () => {},
}));

import { foodRouter } from "../../routes/food.js";

const ORDER = "ord-1";
const ITEM = "itm-1";
const PROPERTY = "p-blr-1";

/** An org-wide caller, so property scoping resolves to "all" and stays out of the way. */
const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

/** One DISPATCHED line: 10 kg ordered, and by default 12 kg actually cooked. */
function seedDispatched(item: Partial<Record<string, unknown>> = {}) {
  seedDb([
    [
      foodOrdersTable,
      [
        {
          id: ORDER,
          orderNumber: "ORD-0001",
          propertyId: PROPERTY,
          brand: "UNILIV",
          mealType: "LUNCH",
          status: "DISPATCHED",
          unitLeadId: "u-lead",
          dispatchId: null,
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
          preparedQty: "12.000",
          receivedQty: null,
          wastedQty: null,
          ...item,
        },
      ],
    ],
    [dishesTable, [{ id: "d-rice", name: "Jeera Rice" }]],
    [foodOrderEventsTable, []],
    [systemConfigTable, []],
  ]);
}

const confirm = (receivedQty: number) =>
  callRoute(foodRouter, {
    method: "POST",
    url: `/orders/${ORDER}/confirm-delivery`,
    body: { items: [{ itemId: ITEM, receivedQty }], remarks: "Kitchen sent extra" },
    user: USER,
  });

beforeEach(() => resetDb());

/**
 * A delivery varies in BOTH directions. The receive path used to cap
 * receivedQty at what was booked out — first at orderedQty (H7), then at
 * max(ordered, prepared) — which made a genuine surplus unsubmittable and left
 * the lead with one legal move: key the sent quantity and let the extra food go
 * unrecorded. Nothing downstream can reconstruct that number afterwards.
 *
 * These cases pin both ends: a surplus is accepted and persisted verbatim, and
 * the remaining ceiling still catches an order-of-magnitude keying slip.
 */
describe("POST /orders/:id/confirm-delivery — a surplus is recordable", () => {
  it("accepts more than was prepared and stores the surplus verbatim", async () => {
    seedDispatched();
    const res = await confirm(15); // 12 kg cooked, 15 kg counted on the dock
    expect(res.status).toBe(200);
    const [item] = await db.select().from(foodOrderItemsTable);
    expect(Number(item!.receivedQty)).toBe(15);
  });

  it("accepts more than was ordered when the kitchen never recorded a prepared qty", async () => {
    seedDispatched({ preparedQty: null });
    const res = await confirm(13); // 10 kg ordered, nothing prepared-stamped
    expect(res.status).toBe(200);
    const [item] = await db.select().from(foodOrderItemsTable);
    expect(Number(item!.receivedQty)).toBe(13);
  });

  it("still accepts an exact count and a shortfall-free match", async () => {
    seedDispatched();
    expect((await confirm(12)).status).toBe(200);
  });

  it("carries the order to DELIVERED like any other confirm", async () => {
    seedDispatched();
    await confirm(15);
    const [order] = await db.select().from(foodOrdersTable);
    expect(order!.status).toBe("DELIVERED");
    expect(order!.deliveryRemarks).toBe("Kitchen sent extra");
  });

  it("raises no shortfall complaint — a surplus is not a shortfall", async () => {
    seedDispatched();
    await confirm(15);
    const events = await db.select().from(foodOrderEventsTable);
    expect(events.map((e) => e.note)).toEqual(["Delivery confirmed"]);
  });
});

describe("POST /orders/:id/confirm-delivery — the ceiling only catches keying slips", () => {
  it("rejects an order-of-magnitude slip (120 keyed for 12)", async () => {
    seedDispatched();
    const res = await confirm(121); // ceiling is 12 × 10
    expect(res.status).toBe(400);
    // The lead reads this at the gate — it has to name the dish, not a line id.
    expect(String(res.body.error)).toBe(
      "Received quantity for Jeera Rice must be between 0 and 120 kg — 12 kg was sent, so check for a typo",
    );
  });

  it("accepts the ceiling itself — the bound is inclusive", async () => {
    seedDispatched();
    expect((await confirm(120)).status).toBe(200);
  });

  it("keeps usable headroom on a tiny line rather than scaling the cap to nothing", async () => {
    // 0.5 kg of a garnish: 10 × 0.5 is a 5 kg ceiling, which a real top-up can
    // clear. The floor is what stops the multiple from squeezing small lines.
    seedDispatched({ orderedQty: "0.500", preparedQty: "0.500" });
    expect((await confirm(8)).status).toBe(200);
  });

  it("rejects a negative quantity", async () => {
    seedDispatched();
    expect((await confirm(-1)).status).toBe(400);
  });

  it("writes nothing when a line is out of bounds", async () => {
    seedDispatched();
    await confirm(121);
    const [item] = await db.select().from(foodOrderItemsTable);
    expect(item!.receivedQty).toBeNull();
    const [order] = await db.select().from(foodOrdersTable);
    expect(order!.status).toBe("DISPATCHED");
  });
});
