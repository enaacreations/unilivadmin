export type UserRole =
  | "SUPER_ADMIN" | "HR_MANAGER" | "OPERATIONS_MANAGER" | "PROCUREMENT_MANAGER"
  | "KITCHEN_MANAGER" | "PROJECTS_MANAGER" | "PROPERTY_ACQUISITION" | "FINANCE"
  | "SALES_EXECUTIVE" | "WARDEN" | "VENDOR_RESTRICTED" | "AUDIT_READONLY"
  // Food Ordering & Kitchen Operations roles (PRD §3)
  | "UNIT_LEAD" | "CLUSTER_MANAGER" | "CITY_HEAD" | "ZONAL_HEAD"
  | "OPS_EXCELLENCE" | "SENIOR_VICE_PRESIDENT"
  | "FNB_SUPERVISOR" | "FNB_MANAGER" | "FNB_ZONAL_HEAD"
  // Audit & Inspection (FRD §2.2 7-role model): CX team conducts ad-hoc CX audits
  | "CUSTOMER_EXPERIENCE";

export type Module =
  | "DASHBOARD" | "EXECUTIVE_DASHBOARD"
  | "PROPERTIES" | "RESIDENTS" | "COMPLAINTS" | "LAUNDRY" | "COMMUNICATIONS"
  | "EMPLOYEES" | "RECRUITMENT" | "LND"
  | "VENDORS" | "INDENTS" | "PURCHASE_ORDERS" | "GRN" | "INVENTORY"
  | "SALES_LEADS" | "SALES_DASHBOARD" | "PROPERTY_LEADS"
  | "LEDGER" | "PAYMENTS" | "WALLET"
  | "BILLING_CYCLES" | "REMINDERS" | "BANKING" | "EXPENSES"
  | "FACILITY" | "ELECTRICITY" | "RESIDENT_ATTENDANCE" | "IOT"
  | "USERS" | "SETTINGS" | "AUDIT_LOG"
  // Food Ordering & Kitchen Operations modules (PRD §5 matrix)
  | "FOOD_RECEIVE_UPDATE" | "FOOD_DELIVERY_TRACKING" | "FOOD_DASHBOARD"
  | "FOOD_ALL_ORDERS" | "FOOD_PLACE_ORDER" | "FOOD_KITCHEN_SUMMARY"
  | "FOOD_DISPATCH" | "FOOD_CONFIRM_DELIVERY" | "FOOD_WASTE_TRACKING"
  | "FOOD_REPORTS" | "FOOD_SETTINGS" | "FOOD_ORG"
  // The definitional layer of Service Set — ingredients, dishes (with their
  // portion rules) and the menu-composition rules: what a plate MAY be built
  // from and what it MUST contain. Split out of FOOD_SETTINGS so a role can
  // build the rotation from an agreed catalogue without being able to change
  // the catalogue itself. Reads are not gated on it; the rotation board must
  // still see every dish.
  | "FOOD_CATALOGUE"
  // Audit & Inspection module (PRD v1.0). Coarse endpoint gates; fine-grained
  // audit-type/org-node truth lives in audit_role_grants (resolveAuditAccess).
  // AUDIT_LOG above is the unrelated host audit log.
  | "AUDIT_DASHBOARD" | "AUDIT_REGISTER" | "AUDIT_EXECUTION"
  | "AUDIT_REVIEW" | "AUDIT_REPORTS" | "AUDIT_SCHEDULES"
  | "AUDIT_TEMPLATES" | "AUDIT_ADMIN";

export type Permission = "view" | "create" | "edit" | "delete";

const FULL: Record<Permission, boolean> = { view: true, create: true, edit: true, delete: true };
const VIEW: Record<Permission, boolean> = { view: true, create: false, edit: false, delete: false };
/** PRD legend "V·E" (View & Edit) — full access in our create/edit model. */
const VE = FULL;

