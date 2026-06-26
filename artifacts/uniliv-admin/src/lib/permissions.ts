export type UserRole =
  | "SUPER_ADMIN" | "HR_MANAGER" | "OPERATIONS_MANAGER" | "PROCUREMENT_MANAGER"
  | "KITCHEN_MANAGER" | "PROJECTS_MANAGER" | "PROPERTY_ACQUISITION" | "FINANCE"
  | "SALES_EXECUTIVE" | "WARDEN" | "VENDOR_RESTRICTED" | "AUDIT_READONLY"
  // Food Ordering & Kitchen Operations roles (PRD §3)
  | "UNIT_LEAD" | "CLUSTER_MANAGER" | "CITY_HEAD" | "ZONAL_HEAD"
  | "OPS_EXCELLENCE" | "SENIOR_VICE_PRESIDENT"
  | "FNB_SUPERVISOR" | "FNB_MANAGER" | "FNB_ZONAL_HEAD";

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
  | "FOOD_SETTINGS" | "FOOD_RECEIVE_UPDATE" | "FOOD_DELIVERY_TRACKING" | "FOOD_ORG";

export type Permission = "view" | "create" | "edit" | "delete";

const FULL = { view: true, create: true, edit: true, delete: true };
const VIEW = { view: true, create: false, edit: false, delete: false };

const FOOD_MODULES: Module[] = [
  "FOOD_DASHBOARD","FOOD_ALL_ORDERS","FOOD_PLACE_ORDER","FOOD_KITCHEN_SUMMARY",
  "FOOD_DISPATCH","FOOD_CONFIRM_DELIVERY","FOOD_WASTE_TRACKING","FOOD_REPORTS",
  "FOOD_SETTINGS","FOOD_RECEIVE_UPDATE","FOOD_DELIVERY_TRACKING","FOOD_ORG",
];

