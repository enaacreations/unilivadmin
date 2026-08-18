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
  | "LEDGER" | "PAYMENTS" | "WALLET" | "BILLING_CYCLES" | "REMINDERS" | "BANKING" | "EXPENSES"
  | "FACILITY" | "ELECTRICITY" | "RESIDENT_ATTENDANCE" | "IOT"
  | "USERS" | "SETTINGS" | "AUDIT_LOG"
  // Food Ordering & Kitchen Operations modules (PRD §5 matrix)
  | "FOOD_DASHBOARD" | "FOOD_ALL_ORDERS" | "FOOD_PLACE_ORDER" | "FOOD_KITCHEN_SUMMARY"
  | "FOOD_DISPATCH" | "FOOD_CONFIRM_DELIVERY" | "FOOD_WASTE_TRACKING" | "FOOD_REPORTS"
  | "FOOD_SETTINGS" | "FOOD_RECEIVE_UPDATE" | "FOOD_DELIVERY_TRACKING" | "FOOD_ORG"
  // The definitional layer of Service Set — ingredients, dishes (with their
  // portion rules) and the menu-composition rules: what a plate MAY be built
  // from and what it MUST contain. Split out of FOOD_SETTINGS so a role can
  // build the rotation from an agreed catalogue without editing the catalogue.
  // Reads are not gated on it; the rotation board still sees every dish.
  | "FOOD_CATALOGUE"
  // Audit & Inspection module (FRD v1.2.2). Coarse page gates; fine-grained
  // audit-type/org-node truth is server-side (audit_role_grants).
  // AUDIT_LOG above is the unrelated host audit log.
  | "AUDIT_DASHBOARD" | "AUDIT_REGISTER" | "AUDIT_EXECUTION"
  | "AUDIT_REVIEW" | "AUDIT_REPORTS" | "AUDIT_SCHEDULES"
  | "AUDIT_TEMPLATES" | "AUDIT_ADMIN";

export type Permission = "view" | "create" | "edit" | "delete";

const FULL = { view: true, create: true, edit: true, delete: true };
const VIEW = { view: true, create: false, edit: false, delete: false };
/** PRD legend "V·E" (View & Edit) — full access in our create/edit model. */
const VE = FULL;

export const FOOD_MODULES: Module[] = [
  "FOOD_DASHBOARD","FOOD_ALL_ORDERS","FOOD_PLACE_ORDER","FOOD_KITCHEN_SUMMARY",
  "FOOD_DISPATCH","FOOD_CONFIRM_DELIVERY","FOOD_WASTE_TRACKING","FOOD_REPORTS",
  "FOOD_SETTINGS","FOOD_RECEIVE_UPDATE","FOOD_DELIVERY_TRACKING","FOOD_ORG","FOOD_CATALOGUE",
];

/** All Audit & Inspection modules, for the everything-granted roles. */
export const AUDIT_MODULES: Module[] = [
  "AUDIT_DASHBOARD","AUDIT_REGISTER","AUDIT_EXECUTION",
  "AUDIT_REVIEW","AUDIT_REPORTS","AUDIT_SCHEDULES",
  "AUDIT_TEMPLATES","AUDIT_ADMIN",
];

