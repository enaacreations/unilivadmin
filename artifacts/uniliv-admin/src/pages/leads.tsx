import * as React from "react"
import { useGetLeads, getGetLeadsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Leads() {
  const { data: leadsRes, isLoading } = useGetLeads({ query: { queryKey: getGetLeadsQueryKey() } });
  
  const leads = leadsRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Lead Name",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span>
    },
    {
      accessorKey: "contact",
      header: "Contact",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">{row.original.phone}</div>
          {row.original.email && <div className="text-xs text-muted-foreground">{row.original.email}</div>}
        </div>
      )
    },
    {
      accessorKey: "propertyName",
      header: "Property Interest",
      cell: ({ row }: any) => row.original.propertyName || <span className="text-muted-foreground italic">Unassigned</span>
    },
    {
      accessorKey: "source",
      header: "Source",
      cell: ({ row }: any) => <Badge variant="outline" className="text-[10px] uppercase">{row.original.source}</Badge>
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
        title="Sales CRM" 
        subtitle="Manage resident inquiries and bookings"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Lead
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={leads}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search leads..."
      />
    </div>
  );
}
