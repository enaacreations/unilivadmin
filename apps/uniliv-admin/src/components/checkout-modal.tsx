import * as React from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  getGetResidentQueryKey,
  getGetResidentLedgerQueryKey,
  getGetResidentsQueryKey,
  type ResidentDto,
  type LedgerEntryDto,
} from "@workspace/api-client-react";
import { FormModal } from "@/components/ui/form-modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { Wallet } from "lucide-react";

interface CheckoutModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  resident: ResidentDto;
  ledger: LedgerEntryDto[];
}

export function CheckoutModal({ open, onOpenChange, resident, ledger }: CheckoutModalProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const dues = ledger.filter((l) => !l.isPaid).reduce((s, l) => s + (l.amount || 0), 0);

  const [checkoutDate, setCheckoutDate] = React.useState(new Date().toISOString().split("T")[0]);
  const [reason, setReason] = React.useState("");
  const [keyReturned, setKeyReturned] = React.useState(true);
  const [roomConditionNote, setRoomConditionNote] = React.useState("");
  const [deductions, setDeductions] = React.useState(0);
  const [refundAmount, setRefundAmount] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [walletSettled, setWalletSettled] = React.useState(false);
  const [settlingWallet, setSettlingWallet] = React.useState(false);

  const { data: walletRes } = useQuery<{
    success: boolean;
    data: { id: string; balance: number; isActive: boolean; walletEnabled: boolean };
  }>({
    queryKey: ["checkout-wallet", resident.id],
    queryFn: () => apiFetch(`/wallet/residents/${resident.id}`),
    enabled: open,
  });
  const wallet = walletRes?.data;
  const walletBalance = wallet?.balance ?? 0;
  const hasPositiveWalletBalance = walletBalance > 0 && wallet?.walletEnabled;

  React.useEffect(() => {
    if (open) {
      setCheckoutDate(new Date().toISOString().split("T")[0]);
      setReason("");
      setKeyReturned(true);
      setRoomConditionNote("");
      setDeductions(0);
      setRefundAmount((resident.securityDeposit || 0) - 0);
      setWalletSettled(false);
    }
  }, [open, resident]);

  React.useEffect(() => {
    setRefundAmount((resident.securityDeposit || 0) - deductions);
  }, [deductions, resident.securityDeposit]);

  const handleSettleWallet = async () => {
    setSettlingWallet(true);
    try {
      await apiFetch(`/wallet/residents/${resident.id}/checkout-refund`, { method: "POST" });
      toast({ title: `Wallet balance ₹${walletBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })} settled` });
      qc.invalidateQueries({ queryKey: ["checkout-wallet", resident.id] });
      setWalletSettled(true);
    } catch (e: any) {
      toast({ title: e?.message || "Wallet settlement failed", variant: "destructive" });
    } finally {
      setSettlingWallet(false);
    }
  };

  const onConfirm = async () => {
    setSubmitting(true);
    try {
      await apiFetch(`/residents/${resident.id}/checkout`, {
        method: "POST",
        body: JSON.stringify({
          checkoutDate,
          reason,
          deductions,
          refundAmount,
          keyReturned,
          roomConditionNote,
        }),
      });
      toast({ title: "Resident checked out" });
      qc.invalidateQueries({ queryKey: getGetResidentQueryKey(resident.id) });
      qc.invalidateQueries({ queryKey: getGetResidentLedgerQueryKey(resident.id) });
      qc.invalidateQueries({ queryKey: getGetResidentsQueryKey() });
      onOpenChange(false);
      setLocation("/residents");
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Check Out Resident"
      onSave={onConfirm}
      isSaving={submitting}
      saveLabel="Confirm Checkout"
    >
      <div className="space-y-4">
        <Card className="bg-destructive/5 border-destructive/20">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Final Outstanding Dues</p>
            <p className="text-2xl font-display font-bold text-destructive">₹{dues.toLocaleString("en-IN")}</p>
          </CardContent>
        </Card>

        {wallet && (
          <Card className={walletSettled ? "bg-success/5 border-success/20" : hasPositiveWalletBalance ? "bg-yellow-50 border-yellow-200 dark:bg-yellow-900/10 dark:border-yellow-800" : "bg-surface"}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Wallet className="w-4 h-4 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground uppercase">Wallet Balance</p>
                  </div>
                  <p className={`text-xl font-display font-bold ${walletBalance < 0 ? "text-destructive" : walletBalance > 0 ? "text-green-600" : "text-primary"}`}>
                    ₹{walletBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </p>
                  {walletSettled && (
                    <Badge variant="secondary" className="text-green-700 mt-1">Settled</Badge>
                  )}
                  {!wallet.walletEnabled && (
                    <Badge variant="outline" className="text-muted-foreground mt-1">Wallet inactive</Badge>
                  )}
                </div>
                {hasPositiveWalletBalance && !walletSettled && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSettleWallet}
                    disabled={settlingWallet}
                  >
                    {settlingWallet ? "Settling…" : "Settle & Refund Wallet"}
                  </Button>
                )}
              </div>
              {hasPositiveWalletBalance && !walletSettled && (
                <p className="text-xs text-muted-foreground mt-2">
                  The wallet balance will be refunded to the resident before closing their account.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div>
          <Label>Checkout Date *</Label>
          <DatePicker value={checkoutDate} onChange={setCheckoutDate} data-testid="input-checkout-date" />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex items-center justify-between border rounded-lg p-3">
          <Label>Key Returned</Label>
          <Switch checked={keyReturned} onCheckedChange={setKeyReturned} data-testid="switch-key-returned" />
        </div>
        <div>
          <Label>Room Condition Note</Label>
          <Textarea rows={2} value={roomConditionNote} onChange={(e) => setRoomConditionNote(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Deductions (₹)</Label>
            <Input type="number" value={deductions} onChange={(e) => setDeductions(Number(e.target.value))} data-testid="input-deductions" />
          </div>
          <div>
            <Label>Refund Amount (₹)</Label>
            <Input type="number" value={refundAmount} onChange={(e) => setRefundAmount(Number(e.target.value))} data-testid="input-refund" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Auto-suggested refund = Security Deposit (₹{(resident.securityDeposit || 0).toLocaleString("en-IN")}) − Deductions
        </p>
      </div>
    </FormModal>
  );
}