/** All food-ops modules, for roles (SUPER_ADMIN / AUDIT_READONLY) granted everything. */
export const FOOD_MODULES: Module[] = [
  "FOOD_RECEIVE_UPDATE", "FOOD_DELIVERY_TRACKING", "FOOD_DASHBOARD",
  "FOOD_ALL_ORDERS", "FOOD_PLACE_ORDER", "FOOD_KITCHEN_SUMMARY",
  "FOOD_DISPATCH", "FOOD_CONFIRM_DELIVERY", "FOOD_WASTE_TRACKING",
  "FOOD_REPORTS", "FOOD_SETTINGS", "FOOD_ORG", "FOOD_CATALOGUE",
];

/** All Audit & Inspection modules, for the everything-granted roles. */
export const AUDIT_MODULES: Module[] = [
  "AUDIT_DASHBOARD", "AUDIT_REGISTER", "AUDIT_EXECUTION",
  "AUDIT_REVIEW", "AUDIT_REPORTS", "AUDIT_SCHEDULES",
  "AUDIT_TEMPLATES", "AUDIT_ADMIN",
];

/**
 * Every module in the system. The three everything-granted roles (SUPER_ADMIN,
 * AUDIT_READONLY, OPS_EXCELLENCE) are built from this one list instead of three
 * hand-copied ones, so a module added to the `Module` union cannot end up
 * silently missing from an admin role. Mirrors the frontend copy in
 * apps/uniliv-admin/src/lib/permissions.ts — permissions-sync.test.ts locks the
 * two together.
 */
export const ALL_MODULES: Module[] = [
  "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
  "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
  "SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
  "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
  "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
  "USERS","SETTINGS","AUDIT_LOG",
  ...FOOD_MODULES,
  ...AUDIT_MODULES,
];

type RoleMatrix = Partial<Record<Module, Partial<Record<Permission, boolean>>>>;

