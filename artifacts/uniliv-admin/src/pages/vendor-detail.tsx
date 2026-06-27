import * as React from "react";
import { useParams, useLocation } from "wouter";
import { withQuery } from "@/lib/nav-helpers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Edit, Plus, Star, FileText, Trash2, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/status-badge";
import { StatCard } from "@/components/stat-card";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from "recharts";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { VendorFormModal } from "@/components/vendor-form-modal";

const DOC_TYPES = ["Trade License", "FSSAI", "GST Certificate", "Other"];

export default function VendorDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = React.useState(false);

  const { data: vendorRes, isLoading } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/vendors/${id}`],
    queryFn: () => apiFetch(`/vendors/${id}`),
  });
  const vendor = vendorRes?.data;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!vendor) {
    return (
      <EmptyState icon={AlertTriangle} title="Vendor not found" description="This vendor may have been deleted." />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-display font-bold text-primary">{vendor.name}</h1>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {vendor.gstin && <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{vendor.gstin}</span>}
              <div className="flex items-center gap-1">
                <Star className="w-4 h-4 fill-warning text-warning" />
                <span className="text-sm font-medium">{vendor.rating ?? "—"}</span>
              </div>
              <StatusBadge status={vendor.status} />
            </div>
            <div className="flex gap-1 flex-wrap mt-2">
              {(vendor.categories || []).map((c: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-[10px] uppercase tracking-wider">{c}</Badge>
              ))}
            </div>
          </div>
          <Button onClick={() => setEditOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
            <Edit className="w-4 h-4 mr-2" /> Edit Vendor
          </Button>
        </div>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="rates">Rate Contracts</TabsTrigger>
          <TabsTrigger value="pos">Purchase Orders</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4 mt-4">
          <ProfileTab vendor={vendor} />
        </TabsContent>
        <TabsContent value="rates" className="mt-4">
          <RateContractsTab vendorId={id} />
        </TabsContent>
        <TabsContent value="pos" className="mt-4">
          <POsTab vendorId={id} onView={(po: any) => setLocation(withQuery("/purchase-orders", { poId: po?.id }))} />
        </TabsContent>
        <TabsContent value="compliance" className="mt-4">
          <ComplianceTab vendorId={id} />
        </TabsContent>
        <TabsContent value="performance" className="mt-4">
          <PerformanceTab vendorId={id} />
        </TabsContent>
      </Tabs>

      <VendorFormModal open={editOpen} onOpenChange={setEditOpen} vendor={vendor} onSaved={() => qc.invalidateQueries({ queryKey: [`/api/vendors/${id}`] })} />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value || "—"}</span>
    </div>
  );
}

function ProfileTab({ vendor }: { vendor: any }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="font-display text-base">Contact</CardTitle></CardHeader>
        <CardContent>
          <InfoRow label="Phone" value={vendor.phone} />
          <InfoRow label="Email" value={vendor.email} />
          <InfoRow label="Address" value={vendor.address} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="font-display text-base">Tax</CardTitle></CardHeader>
        <CardContent>
          <InfoRow label="GSTIN" value={vendor.gstin ? <span className="font-mono">{vendor.gstin}</span> : null} />
          <InfoRow label="PAN" value={vendor.pan ? <span className="font-mono">{vendor.pan}</span> : null} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="font-display text-base">Banking</CardTitle></CardHeader>
        <CardContent>
          <InfoRow label="Bank Account" value={vendor.bankAccount ? <span className="font-mono">{vendor.bankAccount}</span> : null} />
          <InfoRow label="IFSC Code" value={vendor.ifscCode ? <span className="font-mono">{vendor.ifscCode}</span> : null} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="font-display text-base">Status</CardTitle></CardHeader>
        <CardContent>
          <InfoRow label="Status" value={<StatusBadge status={vendor.status} />} />
          <InfoRow label="Rating" value={vendor.rating ?? "—"} />
          <InfoRow label="Created" value={vendor.createdAt ? format(new Date(vendor.createdAt), "dd MMM yyyy") : "—"} />
        </CardContent>
      </Card>
    </div>
  );
}

function RateContractsTab({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/vendors/${vendorId}/rate-contracts`],
    queryFn: () => apiFetch(`/vendors/${vendorId}/rate-contracts`),
  });
  const rates = res?.data || [];

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<any>(null);
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ itemName: "", unit: "", rate: "", validFrom: "", validTo: "", notes: "" });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      if (editing) {
        setForm({
          itemName: editing.itemName || "",
          unit: editing.unit || "",
          rate: String(editing.rate ?? ""),
          validFrom: editing.validFrom ? new Date(editing.validFrom).toISOString().slice(0, 10) : "",
          validTo: editing.validTo ? new Date(editing.validTo).toISOString().slice(0, 10) : "",
          notes: editing.notes || "",
        });
      } else {
        setForm({ itemName: "", unit: "", rate: "", validFrom: "", validTo: "", notes: "" });
      }
    }
  }, [open, editing]);

  const submit = async () => {
    if (!form.itemName || !form.unit || !form.rate || !form.validFrom || !form.validTo) {
      toast({ title: "Fill all required fields", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = { ...form, rate: Number(form.rate) };
      if (editing) {
        await apiFetch(`/vendors/rate-contracts/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Rate contract updated" });
      } else {
        await apiFetch(`/vendors/${vendorId}/rate-contracts`, { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Rate contract added" });
      }
      qc.invalidateQueries({ queryKey: [`/api/vendors/${vendorId}/rate-contracts`] });
      setOpen(false);
      setEditing(null);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirmDel) return;
    try {
      await apiFetch(`/vendors/rate-contracts/${confirmDel}`, { method: "DELETE" });
      toast({ title: "Rate contract deleted" });
      qc.invalidateQueries({ queryKey: [`/api/vendors/${vendorId}/rate-contracts`] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setConfirmDel(null);
    }
  };

  const cols = [
    { accessorKey: "itemName", header: "Item", cell: ({ row }: any) => <span className="font-medium">{row.original.itemName}</span> },
    { accessorKey: "rate", header: "Rate", cell: ({ row }: any) => `₹${Number(row.original.rate).toLocaleString("en-IN")}` },
    { accessorKey: "unit", header: "Unit" },
    { accessorKey: "validFrom", header: "Valid From", cell: ({ row }: any) => row.original.validFrom ? format(new Date(row.original.validFrom), "dd MMM yyyy") : "—" },
    { accessorKey: "validTo", header: "Valid To", cell: ({ row }: any) => row.original.validTo ? format(new Date(row.original.validTo), "dd MMM yyyy") : "—" },
    {
      id: "actions", header: "Actions",
      cell: ({ row }: any) => (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" onClick={() => { setEditing(row.original); setOpen(true); }}>
            <Edit className="w-3.5 h-3.5" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setConfirmDel(row.original.id)}>
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-accent hover:bg-accent/90 text-white">
          <Plus className="w-4 h-4 mr-2" /> Add Rate
        </Button>
      </div>
      <DataTable columns={cols as any} data={rates} isLoading={isLoading} />

      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Rate Contract" : "Add Rate Contract"} onSave={submit} isSaving={saving}>
        <div className="space-y-4">
          <div><Label>Item Name *</Label><Input value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Unit *</Label><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></div>
            <div><Label>Rate *</Label><Input type="number" step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></div>
            <div><Label>Valid From *</Label><DatePicker value={form.validFrom} onChange={(v) => setForm({ ...form, validFrom: v })} /></div>
            <div><Label>Valid To *</Label><DatePicker value={form.validTo} onChange={(v) => setForm({ ...form, validTo: v })} /></div>
          </div>
          <div><Label>Notes</Label><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
      </FormModal>

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => !o && setConfirmDel(null)}
        title="Delete Rate Contract?"
        description="This action cannot be undone."
        onConfirm={del}
        confirmLabel="Delete"
      />
    </div>
  );
}

function POsTab({ vendorId, onView }: { vendorId: string; onView: (po: any) => void }) {
  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/vendors/${vendorId}/purchase-orders`],
    queryFn: () => apiFetch(`/vendors/${vendorId}/purchase-orders`),
  });
  const pos = res?.data || [];

  const cols = [
    { accessorKey: "poNumber", header: "PO #", cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.poNumber}</span> },
    { accessorKey: "createdAt", header: "Date", cell: ({ row }: any) => row.original.createdAt ? format(new Date(row.original.createdAt), "dd MMM yyyy") : "—" },
    { accessorKey: "totalAmount", header: "Total", cell: ({ row }: any) => `₹${Number(row.original.totalAmount || 0).toLocaleString("en-IN")}` },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
  ];

  return <DataTable columns={cols as any} data={pos} isLoading={isLoading} onRowClick={onView} />;
}

function ComplianceTab({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: res } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/vendors/${vendorId}/documents`],
    queryFn: () => apiFetch(`/vendors/${vendorId}/documents`),
  });
  const docs = res?.data || [];

  const [open, setOpen] = React.useState(false);
  const [docType, setDocType] = React.useState("Trade License");
  const [form, setForm] = React.useState({ fileUrl: "", expiryDate: "", notes: "" });
  const [saving, setSaving] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null);

  const submit = async () => {
    if (!form.fileUrl) { toast({ title: "File URL required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await apiFetch(`/vendors/${vendorId}/documents`, { method: "POST", body: JSON.stringify({ docType, ...form, expiryDate: form.expiryDate || undefined }) });
      toast({ title: "Document added" });
      qc.invalidateQueries({ queryKey: [`/api/vendors/${vendorId}/documents`] });
      setOpen(false);
      setForm({ fileUrl: "", expiryDate: "", notes: "" });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirmDel) return;
    try {
      await apiFetch(`/vendors/documents/${confirmDel}`, { method: "DELETE" });
      toast({ title: "Document deleted" });
      qc.invalidateQueries({ queryKey: [`/api/vendors/${vendorId}/documents`] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setConfirmDel(null);
    }
  };

  const expiringCount = docs.filter((d) => d.expiringSoon).length;

  return (
    <div className="space-y-4">
      {expiringCount > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/10 text-destructive text-sm">
          <AlertTriangle className="w-4 h-4" />
          {expiringCount} document{expiringCount > 1 ? "s" : ""} expiring soon
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
          <Plus className="w-4 h-4 mr-2" /> Upload Document
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {DOC_TYPES.map((type) => {
          const matches = docs.filter((d) => d.docType === type);
          return (
            <Card key={type}>
              <CardHeader><CardTitle className="font-display text-base flex items-center gap-2"><FileText className="w-4 h-4" /> {type}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {matches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No document uploaded.</p>
                ) : matches.map((d) => (
                  <div key={d.id} className="border rounded-md p-3 bg-surface">
                    <div className="flex items-center justify-between gap-2">
                      <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" /> View Document
                      </a>
                      <Button size="icon" variant="ghost" onClick={() => setConfirmDel(d.id)}>
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {d.expiryDate && <>Expires: {format(new Date(d.expiryDate), "dd MMM yyyy")} </>}
                      {d.expiringSoon && <Badge variant="destructive" className="ml-2 text-[10px]">Expires Soon</Badge>}
                    </div>
                    {d.notes && <p className="text-xs mt-1">{d.notes}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <FormModal open={open} onOpenChange={setOpen} title="Upload Document" onSave={submit} isSaving={saving}>
        <div className="space-y-4">
          <div>
            <Label>Document Type *</Label>
            <Select value={docType} onValueChange={setDocType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>File URL *</Label><Input value={form.fileUrl} onChange={(e) => setForm({ ...form, fileUrl: e.target.value })} placeholder="https://..." /></div>
          <div><Label>Expiry Date</Label><DatePicker value={form.expiryDate} onChange={(v) => setForm({ ...form, expiryDate: v })} /></div>
          <div><Label>Notes</Label><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
      </FormModal>

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => !o && setConfirmDel(null)}
        title="Delete Document?"
        description="This action cannot be undone."
        onConfirm={del}
        confirmLabel="Delete"
      />
    </div>
  );
}

function PerformanceTab({ vendorId }: { vendorId: string }) {
  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/vendors/${vendorId}/performance`],
    queryFn: () => apiFetch(`/vendors/${vendorId}/performance`),
  });
  const data = res?.data || [];
  const latest = data[data.length - 1];

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (data.length === 0) return <EmptyState icon={AlertTriangle} title="No performance data yet" description="Data will appear after vendor processes orders." />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Latest Delivery Accuracy" value={`${latest?.deliveryAccuracy ?? 0}%`} icon={Star} />
        <StatCard title="Latest Quality Score" value={`${latest?.qualityScore ?? 0}%`} icon={Star} />
        <StatCard title="Latest Complaints" value={latest?.complaints ?? 0} icon={AlertTriangle} />
      </div>
      <Card>
        <CardHeader><CardTitle className="font-display text-base">Quarterly Performance</CardTitle></CardHeader>
        <CardContent className="h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 12 }} />
              <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} />
              <RechartsTooltip contentStyle={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }} />
              <Legend />
              <Bar dataKey="deliveryAccuracy" name="Delivery Accuracy %" fill="#0F172A" radius={[4, 4, 0, 0]} />
              <Bar dataKey="qualityScore" name="Quality Score %" fill="#F97316" radius={[4, 4, 0, 0]} />
              <Bar dataKey="complaints" name="Complaints" fill="#DC2626" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
