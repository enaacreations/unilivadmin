/**
 * The activity event registry (PRD §29).
 *
 * An allow-list, not documentation. `recordActivity` refuses a key that is not
 * here, and `activity-coverage.test.ts` fails when a registered event has no
 * producer — so the PRD's thirteen cannot quietly become seven.
 *
 * `reasonRequired` is how §29's "Reason where required" becomes mechanical
 * rather than aspirational: the writer throws without one.
 */
export type ActivityCategory = "ACCESS" | "LIFECYCLE" | "CONFIG" | "DATA" | "SECURITY";

export interface EventDef {
  category: ActivityCategory;
  entityType: string;
  reasonRequired: boolean;
  /** Tamper-evident stream this event chains into, if any. */
  chainKey?: string;
}

/**
 * ACCESS and SECURITY chain; everything else does not.
 *
 * Chaining costs a per-stream advisory lock on every write. Paying that for
 * routine DATA/LIFECYCLE traffic is what would have made a single global chain
 * the product's write mutex — so only the streams whose integrity is actually
 * contested are chained.
 */
const ACCESS_CHAIN = "ACCESS";

export const ACTIVITY_EVENTS = {
  // ── PRD §29's thirteen ──────────────────────────────────────────────────
  BED_STATUS_CHANGED: { category: "LIFECYCLE", entityType: "bed", reasonRequired: false },
  ROOM_STATUS_CHANGED: { category: "LIFECYCLE", entityType: "room", reasonRequired: false },
  AUDIT_COMPLETED: { category: "LIFECYCLE", entityType: "audit", reasonRequired: false },
  AUDIT_SCORE_CHANGED: { category: "DATA", entityType: "audit", reasonRequired: true },
  ISSUE_CREATED: { category: "LIFECYCLE", entityType: "issue", reasonRequired: false },
  ISSUE_ASSIGNED: { category: "LIFECYCLE", entityType: "issue", reasonRequired: false },
  ISSUE_CLOSED: { category: "LIFECYCLE", entityType: "issue", reasonRequired: true },
  ATTENDANCE_MODIFIED: { category: "DATA", entityType: "attendance", reasonRequired: true },
  MENU_MODIFIED: { category: "CONFIG", entityType: "menu", reasonRequired: false },
  MENU_APPROVED: { category: "LIFECYCLE", entityType: "menu", reasonRequired: false },
  ROLE_CHANGED: { category: "ACCESS", entityType: "user", reasonRequired: true, chainKey: ACCESS_CHAIN },
  PROPERTY_ASSIGNMENT_CHANGED: { category: "ACCESS", entityType: "user", reasonRequired: true, chainKey: ACCESS_CHAIN },
  MAINTENANCE_STATUS_CHANGED: { category: "LIFECYCLE", entityType: "maintenance", reasonRequired: false },

  // ── The access-control plane, which must be traceable to be trustworthy ──
  GRANT_CREATED: { category: "ACCESS", entityType: "grant", reasonRequired: false, chainKey: ACCESS_CHAIN },
  GRANT_REVOKED: { category: "ACCESS", entityType: "grant", reasonRequired: true, chainKey: ACCESS_CHAIN },
  MATRIX_CHANGED: { category: "ACCESS", entityType: "role", reasonRequired: true, chainKey: ACCESS_CHAIN },
  ACCESS_DENIED: { category: "SECURITY", entityType: "module", reasonRequired: false },
  ACCESS_PREVIEWED: { category: "ACCESS", entityType: "user", reasonRequired: false, chainKey: ACCESS_CHAIN },
  /** One person's capabilities diverging from (or returning to) their role's. */
  PERMISSION_OVERRIDDEN: { category: "ACCESS", entityType: "user", reasonRequired: true, chainKey: ACCESS_CHAIN },
  /** One person's whole access surface copied onto another. */
  ACCESS_CLONED: { category: "ACCESS", entityType: "user", reasonRequired: true, chainKey: ACCESS_CHAIN },
  SOD_OVERRIDDEN: { category: "SECURITY", entityType: "record", reasonRequired: true, chainKey: ACCESS_CHAIN },

  // ── Existing producers, adopted from the legacy audit_log ────────────────
  USER_CREATED: { category: "ACCESS", entityType: "user", reasonRequired: false, chainKey: ACCESS_CHAIN },
  USER_UPDATED: { category: "ACCESS", entityType: "user", reasonRequired: false, chainKey: ACCESS_CHAIN },
  CONFIG_CHANGED: { category: "CONFIG", entityType: "config", reasonRequired: false },
  WALLET_TXN: { category: "DATA", entityType: "wallet", reasonRequired: false },
} as const satisfies Record<string, EventDef>;

export type ActivityEventKey = keyof typeof ACTIVITY_EVENTS;

export function eventDef(key: string): EventDef | undefined {
  return (ACTIVITY_EVENTS as Record<string, EventDef>)[key];
}

/**
 * Keys never written to the trail verbatim.
 *
 * Applied centrally rather than at each call site, because a redaction that
 * depends on every caller remembering is not a redaction.
 */
export const REDACT_KEYS = new Set([
  "passwordHash", "password", "token", "refreshToken", "otp",
  "accountNumber", "bankAccount", "ifscCode", "panNumber", "aadhaar",
]);
