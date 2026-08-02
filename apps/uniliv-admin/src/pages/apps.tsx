import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Building2, Wrench, Users, Truck,
  ChefHat, UtensilsCrossed, TrendingUp, Landmark, Settings, LayoutGrid,
  ClipboardCheck, MapPin,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { navGroups, type NavItem } from "@/lib/nav";
import { usePermissions } from "@/lib/use-permissions";
import { useAppStore } from "@/lib/store";
import { foodApi, foodKeys } from "@/lib/food-api";

const MODULE_ICON: Record<string, LucideIcon> = {
  Overview: LayoutDashboard,
  Properties: Building2,
  Operations: Wrench,
  People: Users,
  "Supply Chain": Truck,
  "Kitchen & Menu": ChefHat,
  Food: UtensilsCrossed,
  Audits: ClipboardCheck,
  Growth: TrendingUp,
  Finance: Landmark,
  Settings: Settings,
};

// One-line purpose per module — shown under the name and searched with it.
const MODULE_DESC: Record<string, string> = {
  Overview: "KPIs and the day at a glance",
  Properties: "Buildings, rooms and beds",
  Operations: "Rooms, residents and upkeep",
  People: "Employees, attendance and hiring",
  "Supply Chain": "Vendors, orders and stock",
  "Kitchen & Menu": "Recipes and menu planning",
  Food: "Order food, confirm deliveries, track waste",
  Audits: "Your checks, findings and scores",
  Growth: "Leads and sales pipeline",
  Finance: "Ledger, payments and billing",
  Settings: "Users, roles and configuration",
};

// Gradient identity per module: [iconGradFrom, iconGradTo, cardTint, cardTint2].
// Food and Audits come straight from the design prototype; the rest are
// assigned distinct pairs in the same vivid language.
const MODULE_TINT: Record<string, [string, string, string, string]> = {
  Food: ["#FF9A3D", "#F2603C", "#FF9A3D", "#C2459A"],
  Audits: ["#7C5CFF", "#C2459A", "#9B82FF", "#C2459A"],
  Overview: ["#3666CF", "#6FA0F0", "#6FA0F0", "#7C5CFF"],
  Properties: ["#0EA5A5", "#3666CF", "#2CB9B9", "#3666CF"],
  Operations: ["#0891B2", "#0EA5A5", "#22B8CF", "#0EA5A5"],
  People: ["#E85D75", "#C2459A", "#E85D75", "#C2459A"],
  "Supply Chain": ["#D97706", "#E8602C", "#E5A13D", "#E8602C"],
  "Kitchen & Menu": ["#F2603C", "#C2459A", "#F2703A", "#C2459A"],
  Growth: ["#16A34A", "#0EA5A5", "#34C58A", "#0EA5A5"],
  Finance: ["#157F5B", "#3666CF", "#34A57F", "#3666CF"],
  Settings: ["#8B7D72", "#5C5049", "#8B7D72", "#5C5049"],
};
const FALLBACK_TINT: [string, string, string, string] = ["#FF9A3D", "#F2603C", "#FF9A3D", "#C2459A"];

// Preferred landing page when a module tile is clicked (falls back to the
// module's first accessible page). Food opens its dashboard, not /home.
const MODULE_HOME: Record<string, string> = {
  Food: "/food/dashboard",
  // Conducting personas (UL/CM/CX/OE) land on their My Audits home; oversight
  // roles lack AUDIT_EXECUTION so /audits/my isn't in their filtered items and
  // this falls back to their first page (the Audit Dashboard).
  Audits: "/audits/my",
};

type ModuleCard = { title: string; items: NavItem[] };

/** Square gradient-tinted module tile (prototype: aspect-1/1, 58px gradient
 *  icon badge, name in the display face). */
