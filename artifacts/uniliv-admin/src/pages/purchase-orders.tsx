import * as React from "react"
import { useGetPurchaseOrders, getGetPurchaseOrdersQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { format } from "date-fns";

export default function PurchaseOrders() {
  const { data: posRes, isLoading } = useGetPurchaseOrders({ query: { queryKey: getGetPurchaseOrdersQueryKey() } });
  
  const pos = posRes?.data || [];

  const columns = [
    {
      accessorKey: "poNumber",
      header: "PO Number",
      cell: ({ row }: any) => <span className="font-mono text-sm bg-muted/20 px-2 py-1 rounded">{row.original.poNumber}</span>
    },
    {
      accessorKey: "vendorName",
      header: "Vendor",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.vendorName || 'Unknown Vendor'}</span>
    },
    {
      accessorKey: "createdAt",
      header: "Date",
      cell: ({ row }: any) => format(new Date(row.original.createdAt), "dd MMM yyyy")
    },
    {
      accessorKey: "totalAmount",
      header: "Amount",
      cell: ({ row }: any) => <span className="font-medium">₹{row.original.totalAmount.toLocaleString()}</span>
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
        title="Purchase Orders" 
        subtitle="Manage external orders and vendor fulfillment"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Create PO
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={pos}
        isLoading={isLoading}
        searchKey="poNumber"
        searchPlaceholder="Search PO numbers..."
      />
    </div>
  );
}
