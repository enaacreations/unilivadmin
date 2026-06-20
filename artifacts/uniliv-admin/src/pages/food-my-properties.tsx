import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Home, Building2, ChefHat, Users, Percent, Wallet, ListOrdered, FilePlus2,
  Truck, AlertTriangle, Tag,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { foodApi, foodKeys, type MyPropertyCard } from "@/lib/food-api";
import { withQuery } from "@/lib/nav-helpers";

const inr = (n: number) => `₹${(n ?? 0).toLocaleString("en-IN")}`;

function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export default function FoodMyProperties() {
  const [, setLocation] = useLocation();

  const { data: properties = [], isLoading } = useQuery<MyPropertyCard[]>({
    queryKey: foodKeys.myProperties(),
    queryFn: () => foodApi.myProperties(),
  });

  // Carry the property into the destination page so it opens scoped to it.
  const go = (propertyId: string, path: string) => {
    setLocation(withQuery(path, { propertyId }));
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
            <Card key={p.id} className="flex flex-col">
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
                  <Stat icon={Users} label="Active guests" value={p.activeGuests} />
                  <Stat icon={Percent} label="Occupancy" value={`${p.occupancyPct}%`} />
                  <Stat icon={Wallet} label="Revenue (mo)" value={inr(p.monthlyRevenue)} />
                  <Stat icon={ListOrdered} label="Active orders" value={p.activeOrders} />
                </div>

                {!p.configured && (
                  <p className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Ordering needs a brand &amp; kitchen — ask an admin to configure this property.
                  </p>
                )}

                <div className="mt-auto grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    className="col-span-2 gap-1.5"
                    disabled={!p.configured}
                    onClick={() => go(p.id, "/food/place-order")}
                  >
                    <FilePlus2 className="h-4 w-4" /> Place Order
                  </Button>
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
