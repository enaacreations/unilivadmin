import {
  LayoutDashboard, AlertCircle, WashingMachine, MessageSquare,
  UserCheck, Briefcase, GraduationCap, Truck, ClipboardList, ShoppingCart,
  PackageCheck, Boxes, ChefHat, CalendarDays, TrendingUp, MapPin,
  BookOpen, CreditCard, Shield, Settings, BarChart3,
  Repeat, BellRing, Landmark, Receipt, Wrench, Zap, ClipboardCheck, Radio, Wallet,
  UtensilsCrossed, ListOrdered, Soup, Send, SlidersHorizontal,
  Network, LayoutGrid,
  DoorOpen, CalendarCheck, CalendarX, LineChart, Recycle, Database, ScrollText,
  Gauge, AlertTriangle, ListChecks, Kanban, BadgeCheck, FileBarChart,
  CalendarClock, FileStack, Library, CookingPot,
  type LucideIcon,
} from "lucide-react"
import { type Module, type UserRole } from "@/lib/permissions"

/** `module` gates the item to roles that can view it; an item without a module
 *  (e.g. the Home launcher) is visible to every signed-in user. `hideFor`
 *  additionally hides the item from specific roles even when their module
 *  grants would allow it — used to keep the unit-lead Food nav down to the
 *  three prototype items (the journey dashboard absorbs the other flows).
 *  The page routes stay reachable (deep links, in-page CTAs); only nav +
 *  launcher + palette entries are hidden. */
