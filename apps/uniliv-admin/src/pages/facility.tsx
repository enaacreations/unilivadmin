import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetFacilityAssets, getGetFacilityAssetsQueryKey,
  useGetFacilitySchedules, getGetFacilitySchedulesQueryKey,
  useGetFacilityLogs, getGetFacilityLogsQueryKey,
} from "@workspace/api-client-react";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { useGetEmployees, useGetVendors } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { PageHeader } from "@/components/page-header";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FormModal } from "@/components/ui/form-modal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Wrench, Plus, AlertTriangle, CalendarClock, ClipboardList, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const CATEGORIES = ["LIFT", "GENSET", "WATER_TANK", "HVAC", "FIRE_SAFETY", "DG", "STP", "OTHER"];

interface Asset { id: string; propertyId: string; propertyName?: string; assetCode: string; name: string; category: string; location?: string | null; manufacturer?: string | null; modelNo?: string | null; status: string; warrantyExpiry?: string | null; }
interface Schedule { id: string; assetId: string; assetName?: string; assetCode?: string; propertyName?: string; taskName: string; frequencyDays: number; nextDueDate: string; lastDoneAt?: string | null; isActive: boolean; vendorId?: string | null; assignedTo?: string | null; }
interface Log { id: string; assetId: string; assetName?: string; performedAt: string; outcome: string; cost?: number | null; notes?: string | null; }

