import { describe, expect, it } from "vitest";
import { DISPATCH_TRANSITIONS } from "@workspace/db";

/**
 * The dispatch-trip state machine, pinned.
 *
 * B2 lived and died on a single string literal inside a plain object: the
 * reconciler moves a trip to PARTIAL as soon as its FIRST stop is confirmed, and
 * PARTIAL shipped without a CANCELLED edge — so a 12-stop trip that broke down
 * after stop 1 had eleven meals it could never return to the kitchen (cancel is
 * the ONLY path that walks DISPATCHED orders back to ACCEPTED). Nothing in the
 * suite noticed, because nothing referenced the table. This file is that
 * reference: the mirror of order-transitions.test.ts for the trip machine.
 */

const ALL = ["LOADING", "IN_TRANSIT", "DELIVERED", "PARTIAL", "CANCELLED"] as const;
type TripStatus = (typeof ALL)[number];

const TERMINAL: TripStatus[] = ["DELIVERED", "CANCELLED"];
/** A trip that is still out on the road, with food aboard. */
const RUNNING: TripStatus[] = ["LOADING", "IN_TRANSIT", "PARTIAL"];

/** The whole table, spelled out — the expected value, not a copy of the source. */
const LEGAL: Array<[TripStatus, TripStatus]> = [
  ["LOADING", "IN_TRANSIT"],
  ["LOADING", "CANCELLED"],
  ["IN_TRANSIT", "DELIVERED"],
  ["IN_TRANSIT", "PARTIAL"],
  ["IN_TRANSIT", "CANCELLED"],
  ["PARTIAL", "DELIVERED"],
  ["PARTIAL", "IN_TRANSIT"],
  ["PARTIAL", "CANCELLED"],
];

const canMove = (from: string, to: string): boolean =>
  (DISPATCH_TRANSITIONS[from] ?? []).includes(to);

describe("DISPATCH_TRANSITIONS — every edge in the trip lifecycle", () => {
  it.each(ALL)("%s exposes exactly the hops the lifecycle allows", (from) => {
    expect([...(DISPATCH_TRANSITIONS[from] ?? [])].sort()).toEqual(
      LEGAL.filter(([f]) => f === from).map(([, t]) => t).sort(),
    );
  });

  it.each(
    ALL.flatMap((from) =>
      ALL.map((to) => [from, to, LEGAL.some(([f, t]) => f === from && t === to)] as const),
    ),
  )("%s → %s is %s", (from, to, legal) => {
    expect(canMove(from, to)).toBe(legal);
  });

  it("covers the status enum exhaustively — a new trip status must be added here", () => {
    expect(Object.keys(DISPATCH_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});

/**
 * B2 — the regression this file exists for. Cancel is the only path that returns
 * still-DISPATCHED orders to the kitchen, so EVERY running state must keep it.
 * Removing any one of these edges strands that trip's remaining meals.
 */
describe("every running trip can still be abandoned", () => {
  it.each(RUNNING)("%s can be cancelled", (from) => {
    expect(canMove(from, "CANCELLED")).toBe(true);
  });

  it("PARTIAL specifically — the state the reconciler creates mid-run", () => {
    // A trip goes PARTIAL the moment its first stop is confirmed. It is a
    // RUNNING trip with food still aboard, not a finished one.
    expect(canMove("PARTIAL", "CANCELLED")).toBe(true);
    expect(TERMINAL).not.toContain("PARTIAL" as TripStatus);
  });
});

describe("terminal states accept nothing", () => {
  it.each(TERMINAL)("%s has an empty successor list", (status) => {
    expect(DISPATCH_TRANSITIONS[status]).toEqual([]);
  });

  it.each(TERMINAL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    "%s → %s is refused",
    (from, to) => {
      expect(canMove(from, to)).toBe(false);
    },
  );

  it("a DELIVERED trip is never walked back to PARTIAL", () => {
    // C3 deliberately leaves stops open that a dispatch-side caller may not
    // certify; that must not un-finalise a trip that already completed.
    expect(canMove("DELIVERED", "PARTIAL")).toBe(false);
    expect(canMove("DELIVERED", "IN_TRANSIT")).toBe(false);
  });

  it("a cancelled trip is never resumed", () => {
    expect(canMove("CANCELLED", "IN_TRANSIT")).toBe(false);
    expect(canMove("CANCELLED", "LOADING")).toBe(false);
  });
});

describe("the table is total over untrusted input", () => {
  it("an unknown status refuses every hop instead of throwing", () => {
    // `from` arrives as a plain string off a database row (the status column is
    // a pg enum, but the handlers read it as text), so a value the table has
    // never heard of must fail closed rather than crash the handler.
    expect(canMove("PREPARING", "DELIVERED")).toBe(false);
    expect(canMove("", "CANCELLED")).toBe(false);
    expect(canMove("cancelled", "CANCELLED")).toBe(false);
  });

  it("LOADING cannot skip straight to DELIVERED", () => {
    // Not a bug: advanceDispatch WALKS the declared route (LOADING → IN_TRANSIT
    // → DELIVERED) and audits each hop, precisely because the single-hop check
    // used to drop a legitimate finalise on a van that never left LOADING.
    expect(canMove("LOADING", "DELIVERED")).toBe(false);
    expect(canMove("LOADING", "PARTIAL")).toBe(false);
  });
});
