import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Plus, Eye, Download, Send, PackagePlus, Check, Search } from "lucide-react";
import jsPDF from "jspdf";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useQueryParam } from "@/lib/nav-helpers";
import { useToast } from "@/hooks/use-toast";
import { POFormModal } from "@/components/po-form-modal";
import { GRNFormModal } from "@/components/grn-form-modal";

const STATUS_OPTIONS = ["ALL", "DRAFT", "SENT", "ACKNOWLEDGED", "PARTIAL_DELIVERY", "DELIVERED", "CANCELLED"];
const TIMELINE_STEPS = ["DRAFT", "SENT", "ACKNOWLEDGED", "PARTIAL_DELIVERY", "DELIVERED"];

export default function PurchaseOrders() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = React.useState("ALL");
  const [vendorId, setVendorId] = React.useState("ALL");
  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [grnOpen, setGrnOpen] = React.useState(false);
  const [grnPoId, setGrnPoId] = React.useState<string | undefined>();
  const [detailId, setDetailId] = React.useState<string | null>(null);
  // Opened from a vendor's PO row (?poId=) → show that PO's detail sheet.
  const paramPoId = useQueryParam("poId");
  React.useEffect(() => { if (paramPoId) setDetailId(paramPoId); }, [paramPoId]);

  const params: Record<string, string> = {};
  if (status !== "ALL") params.status = status;
  if (vendorId !== "ALL") params.vendorId = vendorId;
  const qs = new URLSearchParams(params).toString();

  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["purchase-orders", params],
    queryFn: () => apiFetch(`/purchase-orders${qs ? `?${qs}` : ""}`),
  });
  const all = res?.data || [];
  const pos = search ? all.filter((p) => p.poNumber?.toLowerCase().includes(search.toLowerCase()) || p.vendorName?.toLowerCase().includes(search.toLowerCase())) : all;

  const { data: vendorsRes } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["vendors", "for-filter"],
    queryFn: () => apiFetch(`/vendors`),
  });
  const vendors = vendorsRes?.data || [];

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];
  const propName = (id?: string | null) => id ? (properties.find((p) => p.id === id)?.name || "—") : "—";

  const cols = [
    { accessorKey: "poNumber", header: "PO #", cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.poNumber}</span> },
    { accessorKey: "vendorName", header: "Vendor", cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.vendorName || "—"}</span> },
    { accessorKey: "propertyId", header: "Property", cell: ({ row }: any) => propName(row.original.propertyId) },
    { accessorKey: "totalAmount", header: "Total", cell: ({ row }: any) => `₹${Number(row.original.totalAmount || 0).toLocaleString("en-IN")}` },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
    { accessorKey: "deliveryDate", header: "Delivery", cell: ({ row }: any) => row.original.deliveryDate ? format(new Date(row.original.deliveryDate), "dd MMM yyyy") : "—" },
    { accessorKey: "createdAt", header: "Created", cell: ({ row }: any) => row.original.createdAt ? format(new Date(row.original.createdAt), "dd MMM yyyy") : "—" },
    {
      id: "actions", header: "Actions",
      cell: ({ row }: any) => (
        <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); setDetailId(row.original.id); }}>
          <Eye className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Orders"
        subtitle="Manage external orders and vendor fulfillment"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Create PO
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search PO # or vendor..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (<SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={vendorId} onValueChange={setVendorId}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Vendor" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Vendors</SelectItem>
            {vendors.map((v) => (<SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={cols as any} data={pos} isLoading={isLoading} onRowClick={(row: any) => setDetailId(row.id)} />

      <POFormModal open={createOpen} onOpenChange={setCreateOpen} />
      <GRNFormModal open={grnOpen} onOpenChange={setGrnOpen} prefillPoId={grnPoId} />
      <PODetailSheet
        poId={detailId}
        onClose={() => setDetailId(null)}
        onCreateGRN={(id: string) => { setGrnPoId(id); setGrnOpen(true); setDetailId(null); }}
        onSent={() => qc.invalidateQueries({ queryKey: ["purchase-orders"] })}
        propName={propName}
        toast={toast}
      />
    </div>
  );
}

function PODetailSheet({ poId, onClose, onCreateGRN, onSent, propName, toast }: any) {
  const { data: res, isLoading } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/purchase-orders/${poId}`, poId],
    queryFn: () => apiFetch(`/purchase-orders/${poId}`),
    enabled: !!poId,
  });
  const po = res?.data;
  const [sending, setSending] = React.useState(false);

  const send = async () => {
    setSending(true);
    try {
      await apiFetch(`/purchase-orders/${poId}/send`, { method: "POST" });
      toast({ title: `PO sent to ${po?.vendor?.email || "vendor"}` });
      onSent();
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const downloadPDF = () => {
    if (!po) return;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text("PURCHASE ORDER", 105, 18, { align: "center" });
    doc.setFontSize(10);
    doc.text(`PO #: ${po.poNumber}`, 14, 30);
    doc.text(`Date: ${format(new Date(po.createdAt), "dd MMM yyyy")}`, 14, 36);
    if (po.deliveryDate) doc.text(`Delivery: ${format(new Date(po.deliveryDate), "dd MMM yyyy")}`, 14, 42);

    doc.setFontSize(11);
    doc.text("Vendor:", 14, 54);
    doc.setFontSize(10);
    doc.text(`${po.vendor?.name || ""}`, 14, 60);
    if (po.vendor?.gstin) doc.text(`GSTIN: ${po.vendor.gstin}`, 14, 66);
    if (po.vendor?.address) doc.text(`${po.vendor.address}`, 14, 72);
    if (po.vendor?.phone) doc.text(`Phone: ${po.vendor.phone}`, 14, 78);

    let y = 92;
    doc.setFontSize(10);
    doc.setFillColor(240, 240, 240);
    doc.rect(14, y - 5, 182, 8, "F");
    doc.text("Item", 16, y);
    doc.text("Qty", 110, y);
    doc.text("Unit", 130, y);
    doc.text("Rate", 150, y);
    doc.text("Amount", 175, y);
    y += 6;
    (po.items || []).forEach((it: any) => {
      const amount = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
      doc.text(String(it.itemName || "").slice(0, 50), 16, y);
      doc.text(String(it.quantity || ""), 110, y);
      doc.text(String(it.unit || ""), 130, y);
      doc.text(String(it.rate || ""), 150, y);
      doc.text(`${amount.toFixed(2)}`, 175, y);
      y += 6;
      if (y > 270) { doc.addPage(); y = 20; }
    });
    y += 4;
    doc.line(14, y, 196, y);
    y += 6;
    doc.text(`Subtotal: ${Number(po.subtotal || 0).toFixed(2)}`, 140, y);
    y += 6;
    if (po.gstAmount) { doc.text(`GST: ${Number(po.gstAmount).toFixed(2)}`, 140, y); y += 6; }
    doc.setFontSize(12);
    doc.text(`Total: Rs ${Number(po.totalAmount || 0).toFixed(2)}`, 140, y);
    y += 10;
    doc.setFontSize(10);
    if (po.paymentTerms) doc.text(`Payment Terms: ${po.paymentTerms}`, 14, y);
    y += 6;
    if (po.notes) doc.text(`Notes: ${po.notes}`, 14, y);
    y += 10;
    doc.text("This is a system-generated document.", 14, 285);
    doc.save(`${po.poNumber}.pdf`);
  };

  return (
    <Sheet open={!!poId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-3">
            Purchase Order
            {po && <span className="font-mono text-sm bg-muted/30 px-2 py-1 rounded">{po.poNumber}</span>}
            {po && <StatusBadge status={po.status} />}
          </SheetTitle>
        </SheetHeader>
        {isLoading ? (
          <div className="space-y-3 mt-6"><div className="h-6 bg-muted/30 animate-pulse rounded" /><div className="h-32 bg-muted/30 animate-pulse rounded" /></div>
        ) : !po ? (
          <p className="text-sm text-muted-foreground p-4 text-center mt-6">Could not load this purchase order.</p>
        ) : (
          <div className="space-y-6 mt-6">

            <div className="border rounded-md p-4 bg-card grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs uppercase">Vendor</p>
                <p className="font-medium">{po.vendor?.name}</p>
                {po.vendor?.gstin && <p className="font-mono text-xs">{po.vendor.gstin}</p>}
                {po.vendor?.email && <p className="text-xs text-muted-foreground">{po.vendor.email}</p>}
                {po.vendor?.phone && <p className="text-xs text-muted-foreground">{po.vendor.phone}</p>}
                {po.vendor?.address && <p className="text-xs text-muted-foreground">{po.vendor.address}</p>}
              </div>
              <div className="text-right">
                <p className="text-muted-foreground text-xs uppercase">Date</p>
                <p className="font-medium">{format(new Date(po.createdAt), "dd MMM yyyy")}</p>
                {po.deliveryDate && (<><p className="text-muted-foreground text-xs uppercase mt-2">Delivery Date</p><p className="font-medium">{format(new Date(po.deliveryDate), "dd MMM yyyy")}</p></>)}
                {po.propertyId && (<><p className="text-muted-foreground text-xs uppercase mt-2">Property</p><p className="font-medium">{propName(po.propertyId)}</p></>)}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Line Items</h4>
              <table className="w-full text-sm border rounded-md overflow-hidden">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-2">Item</th>
                    <th className="text-left p-2">Spec</th>
                    <th className="text-right p-2">Qty</th>
                    <th className="text-left p-2">Unit</th>
                    <th className="text-right p-2">Rate</th>
                    <th className="text-right p-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(po.items || []).map((it: any, i: number) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-medium">{it.itemName}</td>
                      <td className="p-2 text-muted-foreground">{it.specification || "—"}</td>
                      <td className="p-2 text-right">{it.quantity}</td>
                      <td className="p-2">{it.unit}</td>
                      <td className="p-2 text-right">₹{Number(it.rate || 0).toLocaleString("en-IN")}</td>
                      <td className="p-2 text-right font-medium">₹{((Number(it.quantity) || 0) * (Number(it.rate) || 0)).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border rounded-md p-4 bg-card space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-medium">₹{Number(po.subtotal || 0).toLocaleString("en-IN")}</span></div>
              {Number(po.gstAmount) > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">GST</span><span className="font-medium">₹{Number(po.gstAmount).toLocaleString("en-IN")}</span></div>
              )}
              <div className="flex justify-between text-base font-display font-bold border-t pt-2">
                <span>Total</span><span>₹{Number(po.totalAmount || 0).toLocaleString("en-IN")}</span>
              </div>
            </div>

            {po.paymentTerms && <div className="text-sm"><span className="text-muted-foreground">Payment Terms:</span> <span className="font-medium">{po.paymentTerms}</span></div>}
            {po.notes && <div className="text-sm"><span className="text-muted-foreground">Notes:</span> <span>{po.notes}</span></div>}

            <div>
              <h4 className="text-sm font-medium mb-3">Status Timeline</h4>
              <div className="flex items-center justify-between">
                {TIMELINE_STEPS.map((step, idx) => {
                  const currentIdx = TIMELINE_STEPS.indexOf(po.status);
                  const done = idx <= currentIdx && currentIdx >= 0;
                  return (
                    <React.Fragment key={step}>
                      <div className="flex flex-col items-center gap-1">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${done ? "bg-accent text-white" : "bg-muted/30 text-muted-foreground"}`}>
                          {done ? <Check className="w-4 h-4" /> : <span className="text-xs">{idx + 1}</span>}
                        </div>
                        <span className={`text-[10px] uppercase tracking-wider ${done ? "text-accent font-medium" : "text-muted-foreground"}`}>{step.replace(/_/g, " ")}</span>
                      </div>
                      {idx < TIMELINE_STEPS.length - 1 && <div className={`flex-1 h-px mx-1 ${idx < currentIdx ? "bg-accent" : "bg-muted/30"}`} />}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-4 border-t">
              <Button variant="outline" onClick={downloadPDF}>
                <Download className="w-4 h-4 mr-2" /> Download PDF
              </Button>
              {po.status === "DRAFT" && (
                <Button className="bg-accent hover:bg-accent/90 text-white" onClick={send} disabled={sending}>
                  <Send className="w-4 h-4 mr-2" /> Send to Vendor
                </Button>
              )}
              {["SENT", "ACKNOWLEDGED", "PARTIAL_DELIVERY"].includes(po.status) && (
                <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => onCreateGRN(po.id)}>
                  <PackagePlus className="w-4 h-4 mr-2" /> Create GRN
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
