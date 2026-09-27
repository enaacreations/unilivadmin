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

/* ════════════════════════════════════════════════════════════════════════════
 * THE ACCESS VOCABULARY — three levels, in one place.
 *
 *   Module          a product area a person would name out loud: "Audits",
 *                   "Food", "Finance". 10 of them. This is the unit the nav,
 *                   the launcher and the role editor are organized by.
 *   Functionality   a capability INSIDE a module: "Audit register", "Dispatch",
 *                   "Ledger". 54 of them. This is the unit that is STORED and
 *                   ENFORCED — every authorize() gate names one.
 *   Action          the verb: view / create / edit / … 13 of them, and not
 *                   every functionality supports all of them.
 *
 * ── Why the enforced unit is the functionality, not the module ──────────────
 * Because "roles have functionality-level access inside a module" is the
 * requirement. A module-level grant would be too coarse to express the things
 * this product actually needs — CLUSTER_MANAGER conducts audits but must not
 * review them; F&B dispatches but must never confirm receipt of its own
 * shipment. Both of those are two functionalities of one module with different
 * answers, so the module cannot be the unit that is stored.
 *
 * ── What the module level therefore IS ──────────────────────────────────────
 * DERIVED, never stored. `canModuleAny()` answers "does this person hold
 * anything in Audits?" by folding over the module's functionalities. That is
 * what lights up a nav section or a launcher card, and it is why no row in the
 * database ever names a module: there is nothing to keep in sync, and a
 * functionality added to a module tomorrow is NOT silently granted to everyone
 * who had the module today.
 *
 * That last property is the reason this is a fold and not a wildcard row.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The 11 modules. Deliberately the same set of words the sidebar already groups
 * by (see apps/uniliv-admin/src/lib/nav.ts) — an admin granting "Audits" and a
 * user opening "Audits" must be talking about the same thing.
 *
 * Module keys are disjoint from functionality keys by construction, so a bare
 * string is never ambiguous about which level it names. An invariant test
 * asserts the two namespaces never collide.
 */
export type Module =
  | "OVERVIEW" | "OPERATIONS" | "COMPLAINTS" | "HOUSEKEEPING" | "LAUNDRY"
  | "PEOPLE" | "SUPPLY_CHAIN"
  | "FOOD" | "AUDITS" | "GROWTH" | "FINANCE_OPS"
  | "ACCESS" | "PLATFORM";

/**
 * A capability inside a module — the unit that is stored in
 * `role_functionalities`, carried by `privileges`, and named by every
 * `authorize()` gate in the API.
 */
export type Functionality =
  | "DASHBOARD" | "EXECUTIVE_DASHBOARD"
  | "PROPERTIES" | "RESIDENTS" | "COMMUNICATIONS"
  // Complaint Management — its own module. `COMPLAINT_TICKETS` is the queue
  // (was the flat `COMPLAINTS` key); `COMPLAINT_ROUTING` is the per-property,
  // per-category assignment table and the SLA hours, which were previously
  // reachable only through the blanket SETTINGS gate.
  | "COMPLAINT_TICKETS" | "COMPLAINT_ROUTING"
  // Laundry — its own module. Renamed from the flat `LAUNDRY` key so the module
  // key is free; it gates laundry_batches, which is the whole surface today.
  | "LAUNDRY_BATCHES"
  /**
   * Housekeeping — RESERVED, gates nothing yet.
   *
   * The module exists so roles can be configured ahead of the feature, but
   * there is no housekeeping route, screen or table in the codebase today:
   * "housekeeping" appears only as a complaint CATEGORY, a vendor/department
   * string, and the unused `rooms.housekeeping_status` column. Granting this
   * confers no capability. Wire it to real endpoints before treating it as
   * access control, and delete this note when you do.
   */
  | "HOUSEKEEPING_TASKS"
  | "EMPLOYEES" | "RECRUITMENT" | "LND"
  | "VENDORS" | "INDENTS" | "PURCHASE_ORDERS" | "GRN" | "INVENTORY"
  | "SALES_LEADS" | "SALES_DASHBOARD" | "PROPERTY_LEADS"
  | "LEDGER" | "PAYMENTS" | "WALLET"
  | "BILLING_CYCLES" | "REMINDERS" | "BANKING" | "EXPENSES"
  | "FACILITY" | "ELECTRICITY" | "RESIDENT_ATTENDANCE" | "IOT"
  | "USERS" | "SETTINGS" | "AUDIT_LOG" | "ACCESS_CONTROL"
  // Food Ordering & Kitchen Operations functionalities (PRD §5 matrix)
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
  // Audit & Inspection (PRD v1.0). These are the eight functionalities of the
  // AUDITS module. Coarse endpoint gates; fine-grained audit-type/org-node
  // truth lives in audit_role_grants (resolveAuditAccess).
  // AUDIT_LOG above is the unrelated host activity trail, and belongs to
  // PLATFORM — not to this module. The name collision is historical.
  | "AUDIT_DASHBOARD" | "AUDIT_REGISTER" | "AUDIT_EXECUTION"
  | "AUDIT_REVIEW" | "AUDIT_REPORTS" | "AUDIT_SCHEDULES"
  | "AUDIT_TEMPLATES" | "AUDIT_ADMIN";

/* ── The tree ─────────────────────────────────────────────────────────────── */

/**
 * Module → its functionalities, in the order a human should read them.
 *
 * This is the ONE declaration of the hierarchy; `FUNCTIONALITY_MODULE`,
 * `ALL_FUNCTIONALITIES` and the per-module helper lists are all derived from it
 * below, so a functionality cannot end up in two modules or in none. The
 * partition is asserted at import (see `assertPartition`) rather than only in a
 * test, because a manifest that is wrong is wrong everywhere at once.
 *
 * Ordering is load-bearing for the UI only. Nothing authorizes off it.
 */
