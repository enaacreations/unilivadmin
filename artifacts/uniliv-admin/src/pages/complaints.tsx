import * as React from "react"
import { useGetComplaints, getGetComplaintsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function Complaints() {
  const { data: complaintsRes, isLoading } = useGetComplaints({ query: { queryKey: getGetComplaintsQueryKey() } });
  
  const complaints = complaintsRes?.data || [];

  const columns = [
    {
      accessorKey: "ticketNo",
      header: "Ticket No",
    },
    {
      accessorKey: "title",
      header: "Title",
    },
    {
      accessorKey: "category",
      header: "Category",
    },
    {
      accessorKey: "propertyName",
      header: "Property",
      cell: ({ row }: any) => row.original.propertyName || 'N/A'
    },
    {
      accessorKey: "priority",
      header: "Priority",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={row.original.priority} />
          {row.original.slaBreach && <StatusBadge status="BREACH" />}
        </div>
      )
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
        title="Complaints" 
        subtitle="Track and resolve resident issues"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Raise Ticket
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={complaints}
        isLoading={isLoading}
        searchKey="ticketNo"
        searchPlaceholder="Search tickets..."
      />
    </div>
  );
}