export const ROLE_PERMISSIONS: Record<UserRole, RoleMatrix> = {
  // Break-glass parity role: deliberately holds BOTH FOOD_DISPATCH:edit and
  // FOOD_CONFIRM_DELIVERY:edit. Every operational role keeps those two apart
  // (see the separation-of-duties note on the kitchen roles below).
  SUPER_ADMIN: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as RoleMatrix,
  HR_MANAGER: { DASHBOARD: VIEW, EMPLOYEES: FULL, RECRUITMENT: FULL, LND: FULL, USERS: FULL, SETTINGS: VIEW },
  OPERATIONS_MANAGER: { DASHBOARD: VIEW, PROPERTIES: FULL, RESIDENTS: FULL, COMPLAINTS: FULL, LAUNDRY: FULL, COMMUNICATIONS: FULL, FACILITY: FULL, ELECTRICITY: FULL, RESIDENT_ATTENDANCE: FULL, IOT: FULL, WALLET: VIEW },
  PROCUREMENT_MANAGER: { DASHBOARD: VIEW, VENDORS: FULL, INDENTS: FULL, PURCHASE_ORDERS: FULL, GRN: FULL, INVENTORY: FULL },
  // Recipes / Menu Planning were removed product-wide, so this role is left
  // with the inventory read it always had alongside them. The INDENTS
  // create-only grant went with them: its only purpose was
  // POST /menu-plans/:id/generate-indent, and that route no longer exists.
  KITCHEN_MANAGER: { DASHBOARD: VIEW, INVENTORY: VIEW },
  PROJECTS_MANAGER: { DASHBOARD: VIEW, PROPERTY_LEADS: FULL, LEDGER: VIEW, PAYMENTS: VIEW, INDENTS: VIEW, PURCHASE_ORDERS: VIEW },
  PROPERTY_ACQUISITION: { DASHBOARD: VIEW, PROPERTY_LEADS: FULL },
  FINANCE: { DASHBOARD: VIEW, EXECUTIVE_DASHBOARD: VIEW, RESIDENTS: VIEW, LEDGER: FULL, PAYMENTS: FULL, WALLET: FULL, BILLING_CYCLES: FULL, REMINDERS: FULL, BANKING: FULL, EXPENSES: FULL, INDENTS: VIEW, PURCHASE_ORDERS: VIEW },
  SALES_EXECUTIVE: { DASHBOARD: VIEW, SALES_LEADS: FULL, SALES_DASHBOARD: VIEW, PROPERTY_LEADS: VIEW },
  WARDEN: { DASHBOARD: VIEW, PROPERTIES: VIEW, RESIDENTS: FULL, COMPLAINTS: FULL, LAUNDRY: FULL, COMMUNICATIONS: { view: true, create: true, edit: false, delete: false }, RESIDENT_ATTENDANCE: FULL, FACILITY: VIEW, ELECTRICITY: VIEW, IOT: VIEW, WALLET: VIEW },
  VENDOR_RESTRICTED: { DASHBOARD: VIEW },
  AUDIT_READONLY: Object.fromEntries(ALL_MODULES.map(m => [m, VIEW])) as RoleMatrix,

  // ── Food Ordering & Kitchen Operations roles (PRD §5 authoritative matrix) ──
  //
  // SEPARATION OF DUTIES (C3) — the party that SHIPS must never be the party
  // that CERTIFIES RECEIPT. Concretely: no operational role may hold
  // FOOD_DISPATCH:edit and FOOD_CONFIRM_DELIVERY:edit at the same time.
  //   receiving side  — UNIT_LEAD, CLUSTER_MANAGER: confirm-delivery V·E, and
  //                     dispatch either absent (UNIT_LEAD) or view-only.
  //   shipping side   — FNB_SUPERVISOR / FNB_MANAGER / FNB_ZONAL_HEAD: dispatch
  //                     V·E, confirm-delivery VIEW only.
  //   oversight       — CITY_HEAD / ZONAL_HEAD / SVP: view-only on both.
  // Only SUPER_ADMIN and OPS_EXCELLENCE hold both edits (break-glass parity).
  // Do NOT widen FOOD_CONFIRM_DELIVERY for a kitchen role to clear a 403 — a
  // 403 there means a dispatch path is trying to certify its own receipt, and
  // the route is what has to change. permissions-sync.test.ts asserts this.
  //
  // FOOD_ORG deliberately has NO operational holder — only SUPER_ADMIN /
  // OPS_EXCELLENCE (FULL) and AUDIT_READONLY (VIEW). That is the documented
  // intent, not an omission: FOOD_MODULE_TEST_CASES.md §0.3 states it outright
  // ("granted **only** to …") and negative case M-05 asserts CLUSTER_MANAGER
  // gets 403 on /zones, /agencies and /scopes. The module gates the org spine
  // itself — zones, cities, clusters, agencies, and the user_scopes grants that
  // every other food scope resolves from. FOOD_ORG:edit is what mints a scope
  // row, so any holder can widen its own access; it stays a platform-admin
  // module. Grant a geo scope instead of this cell.
  //
  // Ops users
  UNIT_LEAD: {
    // Food-focused field role (product decision 08-Jul-2026): the launcher/nav
    // is scoped to Food Ordering + Audits only. The former resident/finance
    // suite (RESIDENTS, PROPERTIES, LAUNDRY, COMPLAINTS, LEDGER, PAYMENTS,
    // WALLET) was intentionally removed.
    FOOD_RECEIVE_UPDATE: VE, FOOD_DELIVERY_TRACKING: VE, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VIEW, FOOD_PLACE_ORDER: VE,
    FOOD_CONFIRM_DELIVERY: VE, FOOD_WASTE_TRACKING: VE, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts UL room audits for own property.
    // No ad-hoc creation at launch.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: false, edit: true, delete: false },
  },
  CLUSTER_MANAGER: {
    FOOD_RECEIVE_UPDATE: VE, FOOD_DELIVERY_TRACKING: VE, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VE, FOOD_PLACE_ORDER: VE, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VE, FOOD_WASTE_TRACKING: VE, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts CM + UL audits for the cluster; views CX
    // read-only (C-1). Fine scoping via audit_role_grants.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: false, edit: true, delete: false },
  },
  CITY_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VE, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: oversight viewer — UL + CM for their city, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
  },
  ZONAL_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VE, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: oversight viewer — UL + CM across the zone, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
  },
  // B3-24: OPS_EXCELLENCE has FULL super-admin parity across every module (incl.
  // USERS / SETTINGS / AUDIT_LOG / FINANCE), per explicit product decision.
  // Like SUPER_ADMIN this is the one other role allowed to hold dispatch-edit
  // and confirm-delivery-edit together; it is break-glass, not an operator seat.
  OPS_EXCELLENCE: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as RoleMatrix,
  // SVP holds strictly LESS food access than ZONAL_HEAD below it. That is
  // intent, not drift: FOOD_MODULE_TEST_CASES.md §0.3 spells this seat out as
  // "dispatch VIEW, kitchen-summary VIEW, place/confirm/waste VIEW, reports
  // VIEW; **no FOOD_ALL_ORDERS**" — an executive summary viewer, never an
  // order-level operator (FOOD_ALL_ORDERS is the row-level register, which
  // ZONAL_HEAD/CITY_HEAD hold V·E because they work individual orders).
  // The other apparent gap, FOOD_RECEIVE_UPDATE, confers nothing either way:
  // it and FOOD_DELIVERY_TRACKING are PRD placeholders that gate zero routes
  // and zero screens (no references outside this file on either side), so
  // widening them would buy no capability. Do not close either gap by copying
  // ZONAL_HEAD's row.
  SENIOR_VICE_PRESIDENT: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VIEW, FOOD_DISPATCH: VIEW, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: executive oversight viewer — UL + CM global, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
  },
  // Kitchen users — the SHIPPING side of the separation of duties noted above:
  // FOOD_DISPATCH V·E with FOOD_CONFIRM_DELIVERY VIEW is deliberate, not an
  // oversight. These roles load and send the trip; the receiving property
  // certifies what actually arrived.
  FNB_SUPERVISOR: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VE, FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  FNB_MANAGER: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VE, FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // F&B managers own the food OPERATING configuration — the rotation, meal
    // types, cut-offs and Masters, which shares this gate.
    //
    // Deliberately NOT FOOD_CATALOGUE: ingredients, dishes and the menu rules
    // are agreed centrally, and an F&B manager builds the menu from that agreed
    // catalogue rather than editing it. They still READ every dish — reads are
    // ungated — so the plate composer works exactly as before.
    //
    // B3 — this gate is kitchen-scoped, but three config surfaces have no
    // property or kitchen column at all, so they are brand-wide by construction
    // and only an org-wide caller may WRITE them (food.ts / food-ops.ts
    // deniedGlobalConfig): per_resident_rules (portions), food_meal_config
    // (which meals exist), and the system_config menu-rule switches.
    // Keep this in sync with the same block in apps/uniliv-admin/src/lib/permissions.ts.
    FOOD_SETTINGS: VE,
  },
  FNB_ZONAL_HEAD: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VE, FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  // ── Audit & Inspection roles (FRD §2.2) ──
  // CX team conducts ad-hoc "surprise" CX audits only — never scheduled (C-3).
  CUSTOMER_EXPERIENCE: {
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: true, edit: true, delete: false },
  },
};

export function can(role: UserRole | undefined, module: Module, perm: Permission = "view"): boolean {
  if (!role) return false;
  const matrix = ROLE_PERMISSIONS[role];
  if (!matrix) return false;
  return matrix[module]?.[perm] === true;
}
