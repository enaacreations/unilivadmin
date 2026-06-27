import * as React from "react";
import { useLocation } from "wouter";
import { useAppStore } from "@/lib/store";
import { useQuery } from "@tanstack/react-query";
import {
  Home, Building2, ChefHat, Users, Percent, Wallet, ListOrdered,
  Truck, AlertTriangle, Tag, BedDouble, CheckCircle2, Image as ImageIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { foodApi, foodKeys, type MyPropertyCard } from "@/lib/food-api";
import { withQuery } from "@/lib/nav-helpers";

const inr = (n: number) => `₹${(n ?? 0).toLocaleString("en-IN")}`;

// Card banner image. The /food/my-properties payload now carries heroImageUrl
// (resolved server-side over the caller's full accessible property set), so we
// render it directly instead of calling the PROPERTIES-scoped /:id/photos route
// (which 403s every property beyond the caller's own users.property_id).
// Falls back to a placeholder when there's no hero or storage is unavailable.
function PropertyBanner({ url, name }: { url: string | null; name: string }) {
  return (
    <div className="aspect-[16/7] w-full overflow-hidden bg-surface" data-testid={`property-banner-${name}`}>
      {url ? (
        <img src={url} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-7 w-7" />
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon, label, value, onClick,
}: { icon: typeof Users; label: string; value: React.ReactNode; onClick?: () => void }) {
  const content = (
    <>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </>
  );
  if (!onClick) {
    return <div className="flex flex-col gap-0.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-0.5 rounded-md text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring -m-1 p-1"
    >
      {content}
    </button>
  );
}

export default function FoodMyProperties() {
  const [, setLocation] = useLocation();
  const { setPropertyId: setGlobalProperty } = useAppStore();

  const { data: properties = [], isLoading } = useQuery<MyPropertyCard[]>({
    queryKey: foodKeys.myProperties(),
    queryFn: () => foodApi.myProperties(),
  });

  // Carry the property into the destination page so it opens scoped to it.
  const go = (propertyId: string, path: string) => {
    setLocation(withQuery(path, { propertyId }));
  };
  // Occupancy / beds / collections live on the Unit-Lead Home dashboard (the
  // food-accessible analytics view): scope the global selector to this property,
  // then open Home. The unit-lead persona has no Properties/Payments module.
  const goHomeScoped = (propertyId: string) => {
    setGlobalProperty(propertyId);
    setLocation("/home");
  };
  // Deep-link to this property's delivered orders (orders page reads both params).
  const goDelivered = (propertyId: string) => {
    setLocation(withQuery("/food/orders", { propertyId, status: "DELIVERED" }));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Properties"
        subtitle="Properties tagged to you — manage orders, guests and deliveries per property."
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-64 w-full" />)}
        </div>
      ) : properties.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Home className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">No properties tagged to you yet</p>
            <p className="text-xs text-muted-foreground">Ask an administrator to assign you to one or more properties from the Organization console.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {properties.map((p) => (
            <Card key={p.id} className="flex flex-col overflow-hidden">
              <PropertyBanner url={p.heroImageUrl ?? null} name={p.name} />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.name}</span>
                    </CardTitle>
                    {p.city && <p className="mt-0.5 text-xs text-muted-foreground">{p.city}</p>}
                  </div>
                  {p.awaitingDelivery > 0 && (
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      <Truck className="h-3 w-3" /> {p.awaitingDelivery}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {p.brand ? (
                    <Badge variant="outline" className="gap-1"><Tag className="h-3 w-3" /> {p.brand}</Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> No brand</Badge>
                  )}
                  {p.kitchenName ? (
                    <Badge variant="outline" className="gap-1"><ChefHat className="h-3 w-3" /> {p.kitchenName}</Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> No kitchen</Badge>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <Stat
                    icon={Users}
                    label="Active guests"
                    value={p.activeGuests}
                    onClick={() => go(p.id, "/food/guests")}
                  />
                  <Stat
                    icon={Percent}
                    label="Occupancy"
                    value={`${p.occupancyPct}%`}
                    onClick={() => goHomeScoped(p.id)}
                  />
                  <Stat
                    icon={BedDouble}
                    label="Vacant beds"
                    value={Math.max(0, (p.totalBeds ?? 0) - (p.occupied ?? 0))}
                    onClick={() => goHomeScoped(p.id)}
                  />
                  <Stat
                    icon={Wallet}
                    label="Revenue (month)"
                    value={inr(p.monthlyRevenue)}
                    onClick={() => goHomeScoped(p.id)}
                  />
                  <Stat
                    icon={ListOrdered}
                    label="Active orders"
                    value={p.activeOrders}
                    onClick={() => go(p.id, "/food/orders")}
                  />
                  <Stat
                    icon={CheckCircle2}
                    label="Delivered"
                    value={p.deliveredCount}
                    onClick={() => goDelivered(p.id)}
                  />
                </div>

                {!p.configured && (
                  <p className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Ordering needs a brand &amp; kitchen — ask an admin to configure this property.
                  </p>
                )}

                <div className="mt-auto grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => go(p.id, "/food/orders")}>
                    <ListOrdered className="h-4 w-4" /> Orders
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => go(p.id, "/food/guests")}>
                    <Users className="h-4 w-4" /> Guests
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
