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
  | "RECIPES" | "MENU_PLANNING"
  | "SALES_LEADS" | "SALES_DASHBOARD" | "PROPERTY_LEADS"
  | "LEDGER" | "PAYMENTS" | "WALLET" | "BILLING_CYCLES" | "REMINDERS" | "BANKING" | "EXPENSES"
  | "FACILITY" | "ELECTRICITY" | "RESIDENT_ATTENDANCE" | "IOT"
  | "USERS" | "SETTINGS" | "AUDIT_LOG"
  // Food Ordering & Kitchen Operations modules (PRD §5 matrix)
  | "FOOD_DASHBOARD" | "FOOD_ALL_ORDERS" | "FOOD_PLACE_ORDER" | "FOOD_KITCHEN_SUMMARY"
  | "FOOD_DISPATCH" | "FOOD_CONFIRM_DELIVERY" | "FOOD_WASTE_TRACKING" | "FOOD_REPORTS"
  | "FOOD_SETTINGS" | "FOOD_RECEIVE_UPDATE" | "FOOD_DELIVERY_TRACKING" | "FOOD_ORG"
  // Audit & Inspection module (FRD v1.2.2). Coarse page gates; fine-grained
  // audit-type/org-node truth is server-side (audit_role_grants).
  // AUDIT_LOG above is the unrelated host audit log.
  | "AUDIT_DASHBOARD" | "AUDIT_REGISTER" | "AUDIT_EXECUTION" | "AUDIT_FINDINGS"
  | "AUDIT_NCS" | "AUDIT_REVIEW" | "AUDIT_REPORTS" | "AUDIT_SCHEDULES"
  | "AUDIT_TEMPLATES" | "AUDIT_ADMIN" | "AUDIT_TRAIL";

export type Permission = "view" | "create" | "edit" | "delete";

const FULL = { view: true, create: true, edit: true, delete: true };
const VIEW = { view: true, create: false, edit: false, delete: false };

const FOOD_MODULES: Module[] = [
  "FOOD_DASHBOARD","FOOD_ALL_ORDERS","FOOD_PLACE_ORDER","FOOD_KITCHEN_SUMMARY",
  "FOOD_DISPATCH","FOOD_CONFIRM_DELIVERY","FOOD_WASTE_TRACKING","FOOD_REPORTS",
  "FOOD_SETTINGS","FOOD_RECEIVE_UPDATE","FOOD_DELIVERY_TRACKING","FOOD_ORG",
];

/** All Audit & Inspection modules, for the everything-granted roles. */
const AUDIT_MODULES: Module[] = [
  "AUDIT_DASHBOARD","AUDIT_REGISTER","AUDIT_EXECUTION","AUDIT_FINDINGS",
  "AUDIT_NCS","AUDIT_REVIEW","AUDIT_REPORTS","AUDIT_SCHEDULES",
  "AUDIT_TEMPLATES","AUDIT_ADMIN","AUDIT_TRAIL",
];

const ALL_MODULES: Module[] = [
  "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
  "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
  "RECIPES","MENU_PLANNING","SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
  "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
  "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
  "USERS","SETTINGS","AUDIT_LOG",
  ...FOOD_MODULES,
  ...AUDIT_MODULES,
];

