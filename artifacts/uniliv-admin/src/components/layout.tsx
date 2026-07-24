import * as React from "react"
import { Link, useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthStore } from "@/lib/store"
import { useLogout } from "@workspace/api-client-react"
import {
  LogOut, Search, Menu, ChevronLeft, LayoutGrid,
} from "lucide-react"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

function isItemActive(location: string, href: string) {
  return location === href || (href !== "/" && location.startsWith(href))
}

/** Desktop rail nav link — collapses to a centred icon; expanded shows the
 *  label. Active state gets the 3px gradient rail + accent tint. */
function RailNavLink({
  item, location, collapsed,
}: {
  item: NavItem
  location: string
  collapsed: boolean
}) {
  const isActive = isItemActive(location, item.href)
  return (
    <Link href={item.href}>
      <span
        title={item.title}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex items-center rounded-[10px] text-sm transition-colors cursor-pointer w-full",
          collapsed ? "justify-center py-[11px]" : "gap-2.5 pl-4 pr-3.5 py-2.5",
          isActive
            ? "bg-accent/5 text-accent-strong font-semibold"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {isActive && (
          <span aria-hidden className="absolute left-0 top-[7px] bottom-[7px] w-[3px] rounded-full bg-rail-gradient" />
        )}
        <item.icon className="h-[17px] w-[17px] shrink-0" />
        {!collapsed && <span className="flex-1 truncate text-left">{item.title}</span>}
      </span>
    </Link>
  )
}

/** The collapsible desktop sidebar (68px ↔ 248px), shown inside modules only.
 *  Head: logo (expanded) + collapse toggle. Then a pinned "All Modules" link
 *  back to the launcher, the module's label, and its pages. */
function DesktopSidebar({
  activeModule, location, collapsed, onToggle,
}: {
  activeModule: NavGroup | null
  location: string
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <aside
      className={cn(
        "hidden md:flex flex-col h-full shrink-0 bg-card border-r border-border z-20 overflow-y-auto overflow-x-hidden transition-[width] duration-200 gap-0.5",
        collapsed ? "w-[68px] px-2.5 pb-3.5" : "w-[248px] px-3 pb-3.5",
      )}
    >
      {collapsed ? (
        /* Collapsed head — the square brand mark stacked over the expand
           toggle, so the brand stays visible even as an icon rail. */
        <div className="-mx-2.5 mb-2.5 flex shrink-0 flex-col items-center gap-2 border-b border-border py-3">
          <Link href="/apps">
            <img
              src="/brand/uniliv-mark.svg"
              alt="Uniliv"
              className="h-9 w-9 shrink-0 cursor-pointer select-none rounded-[10px]"
              draggable={false}
            />
          </Link>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            className="flex h-7 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted"
          >
            <ChevronLeft className="h-[15px] w-[15px] rotate-180" />
          </button>
        </div>
      ) : (
        <div className="-mx-3 mb-2.5 flex h-16 shrink-0 items-center justify-between border-b border-border pl-5 pr-3.5">
          <Link href="/apps">
            <img
              src="/brand/uniliv-logo.svg"
              alt="Uniliv"
              className="h-8 w-auto shrink-0 cursor-pointer select-none"
              draggable={false}
            />
          </Link>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted"
          >
            <ChevronLeft className="h-[15px] w-[15px]" />
          </button>
        </div>
      )}

      <Link href="/apps">
        <span
          title="All Modules"
          className={cn(
            "flex items-center rounded-[10px] text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer w-full",
            collapsed ? "justify-center py-[11px]" : "gap-2.5 px-3.5 py-2.5",
          )}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="flex-1 truncate text-left">All Modules</span>}
        </span>
      </Link>

      {activeModule && (
        collapsed ? (
          <div aria-hidden className="mx-0.5 mt-2.5 mb-1 border-t border-border" />
        ) : (
          <p className="mx-0.5 mt-2.5 mb-1 border-t border-border pt-3 pl-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {activeModule.title}
          </p>
        )
      )}

      <nav className="flex flex-col gap-0.5">
        {activeModule?.items.map((item) => (
          <RailNavLink key={item.href} item={item} location={location} collapsed={collapsed} />
        ))}
      </nav>
    </aside>
  )
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

/* The former PropertyScope selector (Popover + cmdk) was removed with the
   redesign — property scoping now lives on the pages that need it (e.g. the
   Food journey's property Select). See git history to resurrect it. */

/** Shared sidebar inner content — used by the mobile Sheet drawer. */
function SidebarContent({
  filteredGroups, location, activeGroup,
  me, onLogout, onNavigate, showFooter = true,
}: {
  filteredGroups: NavGroup[]
  location: string
  /** Title of the module the current route belongs to (null on module-less pages). */
  activeGroup: string | null
  me: ReturnType<typeof usePermissions>["me"]
  onLogout: () => void
  onNavigate?: () => void
  showFooter?: boolean
}) {
  return (
    <>
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
    <div className="flex items-center gap-2 min-w-0">
      <img src="/brand/uniliv-logo.svg" alt="Uniliv" className="h-8 w-auto shrink-0 select-none" draggable={false} />
      {personaLabel ? (
        <Badge
          variant="secondary"
          title={personaLabel}
          className="ml-auto hidden min-w-0 max-w-full sm:inline-flex text-[10px] font-medium leading-none px-2 py-0.5"
        >
          <span className="min-w-0 truncate">{personaLabel}</span>
        </Badge>
      ) : null}
    </div>
  )
}

