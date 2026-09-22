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
  | "USERS" | "SETTINGS" | "AUDIT_LOG" | "ACCESS_CONTROL"
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

/**
 * PRD §23's 13 actions. The legacy four come FIRST and keep their spelling, so
 * `Permission` below is a strict subset and every existing
 * `authorize(module, "view")` call site compiles unchanged.
 */
export type Action =
  | "view" | "create" | "edit" | "delete"
  | "submit" | "approve" | "reject" | "assign"
  | "complete" | "verify" | "export" | "download" | "configure";

export const ALL_ACTIONS: Action[] = [
  "view", "create", "edit", "delete",
  "submit", "approve", "reject", "assign",
  "complete", "verify", "export", "download", "configure",
];

/** @deprecated Use `Action`. Retained so the 4-permission call sites keep typing. */
export type Permission = "view" | "create" | "edit" | "delete";

/**
 * Actions a module has BEYOND the legacy four.
 *
 * `actionsFor()` returns the legacy four UNIONED with these — it never subtracts.
 * That is deliberate: the existing matrix grants view/create/edit/delete broadly
 * (the three parity roles hold all four on all 53 modules), so a hand-curated
 * "this module only has view and export" list would silently REVOKE rights the
 * moment actionsFor() started gating the matrix. An invariant test asserts this.
 *
 * Narrowing a module's set is a real and worthwhile exercise — a dashboard
 * cannot meaningfully be deleted — but it revokes access, so it needs product
 * sign-off per module rather than being smuggled in with the vocabulary change.
 */
export const LEGACY_ACTIONS: Action[] = ["view", "create", "edit", "delete"];

/** Extra actions per module, on top of the legacy four. */
export const MODULE_EXTRA_ACTIONS: Partial<Record<Module, Action[]>> = {
  DASHBOARD: ["export"],
  EXECUTIVE_DASHBOARD: ["export"],
  SALES_DASHBOARD: ["export"],
  FOOD_DASHBOARD: ["export"],
  AUDIT_DASHBOARD: ["export"],
  AUDIT_LOG: ["export"],
  FOOD_REPORTS: ["export", "download"],
  AUDIT_REPORTS: ["export", "download", "configure"],
  AUDIT_REVIEW: ["approve", "reject", "verify"],
  AUDIT_EXECUTION: ["submit", "complete", "assign"],
  AUDIT_SCHEDULES: ["assign", "configure"],
  AUDIT_TEMPLATES: ["configure"],
  AUDIT_ADMIN: ["configure"],
  SETTINGS: ["configure"],
  ACCESS_CONTROL: ["configure"],
  FOOD_SETTINGS: ["configure"],
  FOOD_DISPATCH: ["assign", "complete"],
  FOOD_CONFIRM_DELIVERY: ["verify"],
  FOOD_PLACE_ORDER: ["submit"],
  INDENTS: ["submit", "approve", "reject"],
  PURCHASE_ORDERS: ["submit", "approve", "reject"],
  EXPENSES: ["submit", "approve", "reject"],
  PAYMENTS: ["approve", "verify"],
  WALLET: ["approve", "verify"],
  COMPLAINTS: ["assign", "complete", "verify"],
  RECRUITMENT: ["approve", "reject"],
  EMPLOYEES: ["approve", "reject", "export"],
  RESIDENTS: ["export"],
  USERS: ["configure"],
};

/** Every action a module supports: the legacy four plus its extras. */
export function actionsFor(module: Module): Action[] {
  const extra = MODULE_EXTRA_ACTIONS[module] ?? [];
  return [...LEGACY_ACTIONS, ...extra.filter((a) => !LEGACY_ACTIONS.includes(a))];
}

/**
 * Action implication: holding X also confers Y. Only ever WIDENS, never denies.
 *
 * The edges are deliberately minimal and one-directional — you cannot approve
 * what you cannot see, and an export is a download. Nothing implies `edit`,
 * `delete` or `configure`, so no implication can hand out a write.
 *
 * NOT yet consulted by can(): enabling it would retroactively grant `view` to
 * any cell holding a write WITHOUT view. access-matrix-invariants.test.ts
 * asserts no such cell exists before decide() turns it on.
 */
