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
  | "LEDGER" | "PAYMENTS" | "WALLET"
  | "BILLING_CYCLES" | "REMINDERS" | "BANKING" | "EXPENSES"
  | "FACILITY" | "ELECTRICITY" | "RESIDENT_ATTENDANCE" | "IOT"
  | "USERS" | "SETTINGS" | "AUDIT_LOG"
  // Food Ordering & Kitchen Operations modules (PRD §5 matrix)
  | "FOOD_RECEIVE_UPDATE" | "FOOD_DELIVERY_TRACKING" | "FOOD_DASHBOARD"
  | "FOOD_ALL_ORDERS" | "FOOD_PLACE_ORDER" | "FOOD_KITCHEN_SUMMARY"
  | "FOOD_DISPATCH" | "FOOD_CONFIRM_DELIVERY" | "FOOD_WASTE_TRACKING"
  | "FOOD_REPORTS" | "FOOD_SETTINGS" | "FOOD_ORG" | "FOOD_ORDER_LOCK"
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
const FOOD_MODULES: Module[] = [
  "FOOD_RECEIVE_UPDATE", "FOOD_DELIVERY_TRACKING", "FOOD_DASHBOARD",
  "FOOD_ALL_ORDERS", "FOOD_PLACE_ORDER", "FOOD_KITCHEN_SUMMARY",
  "FOOD_DISPATCH", "FOOD_CONFIRM_DELIVERY", "FOOD_WASTE_TRACKING",
  "FOOD_REPORTS", "FOOD_SETTINGS", "FOOD_ORG",
  // Pin a pre-placement order quantity so it is read-only to everyone else.
  // Deliberately NOT granted to UNIT_LEAD or CLUSTER_MANAGER even though both
  // hold FOOD_PLACE_ORDER — otherwise a unit lead could lock against itself.
  // Only the everything-granted roles below pick this up: SUPER_ADMIN and
  // OPS_EXCELLENCE get FULL, AUDIT_READONLY gets VIEW (sees locks, can't set).
  "FOOD_ORDER_LOCK",
];

/** All Audit & Inspection modules, for the everything-granted roles. */
const AUDIT_MODULES: Module[] = [
  "AUDIT_DASHBOARD", "AUDIT_REGISTER", "AUDIT_EXECUTION",
  "AUDIT_REVIEW", "AUDIT_REPORTS", "AUDIT_SCHEDULES",
  "AUDIT_TEMPLATES", "AUDIT_ADMIN",
];

type RoleMatrix = Partial<Record<Module, Partial<Record<Permission, boolean>>>>;

export const ROLE_PERMISSIONS: Record<UserRole, RoleMatrix> = {
  SUPER_ADMIN: Object.fromEntries(([
    "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
    "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
    "RECIPES","MENU_PLANNING","SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
    "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
    "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
    "USERS","SETTINGS","AUDIT_LOG",
    ...FOOD_MODULES,
    ...AUDIT_MODULES,
  ] as Module[]).map(m => [m, FULL])) as RoleMatrix,
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
  AUDIT_READONLY: Object.fromEntries(([
    "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
    "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
    "RECIPES","MENU_PLANNING","SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
    "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
    "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
    "USERS","SETTINGS","AUDIT_LOG",
    ...FOOD_MODULES,
    ...AUDIT_MODULES,
  ] as Module[]).map(m => [m, VIEW])) as RoleMatrix,

  // ── Food Ordering & Kitchen Operations roles (PRD §5 authoritative matrix) ──
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
  OPS_EXCELLENCE: Object.fromEntries(([
    "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
    "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
    "RECIPES","MENU_PLANNING","SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
    "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
    "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
    "USERS","SETTINGS","AUDIT_LOG",
    ...FOOD_MODULES,
    ...AUDIT_MODULES,
  ] as Module[]).map(m => [m, FULL])) as RoleMatrix,
  SENIOR_VICE_PRESIDENT: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VIEW, FOOD_DISPATCH: VIEW, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // Audit & Inspection: executive oversight viewer — UL + CM global, no CX (C-2).
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
  },
  // Kitchen users
  FNB_SUPERVISOR: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VE, FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  FNB_MANAGER: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VE, FOOD_DISPATCH: VE, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
    // F&B managers own the food operating configuration (dishes, rotation,
    // cutoffs, quantity rules) — includes Masters, which shares this gate.
    FOOD_SETTINGS: VE,
    // Kitchen & Menu lives inside the Food module (13-Jul): recipe and menu
    // management belongs to F&B managers (kitchen managers / ops excellence
    // already hold it); unit leads deliberately have no grant here. Keep in
    // sync with the frontend copy.
    RECIPES: VE, MENU_PLANNING: VE,
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