/**
 * Every module in the system. Mirrors the backend copy in
 * apps/api-server/src/lib/permissions.ts — permissions-sync.test.ts locks the
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

export const ROLE_PERMISSIONS: Record<UserRole, Partial<Record<Module, Partial<Record<Permission, boolean>>>>> = {
  // Break-glass parity role: deliberately holds BOTH FOOD_DISPATCH:edit and
  // FOOD_CONFIRM_DELIVERY:edit. Every operational role keeps those two apart
  // (see the separation-of-duties note on the kitchen roles below).
  SUPER_ADMIN: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as any,
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
  AUDIT_READONLY: Object.fromEntries(ALL_MODULES.map(m => [m, VIEW])) as any,

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
  UNIT_LEAD: {
    // Food-focused field role (product decision 08-Jul-2026): the launcher/nav
    // is scoped to Food Ordering + Audits only. The former resident/finance
    // suite (RESIDENTS, PROPERTIES, LAUNDRY, COMPLAINTS, LEDGER, PAYMENTS,
    // WALLET) was intentionally removed. Keep this in sync with the backend copy.
    FOOD_RECEIVE_UPDATE: VE, FOOD_DELIVERY_TRACKING: VE, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VIEW, FOOD_PLACE_ORDER: VE,
    FOOD_CONFIRM_DELIVERY: VE, FOOD_WASTE_TRACKING: VE, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts UL room audits for own property.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: false, edit: true, delete: false },
  },
  CLUSTER_MANAGER: {
    FOOD_RECEIVE_UPDATE: VE, FOOD_DELIVERY_TRACKING: VE, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VE, FOOD_PLACE_ORDER: VE, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VE, FOOD_WASTE_TRACKING: VE, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts CM + UL audits for the cluster; views CX
    // read-only (C-1). Fine scoping is server-side via audit_role_grants.
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
  // B3-24: OPS_EXCELLENCE = full super-admin parity across every module.
  // Like SUPER_ADMIN this is the one other role allowed to hold dispatch-edit
  // and confirm-delivery-edit together; it is break-glass, not an operator seat.
  OPS_EXCELLENCE: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as any,
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
    // types, cut-offs — and with it the Masters reference data, which shares
    // the FOOD_SETTINGS gate.
    //
    // Deliberately NOT FOOD_CATALOGUE: ingredients, dishes and the menu rules
    // are agreed centrally, so those three Service Set tabs are hidden for this
    // role and their write endpoints refuse it. Reads stay open, so the plate
    // composer still sees every dish. Keep in sync with the backend copy.
    //
    // B3 — this gate is kitchen-scoped, but three config surfaces have no
    // property or kitchen column at all, so they are brand-wide by construction
    // and only an org-wide caller may WRITE them (food.ts / food-ops.ts
    // deniedGlobalConfig): per_resident_rules (portions), food_meal_config
    // (which meals exist), and the system_config menu-rule switches. The pages
    // derive this from `myKitchenIds` (orgWideConfig), not from the role.
    FOOD_SETTINGS: FULL,
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
  return ROLE_PERMISSIONS[role]?.[module]?.[perm] === true;
}

/** B3-24: roles with full super-admin parity (SUPER_ADMIN + OPS_EXCELLENCE). */
export const isSuperAdminRole = (role: UserRole | undefined): boolean =>
  role === "SUPER_ADMIN" || role === "OPS_EXCELLENCE";

/**
 * Where a freshly signed-in user lands: the app launcher (/apps), for every
 * persona — a permission-filtered grid with one card per module, never per
 * page. F&B managers used to skip it and land inside Kitchen Home, which put
 * the Food module's internal pages in front of them before the module itself;
 * those pages are reachable from inside Food, so the first view is now the
 * same one-card launcher everyone else (Ops Excellence included) gets.
 */
export function homeForRole(_role: UserRole | undefined): string {
  return "/apps";
}