export const MODULE_FUNCTIONALITIES: Record<Module, Functionality[]> = {
  OVERVIEW: ["DASHBOARD", "EXECUTIVE_DASHBOARD"],
  // Properties and the old "Operations" sidebar group are one module: the
  // Rooms screen was always gated on PROPERTIES, so the two groups never were
  // a clean split, and "which module is Rooms in" had two answers.
  //
  // Complaints and Laundry were lifted OUT of here into modules of their own
  // (product, 2026-09-26) — they are businesses with their own staff and their
  // own queues, not facets of estate upkeep.
  OPERATIONS: [
    "PROPERTIES", "RESIDENTS", "RESIDENT_ATTENDANCE",
    "COMMUNICATIONS", "FACILITY", "ELECTRICITY", "IOT",
  ],
  // Handling a complaint and deciding WHO it lands on are different jobs held
  // by different people — which is exactly the split a module-level grant
  // could not express, and why routing is its own functionality rather than a
  // corner of SETTINGS.
  COMPLAINTS: ["COMPLAINT_TICKETS", "COMPLAINT_ROUTING"],
  // Reserved — see HOUSEKEEPING_TASKS. One functionality, gating nothing yet.
  HOUSEKEEPING: ["HOUSEKEEPING_TASKS"],
  LAUNDRY: ["LAUNDRY_BATCHES"],
  PEOPLE: ["EMPLOYEES", "RECRUITMENT", "LND"],
  SUPPLY_CHAIN: ["VENDORS", "INDENTS", "PURCHASE_ORDERS", "GRN", "INVENTORY"],
  FOOD: [
    "FOOD_DASHBOARD", "FOOD_ALL_ORDERS", "FOOD_PLACE_ORDER",
    "FOOD_RECEIVE_UPDATE", "FOOD_DELIVERY_TRACKING", "FOOD_KITCHEN_SUMMARY",
    "FOOD_DISPATCH", "FOOD_CONFIRM_DELIVERY", "FOOD_WASTE_TRACKING",
    "FOOD_REPORTS", "FOOD_SETTINGS", "FOOD_CATALOGUE", "FOOD_ORG",
  ],
  AUDITS: [
    "AUDIT_DASHBOARD", "AUDIT_REGISTER", "AUDIT_EXECUTION", "AUDIT_REVIEW",
    "AUDIT_REPORTS", "AUDIT_SCHEDULES", "AUDIT_TEMPLATES", "AUDIT_ADMIN",
  ],
  GROWTH: ["SALES_DASHBOARD", "SALES_LEADS", "PROPERTY_LEADS"],
  // Keyed FINANCE_OPS, not FINANCE: `FINANCE` is already a UserRole, and a
  // module whose key is also a role key makes every log line and every grep
  // ambiguous about which one is meant. The label is still "Finance".
  FINANCE_OPS: [
    "LEDGER", "PAYMENTS", "WALLET", "BILLING_CYCLES",
    "REMINDERS", "BANKING", "EXPENSES",
  ],
  ACCESS: ["USERS", "ACCESS_CONTROL"],
  PLATFORM: ["SETTINGS", "AUDIT_LOG"],
};

/** Module display order — the sidebar/launcher/editor all read this. */
export const MODULE_ORDER: Module[] = [
  "OVERVIEW", "OPERATIONS", "COMPLAINTS", "HOUSEKEEPING", "LAUNDRY",
  "FOOD", "AUDITS", "FINANCE_OPS",
  "PEOPLE", "SUPPLY_CHAIN", "GROWTH", "ACCESS", "PLATFORM",
];

/** Human label for a module — what the nav section and launcher card say. */
export const MODULE_LABEL: Record<Module, string> = {
  OVERVIEW: "Overview",
  OPERATIONS: "Operations",
  COMPLAINTS: "Complaint Management",
  HOUSEKEEPING: "Housekeeping",
  LAUNDRY: "Laundry",
  PEOPLE: "People",
  SUPPLY_CHAIN: "Supply Chain",
  FOOD: "Food & Kitchen",
  AUDITS: "Audits & Inspection",
  GROWTH: "Growth",
  FINANCE_OPS: "Finance",
  ACCESS: "User & Access Management",
  PLATFORM: "Platform",
};

/** One line on what the module is for — the launcher card's subtitle. */
export const MODULE_DESCRIPTION: Record<Module, string> = {
  OVERVIEW: "Company-wide dashboards",
  OPERATIONS: "Properties, residents and facilities",
  COMPLAINTS: "Resident complaints, routing and SLAs",
  HOUSEKEEPING: "Room cleaning and upkeep",
  LAUNDRY: "Laundry batches and collection",
  PEOPLE: "Employees, hiring and learning",
  SUPPLY_CHAIN: "Vendors, indents, purchase orders and stock",
  FOOD: "Ordering, kitchen operations and dispatch",
  AUDITS: "Inspections, review and audit reporting",
  GROWTH: "Sales pipeline and property acquisition",
  FINANCE_OPS: "Ledger, payments, billing and banking",
  ACCESS: "Users, roles and permissions",
  PLATFORM: "Configuration and the activity trail",
};

/**
 * Visual identity per module — icon and colour.
 *
 * Keyed by the module KEY, never by its label. The launcher previously keyed
 * these off the nav group's display title, so renaming "Food" to "Food & Kitchen"
 * silently dropped every lookup to the fallback and rendered all ten cards with
 * the same grey grid glyph. A key cannot drift from itself.
 *
 * The icon is a NAME, not a component: this module is imported by the API and
 * by the parity test, which asserts it stays dependency-free (a `require` here
 * is a tripwire). The web maps the name to a lucide component in one place, so
 * an unknown name degrades to a default glyph rather than failing the build.
 */
export const MODULE_ICON: Record<Module, string> = {
  OVERVIEW: "LayoutDashboard",
  OPERATIONS: "Building2",
  COMPLAINTS: "MessageSquareWarning",
  HOUSEKEEPING: "Sparkles",
  LAUNDRY: "WashingMachine",
  FOOD: "UtensilsCrossed",
  AUDITS: "ClipboardCheck",
  FINANCE_OPS: "Landmark",
  PEOPLE: "Users",
  SUPPLY_CHAIN: "Truck",
  GROWTH: "TrendingUp",
  ACCESS: "ShieldCheck",
  PLATFORM: "Settings",
};

/**
 * Gradient identity per module: [iconFrom, iconTo, cardTint, cardTint2].
 *
 * Distinct hues, ordered so no two ADJACENT cards in MODULE_ORDER share a
 * family — the launcher renders them in that order, and neighbours are what a
 * reader actually compares. Food and Audits keep the design prototype's exact
 * pairs; the rest continue the same vivid language.
 */
export const MODULE_TINT: Record<Module, [string, string, string, string]> = {
  OVERVIEW:     ["#3666CF", "#6FA0F0", "#6FA0F0", "#7C5CFF"],
  OPERATIONS:   ["#0F766E", "#14B8A6", "#14B8A6", "#0891B2"],
  COMPLAINTS:   ["#E11D48", "#FB7185", "#FB7185", "#F2603C"],
  HOUSEKEEPING: ["#0284C7", "#38BDF8", "#38BDF8", "#0EA5A5"],
  LAUNDRY:      ["#4338CA", "#6366F1", "#6366F1", "#7C5CFF"],
  FOOD:         ["#FF9A3D", "#F2603C", "#FF9A3D", "#C2459A"],
  AUDITS:       ["#7C5CFF", "#C2459A", "#9B82FF", "#C2459A"],
  FINANCE_OPS:  ["#157F5B", "#34A57F", "#34A57F", "#3666CF"],
  PEOPLE:       ["#E85D75", "#C2459A", "#E85D75", "#C2459A"],
  SUPPLY_CHAIN: ["#D97706", "#E5A13D", "#E5A13D", "#E8602C"],
  GROWTH:       ["#22C55E", "#86EFAC", "#4ADE80", "#0EA5A5"],
  ACCESS:       ["#334155", "#64748B", "#64748B", "#3666CF"],
  PLATFORM:     ["#8B7D72", "#5C5049", "#8B7D72", "#5C5049"],
};

/** All modules, in display order. */
export const ALL_MODULES: Module[] = [...MODULE_ORDER];

