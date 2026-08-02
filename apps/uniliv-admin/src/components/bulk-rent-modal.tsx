import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProperties,
  getGetPropertiesQueryKey,
  useGetResidents,
  getGetResidentsQueryKey,
} from "@workspace/api-client-react";
import { FormModal } from "@/components/ui/form-modal";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface BulkRentModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function BulkRentModal({ open, onOpenChange }: BulkRentModalProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [propertyId, setPropertyId] = React.useState("");
  const [month, setMonth] = React.useState<string>(String(new Date().getMonth() + 1));
  const [year, setYear] = React.useState<number>(new Date().getFullYear());
  const [submitting, setSubmitting] = React.useState(false);

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const { data: residentsRes } = useGetResidents(
    { propertyId },
    { query: { queryKey: getGetResidentsQueryKey({ propertyId }), enabled: !!propertyId } }
  );
  const activeResidents = (residentsRes?.data || []).filter((r) => r.status === "ACTIVE");
  const totalAmount = activeResidents.reduce((s, r) => s + (r.monthlyRent || 0), 0);

  React.useEffect(() => {
    if (open) {
      setPropertyId("");
      setMonth(String(new Date().getMonth() + 1));
      setYear(new Date().getFullYear());
    }
  }, [open]);

  const onConfirm = async () => {
    if (!propertyId) {
      toast({ title: "Select a property", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { success: number; failed: number; total: number; month: string } }>(
        "/residents/bulk-rent",
        {
          method: "POST",
          body: JSON.stringify({ propertyId, month: Number(month), year }),
        }
      );
      toast({ title: `Rent charged to ${res.data.success} residents (${res.data.failed} failed)` });
      qc.invalidateQueries({ queryKey: getGetResidentsQueryKey() });
      onOpenChange(false);
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
      title="Bulk Rent Charge"
      onSave={onConfirm}
      isSaving={submitting}
      saveLabel="Confirm & Charge"
    >
      <div className="space-y-4">
        <div>
          <Label>Property *</Label>
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger data-testid="select-bulk-property"><SelectValue placeholder="Select property" /></SelectTrigger>
            <SelectContent>
              {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Month *</Label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger data-testid="select-bulk-month"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (<SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Year *</Label>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} data-testid="input-bulk-year" />
          </div>
        </div>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Preview</p>
            <div className="flex items-center justify-between mt-2">
              <div>
                <p className="text-xs text-muted-foreground">Active Residents</p>
                <p className="text-2xl font-display font-bold text-primary">{activeResidents.length}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total Amount</p>
                <p className="text-2xl font-display font-bold text-accent">₹{totalAmount.toLocaleString("en-IN")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </FormModal>
  );
}
