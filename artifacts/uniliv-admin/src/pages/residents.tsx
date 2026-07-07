import * as React from "react";
import {
  useGetResidents,
  getGetResidentsQueryKey,
  useGetProperties,
  getGetPropertiesQueryKey,
} from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/ui/user-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Eye, Users, UserCheck, UserX, AlertTriangle, Search, Download, Receipt, Upload } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import { ResidentFormModal } from "@/components/resident-form-modal";
import { BulkRentModal } from "@/components/bulk-rent-modal";
import { BulkUploadDialog, type BulkColumn } from "@/components/bulk-upload-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/lib/store";
import { useScopedColumns } from "@/lib/use-scoped-columns";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";

// Column config for the bulk-upload template + header→key mapping. Keys match
// the backend's verbatim row object keys for POST /bulk/residents.
const RESIDENT_BULK_COLUMNS: BulkColumn[] = [
  { key: "name", label: "name", required: true },
  { key: "email", label: "email", required: true },
  { key: "phone", label: "phone", required: true },
  { key: "propertyId", label: "propertyId", required: true },
  { key: "monthlyRent", label: "monthlyRent" },
  { key: "gender", label: "gender" },
  { key: "checkInDate", label: "checkInDate" },
];

export default function Residents() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { propertyId: globalPropertyId, setPropertyId: setGlobalProperty } = useAppStore();

  const [propertyId, setPropertyId] = React.useState(globalPropertyId || "ALL");
  // The page filter and the global selector are one scope: changing the filter
  // updates the global property (so the sidebar selector + scope banner stay in
  // sync), and the effect below mirrors global changes back into the local value.
  const selectProperty = (v: string) => {
    setPropertyId(v);
    setGlobalProperty(v === "ALL" ? null : v);
  };
  const [status, setStatus] = React.useState("ALL");
  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = React.useState(false);

  // Sync local filter when global property selector changes
  React.useEffect(() => {
    setPropertyId(globalPropertyId || "ALL");
  }, [globalPropertyId]);

  const apiPropertyId = propertyId !== "ALL" ? propertyId : undefined;
  const apiStatus = status !== "ALL" ? status : undefined;

  const { data: residentsRes, isLoading } = useGetResidents({
    propertyId: apiPropertyId,
    status: apiStatus as any,
    search: search || undefined,
    limit: 200,
  } as any, {
    query: { queryKey: getGetResidentsQueryKey({ propertyId: apiPropertyId, status: apiStatus, search: search || undefined, limit: 200 } as any) },
  });
  const residents = residentsRes?.data || [];

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const now = new Date();
  const checkedOutThisMonth = residents.filter((r) => {
    if (r.status !== "CHECKED_OUT" || !r.checkOutDate) return false;
    const d = new Date(r.checkOutDate);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const totalActive = residents.filter((r) => r.status === "ACTIVE").length;
  const noticePeriod = residents.filter((r) => r.status === "NOTICE_PERIOD").length;

  const exportCsv = () => {
    const headers = ["Name", "Email", "Phone", "Property", "Room", "Plan", "Monthly Rent", "Status"];
    const rows = residents.map((r) => [
      r.name,
      r.email,
      r.phone,
      r.propertyName || "",
      r.roomNumber || "",
      r.planType || "",
      r.monthlyRent ?? "",
      r.status,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `residents-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = [
    {
      id: "name",
      header: "Resident",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-3">
          <UserAvatar name={row.original.name} src={row.original.photo || undefined} className="h-8 w-8" />
          <div>
            <p className="font-medium text-primary">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">{row.original.email}</p>
          </div>
        </div>
      ),
    },
    { accessorKey: "propertyName", header: "Property", cell: ({ row }: any) => row.original.propertyName || "—" },
    { accessorKey: "roomNumber", header: "Room", cell: ({ row }: any) => row.original.roomNumber || "—" },
    { accessorKey: "phone", header: "Phone" },
    { accessorKey: "planType", header: "Plan", cell: ({ row }: any) => row.original.planType || "—" },
    {
      accessorKey: "monthlyRent",
      header: "Monthly Rent",
      cell: ({ row }: any) => row.original.monthlyRent ? `₹${row.original.monthlyRent.toLocaleString("en-IN")}` : "—",
    },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
    {
      id: "compliance",
      header: "KYC / E-sign",
      cell: ({ row }: any) => <ComplianceCell residentId={row.original.id} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }: any) => (
        <Button
          size="icon"
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); setLocation(`/residents/${row.original.id}`); }}
          data-testid={`button-view-resident-${row.original.id}`}
        >
          <Eye className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  // Property column is constant for property-scoped viewers (unit leads/wardens).
  const scopedColumns = useScopedColumns(columns, { singleProperty: ["propertyName"] });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Residents"
        subtitle="Manage resident profiles and lifecycle"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportCsv} data-testid="button-export-residents">
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-rent">
              <Receipt className="w-4 h-4 mr-2" /> Bulk Rent Charge
            </Button>
            <Button variant="outline" onClick={() => setBulkUploadOpen(true)} data-testid="button-bulk-upload-residents">
              <Upload className="w-4 h-4 mr-2" /> Bulk Upload
            </Button>
            <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setCreateOpen(true)} data-testid="button-add-resident">
              <Plus className="w-4 h-4 mr-2" /> Add Resident
            </Button>
          </div>
        }
      />

      <GlobalPropertyScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Active" value={totalActive} icon={UserCheck} />
        <StatCard title="Checked Out This Month" value={checkedOutThisMonth} icon={UserX} />
        <StatCard title="Notice Period" value={noticePeriod} icon={Users} />
        <StatCard title="Overdue" value="—" icon={AlertTriangle} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={selectProperty}>
          <SelectTrigger className="w-48" data-testid="select-filter-property"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="select-filter-resident-status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="NOTICE_PERIOD">Notice Period</SelectItem>
            <SelectItem value="CHECKED_OUT">Checked Out</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search residents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-residents"
          />
        </div>
      </div>

      <DataTable columns={scopedColumns as any} data={residents} isLoading={isLoading} />

      <ResidentFormModal open={createOpen} onOpenChange={setCreateOpen} />
      <BulkRentModal open={bulkOpen} onOpenChange={setBulkOpen} />
      <BulkUploadDialog
        resource="residents"
        columns={RESIDENT_BULK_COLUMNS}
        open={bulkUploadOpen}
        onOpenChange={setBulkUploadOpen}
        onDone={() => qc.invalidateQueries({ queryKey: getGetResidentsQueryKey() })}
      />
    </div>
  );
}

function ComplianceCell({ residentId }: { residentId: string }) {
  const { data: kyc } = useQuery<{ data: Array<{ status: string }> }>({
    queryKey: ["kyc", residentId],
    queryFn: () => apiFetch(`/residents/${residentId}/kyc`),
    staleTime: 60_000,
  });
  const { data: esign } = useQuery<{ data: Array<{ status: string }> }>({
    queryKey: ["esign", residentId],
    queryFn: () => apiFetch(`/residents/${residentId}/esign`),
    staleTime: 60_000,
  });
  const kycVerified = (kyc?.data || []).some((r) => r.status === "VERIFIED");
  const kycPending = !kycVerified && (kyc?.data || []).some((r) => r.status === "PENDING");
  const esignSigned = (esign?.data || []).some((r) => r.status === "SIGNED");
  const esignPending = !esignSigned && (esign?.data || []).some((r) => ["PENDING", "VIEWED"].includes(r.status));
  return (
    <div className="flex gap-1">
      <Badge variant={kycVerified ? "success" : kycPending ? "warning" : "outline"} className="text-[10px]">
        KYC {kycVerified ? "✓" : kycPending ? "…" : "—"}
      </Badge>
      <Badge variant={esignSigned ? "success" : esignPending ? "warning" : "outline"} className="text-[10px]">
        Sign {esignSigned ? "✓" : esignPending ? "…" : "—"}
      </Badge>
    </div>
  );
}
