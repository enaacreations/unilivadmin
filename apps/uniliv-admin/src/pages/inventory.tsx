import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Plus, AlertTriangle, Package, PackageX, Clock, Boxes, Search, Bell, ClipboardCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = ["Groceries", "Electrical", "Plumbing", "Housekeeping", "IT", "Furniture", "Laundry", "Other"];
const STATUS_OPTIONS = ["ALL", "OK", "LOW_STOCK", "OUT_OF_STOCK", "EXPIRING_SOON", "EXPIRED"];

const itemSchema = z.object({
  name: z.string().min(1, "Required"),
  category: z.string().min(1, "Required"),
  unit: z.string().min(1, "Required"),
  minStock: z.coerce.number().min(0),
  currentStock: z.coerce.number().min(0).optional(),
  propertyId: z.string().optional(),
  sku: z.string().optional(),
  location: z.string().optional(),
  expiryDate: z.string().optional(),
  isAsset: z.boolean().optional(),
  assetTag: z.string().optional(),
  condition: z.string().optional(),
});
type ItemForm = z.infer<typeof itemSchema>;

export default function Inventory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [search, setSearch] = React.useState("");
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [category, setCategory] = React.useState("ALL");
  const [status, setStatus] = React.useState("ALL");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [alertsOpen, setAlertsOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const params: Record<string, string> = {};
  if (search) params.search = search;
  if (propertyId !== "ALL") params.propertyId = propertyId;
  if (category !== "ALL") params.category = category;
  if (status !== "ALL") params.status = status;
  const qs = new URLSearchParams(params).toString();

  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["inventory", params],
    queryFn: () => apiFetch(`/inventory${qs ? `?${qs}` : ""}`),
  });
  const items = res?.data || [];

  const { data: statsRes } = useQuery<{ success: boolean; data: { totalSkus: number; lowStock: number; outOfStock: number; expiringSoon: number } }>({
    queryKey: ["inventory-stats"],
    queryFn: () => apiFetch(`/inventory/stats`),
  });
  const stats = statsRes?.data;

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];
  const propName = (id?: string | null) => id ? (properties.find((p) => p.id === id)?.name || "—") : "—";

  const form = useForm<ItemForm>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: "", category: "", unit: "", minStock: 0, currentStock: 0, propertyId: "", sku: "", location: "", expiryDate: "", isAsset: false, assetTag: "", condition: "" },
  });
  const isAsset = form.watch("isAsset");

  React.useEffect(() => {
    if (createOpen) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen]);

  const [saving, setSaving] = React.useState(false);
  const onCreate = form.handleSubmit(async (v) => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...v };
      Object.keys(body).forEach((k) => (body[k] === "" || body[k] === undefined) && delete body[k]);
      await apiFetch(`/inventory`, { method: "POST", body: JSON.stringify(body) });
      toast({ title: "Inventory item created" });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-stats"] });
      setCreateOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  });

  const cols = [
    { accessorKey: "name", header: "Item", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span> },
    { accessorKey: "sku", header: "SKU", cell: ({ row }: any) => row.original.sku ? <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.sku}</span> : <span className="text-muted-foreground text-xs">—</span> },
    { accessorKey: "category", header: "Category", cell: ({ row }: any) => <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{row.original.category}</Badge> },
    { accessorKey: "propertyId", header: "Property", cell: ({ row }: any) => propName(row.original.propertyId) },
    { accessorKey: "currentStock", header: "Stock", cell: ({ row }: any) => <span className="font-medium">{row.original.currentStock} {row.original.unit}</span> },
    { accessorKey: "minStock", header: "Min", cell: ({ row }: any) => <span className="text-muted-foreground text-xs">{row.original.minStock}</span> },
    { accessorKey: "expiryDate", header: "Expiry", cell: ({ row }: any) => row.original.expiryDate ? format(new Date(row.original.expiryDate), "dd MMM yyyy") : "—" },
    { accessorKey: "stockStatus", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.stockStatus || (row.original.isLowStock ? "LOW_STOCK" : "OK")} /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        subtitle="Track stock levels and asset conditions"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAlertsOpen(true)}>
              <Bell className="w-4 h-4 mr-2" /> Stock Alerts
            </Button>
            <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Item
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total SKUs" value={stats?.totalSkus ?? "—"} icon={Boxes} />
        <StatCard title="Low Stock Items" value={stats?.lowStock ?? "—"} icon={AlertTriangle} />
        <StatCard title="Expiring This Week" value={stats?.expiringSoon ?? "—"} icon={Clock} />
        <StatCard title="Out of Stock" value={stats?.outOfStock ?? "—"} icon={PackageX} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search items..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Categories</SelectItem>
            {CATEGORIES.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (<SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={cols as any} data={items} isLoading={isLoading} onRowClick={(row: any) => setDetailId(row.id)} />

      {/* Add item modal */}
      <FormModal open={createOpen} onOpenChange={setCreateOpen} title="Add Inventory Item" onSave={onCreate} isSaving={saving} saveLabel="Create Item">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Name *</Label>
              <Input {...form.register("name")} />
              {form.formState.errors.name && <p className="text-xs text-destructive mt-1">{form.formState.errors.name.message}</p>}
            </div>
            <div>
              <Label>Category *</Label>
              <Select value={form.watch("category") || ""} onValueChange={(v) => form.setValue("category", v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                </SelectContent>
              </Select>
              {form.formState.errors.category && <p className="text-xs text-destructive mt-1">{form.formState.errors.category.message}</p>}
            </div>
            <div>
              <Label>Unit *</Label>
              <Input {...form.register("unit")} placeholder="kg, pcs, ltr..." />
              {form.formState.errors.unit && <p className="text-xs text-destructive mt-1">{form.formState.errors.unit.message}</p>}
            </div>
            <div>
              <Label>Min Stock *</Label>
              <Input type="number" {...form.register("minStock")} />
            </div>
            <div>
              <Label>Current Stock</Label>
              <Input type="number" {...form.register("currentStock")} />
            </div>
            <div>
              <Label>Property</Label>
              <Select value={form.watch("propertyId") || ""} onValueChange={(v) => form.setValue("propertyId", v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>SKU</Label>
              <Input {...form.register("sku")} className="font-mono" />
            </div>
            <div>
              <Label>Location</Label>
              <Input {...form.register("location")} />
            </div>
            <div>
              <Label>Expiry Date</Label>
              <ControlledDatePicker control={form.control} name="expiryDate" />
            </div>
          </div>

          <div className="flex items-center gap-2 border-t pt-3">
            <Checkbox checked={!!isAsset} onCheckedChange={(v) => form.setValue("isAsset", !!v)} id="is-asset" />
            <label htmlFor="is-asset" className="text-sm">Is Asset</label>
          </div>

          {isAsset && (
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Asset Tag</Label><Input {...form.register("assetTag")} className="font-mono" /></div>
              <div>
                <Label>Condition</Label>
                <Select value={form.watch("condition") || ""} onValueChange={(v) => form.setValue("condition", v)}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="New">New</SelectItem>
                    <SelectItem value="Good">Good</SelectItem>
                    <SelectItem value="Fair">Fair</SelectItem>
                    <SelectItem value="Poor">Poor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      </FormModal>

      <InventoryDetailSheet id={detailId} onClose={() => setDetailId(null)} propName={propName} />
      <StockAlertsSheet open={alertsOpen} onOpenChange={setAlertsOpen} onCreateIndent={(item) => {
        sessionStorage.setItem("prefilledIndentItem", JSON.stringify({ itemName: item.name, unit: item.unit }));
        setLocation("/indents");
      }} />
    </div>
  );
}

function InventoryDetailSheet({ id, onClose, propName }: { id: string | null; onClose: () => void; propName: (id?: string | null) => string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: itemRes, isLoading } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/inventory/${id}`, id],
    queryFn: () => apiFetch(`/inventory/${id}`),
    enabled: !!id,
  });
  const item = itemRes?.data;

  const { data: movRes } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/inventory/${id}/movements`, id],
    queryFn: () => apiFetch(`/inventory/${id}/movements`),
    enabled: !!id,
  });
  const movements = movRes?.data || [];

  const [consumeOpen, setConsumeOpen] = React.useState(false);
  const [auditOpen, setAuditOpen] = React.useState(false);
  const [consumeForm, setConsumeForm] = React.useState({ quantity: "", purpose: "", notes: "" });
  const [auditForm, setAuditForm] = React.useState({ physicalCount: "", notes: "" });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { if (consumeOpen) setConsumeForm({ quantity: "", purpose: "", notes: "" }); }, [consumeOpen]);
  React.useEffect(() => { if (auditOpen) setAuditForm({ physicalCount: "", notes: "" }); }, [auditOpen]);

  const consume = async () => {
    if (!consumeForm.quantity || !consumeForm.purpose) { toast({ title: "Quantity and purpose required", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiFetch(`/inventory/${id}/consume`, { method: "POST", body: JSON.stringify({ quantity: Number(consumeForm.quantity), purpose: consumeForm.purpose, notes: consumeForm.notes || undefined }) });
      toast({ title: "Consumption recorded" });
      qc.invalidateQueries({ queryKey: [`/api/inventory/${id}`, id] });
      qc.invalidateQueries({ queryKey: [`/api/inventory/${id}/movements`, id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      setConsumeOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const audit = async () => {
    if (!auditForm.physicalCount) { toast({ title: "Physical count required", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const r = await apiFetch<{ success: boolean; data: { variance: number; newStock: number } }>(`/inventory/${id}/audit`, { method: "POST", body: JSON.stringify({ physicalCount: Number(auditForm.physicalCount), notes: auditForm.notes || undefined }) });
      toast({ title: "Audit recorded", description: `Variance: ${r.data.variance}, New Stock: ${r.data.newStock}` });
      qc.invalidateQueries({ queryKey: [`/api/inventory/${id}`, id] });
      qc.invalidateQueries({ queryKey: [`/api/inventory/${id}/movements`, id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      setAuditOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <>
      <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
        <SheetContent className="sm:max-w-2xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="font-display flex items-center gap-3">
              {item ? <>{item.name} <StatusBadge status={item.stockStatus || (item.isLowStock ? "LOW_STOCK" : "OK")} /></> : "Inventory Item"}
            </SheetTitle>
          </SheetHeader>
          {isLoading ? (
            <div className="space-y-3 mt-6"><div className="h-24 bg-muted/30 animate-pulse rounded" /><div className="h-32 bg-muted/30 animate-pulse rounded" /></div>
          ) : !item ? (
            <p className="text-sm text-muted-foreground p-4 text-center mt-6">Could not load this item.</p>
          ) : (
            <div className="space-y-6 mt-6">

              <div className="grid grid-cols-2 gap-3 text-sm border rounded-md p-4 bg-card">
                <div><p className="text-muted-foreground text-xs uppercase">SKU</p><p className="font-mono">{item.sku || "—"}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Category</p><p className="font-medium">{item.category}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Property</p><p className="font-medium">{propName(item.propertyId)}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Location</p><p className="font-medium">{item.location || "—"}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Current Stock</p><p className="font-display font-bold text-lg">{item.currentStock} {item.unit}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Min Stock</p><p className="font-medium">{item.minStock}</p></div>
                {item.expiryDate && (<div><p className="text-muted-foreground text-xs uppercase">Expiry</p><p className="font-medium">{format(new Date(item.expiryDate), "dd MMM yyyy")}</p></div>)}
                {item.isAsset && (<>
                  <div><p className="text-muted-foreground text-xs uppercase">Asset Tag</p><p className="font-mono">{item.assetTag || "—"}</p></div>
                  <div><p className="text-muted-foreground text-xs uppercase">Condition</p><p className="font-medium">{item.condition || "—"}</p></div>
                </>)}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setConsumeOpen(true)}>
                  <Package className="w-4 h-4 mr-2" /> Record Consumption
                </Button>
                <Button variant="outline" onClick={() => setAuditOpen(true)}>
                  <ClipboardCheck className="w-4 h-4 mr-2" /> Stock Audit
                </Button>
              </div>

              <Tabs defaultValue="movements">
                <TabsList>
                  <TabsTrigger value="movements">Movements</TabsTrigger>
                  <TabsTrigger value="audit">Audit Log</TabsTrigger>
                </TabsList>
                <TabsContent value="movements" className="mt-4">
                  {movements.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-4 border rounded-md text-center">No movements yet.</p>
                  ) : (
                    <table className="w-full text-sm border rounded-md overflow-hidden">
                      <thead className="bg-muted/40">
                        <tr><th className="text-left p-2">Date</th><th className="text-left p-2">Type</th><th className="text-right p-2">Qty</th><th className="text-left p-2">Reference</th><th className="text-left p-2">Notes</th></tr>
                      </thead>
                      <tbody>
                        {movements.map((m: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="p-2">{m.createdAt ? format(new Date(m.createdAt), "dd MMM, HH:mm") : "—"}</td>
                            <td className="p-2"><Badge variant={m.type === "OUT" ? "destructive" : "secondary"} className={`text-[10px] ${m.type === "IN" ? "bg-green-600 text-white hover:bg-green-700" : ""}`}>{m.type}</Badge></td>
                            <td className="p-2 text-right font-medium">{m.quantity}</td>
                            <td className="p-2 text-xs">{m.reference || "—"}</td>
                            <td className="p-2 text-xs text-muted-foreground">{m.notes || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Recent Audits</CardTitle></CardHeader>
                    <CardContent>
                      {movements.filter((m: any) => m.type === "ADJUSTMENT").length === 0 ? (
                        <p className="text-sm text-muted-foreground">No audits recorded yet.</p>
                      ) : (
                        <ul className="space-y-2 text-sm">
                          {movements.filter((m: any) => m.type === "ADJUSTMENT").map((m: any, i: number) => (
                            <li key={i} className="border-b pb-2">
                              <div className="flex justify-between">
                                <span className="font-medium">{m.createdAt ? format(new Date(m.createdAt), "dd MMM yyyy") : ""}</span>
                                <span>Adjustment: <span className="font-medium">{m.quantity}</span></span>
                              </div>
                              {m.notes && <p className="text-xs text-muted-foreground mt-1">{m.notes}</p>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <FormModal open={consumeOpen} onOpenChange={setConsumeOpen} title="Record Consumption" onSave={consume} isSaving={busy} saveLabel="Record">
        <div className="space-y-4">
          <div><Label>Quantity *</Label><Input type="number" value={consumeForm.quantity} onChange={(e) => setConsumeForm({ ...consumeForm, quantity: e.target.value })} /></div>
          <div><Label>Purpose *</Label><Input value={consumeForm.purpose} onChange={(e) => setConsumeForm({ ...consumeForm, purpose: e.target.value })} /></div>
          <div><Label>Notes</Label><Textarea rows={2} value={consumeForm.notes} onChange={(e) => setConsumeForm({ ...consumeForm, notes: e.target.value })} /></div>
        </div>
      </FormModal>

      <FormModal open={auditOpen} onOpenChange={setAuditOpen} title="Stock Audit" onSave={audit} isSaving={busy} saveLabel="Record Audit">
        <div className="space-y-4">
          <div><Label>Physical Count *</Label><Input type="number" value={auditForm.physicalCount} onChange={(e) => setAuditForm({ ...auditForm, physicalCount: e.target.value })} /></div>
          <div><Label>Notes</Label><Textarea rows={2} value={auditForm.notes} onChange={(e) => setAuditForm({ ...auditForm, notes: e.target.value })} /></div>
        </div>
      </FormModal>
    </>
  );
}

function StockAlertsSheet({ open, onOpenChange, onCreateIndent }: { open: boolean; onOpenChange: (o: boolean) => void; onCreateIndent: (item: any) => void }) {
  const { data: res } = useQuery<{ success: boolean; data: { lowStock: any[]; expiring: any[] } }>({
    queryKey: ["inventory-alerts"],
    queryFn: () => apiFetch(`/inventory/alerts`),
    enabled: open,
  });
  const lowStock = res?.data?.lowStock || [];
  const expiring = res?.data?.expiring || [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-2"><Bell className="w-4 h-4" /> Stock Alerts</SheetTitle>
        </SheetHeader>
        <div className="space-y-6 mt-6">
          <div>
            <h4 className="text-sm font-medium mb-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-warning" /> Below Min Stock ({lowStock.length})</h4>
            {lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3 border border-dashed rounded-md">No items below minimum.</p>
            ) : (
              <div className="space-y-2">
                {lowStock.map((it: any) => (
                  <div key={it.id} className="border rounded-md p-3 flex items-center justify-between bg-card">
                    <div>
                      <p className="font-medium text-sm">{it.name}</p>
                      <p className="text-xs text-muted-foreground">{it.currentStock} / min {it.minStock} {it.unit}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => onCreateIndent(it)}>Create Indent</Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-medium mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-warning" /> Expiring within 7 Days ({expiring.length})</h4>
            {expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3 border border-dashed rounded-md">No items expiring soon.</p>
            ) : (
              <div className="space-y-2">
                {expiring.map((it: any) => (
                  <div key={it.id} className="border rounded-md p-3 flex items-center justify-between bg-card">
                    <div>
                      <p className="font-medium text-sm">{it.name}</p>
                      <p className="text-xs text-muted-foreground">Expires {it.expiryDate ? format(new Date(it.expiryDate), "dd MMM yyyy") : "—"}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => onCreateIndent(it)}>Create Indent</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
