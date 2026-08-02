/**
 * Canonical food-order lifecycle. Every transition endpoint enforces exactly
 * one hop from this table, so the chain
 *   PLACED → ACCEPTED → DISPATCHED → DELIVERED
 * (with REJECTED / CANCELLED off-ramps) can't be skipped or reordered. Keeping
 * the rules in one place stops the guards drifting apart (e.g. dispatch used to
 * allow a PLACED order straight through).
 */
export type FoodOrderStatus =
  | "PLACED" | "ACCEPTED" | "REJECTED" | "DISPATCHED" | "DELIVERED" | "CANCELLED";

export const ORDER_NEXT: Record<FoodOrderStatus, FoodOrderStatus[]> = {
  PLACED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["DISPATCHED", "REJECTED", "CANCELLED"],
  DISPATCHED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  REJECTED: [],
};

/** True if `from → to` is a legal single hop in the order lifecycle. */
export function canTransition(from: string, to: FoodOrderStatus): boolean {
  return (ORDER_NEXT[from as FoodOrderStatus] ?? []).includes(to);
}