/**
 * Functionality → the module that owns it. Derived, so it cannot disagree with
 * `MODULE_FUNCTIONALITIES`.
 */
export const FUNCTIONALITY_MODULE: Record<Functionality, Module> = (() => {
  const out = {} as Record<Functionality, Module>;
  for (const m of MODULE_ORDER) for (const f of MODULE_FUNCTIONALITIES[m]) out[f] = m;
  return out;
})();

/** Every functionality, grouped by module and in display order. */
export const ALL_FUNCTIONALITIES: Functionality[] =
  MODULE_ORDER.flatMap((m) => MODULE_FUNCTIONALITIES[m]);

/**
 * The tree is a PARTITION: every functionality belongs to exactly one module,
 * `MODULE_ORDER` covers every module, and no module key is also a functionality
 * key. Checked at import because all three are static data whose breakage would
 * otherwise show up as a silently missing row in the role editor.
 */
function assertPartition(): void {
  const missingOrder = (Object.keys(MODULE_FUNCTIONALITIES) as Module[])
    .filter((m) => !MODULE_ORDER.includes(m));
  if (missingOrder.length) {
    throw new Error(`MODULE_ORDER is missing: ${missingOrder.join(", ")}`);
  }
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const m of MODULE_ORDER) {
    for (const f of MODULE_FUNCTIONALITIES[m]) {
      if (seen.has(f)) dupes.push(f);
      seen.add(f);
    }
  }
  if (dupes.length) {
    throw new Error(`Functionality in more than one module: ${dupes.join(", ")}`);
  }
  const collisions = MODULE_ORDER.filter((m) => seen.has(m));
  if (collisions.length) {
    throw new Error(
      `Module key is also a functionality key: ${collisions.join(", ")} — ` +
      `the two namespaces must stay disjoint so a bare key is never ambiguous.`,
    );
  }
}
assertPartition();

/** The module a functionality belongs to. */
export function moduleOf(functionality: Functionality): Module {
  return FUNCTIONALITY_MODULE[functionality];
}

/** The functionalities of a module, in display order. */
export function functionalitiesOf(module: Module): Functionality[] {
  return MODULE_FUNCTIONALITIES[module] ?? [];
}

/** Narrowing helpers for values that arrive as strings (HTTP, database rows). */
export function isModule(x: string): x is Module {
  return (MODULE_ORDER as readonly string[]).includes(x);
}
export function isFunctionality(x: string): x is Functionality {
  return x in FUNCTIONALITY_MODULE;
}

/** Every functionality of the FOOD module — for roles granted the lot. */
export const FOOD_FUNCTIONALITIES: Functionality[] = functionalitiesOf("FOOD");
/** Every functionality of the AUDITS module. */
export const AUDIT_FUNCTIONALITIES: Functionality[] = functionalitiesOf("AUDITS");

/* ── Actions per functionality ────────────────────────────────────────────── */

export interface ActionDef {
  /** Unique within its functionality. The last segment of the permission id. */
  key: string;
  label: string;
  /** One line, shown wherever this access is granted, listed or explained. */
  description: string;
}

