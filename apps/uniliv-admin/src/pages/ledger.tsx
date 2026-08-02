import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { DataTable } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { useGetResidents, getGetResidentsQueryKey, useGetResidentLedger, getGetResidentLedgerQueryKey } from "@workspace/api-client-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { format } from "date-fns"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Bot } from "lucide-react"
import { useScopedColumns } from "@/lib/use-scoped-columns"

export default function Ledger() {
  const { data: res, isLoading } = useGetResidents({} as any, { query: { queryKey: getGetResidentsQueryKey({} as any) } })
  const residents = res?.data || []
  
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  
  const { data: ledgerRes, isLoading: ledgerLoading } = useGetResidentLedger(selectedId as string, { 
    query: { 
      enabled: !!selectedId, 
      queryKey: getGetResidentLedgerQueryKey(selectedId as string) 
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
        title="Resident Ledgers"
        subtitle="View financial transactions for all residents"
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
            <SheetTitle className="font-display">Ledger Entries</SheetTitle>
          </SheetHeader>
          
          <div className="space-y-4">
            {ledgerLoading ? (
              Array.from({length: 3}).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
            ) : ledgerRes?.data && ledgerRes.data.length > 0 ? (
              ledgerRes.data.map((entry) => (
                <div key={entry.id} className="p-4 border rounded-lg flex justify-between items-center bg-card">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{entry.description}</p>
                      {entry.reference?.startsWith("AUTO:") && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 gap-1" data-testid={`badge-auto-${entry.id}`}>
                          <Bot className="w-3 h-3" /> Auto
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{entry.type} • {format(new Date(entry.createdAt), "dd MMM yyyy")}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">₹{entry.amount}</p>
                    <StatusBadge status={entry.isPaid ? "PAID" : "PENDING"} className="mt-1" />
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
                No ledger entries found for this resident.
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