function ModuleTile({ m }: { m: ModuleCard }) {
  const Icon = MODULE_ICON[m.title] ?? LayoutGrid;
  const [gradFrom, gradTo, tint, tint2] = MODULE_TINT[m.title] ?? FALLBACK_TINT;
  const href = m.items.find((i) => i.href === MODULE_HOME[m.title])?.href ?? m.items[0].href;
  return (
    <Link href={href}>
      <button
        type="button"
        className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-3.5 rounded-[18px] p-5 text-center transition-[transform,box-shadow] duration-150 hover:-translate-y-[3px] hover:shadow-[0_10px_28px_rgba(36,26,21,0.10)]"
        style={{
          background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 26%, var(--card)) 0%, color-mix(in srgb, ${tint} 8%, var(--card)) 55%, color-mix(in srgb, ${tint2} 18%, var(--card)) 100%)`,
          border: `1px solid color-mix(in srgb, ${tint} 45%, var(--border))`,
          boxShadow: `0 4px 14px color-mix(in srgb, ${tint} 14%, transparent)`,
        }}
      >
        <span
          className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-2xl text-white"
          style={{
            background: `linear-gradient(135deg, ${gradFrom} 0%, ${gradTo} 100%)`,
            boxShadow: `0 6px 16px color-mix(in srgb, ${tint} 35%, transparent)`,
          }}
        >
          <Icon className="h-[30px] w-[30px]" />
        </span>
        <span className="font-display text-base font-bold tracking-[-0.012em] text-foreground">
          {m.title}
        </span>
      </button>
    </Link>
  );
}

// Cycling gradient palette for workspace tiles (used when a single-module
// persona's launcher explodes its group into one tile per workspace, so the
// grid stays colourful instead of seven identical warm tiles).
const WORKSPACE_TINTS: Array<[string, string, string, string]> = [
  ["#FF9A3D", "#F2603C", "#FF9A3D", "#C2459A"],
  ["#7C5CFF", "#C2459A", "#9B82FF", "#C2459A"],
  ["#0EA5A5", "#3666CF", "#2CB9B9", "#3666CF"],
  ["#16A34A", "#0EA5A5", "#34C58A", "#0EA5A5"],
  ["#3666CF", "#6FA0F0", "#6FA0F0", "#7C5CFF"],
  ["#E85D75", "#C2459A", "#E85D75", "#C2459A"],
  ["#D97706", "#E8602C", "#E5A13D", "#E8602C"],
];

/** One tile per workspace (nav item) — used for single-module personas (F&B
 *  manager, unit lead) so the launcher shows their actual workspaces, not one
 *  lonely module tile. Same visual language as ModuleTile. */
function WorkspaceTile({ item, index }: { item: NavItem; index: number }) {
  const Icon = item.icon;
  const [gradFrom, gradTo, tint, tint2] = WORKSPACE_TINTS[index % WORKSPACE_TINTS.length];
  return (
    <Link href={item.href}>
      <button
        type="button"
        className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-3.5 rounded-[18px] p-5 text-center transition-[transform,box-shadow] duration-150 hover:-translate-y-[3px] hover:shadow-[0_10px_28px_rgba(36,26,21,0.10)]"
        style={{
          background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 26%, var(--card)) 0%, color-mix(in srgb, ${tint} 8%, var(--card)) 55%, color-mix(in srgb, ${tint2} 18%, var(--card)) 100%)`,
          border: `1px solid color-mix(in srgb, ${tint} 45%, var(--border))`,
          boxShadow: `0 4px 14px color-mix(in srgb, ${tint} 14%, transparent)`,
        }}
      >
        <span
          className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-2xl text-white"
          style={{
            background: `linear-gradient(135deg, ${gradFrom} 0%, ${gradTo} 100%)`,
            boxShadow: `0 6px 16px color-mix(in srgb, ${tint} 35%, transparent)`,
          }}
        >
          <Icon className="h-[30px] w-[30px]" />
        </span>
        <span className="font-display text-base font-bold tracking-[-0.012em] text-foreground">
          {item.title}
        </span>
      </button>
    </Link>
  );
}

