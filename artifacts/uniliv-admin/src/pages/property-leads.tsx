import * as React from "react"
import { useGetPropertyLeads, getGetPropertyLeadsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function PropertyLeads() {
  const { data: leadsRes, isLoading } = useGetPropertyLeads({ query: { queryKey: getGetPropertyLeadsQueryKey() } });
  
  const leads = leadsRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Property Name",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span>
    },
    {
      accessorKey: "location",
      header: "Location",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">{row.original.city}</div>
          <div className="text-xs text-muted-foreground truncate max-w-[200px]">{row.original.address}</div>
        </div>
      )
    },
    {
      accessorKey: "owner",
      header: "Owner",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">{row.original.ownerName || <span className="italic text-muted-foreground">Unknown</span>}</div>
          <div className="text-xs text-muted-foreground">{row.original.ownerPhone || '-'}</div>
        </div>
      )
    },
    {
      accessorKey: "capacity",
      header: "Capacity / Rent",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">{row.original.bedCount ? `${row.original.bedCount} Beds` : '-'}</div>
          <div className="text-xs text-muted-foreground">{row.original.askingRent ? `₹${row.original.askingRent.toLocaleString()}` : '-'}</div>
        </div>
      )
    },
    {
      accessorKey: "stage",
      header: "Stage",
      cell: ({ row }: any) => <StatusBadge status={row.original.stage} />
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Property Leads" 
        subtitle="Track potential real estate acquisitions"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Property Lead
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={leads}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search property leads..."
      />
    </div>
  );
}