export const PATH_TO_MODULE: Array<[RegExp, Module]> = [
  // Unit-Lead dashboard (WS7) — top-level, gated on the food module.
  [/^\/home/, "FOOD_DASHBOARD"],
  [/^\/dashboard\/executive/, "EXECUTIVE_DASHBOARD"],
  [/^\/dashboard/, "DASHBOARD"],
  [/^\/properties/, "PROPERTIES"],
  [/^\/residents/, "RESIDENTS"],
  [/^\/complaints/, "COMPLAINTS"],
  [/^\/laundry/, "LAUNDRY"],
  [/^\/communications/, "COMMUNICATIONS"],
  [/^\/employees/, "EMPLOYEES"],
  [/^\/attendance/, "EMPLOYEES"],
  [/^\/leaves/, "EMPLOYEES"],
  [/^\/recruitment/, "RECRUITMENT"],
  [/^\/courses/, "LND"],
  [/^\/vendors/, "VENDORS"],
  [/^\/indents/, "INDENTS"],
  [/^\/purchase-orders/, "PURCHASE_ORDERS"],
  [/^\/grn/, "GRN"],
  [/^\/inventory/, "INVENTORY"],
  // Food Ordering & Kitchen Operations (specific paths before the /food dashboard)
  [/^\/food\/organization/, "FOOD_ORG"],
  [/^\/food\/my-properties/, "FOOD_DASHBOARD"],
  [/^\/food\/orders/, "FOOD_ALL_ORDERS"],
  // Track calls GET /food/orders/track + /food/orders, which the SERVER gates
  // on FOOD_ALL_ORDERS — mirror that here so under-permissioned roles get the
  // Forbidden screen instead of a dead search page. (If track should open up
  // to kitchen personas, gate BOTH sides on FOOD_DELIVERY_TRACKING instead.)
  [/^\/food\/track/, "FOOD_ALL_ORDERS"],
  [/^\/food\/kitchen-home/, "FOOD_KITCHEN_SUMMARY"],
  // Kitchen Summary and Dispatch were pulled from the UI (nav + Kitchen Home
  // quick links) — every persona now works the meal from Kitchen Home. Their
  // routes and pages are intentionally still mounted, so these gates stay live
  // for anyone hitting the URLs directly.
  [/^\/food\/kitchen-summary/, "FOOD_KITCHEN_SUMMARY"],
  [/^\/food\/dispatch/, "FOOD_DISPATCH"],
  // /food/place-order, /food/confirm-delivery, /food/waste were folded into
  // Food Overview and their routes removed; the modules still gate the inline
  // actions there.
  [/^\/food\/waste-analytics/, "FOOD_REPORTS"],
  [/^\/food\/reports/, "FOOD_REPORTS"],
  [/^\/food\/settings/, "FOOD_SETTINGS"],
  [/^\/food\/guests/, "FOOD_DASHBOARD"],
  [/^\/food\/dashboard/, "FOOD_DASHBOARD"],
  [/^\/food\/?$/, "FOOD_DASHBOARD"],
  [/^\/leads/, "SALES_LEADS"],
  [/^\/sales\/dashboard/, "SALES_DASHBOARD"],
  [/^\/property-leads/, "PROPERTY_LEADS"],
  [/^\/ledger/, "LEDGER"],
  [/^\/payments/, "PAYMENTS"],
  [/^\/billing-cycles/, "BILLING_CYCLES"],
  [/^\/reminders/, "REMINDERS"],
  [/^\/banking/, "BANKING"],
  [/^\/expenses/, "EXPENSES"],
  [/^\/wallet/, "WALLET"],
  [/^\/facility/, "FACILITY"],
  [/^\/electricity/, "ELECTRICITY"],
  [/^\/resident-attendance/, "RESIDENT_ATTENDANCE"],
  [/^\/out-passes/, "RESIDENT_ATTENDANCE"],
  [/^\/iot/, "IOT"],
  // Masters admin (B3-2) — registry-backed reference-data CRUD, gated on food settings.
  [/^\/masters/, "FOOD_SETTINGS"],
  [/^\/users/, "USERS"],
  [/^\/audit-log/, "AUDIT_LOG"],
  [/^\/settings/, "SETTINGS"],
  [/^\/rooms/, "PROPERTIES"],
  // Audit & Inspection (specific paths before the /audits/:id catch-all).
  [/^\/audits\/dashboard/, "AUDIT_DASHBOARD"],
  [/^\/audits\/register/, "AUDIT_REGISTER"],
  [/^\/audits\/my/, "AUDIT_EXECUTION"],
  [/^\/audits\/review/, "AUDIT_REVIEW"],
  [/^\/audits\/reports/, "AUDIT_REPORTS"],
  [/^\/audits\/schedules/, "AUDIT_SCHEDULES"],
  [/^\/audits\/templates/, "AUDIT_TEMPLATES"],
  [/^\/audits\/question-bank/, "AUDIT_TEMPLATES"],
  [/^\/audits\/admin/, "AUDIT_ADMIN"],
  [/^\/audits\/[^/]+\/run/, "AUDIT_EXECUTION"],
  // Audit detail: gated on register view; rows are server-scoped.
  [/^\/audits/, "AUDIT_REGISTER"],
];

export function moduleForPath(path: string): Module | null {
  for (const [re, m] of PATH_TO_MODULE) if (re.test(path)) return m;
  return null;
}
