import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dishesTable,
  foodMenuRotationTable,
  foodOrderItemsTable,
  foodOrdersTable,
  perResidentRuleTable,
  systemConfigTable,
} from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { callRoute } from "./helpers/call-route.js";
import { atIst } from "../tz.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

// RBAC is asserted by permissions-sync.test.ts; this file is about the per-dish
// people ceiling, so the chain is opened and the caller set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Delivery fans out to the broker; a Redis connection is not part of this test.
vi.mock("../../lib/notification-service.js", () => ({
  notifyOrderEvent: async () => {},
  notifyOrderEdited: async () => {},
}));

import { foodRouter } from "../../routes/food.js";

const ORDER = "ord-1";
const PROPERTY = "p-blr-1";
const KITCHEN = "K-BLR";
const BRAND = "UNILIV";
const MEAL = "LUNCH";
const DISH = "d-rice";

/** A Monday (ISO day 1) in IST — the seeded rotation cell is dayOfWeek 1. */
const SERVICE_DAY = atIst("2026-08-10", "12:00");

/** An org-wide caller, so property scoping resolves to "all" and stays out of the way. */
const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

/** One PLACED lunch order with a single rice line, plus the menu cell and the
 *  0.1 KG/person rule the edit re-validates against. */
function seedOrder(over: { residentsCount?: number; staffCount?: number } = {}) {
  const residentsCount = over.residentsCount ?? 8;
  const staffCount = over.staffCount ?? 2;
  const people = residentsCount + staffCount;
  seedDb([
    [
      foodOrdersTable,
      [
        {
          id: ORDER,
          orderNumber: "ORD-0001",
          propertyId: PROPERTY,
          kitchenId: KITCHEN,
          brand: BRAND,
          mealType: MEAL,
          serviceDate: SERVICE_DAY,
          status: "PLACED",
          unitLeadId: "u-lead",
          residentsCount,
          staffCount,
          totalQuantity: null,
          notes: null,
        },
      ],
    ],
    [
      foodOrderItemsTable,
      [
        {
          id: "itm-1",
          orderId: ORDER,
          dishId: DISH,
          unit: "KG",
          personsCount: people,
          orderedQty: String(people * 0.1),
          preparedQty: null,
          receivedQty: null,
          wastedQty: null,
        },
      ],
    ],
    [
      foodMenuRotationTable,
      [
        {
          id: "rot-1",
          kitchenId: KITCHEN,
          brand: BRAND,
          mealType: MEAL,
          dayOfWeek: 1,
          rotationWeek: 1,
          dishId: DISH,
          slotLabel: null,
          sortOrder: 0,
          parentRotationId: null,
          effectiveFrom: null,
          effectiveTo: null,
          isActive: true,
        },
      ],
    ],
    [
      dishesTable,
      [
        {
          id: DISH,
          name: "Rice",
          component: "RICE",
          unit: "KG",
          preparations: [],
          isQtyLocked: false,
          lockedPersons: null,
          isActive: true,
        },
      ],
    ],
    [
      perResidentRuleTable,
      [
        {
          id: "r-1",
          brand: BRAND,
          mealType: MEAL,
          dishId: DISH,
          propertyId: null,
          qtyPerResident: "0.100",
          unit: "KG",
          isActive: true,
        },
      ],
    ],
  ]);
}

const putItems = (personsCount: number) =>
  callRoute(foodRouter, {
    method: "PUT",
    url: `/orders/${ORDER}`,
    user: USER,
    body: {
      items: [
        // orderedQty is what the grid derives: persons × 0.1 KG per person.
        { dishId: DISH, personsCount, orderedQty: Math.round(personsCount * 0.1 * 1000) / 1000 },
      ],
    },
  });

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
  // The day before service, well before the default 09:00 cut-off, so the
  // PLACED-only edit window is open and only the persons ceiling can reject.
  vi.setSystemTime(atIst("2026-08-09", "07:00"));
});
afterEach(() => vi.useRealTimers());

/** Seed the ordering-headroom setting. Omit to exercise the default (100%). */
const seedHeadroom = (pct: number) =>
  seedDb([[systemConfigTable, [{
    id: "cfg-headroom",
    key: "FOOD_ORDER_HEADROOM_PCT",
    value: pct,
    description: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  }]]]);

describe("PUT /orders/:id — per-dish people ceiling (meal total + headroom)", () => {
  it("accepts a dish ordered for more people than the meal, up to the headroom", async () => {
    seedOrder(); // 8 residents + 2 staff = 10 people → ceiling 20 at the 100% default
    const res = await putItems(20);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects a dish ordered past the meal total + headroom", async () => {
    seedOrder(); // 10 people → ceiling 20
    const res = await putItems(21);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("at most 20");
    expect(res.body.error).toContain("100% above the 10 eating this meal");
  });

  it("rounds a fractional ceiling up — 7 people at 25% allow 9, not 8", async () => {
    seedHeadroom(25);
    seedOrder({ residentsCount: 7, staffCount: 0 }); // ceil(7 × 1.25) = 9
    expect((await putItems(9)).status).toBe(200);
    const over = await putItems(10);
    expect(over.status).toBe(422);
    expect(over.body.error).toContain("at most 9");
  });

  /* The setting is what makes the ceiling movable at all — without these two, a
   * call site that quietly went back to a hardcoded multiplier still passes. */
  it("honours a configured headroom below the default", async () => {
    seedHeadroom(20);
    seedOrder(); // 10 people → ceiling 12, the pre-setting behaviour
    expect((await putItems(12)).status).toBe(200);
    const over = await putItems(13);
    expect(over.status).toBe(422);
    expect(over.body.error).toContain("20% above the 10 eating this meal");
  });

  it("0% headroom pins the ceiling to the meal total exactly", async () => {
    seedHeadroom(0);
    seedOrder(); // 10 people → ceiling 10
    expect((await putItems(10)).status).toBe(200);
    expect((await putItems(11)).status).toBe(422);
  });

  it("falls back to the default when the stored value is out of range", async () => {
    seedHeadroom(99999); // past FOOD_ORDER_HEADROOM_MAX_PCT — not an uncapped order
    seedOrder(); // 10 people → ceiling 20, the 100% default
    expect((await putItems(20)).status).toBe(200);
    expect((await putItems(21)).status).toBe(422);
  });
});
