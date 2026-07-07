import * as React from "react"
import { Link, useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthStore, useAppStore } from "@/lib/store"
import { useLogout, useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react"
import {
  LogOut, Search, Menu, Check, ChevronsUpDown, Building2,
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
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { UserAvatar } from "@/components/ui/user-avatar"
import { NotificationBell } from "@/components/notification-bell"
import { ThemeToggle } from "@/components/theme-toggle"
import { usePermissions } from "@/lib/use-permissions"
import { moduleForPath } from "@/lib/permissions"
import { cn } from "@/lib/utils"
import { navGroups, type NavGroup, type NavItem } from "@/lib/nav"
import { CommandPalette, type CommandNavItem } from "@/components/command-palette"

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

/** The open module's pages, under a static module label. The sidebar shows
 *  only the module the user is inside; switching modules happens through the
 *  pinned Home launcher (or ⌘K, which searches everything). */
function ActiveModuleSection({
  group, location, onNavigate,
}: {
  group: NavGroup
  location: string
  onNavigate?: () => void
}) {
  return (
    <div className="mt-1.5 border-t border-sidebar-border pt-1.5">
      <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/85">
        {group.title}
      </p>
      <div className="space-y-1 pt-1 pb-1">
        {group.items.map((item) => (
          <NavLink key={item.href} item={item} location={location} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  )
}

/** Searchable, scroll-capped property scope selector (Popover + cmdk). */
function PropertyScope({
  properties, propertyId, onSelect, className, tone = "sidebar",
}: {
  properties: Array<{ id: string; name: string }>
  propertyId: string | null
  onSelect: (id: string | null) => void
  className?: string
  /** "sidebar" tints to the sidebar surface; "header" tints to the card header. */
  tone?: "sidebar" | "header"
}) {
  const [open, setOpen] = React.useState(false)
  const current = properties.find((p) => p.id === propertyId)
  const label = propertyId ? (current?.name ?? "Property") : "All Properties"
  const toneCls = tone === "header"
    ? "border-border bg-surface text-foreground hover:bg-muted/50"
    : "border-sidebar-border bg-sidebar-foreground/[0.04] text-sidebar-foreground hover:bg-sidebar-foreground/[0.07]"
  const mutedCls = tone === "header" ? "text-muted-foreground" : "text-sidebar-foreground/60"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Select property scope"
          className={cn(
            "items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            toneCls,
            className,
          )}
        >
          <Building2 className={cn("w-4 h-4 shrink-0", mutedCls)} />
          <span className="flex-1 truncate text-left">{label}</span>
          <ChevronsUpDown className={cn("w-4 h-4 shrink-0", mutedCls)} />
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
  filteredGroups, location, activeGroup, properties, propertyId, onSelectProperty,
  me, onLogout, onNavigate, showFooter = true, showPropertyScope = true,
}: {
  filteredGroups: NavGroup[]
  location: string
  /** Title of the module the current route belongs to (null on module-less pages). */
  activeGroup: string | null
  properties: Array<{ id: string; name: string }>
  propertyId: string | null
  onSelectProperty: (id: string | null) => void
  me: ReturnType<typeof usePermissions>["me"]
  onLogout: () => void
  onNavigate?: () => void
  showFooter?: boolean
  /** Hidden on desktop (the property scope lives in the header there); shown in the mobile drawer. */
  showPropertyScope?: boolean
}) {
  return (
    <>
      {showPropertyScope && (
        <div className="px-4 pb-4 border-b border-sidebar-border">
          <PropertyScope properties={properties} propertyId={propertyId} onSelect={onSelectProperty} className="flex w-full" />
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-3 scrollbar-thin">
        <nav className="px-3 space-y-1">
          {/* Pinned links (the "Home" group: the module launcher) — always visible. */}
          {filteredGroups.filter((g) => g.title === "Home").map((group) => (
            <div key={group.title} className="space-y-1">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} location={location} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
          {/* Only the module the user is inside — no other groups. */}
          {activeGroup && activeGroup !== "Home" && filteredGroups
            .filter((g) => g.title === activeGroup)
            .map((group) => (
              <ActiveModuleSection key={group.title} group={group} location={location} onNavigate={onNavigate} />
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

/** Pretty-prints a UserRole enum ("UNIT_LEAD" → "Unit Lead"). */
const roleLabel = (r?: string) =>
  r ? r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : ""

function Logo({ personaLabel }: { personaLabel?: string }) {
  return (
    <div className="flex items-center gap-2">
      <img src="/brand/uniliv-logo.svg" alt="Uniliv" className="h-8 w-auto select-none" draggable={false} />
      {personaLabel ? (
        <Badge variant="secondary" className="ml-auto text-[10px] font-medium leading-none px-2 py-0.5">
          {personaLabel}
        </Badge>
      ) : null}
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

  // Persona/role pill shown next to the wordmark (undefined while `me` loads).
  const personaLabel = me ? (me.designation || roleLabel(me.role)) || undefined : undefined

  const [mobileOpen, setMobileOpen] = React.useState(false)

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
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.module || can(i.module, "view")) }))
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

  // The sidebar shows only the active route's module (plus the pinned links);
  // there is no group accordion — modules are switched via the /apps launcher.
  const activeGroup = active?.group ?? null

  // The launcher (/apps) is a full-width page: no sidebar, logo in the header.
  const isLauncher = location === "/apps"

  const pageTitle = active?.item.title ?? "Dashboard"
  // A detail route is a deeper path than the matched nav item (e.g. /residents/:id, /food/orders/:id).
  const isDetail = !!active && location !== active.item.href && location.startsWith(active.item.href)

  React.useEffect(() => { document.title = `${pageTitle} | Uniliv` }, [pageTitle])

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      {/* Desktop sidebar — hidden on the launcher, which is the module switcher itself */}
      {!isLauncher && <aside
        className="w-64 bg-sidebar text-sidebar-foreground flex flex-col h-full shrink-0 border-r border-sidebar-border z-20 hidden md:flex"
      >
        <div className="pl-7 pr-5 py-4 border-b border-sidebar-border">
          <Logo personaLabel={personaLabel} />
        </div>
        <SidebarContent
          filteredGroups={filteredGroups}
          location={location}
          activeGroup={activeGroup}
          properties={properties}
          propertyId={propertyId}
          onSelectProperty={setPropertyId}
          me={me}
          onLogout={handleLogout}
          showPropertyScope={false}
        />
      </aside>}

      {/* Mobile nav drawer */}
      {!isLauncher && <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 p-0 bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col"
        >
          <SheetHeader className="p-5 text-left">
            <SheetTitle asChild>
              <div><Logo personaLabel={personaLabel} /></div>
            </SheetTitle>
          </SheetHeader>
          <SidebarContent
            filteredGroups={filteredGroups}
            location={location}
            activeGroup={activeGroup}
            properties={properties}
            propertyId={propertyId}
            onSelectProperty={setPropertyId}
            me={me}
            onLogout={handleLogout}
            onNavigate={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>}

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-card border-b border-border grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6 shrink-0 z-10">
          <div className="flex items-center gap-3 min-w-0">
            {isLauncher ? (
              /* The launcher has no sidebar, so the brand lives in the header here. */
              <Logo personaLabel={personaLabel} />
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden shrink-0"
                  aria-label="Open navigation"
                  onClick={() => setMobileOpen(true)}
                >
                  <Menu className="w-5 h-5" />
                </Button>
                {/* Page heading lives in the page body. The detail-page breadcrumb is
                    rendered as a bar at the top of <main>, not in the header. */}
                <GreetingClock name={me?.name} />
              </>
            )}
          </div>

          {/* Centered global search — the auto-width middle column with 1fr on each
              side keeps it centered in the header regardless of the side content. */}
          <button
            type="button"
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="hidden md:flex items-center gap-2 w-72 lg:w-96 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Search (Command-K)"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="pointer-events-none hidden lg:inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-card px-1.5 font-mono text-[10px] font-medium text-muted-foreground">⌘K</kbd>
          </button>

          <div className="flex items-center justify-end gap-2">
            <ThemeToggle />
            <NotificationBell />
            <PropertyScope
              tone="header"
              properties={properties}
              propertyId={propertyId}
              onSelect={setPropertyId}
              className="hidden md:flex w-44 lg:w-56"
            />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 bg-surface">
          <div className="max-w-7xl mx-auto space-y-6">
            {isDetail && active ? (
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden sm:inline-flex">
                    <BreadcrumbLink asChild>
                      <Link href={active.item.href}>{active.item.title}</Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:inline-flex" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Details</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            ) : null}
            {children}
          </div>
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