export const FUNCTIONALITY_ACTIONS: Record<Functionality, readonly ActionDef[]> = {
  DASHBOARD: [
    { key: "view_dashboard", label: "View dashboard", description: "Open the operations dashboard" },
    { key: "export_dashboard", label: "Export dashboard", description: "Download the dashboard figures" },
  ],
  EXECUTIVE_DASHBOARD: [
    { key: "view_executive_dashboard", label: "View executive dashboard", description: "Open the company-wide dashboard" },
    { key: "export_executive_dashboard", label: "Export executive dashboard", description: "Download the executive figures" },
  ],
  PROPERTIES: [
    { key: "view_property", label: "View property", description: "Open and read a property" },
    { key: "add_property", label: "Add property", description: "Create a new property" },
    { key: "edit_property", label: "Edit property", description: "Change an existing property" },
    { key: "delete_property", label: "Delete property", description: "Remove a property for good" },
  ],
  RESIDENTS: [
    { key: "view_resident", label: "View resident", description: "Open and read a resident" },
    { key: "add_resident", label: "Add resident", description: "Create a new resident" },
    { key: "edit_resident", label: "Edit resident", description: "Change an existing resident" },
    { key: "delete_resident", label: "Delete resident", description: "Remove a resident for good" },
    { key: "export_resident", label: "Export resident", description: "Download resident records as a spreadsheet" },
  ],
  RESIDENT_ATTENDANCE: [
    { key: "view_resident_attendance", label: "View resident attendance", description: "Open and read a resident attendance" },
    { key: "add_resident_attendance", label: "Add resident attendance", description: "Create a new resident attendance" },
    { key: "edit_resident_attendance", label: "Edit resident attendance", description: "Change an existing resident attendance" },
    { key: "delete_resident_attendance", label: "Delete resident attendance", description: "Remove a resident attendance for good" },
  ],
  COMMUNICATIONS: [
    { key: "view_communication", label: "View communication", description: "Open and read a communication" },
    { key: "add_communication", label: "Add communication", description: "Create a new communication" },
    { key: "edit_communication", label: "Edit communication", description: "Change an existing communication" },
    { key: "delete_communication", label: "Delete communication", description: "Remove a communication for good" },
  ],
  FACILITY: [
    { key: "view_facility", label: "View facility", description: "Open and read a facility" },
    { key: "add_facility", label: "Add facility", description: "Create a new facility" },
    { key: "edit_facility", label: "Edit facility", description: "Change an existing facility" },
    { key: "delete_facility", label: "Delete facility", description: "Remove a facility for good" },
  ],
  ELECTRICITY: [
    { key: "view_electricity", label: "View electricity", description: "Open and read an electricity" },
    { key: "add_electricity", label: "Add electricity", description: "Create a new electricity" },
    { key: "edit_electricity", label: "Edit electricity", description: "Change an existing electricity" },
    { key: "delete_electricity", label: "Delete electricity", description: "Remove an electricity for good" },
  ],
  IOT: [
    { key: "view_iot", label: "View iot", description: "Open and read an iot" },
    { key: "add_iot", label: "Add iot", description: "Create a new iot" },
    { key: "edit_iot", label: "Edit iot", description: "Change an existing iot" },
    { key: "delete_iot", label: "Delete iot", description: "Remove an iot for good" },
  ],
  COMPLAINT_TICKETS: [
    { key: "view_complaint", label: "View complaint", description: "Open and read a complaint" },
    { key: "add_complaint", label: "Add complaint", description: "Create a new complaint" },
    { key: "edit_complaint", label: "Edit complaint", description: "Change an existing complaint" },
    { key: "delete_complaint", label: "Delete complaint", description: "Remove a complaint for good" },
    { key: "assign_complaint", label: "Assign complaint", description: "Hand a complaint to somebody" },
    { key: "close_complaint", label: "Close complaint", description: "Mark a complaint as done" },
    { key: "verify_complaint", label: "Verify complaint", description: "Confirm a complaint is correct" },
  ],
  COMPLAINT_ROUTING: [
    { key: "view_routing_sla", label: "View routing & sla", description: "Open and read a routing & sla" },
    { key: "add_routing_sla", label: "Add routing & sla", description: "Create a new routing & sla" },
    { key: "edit_routing_sla", label: "Edit routing & sla", description: "Change an existing routing & sla" },
    { key: "delete_routing_sla", label: "Delete routing & sla", description: "Remove a routing & sla for good" },
    { key: "configure_routing_sla", label: "Configure routing & sla", description: "Change how routing & sla is set up" },
  ],
  HOUSEKEEPING_TASKS: [
    { key: "view_housekeeping_task", label: "View housekeeping task", description: "Open and read a housekeeping task" },
    { key: "add_housekeeping_task", label: "Add housekeeping task", description: "Create a new housekeeping task" },
    { key: "edit_housekeeping_task", label: "Edit housekeeping task", description: "Change an existing housekeeping task" },
    { key: "delete_housekeeping_task", label: "Delete housekeeping task", description: "Remove a housekeeping task for good" },
  ],
  LAUNDRY_BATCHES: [
    { key: "view_laundry_batche", label: "View laundry batche", description: "Open and read a laundry batche" },
    { key: "add_laundry_batche", label: "Add laundry batche", description: "Create a new laundry batche" },
    { key: "edit_laundry_batche", label: "Edit laundry batche", description: "Change an existing laundry batche" },
    { key: "delete_laundry_batche", label: "Delete laundry batche", description: "Remove a laundry batche for good" },
  ],
  FOOD_DASHBOARD: [
    { key: "view_food_dashboard", label: "View food dashboard", description: "Open the food operations dashboard" },
    { key: "export_food_dashboard", label: "Export food dashboard", description: "Download the food figures" },
  ],
  FOOD_ALL_ORDERS: [
    { key: "view_order", label: "View order", description: "Open and read an order" },
    { key: "add_order", label: "Add order", description: "Create a new order" },
    { key: "edit_order", label: "Edit order", description: "Change an existing order" },
    { key: "delete_order", label: "Delete order", description: "Remove an order for good" },
  ],
  FOOD_PLACE_ORDER: [
    { key: "view_order_form", label: "View order form", description: "Open the ordering screen" },
    { key: "draft_order", label: "Draft order", description: "Start an order for a property" },
    { key: "edit_order", label: "Edit order", description: "Change an order before it is sent" },
    { key: "cancel_draft", label: "Cancel draft", description: "Throw away an unsent order" },
    { key: "place_order", label: "Place order", description: "Send an order to the kitchen" },
  ],
  FOOD_RECEIVE_UPDATE: [
    { key: "view_receive_update", label: "View receive & update", description: "Open and read a receive & update" },
    { key: "add_receive_update", label: "Add receive & update", description: "Create a new receive & update" },
    { key: "edit_receive_update", label: "Edit receive & update", description: "Change an existing receive & update" },
    { key: "delete_receive_update", label: "Delete receive & update", description: "Remove a receive & update for good" },
  ],
  FOOD_DELIVERY_TRACKING: [
    { key: "view_delivery_tracking", label: "View delivery tracking", description: "Open and read a delivery tracking" },
    { key: "add_delivery_tracking", label: "Add delivery tracking", description: "Create a new delivery tracking" },
    { key: "edit_delivery_tracking", label: "Edit delivery tracking", description: "Change an existing delivery tracking" },
    { key: "delete_delivery_tracking", label: "Delete delivery tracking", description: "Remove a delivery tracking for good" },
  ],
  FOOD_KITCHEN_SUMMARY: [
    { key: "view_kitchen_summary", label: "View kitchen summary", description: "Open and read a kitchen summary" },
    { key: "add_kitchen_summary", label: "Add kitchen summary", description: "Create a new kitchen summary" },
    { key: "edit_kitchen_summary", label: "Edit kitchen summary", description: "Change an existing kitchen summary" },
    { key: "delete_kitchen_summary", label: "Delete kitchen summary", description: "Remove a kitchen summary for good" },
  ],
  FOOD_DISPATCH: [
    { key: "view_dispatch_queue", label: "View dispatch queue", description: "See what is waiting to go out" },
    { key: "edit_dispatch", label: "Edit dispatch", description: "Change a dispatch before it leaves" },
    { key: "assign_rider", label: "Assign rider", description: "Give a dispatch to a rider" },
    { key: "mark_dispatched", label: "Mark dispatched", description: "Record that an order has left the kitchen" },
  ],
  FOOD_CONFIRM_DELIVERY: [
    { key: "view_deliveries", label: "View deliveries", description: "See what has been delivered" },
    { key: "amend_delivery", label: "Amend delivery", description: "Correct a delivery record" },
    { key: "confirm_receipt", label: "Confirm receipt", description: "Confirm an order actually arrived" },
  ],
  FOOD_WASTE_TRACKING: [
    { key: "view_waste_tracking", label: "View waste tracking", description: "Open and read a waste tracking" },
    { key: "add_waste_tracking", label: "Add waste tracking", description: "Create a new waste tracking" },
    { key: "edit_waste_tracking", label: "Edit waste tracking", description: "Change an existing waste tracking" },
    { key: "delete_waste_tracking", label: "Delete waste tracking", description: "Remove a waste tracking for good" },
  ],
  FOOD_REPORTS: [
    { key: "view_food_report", label: "View food report", description: "Open and read a food report" },
    { key: "add_food_report", label: "Add food report", description: "Create a new food report" },
    { key: "edit_food_report", label: "Edit food report", description: "Change an existing food report" },
    { key: "delete_food_report", label: "Delete food report", description: "Remove a food report for good" },
    { key: "export_food_report", label: "Export food report", description: "Download food report records as a spreadsheet" },
    { key: "download_food_report", label: "Download food report", description: "Download food report files" },
  ],
  FOOD_SETTINGS: [
    { key: "view_food_setting", label: "View food setting", description: "Open and read a food setting" },
    { key: "add_food_setting", label: "Add food setting", description: "Create a new food setting" },
    { key: "edit_food_setting", label: "Edit food setting", description: "Change an existing food setting" },
    { key: "delete_food_setting", label: "Delete food setting", description: "Remove a food setting for good" },
    { key: "configure_food_setting", label: "Configure food setting", description: "Change how food setting is set up" },
  ],
  FOOD_CATALOGUE: [
    { key: "view_service_catalogue", label: "View service catalogue", description: "Open and read a service catalogue" },
    { key: "add_service_catalogue", label: "Add service catalogue", description: "Create a new service catalogue" },
    { key: "edit_service_catalogue", label: "Edit service catalogue", description: "Change an existing service catalogue" },
    { key: "delete_service_catalogue", label: "Delete service catalogue", description: "Remove a service catalogue for good" },
  ],
  FOOD_ORG: [
    { key: "view_kitchen_org", label: "View kitchen org", description: "Open and read a kitchen org" },
    { key: "add_kitchen_org", label: "Add kitchen org", description: "Create a new kitchen org" },
    { key: "edit_kitchen_org", label: "Edit kitchen org", description: "Change an existing kitchen org" },
    { key: "delete_kitchen_org", label: "Delete kitchen org", description: "Remove a kitchen org for good" },
  ],
  AUDIT_DASHBOARD: [
    { key: "view_audit_dashboard", label: "View audit dashboard", description: "Open the audit dashboard" },
    { key: "export_audit_dashboard", label: "Export audit dashboard", description: "Download the audit figures" },
  ],
  AUDIT_REGISTER: [
    { key: "view_audit_register", label: "View audit register", description: "Open and read an audit register" },
    { key: "add_audit_register", label: "Add audit register", description: "Create a new audit register" },
    { key: "edit_audit_register", label: "Edit audit register", description: "Change an existing audit register" },
    { key: "delete_audit_register", label: "Delete audit register", description: "Remove an audit register for good" },
  ],
  AUDIT_EXECUTION: [
    { key: "view_audit", label: "View audit", description: "Open an audit and read its answers" },
    { key: "start_audit", label: "Start audit", description: "Begin conducting a scheduled audit" },
    { key: "record_answers", label: "Record answers", description: "Fill in an audit while conducting it" },
    { key: "discard_audit", label: "Discard audit", description: "Throw away an audit in progress" },
    { key: "submit_audit", label: "Submit audit", description: "Send a finished audit for review" },
    { key: "close_audit", label: "Close audit", description: "Mark an audit as finished" },
    { key: "reassign_audit", label: "Reassign audit", description: "Hand an audit to another auditor" },
  ],
  AUDIT_REVIEW: [
    { key: "view_review_queue", label: "View review queue", description: "See audits waiting to be reviewed" },
    { key: "annotate_review", label: "Annotate review", description: "Leave notes on an audit under review" },
    { key: "approve_audit", label: "Approve audit", description: "Sign off an audit as accepted" },
    { key: "reject_audit", label: "Reject audit", description: "Send an audit back to the auditor" },
    { key: "verify_evidence", label: "Verify evidence", description: "Confirm the attached evidence is genuine" },
  ],
  AUDIT_REPORTS: [
    { key: "view_audit_report", label: "View audit report", description: "Open and read an audit report" },
    { key: "add_audit_report", label: "Add audit report", description: "Create a new audit report" },
    { key: "edit_audit_report", label: "Edit audit report", description: "Change an existing audit report" },
    { key: "delete_audit_report", label: "Delete audit report", description: "Remove an audit report for good" },
    { key: "export_audit_report", label: "Export audit report", description: "Download audit report records as a spreadsheet" },
    { key: "download_audit_report", label: "Download audit report", description: "Download audit report files" },
    { key: "configure_audit_report", label: "Configure audit report", description: "Change how audit report is set up" },
  ],
  AUDIT_SCHEDULES: [
    { key: "view_schedule", label: "View schedule", description: "Open and read a schedule" },
    { key: "add_schedule", label: "Add schedule", description: "Create a new schedule" },
    { key: "edit_schedule", label: "Edit schedule", description: "Change an existing schedule" },
    { key: "delete_schedule", label: "Delete schedule", description: "Remove a schedule for good" },
    { key: "assign_schedule", label: "Assign schedule", description: "Hand a schedule to somebody" },
    { key: "configure_schedule", label: "Configure schedule", description: "Change how schedule is set up" },
  ],
  AUDIT_TEMPLATES: [
    { key: "view_template", label: "View template", description: "Open and read a template" },
    { key: "add_template", label: "Add template", description: "Create a new template" },
    { key: "edit_template", label: "Edit template", description: "Change an existing template" },
    { key: "delete_template", label: "Delete template", description: "Remove a template for good" },
    { key: "configure_template", label: "Configure template", description: "Change how template is set up" },
  ],
  AUDIT_ADMIN: [
    { key: "view_audit_admin", label: "View audit admin", description: "Open and read an audit admin" },
    { key: "add_audit_admin", label: "Add audit admin", description: "Create a new audit admin" },
    { key: "edit_audit_admin", label: "Edit audit admin", description: "Change an existing audit admin" },
    { key: "delete_audit_admin", label: "Delete audit admin", description: "Remove an audit admin for good" },
    { key: "configure_audit_admin", label: "Configure audit admin", description: "Change how audit admin is set up" },
  ],
  LEDGER: [
    { key: "view_ledger", label: "View ledger", description: "Open and read a ledger" },
    { key: "add_ledger", label: "Add ledger", description: "Create a new ledger" },
    { key: "edit_ledger", label: "Edit ledger", description: "Change an existing ledger" },
    { key: "delete_ledger", label: "Delete ledger", description: "Remove a ledger for good" },
  ],
  PAYMENTS: [
    { key: "view_payment", label: "View payment", description: "Open and read a payment" },
    { key: "add_payment", label: "Add payment", description: "Create a new payment" },
    { key: "edit_payment", label: "Edit payment", description: "Change an existing payment" },
    { key: "delete_payment", label: "Delete payment", description: "Remove a payment for good" },
    { key: "approve_payment", label: "Approve payment", description: "Approve a payment someone else submitted" },
    { key: "verify_payment", label: "Verify payment", description: "Confirm a payment is correct" },
  ],
  WALLET: [
    { key: "view_wallet", label: "View wallet", description: "Open and read a wallet" },
    { key: "add_wallet", label: "Add wallet", description: "Create a new wallet" },
    { key: "edit_wallet", label: "Edit wallet", description: "Change an existing wallet" },
    { key: "delete_wallet", label: "Delete wallet", description: "Remove a wallet for good" },
    { key: "approve_wallet", label: "Approve wallet", description: "Approve a wallet someone else submitted" },
    { key: "verify_wallet", label: "Verify wallet", description: "Confirm a wallet is correct" },
  ],
  BILLING_CYCLES: [
    { key: "view_recurring_billing", label: "View recurring billing", description: "Open and read a recurring billing" },
    { key: "add_recurring_billing", label: "Add recurring billing", description: "Create a new recurring billing" },
    { key: "edit_recurring_billing", label: "Edit recurring billing", description: "Change an existing recurring billing" },
    { key: "delete_recurring_billing", label: "Delete recurring billing", description: "Remove a recurring billing for good" },
  ],
  REMINDERS: [
    { key: "view_reminder", label: "View reminder", description: "Open and read a reminder" },
    { key: "add_reminder", label: "Add reminder", description: "Create a new reminder" },
    { key: "edit_reminder", label: "Edit reminder", description: "Change an existing reminder" },
    { key: "delete_reminder", label: "Delete reminder", description: "Remove a reminder for good" },
  ],
  BANKING: [
    { key: "view_banking", label: "View banking", description: "Open and read a banking" },
    { key: "add_banking", label: "Add banking", description: "Create a new banking" },
    { key: "edit_banking", label: "Edit banking", description: "Change an existing banking" },
    { key: "delete_banking", label: "Delete banking", description: "Remove a banking for good" },
  ],
  EXPENSES: [
    { key: "view_expense", label: "View expense", description: "Open and read an expense" },
    { key: "add_expense", label: "Add expense", description: "Create a new expense" },
    { key: "edit_expense", label: "Edit expense", description: "Change an existing expense" },
    { key: "delete_expense", label: "Delete expense", description: "Remove an expense for good" },
    { key: "submit_expense", label: "Submit expense", description: "Send an expense for approval" },
    { key: "approve_expense", label: "Approve expense", description: "Approve an expense someone else submitted" },
    { key: "reject_expense", label: "Reject expense", description: "Send an expense back with a note" },
  ],
  EMPLOYEES: [
    { key: "view_employee", label: "View employee", description: "Open and read an employee" },
    { key: "add_employee", label: "Add employee", description: "Create a new employee" },
    { key: "edit_employee", label: "Edit employee", description: "Change an existing employee" },
    { key: "delete_employee", label: "Delete employee", description: "Remove an employee for good" },
    { key: "approve_employee", label: "Approve employee", description: "Approve an employee someone else submitted" },
    { key: "reject_employee", label: "Reject employee", description: "Send an employee back with a note" },
    { key: "export_employee", label: "Export employee", description: "Download employee records as a spreadsheet" },
  ],
  RECRUITMENT: [
    { key: "view_recruitment", label: "View recruitment", description: "Open and read a recruitment" },
    { key: "add_recruitment", label: "Add recruitment", description: "Create a new recruitment" },
    { key: "edit_recruitment", label: "Edit recruitment", description: "Change an existing recruitment" },
    { key: "delete_recruitment", label: "Delete recruitment", description: "Remove a recruitment for good" },
    { key: "approve_recruitment", label: "Approve recruitment", description: "Approve a recruitment someone else submitted" },
    { key: "reject_recruitment", label: "Reject recruitment", description: "Send a recruitment back with a note" },
  ],
  LND: [
    { key: "view_learning_development", label: "View learning & development", description: "Open and read a learning & development" },
    { key: "add_learning_development", label: "Add learning & development", description: "Create a new learning & development" },
    { key: "edit_learning_development", label: "Edit learning & development", description: "Change an existing learning & development" },
    { key: "delete_learning_development", label: "Delete learning & development", description: "Remove a learning & development for good" },
  ],
  VENDORS: [
    { key: "view_vendor", label: "View vendor", description: "Open and read a vendor" },
    { key: "add_vendor", label: "Add vendor", description: "Create a new vendor" },
    { key: "edit_vendor", label: "Edit vendor", description: "Change an existing vendor" },
    { key: "delete_vendor", label: "Delete vendor", description: "Remove a vendor for good" },
  ],
  INDENTS: [
    { key: "view_indent", label: "View indent", description: "Open and read an indent" },
    { key: "add_indent", label: "Add indent", description: "Create a new indent" },
    { key: "edit_indent", label: "Edit indent", description: "Change an existing indent" },
    { key: "delete_indent", label: "Delete indent", description: "Remove an indent for good" },
    { key: "submit_indent", label: "Submit indent", description: "Send an indent for approval" },
    { key: "approve_indent", label: "Approve indent", description: "Approve an indent someone else submitted" },
    { key: "reject_indent", label: "Reject indent", description: "Send an indent back with a note" },
  ],
  PURCHASE_ORDERS: [
    { key: "view_purchase_order", label: "View purchase order", description: "Open and read a purchase order" },
    { key: "add_purchase_order", label: "Add purchase order", description: "Create a new purchase order" },
    { key: "edit_purchase_order", label: "Edit purchase order", description: "Change an existing purchase order" },
    { key: "delete_purchase_order", label: "Delete purchase order", description: "Remove a purchase order for good" },
    { key: "submit_purchase_order", label: "Submit purchase order", description: "Send a purchase order for approval" },
    { key: "approve_purchase_order", label: "Approve purchase order", description: "Approve a purchase order someone else submitted" },
    { key: "reject_purchase_order", label: "Reject purchase order", description: "Send a purchase order back with a note" },
  ],
  GRN: [
    { key: "view_goods_received", label: "View goods received", description: "Open and read a goods received" },
    { key: "add_goods_received", label: "Add goods received", description: "Create a new goods received" },
    { key: "edit_goods_received", label: "Edit goods received", description: "Change an existing goods received" },
    { key: "delete_goods_received", label: "Delete goods received", description: "Remove a goods received for good" },
  ],
  INVENTORY: [
    { key: "view_inventory", label: "View inventory", description: "Open and read an inventory" },
    { key: "add_inventory", label: "Add inventory", description: "Create a new inventory" },
    { key: "edit_inventory", label: "Edit inventory", description: "Change an existing inventory" },
    { key: "delete_inventory", label: "Delete inventory", description: "Remove an inventory for good" },
  ],
  SALES_DASHBOARD: [
    { key: "view_sales_dashboard", label: "View sales dashboard", description: "Open the sales dashboard" },
    { key: "export_sales_dashboard", label: "Export sales dashboard", description: "Download the sales figures" },
  ],
  SALES_LEADS: [
    { key: "view_sales_crm", label: "View sales crm", description: "Open and read a sales crm" },
    { key: "add_sales_crm", label: "Add sales crm", description: "Create a new sales crm" },
    { key: "edit_sales_crm", label: "Edit sales crm", description: "Change an existing sales crm" },
    { key: "delete_sales_crm", label: "Delete sales crm", description: "Remove a sales crm for good" },
  ],
  PROPERTY_LEADS: [
    { key: "view_property_lead", label: "View property lead", description: "Open and read a property lead" },
    { key: "add_property_lead", label: "Add property lead", description: "Create a new property lead" },
    { key: "edit_property_lead", label: "Edit property lead", description: "Change an existing property lead" },
    { key: "delete_property_lead", label: "Delete property lead", description: "Remove a property lead for good" },
  ],
  USERS: [
    { key: "view_user", label: "View user", description: "Open and read an user" },
    { key: "add_user", label: "Add user", description: "Create a new user" },
    { key: "edit_user", label: "Edit user", description: "Change an existing user" },
    { key: "delete_user", label: "Delete user", description: "Remove an user for good" },
    { key: "configure_user", label: "Configure user", description: "Change how user is set up" },
  ],
  ACCESS_CONTROL: [
    { key: "view_access", label: "View access", description: "See roles, privileges and who holds what" },
    { key: "grant_access", label: "Grant access", description: "Give somebody a role or a privilege" },
    { key: "change_access", label: "Change access", description: "Alter what a role or person may do" },
    { key: "revoke_access", label: "Revoke access", description: "Take a role or privilege away" },
    { key: "administer_access", label: "Administer access", description: "Change the access model itself" },
  ],
  SETTINGS: [
    { key: "view_setting", label: "View setting", description: "Open and read a setting" },
    { key: "add_setting", label: "Add setting", description: "Create a new setting" },
    { key: "edit_setting", label: "Edit setting", description: "Change an existing setting" },
    { key: "delete_setting", label: "Delete setting", description: "Remove a setting for good" },
    { key: "configure_setting", label: "Configure setting", description: "Change how setting is set up" },
  ],
  AUDIT_LOG: [
    { key: "view_activity", label: "View activity", description: "Read the record of who changed what" },
    { key: "export_activity", label: "Export activity", description: "Download the activity trail" },
  ],
};

