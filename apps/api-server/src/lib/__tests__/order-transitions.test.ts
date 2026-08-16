import { describe, expect, it } from "vitest";
import { ORDER_NEXT, canTransition, type FoodOrderStatus } from "../order-transitions.js";

const ALL: FoodOrderStatus[] = ["PLACED", "ACCEPTED", "REJECTED", "DISPATCHED", "DELIVERED", "CANCELLED"];
const TERMINAL: FoodOrderStatus[] = ["DELIVERED", "CANCELLED", "REJECTED"];

/** The whole table, spelled out — the expected value, not a copy of the source. */
const LEGAL: Array<[FoodOrderStatus, FoodOrderStatus]> = [
  ["PLACED", "ACCEPTED"],
  ["PLACED", "REJECTED"],
  ["PLACED", "CANCELLED"],
  ["ACCEPTED", "DISPATCHED"],
  ["ACCEPTED", "REJECTED"],
  ["ACCEPTED", "CANCELLED"],
  ["DISPATCHED", "DELIVERED"],
];

describe("ORDER_NEXT — every edge in the order lifecycle", () => {
  it.each(ALL)("%s exposes exactly the hops the lifecycle allows", (from) => {
    expect([...ORDER_NEXT[from]].sort()).toEqual(
      LEGAL.filter(([f]) => f === from).map(([, t]) => t).sort(),
    );
  });

  it.each(
    ALL.flatMap((from) =>
      ALL.map((to) => {
        const legal = LEGAL.some(([f, t]) => f === from && t === to);
        return [from, to, legal] as const;
      }),
    ),
  )("%s → %s is %s", (from, to, legal) => {
    expect(canTransition(from, to)).toBe(legal);
  });

  it("the happy path is a single unbroken chain and nothing skips a hop", () => {
    expect(canTransition("PLACED", "ACCEPTED")).toBe(true);
    expect(canTransition("ACCEPTED", "DISPATCHED")).toBe(true);
    expect(canTransition("DISPATCHED", "DELIVERED")).toBe(true);
    // Dispatch used to let a PLACED order straight through to DISPATCHED; the
    // kitchen never accepted it, so nothing was ever cooked to a commitment.
    expect(canTransition("PLACED", "DISPATCHED")).toBe(false);
    expect(canTransition("PLACED", "DELIVERED")).toBe(false);
    expect(canTransition("ACCEPTED", "DELIVERED")).toBe(false);
  });
});

/**
 * Terminal states accept NOTHING. This is the assertion C3 and M2 both failed
 * against: the per-order dispatch toggle wrote `status: "DISPATCHED"` onto a
 * DELIVERED order, un-terminating it, which let confirm-delivery run a second
 * time and mint a duplicate variance complaint. There is no legal hop out of a
 * terminal state — not to another status, not to itself, not back the way it
 * came — and no reopen path may be added here without a spec change.
 */
describe("terminal states accept nothing", () => {
  it.each(TERMINAL)("%s has an empty successor list", (status) => {
    expect(ORDER_NEXT[status]).toEqual([]);
  });

  it.each(TERMINAL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    "%s → %s is refused",
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    },
  );

  it("a DELIVERED order cannot be walked back to DISPATCHED", () => {
    expect(canTransition("DELIVERED", "DISPATCHED")).toBe(false);
  });
});

describe("canTransition is total over untrusted input", () => {
  it("an unknown `from` refuses every hop instead of throwing", () => {
    // `from` arrives as a plain string off a database row, so a status the table
    // has never heard of must fail closed rather than crash the handler (M1: the
    // check runs against a stale read, and it is the only gate there is).
    expect(canTransition("PREPARING", "DISPATCHED")).toBe(false);
    expect(canTransition("", "ACCEPTED")).toBe(false);
    expect(canTransition("delivered", "DELIVERED")).toBe(false);
  });

  it("covers the status enum exhaustively — a new status must be added here", () => {
    expect(Object.keys(ORDER_NEXT).sort()).toEqual([...ALL].sort());
  });
});