export default function FacilityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { propertyId } = useAppStore();
  const { can, me } = usePermissions();
  const isSingleProperty = Boolean(me?.propertyId);
  const [tab, setTab] = React.useState("assets");

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const assetParams = propertyId ? { propertyId } : {};
  const schedParams = propertyId ? { propertyId } : {};

  const { data: assetsRes, isLoading: assetsLoading } = useGetFacilityAssets(assetParams, { query: { queryKey: getGetFacilityAssetsQueryKey(assetParams) } });
  const assets = (assetsRes?.data || []) as unknown as Asset[];

  const { data: schedRes, isLoading: schedLoading } = useGetFacilitySchedules(schedParams, { query: { queryKey: getGetFacilitySchedulesQueryKey(schedParams) } });
  const schedules = (schedRes?.data || []) as unknown as Schedule[];

  const logsParams = propertyId ? { propertyId } : {};
  const { data: logsRes } = useGetFacilityLogs(logsParams, { query: { queryKey: getGetFacilityLogsQueryKey(logsParams) } });
  const logs = (logsRes?.data || []) as unknown as Log[];

  // People for "Assigned To" combobox: employees + vendors, labelled by name
  const { data: employeesRes } = useGetEmployees();
  const employees = employeesRes?.data || [];
  const { data: vendorsRes } = useGetVendors();
  const vendors = vendorsRes?.data || [];

  // Stats
  const overdueCount = schedules.filter((s) => new Date(s.nextDueDate) < new Date()).length;
  const dueSoonCount = schedules.filter((s) => {
    const d = new Date(s.nextDueDate);
    const now = Date.now();
    return d.getTime() >= now && d.getTime() < now + 7 * 86400_000;
  }).length;

  // Asset modal
  const [assetOpen, setAssetOpen] = React.useState(false);
  const [editAsset, setEditAsset] = React.useState<Asset | null>(null);
  const [assetForm, setAssetForm] = React.useState<any>({});
  const openAssetModal = (a?: Asset) => {
    setEditAsset(a || null);
    setAssetForm(a ? { ...a } : { propertyId: propertyId || properties[0]?.id, status: "ACTIVE", category: "OTHER" });
    setAssetOpen(true);
  };
  const saveAsset = useMutation({
    mutationFn: (d: any) => apiFetch(`/facility/assets${editAsset ? `/${editAsset.id}` : ""}`, { method: editAsset ? "PUT" : "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: editAsset ? "Asset updated" : "Asset created" }); qc.invalidateQueries({ queryKey: getGetFacilityAssetsQueryKey(assetParams) }); setAssetOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // Schedule modal
  const [schedOpen, setSchedOpen] = React.useState(false);
  const [editSched, setEditSched] = React.useState<Schedule | null>(null);
  const [schedForm, setSchedForm] = React.useState<any>({});
  const openSchedModal = (s?: Schedule) => {
    setEditSched(s || null);
    setSchedForm(s ? { ...s, nextDueDate: s.nextDueDate.slice(0, 10) } : { assetId: assets[0]?.id, frequencyDays: 30, nextDueDate: new Date().toISOString().slice(0, 10), isActive: true });
    setSchedOpen(true);
  };
  const saveSched = useMutation({
    mutationFn: (d: any) => apiFetch(`/facility/schedules${editSched ? `/${editSched.id}` : ""}`, { method: editSched ? "PUT" : "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: editSched ? "Schedule updated" : "Schedule created" }); qc.invalidateQueries({ queryKey: getGetFacilitySchedulesQueryKey(schedParams) }); setSchedOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // "Assigned To" options: employees + vendors keyed/stored by name (back-compat).
  // Include any existing stored name so legacy/custom values still display.
  const assigneeOptions: ComboboxOption[] = React.useMemo(() => {
    const opts: ComboboxOption[] = [];
    const seen = new Set<string>();
    employees.forEach((e: any) => {
      if (e?.name && !seen.has(e.name)) { seen.add(e.name); opts.push({ value: e.name, label: e.name, keywords: ["Employee"] }); }
    });
    vendors.forEach((v: any) => {
      if (v?.name && !seen.has(v.name)) { seen.add(v.name); opts.push({ value: v.name, label: `Vendor · ${v.name}`, keywords: ["Vendor", v.name] }); }
    });
    const current = schedForm.assignedTo;
    if (current && !seen.has(current)) opts.push({ value: current, label: current });
    return opts;
  }, [employees, vendors, schedForm.assignedTo]);

  // Log modal
  const [logOpen, setLogOpen] = React.useState(false);
  const [logForm, setLogForm] = React.useState<any>({});
  const openLogModal = (s: Schedule) => {
    setLogForm({ scheduleId: s.id, assetId: s.assetId, performedAt: new Date().toISOString().slice(0, 16), outcome: "COMPLETED" });
    setLogOpen(true);
  };
  const saveLog = useMutation({
    mutationFn: (d: any) => apiFetch(`/facility/logs`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Log recorded" }); qc.invalidateQueries({ queryKey: getGetFacilityLogsQueryKey(logsParams) }); qc.invalidateQueries({ queryKey: getGetFacilitySchedulesQueryKey(schedParams) }); setLogOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Facility Management" subtitle="Track assets, preventive maintenance schedules and service logs" />

      <GlobalPropertyScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Assets" value={assets.length} icon={Wrench} />
        <StatCard title="Active Schedules" value={schedules.filter((s) => s.isActive).length} icon={CalendarClock} />
        <StatCard title="Overdue" value={overdueCount} icon={AlertTriangle} />
        <StatCard title="Due in 7d" value={dueSoonCount} icon={ClipboardList} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="assets" data-testid="tab-assets">Assets</TabsTrigger>
          <TabsTrigger value="schedules" data-testid="tab-schedules">Maintenance Schedules</TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs">Service Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="assets" className="space-y-4">
          <div className="flex justify-end">
            {can("FACILITY", "create") && <Button onClick={() => openAssetModal()} data-testid="button-add-asset"><Plus className="w-4 h-4 mr-2" />Add Asset</Button>}
          </div>
          <Card><CardContent className="p-0">
            {assetsLoading ? <div className="p-6 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}</div> : assets.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No assets yet — add your first one.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Code</th><th className="px-4 py-3">Name</th><th className="px-4 py-3">Category</th>{!isSingleProperty && <th className="px-4 py-3">Property</th>}<th className="px-4 py-3">Status</th><th className="px-4 py-3">Warranty</th><th />
                </tr></thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id} className="border-t hover:bg-muted/20" data-testid={`asset-row-${a.id}`}>
                      <td className="px-4 py-3 font-mono">{a.assetCode}</td>
                      <td className="px-4 py-3 font-medium">{a.name}</td>
                      <td className="px-4 py-3"><Badge variant="outline">{a.category}</Badge></td>
                      {!isSingleProperty && <td className="px-4 py-3">{a.propertyName || "—"}</td>}
                      <td className="px-4 py-3"><Badge variant={a.status === "ACTIVE" ? "default" : "secondary"}>{a.status}</Badge></td>
                      <td className="px-4 py-3 text-xs">{a.warrantyExpiry ? format(new Date(a.warrantyExpiry), "dd MMM yyyy") : "—"}</td>
                      <td className="px-4 py-3 text-right">{can("FACILITY", "edit") && <Button size="sm" variant="ghost" onClick={() => openAssetModal(a)} data-testid={`button-edit-asset-${a.id}`}>Edit</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="schedules" className="space-y-4">
          <div className="flex justify-end">
            {can("FACILITY", "create") && <Button onClick={() => openSchedModal()} disabled={assets.length === 0} data-testid="button-add-schedule"><Plus className="w-4 h-4 mr-2" />Add Schedule</Button>}
          </div>
          <Card><CardContent className="p-0">
            {schedLoading ? <div className="p-6 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}</div> : schedules.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No schedules yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Task</th><th className="px-4 py-3">Asset</th><th className="px-4 py-3">Frequency</th><th className="px-4 py-3">Next Due</th><th className="px-4 py-3">Last Done</th><th className="px-4 py-3">Status</th><th />
                </tr></thead>
                <tbody>
                  {schedules.map((s) => {
                    const overdue = new Date(s.nextDueDate) < new Date();
                    return (
                      <tr key={s.id} className="border-t hover:bg-muted/20" data-testid={`schedule-row-${s.id}`}>
                        <td className="px-4 py-3 font-medium">{s.taskName}</td>
                        <td className="px-4 py-3 text-xs">{s.assetCode} · {s.assetName}</td>
                        <td className="px-4 py-3">Every {s.frequencyDays}d</td>
                        <td className="px-4 py-3 text-xs">{format(new Date(s.nextDueDate), "dd MMM yyyy")}</td>
                        <td className="px-4 py-3 text-xs">{s.lastDoneAt ? format(new Date(s.lastDoneAt), "dd MMM yyyy") : "—"}</td>
                        <td className="px-4 py-3">{!s.isActive ? <Badge variant="secondary">Paused</Badge> : overdue ? <Badge variant="destructive">Overdue</Badge> : <Badge>Active</Badge>}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {can("FACILITY", "create") && <Button size="sm" variant="outline" onClick={() => openLogModal(s)} data-testid={`button-log-${s.id}`}><CheckCircle2 className="w-3 h-3 mr-1" />Log</Button>}
                          {can("FACILITY", "edit") && <Button size="sm" variant="ghost" onClick={() => openSchedModal(s)}>Edit</Button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <Card><CardContent className="p-0">
            {logs.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No service logs yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">When</th><th className="px-4 py-3">Asset</th><th className="px-4 py-3">Outcome</th><th className="px-4 py-3">Cost</th><th className="px-4 py-3">Notes</th>
                </tr></thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-t" data-testid={`log-row-${l.id}`}>
                      <td className="px-4 py-3 text-xs">{format(new Date(l.performedAt), "dd MMM yyyy HH:mm")}</td>
                      <td className="px-4 py-3">{l.assetName}</td>
                      <td className="px-4 py-3"><Badge variant={l.outcome === "COMPLETED" ? "default" : "secondary"}>{l.outcome}</Badge></td>
                      <td className="px-4 py-3 font-mono">{l.cost != null ? `₹${l.cost.toFixed(2)}` : "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{l.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      {/* Asset modal */}
      <FormModal open={assetOpen} onOpenChange={setAssetOpen} title={editAsset ? "Edit Asset" : "New Asset"} onSave={() => saveAsset.mutate(assetForm)} isSaving={saveAsset.isPending}>
        <div className="space-y-4">
          <div><Label>Property *</Label>
            <Select value={assetForm.propertyId} onValueChange={(v) => setAssetForm({ ...assetForm, propertyId: v })}>
              <SelectTrigger data-testid="select-asset-property"><SelectValue /></SelectTrigger>
              <SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Asset Code *</Label><Input value={assetForm.assetCode || ""} onChange={(e) => setAssetForm({ ...assetForm, assetCode: e.target.value })} data-testid="input-asset-code" /></div>
            <div><Label>Name *</Label><Input value={assetForm.name || ""} onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })} data-testid="input-asset-name" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Category *</Label>
              <Select value={assetForm.category} onValueChange={(v) => setAssetForm({ ...assetForm, category: v })}>
                <SelectTrigger data-testid="select-asset-category"><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Status</Label>
              <Select value={assetForm.status} onValueChange={(v) => setAssetForm({ ...assetForm, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["ACTIVE","UNDER_MAINTENANCE","DECOMMISSIONED"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div><Label>Location</Label><Input value={assetForm.location || ""} onChange={(e) => setAssetForm({ ...assetForm, location: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Manufacturer</Label><Input value={assetForm.manufacturer || ""} onChange={(e) => setAssetForm({ ...assetForm, manufacturer: e.target.value })} /></div>
            <div><Label>Model No.</Label><Input value={assetForm.modelNo || ""} onChange={(e) => setAssetForm({ ...assetForm, modelNo: e.target.value })} /></div>
          </div>
          <div><Label>Warranty Expiry</Label><DatePicker value={assetForm.warrantyExpiry?.slice?.(0,10) || ""} onChange={(v) => setAssetForm({ ...assetForm, warrantyExpiry: v })} /></div>
          <div><Label>Notes</Label><Textarea value={assetForm.notes || ""} onChange={(e) => setAssetForm({ ...assetForm, notes: e.target.value })} /></div>
        </div>
      </FormModal>

      {/* Schedule modal */}
      <FormModal open={schedOpen} onOpenChange={setSchedOpen} title={editSched ? "Edit Schedule" : "New Schedule"} onSave={() => saveSched.mutate(schedForm)} isSaving={saveSched.isPending}>
        <div className="space-y-4">
          <div><Label>Asset *</Label>
            <Select value={schedForm.assetId} onValueChange={(v) => setSchedForm({ ...schedForm, assetId: v })}>
              <SelectTrigger data-testid="select-schedule-asset"><SelectValue /></SelectTrigger>
              <SelectContent>{assets.map((a) => <SelectItem key={a.id} value={a.id}>{a.assetCode} · {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Task name *</Label><Input value={schedForm.taskName || ""} onChange={(e) => setSchedForm({ ...schedForm, taskName: e.target.value })} data-testid="input-task-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Frequency (days) *</Label><Input type="number" min={1} value={schedForm.frequencyDays || ""} onChange={(e) => setSchedForm({ ...schedForm, frequencyDays: Number(e.target.value) })} data-testid="input-frequency" /></div>
            <div><Label>Next due *</Label><DatePicker value={schedForm.nextDueDate || ""} onChange={(v) => setSchedForm({ ...schedForm, nextDueDate: v })} data-testid="input-next-due" /></div>
          </div>
          <div><Label>Assigned To</Label>
            <Combobox
              options={assigneeOptions}
              value={schedForm.assignedTo || null}
              onChange={(v) => setSchedForm({ ...schedForm, assignedTo: v || "" })}
              placeholder="Vendor or employee name"
              searchPlaceholder="Search people…"
              emptyText="No people found."
              creatable
              allowClear
              createLabel={(q) => `Use "${q}"`}
            />
          </div>
          <div><Label>Notes</Label><Textarea value={schedForm.notes || ""} onChange={(e) => setSchedForm({ ...schedForm, notes: e.target.value })} /></div>
        </div>
      </FormModal>

      {/* Log modal */}
      <FormModal open={logOpen} onOpenChange={setLogOpen} title="Log Maintenance" onSave={() => saveLog.mutate(logForm)} isSaving={saveLog.isPending}>
        <div className="space-y-4">
          <div><Label>Performed at *</Label><DateTimePicker value={logForm.performedAt || ""} onChange={(v) => setLogForm({ ...logForm, performedAt: v })} data-testid="input-performed-at" /></div>
          <div><Label>Outcome</Label>
            <Select value={logForm.outcome} onValueChange={(v) => setLogForm({ ...logForm, outcome: v })}>
              <SelectTrigger data-testid="select-outcome"><SelectValue /></SelectTrigger>
              <SelectContent>{["COMPLETED","PARTIAL","FAILED"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Cost</Label><Input type="number" step="0.01" value={logForm.cost ?? ""} onChange={(e) => setLogForm({ ...logForm, cost: e.target.value === "" ? null : Number(e.target.value) })} /></div>
          <div><Label>Notes</Label><Textarea value={logForm.notes || ""} onChange={(e) => setLogForm({ ...logForm, notes: e.target.value })} /></div>
        </div>
      </FormModal>
    </div>
  );
}
