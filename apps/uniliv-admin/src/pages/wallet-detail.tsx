import * as React from "react";
import { useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { ChevronLeft, ArrowUpCircle, RotateCcw, Download, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { useGetResident, getGetResidentQueryKey } from "@workspace/api-client-react";

const PAGE_SIZE = 20;

const TX_COLOR: Record<string, string> = {
  TOPUP: "text-green-700",
  ADJUSTMENT_CREDIT: "text-green-600",
  REFUND_WITHDRAWAL: "text-green-500",
  PAYMENT: "text-red-600",
  PARTIAL_PAYMENT: "text-orange-600",
  ADJUSTMENT_DEBIT: "text-red-500",
  REVERSAL: "text-purple-600",
};

function isCredit(type: string) {
  return ["TOPUP", "ADJUSTMENT_CREDIT", "REFUND_WITHDRAWAL", "REVERSAL"].includes(type);
}

function txBadge(type: string) {
  return (
    <Badge variant="outline" className={TX_COLOR[type] || ""}>
      {type.replace(/_/g, " ")}
    </Badge>
  );
}

interface WalletInfo {
  id: string;
  balance: number;
  isActive: boolean;
  walletEnabled: boolean;
  transactionCount: number;
}

interface WalletTx {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  notes?: string | null;
  createdAt: string;
}

export default function WalletDetail() {
  const params = useParams<{ residentId: string }>();
  const residentId = params.residentId as string;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { role } = usePermissions();

  const [page, setPage] = React.useState(0);
  const [topupOpen, setTopupOpen] = React.useState(false);
  const [reversalOpen, setReversalOpen] = React.useState(false);
  const [topupAmount, setTopupAmount] = React.useState("");
  const [topupDesc, setTopupDesc] = React.useState("Cash top-up by staff");
  const [topupNotes, setTopupNotes] = React.useState("");
  const [reversalTxId, setReversalTxId] = React.useState("");
  const [reversalReason, setReversalReason] = React.useState("");

  const { data: residentRes, isLoading: residentLoading } = useGetResident(residentId, {
    query: { queryKey: getGetResidentQueryKey(residentId), enabled: !!residentId },
  });
  const resident = (residentRes as any)?.data;

  const walletQK = ["resident-wallet", residentId];
  const { data: walletRes, isLoading: walletLoading } = useQuery<{ success: boolean; data: WalletInfo }>({
    queryKey: walletQK,
    queryFn: () => apiFetch(`/wallet/residents/${residentId}`),
    enabled: !!residentId,
  });
  const wallet = walletRes?.data;

  const txQK = ["resident-wallet-txns-detail", residentId, page];
  const { data: txRes, isLoading: txLoading } = useQuery<{
    success: boolean;
    data: WalletTx[];
    meta: { total: number };
  }>({
    queryKey: txQK,
    queryFn: () =>
      apiFetch(`/wallet/residents/${residentId}/transactions?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
    enabled: !!residentId,
  });
  const txns = txRes?.data || [];
  const total = txRes?.meta?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: walletQK });
    qc.invalidateQueries({ queryKey: txQK });
  };

  const topupMut = useMutation({
    mutationFn: (body: object) =>
      apiFetch(`/wallet/residents/${residentId}/topup`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: "Top-up successful" });
      invalidate();
      setTopupOpen(false);
      setTopupAmount("");
      setTopupNotes("");
    },
    onError: (e: Error) => toast({ title: "Top-up failed", description: e.message, variant: "destructive" }),
  });

  const reversalMut = useMutation({
    mutationFn: (body: object) =>
      apiFetch(`/wallet/residents/${residentId}/reversal`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: "Reversal applied" });
      invalidate();
      setReversalOpen(false);
      setReversalTxId("");
      setReversalReason("");
    },
    onError: (e: Error) => toast({ title: "Reversal failed", description: e.message, variant: "destructive" }),
  });

  function exportCsv() {
    const rows = [
      ["Date", "Type", "Description", "Amount", "Balance After", "Notes"].join(","),
      ...txns.map((t) =>
        [
          format(new Date(t.createdAt), "yyyy-MM-dd HH:mm"),
          t.type,
          `"${t.description.replace(/"/g, '""')}"`,
          `${isCredit(t.type) ? "+" : "-"}${t.amount.toFixed(2)}`,
          t.balanceAfter.toFixed(2),
          `"${(t.notes || "").replace(/"/g, '""')}"`,
        ].join(",")
      ),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wallet_${(resident?.name || residentId).replace(/\s+/g, "_")}_${format(new Date(), "yyyyMMdd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const balanceColor =
    (wallet?.balance ?? 0) < 0
      ? "text-destructive"
      : (wallet?.balance ?? 0) < 200
      ? "text-yellow-600"
      : "text-green-600";

  const projectedBalance = (wallet?.balance ?? 0) + (parseFloat(topupAmount) || 0);

  const canTopup = wallet?.walletEnabled;
  const canReverse = isSuperAdminRole(role);

  if (residentLoading || walletLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/wallet">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Wallets
        </Button>
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-primary">{resident?.name || "Resident"}</h1>
          <div className="flex flex-wrap gap-2 mt-2">
            {resident?.propertyName && <Badge variant="secondary">{resident.propertyName}</Badge>}
            {resident?.roomNumber && <Badge variant="outline">Room {resident.roomNumber}</Badge>}
            {wallet?.walletEnabled
              ? <Badge variant="secondary" className="text-green-700">Wallet Active</Badge>
              : <Badge variant="outline" className="text-muted-foreground">Wallet Inactive</Badge>}
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {canTopup && (
            <Button size="sm" onClick={() => setTopupOpen(true)}>
              <ArrowUpCircle className="w-4 h-4 mr-2" /> Top-up
            </Button>
          )}
          {canReverse && (
            <Button size="sm" variant="outline" onClick={() => setReversalOpen(true)}>
              <RotateCcw className="w-4 h-4 mr-2" /> Reverse Transaction
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={txns.length === 0}>
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
          <Button size="sm" variant="ghost" onClick={invalidate}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="md:col-span-2">
          <CardContent className="p-6">
            <div className="text-xs text-muted-foreground uppercase mb-1">Current Balance</div>
            <div className={`text-4xl font-display font-bold ${balanceColor}`}>
              ₹{(wallet?.balance ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase mb-1">Total Transactions</div>
            <div className="text-2xl font-display font-bold text-primary">{wallet?.transactionCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase mb-1">Wallet</div>
            <div className="text-lg font-display font-bold text-primary">
              {wallet?.walletEnabled ? "Enabled" : "Disabled"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {txLoading ? (
            <div className="p-6 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : txns.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">No transactions yet.</div>
          ) : (
            <BoundedScroll size="md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txns.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {format(new Date(t.createdAt), "dd MMM yy, HH:mm")}
                    </TableCell>
                    <TableCell>{txBadge(t.type)}</TableCell>
                    <TableCell className="text-sm max-w-xs">
                      <div>{t.description}</div>
                      {t.notes && <div className="text-xs text-muted-foreground">{t.notes}</div>}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono text-sm font-semibold ${
                        isCredit(t.type) ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {isCredit(t.type) ? "+" : "−"}₹
                      {t.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      ₹{t.balanceAfter.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </BoundedScroll>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <FormModal
        open={topupOpen}
        onOpenChange={(o) => { if (!o) { setTopupOpen(false); setTopupAmount(""); setTopupNotes(""); } }}
        title={`Top-up — ${resident?.name ?? "Resident"}`}
        onSave={() => {
          const amt = parseFloat(topupAmount);
          if (isNaN(amt) || amt <= 0) {
            toast({ title: "Enter a valid amount", variant: "destructive" });
            return;
          }
          topupMut.mutate({ amount: amt, description: topupDesc, notes: topupNotes });
        }}
        isSaving={topupMut.isPending}
        saveLabel="Top-up"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Current balance: ₹{(wallet?.balance ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </p>
          <div>
            <Label>Amount (₹)</Label>
            <Input
              type="number"
              min="1"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              placeholder="500"
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
          <div>
            <Label>Description</Label>
            <Input value={topupDesc} onChange={(e) => setTopupDesc(e.target.value)} />
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={topupNotes} onChange={(e) => setTopupNotes(e.target.value)} />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={reversalOpen}
        onOpenChange={(o) => { if (!o) { setReversalOpen(false); setReversalTxId(""); setReversalReason(""); } }}
        title="Reverse Transaction"
        onSave={() => {
          if (!reversalTxId) {
            toast({ title: "Select a transaction to reverse", variant: "destructive" });
            return;
          }
          if (reversalReason.length < 10) {
            toast({ title: "Reason must be at least 10 characters", variant: "destructive" });
            return;
          }
          reversalMut.mutate({ reversalOf: reversalTxId, notes: reversalReason });
        }}
        isSaving={reversalMut.isPending}
        saveLabel="Apply Reversal"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Creates a correcting entry to offset the selected transaction.
          </p>
          <div>
            <Label>Transaction to reverse</Label>
            <Select value={reversalTxId} onValueChange={setReversalTxId}>
              <SelectTrigger>
                <SelectValue placeholder="Select transaction" />
              </SelectTrigger>
              <SelectContent>
                {txns
                  .filter((t) => t.type !== "REVERSAL")
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {format(new Date(t.createdAt), "dd MMM yy")} — {t.type.replace(/_/g, " ")} — ₹{t.amount.toFixed(2)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reason (min. 10 chars)</Label>
            <Textarea
              rows={2}
              value={reversalReason}
              onChange={(e) => setReversalReason(e.target.value)}
              placeholder="Entered wrong amount on..."
            />
          </div>
        </div>
      </FormModal>
    </div>
  );
}
