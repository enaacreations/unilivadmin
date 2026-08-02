import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Plus, FileText } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { IndentFormModal, DEPARTMENTS } from "@/components/indent-form-modal";
import { POFormModal } from "@/components/po-form-modal";

const STATUS_TABS = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "PO_RAISED", label: "PO Raised" },
  { value: "REJECTED", label: "Rejected" },
];

export default function Indents() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [department, setDepartment] = React.useState("ALL");
  const [tab, setTab] = React.useState("ALL");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingIndent, setEditingIndent] = React.useState<any>(null);
  const [detailIndent, setDetailIndent] = React.useState<any>(null);
  const [rejectReason, setRejectReason] = React.useState("");
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [poOpen, setPoOpen] = React.useState(false);
  const [poPrefill, setPoPrefill] = React.useState<any>(null);
  const [prefilledItem, setPrefilledItem] = React.useState<{ itemName: string; unit: string } | null>(null);

  React.useEffect(() => {
    const stored = sessionStorage.getItem("prefilledIndentItem");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setPrefilledItem(parsed);
        setCreateOpen(true);
      } catch {}
      sessionStorage.removeItem("prefilledIndentItem");
    }
  }, []);

  const params: Record<string, string> = {};
  if (propertyId !== "ALL") params.propertyId = propertyId;
  if (department !== "ALL") params.department = department;
  const qs = new URLSearchParams(params).toString();

  const { data: res, isLoading } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["indents", params],
    queryFn: () => apiFetch(`/indents${qs ? `?${qs}` : ""}`),
  });
  const all = res?.data || [];

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];
  const propName = (id: string) => properties.find((p) => p.id === id)?.name || "—";

  const filtered = tab === "ALL" ? all : all.filter((i) => i.status === tab);
  const counts: Record<string, number> = STATUS_TABS.reduce((acc, t) => {
    acc[t.value] = t.value === "ALL" ? all.length : all.filter((i) => i.status === t.value).length;
    return acc;
  }, {} as Record<string, number>);

  const totalEst = (items: any[]) => items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.estUnitPrice) || 0), 0);

  const cols = [
    {
      accessorKey: "indentNumber",
      header: "Indent #",
      cell: ({ row }: any) => <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.indentNumber || row.original.id?.slice(0, 8)}</span>,
    },
    { accessorKey: "propertyId", header: "Property", cell: ({ row }: any) => propName(row.original.propertyId) },
    { accessorKey: "department", header: "Department", cell: ({ row }: any) => <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">{row.original.department}</Badge> },
    { id: "items", header: "Items", accessorFn: (r: any) => `${r.items?.length || 0} items`, cell: ({ row }: any) => `${row.original.items?.length || 0} items` },
    { id: "totalEst", header: "Est. Value", accessorFn: (r: any) => totalEst(r.items || []), cell: ({ row }: any) => `₹${totalEst(row.original.items || []).toLocaleString("en-IN")}` },
    { accessorKey: "urgency", header: "Urgency", cell: ({ row }: any) => <StatusBadge status={row.original.urgency} /> },
    { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
    { accessorKey: "createdAt", header: "Created", cell: ({ row }: any) => row.original.createdAt ? format(new Date(row.original.createdAt), "dd MMM yyyy") : "—" },
  ];

  const approve = async (id: string) => {
    try {
      await apiFetch(`/indents/${id}/approve`, { method: "POST" });
      toast({ title: "Indent approved" });
      qc.invalidateQueries({ queryKey: ["indents"] });
      setDetailIndent(null);
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const submitDraft = async (ind: any) => {
    try {
      await apiFetch(`/indents/${ind.id}`, { method: "PUT", body: JSON.stringify({ status: "SUBMITTED" }) });
      toast({ title: "Indent submitted" });
      qc.invalidateQueries({ queryKey: ["indents"] });
      setDetailIndent(null);
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const reject = async () => {
    if (!detailIndent || !rejectReason.trim()) {
      toast({ title: "Please provide a reason", variant: "destructive" });
      return;
    }
    try {
      await apiFetch(`/indents/${detailIndent.id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejectReason }) });
      toast({ title: "Indent rejected" });
      qc.invalidateQueries({ queryKey: ["indents"] });
      setRejectOpen(false);
      setRejectReason("");
      setDetailIndent(null);
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const convertToPO = (ind: any) => {
    setPoPrefill({
      vendorId: undefined,
      propertyId: ind.propertyId,
      indentId: ind.id,
      items: (ind.items || []).map((i: any) => ({
        itemName: i.itemName,
        specification: i.specification || "",
        quantity: i.quantity,
        unit: i.unit,
        rate: i.estUnitPrice || 0,
      })),
    });
    setPoOpen(true);
    setDetailIndent(null);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Material Indents"
        subtitle="Internal requests for materials and supplies"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => { setEditingIndent(null); setPrefilledItem(null); setCreateOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" /> Raise Indent
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {STATUS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label} <Badge variant="secondary" className="ml-2 text-[10px]">{counts[t.value]}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Department" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Departments</SelectItem>
            {DEPARTMENTS.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      <div className={tab === "SUBMITTED" || tab === "ALL" ? "[&_tr[data-status=SUBMITTED]]:border-l-2 [&_tr[data-status=SUBMITTED]]:border-l-accent" : ""}>
        <DataTable columns={cols as any} data={filtered} isLoading={isLoading} onRowClick={(row: any) => setDetailIndent(row)} />
      </div>

      {/* Detail dialog */}
      <Dialog open={!!detailIndent} onOpenChange={(o) => !o && setDetailIndent(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {detailIndent && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display flex items-center gap-3">
                  <FileText className="w-5 h-5" /> {detailIndent.indentNumber || `Indent ${detailIndent.id?.slice(0, 8)}`}
                  <StatusBadge status={detailIndent.status} />
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">Property:</span> <span className="font-medium">{propName(detailIndent.propertyId)}</span></div>
                  <div><span className="text-muted-foreground">Department:</span> <span className="font-medium">{detailIndent.department}</span></div>
                  <div><span className="text-muted-foreground">Urgency:</span> <StatusBadge status={detailIndent.urgency} /></div>
                  <div><span className="text-muted-foreground">Budget Head:</span> <span className="font-medium">{detailIndent.budgetHead || "—"}</span></div>
                  <div className="col-span-2"><span className="text-muted-foreground">Purpose:</span> <span>{detailIndent.purpose || "—"}</span></div>
                </div>

                <div>
                  <h4 className="text-sm font-medium mb-2">Items</h4>
                  <table className="w-full text-sm border rounded-md overflow-hidden">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="text-left p-2">Item</th>
                        <th className="text-left p-2">Spec</th>
                        <th className="text-right p-2">Qty</th>
                        <th className="text-left p-2">Unit</th>
                        <th className="text-right p-2">Est. Rate</th>
                        <th className="text-right p-2">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detailIndent.items || []).map((it: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="p-2 font-medium">{it.itemName}</td>
                          <td className="p-2 text-muted-foreground">{it.specification || "—"}</td>
                          <td className="p-2 text-right">{it.quantity}</td>
                          <td className="p-2">{it.unit}</td>
                          <td className="p-2 text-right">₹{Number(it.estUnitPrice || 0).toLocaleString("en-IN")}</td>
                          <td className="p-2 text-right font-medium">₹{((Number(it.quantity) || 0) * (Number(it.estUnitPrice) || 0)).toLocaleString("en-IN")}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/20">
                        <td colSpan={5} className="p-2 text-right font-medium">Total Estimated</td>
                        <td className="p-2 text-right font-bold">₹{totalEst(detailIndent.items || []).toLocaleString("en-IN")}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              <DialogFooter className="flex-row justify-end gap-2">
                {detailIndent.status === "DRAFT" && (
                  <>
                    <Button variant="outline" onClick={() => { setEditingIndent(detailIndent); setDetailIndent(null); setCreateOpen(true); }}>Edit</Button>
                    <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => submitDraft(detailIndent)}>Submit</Button>
                  </>
                )}
                {detailIndent.status === "SUBMITTED" && (
                  <>
                    <Button variant="destructive" onClick={() => setRejectOpen(true)}>Reject</Button>
                    <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => approve(detailIndent.id)}>Approve</Button>
                  </>
                )}
                {detailIndent.status === "APPROVED" && (
                  <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => convertToPO(detailIndent)}>Convert to PO</Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject reason dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject Indent</DialogTitle></DialogHeader>
          <Label>Reason</Label>
          <Textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Explain why this indent is being rejected..." />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={reject}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IndentFormModal
        open={createOpen}
        onOpenChange={(o) => { setCreateOpen(o); if (!o) { setEditingIndent(null); setPrefilledItem(null); } }}
        indent={editingIndent}
        prefillItem={prefilledItem || undefined}
      />

      <POFormModal open={poOpen} onOpenChange={setPoOpen} prefill={poPrefill} />
    </div>
  );
}