export type NavItem = { title: string; href: string; icon: LucideIcon; module?: Module; hideFor?: UserRole[] }
export type NavGroup = { title: string; items: NavItem[] }

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
  { title: "Overview", items: [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, module: "DASHBOARD" },
    { title: "Executive", href: "/dashboard/executive", icon: BarChart3, module: "EXECUTIVE_DASHBOARD" },
  ]},
  { title: "Properties", items: [
    { title: "Properties", href: "/properties", icon: Building2, module: "PROPERTIES" },
  ]},
  */
  /* Hidden for now (user decision 13-Jul-2026): only Food + Audits are live
     modules in the launcher/sidebar. Routes and permission gates still exist;
     re-add a group here to restore it.
  { title: "Operations", items: [
    { title: "Rooms", href: "/rooms", icon: DoorOpen, module: "PROPERTIES" },
    { title: "Residents", href: "/residents", icon: Users, module: "RESIDENTS" },
    { title: "Complaints", href: "/complaints", icon: AlertCircle, module: "COMPLAINTS" },
    { title: "Laundry", href: "/laundry", icon: WashingMachine, module: "LAUNDRY" },
    { title: "Communications", href: "/communications", icon: MessageSquare, module: "COMMUNICATIONS" },
    { title: "Facility", href: "/facility", icon: Wrench, module: "FACILITY" },
    { title: "Electricity", href: "/electricity", icon: Zap, module: "ELECTRICITY" },
    { title: "Attendance & Out-pass", href: "/resident-attendance", icon: ClipboardCheck, module: "RESIDENT_ATTENDANCE" },
    { title: "IoT Devices", href: "/iot", icon: Radio, module: "IOT" },
  ]},
  { title: "People", items: [
    { title: "Employees", href: "/employees", icon: UserCheck, module: "EMPLOYEES" },
    { title: "Attendance", href: "/attendance", icon: CalendarCheck, module: "EMPLOYEES" },
    { title: "Leaves", href: "/leaves", icon: CalendarX, module: "EMPLOYEES" },
    { title: "Recruitment", href: "/recruitment", icon: Briefcase, module: "RECRUITMENT" },
    { title: "Learning & Dev", href: "/courses", icon: GraduationCap, module: "LND" },
  ]},
  { title: "Supply Chain", items: [
    { title: "Vendors", href: "/vendors", icon: Truck, module: "VENDORS" },
    { title: "Indents", href: "/indents", icon: ClipboardList, module: "INDENTS" },
    { title: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart, module: "PURCHASE_ORDERS" },
    { title: "GRN", href: "/grn", icon: PackageCheck, module: "GRN" },
    { title: "Inventory", href: "/inventory", icon: Boxes, module: "INVENTORY" },
  ]},
  */
  // Unit leads get the prototype's three-item Food nav (Food Overview / All
  // Orders / Reports) — the journey dashboard absorbs place-order, confirm,
  // waste and guests, so those entries are hidden for that role only.
  // Kitchen & Menu lives INSIDE Food (13-Jul): visible to roles holding
  // RECIPES/MENU_PLANNING (kitchen managers, F&B managers, ops excellence) —
  // unit leads have no grant on those modules, so they never see them.
  { title: "Food", items: [
    // My Dashboard (UnitLeadHome), My Properties and Active Guests are
    // property/tenancy surfaces, not food ops — they belong to the Property
    // module, so they're kept OUT of the Food nav entirely. The routes still
    // exist (deep links) and can be re-homed under a Property group if one is
    // re-exposed. Food Overview is the unit lead's journey dashboard; F&B
    // managers get a gated-empty state there so it's hidden for them.
    { title: "Food Overview", href: "/food/dashboard", icon: UtensilsCrossed, module: "FOOD_DASHBOARD", hideFor: ["FNB_MANAGER"] },
    { title: "Organization", href: "/food/organization", icon: Network, module: "FOOD_ORG" },
    { title: "All Orders", href: "/food/orders", icon: ListOrdered, module: "FOOD_ALL_ORDERS" },
    // Kitchen Home is the F&B journey dashboard (accept → cook → dispatch per
    // meal) and the FNB_MANAGER landing page. F&B managers now run entirely
    // from it: Kitchen Summary, Dispatch, Recipes, Menu Planning, Waste
    // Analytics and Settings are hidden for that persona (the routes still
    // exist for other roles + deep links) so their Food nav is just Kitchen
    // Home + Reports. Other kitchen roles (supervisor, ops-excellence, admin)
    // still see the full set.
    { title: "Kitchen Home", href: "/food/kitchen-home", icon: CookingPot, module: "FOOD_KITCHEN_SUMMARY" },
    { title: "Kitchen Summary", href: "/food/kitchen-summary", icon: Soup, module: "FOOD_KITCHEN_SUMMARY", hideFor: ["FNB_MANAGER"] },
    { title: "Dispatch", href: "/food/dispatch", icon: Send, module: "FOOD_DISPATCH", hideFor: ["FNB_MANAGER"] },
    { title: "Recipes", href: "/recipes", icon: ChefHat, module: "RECIPES", hideFor: ["FNB_MANAGER"] },
    { title: "Menu Planning", href: "/menu-planning", icon: CalendarDays, module: "MENU_PLANNING", hideFor: ["FNB_MANAGER"] },
    // Place Order / Confirm Delivery / Waste Tracking were folded into the
    // Food Overview single page (place order, receive, log waste inline), so
    // the standalone pages + routes were removed. Their permission MODULES
    // (FOOD_PLACE_ORDER / FOOD_CONFIRM_DELIVERY / FOOD_WASTE_TRACKING) remain —
    // they still gate those inline actions on Food Overview.
    { title: "Reports", href: "/food/reports", icon: BarChart3, module: "FOOD_REPORTS" },
    { title: "Waste Analytics", href: "/food/waste-analytics", icon: Recycle, module: "FOOD_REPORTS", hideFor: ["UNIT_LEAD", "FNB_MANAGER"] },
    { title: "Settings", href: "/food/settings", icon: SlidersHorizontal, module: "FOOD_SETTINGS" },
  ]},
  /* Audit nav is trimmed per persona (like Food) so each role sees only its
   * essential tabs, even where the module grant is broader:
   *  - Conductors (UNIT_LEAD / CLUSTER_MANAGER / CUSTOMER_EXPERIENCE): their own
   *    work only — My Audits + their findings surface (My Findings for UL/CM,
   *    NC Board for CX which lacks AUDIT_FINDINGS); oversight/admin tabs hidden.
   *  - Oversight (CITY_HEAD / ZONAL_HEAD / SENIOR_VICE_PRESIDENT): Dashboard +
   *    Register + Reports; the operational NC Board is hidden.
   *  - OPS_EXCELLENCE runs the programme but doesn't conduct → hide the two
   *    personal tabs (My Audits, My Findings), keep the management set.
   *  - SUPER_ADMIN / AUDIT_READONLY keep full visibility (no hideFor).
   * hideFor only hides the nav link; routes + data access are unchanged. */
  { title: "Audits", items: [
    { title: "My Audits", href: "/audits/my", icon: ClipboardCheck, module: "AUDIT_EXECUTION", hideFor: ["OPS_EXCELLENCE"] },
    { title: "Audit Dashboard", href: "/audits/dashboard", icon: Gauge, module: "AUDIT_DASHBOARD", hideFor: ["UNIT_LEAD", "CLUSTER_MANAGER", "CUSTOMER_EXPERIENCE"] },
    { title: "My Findings", href: "/audits/findings", icon: AlertTriangle, module: "AUDIT_FINDINGS", hideFor: ["OPS_EXCELLENCE"] },
    { title: "Audit Register", href: "/audits/register", icon: ListChecks, module: "AUDIT_REGISTER", hideFor: ["UNIT_LEAD", "CLUSTER_MANAGER", "CUSTOMER_EXPERIENCE"] },
    { title: "NC Board", href: "/audits/ncs", icon: Kanban, module: "AUDIT_NCS", hideFor: ["CITY_HEAD", "ZONAL_HEAD", "SENIOR_VICE_PRESIDENT"] },
    { title: "Review", href: "/audits/review", icon: BadgeCheck, module: "AUDIT_REVIEW" },
    { title: "Reports", href: "/audits/reports", icon: FileBarChart, module: "AUDIT_REPORTS", hideFor: ["UNIT_LEAD", "CLUSTER_MANAGER", "CUSTOMER_EXPERIENCE"] },
    { title: "Schedules", href: "/audits/schedules", icon: CalendarClock, module: "AUDIT_SCHEDULES" },
    { title: "Templates", href: "/audits/templates", icon: FileStack, module: "AUDIT_TEMPLATES" },
    { title: "Question Bank", href: "/audits/question-bank", icon: Library, module: "AUDIT_TEMPLATES" },
    { title: "Audit Admin", href: "/audits/admin", icon: SlidersHorizontal, module: "AUDIT_ADMIN" },
    { title: "Trail Explorer", href: "/audits/trail", icon: ScrollText, module: "AUDIT_TRAIL" },
  ]},
  /* Hidden for now (user decision 13-Jul-2026) — see the note above.
  { title: "Growth", items: [
    { title: "Sales Dashboard", href: "/sales/dashboard", icon: LineChart, module: "SALES_DASHBOARD" },
    { title: "Sales CRM", href: "/leads", icon: TrendingUp, module: "SALES_LEADS" },
    { title: "Property Leads", href: "/property-leads", icon: MapPin, module: "PROPERTY_LEADS" },
  ]},
  { title: "Finance", items: [
    { title: "Ledger", href: "/ledger", icon: BookOpen, module: "LEDGER" },
    { title: "Payments", href: "/payments", icon: CreditCard, module: "PAYMENTS" },
    { title: "Wallet", href: "/wallet", icon: Wallet, module: "WALLET" },
    { title: "Recurring Billing", href: "/billing-cycles", icon: Repeat, module: "BILLING_CYCLES" },
    { title: "Reminders", href: "/reminders", icon: BellRing, module: "REMINDERS" },
    { title: "Banking", href: "/banking", icon: Landmark, module: "BANKING" },
    { title: "Expenses", href: "/expenses", icon: Receipt, module: "EXPENSES" },
  ]},
  { title: "Settings", items: [
    { title: "Masters", href: "/masters", icon: Database, module: "FOOD_SETTINGS" },
    { title: "Users & Roles", href: "/users", icon: Shield, module: "USERS" },
    { title: "Audit Log", href: "/audit-log", icon: ScrollText, module: "AUDIT_LOG" },
    { title: "Configuration", href: "/settings", icon: Settings, module: "SETTINGS" },
  ]},
  */
];