/** Account menu in the header (top-right). Present on every page — including the
 *  launcher, which has no sidebar (and therefore no other logout affordance). */
function HeaderUserMenu({ name, subtitle, onLogout }: {
  name?: string
  subtitle?: string
  onLogout: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-[38px] w-[38px] shrink-0 rounded-full" aria-label="Account menu">
          <UserAvatar
            name={name}
            className="h-[38px] w-[38px]"
            fallbackClassName="bg-brand-gradient text-white font-bold text-sm font-display"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{name || "User"}</span>
          {subtitle ? (
            <span className="truncate text-xs font-normal text-muted-foreground">{subtitle}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} className="text-destructive focus:text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation()
  const { setToken } = useAuthStore()
  const { me, can, role } = usePermissions()
  const logout = useLogout()
  const queryClient = useQueryClient()

  // Persona/role pill shown next to the wordmark (undefined while `me` loads).
  const personaLabel = me ? (me.designation || roleLabel(me.role)) || undefined : undefined

  const [mobileOpen, setMobileOpen] = React.useState(false)

  // Desktop sidebar: opens EXPANDED (248px, text menu) by default for
  // readability; collapsing to the 68px icon rail is a within-session choice.
  // Deliberately NOT persisted.
  const [collapsed, setCollapsed] = React.useState(false)
  const toggleCollapsed = React.useCallback(() => setCollapsed((c) => !c), [])

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
      .map((g) => ({
        ...g,
        items: g.items.filter((i) =>
          (!i.module || can(i.module, "view")) &&
          !(role && i.hideFor?.includes(role)),
        ),
      }))
      .filter((g) => g.items.length > 0),
    [can, role],
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
  //
  // Detail/sub pages whose exact path isn't a nav item (e.g. /audits/:id, whose
  // nav items are /audits/register, /audits/my, … with no bare /audits item)
  // won't match above and would collapse the sidebar to just Home. Fall back to
  // the route's module (via PATH_TO_MODULE) and show that module's group, so the
  // sidebar stays put on every detail screen across all modules.
  //
  // The owning group is resolved from the UNfiltered nav: a persona may have the
  // route's own item folded away by hideFor (e.g. Reports lives inside the
  // Dashboard hub for OPS_EXCELLENCE, so /audits/reports/:id has no visible
  // AUDIT_REPORTS item) — the sidebar must still show their audit hub items.
  const activeGroup = React.useMemo(() => {
    if (active) return active.group
    const mod = moduleForPath(location)
    if (!mod) return null
    const owner = navGroups.find((g) => g.items.some((i) => i.module === mod))
    if (!owner) return null
    return filteredGroups.find((g) => g.title === owner.title)?.title ?? null
  }, [active, location, filteredGroups])

  // The launcher (/apps) is a full-width page: no sidebar, logo in the header.
  const isLauncher = location === "/apps"

  // The group object for the module the user is inside (drives the desktop rail).
  const activeModuleGroup = React.useMemo(
    () => (activeGroup && activeGroup !== "Home"
      ? filteredGroups.find((g) => g.title === activeGroup) ?? null
      : null),
    [activeGroup, filteredGroups],
  )

  // Pages without a nav item (e.g. /food/track) fall back to their module's
  // group title so the tab doesn't misleadingly read "Dashboard".
  const pageTitle = active?.item.title ?? activeGroup ?? "Home"
  // A detail route is a deeper path than the matched nav item (e.g. /residents/:id, /food/orders/:id).
  const isDetail = !!active && location !== active.item.href && location.startsWith(active.item.href)

  React.useEffect(() => { document.title = `${pageTitle} | Uniliv` }, [pageTitle])

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      {/* Desktop sidebar — hidden on the launcher, which is the module switcher itself */}
      {!isLauncher && (
        <DesktopSidebar
          activeModule={activeModuleGroup}
          location={location}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
        />
      )}

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
            me={me}
            onLogout={handleLogout}
            onNavigate={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>}

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-card border-b border-border flex items-center gap-4 px-4 sm:px-6 shrink-0 z-10">
          {isLauncher ? (
            /* The launcher has no sidebar, so the brand lives in the header here. */
            <Link href="/apps" className="shrink-0">
              <Logo personaLabel={personaLabel} />
            </Link>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden shrink-0"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </Button>
          )}

          {/* Global search — left-aligned pill (prototype), opens the ⌘K palette. */}
          <button
            type="button"
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="hidden md:flex items-center gap-2 w-80 rounded-[10px] border border-border bg-surface px-3 py-[9px] text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Search (Command-K)"
          >
            <Search className="h-[15px] w-[15px] shrink-0" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="pointer-events-none hidden lg:inline-flex h-5 select-none items-center gap-0.5 rounded-[5px] border border-border bg-card px-1.5 font-mono text-[10px] font-medium text-muted-foreground">⌘K</kbd>
          </button>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <NotificationBell />
            <HeaderUserMenu name={me?.name} subtitle={personaLabel} onLogout={handleLogout} />
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
