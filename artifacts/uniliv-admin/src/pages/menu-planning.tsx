import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { DataTable } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { useGetMenuPlans, getGetMenuPlansQueryKey } from "@workspace/api-client-react"
import { format } from "date-fns"

export default function MenuPlanning() {
  const { data: res, isLoading } = useGetMenuPlans({} as any, { query: { queryKey: getGetMenuPlansQueryKey({} as any) } })
  const plans = res?.data || []

  const columns = [
    { 
      accessorKey: "weekStart", 
      header: "Week Starting",
      cell: ({row}: any) => {
        try {
          return format(new Date(row.original.weekStart), "dd MMM yyyy")
        } catch { return row.original.weekStart }
      }
    },
    { accessorKey: "propertyId", header: "Property ID" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({row}: any) => <StatusBadge status={row.original.status} />
    }
  ]

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Menu Planning" 
        subtitle="Manage weekly meal plans across properties"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Plan Menu
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={plans}
        isLoading={isLoading}
      />
    </div>
  )
}
