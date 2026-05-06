import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { Wallet, ArrowUpCircle, ArrowDownCircle, Search, SlidersHorizontal, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";

interface WalletRow {
  walletId: string;
  residentId: string;
  residentName: string;
  residentEmail: string;
  residentStatus: string;
  walletEnabled: boolean;
  balance: number;
  isActive: boolean;
  propertyId: string | null;
  propertyName: string | null;
  updatedAt: string;
}

interface WalletOverviewResponse {
  success: boolean;
  data: WalletRow[];
  meta: { total: number; limit: number; offset: number };
}

export default function WalletPage() {
  const [, setLocation] = useLocation();
  const { can } = usePermissions();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState("");
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [topupOpen, setTopupOpen] = React.useState(false);
  const [selectedRow, setSelectedRow] = React.useState<WalletRow | null>(null);
  const [topupAmount, setTopupAmount] = React.useState("");
  const [topupDesc, setTopupDesc] = React.useState("");
  const [topupNotes, setTopupNotes] = React.useState("");

  const { data: propertiesRes } = useGetProperties({ query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propertiesRes?.data || [];

  const queryKey = ["wallet-overview", propertyId, search];
  const { data, isLoading } = useQuery<WalletOverviewResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (propertyId !== "ALL") params.set("propertyId", propertyId);
      if (search) params.set("search", search);
      return apiFetch(`/wallet/overview?${params}`);
    },
  });

  const wallets = data?.data || [];

  const totalBalance = wallets.reduce((s, w) => s + w.balance, 0);
  const positiveCount = wallets.filter((w) => w.balance > 0).length;
  const lowCount = wallets.filter((w) => w.balance < 200 && w.balance >= 0).length;
  const negativeCount = wallets.filter((w) => w.balance < 0).length;

  const topupMutation = useMutation({
    mutationFn: (payload: { residentId: string; amount: number; description: string; notes: string }) =>
      apiFetch(`/wallet/residents/${payload.residentId}/topup`, {
        method: "POST",
        body: JSON.stringify({ amount: payload.amount, description: payload.description, notes: payload.notes }),
      }),
    onSuccess: () => {
      toast({ title: "Top-up successful" });
      queryClient.invalidateQueries({ queryKey });
      setTopupOpen(false);
      setTopupAmount("");
      setTopupDesc("");
      setTopupNotes("");
      setSelectedRow(null);
    },
    onError: (err: Error) => toast({ title: "Top-up failed", description: err.message, variant: "destructive" }),
  });

  function openTopup(row: WalletRow) {
    setSelectedRow(row);
    setTopupDesc("Cash top-up by staff");
    setTopupOpen(true);
  }

  function handleTopupSubmit() {
    const amt = parseFloat(topupAmount);
    if (!selectedRow || isNaN(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    topupMutation.mutate({
      residentId: selectedRow.residentId,
      amount: amt,
      description: topupDesc,
      notes: topupNotes,
    });
  }

  function balanceBadge(balance: number) {
    if (balance < 0) return <Badge variant="destructive">₹{balance.toFixed(2)}</Badge>;
    if (balance < 200) return <Badge variant="outline" className="text-yellow-600 border-yellow-400">₹{balance.toFixed(2)}</Badge>;
    return <Badge variant="secondary" className="text-green-700">₹{balance.toFixed(2)}</Badge>;
  }

  const columns = [
    {
      key: "residentName",
      label: "Resident",
      render: (row: WalletRow) => (
        <div>
          <div className="font-medium">{row.residentName}</div>
          <div className="text-xs text-muted-foreground">{row.residentEmail}</div>
        </div>
      ),
    },
    { key: "propertyName", label: "Property", render: (row: WalletRow) => row.propertyName || "—" },
    {
      key: "balance",
      label: "Balance",
      render: (row: WalletRow) => balanceBadge(row.balance),
    },
    {
      key: "walletEnabled",
      label: "Status",
      render: (row: WalletRow) =>
        row.walletEnabled ? (
          <Badge variant="secondary" className="text-green-700">Active</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
        ),
    },
    {
      key: "residentStatus",
      label: "Resident",
      render: (row: WalletRow) => <StatusBadge status={row.residentStatus} />,
    },
    {
      key: "actions",
      label: "",
      render: (row: WalletRow) => (
        <div className="flex gap-2 justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); setLocation(`/residents/${row.residentId}`); }}
          >
            View
          </Button>
          {can("WALLET", "create") && row.walletEnabled && (
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); openTopup(row); }}
            >
              <ArrowUpCircle className="w-3.5 h-3.5 mr-1" />
              Top-up
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
        description="Resident wallet balances and transaction management"
        actions={
          <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey })}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Wallet Balance"
          value={`₹${totalBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}
          icon={Wallet}
        />
        <StatCard title="Positive Balance" value={positiveCount} icon={ArrowUpCircle} />
        <StatCard title="Low Balance (<₹200)" value={lowCount} icon={SlidersHorizontal} />
        <StatCard title="Negative Balance" value={negativeCount} icon={ArrowDownCircle} />
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
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={wallets}
        isLoading={isLoading}
        onRowClick={(row) => setLocation(`/residents/${row.residentId}`)}
        emptyMessage="No wallets found"
      />

      <FormModal
        open={topupOpen}
        onClose={() => { setTopupOpen(false); setSelectedRow(null); }}
        title={`Top-up Wallet — ${selectedRow?.residentName}`}
        description={`Current balance: ₹${selectedRow?.balance?.toFixed(2) ?? "0.00"}`}
        onSubmit={handleTopupSubmit}
        isLoading={topupMutation.isPending}
      >
        <div className="space-y-4">
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
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input
              value={topupDesc}
              onChange={(e) => setTopupDesc(e.target.value)}
              placeholder="Cash top-up by staff"
            />
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
    </div>
  );
}
