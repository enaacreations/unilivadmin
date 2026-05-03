import * as React from "react"
import { useGetVendors, getGetVendorsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Vendors() {
  const { data: vendorsRes, isLoading } = useGetVendors({ query: { queryKey: getGetVendorsQueryKey() } });
  
  const vendors = vendorsRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span>
    },
    {
      accessorKey: "categories",
      header: "Categories",
      cell: ({ row }: any) => (
        <div className="flex gap-1 flex-wrap max-w-[200px]">
          {row.original.categories.map((cat: string, i: number) => (
            <Badge key={i} variant="secondary" className="text-[10px] uppercase tracking-wider bg-muted/20 text-muted-foreground">{cat}</Badge>
          ))}
        </div>
      )
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
      accessorKey: "rating",
      header: "Rating",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-1.5">
          <Star className="w-4 h-4 fill-warning text-warning" />
          <span className="font-medium text-sm">{row.original.rating || '-'}</span>
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
        title="Vendors" 
        subtitle="Manage supplier relationships and ratings"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Vendor
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={vendors}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search vendors..."
      />
    </div>
  );
}
