import {
  LayoutDashboard, Building2, Users, AlertCircle, WashingMachine, MessageSquare,
  UserCheck, Briefcase, GraduationCap, Truck, ClipboardList, ShoppingCart,
  PackageCheck, Boxes, ChefHat, CalendarDays, TrendingUp, MapPin,
  BookOpen, CreditCard, Shield, Settings, BarChart3,
  Repeat, BellRing, Landmark, Receipt, Wrench, Zap, ClipboardCheck, Radio, Wallet,
  UtensilsCrossed, ListOrdered, FilePlus2, Soup, Send, CheckCircle2, Trash2, SlidersHorizontal,
  Network, Home, LayoutGrid,
  DoorOpen, CalendarCheck, CalendarX, LineChart, Recycle, Database, ScrollText,
  Gauge, AlertTriangle, ListChecks, Kanban, BadgeCheck, FileBarChart,
  CalendarClock, FileStack, Library,
  type LucideIcon,
} from "lucide-react"
import { type Module } from "@/lib/permissions"

/** `module` gates the item to roles that can view it; an item without a module
 *  (e.g. the Home launcher) is visible to every signed-in user. */
export type NavItem = { title: string; href: string; icon: LucideIcon; module?: Module }
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
  { title: "Kitchen & Menu", items: [
    { title: "Recipes", href: "/recipes", icon: ChefHat, module: "RECIPES" },
    { title: "Menu Planning", href: "/menu-planning", icon: CalendarDays, module: "MENU_PLANNING" },
  ]},
  { title: "Food", items: [
    { title: "My Dashboard", href: "/home", icon: Home, module: "FOOD_DASHBOARD" },
    { title: "My Properties", href: "/food/my-properties", icon: Building2, module: "FOOD_DASHBOARD" },
    { title: "Active Guests", href: "/food/guests", icon: Users, module: "FOOD_DASHBOARD" },
    { title: "Food Overview", href: "/food/dashboard", icon: UtensilsCrossed, module: "FOOD_DASHBOARD" },
    { title: "Organization", href: "/food/organization", icon: Network, module: "FOOD_ORG" },
    { title: "All Orders", href: "/food/orders", icon: ListOrdered, module: "FOOD_ALL_ORDERS" },
    { title: "Place Order", href: "/food/place-order", icon: FilePlus2, module: "FOOD_PLACE_ORDER" },
    { title: "Kitchen Summary", href: "/food/kitchen-summary", icon: Soup, module: "FOOD_KITCHEN_SUMMARY" },
    { title: "Dispatch", href: "/food/dispatch", icon: Send, module: "FOOD_DISPATCH" },
    { title: "Confirm Delivery", href: "/food/confirm-delivery", icon: CheckCircle2, module: "FOOD_CONFIRM_DELIVERY" },
    { title: "Waste Tracking", href: "/food/waste", icon: Trash2, module: "FOOD_WASTE_TRACKING" },
    { title: "Reports", href: "/food/reports", icon: BarChart3, module: "FOOD_REPORTS" },
    { title: "Waste Analytics", href: "/food/waste-analytics", icon: Recycle, module: "FOOD_REPORTS" },
    { title: "Settings", href: "/food/settings", icon: SlidersHorizontal, module: "FOOD_SETTINGS" },
  ]},
  { title: "Audits", items: [
    { title: "Audit Dashboard", href: "/audits/dashboard", icon: Gauge, module: "AUDIT_DASHBOARD" },
    { title: "My Audits", href: "/audits/my", icon: ClipboardCheck, module: "AUDIT_EXECUTION" },
    { title: "My Findings", href: "/audits/findings", icon: AlertTriangle, module: "AUDIT_FINDINGS" },
    { title: "Audit Register", href: "/audits/register", icon: ListChecks, module: "AUDIT_REGISTER" },
    { title: "NC Board", href: "/audits/ncs", icon: Kanban, module: "AUDIT_NCS" },
    { title: "Review", href: "/audits/review", icon: BadgeCheck, module: "AUDIT_REVIEW" },
    { title: "Reports", href: "/audits/reports", icon: FileBarChart, module: "AUDIT_REPORTS" },
    { title: "Schedules", href: "/audits/schedules", icon: CalendarClock, module: "AUDIT_SCHEDULES" },
    { title: "Templates", href: "/audits/templates", icon: FileStack, module: "AUDIT_TEMPLATES" },
    { title: "Question Bank", href: "/audits/question-bank", icon: Library, module: "AUDIT_TEMPLATES" },
    { title: "Audit Admin", href: "/audits/admin", icon: SlidersHorizontal, module: "AUDIT_ADMIN" },
    { title: "Trail Explorer", href: "/audits/trail", icon: ScrollText, module: "AUDIT_TRAIL" },
  ]},
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
];