export const ROLE_PERMISSIONS: Record<UserRole, Partial<Record<Module, Partial<Record<Permission, boolean>>>>> = {
  SUPER_ADMIN: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as any,
  HR_MANAGER: { DASHBOARD: VIEW, EMPLOYEES: FULL, RECRUITMENT: FULL, LND: FULL, USERS: FULL, SETTINGS: VIEW },
  OPERATIONS_MANAGER: { DASHBOARD: VIEW, PROPERTIES: FULL, RESIDENTS: FULL, COMPLAINTS: FULL, LAUNDRY: FULL, COMMUNICATIONS: FULL, FACILITY: FULL, ELECTRICITY: FULL, RESIDENT_ATTENDANCE: FULL, IOT: FULL, WALLET: VIEW },
  PROCUREMENT_MANAGER: { DASHBOARD: VIEW, VENDORS: FULL, INDENTS: FULL, PURCHASE_ORDERS: FULL, GRN: FULL, INVENTORY: FULL },
  KITCHEN_MANAGER: { DASHBOARD: VIEW, RECIPES: FULL, MENU_PLANNING: FULL, INVENTORY: VIEW },
  PROJECTS_MANAGER: { DASHBOARD: VIEW, PROPERTY_LEADS: FULL, LEDGER: VIEW, PAYMENTS: VIEW, INDENTS: VIEW, PURCHASE_ORDERS: VIEW },
  PROPERTY_ACQUISITION: { DASHBOARD: VIEW, PROPERTY_LEADS: FULL },
  FINANCE: { DASHBOARD: VIEW, EXECUTIVE_DASHBOARD: VIEW, RESIDENTS: VIEW, LEDGER: FULL, PAYMENTS: FULL, WALLET: FULL, BILLING_CYCLES: FULL, REMINDERS: FULL, BANKING: FULL, EXPENSES: FULL, INDENTS: VIEW, PURCHASE_ORDERS: VIEW },
  SALES_EXECUTIVE: { DASHBOARD: VIEW, SALES_LEADS: FULL, SALES_DASHBOARD: VIEW, PROPERTY_LEADS: VIEW },
  WARDEN: { DASHBOARD: VIEW, PROPERTIES: VIEW, RESIDENTS: FULL, COMPLAINTS: FULL, LAUNDRY: FULL, COMMUNICATIONS: { view: true, create: true, edit: false, delete: false }, RESIDENT_ATTENDANCE: FULL, FACILITY: VIEW, ELECTRICITY: VIEW, IOT: VIEW, WALLET: VIEW },
  VENDOR_RESTRICTED: { DASHBOARD: VIEW },
  AUDIT_READONLY: Object.fromEntries(ALL_MODULES.map(m => [m, VIEW])) as any,

  // ── Food Ordering & Kitchen Operations roles (PRD §5 authoritative matrix) ──
  UNIT_LEAD: {
    // Food-focused field role (product decision 08-Jul-2026): the launcher/nav
    // is scoped to Food Ordering + Audits only. The former resident/finance
    // suite (RESIDENTS, PROPERTIES, LAUNDRY, COMPLAINTS, LEDGER, PAYMENTS,
    // WALLET) was intentionally removed. Keep this in sync with the backend copy.
    FOOD_RECEIVE_UPDATE: FULL, FOOD_DELIVERY_TRACKING: FULL, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VIEW, FOOD_PLACE_ORDER: FULL,
    FOOD_CONFIRM_DELIVERY: FULL, FOOD_WASTE_TRACKING: FULL, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts UL room audits for own property; auditee for
    // NCs on it (CAPA via AUDIT_FINDINGS). No ad-hoc creation at launch.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: false, edit: true, delete: false },
    AUDIT_FINDINGS: { view: true, create: true, edit: true, delete: false },
  },
  CLUSTER_MANAGER: {
    FOOD_RECEIVE_UPDATE: FULL, FOOD_DELIVERY_TRACKING: FULL, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: FULL, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: FULL, FOOD_WASTE_TRACKING: FULL, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts CM + UL audits for the cluster; views CX
    // read-only (C-1). Fine scoping is server-side via audit_role_grants.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: false, edit: true, delete: false },
    AUDIT_FINDINGS: VIEW, AUDIT_NCS: VIEW,
  },
  CITY_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: oversight viewer — UL + CM for their city, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW, AUDIT_NCS: VIEW,
  },
  ZONAL_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: oversight viewer — UL + CM across the zone, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW, AUDIT_NCS: VIEW,
  },
  // B3-24: OPS_EXCELLENCE = full super-admin parity across every module.
  OPS_EXCELLENCE: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as any,
  SENIOR_VICE_PRESIDENT: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VIEW, FOOD_DISPATCH: VIEW, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: executive oversight viewer — UL + CM global, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW, AUDIT_NCS: VIEW,
  },
  FNB_SUPERVISOR: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: FULL, FOOD_DISPATCH: FULL, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  FNB_MANAGER: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: FULL, FOOD_DISPATCH: FULL, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // F&B managers own the food operating configuration (dishes, rotation,
    // cutoffs, quantity rules) — and with it the Masters reference data, which
    // shares the FOOD_SETTINGS gate.
    FOOD_SETTINGS: FULL,
    // Kitchen & Menu lives inside the Food module (13-Jul): recipe and menu
    // management belongs to F&B managers (and kitchen managers / ops
    // excellence); unit leads deliberately have no grant here.
    RECIPES: FULL, MENU_PLANNING: FULL,
  },
  FNB_ZONAL_HEAD: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: FULL, FOOD_DISPATCH: FULL, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  // ── Audit & Inspection roles (FRD §2.2) ──
  // CX team conducts ad-hoc "surprise" CX audits only — never scheduled (C-3).
  CUSTOMER_EXPERIENCE: {
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    AUDIT_EXECUTION: { view: true, create: true, edit: true, delete: false },
    AUDIT_NCS: VIEW,
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
 * Where a freshly signed-in user lands. Most roles get the app launcher
 * (/apps) — a permission-filtered grid of their modules. F&B managers work out
 * of Kitchen Summary all day, so we drop them straight onto it as their default
 * dashboard (the launcher is still reachable from the logo / Home).
 */
export function homeForRole(role: UserRole | undefined): string {
  // F&B managers land on Kitchen Home — the journey dashboard where they
  // accept, cook and dispatch the day's meals (Kitchen Summary remains the
  // detailed cook-plan sheet, one click away).
  if (role === "FNB_MANAGER") return "/food/kitchen-home";
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
  [/^\/recipes/, "RECIPES"],
  [/^\/kitchen/, "RECIPES"],
  [/^\/menu-planning/, "MENU_PLANNING"],
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
  [/^\/audits\/findings/, "AUDIT_FINDINGS"],
  [/^\/audits\/ncs/, "AUDIT_NCS"],
  [/^\/audits\/review/, "AUDIT_REVIEW"],
  [/^\/audits\/reports/, "AUDIT_REPORTS"],
  [/^\/audits\/schedules/, "AUDIT_SCHEDULES"],
  [/^\/audits\/templates/, "AUDIT_TEMPLATES"],
  [/^\/audits\/question-bank/, "AUDIT_TEMPLATES"],
  [/^\/audits\/admin/, "AUDIT_ADMIN"],
  [/^\/audits\/trail/, "AUDIT_TRAIL"],
  [/^\/audits\/[^/]+\/run/, "AUDIT_EXECUTION"],
  // Audit detail: gated on register view; rows are server-scoped.
  [/^\/audits/, "AUDIT_REGISTER"],
];

export function moduleForPath(path: string): Module | null {
  for (const [re, m] of PATH_TO_MODULE) if (re.test(path)) return m;
  return null;
}
