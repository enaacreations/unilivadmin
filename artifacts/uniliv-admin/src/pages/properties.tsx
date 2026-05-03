import * as React from "react"
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useLocation } from "wouter";

export default function Properties() {
  const [, setLocation] = useLocation();
  const { data: propertiesRes, isLoading } = useGetProperties({ query: { queryKey: getGetPropertiesQueryKey() } });
  
  const properties = propertiesRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Property Name",
    },
    {
      accessorKey: "city",
      header: "Location",
      cell: ({ row }: any) => `${row.original.city}, ${row.original.state}`
    },
    {
      accessorKey: "totalBeds",
      header: "Beds",
      cell: ({ row }: any) => `${row.original.occupiedBeds || 0} / ${row.original.totalBeds || 0}`
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Properties" 
        subtitle="Manage all co-living properties and buildings"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Property
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={properties}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search properties..."
        onRowClick={(row) => setLocation(`/properties/${row.id}`)}
      />
    </div>
  );
}