const ALL_MODULES: Module[] = [
  "DASHBOARD","EXECUTIVE_DASHBOARD","PROPERTIES","RESIDENTS","COMPLAINTS","LAUNDRY","COMMUNICATIONS",
  "EMPLOYEES","RECRUITMENT","LND","VENDORS","INDENTS","PURCHASE_ORDERS","GRN","INVENTORY",
  "RECIPES","MENU_PLANNING","SALES_LEADS","SALES_DASHBOARD","PROPERTY_LEADS","LEDGER","PAYMENTS","WALLET",
  "BILLING_CYCLES","REMINDERS","BANKING","EXPENSES",
  "FACILITY","ELECTRICITY","RESIDENT_ATTENDANCE","IOT",
  "USERS","SETTINGS","AUDIT_LOG",
  ...FOOD_MODULES,
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
    // Full resident suite (Wave-4a): surfaces the resident/ledger/payments/
    // laundry/properties nav + pages for Unit Leads, mirroring WARDEN (the
    // property-scoped resident role) plus finance for collections. All
    // resident/ledger/payment routes property-scope, so a UNIT_LEAD with a
    // propertyId is automatically limited to their property.
    RESIDENTS: FULL, PROPERTIES: VIEW, LAUNDRY: FULL,
    LEDGER: { view: true, create: true, edit: true, delete: false },
    PAYMENTS: { view: true, create: true, edit: true, delete: false },
    WALLET: VIEW,
    // Complaints (O6 reuse): surfaces the Complaints nav item + pages for Unit
    // Leads, who raise/work property-scoped tickets incl. auto-created food
    // variance complaints (O5). No delete (status-driven lifecycle).
    COMPLAINTS: { view: true, create: true, edit: true, delete: false },
    FOOD_RECEIVE_UPDATE: FULL, FOOD_DELIVERY_TRACKING: FULL, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VIEW, FOOD_PLACE_ORDER: FULL,
    FOOD_CONFIRM_DELIVERY: FULL, FOOD_WASTE_TRACKING: FULL, FOOD_REPORTS: VIEW,
  },
  CLUSTER_MANAGER: {
    FOOD_RECEIVE_UPDATE: FULL, FOOD_DELIVERY_TRACKING: FULL, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: FULL, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: FULL, FOOD_WASTE_TRACKING: FULL, FOOD_REPORTS: VIEW,
  },
  CITY_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  ZONAL_HEAD: {
    FOOD_RECEIVE_UPDATE: VIEW, FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: FULL, FOOD_PLACE_ORDER: VIEW, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VIEW, FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
  },
  // B3-24: OPS_EXCELLENCE = full super-admin parity across every module.
  OPS_EXCELLENCE: Object.fromEntries(ALL_MODULES.map(m => [m, FULL])) as any,
  SENIOR_VICE_PRESIDENT: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: VIEW, FOOD_DISPATCH: VIEW, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
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
  },
  FNB_ZONAL_HEAD: {
    FOOD_DELIVERY_TRACKING: VIEW, FOOD_DASHBOARD: VIEW, FOOD_PLACE_ORDER: VIEW,
    FOOD_KITCHEN_SUMMARY: FULL, FOOD_DISPATCH: FULL, FOOD_CONFIRM_DELIVERY: VIEW,
    FOOD_WASTE_TRACKING: VIEW, FOOD_REPORTS: VIEW,
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
 * Where a freshly signed-in user should land, based on their role. Each role
 * goes to the module it actually works in, so nobody is dropped onto the
 * super-admin operations dashboard by accident. Admin/ops/audit roles (which
 * legitimately read the ops overview) fall through to "/".
 */
export function homeForRole(role: UserRole | undefined): string {
  if (!role) return "/";
  const HOME: Partial<Record<UserRole, string>> = {
    HR_MANAGER: "/employees",
    PROCUREMENT_MANAGER: "/indents",
    KITCHEN_MANAGER: "/recipes",
    PROJECTS_MANAGER: "/property-leads",
    PROPERTY_ACQUISITION: "/property-leads",
    FINANCE: "/dashboard/executive",
    SALES_EXECUTIVE: "/leads",
    UNIT_LEAD: "/home",
    CLUSTER_MANAGER: "/food/dashboard",
    CITY_HEAD: "/food/dashboard",
    ZONAL_HEAD: "/food/dashboard",
    // B3-24: OPS_EXCELLENCE = super-admin parity, so it lands on the same "/" overview.
    SENIOR_VICE_PRESIDENT: "/food/dashboard",
    FNB_SUPERVISOR: "/food/dashboard",
    FNB_MANAGER: "/food/dashboard",
    FNB_ZONAL_HEAD: "/food/dashboard",
  };
  if (HOME[role]) return HOME[role]!;
  if (can(role, "DASHBOARD", "view")) return "/";
  if (can(role, "FOOD_DASHBOARD", "view")) return "/food/dashboard";
  return "/";
}

export const PATH_TO_MODULE: Array<[RegExp, Module]> = [
  [/^\/$/, "DASHBOARD"],
  // Unit-Lead Home dashboard (WS7) — top-level, gated on the food module.
  [/^\/home/, "FOOD_DASHBOARD"],
  [/^\/dashboard\/executive/, "EXECUTIVE_DASHBOARD"],
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
  [/^\/food\/place-order/, "FOOD_PLACE_ORDER"],
  [/^\/food\/kitchen-summary/, "FOOD_KITCHEN_SUMMARY"],
  [/^\/food\/dispatch/, "FOOD_DISPATCH"],
  [/^\/food\/confirm-delivery/, "FOOD_CONFIRM_DELIVERY"],
  [/^\/food\/waste-analytics/, "FOOD_REPORTS"],
  [/^\/food\/waste/, "FOOD_WASTE_TRACKING"],
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
];

export function moduleForPath(path: string): Module | null {
  for (const [re, m] of PATH_TO_MODULE) if (re.test(path)) return m;
  return null;
}
