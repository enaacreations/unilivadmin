import {
  LayoutDashboard, AlertCircle, WashingMachine, MessageSquare,
  UserCheck, Briefcase, GraduationCap, Truck, ClipboardList, ShoppingCart,
  PackageCheck, Boxes, TrendingUp, MapPin,
  BookOpen, CreditCard, Shield, Settings, BarChart3, Users, KeyRound,
  Repeat, BellRing, Landmark, Receipt, Wrench, Zap, ClipboardCheck, Radio, Wallet,
  UtensilsCrossed, ListOrdered, SlidersHorizontal,
  Network, LayoutGrid,
  DoorOpen, CalendarCheck, CalendarX, LineChart, Recycle, Database, ScrollText,
  Gauge, AlertTriangle, ListChecks, Kanban, BadgeCheck, FileBarChart,
  CalendarClock, FileStack, CookingPot,
  type LucideIcon,
} from "lucide-react"
import {
  functionalityForPath, moduleOf, moduleLabel,
  type Functionality, type Module, type NamedAction, type UserRole,
} from "@/lib/permissions"

/** `functionality` gates the item to roles that can view it — a nav item is one
 *  screen, so it names one capability, never a whole module. An item without one
 *  (e.g. the Home launcher) is visible to every signed-in user. `hideFor`
 *  additionally hides the item from specific roles even when their grants would
 *  allow it — used to keep the unit-lead Food nav down to the three prototype
 *  items (the journey dashboard absorbs the other flows). The page routes stay
 *  reachable (deep links, in-page CTAs); only nav + launcher + palette entries
 *  are hidden. */
export type NavItem = { title: string; href: string; icon: LucideIcon; functionality?: Functionality; hideFor?: UserRole[] }

/**
 * A nav GROUP is a MODULE — the sidebar section and the launcher card are the
 * module level made visible, which is why `module` is the group's identity here
 * rather than its title being the only thing tying its items together.
 *
 * `module` is optional only for the Home launcher pseudo-group, which belongs to
 * no module and is shown to everyone.
 */
export type NavGroup = { title: string; module?: Module; items: NavItem[] }

type CanFn = (functionality: Functionality, perm?: NamedAction) => boolean

/** True when the signed-in persona may actually OPEN `href`. Resolves the route's
 *  module exactly the way `PageGuard` does, so anything we render as a link can
 *  never dead-end on the Forbidden screen.
 *
 *  `hideFor` is deliberately NOT consulted: it only folds an item out of the nav
 *  (see the note above) — the route stays reachable, so such a link is still
 *  legitimate. Only a missing module grant makes an href unlinkable. */
export function canViewHref(href: string, can: CanFn): boolean {
  const f = functionalityForPath(href)
  return !f || can(f)
}

/** A `PageHeader` breadcrumb entry. */
export type Crumb = { label: string; href?: string; onClick?: () => void }

/** Drops the crumbs that point at a route this persona cannot view, so a
 *  breadcrumb never advertises — let alone links to — a screen the user has no
 *  access to (e.g. a unit lead on /audits/register seeing a "Review Queue"
 *  parent). Crumbs without an `href` are plain labels and always survive, so the
 *  section root and the current page are never dropped. */
export function scopeCrumbs<T extends Crumb>(crumbs: T[], can: CanFn): T[] {
  return crumbs.filter((c) => !c.href || canViewHref(c.href, can))
}