export const IMPLIES: Partial<Record<Action, Action[]>> = {
  create: ["view"],
  edit: ["view"],
  delete: ["view"],
  submit: ["view"],
  approve: ["view"],
  reject: ["view"],
  assign: ["view"],
  complete: ["view"],
  verify: ["view"],
  configure: ["view"],
  export: ["view", "download"],
  download: ["view"],
};

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
  "USERS","SETTINGS","AUDIT_LOG","ACCESS_CONTROL",
  ...FOOD_MODULES,
  ...AUDIT_MODULES,
];

/**
 * Module families, for grouping in the admin UI.
 *
 * Presentation only — nothing authorizes off a family. It exists because 53
 * flat modules is the reason the access preview reads as a wall: grouped, a
 * reader scans eight rows and drills into one.
 *
 * MODULE_FAMILY is exhaustive by construction (the test below the Module union
 * would fail on a missing key), so a new module must be filed rather than
 * silently landing in "Other".
 */
export type ModuleFamily =
  | "Operations" | "Food & Kitchen" | "Audits" | "Finance"
  | "People" | "Procurement" | "Sales" | "Platform";

export const MODULE_FAMILY: Record<Module, ModuleFamily> = {
  DASHBOARD: "Operations", EXECUTIVE_DASHBOARD: "Operations", PROPERTIES: "Operations",
  RESIDENTS: "Operations", COMPLAINTS: "Operations", LAUNDRY: "Operations",
  COMMUNICATIONS: "Operations", FACILITY: "Operations", ELECTRICITY: "Operations",
  RESIDENT_ATTENDANCE: "Operations", IOT: "Operations",

  EMPLOYEES: "People", RECRUITMENT: "People", LND: "People",

  VENDORS: "Procurement", INDENTS: "Procurement", PURCHASE_ORDERS: "Procurement",
  GRN: "Procurement", INVENTORY: "Procurement",

  SALES_LEADS: "Sales", SALES_DASHBOARD: "Sales", PROPERTY_LEADS: "Sales",

  LEDGER: "Finance", PAYMENTS: "Finance", WALLET: "Finance", BILLING_CYCLES: "Finance",
  REMINDERS: "Finance", BANKING: "Finance", EXPENSES: "Finance",

  USERS: "Platform", SETTINGS: "Platform", AUDIT_LOG: "Platform", ACCESS_CONTROL: "Platform",

  FOOD_RECEIVE_UPDATE: "Food & Kitchen", FOOD_DELIVERY_TRACKING: "Food & Kitchen",
  FOOD_DASHBOARD: "Food & Kitchen", FOOD_ALL_ORDERS: "Food & Kitchen",
  FOOD_PLACE_ORDER: "Food & Kitchen", FOOD_KITCHEN_SUMMARY: "Food & Kitchen",
  FOOD_DISPATCH: "Food & Kitchen", FOOD_CONFIRM_DELIVERY: "Food & Kitchen",
  FOOD_WASTE_TRACKING: "Food & Kitchen", FOOD_REPORTS: "Food & Kitchen",
  FOOD_SETTINGS: "Food & Kitchen", FOOD_ORG: "Food & Kitchen", FOOD_CATALOGUE: "Food & Kitchen",

  AUDIT_DASHBOARD: "Audits", AUDIT_REGISTER: "Audits", AUDIT_EXECUTION: "Audits",
  AUDIT_REVIEW: "Audits", AUDIT_REPORTS: "Audits", AUDIT_SCHEDULES: "Audits",
  AUDIT_TEMPLATES: "Audits", AUDIT_ADMIN: "Audits",
};

