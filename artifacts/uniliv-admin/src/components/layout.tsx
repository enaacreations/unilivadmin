import * as React from "react"
import { Link, useLocation } from "wouter"
import { useAuthStore, useAppStore } from "@/lib/store"
import { useLogout, useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react"
import {
  LayoutDashboard, Building2, Users, AlertCircle, WashingMachine, MessageSquare,
  UserCheck, Briefcase, GraduationCap, Truck, ClipboardList, ShoppingCart,
  PackageCheck, Boxes, ChefHat, CalendarDays, TrendingUp, MapPin,
  BookOpen, CreditCard, Shield, Settings, LogOut, Search, Menu, BarChart3,
  Repeat, BellRing, Landmark, Receipt, Wrench, Zap, ClipboardCheck, Radio, Wallet,
  UtensilsCrossed, ListOrdered, FilePlus2, Soup, Send, CheckCircle2, Trash2, SlidersHorizontal
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { NotificationBell } from "@/components/notification-bell"
import { ThemeToggle } from "@/components/theme-toggle"
import { usePermissions } from "@/lib/use-permissions"
import { moduleForPath, type Module } from "@/lib/permissions"

const navGroups: Array<{ title: string; items: Array<{ title: string; href: string; icon: any; module: Module }> }> = [
  { title: "Overview", items: [
    { title: "Dashboard", href: "/", icon: LayoutDashboard, module: "DASHBOARD" },
    { title: "Executive", href: "/dashboard/executive", icon: BarChart3, module: "EXECUTIVE_DASHBOARD" },
  ]},
  { title: "Operations", items: [
    { title: "Properties", href: "/properties", icon: Building2, module: "PROPERTIES" },
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
  { title: "Food", items: [
    { title: "Recipes", href: "/recipes", icon: ChefHat, module: "RECIPES" },
    { title: "Menu Planning", href: "/menu-planning", icon: CalendarDays, module: "MENU_PLANNING" },
  ]},
  { title: "Food Ordering", items: [
    { title: "Dashboard", href: "/food/dashboard", icon: UtensilsCrossed, module: "FOOD_DASHBOARD" },
    { title: "All Orders", href: "/food/orders", icon: ListOrdered, module: "FOOD_ALL_ORDERS" },
    { title: "Place Order", href: "/food/place-order", icon: FilePlus2, module: "FOOD_PLACE_ORDER" },
    { title: "Active Guests", href: "/food/guests", icon: Users, module: "FOOD_DASHBOARD" },
    { title: "Kitchen Summary", href: "/food/kitchen-summary", icon: Soup, module: "FOOD_KITCHEN_SUMMARY" },
    { title: "Dispatch", href: "/food/dispatch", icon: Send, module: "FOOD_DISPATCH" },
    { title: "Confirm Delivery", href: "/food/confirm-delivery", icon: CheckCircle2, module: "FOOD_CONFIRM_DELIVERY" },
    { title: "Waste Tracking", href: "/food/waste", icon: Trash2, module: "FOOD_WASTE_TRACKING" },
    { title: "Reports", href: "/food/reports", icon: BarChart3, module: "FOOD_REPORTS" },
    { title: "Settings", href: "/food/settings", icon: SlidersHorizontal, module: "FOOD_SETTINGS" },
  ]},
  { title: "Growth", items: [
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
    { title: "Users & Roles", href: "/users", icon: Shield, module: "USERS" },
    { title: "Configuration", href: "/settings", icon: Settings, module: "SETTINGS" },
  ]}
];

/** Live greeting + date/time/day shown in the topbar (Persona st.37, st.39). */
function GreetingClock({ name }: { name?: string }) {
  const [now, setNow] = React.useState(new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  const h = now.getHours();
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const first = name?.split(" ")[0];
  const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="hidden lg:flex flex-col leading-tight">
      <span className="text-sm font-semibold text-foreground">{greeting}{first ? `, ${first}` : ""}</span>
      <span className="text-xs text-muted-foreground">{dateStr} · {timeStr}</span>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { setToken } = useAuthStore();
  const { propertyId, setPropertyId } = useAppStore();
  const { me, can } = usePermissions();
  const { data: propertiesRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const logout = useLogout();
  const properties = propertiesRes?.data || [];

  const handleLogout = () => {
    logout.mutate(undefined, { onSettled: () => { setToken(null); setLocation("/login"); } });
  };

  const filteredGroups = navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => can(i.module, "view")) }))
    .filter((g) => g.items.length > 0);

  let pageTitle = "Dashboard";
  filteredGroups.forEach((g) => g.items.forEach((i) => {
    if (i.href === location || (i.href !== "/" && location.startsWith(i.href))) pageTitle = i.title;
  }));

  React.useEffect(() => { document.title = `${pageTitle} | Uniliv Admin`; }, [pageTitle]);

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      <div className="w-64 bg-sidebar text-sidebar-foreground flex flex-col h-full shrink-0 border-r border-sidebar shadow-xl z-20 hidden md:flex">
        <div className="p-5 flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-lg shadow-sm">U</div>
          <span className="font-display font-bold text-lg tracking-tight">Uniliv Admin</span>
        </div>
        <div className="px-4 pb-4 border-b border-sidebar-foreground/10">
          <Select value={propertyId || "all"} onValueChange={(val) => setPropertyId(val === "all" ? null : val)}>
            <SelectTrigger className="w-full bg-sidebar-foreground/5 border-sidebar-foreground/10 text-sidebar-foreground focus:ring-accent">
              <SelectValue placeholder="All Properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 overflow-y-auto py-4 scrollbar-thin">
          <nav className="px-3 space-y-6">
            {filteredGroups.map((group) => (
              <div key={group.title}>
                <h4 className="text-[10px] uppercase text-sidebar-foreground/40 font-bold mb-2 tracking-widest px-3">{group.title}</h4>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                    return (
                      <Link key={item.href} href={item.href}>
                        <span className={`flex items-center gap-3 px-3 py-2 rounded-md transition-all cursor-pointer text-sm font-medium ${isActive ? 'bg-accent/10 text-accent border-l-4 border-accent' : 'text-sidebar-foreground/70 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground'}`}>
                          <item.icon className="w-4 h-4" />
                          {item.title}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </div>
        <div className="p-4 border-t border-sidebar-foreground/10 mt-auto bg-sidebar/95">
          <div className="flex items-center gap-3">
            <UserAvatar name={me?.name} className="w-10 h-10 border border-sidebar-foreground/20" fallbackClassName="bg-sidebar-foreground/10 text-sidebar-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{me?.name || "Admin User"}</p>
              {me?.designation && <p className="text-[11px] text-sidebar-foreground/60 truncate">{me.designation}</p>}
              <div className="flex items-center mt-0.5">
                <span className="text-[10px] uppercase tracking-wider bg-accent text-accent-foreground px-2 py-0.5 rounded-full font-bold">{(me?.role || "ADMIN").replace(/_/g, " ")}</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="text-sidebar-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-card border-b border-border flex items-center justify-between px-6 shrink-0 z-10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="md:hidden"><Menu className="w-5 h-5" /></Button>
            <h2 className="text-lg font-display font-semibold hidden sm:block">{pageTitle}</h2>
            <div className="hidden lg:block h-8 w-px bg-border" />
            <GreetingClock name={me?.name} />
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden md:block w-64 lg:w-80">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input type="search" placeholder="Search residents, complaints..." className="pl-9 bg-surface border-transparent focus-visible:border-accent" />
            </div>
            <ThemeToggle />
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                  <UserAvatar name={me?.name} className="h-8 w-8" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{me?.name}</p>
                    {me?.designation && <p className="text-xs leading-none text-muted-foreground">{me.designation}</p>}
                    <p className="text-xs leading-none text-muted-foreground">{me?.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocation("/settings")}>Settings</DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6 bg-surface">
          <div className="max-w-7xl mx-auto space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageGuard({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { me, can } = usePermissions();
  const Forbidden = React.lazy(() => import("@/pages/forbidden"));
  const mod = moduleForPath(location);
  if (!me) return <>{children}</>; // loading — let children render skeleton
  if (mod && !can(mod, "view")) return <React.Suspense fallback={null}><Forbidden /></React.Suspense>;
  return <>{children}</>;
}
