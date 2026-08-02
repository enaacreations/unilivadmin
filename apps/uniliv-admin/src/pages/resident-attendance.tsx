import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetProperties, getGetPropertiesQueryKey, useGetResidentAttendance, getGetResidentAttendanceQueryKey, useGetOutPasses, getGetOutPassesQueryKey } from "@workspace/api-client-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormModal } from "@/components/ui/form-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { ClipboardCheck, UserCheck, UserX, Plane, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface AttRow { residentId: string; residentName: string; roomId: string | null; record: { id: string; status: string; notes?: string | null } | null; }
interface OutPass { id: string; residentId: string; residentName?: string; propertyId: string; propertyName?: string; reason: string; destination?: string | null; leaveOn: string; expectedReturn: string; actualReturn?: string | null; status: string; }

export default function ResidentAttendancePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { propertyId, setPropertyId: setGlobalProperty } = useAppStore();
  const { can } = usePermissions();
  const [tab, setTab] = React.useState("attendance");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const [localPropId, setLocalPropId] = React.useState<string | undefined>(undefined);
  const propId = propertyId || localPropId || properties[0]?.id;
  React.useEffect(() => { if (!localPropId && properties[0]?.id) setLocalPropId(properties[0].id); }, [properties.length, localPropId]);

  const attParams = { propertyId: propId || "", date };
  const { data: attRes, isLoading } = useGetResidentAttendance(attParams, { query: { queryKey: getGetResidentAttendanceQueryKey(attParams), enabled: !!propId } });
  const rows = (attRes?.data || []) as unknown as AttRow[];
  const summary = (attRes as unknown as { summary?: { total: number; marked: number; present: number; absent: number; outPass: number; pct: number } } | undefined)?.summary;

  const markMut = useMutation({
    mutationFn: (status: string) => {
      const ids = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
      const items = ids.map((residentId) => ({ residentId, propertyId: propId, attendanceDate: date, status }));
      return apiFetch(`/resident-attendance/mark`, { method: "POST", body: JSON.stringify({ items }) });
    },
    onSuccess: () => { toast({ title: "Marked" }); qc.invalidateQueries({ queryKey: getGetResidentAttendanceQueryKey(attParams) }); setSelected({}); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const markAllPresent = useMutation({
    mutationFn: () => {
      const items = rows.filter((r) => !r.record).map((r) => ({ residentId: r.residentId, propertyId: propId, attendanceDate: date, status: "PRESENT" }));
      return apiFetch(`/resident-attendance/mark`, { method: "POST", body: JSON.stringify({ items }) });
    },
    onSuccess: () => { toast({ title: "Marked unmarked residents present" }); qc.invalidateQueries({ queryKey: getGetResidentAttendanceQueryKey(attParams) }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // Out-pass
  const opParams = propId ? { propertyId: propId } : {};
  const { data: outPassRes } = useGetOutPasses(opParams, { query: { queryKey: getGetOutPassesQueryKey(opParams), enabled: !!propId } });
  const outPasses = (outPassRes?.data || []) as unknown as OutPass[];

  const [opOpen, setOpOpen] = React.useState(false);
  const [opForm, setOpForm] = React.useState<any>({});
  const saveOp = useMutation({
    mutationFn: (d: any) => apiFetch(`/out-passes`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Out-pass created" }); qc.invalidateQueries({ queryKey: getGetOutPassesQueryKey(opParams) }); setOpOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  const updateOp = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => apiFetch(`/out-passes/${id}`, { method: "PUT", body: JSON.stringify({ status }) }),
    onSuccess: () => { toast({ title: "Updated" }); qc.invalidateQueries({ queryKey: getGetOutPassesQueryKey(opParams) }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  const markReturn = useMutation({
    mutationFn: (id: string) => apiFetch(`/out-passes/${id}/return`, { method: "POST", body: "{}" }),
    onSuccess: () => { toast({ title: "Returned" }); qc.invalidateQueries({ queryKey: getGetOutPassesQueryKey(opParams) }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const allSelected = rows.length > 0 && rows.every((r) => selected[r.residentId]);
  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(rows.map((r) => [r.residentId, true])));
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Resident Attendance & Out-pass" subtitle="Daily attendance roll and gate-out approvals" />

      <GlobalPropertyScopeBanner />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="attendance" data-testid="tab-attendance">Attendance</TabsTrigger>
          <TabsTrigger value="outpass" data-testid="tab-outpass">Out-pass</TabsTrigger>
        </TabsList>

        <TabsContent value="attendance" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StatCard title="Residents" value={summary?.total || 0} icon={ClipboardCheck} />
            <StatCard title="Present" value={summary?.present || 0} icon={UserCheck} />
            <StatCard title="Absent" value={summary?.absent || 0} icon={UserX} />
            <StatCard title="On Out-pass" value={summary?.outPass || 0} icon={Plane} />
            <StatCard title="Attendance %" value={`${summary?.pct ?? 0}%`} icon={UserCheck} />
          </div>

          <Card><CardContent className="p-4 flex flex-wrap items-end gap-3">
            <div><Label>Date</Label><DatePicker value={date} onChange={setDate} data-testid="input-att-date" /></div>
            {!propertyId && <div><Label>Property</Label>
              <Select value={propId} onValueChange={(v) => { setLocalPropId(v); setGlobalProperty(v); }}>
                <SelectTrigger className="w-[220px]" data-testid="select-att-property"><SelectValue /></SelectTrigger>
                <SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>}
            <div className="flex-1" />
            {can("RESIDENT_ATTENDANCE", "create") && (
              <>
                <Button variant="outline" onClick={() => markAllPresent.mutate()} data-testid="button-mark-all-present">Mark unmarked Present</Button>
                <Button onClick={() => markMut.mutate("PRESENT")} disabled={!Object.values(selected).some(Boolean)} data-testid="button-bulk-present">Bulk Present</Button>
                <Button variant="secondary" onClick={() => markMut.mutate("ABSENT")} disabled={!Object.values(selected).some(Boolean)}>Bulk Absent</Button>
              </>
            )}
          </CardContent></Card>

          <Card><CardContent className="p-0">
            {isLoading ? <div className="p-8 text-center text-muted-foreground">Loading...</div> : rows.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No active residents in this property.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3 w-8"><Checkbox checked={allSelected} onCheckedChange={toggleAll} /></th>
                  <th className="px-4 py-3">Resident</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Notes</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.residentId} className="border-t" data-testid={`att-row-${r.residentId}`}>
                      <td className="px-4 py-3"><Checkbox checked={!!selected[r.residentId]} onCheckedChange={(v) => setSelected({ ...selected, [r.residentId]: !!v })} /></td>
                      <td className="px-4 py-3 font-medium">{r.residentName}</td>
                      <td className="px-4 py-3">
                        {r.record ? (
                          <Badge variant={r.record.status === "PRESENT" ? "default" : r.record.status === "ABSENT" ? "destructive" : "secondary"}>{r.record.status}</Badge>
                        ) : <span className="text-muted-foreground text-xs">Unmarked</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{r.record?.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="outpass" className="space-y-4">
          <div className="flex justify-end">
            {can("RESIDENT_ATTENDANCE", "create") && (
              <Button onClick={() => { setOpForm({ propertyId: propId, leaveOn: new Date().toISOString().slice(0,16), expectedReturn: "" }); setOpOpen(true); }} data-testid="button-add-outpass"><Plus className="w-4 h-4 mr-2" />New Out-pass</Button>
            )}
          </div>
          <Card><CardContent className="p-0">
            {outPasses.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No out-pass requests yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Resident</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Leave</th><th className="px-4 py-3">Return by</th><th className="px-4 py-3">Status</th><th />
                </tr></thead>
                <tbody>
                  {outPasses.map((o) => {
                    const overdue = !o.actualReturn && new Date(o.expectedReturn) < new Date() && (o.status === "APPROVED" || o.status === "PENDING");
                    return (
                      <tr key={o.id} className="border-t" data-testid={`outpass-row-${o.id}`}>
                        <td className="px-4 py-3 font-medium">{o.residentName}</td>
                        <td className="px-4 py-3 text-xs">{o.reason}{o.destination ? ` · ${o.destination}` : ""}</td>
                        <td className="px-4 py-3 text-xs">{format(new Date(o.leaveOn), "dd MMM HH:mm")}</td>
                        <td className="px-4 py-3 text-xs">{format(new Date(o.expectedReturn), "dd MMM HH:mm")}</td>
                        <td className="px-4 py-3">
                          {overdue ? <Badge variant="destructive">Overdue</Badge> :
                            <Badge variant={o.status === "APPROVED" ? "default" : o.status === "REJECTED" ? "destructive" : o.status === "RETURNED" ? "secondary" : "outline"}>{o.status}</Badge>}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {can("RESIDENT_ATTENDANCE", "edit") && o.status === "PENDING" && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => updateOp.mutate({ id: o.id, status: "APPROVED" })} data-testid={`button-approve-${o.id}`}>Approve</Button>
                              <Button size="sm" variant="ghost" onClick={() => updateOp.mutate({ id: o.id, status: "REJECTED" })}>Reject</Button>
                            </>
                          )}
                          {can("RESIDENT_ATTENDANCE", "edit") && o.status === "APPROVED" && !o.actualReturn && (
                            <Button size="sm" variant="outline" onClick={() => markReturn.mutate(o.id)} data-testid={`button-return-${o.id}`}>Mark Returned</Button>
                          )}
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
      </Tabs>

      <FormModal open={opOpen} onOpenChange={setOpOpen} title="New Out-pass" onSave={() => saveOp.mutate(opForm)} isSaving={saveOp.isPending}>
        <div className="space-y-4">
          <div><Label>Resident *</Label>
            <Select value={opForm.residentId} onValueChange={(v) => setOpForm({ ...opForm, residentId: v })}>
              <SelectTrigger data-testid="select-op-resident"><SelectValue placeholder="Select resident" /></SelectTrigger>
              <SelectContent>{rows.map((r) => <SelectItem key={r.residentId} value={r.residentId}>{r.residentName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Reason *</Label><Input value={opForm.reason || ""} onChange={(e) => setOpForm({ ...opForm, reason: e.target.value })} data-testid="input-op-reason" /></div>
          <div><Label>Destination</Label><Input value={opForm.destination || ""} onChange={(e) => setOpForm({ ...opForm, destination: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Leave on *</Label><DateTimePicker value={opForm.leaveOn || ""} onChange={(v) => setOpForm({ ...opForm, leaveOn: v })} /></div>
            <div><Label>Expected return *</Label><DateTimePicker value={opForm.expectedReturn || ""} onChange={(v) => setOpForm({ ...opForm, expectedReturn: v })} /></div>
          </div>
        </div>
      </FormModal>
    </div>
  );
}
