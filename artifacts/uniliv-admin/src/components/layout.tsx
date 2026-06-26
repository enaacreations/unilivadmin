import * as React from "react"
import { Link, useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthStore, useAppStore } from "@/lib/store"
import { useLogout, useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react"
import {
  LogOut, Search, Menu, ChevronDown, Check, ChevronsUpDown, Building2, Sun, Moon,
} from "lucide-react"
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { NotificationBell } from "@/components/notification-bell"
import { ThemeToggle } from "@/components/theme-toggle"
import { usePermissions } from "@/lib/use-permissions"
import { moduleForPath } from "@/lib/permissions"
import { cn } from "@/lib/utils"
import { navGroups, type NavGroup, type NavItem } from "@/lib/nav"
import { CommandPalette, type CommandNavItem } from "@/components/command-palette"

const NAV_OPEN_KEY = "uniliv_nav_open"
const SIDEBAR_KEY = "uniliv_sidebar"

/** Live greeting + date/time/day shown in the topbar (Persona st.37, st.39). */
function GreetingClock({ name }: { name?: string }) {
  const [now, setNow] = React.useState(new Date())
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const h = now.getHours()
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"
  const first = name?.split(" ")[0]
  const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", year: "numeric" })
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
  return (
    <div className="hidden lg:flex flex-col leading-tight">
      <span className="text-sm font-semibold text-foreground">{greeting}{first ? `, ${first}` : ""}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{dateStr} · {timeStr}</span>
    </div>
  )
}

function isItemActive(location: string, href: string) {
  return location === href || (href !== "/" && location.startsWith(href))
}

/** A single nav link with the gradient active-rail (no layout shift: pl-4 in both states). */
function NavLink({ item, location, onNavigate }: { item: NavItem; location: string; onNavigate?: () => void }) {
  const isActive = isItemActive(location, item.href)
  return (
    <Link href={item.href}>
      <span
        onClick={onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex items-center gap-3 pl-4 pr-3 py-2 rounded-lg transition-colors cursor-pointer text-sm hover-elevate",
          isActive
            ? "text-accent font-semibold bg-accent/5"
            : "text-sidebar-foreground/70 hover:text-sidebar-foreground",
        )}
      >
        {isActive && <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-rail-gradient" />}
        <item.icon className="w-4 h-4 shrink-0" />
        <span className="truncate">{item.title}</span>
      </span>
    </Link>
  )
}

/** Collapsible nav group with persisted open/closed state. */
function NavGroupSection({
  group, location, open, onToggle, onNavigate, divider,
}: {
  group: NavGroup
  location: string
  open: boolean
  onToggle: (title: string, open: boolean) => void
  onNavigate?: () => void
  /** Draw a hairline divider above this group (every group except the first). */
  divider?: boolean
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={(o) => onToggle(group.title, o)}
      className={cn(divider && "mt-1.5 border-t border-sidebar-border pt-1.5")}
    >
      {/* Heading hierarchy: the open group reads as a strong section label;
          collapsed groups recede. The active-item gradient rail lives on the
          item itself (NavLink), never on the heading. */}
      <CollapsibleTrigger
        className={cn(
          "group/nav flex w-full items-center justify-between px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-widest transition-colors",
          open
            ? "font-semibold text-sidebar-foreground/85"
            : "font-medium text-sidebar-foreground/55 hover:text-sidebar-foreground/80",
        )}
      >
        <span>{group.title}</span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 transition-transform duration-200",
            open ? "text-sidebar-foreground/70" : "-rotate-90 text-sidebar-foreground/40",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
        <div className="space-y-1 pt-1 pb-1">
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} location={location} onNavigate={onNavigate} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Searchable, scroll-capped property scope selector (Popover + cmdk). */
function PropertyScope({
  properties, propertyId, onSelect, className,
}: {
  properties: Array<{ id: string; name: string }>
  propertyId: string | null
  onSelect: (id: string | null) => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const current = properties.find((p) => p.id === propertyId)
  const label = propertyId ? (current?.name ?? "Property") : "All Properties"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Select property scope"
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-foreground/[0.04] px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-foreground/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            className,
          )}
        >
          <Building2 className="w-4 h-4 shrink-0 text-sidebar-foreground/60" />
          <span className="flex-1 truncate text-left">{label}</span>
          <ChevronsUpDown className="w-4 h-4 shrink-0 text-sidebar-foreground/50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-56 p-0">
        <Command>
          <CommandInput placeholder="Search properties…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No properties found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="All Properties"
                onSelect={() => { onSelect(null); setOpen(false) }}
              >
                <Check className={cn("w-4 h-4", propertyId === null ? "opacity-100" : "opacity-0")} />
                <span>All Properties</span>
              </CommandItem>
              {properties.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.name}
                  onSelect={() => { onSelect(p.id); setOpen(false) }}
                >
                  <Check className={cn("w-4 h-4", propertyId === p.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Shared sidebar inner content — reused by the desktop rail and the mobile Sheet. */
function SidebarContent({
  filteredGroups, location, openGroup, onToggleGroup, properties, propertyId, onSelectProperty,
  me, sidebarMode, onToggleSidebarMode, onLogout, onNavigate, showFooter = true,
}: {
  filteredGroups: NavGroup[]
  location: string
  openGroup: string | null
  onToggleGroup: (title: string, open: boolean) => void
  properties: Array<{ id: string; name: string }>
  propertyId: string | null
  onSelectProperty: (id: string | null) => void
  me: ReturnType<typeof usePermissions>["me"]
  sidebarMode: "light" | "espresso"
  onToggleSidebarMode: () => void
  onLogout: () => void
  onNavigate?: () => void
  showFooter?: boolean
}) {
  return (
    <>
      <div className="px-4 pb-4 border-b border-sidebar-border">
        <PropertyScope properties={properties} propertyId={propertyId} onSelect={onSelectProperty} />
      </div>
      <div className="flex-1 overflow-y-auto py-3 scrollbar-thin">
        <nav className="px-3 space-y-1">
          {filteredGroups.map((group, i) => (
            <NavGroupSection
              key={group.title}
              group={group}
              location={location}
              open={openGroup === group.title}
              onToggle={onToggleGroup}
              onNavigate={onNavigate}
              divider={i > 0}
            />
          ))}
        </nav>
      </div>
      {showFooter && (
        <div className="p-3 border-t border-sidebar-border mt-auto">
          <div className="flex items-center gap-3">
            <UserAvatar name={me?.name} className="w-9 h-9 border border-sidebar-border" fallbackClassName="bg-sidebar-foreground/10 text-sidebar-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-sidebar-foreground">{me?.name || "Admin User"}</p>
              <p className="text-[11px] text-sidebar-foreground/60 truncate">
                {me?.designation || (me?.role || "ADMIN").replace(/_/g, " ")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleSidebarMode}
              aria-label={sidebarMode === "espresso" ? "Switch to light sidebar" : "Switch to espresso sidebar"}
              title="Toggle sidebar appearance"
              className="text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-foreground/10 shrink-0 h-8 w-8"
            >
              {sidebarMode === "espresso" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onLogout}
              aria-label="Log out"
              className="text-sidebar-foreground/50 hover:text-destructive hover:bg-destructive/10 shrink-0 h-8 w-8"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-lg bg-brand-gradient flex items-center justify-center text-white font-display font-bold text-lg">U</div>
      <span className="font-display font-bold text-lg tracking-tight text-sidebar-foreground">Uniliv</span>
    </div>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation()
  const { setToken } = useAuthStore()
  const { propertyId, setPropertyId } = useAppStore()
  const { me, can } = usePermissions()
  const { data: propertiesRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } })
  const logout = useLogout()
  const queryClient = useQueryClient()
  const properties = (propertiesRes?.data || []) as Array<{ id: string; name: string }>

  const [mobileOpen, setMobileOpen] = React.useState(false)

  // Persisted sidebar appearance (light | espresso).
  const [sidebarMode, setSidebarMode] = React.useState<"light" | "espresso">(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "espresso" ? "espresso" : "light"
    } catch { return "light" }
  })
  const toggleSidebarMode = React.useCallback(() => {
    setSidebarMode((prev) => {
      const next = prev === "espresso" ? "light" : "espresso"
      try { localStorage.setItem(SIDEBAR_KEY, next) } catch { /* ignore */ }
      return next
    })
  }, [])

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        setToken(null)
        queryClient.clear() // drop all user-scoped cache so the next login starts clean
        setLocation("/login")
      },
    })
  }

  const filteredGroups = React.useMemo(
    () => navGroups
      .map((g) => ({ ...g, items: g.items.filter((i) => can(i.module, "view")) }))
      .filter((g) => g.items.length > 0),
    [can],
  )

  // Flatten permission-filtered nav for the command palette.
  const commandItems = React.useMemo<CommandNavItem[]>(
    () => filteredGroups.flatMap((g) =>
      g.items.map((i) => ({ title: i.title, href: i.href, group: g.title, icon: i.icon })),
    ),
    [filteredGroups],
  )

  // Active item + group, for page title and breadcrumb.
  const active = React.useMemo(() => {
    let found: { item: NavItem; group: string } | null = null
    filteredGroups.forEach((g) => g.items.forEach((i) => {
      if (isItemActive(location, i.href)) {
        if (!found || i.href.length > found.item.href.length) found = { item: i, group: g.title }
      }
    }))
    return found as { item: NavItem; group: string } | null
  }, [filteredGroups, location])

  // Accordion nav: exactly one group open at a time — the active route's group
  // by default; opening another collapses the rest. Everything else stays shut.
  const activeGroup = active?.group ?? null
  const [openGroup, setOpenGroup] = React.useState<string | null>(activeGroup)
  React.useEffect(() => { if (activeGroup) setOpenGroup(activeGroup) }, [activeGroup])
  const toggleGroup = React.useCallback((title: string, open: boolean) => {
    setOpenGroup(open ? title : null)
  }, [])

  const pageTitle = active?.item.title ?? "Dashboard"
  // A detail route is a deeper path than the matched nav item (e.g. /residents/:id, /food/orders/:id).
  const isDetail = !!active && location !== active.item.href && location.startsWith(active.item.href)

  React.useEffect(() => { document.title = `${pageTitle} | Uniliv` }, [pageTitle])

  const sidebarClass = cn(sidebarMode === "espresso" && "sidebar-espresso")

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "w-64 bg-sidebar text-sidebar-foreground flex flex-col h-full shrink-0 border-r border-sidebar-border z-20 hidden md:flex",
          sidebarClass,
        )}
      >
        <div className="p-5">
          <Logo />
        </div>
        <SidebarContent
          filteredGroups={filteredGroups}
          location={location}
          openGroup={openGroup}
          onToggleGroup={toggleGroup}
          properties={properties}
          propertyId={propertyId}
          onSelectProperty={setPropertyId}
          me={me}
          sidebarMode={sidebarMode}
          onToggleSidebarMode={toggleSidebarMode}
          onLogout={handleLogout}
        />
      </aside>

      {/* Mobile nav drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className={cn(
            "w-72 p-0 bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col",
            sidebarClass,
          )}
        >
          <SheetHeader className="p-5 text-left">
            <SheetTitle asChild>
              <div><Logo /></div>
            </SheetTitle>
          </SheetHeader>
          <SidebarContent
            filteredGroups={filteredGroups}
            location={location}
            openGroup={openGroup}
            onToggleGroup={toggleGroup}
            properties={properties}
            propertyId={propertyId}
            onSelectProperty={setPropertyId}
            me={me}
            sidebarMode={sidebarMode}
            onToggleSidebarMode={toggleSidebarMode}
            onLogout={handleLogout}
            onNavigate={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-card border-b border-border flex items-center justify-between px-4 sm:px-6 shrink-0 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden shrink-0"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </Button>
            {/* Page title (h2) intentionally omitted on list pages: the page renders
                its own heading below, so showing it here too is redundant. Detail pages
                keep the breadcrumb since it provides navigation context, not a duplicate. */}
            {isDetail && active ? (
              <>
                <div className="min-w-0">
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem className="hidden sm:inline-flex">
                        <BreadcrumbLink asChild>
                          <Link href={active.item.href}>{active.item.title}</Link>
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="hidden sm:inline-flex" />
                      <BreadcrumbItem>
                        <BreadcrumbPage className="font-display font-semibold text-lg text-foreground">Details</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
                <div className="hidden lg:block h-8 w-px bg-border" />
              </>
            ) : null}
            <GreetingClock name={me?.name} />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              className="hidden md:flex items-center gap-2 w-56 lg:w-72 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Search (Command-K)"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Search…</span>
              <kbd className="pointer-events-none hidden lg:inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-card px-1.5 font-mono text-[10px] font-medium text-muted-foreground">⌘K</kbd>
            </button>
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 bg-surface">
          <div className="max-w-7xl mx-auto space-y-6">{children}</div>
        </main>
      </div>

      {/* ⌘K command palette — self-manages its own open state. */}
      <CommandPalette items={commandItems} />
    </div>
  )
}

export function PageGuard({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const { me, can } = usePermissions()
  const Forbidden = React.lazy(() => import("@/pages/forbidden"))
  const mod = moduleForPath(location)
  if (!me) return <>{children}</> // loading — let children render skeleton
  if (mod && !can(mod, "view")) return <React.Suspense fallback={null}><Forbidden /></React.Suspense>
  return <>{children}</>
}
