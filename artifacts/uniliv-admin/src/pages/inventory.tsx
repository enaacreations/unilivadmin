import * as React from "react"
import { useGetInventory, getGetInventoryQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus, AlertTriangle } from "lucide-react";

export default function Inventory() {
  const { data: inventoryRes, isLoading } = useGetInventory({ query: { queryKey: getGetInventoryQueryKey() } });
  
  const items = inventoryRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Item Name",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-primary">{row.original.name}</span>
          {row.original.isLowStock && <AlertTriangle className="w-4 h-4 text-destructive" title="Low Stock" />}
        </div>
      )
    },
    {
      accessorKey: "category",
      header: "Category",
    },
    {
      accessorKey: "stock",
      header: "Stock Level",
      cell: ({ row }: any) => (
        <div className="flex flex-col">
          <span className={row.original.isLowStock ? "text-destructive font-bold" : "font-medium"}>
            {row.original.currentStock} {row.original.unit}
          </span>
          <span className="text-xs text-muted-foreground">Min: {row.original.minStock}</span>
        </div>
      )
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => (
        row.original.isLowStock ? <StatusBadge status="LOW STOCK" /> : <StatusBadge status="IN STOCK" />
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Inventory" 
        subtitle="Track stock levels and asset conditions"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Item
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={items}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search inventory items..."
      />
    </div>
  );
}