export const navGroups: NavGroup[] = [
  // "Home" is the /apps module launcher — the universal landing page. The
  // sidebar (components/layout.tsx) pins this group at the top and otherwise
  // shows only the group the current route belongs to; the launcher renders
  // one card per remaining group.
  { title: "Home", items: [
    { title: "Home", href: "/apps", icon: LayoutGrid },
  ]},
  /* Hidden for now (PO, 08-Jul): Dashboard + Properties top-level modules.
     Routes still exist; just removed from the launcher/sidebar. Re-add to restore.
  { title: "Overview", module: "OVERVIEW", items: [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, functionality: "DASHBOARD" },
    { title: "Executive", href: "/dashboard/executive", icon: BarChart3, functionality: "EXECUTIVE_DASHBOARD" },
  ]},
  { title: "Properties", module: "OPERATIONS", items: [
    { title: "Properties", href: "/properties", icon: Building2, functionality: "PROPERTIES" },
  ]},
  */
  /* Hidden for now (user decision 13-Jul-2026): only Food + Audits are live
     modules in the launcher/sidebar. Routes and permission gates still exist;
     re-add a group here to restore it.
  { title: "Operations", module: "OPERATIONS", items: [
    { title: "Rooms", href: "/rooms", icon: DoorOpen, functionality: "PROPERTIES" },
    { title: "Residents", href: "/residents", icon: Users, functionality: "RESIDENTS" },
    { title: "Communications", href: "/communications", icon: MessageSquare, functionality: "COMMUNICATIONS" },
    { title: "Facility", href: "/facility", icon: Wrench, functionality: "FACILITY" },
    { title: "Electricity", href: "/electricity", icon: Zap, functionality: "ELECTRICITY" },
    { title: "Attendance & Out-pass", href: "/resident-attendance", icon: ClipboardCheck, functionality: "RESIDENT_ATTENDANCE" },
    { title: "IoT Devices", href: "/iot", icon: Radio, functionality: "IOT" },
  ]},
  { title: "People", module: "PEOPLE", items: [
    { title: "Employees", href: "/employees", icon: UserCheck, functionality: "EMPLOYEES" },
    { title: "Attendance", href: "/attendance", icon: CalendarCheck, functionality: "EMPLOYEES" },
    { title: "Leaves", href: "/leaves", icon: CalendarX, functionality: "EMPLOYEES" },
    { title: "Recruitment", href: "/recruitment", icon: Briefcase, functionality: "RECRUITMENT" },
    { title: "Learning & Dev", href: "/courses", icon: GraduationCap, functionality: "LND" },
  ]},
  { title: "Supply Chain", module: "SUPPLY_CHAIN", items: [
    { title: "Vendors", href: "/vendors", icon: Truck, functionality: "VENDORS" },
    { title: "Indents", href: "/indents", icon: ClipboardList, functionality: "INDENTS" },
    { title: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart, functionality: "PURCHASE_ORDERS" },
    { title: "GRN", href: "/grn", icon: PackageCheck, functionality: "GRN" },
    { title: "Inventory", href: "/inventory", icon: Boxes, functionality: "INVENTORY" },
  ]},
  */
  /* Complaint Management and Laundry are MODULES of their own (product,
     2026-09-26), so each gets its own group rather than sitting as an item
     inside Operations — the sidebar section and the launcher card ARE the
     module level, so a module with no group can never appear as a card.

     Still hidden, to respect the same 13-Jul-2026 decision that hid Operations:
     only Food + Audits are live in the launcher. They are kept OUT of that
     block and separately commented so either can be switched on alone — delete
     the two comment markers around the group you want and nothing else moves.

     Housekeeping has no group: the module is reserved but has no page to link
     to, and a group with no items is dropped rather than rendered empty. Add it
     here when the feature lands. */
  /*
  { title: "Complaint Management", module: "COMPLAINTS", items: [
    { title: "Complaints", href: "/complaints", icon: AlertCircle, functionality: "COMPLAINT_TICKETS" },
  ]},
  */
  /*
  { title: "Laundry", module: "LAUNDRY", items: [
    { title: "Laundry", href: "/laundry", icon: WashingMachine, functionality: "LAUNDRY_BATCHES" },
  ]},
  */
  // Unit leads get the prototype's three-item Food nav (Food Overview / All
  // Orders / Reports) — the journey dashboard absorbs place-order, confirm,
  // waste and guests, so those entries are hidden for that role only.
  // Recipes and Menu Planning (the old Kitchen & Menu pair) were removed
  // product-wide along with their routes, API and RECIPES/MENU_PLANNING
  // permission modules; only their `recipes`/`menu_plans` tables remain.
  { title: "Food", module: "FOOD", items: [
    // My Dashboard (UnitLeadHome), My Properties and Active Guests are
    // property/tenancy surfaces, not food ops — they belong to the Property
    // module, so they're kept OUT of the Food nav entirely. The routes still
    // exist (deep links) and can be re-homed under a Property group if one is
    // re-exposed. Food Overview is the unit lead's journey dashboard; F&B
    // managers get a gated-empty state there so it's hidden for them.
    { title: "Food Overview", href: "/food/dashboard", icon: UtensilsCrossed, functionality: "FOOD_DASHBOARD", hideFor: ["FNB_MANAGER"] },
    { title: "Organization", href: "/food/organization", icon: Network, functionality: "FOOD_ORG" },
    { title: "All Orders", href: "/food/orders", icon: ListOrdered, functionality: "FOOD_ALL_ORDERS" },
    // Kitchen Home is the F&B journey dashboard (accept → cook → dispatch per
    // meal) and the FNB_MANAGER landing page. Every kitchen role now runs from
    // it: the standalone Kitchen Summary and Dispatch pages were pulled from
    // the UI (nav + Kitchen Home quick links) — their routes, APIs and
    // permission modules are untouched, so deep links still resolve and
    // restoring them is just re-adding the two nav items here.
    { title: "Kitchen Home", href: "/food/kitchen-home", icon: CookingPot, functionality: "FOOD_KITCHEN_SUMMARY" },
    // Place Order / Confirm Delivery / Waste Tracking were folded into the
    // Food Overview single page (place order, receive, log waste inline), so
    // the standalone pages + routes were removed. Their permission MODULES
    // (FOOD_PLACE_ORDER / FOOD_CONFIRM_DELIVERY / FOOD_WASTE_TRACKING) remain —
    // they still gate those inline actions on Food Overview.
    { title: "Reports", href: "/food/reports", icon: BarChart3, functionality: "FOOD_REPORTS" },
    { title: "Waste Analytics", href: "/food/waste-analytics", icon: Recycle, functionality: "FOOD_REPORTS", hideFor: ["UNIT_LEAD", "FNB_MANAGER"] },
    // "Service Set" — the dishes, rules and rotation that define what a property
    // is served. Named for the thing it configures, not for the fact that it's
    // configuration (the route stays /food/settings).
    { title: "Service Set", href: "/food/settings", icon: SlidersHorizontal, functionality: "FOOD_SETTINGS" },
  ]},
  /* Audit nav (PRD v1.0 trim, 2026-07-24): the NC/findings subsystem and the
   * trail-explorer UI were removed product-wide, so the module is small enough
   * to need only light per-persona folding:
   *  - Staff (UNIT_LEAD / CLUSTER_MANAGER / CUSTOMER_EXPERIENCE): My Audits +
   *    Reports.
   *  - Oversight (CITY_HEAD / ZONAL_HEAD / SENIOR_VICE_PRESIDENT): All Audits +
   *    Reports.
   *  - OPS_EXCELLENCE / SUPER_ADMIN: Review Queue, Templates, Schedules,
   *    Reports, Audit Admin. Neither My Audits nor All Audits —
   *    they hold those modules through a blanket grant rather than because
   *    they conduct audits or watch the estate (product, 2026-08-08).
   * Reports is standalone for EVERY audit persona (PRD: each role sees its
   * permitted audit types' reports — the backend scopes the data). The old
   * oversight dashboard is retired; /audits/dashboard redirects to the Review
   * Queue. hideFor only hides nav links; routes + data access are unchanged. */
  /* Order fixed by product (2026-08-08): Review Queue · Schedules · Audit
   * Templates · Reports · Settings (staff additionally see My Audits first).
   * Day-to-day operating items lead; authoring follows. The Question Bank and
   * the schedule calendar are tabs/views of Templates and Schedules, not nav
   * items of their own. */
  { title: "Audits", module: "AUDITS", items: [
    /* The conducting persona's OWN queue. Admin-class roles hold AUDIT_EXECUTION
       through their blanket grant, not because they run audits — showing them a
       personal queue mislabels them as the auditing persona. Hidden, not
       revoked: the route stays reachable if one is ever assigned work. */
    { title: "My Audits", href: "/audits/my", icon: ClipboardCheck, functionality: "AUDIT_EXECUTION",
      hideFor: ["OPS_EXCELLENCE", "SUPER_ADMIN"] },
    { title: "Review Queue", href: "/audits/review", icon: BadgeCheck, functionality: "AUDIT_REVIEW" },
    /* The scoped, filterable register. It has always been routed and gated on
       AUDIT_REGISTER but had no nav item, so oversight roles saw a single
       "Reports" link. Hidden from conducting personas: their queue is My
       Audits, and a ten-column register is not a phone surface. */
    { title: "All Audits", href: "/audits/register", icon: ClipboardList, functionality: "AUDIT_REGISTER",
      /* Conducting personas work from My Audits; admin-class roles work from the
         Review Queue and Templates. The register is for the read-only oversight
         roles (City / Zonal Head, SVP, AUDIT_READONLY) whose whole job is
         looking across the estate. */
      hideFor: ["UNIT_LEAD", "CLUSTER_MANAGER", "CUSTOMER_EXPERIENCE", "OPS_EXCELLENCE", "SUPER_ADMIN"] },
    { title: "Schedules", href: "/audits/schedules", icon: CalendarClock, functionality: "AUDIT_SCHEDULES", hideFor: ["OPS_EXCELLENCE"] },
    { title: "Audit Templates", href: "/audits/templates", icon: FileStack, functionality: "AUDIT_TEMPLATES" },
    /* No Question Bank item: it is a tab of the Audit Templates page
       (templates.tsx renders <QuestionBankPanel embedded />), so a nav entry
       duplicated the same surface. /audits/question-bank stays routed and
       gated on AUDIT_TEMPLATES for direct links. */
    { title: "Reports", href: "/audits/reports", icon: FileBarChart, functionality: "AUDIT_REPORTS" },
    { title: "Settings", href: "/audits/admin", icon: SlidersHorizontal, functionality: "AUDIT_ADMIN" },
  ]},
  /* Admin Console -> RBAC (PRD §30). A live group of its own rather
     than an item under the commented-out Settings group, so it is reachable
     from the launcher today. Gated on ACCESS_CONTROL, which only SUPER_ADMIN
     and OPS_EXCELLENCE hold, so no other role sees the group at all. */
  /* Named the way the module's own screens name themselves: each item is the
     question it answers, not the table it reads. */
  { title: "User & Access Management", module: "ACCESS", items: [
    { title: "Users", href: "/uam/users", icon: Users, functionality: "USERS" },
    { title: "Roles", href: "/uam/roles", icon: Shield, functionality: "ACCESS_CONTROL" },
    { title: "Privileges", href: "/uam/privileges", icon: KeyRound, functionality: "ACCESS_CONTROL" },
  ]},
  /* Hidden for now (user decision 13-Jul-2026) — see the note above.
  { title: "Growth", module: "GROWTH", items: [
    { title: "Sales Dashboard", href: "/sales/dashboard", icon: LineChart, functionality: "SALES_DASHBOARD" },
    { title: "Sales CRM", href: "/leads", icon: TrendingUp, functionality: "SALES_LEADS" },
    { title: "Property Leads", href: "/property-leads", icon: MapPin, functionality: "PROPERTY_LEADS" },
  ]},
  { title: "Finance", module: "FINANCE_OPS", items: [
    { title: "Ledger", href: "/ledger", icon: BookOpen, functionality: "LEDGER" },
    { title: "Payments", href: "/payments", icon: CreditCard, functionality: "PAYMENTS" },
    { title: "Wallet", href: "/wallet", icon: Wallet, functionality: "WALLET" },
    { title: "Recurring Billing", href: "/billing-cycles", icon: Repeat, functionality: "BILLING_CYCLES" },
    { title: "Reminders", href: "/reminders", icon: BellRing, functionality: "REMINDERS" },
    { title: "Banking", href: "/banking", icon: Landmark, functionality: "BANKING" },
    { title: "Expenses", href: "/expenses", icon: Receipt, functionality: "EXPENSES" },
  ]},
  { title: "Settings", module: "PLATFORM", items: [
    { title: "Masters", href: "/masters", icon: Database, functionality: "FOOD_SETTINGS" },
    { title: "Audit Log", href: "/audit-log", icon: ScrollText, functionality: "AUDIT_LOG" },
    { title: "Configuration", href: "/settings", icon: Settings, functionality: "SETTINGS" },
  ]},
  */
];