/** Every named action of a functionality. */
/**
 * Every named action in the manifest, as one union.
 *
 * Use `ActionOf<F>` instead wherever the functionality is known statically —
 * this flat union permits `authorize("PROPERTIES", "submit_audit")`, which is
 * nonsense the per-functionality type rejects at compile time.
 */
export type NamedAction =
  (typeof FUNCTIONALITY_ACTIONS)[Functionality][number]["key"];

/**
 * The named actions THIS functionality defines — the GCP-style guarantee.
 *
 * `authorize("PROPERTIES", "add_property")` compiles; `"add_resident"` does
 * not, because a permission id is one thing, not a noun and a verb that happen
 * to sit next to each other.
 */
export type ActionOf<F extends Functionality> =
  (typeof FUNCTIONALITY_ACTIONS)[F][number]["key"];

/** @deprecated Use `NamedAction` directly. */
/** @deprecated Use `NamedAction`. Kept as an alias while call sites settle. */
export type AnyAction = NamedAction;

export function namedActionsFor(functionality: Functionality): readonly ActionDef[] {
  return FUNCTIONALITY_ACTIONS[functionality] ?? [];
}

/** One named action of this functionality, or undefined if it declares none such. */
export function actionDef(functionality: Functionality, action: string): ActionDef | undefined {
  return namedActionsFor(functionality).find((d) => d.key === action);
}

