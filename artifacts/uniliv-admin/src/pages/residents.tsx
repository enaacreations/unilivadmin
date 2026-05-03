import * as React from "react"
import { useGetResidents, getGetResidentsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useLocation } from "wouter";

export default function Residents() {
  const [, setLocation] = useLocation();
  const { data: residentsRes, isLoading } = useGetResidents({ query: { queryKey: getGetResidentsQueryKey() } });
  
  const residents = residentsRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Name",
    },
    {
      accessorKey: "phone",
      header: "Phone",
    },
    {
      accessorKey: "propertyName",
      header: "Property / Room",
      cell: ({ row }: any) => `${row.original.propertyName || 'N/A'} / ${row.original.roomNumber || 'N/A'}`
    },
    {
      accessorKey: "checkInDate",
      header: "Check In",
      cell: ({ row }: any) => row.original.checkInDate ? new Date(row.original.checkInDate).toLocaleDateString() : 'N/A'
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
        title="Residents" 
        subtitle="Manage resident profiles and lifecycle"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Resident
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={residents}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search residents..."
        onRowClick={(row) => setLocation(`/residents/${row.id}`)}
      />
    </div>
  );
}
