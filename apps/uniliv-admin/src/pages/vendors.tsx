import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Star, Search } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { VendorFormModal, VENDOR_CATEGORIES } from "@/components/vendor-form-modal";

export default function Vendors() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("ALL");
  const [category, setCategory] = React.useState("ALL");
  const [createOpen, setCreateOpen] = React.useState(false);

  const params: Record<string, string> = {};
  if (search) params.search = search;
  if (status !== "ALL") params.status = status;
  if (category !== "ALL") params.category = category;
  const qs = new URLSearchParams(params).toString();

  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["vendors", params],
    queryFn: () => apiFetch(`/vendors${qs ? `?${qs}` : ""}`),
  });
  const vendors = res?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span>,
    },
    {
      accessorKey: "gstin",
      header: "GSTIN",
      cell: ({ row }: any) => row.original.gstin
        ? <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.gstin}</span>
        : <span className="text-muted-foreground text-xs">—</span>,
    },
    {
      accessorKey: "categories",
      header: "Categories",
      cell: ({ row }: any) => (
        <div className="flex gap-1 flex-wrap max-w-[220px]">
          {(row.original.categories || []).map((c: string, i: number) => (
            <Badge key={i} variant="secondary" className="text-[10px] uppercase tracking-wider">{c}</Badge>
          ))}
        </div>
      ),
    },
    { accessorKey: "phone", header: "Phone" },
    {
      accessorKey: "rating",
      header: "Rating",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-1">
          <Star className="w-4 h-4 fill-warning text-warning" />
          <span className="font-medium text-sm">{row.original.rating ?? "—"}</span>
        </div>
      ),
    },
    {
      accessorKey: "activePOs",
      header: "Active POs",
      cell: ({ row }: any) => (
        <Badge variant={row.original.activePOs > 0 ? "default" : "outline"}>
          {row.original.activePOs || 0}
        </Badge>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        subtitle="Manage supplier relationships and ratings"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setCreateOpen(true)} data-testid="button-add-vendor">
            <Plus className="w-4 h-4 mr-2" /> Add Vendor
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search vendors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-vendors"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="INACTIVE">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Categories</SelectItem>
            {VENDOR_CATEGORIES.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns as any}
        data={vendors}
        isLoading={isLoading}
        onRowClick={(row: any) => setLocation(`/vendors/${row.id}`)}
      />

      <VendorFormModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
