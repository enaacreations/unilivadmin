import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { useGetResidents, useGetProperties } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Plus, Droplets, CheckCircle, PackageCheck, AlertTriangle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { FormModal } from "@/components/ui/form-modal";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useScopedColumns } from "@/lib/use-scoped-columns";

export default function Laundry() {
  const qc = useQueryClient();
  const { toast } = useToast();
  
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [status, setStatus] = React.useState("ALL");

  const { data: propsRes } = useGetProperties();
  const { data: laundryRes, isLoading } = useQuery({
    queryKey: ["laundry", propertyId, status],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (propertyId !== "ALL") params.set("propertyId", propertyId);
      return apiFetch(`/laundry?${params.toString()}`);
    }
  });
  
  const batches = (laundryRes as any)?.data || [];
  
  const filtered = batches.filter((b: any) => status === "ALL" || b.status === status);

  const active = batches.filter((b: any) => ["RECEIVED", "IN_WASH"].includes(b.status)).length;
  const inWash = batches.filter((b: any) => b.status === "IN_WASH").length;
  const ready = batches.filter((b: any) => b.status === "READY").length;
  
  const now = new Date().getTime();
  const breaches = batches.filter((b: any) => {
    if (b.status === "PICKED_UP" || b.status === "DAMAGED") return false;
    const deadline = new Date(b.dropDate).getTime() + (b.commitTatDays * 24 * 60 * 60 * 1000);
    return now > deadline;
  }).length;

  const [createOpen, setCreateOpen] = React.useState(false);
  const [damageDialog, setDamageDialog] = React.useState<{open: boolean, id: string | null}>({open: false, id: null});
  const [damageReason, setDamageReason] = React.useState("");

  const mutUpdate = useMutation({
    mutationFn: (args: {id: string, data: any}) => apiFetch(`/laundry/${args.id}`, { method: "PUT", body: JSON.stringify(args.data) }),
    onSuccess: () => {
      toast({ title: "Updated" });
      qc.invalidateQueries({ queryKey: ["laundry"] });
    }
  });

  const columns = [
    { accessorKey: "id", header: "Batch #", cell: ({row}: any) => <span className="font-mono text-xs">{row.original.id.substring(0,8)}</span> },
    { accessorKey: "residentName", header: "Resident", cell: ({row}: any) => <span className="font-medium">{row.original.residentName || "—"}</span> },
    { accessorKey: "propertyName", header: "Property", cell: ({row}: any) => row.original.propertyName || "—" },
    { id: "items", header: "Items", cell: ({row}: any) => {
      const items = row.original.items || {};
      const total = Object.values(items).reduce((a:any, b:any) => a + Number(b), 0);
      return <span className="font-medium">{String(total)} items</span>;
    }},
    { accessorKey: "dropDate", header: "Drop Date", cell: ({row}: any) => new Date(row.original.dropDate).toLocaleDateString() },
    { accessorKey: "commitTatDays", header: "TAT (Days)", cell: ({row}: any) => row.original.commitTatDays },
    { accessorKey: "status", header: "Status", cell: ({row}: any) => (
      <div className="flex items-center gap-2">
        <StatusBadge status={row.original.status} />
        {(() => {
          if (row.original.status === "PICKED_UP" || row.original.status === "DAMAGED") return null;
          const deadline = new Date(row.original.dropDate).getTime() + (row.original.commitTatDays * 24 * 60 * 60 * 1000);
          if (now > deadline) return <StatusBadge status="BREACH" />;
          return null;
        })()}
      </div>
    )},
    { id: "elapsed", header: "Elapsed", cell: ({row}: any) => {
      if (row.original.status === "PICKED_UP" || row.original.status === "DAMAGED") return "—";
      const dropTime = new Date(row.original.dropDate).getTime();
      const elapsedDays = Math.floor((now - dropTime) / (1000 * 60 * 60 * 24));
      return `${elapsedDays} days`;
    }},
    {
      id: "actions", header: "Actions", cell: ({row}: any) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Actions</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => mutUpdate.mutate({id: row.original.id, data: {status: "IN_WASH"}})}>Mark In Wash</DropdownMenuItem>
            <DropdownMenuItem onClick={() => mutUpdate.mutate({id: row.original.id, data: {status: "READY"}})}>Mark Ready</DropdownMenuItem>
            <DropdownMenuItem onClick={() => mutUpdate.mutate({id: row.original.id, data: {status: "PICKED_UP"}})}>Mark Picked Up</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={() => setDamageDialog({open: true, id: row.original.id})}>Mark Damaged</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
  ];
  const scopedColumns = useScopedColumns(columns, { singleProperty: ["propertyName"] });

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Laundry Operations" 
        subtitle="Manage resident laundry batches and TAT"
        action={
          <Button onClick={() => setCreateOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" /> Log Inward
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Active Batches" value={active} icon={PackageCheck} />
        <StatCard title="In Wash" value={inWash} icon={Droplets} />
        <StatCard title="Ready for Pickup" value={ready} icon={CheckCircle} />
        <StatCard title="TAT Breaches" value={breaches} icon={AlertTriangle} className={breaches > 0 ? "border-destructive/50 bg-destructive/5" : ""} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {propsRes?.data?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="RECEIVED">Received</SelectItem>
            <SelectItem value="IN_WASH">In Wash</SelectItem>
            <SelectItem value="READY">Ready</SelectItem>
            <SelectItem value="PICKED_UP">Picked Up</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={scopedColumns as any} data={filtered} isLoading={isLoading} />

      <LogInwardModal open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog open={damageDialog.open} onOpenChange={(op) => { if(!op) { setDamageDialog({open: false, id: null}); setDamageReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Damaged</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <Label>Damage Reason</Label>
              <Textarea value={damageReason} onChange={(e) => setDamageReason(e.target.value)} rows={3} placeholder="Describe the damage..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDamageDialog({open: false, id: null})}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              if (damageDialog.id) {
                mutUpdate.mutate({id: damageDialog.id, data: {status: "DAMAGED", damageNote: damageReason}});
                setDamageDialog({open: false, id: null});
                setDamageReason("");
              }
            }}>Mark Damaged</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LogInwardModal({ open, onOpenChange }: { open: boolean, onOpenChange: (o: boolean) => void }) {
  const { data: resRes } = useGetResidents();
  const qc = useQueryClient();
  const { toast } = useToast();
  
  const mut = useMutation({
    mutationFn: (data: any) => apiFetch("/laundry", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      toast({ title: "Logged successfully" });
      qc.invalidateQueries({ queryKey: ["laundry"] });
      onOpenChange(false);
    }
  });

  const [form, setForm] = React.useState({
    residentId: "", dropDate: new Date().toISOString().split('T')[0], commitTatDays: 2,
    items: { shirts: 0, pants: 0, innerWear: 0, bedSheets: 0, towels: 0, others: 0 },
    specialInstructions: "", damageNote: ""
  });

  const handleItemChange = (k: string, v: number) => {
    setForm(prev => ({ ...prev, items: { ...prev.items, [k]: Math.max(0, v) } }));
  };

  const total = Object.values(form.items).reduce((a,b) => a+b, 0);

  const handleSave = () => {
    if (!form.residentId || !form.dropDate) {
      toast({ title: "Missing required fields", variant: "destructive" });
      return;
    }
    mut.mutate(form);
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Log Laundry Inward" onSave={handleSave} isSaving={mut.isPending}>
      <div className="space-y-4">
        <div>
          <Label>Resident *</Label>
          <Select value={form.residentId} onValueChange={v => setForm({...form, residentId: v})}>
            <SelectTrigger><SelectValue placeholder="Select Resident" /></SelectTrigger>
            <SelectContent>
              {resRes?.data?.map(r => <SelectItem key={r.id} value={r.id}>{r.name} ({r.roomNumber || "No room"})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Drop Date *</Label>
            <DatePicker value={form.dropDate} onChange={v => setForm({...form, dropDate: v})} />
          </div>
          <div>
            <Label>Commit TAT (Days) *</Label>
            <Input type="number" value={form.commitTatDays} onChange={e => setForm({...form, commitTatDays: Number(e.target.value)})} />
          </div>
        </div>

        <div className="border rounded-md p-4 bg-card mt-2">
          <div className="flex justify-between items-center mb-4">
            <h4 className="font-medium text-sm">Items Count</h4>
            <Badge variant="secondary">{total} Total</Badge>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {Object.keys(form.items).map(k => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-sm capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="icon" className="h-6 w-6" onClick={() => handleItemChange(k, (form.items as any)[k] - 1)}>-</Button>
                  <span className="w-4 text-center text-sm font-medium">{(form.items as any)[k]}</span>
                  <Button type="button" variant="outline" size="icon" className="h-6 w-6" onClick={() => handleItemChange(k, (form.items as any)[k] + 1)}>+</Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <Label>Special Instructions</Label>
          <Textarea rows={2} value={form.specialInstructions} onChange={e => setForm({...form, specialInstructions: e.target.value})} />
        </div>
        <div>
          <Label>Existing Damage Note</Label>
          <Textarea rows={2} value={form.damageNote} onChange={e => setForm({...form, damageNote: e.target.value})} />
        </div>
      </div>
    </FormModal>
  );
}