/**
 * The action that means "see this" — the FIRST one a functionality declares.
 *
 * Position, not a flag or a naming convention. Every functionality has exactly
 * one read and it is written first, which a guard test asserts; anything else
 * (a `read: true` field, or matching on a `view_` prefix) would be a second
 * source of truth that can disagree with the list itself.
 *
 * It matters because you cannot do anything to a thing you cannot see: the VIEW
 * level and the read-implication both resolve through this.
 */
export function readActionOf(functionality: Functionality): string | undefined {
  return namedActionsFor(functionality)[0]?.key;
}

/** `module.functionality.action` — the identifier, using the NAMED action. */
export function permissionName(functionality: Functionality, action: string): string {
  const def = actionDef(functionality, action);
  return [moduleOf(functionality), functionality, def?.key ?? action]
    .map((s) => s.toLowerCase())
    .join(".");
}

/** Human label for a functionality — the UI leads with this, key as mono subtext. */
export const FUNCTIONALITY_LABEL: Partial<Record<Functionality, string>> = {
  EXECUTIVE_DASHBOARD: "Executive dashboard", RESIDENT_ATTENDANCE: "Resident attendance",
  COMPLAINT_TICKETS: "Complaints", COMPLAINT_ROUTING: "Routing & SLA",
  LAUNDRY_BATCHES: "Laundry batches", HOUSEKEEPING_TASKS: "Housekeeping tasks",
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

export function functionalityLabel(f: Functionality): string {
  return FUNCTIONALITY_LABEL[f] ?? f.charAt(0) + f.slice(1).toLowerCase().replace(/_/g, " ");
}

export function moduleLabel(m: Module): string {
  return MODULE_LABEL[m] ?? m.charAt(0) + m.slice(1).toLowerCase().replace(/_/g, " ");
}

/** "Audits & Inspection › Audit register" — for a 403 body or a trail entry. */
export function functionalityPath(f: Functionality): string {
  return `${moduleLabel(moduleOf(f))} › ${functionalityLabel(f)}`;
}

/**
 * What a role holds on one functionality.
 *
 * `FULL` and `VIEW` are LEVELS, expanded through the manifest — not verb sets.
 * That distinction is the whole reason the matrix survived the rename intact:
 * `EMPLOYEES: FULL` means "everything Employees declares", so a functionality
 * that gains an action tomorrow gives it to every FULL holder without anyone
 * editing 330 cells, and one that never had a sensible `delete` never had to
 * pretend otherwise.
 *
 * An explicit list is the escape hatch for the handful of cells that are
 * genuinely partial — "read and submit, but not approve your own". It names the
 * actions, so it reads as the permissions it grants rather than as booleans
 * against four verbs.
 */
export type Cell = "FULL" | "VIEW" | readonly string[];

/** The named actions a cell grants on `functionality`. */
export function expandCell(functionality: Functionality, cell: Cell): string[] {
  if (cell === "FULL") return namedActionsFor(functionality).map((d) => d.key);
  if (cell === "VIEW") {
    const read = readActionOf(functionality);
    return read ? [read] : [];
  }
  // An explicit list is still held to the manifest: a typo grants nothing
  // rather than creating a permission by writing it down.
  return cell.filter((a) => actionDef(functionality, a) != null);
}

const FULL = "FULL" as const;
const VIEW = "VIEW" as const;
/** PRD legend "V·E" (View & Edit). Everything the functionality declares. */
const VE = FULL;

type RoleMatrix = Partial<Record<Functionality, Cell>>;

export const ROLE_PERMISSIONS: Record<UserRole, RoleMatrix> = {
  // Break-glass parity role: deliberately holds BOTH FOOD_DISPATCH:edit and
  // FOOD_CONFIRM_DELIVERY:edit. Every operational role keeps those two apart
  // (see the separation-of-duties note on the kitchen roles below).
  SUPER_ADMIN: Object.fromEntries(ALL_FUNCTIONALITIES.map(m => [m, FULL])) as RoleMatrix,
  // COMPLAINT_ROUTING mirrors this role's SETTINGS level, because the routing
  // and SLA endpoints used to be gated on SETTINGS and moving them must not
  // change who can reach them. Dropping it is a product call, not a refactor.
  HR_MANAGER: { DASHBOARD: VIEW, EMPLOYEES: FULL, RECRUITMENT: FULL, LND: FULL, USERS: FULL, SETTINGS: VIEW, COMPLAINT_ROUTING: VIEW },
  OPERATIONS_MANAGER: { DASHBOARD: VIEW, PROPERTIES: FULL, RESIDENTS: FULL, COMPLAINT_TICKETS: FULL, LAUNDRY_BATCHES: FULL, COMMUNICATIONS: FULL, FACILITY: FULL, ELECTRICITY: FULL, RESIDENT_ATTENDANCE: FULL, IOT: FULL, WALLET: VIEW },
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
  WARDEN: { DASHBOARD: VIEW, PROPERTIES: VIEW, RESIDENTS: FULL, COMPLAINT_TICKETS: FULL, LAUNDRY_BATCHES: FULL, COMMUNICATIONS: ["view_communication", "add_communication"], RESIDENT_ATTENDANCE: FULL, FACILITY: VIEW, ELECTRICITY: VIEW, IOT: VIEW, WALLET: VIEW },
  VENDOR_RESTRICTED: { DASHBOARD: VIEW },
  AUDIT_READONLY: Object.fromEntries(ALL_FUNCTIONALITIES.map(m => [m, VIEW])) as RoleMatrix,

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
  // gets 403 on /zones, /agencies and /scopes. This functionality gates the org spine
  // itself — zones, cities, clusters, agencies, and the user_scopes grants that
  // every other food scope resolves from. FOOD_ORG:edit is what mints a scope
  // row, so any holder can widen its own access; it stays a platform-admin
  // functionality. Grant a geo scope instead of this cell.
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
    // Conducts audits but cannot start or discard them — those are the
    // scheduler's, and a conductor who can discard can erase a bad result.
    AUDIT_EXECUTION: ["view_audit", "record_answers"],
  },
  CLUSTER_MANAGER: {
    FOOD_RECEIVE_UPDATE: VE, FOOD_DELIVERY_TRACKING: VE, FOOD_DASHBOARD: VIEW,
    FOOD_ALL_ORDERS: VE, FOOD_PLACE_ORDER: VE, FOOD_DISPATCH: VIEW,
    FOOD_CONFIRM_DELIVERY: VE, FOOD_WASTE_TRACKING: VE, FOOD_REPORTS: VIEW,
    // Audit & Inspection: conducts CM + UL audits for the cluster; views CX
    // read-only (C-1). Fine scoping via audit_role_grants.
    AUDIT_DASHBOARD: VIEW, AUDIT_REGISTER: VIEW, AUDIT_REPORTS: VIEW,
    // Conducts audits but cannot start or discard them — those are the
    // scheduler's, and a conductor who can discard can erase a bad result.
    AUDIT_EXECUTION: ["view_audit", "record_answers"],
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
  // B3-24: OPS_EXCELLENCE has FULL super-admin parity across every functionality (incl.
  // USERS / SETTINGS / AUDIT_LOG / FINANCE), per explicit product decision.
  // Like SUPER_ADMIN this is the one other role allowed to hold dispatch-edit
  // and confirm-delivery-edit together; it is break-glass, not an operator seat.
  OPS_EXCELLENCE: Object.fromEntries(ALL_FUNCTIONALITIES.map(m => [m, FULL])) as RoleMatrix,
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
    // Starts and conducts, but still cannot discard.
    AUDIT_EXECUTION: ["view_audit", "start_audit", "record_answers"],
  },
};

