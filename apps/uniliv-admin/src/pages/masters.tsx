import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Database, ArrowRight, ChefHat, Boxes, Building2, MapPin, Network,
  UtensilsCrossed, Carrot, Truck, SlidersHorizontal, Layers, Lock, AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { mastersApi, masterKeys, MASTER_REGISTRY, type MasterSummary } from "@/lib/masters-api";

/** Per-type tile icon. Falls back to a generic Boxes for any unmapped master. */
const TYPE_ICON: Record<string, LucideIcon> = {
  brands: UtensilsCrossed,
  cities: MapPin,
  clusters: Network,
  zones: MapPin,
  kitchens: ChefHat,
};

/** Advanced masters live in the richer Food Settings editors. The settings page
 *  does not read a tab from the URL, so we deep-link to /food/settings directly. */
const ADVANCED: Array<{ label: string; description: string; icon: LucideIcon }> = [
  { label: "Dishes", description: "Menu dishes with components & portion data", icon: UtensilsCrossed },
  { label: "Ingredients", description: "Raw ingredients used in composition rules", icon: Carrot },
  { label: "Agencies", description: "Delivery agencies & partners", icon: Truck },
  { label: "Composition Rules", description: "Dish → component composition by meal", icon: Layers },
  { label: "Portion Size Rules", description: "Per-meal portion sizing defaults", icon: SlidersHorizontal },
];

/** Fixed enum masters — system-defined, not editable through the admin UI. */
const SYSTEM_DEFINED = ["Components", "Preparation Methods"];

export default function Masters() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: masterKeys.hub(),
    queryFn: () => mastersApi.hub(),
  });

  // Fall back to the static registry ordering so tiles render in a stable,
  // sensible order even if the API returns them differently.
  const summaries: MasterSummary[] = React.useMemo(() => {
    const rows = data ?? [];
    const order = Object.keys(MASTER_REGISTRY);
    return [...rows].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }, [data]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Masters"
        subtitle="Manage core reference data that powers food ops, geography and kitchens"
      />

      {/* Section A — core registry masters */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-display font-semibold uppercase tracking-wider text-muted-foreground">
            Core masters
          </h2>
        </div>

        {isError ? (
          <Card className="border-destructive/30">
            <CardContent className="flex items-center gap-3 p-6 text-sm text-destructive">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{(error as Error)?.message || "Failed to load masters."}</span>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-6 space-y-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-4 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((m) => {
              const Icon = TYPE_ICON[m.type] ?? Boxes;
              return (
                <Link key={m.type} href={`/masters/${m.type}`}>
                  <Card className="group cursor-pointer transition-all hover:border-accent/40 hover:shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent-strong">
                          <Icon className="w-5 h-5" />
                        </div>
                        <ArrowRight className="w-4 h-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-accent-strong" />
                      </div>
                      <h3 className="mt-4 font-display font-semibold text-primary">{m.label}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {m.count} {m.count === 1 ? "record" : "records"}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Section B — advanced masters (rich editors in Food Settings) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-display font-semibold uppercase tracking-wider text-muted-foreground">
            Advanced masters
          </h2>
          <span className="text-xs text-muted-foreground">— managed in Food Settings</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ADVANCED.map((a) => {
            const Icon = a.icon;
            return (
              <Link key={a.label} href="/food/settings">
                <Card className="group cursor-pointer transition-all hover:border-accent/40 hover:shadow-sm">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="w-10 h-10 rounded-lg bg-primary/5 flex items-center justify-center text-primary">
                        <Icon className="w-5 h-5" />
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-accent-strong" />
                    </div>
                    <h3 className="mt-4 font-display font-semibold text-primary">{a.label}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Section C — fixed enum masters (read-only, system-defined) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-display font-semibold uppercase tracking-wider text-muted-foreground">
            System-defined
          </h2>
        </div>

        <Card className="bg-surface/50">
          <CardContent className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  These masters are fixed enums baked into the platform and cannot be edited.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SYSTEM_DEFINED.map((s) => (
                    <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
