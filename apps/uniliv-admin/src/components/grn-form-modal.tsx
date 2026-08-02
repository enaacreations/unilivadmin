import * as React from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberStepper } from "@/components/ui/number-stepper";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";

interface GRNItem {
  itemName: string;
  unit: string;
  qtyOrdered: number;
  qtyReceived: number | string;
  condition: string;
  damageNotes?: string;
  rate?: number;
  category?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefillPoId?: string;
  onCreated?: () => void;
}

export function GRNFormModal({ open, onOpenChange, prefillPoId, onCreated }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [poId, setPoId] = React.useState("");
  const [invoiceNumber, setInvoiceNumber] = React.useState("");
  const [invoicePhotoUrl, setInvoicePhotoUrl] = React.useState("");
  const [qcPass, setQcPass] = React.useState(true);
  const [qcNotes, setQcNotes] = React.useState("");
  const [items, setItems] = React.useState<GRNItem[]>([]);
  const [saving, setSaving] = React.useState(false);

  const { data: posRes } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["purchase-orders", "for-grn"],
    queryFn: () => apiFetch(`/purchase-orders`),
    enabled: open,
  });
  const eligible = (posRes?.data || []).filter((p) => ["SENT", "ACKNOWLEDGED", "PARTIAL_DELIVERY"].includes(p.status));

  const { data: poDetailRes } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/purchase-orders/${poId}`, poId],
    queryFn: () => apiFetch(`/purchase-orders/${poId}`),
    enabled: !!poId,
  });
  const po = poDetailRes?.data;

  React.useEffect(() => {
    if (open) {
      setPoId(prefillPoId || "");
      setInvoiceNumber("");
      setInvoicePhotoUrl("");
      setQcPass(true);
      setQcNotes("");
      setItems([]);
    }
  }, [open, prefillPoId]);

  React.useEffect(() => {
    if (po && Array.isArray(po.items)) {
      setItems(po.items.map((i: any) => ({
        itemName: i.itemName,
        unit: i.unit || "",
        qtyOrdered: Number(i.quantity) || 0,
        qtyReceived: Number(i.quantity) || 0,
        condition: "GOOD",
        damageNotes: "",
        rate: Number(i.rate) || 0,
        category: i.category,
      })));
    }
  }, [po]);

  const updateItem = (idx: number, key: keyof GRNItem, value: any) => {
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, [key]: value } : it));
  };

  const submit = async () => {
    if (!poId) { toast({ title: "Select a PO", variant: "destructive" }); return; }
    if (items.length === 0) { toast({ title: "No items to receive", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        poId,
        propertyId: po?.propertyId,
        items: items.map((i) => ({
          itemName: i.itemName,
          unit: i.unit,
          qtyOrdered: i.qtyOrdered,
          qtyReceived: Number(i.qtyReceived),
          condition: i.condition,
          damageNotes: i.condition === "DAMAGED" ? i.damageNotes : undefined,
          rate: i.rate,
          category: i.category,
        })),
        invoiceNumber: invoiceNumber || undefined,
        invoicePhotoUrl: invoicePhotoUrl || undefined,
        qcPass,
        qcNotes: qcNotes || undefined,
        photos: [],
      };
      await apiFetch(`/grn`, { method: "POST", body: JSON.stringify(body) });
      toast({ title: "GRN created", description: "Inventory updated successfully" });
      qc.invalidateQueries({ queryKey: ["grn"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      onCreated?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Create GRN"
      onSave={submit}
      isSaving={saving}
      saveLabel="Receive Goods"
    >
      <div className="space-y-4">
        <div>
          <Label>Purchase Order *</Label>
          <Select value={poId} onValueChange={setPoId}>
            <SelectTrigger><SelectValue placeholder="Select PO" /></SelectTrigger>
            <SelectContent>
              {eligible.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No eligible POs</div>}
              {eligible.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.poNumber} — {p.vendorName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {po && (
          <div className="border rounded-md p-3 bg-surface text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Vendor</span><span className="font-medium">{po.vendor?.name}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="font-medium">₹{Number(po.totalAmount || 0).toLocaleString("en-IN")}</span></div>
          </div>
        )}

        {items.length > 0 && (
          <div>
            <Label>Items Received</Label>
            <div className="space-y-2 mt-1">
              {items.map((it, idx) => (
                <div key={idx} className="border rounded-md p-3 bg-card space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{it.itemName}</span>
                    <span className="text-xs text-muted-foreground">Ordered: {it.qtyOrdered} {it.unit}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Qty Received *</Label>
                      <div className="mt-1">
                        <NumberStepper
                          aria-label="Quantity received"
                          value={Number(it.qtyReceived) || 0}
                          onChange={(n) => updateItem(idx, "qtyReceived", n)}
                          min={0}
                          className="w-full"
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Condition</Label>
                      <Select value={it.condition} onValueChange={(v) => updateItem(idx, "condition", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="GOOD">Good</SelectItem>
                          <SelectItem value="DAMAGED">Damaged</SelectItem>
                          <SelectItem value="SHORT">Short</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {it.condition === "DAMAGED" && (
                      <div className="col-span-2">
                        <Label className="text-xs">Damage Notes</Label>
                        <Input value={it.damageNotes || ""} onChange={(e) => updateItem(idx, "damageNotes", e.target.value)} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Invoice Number</Label>
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>Invoice Photo URL</Label>
            <Input value={invoicePhotoUrl} onChange={(e) => setInvoicePhotoUrl(e.target.value)} placeholder="https://..." />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox checked={qcPass} onCheckedChange={(v) => setQcPass(!!v)} id="qc-pass" />
          <label htmlFor="qc-pass" className="text-sm">QC Pass</label>
        </div>

        <div>
          <Label>QC Notes</Label>
          <Textarea rows={2} value={qcNotes} onChange={(e) => setQcNotes(e.target.value)} />
        </div>
      </div>
    </FormModal>
  );
}