export function can(role: UserRole | undefined, functionality: Functionality, perm: NamedAction): boolean {
  if (!role) return false;
  // The manifest ceiling, checked before anything is granted: an action the
  // functionality does not declare is a refusal, never a pass.
  if (!actionDef(functionality, perm)) return false;
  const cell = ROLE_PERMISSIONS[role]?.[functionality];
  if (!cell) return false;
  return expandCell(functionality, cell).includes(perm);
}

/**
 * Does the role hold `perm` on ANYTHING in the module? See the note on the
 * API-side twin: the module level is a FOLD, never a stored grant, so a
 * functionality added tomorrow is not retroactively granted today.
 *
 * Decides whether a nav SECTION or a launcher CARD appears. Never gates a
 * screen — those name the functionality they need.
 */
export function canModule(role: UserRole | undefined, module: Module, perm?: NamedAction): boolean {
  if (!role) return false;
  // Omitting `perm` means each functionality's OWN read — a module's
  // functionalities no longer share a verb, so there is nothing else to default
  // to. Same resolution as the API-side twin.
  return functionalitiesOf(module).some((f) => {
    const a = perm ?? readActionOf(f);
    return a != null && can(role, f, a);
  });
}

/** B3-24: roles with full super-admin parity (SUPER_ADMIN + OPS_EXCELLENCE). */
export const isSuperAdminRole = (role: UserRole | undefined): boolean =>
  role === "SUPER_ADMIN" || role === "OPS_EXCELLENCE";

