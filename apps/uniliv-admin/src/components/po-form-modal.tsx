import * as React from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberStepper } from "@/components/ui/number-stepper";
import { UNITS } from "@/components/indent-form-modal";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";

interface POItem {
  itemName: string;
  specification: string;
  quantity: number | string;
  unit: string;
  rate: number | string;
}

interface PrefillData {
  vendorId?: string;
  propertyId?: string;
  indentId?: string;
  items?: POItem[];
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: PrefillData;
  onCreated?: () => void;
}

const PAYMENT_TERMS = ["Net 15", "Net 30", "Net 45", "Advance", "COD"];
const emptyRow: POItem = { itemName: "", specification: "", quantity: 1, unit: "", rate: 0 };

export function POFormModal({ open, onOpenChange, prefill, onCreated }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [vendorId, setVendorId] = React.useState("");
  const [propertyId, setPropertyId] = React.useState("");
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [paymentTerms, setPaymentTerms] = React.useState("Net 30");
  const [gstApplicable, setGstApplicable] = React.useState(true);
  const [notes, setNotes] = React.useState("");
  const [items, setItems] = React.useState<POItem[]>([{ ...emptyRow }]);
  const [saving, setSaving] = React.useState(false);

  const { data: vendorsRes } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["vendors", "all-active"],
    queryFn: () => apiFetch(`/vendors?status=ACTIVE`),
    enabled: open,
  });
  const vendors = vendorsRes?.data || [];

  const { data: propsRes } = useGetProperties(undefined, {
    query: { queryKey: getGetPropertiesQueryKey() },
  });
  const properties = propsRes?.data || [];

  const { data: rcRes } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/vendors/${vendorId}/rate-contracts`, vendorId],
    queryFn: () => apiFetch(`/vendors/${vendorId}/rate-contracts`),
    enabled: !!vendorId,
  });
  const rates = rcRes?.data || [];

  const { data: itemSugRes } = useQuery<{ success: boolean; data: string[] }>({
    queryKey: ["procurement", "item-suggestions"],
    queryFn: () => apiFetch(`/procurement/item-suggestions`),
  });
  const itemOptions = React.useMemo(
    () => (itemSugRes?.data || []).map((s) => ({ value: s, label: s })),
    [itemSugRes],
  );

  React.useEffect(() => {
    if (open) {
      setVendorId(prefill?.vendorId || "");
      setPropertyId(prefill?.propertyId || "");
      setDeliveryDate("");
      setPaymentTerms("Net 30");
      setGstApplicable(true);
      setNotes("");
      setItems(prefill?.items && prefill.items.length > 0 ? prefill.items.map((i) => ({ ...emptyRow, ...i })) : [{ ...emptyRow }]);
    }
  }, [open, prefill]);

  const updateItem = (idx: number, key: keyof POItem, value: any) => {
    setItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const next = { ...it, [key]: value };
      if (key === "itemName" && rates.length > 0) {
        const match = rates.find((r) => r.itemName?.toLowerCase() === String(value).toLowerCase());
        if (match) {
          next.rate = match.rate;
          if (!next.unit) next.unit = match.unit;
        }
      }
      return next;
    }));
  };

  const addRow = () => setItems((p) => [...p, { ...emptyRow }]);
  const removeRow = (idx: number) => setItems((p) => p.filter((_, i) => i !== idx));

  const subtotal = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0);
  const gst = gstApplicable ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
  const total = subtotal + gst;

  const submit = async () => {
    if (!vendorId) { toast({ title: "Select a vendor", variant: "destructive" }); return; }
    const cleaned = items.filter((i) => i.itemName.trim());
    if (cleaned.length === 0) { toast({ title: "Add at least one item", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = {
        vendorId,
        propertyId: propertyId || undefined,
        indentId: prefill?.indentId,
        items: cleaned.map((i) => ({
          itemName: i.itemName,
          specification: i.specification,
          quantity: Number(i.quantity),
          unit: i.unit,
          rate: Number(i.rate),
        })),
        gstApplicable,
        paymentTerms,
        deliveryDate: deliveryDate || undefined,
        notes: notes || undefined,
        status: "DRAFT",
      };
      await apiFetch(`/purchase-orders`, { method: "POST", body: JSON.stringify(body) });
      toast({ title: "Purchase order created" });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
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
      title="Create Purchase Order"
      onSave={submit}
      isSaving={saving}
      saveLabel="Create PO"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Vendor *</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger data-testid="select-po-vendor"><SelectValue placeholder="Select vendor" /></SelectTrigger>
              <SelectContent>
                {vendors.map((v: any) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}{v.gstin ? ` — ${v.gstin}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Property</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Delivery Date</Label>
            <DatePicker value={deliveryDate} onChange={setDeliveryDate} />
          </div>
          <div className="col-span-2">
            <Label>Payment Terms</Label>
            <Select value={paymentTerms} onValueChange={setPaymentTerms}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Items</Label>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Row
            </Button>
          </div>
          <div className="space-y-2">
            {items.map((it, idx) => {
              const amount = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
              return (
                <div key={idx} className="border rounded-md p-3 bg-card space-y-2">
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-5">
                      <Combobox
                        options={itemOptions}
                        value={it.itemName || null}
                        onChange={(v) => updateItem(idx, "itemName", v || "")}
                        placeholder="Item name *"
                        searchPlaceholder="Search or add item…"
                        creatable
                      />
                    </div>
                    <div className="col-span-5">
                      <Input placeholder="Specification" value={it.specification} onChange={(e) => updateItem(idx, "specification", e.target.value)} />
                    </div>
                    <div className="col-span-2 flex justify-end">
                      <Button type="button" size="icon" variant="ghost" onClick={() => removeRow(idx)} disabled={items.length === 1}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                    <div className="col-span-3">
                      <NumberStepper
                        aria-label="Quantity"
                        value={Number(it.quantity) || 0}
                        onChange={(n) => updateItem(idx, "quantity", n)}
                        min={0}
                        className="w-full"
                      />
                    </div>
                    <div className="col-span-3">
                      <Select value={it.unit || undefined} onValueChange={(v) => updateItem(idx, "unit", v)}>
                        <SelectTrigger><SelectValue placeholder="Unit" /></SelectTrigger>
                        <SelectContent>
                          {[...new Set([...UNITS, ...(it.unit && !UNITS.includes(it.unit) ? [it.unit] : [])])].map((u) => (
                            <SelectItem key={u} value={u}>{u}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Input type="number" min={0} step="0.01" placeholder="Rate" value={it.rate} onChange={(e) => updateItem(idx, "rate", e.target.value)} />
                    </div>
                    <div className="col-span-3 text-right text-sm font-medium pt-2">
                      ₹{amount.toLocaleString("en-IN")}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox checked={gstApplicable} onCheckedChange={(v) => setGstApplicable(!!v)} id="gst-applicable" />
          <label htmlFor="gst-applicable" className="text-sm">GST Applicable (18%)</label>
        </div>

        <div className="border-t pt-3 space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-medium">₹{subtotal.toLocaleString("en-IN")}</span></div>
          {gstApplicable && (
            <div className="flex justify-between"><span className="text-muted-foreground">GST (18%)</span><span className="font-medium">₹{gst.toLocaleString("en-IN")}</span></div>
          )}
          <div className="flex justify-between text-base font-display font-bold border-t pt-2">
            <span>Total</span><span>₹{total.toLocaleString("en-IN")}</span>
          </div>
        </div>

        <div>
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </FormModal>
  );
}
