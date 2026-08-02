import * as React from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";

export const DEPARTMENTS = ["Operations", "Housekeeping", "Kitchen", "Maintenance", "Admin"];

// Common units of measure for procurement line items.
export const UNITS = ["kg", "g", "litre", "ml", "pcs", "plate", "dozen", "box", "packet"];

interface IndentItem {
  itemName: string;
  specification: string;
  quantity: number | string;
  unit: string;
  estUnitPrice: number | string;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  indent?: any;
  prefillItem?: { itemName: string; unit: string };
  onSaved?: () => void;
}

const emptyRow: IndentItem = { itemName: "", specification: "", quantity: 1, unit: "", estUnitPrice: 0 };

export function IndentFormModal({ open, onOpenChange, indent, prefillItem, onSaved }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [propertyId, setPropertyId] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [urgency, setUrgency] = React.useState("NORMAL");
  const [purpose, setPurpose] = React.useState("");
  const [budgetHead, setBudgetHead] = React.useState("");
  const [items, setItems] = React.useState<IndentItem[]>([{ ...emptyRow }]);
  const [saving, setSaving] = React.useState<"draft" | "submit" | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const { data: propsRes } = useGetProperties(undefined, {
    query: { queryKey: getGetPropertiesQueryKey() },
  });
  const properties = propsRes?.data || [];

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
      setPropertyId(indent?.propertyId || "");
      setDepartment(indent?.department || "");
      setUrgency(indent?.urgency || "NORMAL");
      setPurpose(indent?.purpose || "");
      setBudgetHead(indent?.budgetHead || "");
      if (indent?.items?.length) {
        setItems(indent.items.map((i: any) => ({ ...emptyRow, ...i })));
      } else if (prefillItem) {
        setItems([{ ...emptyRow, itemName: prefillItem.itemName, unit: prefillItem.unit }]);
      } else {
        setItems([{ ...emptyRow }]);
      }
      setErrors({});
    }
  }, [open, indent, prefillItem]);

  const updateItem = (idx: number, key: keyof IndentItem, value: any) => {
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, [key]: value } : it));
  };
  const addRow = () => setItems((p) => [...p, { ...emptyRow }]);
  const removeRow = (idx: number) => setItems((p) => p.filter((_, i) => i !== idx));

  const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.estUnitPrice) || 0), 0);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!propertyId) e.propertyId = "Required";
    if (!department) e.department = "Required";
    const cleaned = items.filter((i) => i.itemName.trim());
    if (cleaned.length === 0) e.items = "Add at least one item";
    cleaned.forEach((i, idx) => {
      if (!i.unit) e[`unit-${idx}`] = "Unit required";
      if (!Number(i.quantity)) e[`qty-${idx}`] = "Qty required";
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (status: "DRAFT" | "SUBMITTED") => {
    if (!validate()) return;
    setSaving(status === "DRAFT" ? "draft" : "submit");
    try {
      const cleaned = items.filter((i) => i.itemName.trim());
      const body = {
        propertyId, department, urgency, purpose: purpose || undefined, budgetHead: budgetHead || undefined,
        items: cleaned.map((i) => ({
          itemName: i.itemName,
          specification: i.specification,
          quantity: Number(i.quantity),
          unit: i.unit,
          estUnitPrice: Number(i.estUnitPrice) || 0,
        })),
        status,
      };
      if (indent?.id) {
        await apiFetch(`/indents/${indent.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: status === "DRAFT" ? "Draft saved" : "Indent submitted" });
      } else {
        await apiFetch(`/indents`, { method: "POST", body: JSON.stringify(body) });
        toast({ title: status === "DRAFT" ? "Draft saved" : "Indent submitted for approval" });
      }
      qc.invalidateQueries({ queryKey: ["indents"] });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={indent?.id ? "Edit Indent" : "Raise Indent"}
      showFooter={false}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Property *</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
              </SelectContent>
            </Select>
            {errors.propertyId && <p className="text-xs text-destructive mt-1">{errors.propertyId}</p>}
          </div>
          <div>
            <Label>Department *</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {DEPARTMENTS.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
              </SelectContent>
            </Select>
            {errors.department && <p className="text-xs text-destructive mt-1">{errors.department}</p>}
          </div>
          <div>
            <Label>Urgency</Label>
            <Select value={urgency} onValueChange={setUrgency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NORMAL">Normal</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
                <SelectItem value="CRITICAL">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Budget Head</Label>
            <Input value={budgetHead} onChange={(e) => setBudgetHead(e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label>Purpose</Label>
            <Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Items</Label>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Row
            </Button>
          </div>
          {errors.items && <p className="text-xs text-destructive mb-2">{errors.items}</p>}
          <div className="space-y-2">
            {items.map((it, idx) => (
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
                    {errors[`qty-${idx}`] && <p className="text-[10px] text-destructive">{errors[`qty-${idx}`]}</p>}
                  </div>
                  <div className="col-span-3">
                    <Select value={it.unit || undefined} onValueChange={(v) => updateItem(idx, "unit", v)}>
                      <SelectTrigger><SelectValue placeholder="Unit *" /></SelectTrigger>
                      <SelectContent>
                        {UNITS.map((u) => (<SelectItem key={u} value={u}>{u}</SelectItem>))}
                      </SelectContent>
                    </Select>
                    {errors[`unit-${idx}`] && <p className="text-[10px] text-destructive">{errors[`unit-${idx}`]}</p>}
                  </div>
                  <div className="col-span-3">
                    <Input type="number" min={0} step="0.01" placeholder="Est. Rate" value={it.estUnitPrice} onChange={(e) => updateItem(idx, "estUnitPrice", e.target.value)} />
                  </div>
                  <div className="col-span-3 text-right text-sm font-medium pt-2">
                    ₹{((Number(it.quantity) || 0) * (Number(it.estUnitPrice) || 0)).toLocaleString("en-IN")}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-2 text-sm">
            <span className="text-muted-foreground mr-2">Total Estimated:</span>
            <span className="font-display font-bold">₹{total.toLocaleString("en-IN")}</span>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 bg-surface pt-4 mt-6 border-t flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!saving}>Cancel</Button>
        <Button variant="outline" onClick={() => submit("DRAFT")} disabled={!!saving}>
          {saving === "draft" && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Save as Draft
        </Button>
        <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => submit("SUBMITTED")} disabled={!!saving}>
          {saving === "submit" && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Submit for Approval
        </Button>
      </div>
    </FormModal>
  );
}