/**
 * Where a freshly signed-in user lands: the app launcher (/apps), for every
 * persona — a permission-filtered grid with one card per MODULE, never per
 * page. F&B managers used to skip it and land inside Kitchen Home, which put
 * the Food module's internal pages in front of them before the module itself;
 * those pages are reachable from inside Food, so the first view is now the
 * same one-card launcher everyone else (Ops Excellence included) gets.
 */
export function homeForRole(_role: UserRole | undefined): string {
  return "/apps";
}

/**
 * Paths that are deliberately not gated.
 *
 * PageGuard fails CLOSED on anything unmapped, so this is the explicit escape
 * hatch rather than the old implicit one (an unlisted path used to render
 * ungated, which meant forgetting a mapping silently opened a page). Keep it
 * short and argued: pre-auth flows, token-bearing links, and the two surfaces
 * every signed-in user may see.
 *
 * `routes.test.ts` asserts every <Route> in App.tsx is either mapped below or
 * listed here, so a new route cannot be added without answering the question.
 */
export const PUBLIC_PATHS: RegExp[] = [
  /^\/login/,
  /^\/reset-password\//,
  /^\/recover-username\//,
  /^\/esign\/sign\//,   // the resident's own signing link; the token is the credential
  /^\/m\//,             // short share link
  /^\/403/,              // the refusal page itself must never be refused
  /^\/apps\/?$/,        // the launcher — every signed-in user sees it
  /^\/$/,                // root redirect
];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(path));
}

/**
 * Route → the FUNCTIONALITY it needs. Not the module: a route is one screen and
 * one screen is one capability. Gating a route on its module would let anyone
 * with any Audit access open the review queue.
 */
export const PATH_TO_FUNCTIONALITY: Array<[RegExp, Functionality]> = [
  // Admin Console -> Access Control. Must be listed: functionalityForPath()
  // returns null for an unmapped path and PageGuard then refuses.
  [/^\/access-control/, "ACCESS_CONTROL"],
  // User & Access Management. Users/roles administration is the USERS
  // functionality; the access plane itself stays on ACCESS_CONTROL.
  [/^\/uam\/users/, "USERS"],
  [/^\/uam\/roles/, "ACCESS_CONTROL"],
  [/^\/uam\/privileges/, "ACCESS_CONTROL"],
  [/^\/uam\/check/, "ACCESS_CONTROL"],
  // Unit-Lead dashboard (WS7) — top-level, gated on the food dashboard.
  [/^\/home/, "FOOD_DASHBOARD"],
  [/^\/dashboard\/executive/, "EXECUTIVE_DASHBOARD"],
  [/^\/dashboard/, "DASHBOARD"],
  [/^\/properties/, "PROPERTIES"],
  [/^\/residents/, "RESIDENTS"],
  [/^\/complaints/, "COMPLAINT_TICKETS"],
  [/^\/laundry/, "LAUNDRY_BATCHES"],
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
  // Food Overview and their routes removed; the functionalities still gate the
  // inline actions there.
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

export function functionalityForPath(path: string): Functionality | null {
  for (const [re, f] of PATH_TO_FUNCTIONALITY) if (re.test(path)) return f;
  return null;
}

/** The module a route belongs to — for breadcrumbs and the active nav section. */
export function moduleForPath(path: string): Module | null {
  const f = functionalityForPath(path);
  return f ? moduleOf(f) : null;
}
