import * as React from "react"
import { useGetIndents, getGetIndentsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { format } from "date-fns";

export default function Indents() {
  const { data: indentsRes, isLoading } = useGetIndents({ query: { queryKey: getGetIndentsQueryKey() } });
  
  const indents = indentsRes?.data || [];

  const columns = [
    {
      accessorKey: "createdAt",
      header: "Date",
      cell: ({ row }: any) => format(new Date(row.original.createdAt), "dd MMM yyyy")
    },
    {
      accessorKey: "department",
      header: "Department",
    },
    {
      accessorKey: "items",
      header: "Items",
      cell: ({ row }: any) => <span className="font-medium">{row.original.items.length} items</span>
    },
    {
      accessorKey: "urgency",
      header: "Urgency",
      cell: ({ row }: any) => <StatusBadge status={row.original.urgency} />
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
        title="Material Indents" 
        subtitle="Internal requests for materials and supplies"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Raise Indent
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={indents}
        isLoading={isLoading}
      />
    </div>
  );
}