export const FAMILY_ORDER: ModuleFamily[] = [
  "Operations", "Food & Kitchen", "Audits", "Finance", "People", "Procurement", "Sales", "Platform",
];

/** Human label for a module key — the UI leads with this, key as mono subtext. */
export const MODULE_LABEL: Partial<Record<Module, string>> = {
  EXECUTIVE_DASHBOARD: "Executive dashboard", RESIDENT_ATTENDANCE: "Resident attendance",
  LND: "Learning & development", GRN: "Goods received", SALES_LEADS: "Sales CRM",
  SALES_DASHBOARD: "Sales dashboard", PROPERTY_LEADS: "Property leads",
  BILLING_CYCLES: "Recurring billing", AUDIT_LOG: "Activity trail",
  ACCESS_CONTROL: "Access control", FOOD_RECEIVE_UPDATE: "Receive & update",
  FOOD_DELIVERY_TRACKING: "Delivery tracking", FOOD_DASHBOARD: "Food dashboard",
  FOOD_ALL_ORDERS: "All orders", FOOD_PLACE_ORDER: "Place order",
  FOOD_KITCHEN_SUMMARY: "Kitchen summary", FOOD_DISPATCH: "Dispatch",
  FOOD_CONFIRM_DELIVERY: "Confirm delivery", FOOD_WASTE_TRACKING: "Waste tracking",
  FOOD_REPORTS: "Food reports", FOOD_SETTINGS: "Food settings", FOOD_ORG: "Kitchen org",
  FOOD_CATALOGUE: "Service catalogue", AUDIT_DASHBOARD: "Audit dashboard",
  AUDIT_REGISTER: "Audit register", AUDIT_EXECUTION: "Audit execution",
  AUDIT_REVIEW: "Audit review", AUDIT_REPORTS: "Audit reports",
  AUDIT_SCHEDULES: "Audit schedules", AUDIT_TEMPLATES: "Audit templates",
  AUDIT_ADMIN: "Audit admin",
};

export function moduleLabel(m: Module): string {
  return MODULE_LABEL[m] ?? m.charAt(0) + m.slice(1).toLowerCase().replace(/_/g, " ");
}

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

/**
 * Installed resolver, when the matrix has been moved into the database.
 *
 * A registration hook rather than a direct import because matrix.ts already
 * imports THIS module (for ROLE_PERMISSIONS, ALL_MODULES, actionsFor, IMPLIES)
 * and importing back would close the cycle. It also keeps the switch explicit
 * and revertable: nothing reads the database until something installs this.
 */
type MatrixResolver = (roleKey: string | undefined, module: Module, action: Action) => boolean;
let installedResolver: MatrixResolver | null = null;

export function installMatrixResolver(fn: MatrixResolver): void {
  installedResolver = fn;
}
/** Test seam — restores the code matrix. */
export function uninstallMatrixResolver(): void {
  installedResolver = null;
}
export function matrixResolverInstalled(): boolean {
  return installedResolver !== null;
}

/**
 * The single capability question, asked ~200 times across the app.
 *
 * Stays SYNCHRONOUS on purpose: most call sites are express middleware that
 * cannot await, so a database-backed matrix is served from a process snapshot
 * refreshed out of band, never read inline.
 */
/**
 * Widened from `Permission` to `Action`: `Permission` is the legacy four and a
 * strict subset, so every existing `can(m, "view")` call keeps compiling while
 * a route may now gate on `approve`, `assign`, `export` and the rest.
 *
 * A non-legacy action against the CODE matrix simply misses and returns false —
 * the code matrix only ever held four. That is the right fallback: a route
 * gating on `approve` before the DB matrix is seeded denies, rather than
 * accidentally allowing.
 */
export function can(role: UserRole | undefined, module: Module, perm: Action = "view"): boolean {
  if (!role) return false;
  if (installedResolver) return installedResolver(role, module, perm);
  const matrix = ROLE_PERMISSIONS[role];
  if (!matrix) return false;
  return matrix[module]?.[perm as Permission] === true;
}
