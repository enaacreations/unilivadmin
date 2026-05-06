import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { FormModal } from "@/components/ui/form-modal";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import {
  Wallet, ArrowUpCircle, ArrowDownCircle, Search, SlidersHorizontal,
  RefreshCw, Download, AlertTriangle,
} from "lucide-react";
import { useLocation } from "wouter";

interface WalletRow {
  walletId: string;
  residentId: string;
  residentName: string;
  residentEmail: string;
  residentStatus: string;
  roomNumber?: string | null;
  walletEnabled: boolean;
  balance: number;
  isActive: boolean;
  isNegative: boolean;
  isLowBalance: boolean;
  propertyId: string | null;
  propertyName: string | null;
  updatedAt: string;
}

interface WalletOverviewResponse {
  success: boolean;
  data: WalletRow[];
  meta: { total: number; limit: number; offset: number; negativeCount: number; totalBalance: number };
}

type WalletStatus = "ALL" | "NEGATIVE" | "LOW" | "HEALTHY" | "INACTIVE";

function walletStatusBadge(row: WalletRow) {
  if (!row.walletEnabled) return <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>;
  if (row.isNegative) return <Badge variant="destructive">Negative</Badge>;
  if (row.isLowBalance) return <Badge variant="outline" className="text-yellow-700 border-yellow-400">Low Balance</Badge>;
  return <Badge variant="secondary" className="text-green-700">Healthy</Badge>;
}

function balanceBadge(row: WalletRow) {
  const fmt = row.balance.toLocaleString("en-IN", { minimumFractionDigits: 2 });
  if (row.isNegative) return <span className="font-mono text-sm font-semibold text-destructive">₹{fmt}</span>;
  if (row.isLowBalance) return <span className="font-mono text-sm font-semibold text-yellow-600">₹{fmt}</span>;
  return <span className="font-mono text-sm font-semibold text-green-700">₹{fmt}</span>;
}

