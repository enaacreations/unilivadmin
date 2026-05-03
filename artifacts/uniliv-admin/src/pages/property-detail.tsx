import * as React from "react"
import { useGetProperty, getGetPropertyQueryKey, useGetRooms, getGetRoomsQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Bed, MapPin, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";

export default function PropertyDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;

  const { data: propertyRes, isLoading: propertyLoading } = useGetProperty(id, { query: { queryKey: getGetPropertyQueryKey(id), enabled: !!id } });
  const { data: roomsRes, isLoading: roomsLoading } = useGetRooms({ propertyId: id }, { query: { queryKey: getGetRoomsQueryKey({ propertyId: id }), enabled: !!id } });

  const property = propertyRes?.data;
  const rooms = roomsRes?.data || [];

  if (propertyLoading) {
    return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!property) {
    return <div>Property not found</div>;
  }

  return (
    <div className="space-y-6">
      <Link href="/properties">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Properties
        </Button>
      </Link>
      
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-primary">{property.name}</h1>
          <p className="text-muted-foreground flex items-center gap-1 mt-1 text-sm">
            <MapPin className="w-4 h-4" /> {property.address}, {property.city}, {property.state} {property.pincode}
          </p>
        </div>
        <StatusBadge status={property.status} className="px-3 py-1" />
      </div>

      <div className="grid gap-6 grid-cols-1 md:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Occupancy Rate</CardTitle>
            <div className="p-2 bg-primary/5 rounded-full"><Users className="h-4 w-4 text-primary" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold text-primary">{property.occupancyRate}%</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Occupied Beds</CardTitle>
            <div className="p-2 bg-primary/5 rounded-full"><Bed className="h-4 w-4 text-primary" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold text-primary">{property.occupiedBeds}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Beds</CardTitle>
            <div className="p-2 bg-primary/5 rounded-full"><Bed className="h-4 w-4 text-primary" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold text-primary">{property.totalBeds}</div>
          </CardContent>
        </Card>
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-display font-bold text-primary">Rooms</h2>
          <Button size="sm" variant="outline">View All</Button>
        </div>
        
        {roomsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 w-full" />)}
          </div>
        ) : rooms.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground border border-dashed rounded-xl bg-surface/50">
            No rooms found for this property
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {rooms.map(room => (
              <Card key={room.id} className="hover:border-accent/50 transition-colors cursor-pointer shadow-sm group">
                <CardContent className="p-4 flex flex-col gap-3">
                  <div className="flex justify-between items-start">
                    <span className="font-display font-bold text-lg text-primary group-hover:text-accent transition-colors">{room.number}</span>
                    <StatusBadge status={room.status} className="text-[10px] px-1.5 py-0" />
                  </div>
                  <div className="text-xs text-muted-foreground bg-surface px-2 py-1 rounded w-fit">
                    Floor {room.floor} {room.wing ? `· Wing ${room.wing}` : ''}
                  </div>
                  <div className="text-sm font-medium flex justify-between items-center border-t pt-2 mt-1">
                    <span className="text-muted-foreground">{room.type}</span>
                    <span className="text-primary">{room.occupancy}/{room.capacity} Beds</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
