import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Building2, Users, Truck,
  UtensilsCrossed, TrendingUp, Landmark, Settings, LayoutGrid,
  ClipboardCheck, MapPin, MessageSquareWarning, Sparkles, WashingMachine,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { navGroups, type NavItem } from "@/lib/nav";
import { moduleLabel, MODULE_DESCRIPTION, MODULE_ICON, MODULE_TINT, type Module } from "@/lib/permissions";
import { usePermissions } from "@/lib/use-permissions";
import { useAppStore } from "@/lib/store";
import { foodApi, foodKeys } from "@/lib/food-api";

/**
 * Lucide component for each icon NAME the manifest declares.
 *
 * The manifest cannot import lucide (permissions.ts is asserted dependency-free
 * by the parity test), so it names the icon and this resolves it. An unknown
 * name falls back to the grid glyph rather than breaking the launcher.
 *
 * Both this and the tints are keyed by the module KEY, never by its label —
 * keying them by the nav group's display title is exactly what made every card
 * render the same grey grid icon the moment "Food" became "Food & Kitchen".
 */
const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Building2, MessageSquareWarning, Sparkles, WashingMachine,
  UtensilsCrossed, ClipboardCheck, Landmark, Users, Truck, TrendingUp,
  ShieldCheck, Settings,
};

const FALLBACK_TINT: [string, string, string, string] = ["#FF9A3D", "#F2603C", "#FF9A3D", "#C2459A"];

// Preferred landing page when a module tile is clicked (falls back to the
// module's first accessible page). Food opens its dashboard, not /home.
const MODULE_HOME: Partial<Record<Module, string>> = {
  FOOD: "/food/dashboard",
  // Conducting personas (UL/CM/CX/OE) land on their My Audits home; oversight
  // roles lack AUDIT_EXECUTION so /audits/my isn't in their filtered items and
  // this falls back to their first page (the Audit Dashboard).
  AUDITS: "/audits/my",
};

type ModuleCard = { key: Module | null; title: string; description?: string; items: NavItem[] };

/** Square gradient-tinted module tile (prototype: aspect-1/1, 58px gradient
 *  icon badge, name in the display face). */
function ModuleTile({ m }: { m: ModuleCard }) {
  const Icon = (m.key ? ICONS[MODULE_ICON[m.key]] : undefined) ?? LayoutGrid;
  const [gradFrom, gradTo, tint, tint2] = (m.key ? MODULE_TINT[m.key] : undefined) ?? FALLBACK_TINT;
  const home = m.key ? MODULE_HOME[m.key] : undefined;
  const href = m.items.find((i) => i.href === home)?.href ?? m.items[0].href;
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
  const { me, can, canModule, role } = usePermissions();
  const { propertyId } = useAppStore();
  const greeting = useGreeting();

  // Property line under the greeting — resolved from the food property cards
  // (food roles can't read /properties). Falls back to the persona label.
  const canFood = !!me && can("FOOD_DASHBOARD", "view_food_dashboard");
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

  /**
   * One card per MODULE the persona can see something in — which is what the
   * launcher has always meant, and now says. The card appears when the module
   * rollup grants anything; its links are the individual functionalities they
   * may open. A module with a grant but no openable nav item is dropped rather
   * than rendered as an empty card (that state means the grant is for an inline
   * action, not a screen).
   */
  const modules = React.useMemo<ModuleCard[]>(() => {
    return navGroups
      .filter((g) => !g.module || canModule(g.module))
      .map((g) => ({
        key: g.module ?? null,
        title: g.module ? moduleLabel(g.module) : g.title,
        description: g.module ? MODULE_DESCRIPTION[g.module] : undefined,
        items: g.items.filter((i) =>
          i.href !== "/apps" &&
          (!i.functionality || can(i.functionality)) &&
          !(role && i.hideFor?.includes(role)),
        ),
      }))
      .filter((m) => m.items.length > 0);
  }, [can, canModule, role]);

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

      {/* Module grid — always one tile per module group, for every persona
          (PO, 03-Aug-2026): the launcher shows domains, never individual
          workspaces, so a single-module persona just gets a single tile. */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 font-display text-base font-bold tracking-[-0.012em]">
            Your modules
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
            {modules.map((m) => <ModuleTile key={m.title} m={m} />)}
          </div>
        )}
      </section>
    </div>
  );
}
