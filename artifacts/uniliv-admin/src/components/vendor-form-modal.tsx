import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
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
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";

export const VENDOR_CATEGORIES = [
  "Groceries",
  "Electrical",
  "Plumbing",
  "Housekeeping",
  "IT",
  "Furniture",
  "Laundry",
  "Other",
];

const schema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().min(7, "Required"),
  email: z.string().email("Invalid").optional().or(z.literal("")),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  address: z.string().optional(),
  bankAccount: z.string().optional(),
  ifscCode: z.string().optional(),
  status: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vendor?: any;
  onSaved?: () => void;
}

export function VendorFormModal({ open, onOpenChange, vendor, onSaved }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [categories, setCategories] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", phone: "", email: "", gstin: "", pan: "",
      address: "", bankAccount: "", ifscCode: "", status: "ACTIVE",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: vendor?.name || "",
        phone: vendor?.phone || "",
        email: vendor?.email || "",
        gstin: vendor?.gstin || "",
        pan: vendor?.pan || "",
        address: vendor?.address || "",
        bankAccount: vendor?.bankAccount || "",
        ifscCode: vendor?.ifscCode || "",
        status: vendor?.status || "ACTIVE",
      });
      setCategories(vendor?.categories || []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vendor]);

  const onSubmit = form.handleSubmit(async (v) => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...v, categories };
      Object.keys(body).forEach((k) => body[k] === "" && delete body[k]);
      if (vendor?.id) {
        await apiFetch(`/vendors/${vendor.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Vendor updated" });
      } else {
        await apiFetch(`/vendors`, { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Vendor created" });
      }
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: [`/api/vendors/${vendor?.id}`] });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  });

  const toggleCat = (c: string) => {
    setCategories((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]);
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={vendor?.id ? "Edit Vendor" : "Add Vendor"}
      onSave={onSubmit}
      isSaving={saving}
      saveLabel={vendor?.id ? "Save Changes" : "Create Vendor"}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Name *</Label>
            <Input {...form.register("name")} data-testid="input-vendor-name" />
            {form.formState.errors.name && <p className="text-xs text-destructive mt-1">{form.formState.errors.name.message}</p>}
          </div>
          <div>
            <Label>Phone *</Label>
            <Input type="tel" {...form.register("phone")} data-testid="input-vendor-phone" />
            {form.formState.errors.phone && <p className="text-xs text-destructive mt-1">{form.formState.errors.phone.message}</p>}
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" {...form.register("email")} />
          </div>
          <div>
            <Label>GSTIN</Label>
            <Input
              {...form.register("gstin", {
                onChange: (e) => {
                  e.target.value = e.target.value.toUpperCase();
                },
              })}
              className="font-mono uppercase"
              maxLength={15}
              placeholder="22AAAAA0000A1Z5"
            />
          </div>
          <div>
            <Label>PAN</Label>
            <Input
              {...form.register("pan", {
                onChange: (e) => {
                  e.target.value = e.target.value.toUpperCase();
                },
              })}
              className="font-mono uppercase"
              maxLength={10}
              placeholder="AAAAA0000A"
            />
          </div>
          <div className="col-span-2">
            <Label>Address</Label>
            <Textarea rows={2} {...form.register("address")} />
          </div>
        </div>

        <div>
          <Label>Categories</Label>
          <div className="grid grid-cols-2 gap-2 mt-2 p-3 border rounded-md bg-card">
            {VENDOR_CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={categories.includes(c)} onCheckedChange={() => toggleCat(c)} />
                {c}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Bank Account</Label>
            <Input
              {...form.register("bankAccount", {
                onChange: (e) => {
                  e.target.value = e.target.value.toUpperCase();
                },
              })}
              className="font-mono uppercase"
              maxLength={18}
              inputMode="numeric"
            />
          </div>
          <div>
            <Label>IFSC Code</Label>
            <Input
              {...form.register("ifscCode", {
                onChange: (e) => {
                  e.target.value = e.target.value.toUpperCase();
                },
              })}
              className="font-mono uppercase"
              maxLength={11}
              placeholder="HDFC0001234"
            />
          </div>
          <div className="col-span-2">
            <Label>Status</Label>
            <Select value={form.watch("status") || "ACTIVE"} onValueChange={(v) => form.setValue("status", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </FormModal>
  );
}
