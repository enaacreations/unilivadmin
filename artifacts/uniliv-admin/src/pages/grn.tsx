import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { DataTable } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { useGetGRNs, getGetGRNsQueryKey } from "@workspace/api-client-react"
import { format } from "date-fns"

export default function GRN() {
  const { data: res, isLoading } = useGetGRNs({} as any, { query: { queryKey: getGetGRNsQueryKey({} as any) } })
  const grns = res?.data || []

  const columns = [
    { accessorKey: "grnNumber", header: "GRN #" },
    { accessorKey: "poId", header: "PO ID" },
    { 
      accessorKey: "createdAt", 
      header: "Received Date",
      cell: ({row}: any) => {
        try {
          return format(new Date(row.original.createdAt), "dd MMM yyyy")
        } catch { return "" }
      }
    },
    { accessorKey: "receivedBy", header: "Received By" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({row}: any) => <StatusBadge status={row.original.status} />
    }
  ]

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Goods Receipt Notes" 
        subtitle="Track items received against purchase orders"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Create GRN
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={grns}
        isLoading={isLoading}
        searchKey="grnNumber"
        searchPlaceholder="Search GRNs..."
      />
    </div>
  )
}