export default function WalletPage() {
  const [, setLocation] = useLocation();
  const { can } = usePermissions();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [statusFilter, setStatusFilter] = React.useState<WalletStatus>("ALL");

  const [topupOpen, setTopupOpen] = React.useState(false);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [selectedRow, setSelectedRow] = React.useState<WalletRow | null>(null);

  const [topupAmount, setTopupAmount] = React.useState("");
  const [topupDesc, setTopupDesc] = React.useState("Cash top-up by staff");
  const [topupNotes, setTopupNotes] = React.useState("");

  const [adjustType, setAdjustType] = React.useState<"ADJUSTMENT_CREDIT" | "ADJUSTMENT_DEBIT">("ADJUSTMENT_CREDIT");
  const [adjustAmount, setAdjustAmount] = React.useState("");
  const [adjustDesc, setAdjustDesc] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: propertiesRes } = useGetProperties({ query: { queryKey: getGetPropertiesQueryKey() } } as any);
  const properties = (propertiesRes as any)?.data || [];

  const queryKey = ["wallet-overview", propertyId, debouncedSearch];
  const { data, isLoading } = useQuery<WalletOverviewResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: "200" });
      if (propertyId !== "ALL") params.set("propertyId", propertyId);
      if (debouncedSearch) params.set("search", debouncedSearch);
      return apiFetch(`/wallet/overview?${params}`);
    },
  });

  const allWallets = data?.data || [];
  const meta = data?.meta;

  const wallets = React.useMemo(() => {
    if (statusFilter === "ALL") return allWallets;
    if (statusFilter === "NEGATIVE") return allWallets.filter((w) => w.isNegative);
    if (statusFilter === "LOW") return allWallets.filter((w) => w.isLowBalance && !w.isNegative);
    if (statusFilter === "HEALTHY") return allWallets.filter((w) => !w.isNegative && !w.isLowBalance && w.walletEnabled);
    if (statusFilter === "INACTIVE") return allWallets.filter((w) => !w.walletEnabled);
    return allWallets;
  }, [allWallets, statusFilter]);

  const totalLoadedBalance = allWallets.filter((w) => w.balance > 0).reduce((s, w) => s + w.balance, 0);
  const negativeCount = meta?.negativeCount ?? allWallets.filter((w) => w.isNegative).length;
  const lowCount = allWallets.filter((w) => w.isLowBalance && !w.isNegative).length;
  const inactiveCount = allWallets.filter((w) => !w.walletEnabled).length;

  const canEdit = can("WALLET", "edit");
  const canCreate = can("WALLET", "create");

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const topupMut = useMutation({
    mutationFn: (payload: { residentId: string; amount: number; description: string; notes: string }) =>
      apiFetch(`/wallet/residents/${payload.residentId}/topup`, {
        method: "POST",
        body: JSON.stringify({ amount: payload.amount, description: payload.description, notes: payload.notes }),
      }),
    onSuccess: () => {
      toast({ title: "Top-up successful" });
      invalidate();
      setTopupOpen(false);
      setTopupAmount("");
      setTopupDesc("Cash top-up by staff");
      setTopupNotes("");
      setSelectedRow(null);
    },
    onError: (err: Error) => toast({ title: "Top-up failed", description: err.message, variant: "destructive" }),
  });

  const adjustMut = useMutation({
    mutationFn: (payload: { residentId: string; type: string; amount: number; description: string }) =>
      apiFetch(`/wallet/residents/${payload.residentId}/adjust`, {
        method: "POST",
        body: JSON.stringify({ type: payload.type, amount: payload.amount, description: payload.description }),
      }),
    onSuccess: () => {
      toast({ title: "Adjustment applied" });
      invalidate();
      setAdjustOpen(false);
      setAdjustAmount("");
      setAdjustDesc("");
      setSelectedRow(null);
    },
    onError: (err: Error) => toast({ title: "Adjustment failed", description: err.message, variant: "destructive" }),
  });

  function openTopup(e: React.MouseEvent, row: WalletRow) {
    e.stopPropagation();
    setSelectedRow(row);
    setTopupDesc("Cash top-up by staff");
    setTopupAmount("");
    setTopupNotes("");
    setTopupOpen(true);
  }

  function openAdjust(e: React.MouseEvent, row: WalletRow) {
    e.stopPropagation();
    setSelectedRow(row);
    setAdjustAmount("");
    setAdjustDesc("");
    setAdjustType("ADJUSTMENT_CREDIT");
    setAdjustOpen(true);
  }

  function exportCsv() {
    const rows = [
      ["Resident", "Email", "Room", "Property", "Balance", "Status", "Wallet Enabled", "Last Updated"].join(","),
      ...wallets.map((w) =>
        [
          `"${w.residentName}"`,
          w.residentEmail,
          w.roomNumber || "",
          `"${w.propertyName || ""}"`,
          w.balance.toFixed(2),
          w.isNegative ? "NEGATIVE" : w.isLowBalance ? "LOW" : w.walletEnabled ? "HEALTHY" : "INACTIVE",
          w.walletEnabled ? "Yes" : "No",
          new Date(w.updatedAt).toLocaleDateString(),
        ].join(",")
      ),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wallet_overview_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const projectedBalance = selectedRow
    ? selectedRow.balance + (parseFloat(topupAmount) || 0)
    : 0;

  const STATUS_OPTIONS: { value: WalletStatus; label: string }[] = [
    { value: "ALL", label: "All Statuses" },
    { value: "NEGATIVE", label: `Negative (${negativeCount})` },
    { value: "LOW", label: `Low Balance (${lowCount})` },
    { value: "HEALTHY", label: "Healthy" },
    { value: "INACTIVE", label: `Inactive (${inactiveCount})` },
  ];

  const columns: ColumnDef<WalletRow>[] = [
    {
      accessorKey: "residentName",
      header: "Resident",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.residentName}</div>
          <div className="text-xs text-muted-foreground">{row.original.residentEmail}</div>
        </div>
      ),
    },
    {
      accessorKey: "roomNumber",
      header: "Room",
      cell: ({ row }) =>
        row.original.roomNumber
          ? <Badge variant="outline">{row.original.roomNumber}</Badge>
          : <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "propertyName",
      header: "Property",
      cell: ({ row }) => row.original.propertyName || "—",
    },
    {
      accessorKey: "balance",
      header: "Balance",
      cell: ({ row }) => balanceBadge(row.original),
    },
    {
      id: "walletStatus",
      header: "Wallet Status",
      cell: ({ row }) => walletStatusBadge(row.original),
    },
    {
      accessorKey: "residentStatus",
      header: "Resident",
      cell: ({ row }) => <StatusBadge status={row.original.residentStatus} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1 justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); setLocation(`/wallet/${row.original.residentId}`); }}
          >
            Transactions
          </Button>
          {canCreate && row.original.walletEnabled && (
            <Button size="sm" variant="outline" onClick={(e) => openTopup(e, row.original)}>
              <ArrowUpCircle className="w-3.5 h-3.5 mr-1" /> Top-up
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={(e) => openAdjust(e, row.original)}>
              Adjust
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wallet"
        subtitle="Resident wallet balances and transaction management"
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={invalidate}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Loaded Balance"
          value={`₹${totalLoadedBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}
          icon={Wallet}
        />
        <StatCard
          title="Negative Balances"
          value={negativeCount}
          icon={ArrowDownCircle}
        />
        <StatCard
          title="Low Balance Alerts"
          value={lowCount}
          icon={AlertTriangle}
        />
        <StatCard
          title="Inactive Wallets"
          value={inactiveCount}
          icon={SlidersHorizontal}
        />
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search residents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All Properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Properties</SelectItem>
              {properties.map((p: any) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as WalletStatus)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={wallets}
        isLoading={isLoading}
        onRowClick={(row) => setLocation(`/wallet/${row.residentId}`)}
      />

      <FormModal
        open={topupOpen}
        onOpenChange={(o) => { if (!o) { setTopupOpen(false); setSelectedRow(null); } }}
        title={`Top-up — ${selectedRow?.residentName ?? ""}`}
        onSave={() => {
          const amt = parseFloat(topupAmount);
          if (!selectedRow || isNaN(amt) || amt <= 0) {
            toast({ title: "Enter a valid amount", variant: "destructive" });
            return;
          }
          topupMut.mutate({ residentId: selectedRow.residentId, amount: amt, description: topupDesc, notes: topupNotes });
        }}
        isSaving={topupMut.isPending}
        saveLabel="Top-up"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Current balance: ₹{selectedRow?.balance?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "0.00"}
          </p>
          <div className="space-y-1.5">
            <Label>Amount (₹)</Label>
            <Input
              type="number"
              min="1"
              step="1"
              placeholder="500"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
            />
          </div>
          {topupAmount && parseFloat(topupAmount) > 0 && (
            <div className="p-3 rounded-lg bg-surface border text-sm">
              Projected balance:{" "}
              <span className={projectedBalance < 0 ? "text-destructive font-semibold" : "text-green-600 font-semibold"}>
                ₹{projectedBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={topupDesc} onChange={(e) => setTopupDesc(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              value={topupNotes}
              onChange={(e) => setTopupNotes(e.target.value)}
              placeholder="Denomination details, reason, etc."
              rows={2}
            />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={adjustOpen}
        onOpenChange={(o) => { if (!o) { setAdjustOpen(false); setSelectedRow(null); } }}
        title={`Manual Adjustment — ${selectedRow?.residentName ?? ""}`}
        onSave={() => {
          const amt = parseFloat(adjustAmount);
          if (!selectedRow || isNaN(amt) || amt <= 0) {
            toast({ title: "Enter a valid amount", variant: "destructive" });
            return;
          }
          if (adjustDesc.length < 5) {
            toast({ title: "Description must be at least 5 characters", variant: "destructive" });
            return;
          }
          adjustMut.mutate({ residentId: selectedRow.residentId, type: adjustType, amount: amt, description: adjustDesc });
        }}
        isSaving={adjustMut.isPending}
        saveLabel="Apply Adjustment"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Current balance: ₹{selectedRow?.balance?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "0.00"}
          </p>
          <div>
            <Label>Type</Label>
            <Select value={adjustType} onValueChange={(v) => setAdjustType(v as typeof adjustType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ADJUSTMENT_CREDIT">Credit — add funds</SelectItem>
                <SelectItem value="ADJUSTMENT_DEBIT">Debit — remove funds</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amount (₹)</Label>
            <Input type="number" min="1" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} />
          </div>
          <div>
            <Label>Reason / Description</Label>
            <Input
              value={adjustDesc}
              onChange={(e) => setAdjustDesc(e.target.value)}
              placeholder="Correction for..."
            />
          </div>
        </div>
      </FormModal>
    </div>
  );
}