/**
 * The nav group a route belongs to, by MODULE — so a deep link into
 * /audits/templates highlights the Audits section without the caller matching
 * hrefs by prefix.
 */
export function groupForPath(path: string): NavGroup | undefined {
  const f = functionalityForPath(path)
  if (!f) return undefined
  const m = moduleOf(f)
  return navGroups.find((g) => g.module === m)
}

/**
 * The module sections this persona should see, each with only the items they can
 * open.
 *
 * `canModule` decides whether the SECTION appears and `can` which ITEMS do —
 * two different questions, which is the whole reason the module level exists. A
 * section with a granted module but no openable items is dropped rather than
 * rendered empty: that state means the person holds something in the module that
 * has no nav surface (an inline action, say), and an empty drawer reads as a bug.
 */
export function visibleGroups(
  can: CanFn,
  canModule: (module: Module, perm?: NamedAction) => boolean,
  role: UserRole | undefined,
): NavGroup[] {
  return navGroups
    .filter((g) => !g.module || canModule(g.module))
    .map((g) => ({
      ...g,
      title: g.module ? moduleLabel(g.module) : g.title,
      items: g.items.filter(
        (i) =>
          (!i.functionality || can(i.functionality)) &&
          !(role && i.hideFor?.includes(role)),
      ),
    }))
    .filter((g) => g.items.length > 0)
}