/** Time-of-day greeting. Instead of a per-minute tick (1,440 pointless
 *  re-renders/day), schedule exactly ONE timeout for the next boundary
 *  (noon / 5 pm / midnight) and re-render only when the greeting changes. */
function useGreeting() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const boundaries = [12, 17, 24];
    const nextHour = boundaries.find((h) => h > now.getHours())!;
    const next = new Date(now);
    next.setHours(nextHour, 0, 0, 0);
    const t = setTimeout(() => setNow(new Date()), next.getTime() - now.getTime() + 1_000);
    return () => clearTimeout(t);
  }, [now]);
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** App launcher — the universal post-login landing (see homeForRole): a
 *  personal greeting hero, then one gradient tile per module the signed-in
 *  role can access. Searching filters the modules; precise page search is the
 *  command palette (Cmd/Ctrl-K). Sourced from the same permission-filtered
 *  nav data as the sidebar. */
export default function AppLauncher() {
  const { me, can, role } = usePermissions();
  const { propertyId } = useAppStore();
  const greeting = useGreeting();

  // Property line under the greeting — resolved from the food property cards
  // (food roles can't read /properties). Falls back to the persona label.
  const canFood = !!me && can("FOOD_DASHBOARD", "view");
  const { data: myProps } = useQuery({
    queryKey: foodKeys.myProperties(),
    queryFn: () => foodApi.myProperties(),
    enabled: canFood,
    staleTime: 300_000,
  });
  const property = React.useMemo(() => {
    if (!myProps?.length) return null;
    return (
      myProps.find((p) => p.id === propertyId) ??
      myProps.find((p) => p.id === me?.propertyId) ??
      (myProps.length === 1 ? myProps[0] : null)
    );
  }, [myProps, propertyId, me?.propertyId]);

  const first = me?.name?.split(" ")[0];
  const subtitle = property
    ? [property.name, property.city].filter(Boolean).join(" · ")
    : me?.designation || (me?.role ? me.role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");

  const modules = React.useMemo<ModuleCard[]>(() => {
    return navGroups
      .map((g) => ({
        title: g.title,
        items: g.items.filter((i) =>
          i.href !== "/apps" &&
          (!i.module || can(i.module, "view")) &&
          !(role && i.hideFor?.includes(role)),
        ),
      }))
      .filter((m) => m.items.length > 0);
  }, [can, role]);

  // A persona with exactly one module group → show its workspaces as the tiles.
  const solo = modules.length === 1 ? modules[0] : null;

  return (
    <div className="flex animate-fade-up flex-col gap-7">
      {/* Personal hero — greeting + where the user works. */}
      <section
        className="flex flex-wrap items-center gap-6 rounded-[14px] border border-border px-6 py-[22px] sm:px-[26px]"
        style={{
          background:
            "linear-gradient(120deg, color-mix(in srgb, #FF9A3D 10%, var(--card)) 0%, var(--card) 45%, color-mix(in srgb, #C2459A 7%, var(--card)) 100%)",
        }}
      >
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">
            {greeting}{first ? `, ${first}` : ""}
          </h1>
          {subtitle ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {property && <MapPin className="h-3.5 w-3.5 shrink-0" />}
              {subtitle}
            </p>
          ) : null}
        </div>
      </section>

      {/* Module grid. When the persona has just one module group (F&B manager,
          unit lead), explode it into one tile per workspace so the launcher
          isn't a single lonely tile. */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 font-display text-base font-bold tracking-[-0.012em]">
            {solo ? "Your workspaces" : "Your modules"}
          </h2>
        </div>

        {!me ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square w-full rounded-[18px]" />
            ))}
          </div>
        ) : modules.length === 0 ? (
          <EmptyState
            icon={LayoutDashboard}
            title="No modules yet"
            description="Your role has no modules assigned. Contact your administrator."
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {solo
              ? solo.items.map((item, i) => (
                  <WorkspaceTile key={item.href} item={item} index={i} />
                ))
              : modules.map((m) => <ModuleTile key={m.title} m={m} />)}
          </div>
        )}
      </section>
    </div>
  );
}
