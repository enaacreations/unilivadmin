import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Plus, Eye } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { GRNFormModal } from "@/components/grn-form-modal";

export default function GRN() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["grn"],
    queryFn: () => apiFetch(`/grn`),
  });
  const grns = res?.data || [];

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];
  const propName = (id?: string | null) => id ? (properties.find((p) => p.id === id)?.name || "—") : "—";

  const cols = [
    { accessorKey: "grnNumber", header: "GRN #", cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.grnNumber}</span> },
    { accessorKey: "poNumber", header: "PO #", cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.poNumber || "—"}</span> },
    { accessorKey: "vendorName", header: "Vendor", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.vendorName || "—"}</span> },
    { accessorKey: "propertyId", header: "Property", cell: ({ row }: any) => propName(row.original.propertyId) },
    { id: "items", header: "Items", accessorFn: (r: any) => `${r.items?.length || 0} items`, cell: ({ row }: any) => `${row.original.items?.length || 0} items` },
    {
      accessorKey: "qcPass", header: "QC",
      cell: ({ row }: any) => row.original.qcPass !== false
        ? <Badge className="bg-emerald-600 text-white border-transparent">Pass</Badge>
        : <Badge variant="destructive">Fail</Badge>,
    },
    { accessorKey: "receivedBy", header: "Received By", cell: ({ row }: any) => row.original.receivedBy || "—" },
    { accessorKey: "createdAt", header: "Date", cell: ({ row }: any) => row.original.createdAt ? format(new Date(row.original.createdAt), "dd MMM yyyy") : "—" },
    {
      id: "actions", header: "",
      cell: ({ row }: any) => (
        <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); setDetailId(row.original.id); }}>
          <Eye className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goods Receipt Notes"
        subtitle="Track items received against purchase orders"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Create GRN
          </Button>
        }
      />
      <DataTable columns={cols as any} data={grns} isLoading={isLoading} onRowClick={(row: any) => setDetailId(row.id)} />

      <GRNFormModal open={createOpen} onOpenChange={setCreateOpen} />
      <GRNDetailSheet id={detailId} onClose={() => setDetailId(null)} propName={propName} />
    </div>
  );
}

function GRNDetailSheet({ id, onClose, propName }: { id: string | null; onClose: () => void; propName: (id?: string | null) => string }) {
  const { data: res, isLoading } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/grn/${id}`, id],
    queryFn: () => apiFetch(`/grn/${id}`),
    enabled: !!id,
  });
  const grn = res?.data;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-3">
            GRN {grn && <span className="font-mono text-sm bg-muted/30 px-2 py-1 rounded">{grn.grnNumber}</span>}
            {grn && (grn.qcPass !== false ? <Badge className="bg-green-600 text-white hover:bg-green-700">QC Pass</Badge> : <Badge variant="destructive">QC Fail</Badge>)}
          </SheetTitle>
        </SheetHeader>
        {isLoading ? (
          <div className="space-y-3 mt-6"><div className="h-24 bg-muted/30 animate-pulse rounded" /><div className="h-32 bg-muted/30 animate-pulse rounded" /></div>
        ) : !grn ? (
          <p className="text-sm text-muted-foreground p-4 text-center mt-6">Could not load this GRN.</p>
        ) : (
          <div className="space-y-6 mt-6">

            <div className="grid grid-cols-2 gap-3 text-sm border rounded-md p-4 bg-card">
              <div><p className="text-muted-foreground text-xs uppercase">PO Number</p><p className="font-mono font-medium">{grn.po?.poNumber || "—"}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Vendor</p><p className="font-medium">{grn.po?.vendorName || "—"}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Property</p><p className="font-medium">{propName(grn.propertyId)}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Received</p><p className="font-medium">{grn.createdAt ? format(new Date(grn.createdAt), "dd MMM yyyy") : "—"}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Invoice #</p><p className="font-mono">{grn.invoiceNumber || "—"}</p></div>
              <div><p className="text-muted-foreground text-xs uppercase">Received By</p><p className="font-medium">{grn.receivedBy || "—"}</p></div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Items Received</h4>
              <table className="w-full text-sm border rounded-md overflow-hidden">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-2">Item</th>
                    <th className="text-right p-2">Ordered</th>
                    <th className="text-right p-2">Received</th>
                    <th className="text-left p-2">Unit</th>
                    <th className="text-left p-2">Condition</th>
                  </tr>
                </thead>
                <tbody>
                  {(grn.items || []).map((it: any, i: number) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-medium">{it.itemName}</td>
                      <td className="p-2 text-right">{it.qtyOrdered}</td>
                      <td className="p-2 text-right">{it.qtyReceived}</td>
                      <td className="p-2">{it.unit}</td>
                      <td className="p-2">
                        <Badge className={`text-[10px] ${it.condition === "GOOD" ? "bg-green-600 text-white hover:bg-green-700" : "bg-red-600 text-white hover:bg-red-700"}`}>
                          {it.condition}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {grn.qcNotes && (
              <div className="border rounded-md p-3 bg-card text-sm">
                <p className="text-muted-foreground text-xs uppercase mb-1">QC Notes</p>
                <p>{grn.qcNotes}</p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
