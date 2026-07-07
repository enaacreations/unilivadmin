/**
 * Browser-local draft persistence for the Place Order builder. One draft per
 * (user, property, service date); localStorage is the only store — nothing is
 * sent to the backend. All storage access is best-effort (private browsing /
 * quota errors degrade to "no draft").
 */

export type OrderDraftOverride = { excluded?: boolean; persons?: number; qty?: number };

export type OrderDraft = {
  v: 1;
  savedAt: string; // ISO timestamp of the last autosave
  persons: number;
  overrides: Record<string, OrderDraftOverride>;
  mealPersons: Record<string, number>;
};

const PREFIX = "uniliv_food_order_draft_";

export const orderDraftKey = (userId: string, propertyId: string, serviceDate: string) =>
  `${PREFIX}${userId}_${propertyId}_${serviceDate}`;

export function loadOrderDraft(key: string): OrderDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const isRecord = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
    if (d?.v !== 1 || typeof d.persons !== "number" || typeof d.savedAt !== "string"
      || !isRecord(d.overrides) || !isRecord(d.mealPersons)) {
      localStorage.removeItem(key);
      return null;
    }
    return d as OrderDraft;
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
}

export function saveOrderDraft(key: string, draft: OrderDraft): void {
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* ignore */ }
}

export function removeOrderDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** Drop drafts whose service date has passed — the builder only ever targets
 *  the next orderable day, so they can never be restored. */
export function pruneOrderDrafts(todayYmd: string): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const m = key.match(/(\d{4}-\d{2}-\d{2})$/);
      if (!m || m[1] < todayYmd) stale.push(key);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
