import * as React from "react"
import { Link, useLocation } from "wouter"
import { useAuthStore, useAppStore } from "@/lib/store"
import { useLogout, useGetMe, useGetProperties, getGetPropertiesQueryKey, useGetComplaints, getGetComplaintsQueryKey, useGetAnnouncements, getGetAnnouncementsQueryKey, useGetResidentPayments, getGetResidentPaymentsQueryKey } from "@workspace/api-client-react"
import {
  LayoutDashboard, Building2, Users, AlertCircle, WashingMachine, MessageSquare,
  UserCheck, Briefcase, GraduationCap, Truck, ClipboardList, ShoppingCart,
  PackageCheck, Boxes, ChefHat, CalendarDays, TrendingUp, MapPin,
  BookOpen, CreditCard, Shield, Settings, LogOut, Bell, Search, Menu
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"

const navGroups = [
  {
    title: "Overview",
    items: [
      { title: "Dashboard", href: "/", icon: LayoutDashboard },
    ]
  },
  {
    title: "Operations",
    items: [
      { title: "Properties", href: "/properties", icon: Building2 },
      { title: "Residents", href: "/residents", icon: Users },
      { title: "Complaints", href: "/complaints", icon: AlertCircle },
      { title: "Laundry", href: "/laundry", icon: WashingMachine },
      { title: "Communications", href: "/communications", icon: MessageSquare },
    ]
  },
  {
    title: "People",
    items: [
      { title: "Employees", href: "/employees", icon: UserCheck },
      { title: "Recruitment", href: "/recruitment", icon: Briefcase },
      { title: "Learning & Dev", href: "/courses", icon: GraduationCap },
    ]
  },
  {
    title: "Supply Chain",
    items: [
      { title: "Vendors", href: "/vendors", icon: Truck },
      { title: "Indents", href: "/indents", icon: ClipboardList },
      { title: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart },
      { title: "GRN", href: "/grn", icon: PackageCheck },
      { title: "Inventory", href: "/inventory", icon: Boxes },
    ]
  },
  {
    title: "Food",
    items: [
      { title: "Recipes", href: "/recipes", icon: ChefHat },
      { title: "Menu Planning", href: "/menu-planning", icon: CalendarDays },
    ]
  },
  {
    title: "Growth",
    items: [
      { title: "Sales CRM", href: "/leads", icon: TrendingUp },
      { title: "Property Leads", href: "/property-leads", icon: MapPin },
    ]
  },
  {
    title: "Finance",
    items: [
      { title: "Ledger", href: "/ledger", icon: BookOpen },
      { title: "Payments", href: "/payments", icon: CreditCard },
    ]
  },
  {
    title: "Settings",
    items: [
      { title: "Users & Roles", href: "/users", icon: Shield },
      { title: "Configuration", href: "/settings", icon: Settings },
    ]
  }
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { setToken } = useAuthStore();
  const { propertyId, setPropertyId } = useAppStore();
  
  const { data: userRes } = useGetMe();
  const { data: propertiesRes } = useGetProperties({ query: { queryKey: getGetPropertiesQueryKey() } });
  const logout = useLogout();

  const user = userRes?.data;
  const properties = propertiesRes?.data || [];

  // Synthesize notifications
  const { data: complaintsRes } = useGetComplaints({ limit: 5 } as any, { query: { queryKey: getGetComplaintsQueryKey({ limit: 5 } as any) } });
  const { data: announcementsRes } = useGetAnnouncements({ limit: 5 } as any, { query: { queryKey: getGetAnnouncementsQueryKey({ limit: 5 } as any) } });
  
  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        setToken(null);
        setLocation("/login");
      }
    });
  };

  // Find current page title
  let pageTitle = "Dashboard";
  navGroups.forEach(g => {
    g.items.forEach(i => {
      if (i.href === location || (i.href !== "/" && location.startsWith(i.href))) {
        pageTitle = i.title;
      }
    });
  });

  const notifications = [
    ...(complaintsRes?.data || []).map(c => ({ id: c.id, title: c.title, desc: "New Complaint" })),
    ...(announcementsRes?.data || []).map(a => ({ id: a.id, title: a.title, desc: "Announcement" }))
  ].slice(0, 5);

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 bg-primary text-primary-foreground flex flex-col h-full shrink-0 border-r border-primary shadow-xl z-20 hidden md:flex">
        <div className="p-5 flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-lg shadow-sm">U</div>
          <span className="font-display font-bold text-lg tracking-tight">Uniliv Admin</span>
        </div>
        
        <div className="px-4 pb-4 border-b border-primary-foreground/10">
          <Select value={propertyId || "all"} onValueChange={(val) => setPropertyId(val === "all" ? null : val)}>
            <SelectTrigger className="w-full bg-primary-foreground/5 border-primary-foreground/10 text-primary-foreground focus:ring-accent">
              <SelectValue placeholder="All Properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {properties.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 overflow-y-auto py-4 scrollbar-thin">
          <nav className="px-3 space-y-6">
            {navGroups.map((group) => (
              <div key={group.title}>
                <h4 className="text-[10px] uppercase text-primary-foreground/40 font-bold mb-2 tracking-widest px-3">{group.title}</h4>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                    return (
                      <Link key={item.href} href={item.href}>
                        <span className={`flex items-center gap-3 px-3 py-2 rounded-md transition-all cursor-pointer text-sm font-medium ${isActive ? 'bg-accent/10 text-accent border-l-4 border-accent' : 'text-primary-foreground/70 hover:bg-primary-foreground/5 hover:text-primary-foreground'}`}>
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

        <div className="p-4 border-t border-primary-foreground/10 mt-auto bg-primary/95">
          <div className="flex items-center gap-3">
            <UserAvatar name={user?.name} className="w-10 h-10 border border-primary-foreground/20" fallbackClassName="bg-primary-foreground/10 text-primary-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.name || "Admin User"}</p>
              <div className="flex items-center mt-0.5">
                <span className="text-[10px] uppercase tracking-wider bg-accent text-accent-foreground px-2 py-0.5 rounded-full font-bold">{user?.role || "ADMIN"}</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="text-primary-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Topbar */}
        <header className="h-16 bg-card border-b border-border flex items-center justify-between px-6 shrink-0 z-10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="md:hidden">
              <Menu className="w-5 h-5" />
            </Button>
            <h2 className="text-lg font-display font-semibold hidden sm:block">{pageTitle}</h2>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative hidden md:block w-64 lg:w-80">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input type="search" placeholder="Search residents, complaints..." className="pl-9 bg-surface border-transparent focus-visible:border-accent" />
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative">
                  <Bell className="w-5 h-5 text-muted-foreground" />
                  {notifications.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-destructive rounded-full border-2 border-card"></span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {notifications.length > 0 ? (
                  notifications.map((n, i) => (
                    <DropdownMenuItem key={i} className="flex flex-col items-start gap-1 p-3 cursor-pointer">
                      <span className="font-medium text-sm">{n.title}</span>
                      <span className="text-xs text-muted-foreground">{n.desc}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <div className="p-4 text-center text-sm text-muted-foreground">No new notifications</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                  <UserAvatar name={user?.name} className="h-8 w-8" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{user?.name}</p>
                    <p className="text-xs leading-none text-muted-foreground">{user?.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocation("/settings")}>Settings</DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6 bg-surface">
          <div className="max-w-7xl mx-auto space-y-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
