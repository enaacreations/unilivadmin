import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { DataTable } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { useGetResidents, getGetResidentsQueryKey, useGetResidentPayments, getGetResidentPaymentsQueryKey } from "@workspace/api-client-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { format } from "date-fns"
import { Skeleton } from "@/components/ui/skeleton"
import { useQueryParam } from "@/lib/nav-helpers"
import { useScopedColumns } from "@/lib/use-scoped-columns"

export default function Payments() {
  // Optional ?propertyId= scopes the page to one property (e.g. from My Properties → Revenue).
  const propertyId = useQueryParam("propertyId") || undefined
  const params = (propertyId ? { propertyId } : {}) as any
  const { data: res, isLoading } = useGetResidents(params, { query: { queryKey: getGetResidentsQueryKey(params) } })
  const residents = res?.data || []
  const scopedName = propertyId ? (residents[0] as any)?.propertyName ?? null : null
  
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  
  const { data: paymentsRes, isLoading: paymentsLoading } = useGetResidentPayments(selectedId as string, { 
    query: { 
      enabled: !!selectedId, 
      queryKey: getGetResidentPaymentsQueryKey(selectedId as string) 
    } 
  })

  const columns = [
    { accessorKey: "name", header: "Resident" },
    { accessorKey: "propertyName", header: "Property" },
    { accessorKey: "roomNumber", header: "Room" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({row}: any) => <StatusBadge status={row.original.status} />
    }
  ]
  const scopedColumns = useScopedColumns(columns, { singleProperty: ["propertyName"] })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        subtitle={scopedName ? `Collections — ${scopedName}` : "Track payment receipts across the portfolio"}
      />

      <DataTable
        columns={scopedColumns}
        data={residents}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search residents..."
        onRowClick={(row) => setSelectedId(row.id)}
      />

      <Sheet open={!!selectedId} onOpenChange={(op) => !op && setSelectedId(null)}>
        <SheetContent className="sm:max-w-xl w-full">
          <SheetHeader className="mb-6">
            <SheetTitle className="font-display">Payment History</SheetTitle>
          </SheetHeader>
          
          <div className="space-y-4">
            {paymentsLoading ? (
              Array.from({length: 3}).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
            ) : paymentsRes?.data && paymentsRes.data.length > 0 ? (
              paymentsRes.data.map((payment) => (
                <div key={payment.id} className="p-4 border rounded-lg flex justify-between items-center bg-card">
                  <div>
                    <p className="font-medium text-lg">₹{payment.amount}</p>
                    <p className="text-sm text-muted-foreground">{payment.mode} • Ref: {payment.reference || "N/A"}</p>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={payment.status} className="mb-1" />
                    <p className="text-xs text-muted-foreground mt-1">{format(new Date(payment.createdAt), "dd MMM yyyy HH:mm")}</p>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
                No payment records found for this resident.
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
