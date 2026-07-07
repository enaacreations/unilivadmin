import * as React from "react";
import { Link } from "wouter";
import {
  Search, ChevronRight, LayoutDashboard, Building2, Wrench, Users, Truck,
  ChefHat, UtensilsCrossed, TrendingUp, Landmark, Settings, LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { navGroups, type NavItem } from "@/lib/nav";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";

const MODULE_ICON: Record<string, LucideIcon> = {
  Overview: LayoutDashboard,
  Properties: Building2,
  Operations: Wrench,
  People: Users,
  "Supply Chain": Truck,
  "Kitchen & Menu": ChefHat,
  "Food Ordering": UtensilsCrossed,
  Growth: TrendingUp,
  Finance: Landmark,
  Settings: Settings,
};

const MODULE_TINT: Record<string, string> = {
  Overview: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  Properties: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  Operations: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  People: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "Supply Chain": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "Kitchen & Menu": "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  "Food Ordering": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Growth: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  Finance: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  Settings: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

type ModuleCard = { title: string; items: NavItem[] };

function CardHeader({ m }: { m: ModuleCard }) {
  const Icon = MODULE_ICON[m.title] ?? LayoutGrid;
  return (
    <span className="group flex cursor-pointer items-center gap-3">
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", MODULE_TINT[m.title] ?? "bg-accent/10 text-accent")}>
        <Icon className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold transition-colors group-hover:text-accent">{m.title}</span>
        <span className="text-xs text-muted-foreground">{m.items.length} page{m.items.length === 1 ? "" : "s"}</span>
      </span>
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </span>
  );
}

/** App launcher — the universal post-login landing (see homeForRole): one tile
 *  per module the signed-in role can access; clicking a tile opens the
 *  module's first page. Searching surfaces matching pages as direct links so a
 *  page hit navigates precisely, not just to its module. Sourced from the same
 *  permission-filtered nav data as the sidebar. */
export default function AppLauncher() {
  const { me, can } = usePermissions();
  const [query, setQuery] = React.useState("");

  const modules = React.useMemo<ModuleCard[]>(() => {
    return navGroups
      .map((g) => ({
        title: g.title,
        items: g.items.filter((i) => i.href !== "/apps" && (!i.module || can(i.module, "view"))),
      }))
      .filter((m) => m.items.length > 0);
  }, [can]);

  // With a query: a module-title hit keeps the whole card; otherwise the card
  // survives only if pages match, and those pages render as direct links.
  const q = query.trim().toLowerCase();
  const visible = q
    ? modules
        .map((m) => m.title.toLowerCase().includes(q)
          ? { ...m, matches: [] as NavItem[] }
          : { ...m, matches: m.items.filter((i) => i.title.toLowerCase().includes(q)) })
        .filter((m) => m.title.toLowerCase().includes(q) || m.matches.length > 0)
    : modules.map((m) => ({ ...m, matches: [] as NavItem[] }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home"
        subtitle="Everything you can access, one tap away."
        action={
          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a module or page…"
              aria-label="Find a module or page"
              className="pl-9"
            />
          </div>
        }
      />

      {!me ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No modules match"
          description={q
            ? `Nothing matches “${query.trim()}”. Try a different search.`
            : "Your role has no modules assigned. Contact your administrator."}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((m) => (
            <div key={m.title} className="rounded-xl border bg-card p-4">
              <Link href={m.items[0].href}>
                <CardHeader m={m} />
              </Link>
              {m.matches.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {m.matches.map((i) => (
                    <Link key={i.href} href={i.href}>
                      <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground">
                        <i.icon className="h-3.5 w-3.5 text-muted-foreground" />
                        {i.title}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
