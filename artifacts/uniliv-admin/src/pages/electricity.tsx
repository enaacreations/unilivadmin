import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetProperties, getGetPropertiesQueryKey,
  useGetRooms, getGetRoomsQueryKey,
  useGetResidents, getGetResidentsQueryKey,
  useGetElectricityTariffs, getGetElectricityTariffsQueryKey,
  useGetElectricityMeters, getGetElectricityMetersQueryKey,
  useGetElectricityReadings, getGetElectricityReadingsQueryKey,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { PageHeader } from "@/components/page-header";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { FormModal } from "@/components/ui/form-modal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Zap, Gauge, IndianRupee, Plus, Send, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface Tariff { id: string; name: string; ratePerUnit: number; fixedCharge: number; effectiveFrom: string; isActive: boolean; propertyId?: string | null; }
interface Meter { id: string; meterNo: string; label?: string | null; propertyId: string; propertyName?: string; roomNumber?: string | null; residentId?: string | null; residentName?: string | null; tariffId?: string | null; tariffName?: string | null; ratePerUnit?: number | null; isActive: boolean; }
interface Reading { id: string; meterId: string; meterNo?: string; readingDate: string; reading: number; prevReading: number | null; unitsConsumed: number | null; amount: number | null; posted: boolean; }

export default function ElectricityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { propertyId } = useAppStore();
  const { can, me } = usePermissions();
  const isSingleProperty = Boolean(me?.propertyId);
  const [tab, setTab] = React.useState("meters");

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const { data: roomsRes } = useGetRooms(
    propertyId ? { propertyId } : ({} as any),
    { query: { queryKey: propertyId ? getGetRoomsQueryKey({ propertyId }) : ["rooms-all"] as any } }
  );
  const rooms = (roomsRes?.data || []) as Array<{ id: string; number: string; propertyId: string }>;
  const { data: residentsRes } = useGetResidents(
    propertyId ? { propertyId } : ({} as any),
    { query: { queryKey: propertyId ? getGetResidentsQueryKey({ propertyId }) : ["residents-all"] as any } }
  );
  const residents = (residentsRes?.data || []) as Array<{ id: string; name: string; propertyId: string; roomId?: string | null }>;

  const meterParams = propertyId ? { propertyId } : {};
  const readingParams = propertyId ? { propertyId } : {};

  const { data: tariffsRes } = useGetElectricityTariffs({ query: { queryKey: getGetElectricityTariffsQueryKey() } });
  const tariffs = (tariffsRes?.data || []) as unknown as Tariff[];

  const { data: metersRes, isLoading: metersLoading } = useGetElectricityMeters(meterParams, { query: { queryKey: getGetElectricityMetersQueryKey(meterParams) } });
  const meters = (metersRes?.data || []) as unknown as Meter[];

  const { data: readingsRes } = useGetElectricityReadings(readingParams, { query: { queryKey: getGetElectricityReadingsQueryKey(readingParams) } });
  const readings: Reading[] = (readingsRes?.data || []) as unknown as Reading[];

  // Stats
  const totalUnits = readings.reduce((s, r) => s + (r.unitsConsumed || 0), 0);
  const pendingPosts = readings.filter((r) => !r.posted && (r.amount || 0) > 0).length;
  const postedAmount = readings.filter((r) => r.posted).reduce((s, r) => s + (r.amount || 0), 0);

  // Meter modal
  const [meterOpen, setMeterOpen] = React.useState(false);
  const [editMeter, setEditMeter] = React.useState<Meter | null>(null);
  const [meterForm, setMeterForm] = React.useState<any>({});
  const openMeter = (m?: Meter) => {
    setEditMeter(m || null);
    setMeterForm(m ? { ...m } : { propertyId: propertyId || properties[0]?.id, isActive: true });
    setMeterOpen(true);
  };
  const saveMeter = useMutation({
    mutationFn: (d: any) => apiFetch(`/electricity/meters${editMeter ? `/${editMeter.id}` : ""}`, { method: editMeter ? "PUT" : "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Saved" }); qc.invalidateQueries({ queryKey: getGetElectricityMetersQueryKey(meterParams) }); setMeterOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // Tariff modal
  const [tariffOpen, setTariffOpen] = React.useState(false);
  const [tariffForm, setTariffForm] = React.useState<any>({});
  const saveTariff = useMutation({
    mutationFn: (d: any) => apiFetch(`/electricity/tariffs`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Tariff saved" }); qc.invalidateQueries({ queryKey: getGetElectricityTariffsQueryKey() }); setTariffOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // Reading modal
  const [readingOpen, setReadingOpen] = React.useState(false);
  const [readingForm, setReadingForm] = React.useState<any>({});
  const openReading = (m: Meter) => { setReadingForm({ meterId: m.id, meterNo: m.meterNo, reading: "", readingDate: new Date().toISOString().slice(0, 10) }); setReadingOpen(true); };
  const saveReading = useMutation({
    mutationFn: (d: any) => apiFetch(`/electricity/readings`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Reading recorded" }); qc.invalidateQueries({ queryKey: getGetElectricityReadingsQueryKey(readingParams) }); setReadingOpen(false); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // Bulk upload
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkText, setBulkText] = React.useState("");
  const [bulkDate, setBulkDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const bulkUpload = useMutation({
    mutationFn: () => {
      const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const byNo = new Map(meters.map((m) => [m.meterNo, m.id]));
      const items: Array<{ meterId: string; reading: number; readingDate: string }> = [];
      const skipped: string[] = [];
      for (const line of lines) {
        const [meterNo, reading, dateOverride] = line.split(",").map((s) => s.trim());
        const meterId = byNo.get(meterNo);
        if (!meterId) { skipped.push(meterNo); continue; }
        items.push({ meterId, reading: Number(reading), readingDate: dateOverride || bulkDate });
      }
      if (skipped.length) toast({ title: `Skipped unknown meter(s): ${skipped.join(", ")}`, variant: "destructive" });
      return apiFetch(`/electricity/readings/bulk`, { method: "POST", body: JSON.stringify({ items }) });
    },
    onSuccess: (res: any) => {
      const succ = res?.data?.success ?? 0;
      const fail = res?.data?.failed ?? 0;
      toast({ title: `Uploaded ${succ} reading(s)`, description: fail ? `${fail} row(s) failed` : undefined });
      qc.invalidateQueries({ queryKey: getGetElectricityReadingsQueryKey(readingParams) });
      setBulkOpen(false);
      setBulkText("");
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const postReading = useMutation({
    mutationFn: (id: string) => apiFetch(`/electricity/readings/${id}/post`, { method: "POST", body: "{}" }),
    onSuccess: () => { toast({ title: "Posted to ledger" }); qc.invalidateQueries({ queryKey: getGetElectricityReadingsQueryKey(readingParams) }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Electricity" subtitle="Meters, readings, tariffs, and post charges to ledger" />

      <GlobalPropertyScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Active Meters" value={meters.filter((m) => m.isActive).length} icon={Gauge} />
        <StatCard title="Units Consumed" value={totalUnits.toFixed(1)} icon={Zap} />
        <StatCard title="Pending Posts" value={pendingPosts} icon={Send} />
        <StatCard title="Posted Amount" value={`₹${postedAmount.toFixed(0)}`} icon={IndianRupee} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="meters" data-testid="tab-meters">Meters</TabsTrigger>
          <TabsTrigger value="readings" data-testid="tab-readings">Readings</TabsTrigger>
          <TabsTrigger value="tariffs" data-testid="tab-tariffs">Tariffs</TabsTrigger>
        </TabsList>

        <TabsContent value="meters" className="space-y-4">
          <div className="flex justify-end">
            {can("ELECTRICITY", "create") && <Button onClick={() => openMeter()} data-testid="button-add-meter"><Plus className="w-4 h-4 mr-2" />Add Meter</Button>}
          </div>
          <Card><CardContent className="p-0">
            {metersLoading ? <div className="p-8 text-center text-muted-foreground">Loading...</div> : meters.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No meters yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Meter No.</th><th className="px-4 py-3">Label</th>{!isSingleProperty && <th className="px-4 py-3">Property</th>}<th className="px-4 py-3">Room</th><th className="px-4 py-3">Resident</th><th className="px-4 py-3">Tariff</th><th />
                </tr></thead>
                <tbody>
                  {meters.map((m) => (
                    <tr key={m.id} className="border-t hover:bg-muted/20" data-testid={`meter-row-${m.id}`}>
                      <td className="px-4 py-3 font-mono">{m.meterNo}</td>
                      <td className="px-4 py-3">{m.label || "—"}</td>
                      {!isSingleProperty && <td className="px-4 py-3">{m.propertyName || "—"}</td>}
                      <td className="px-4 py-3">{m.roomNumber || "—"}</td>
                      <td className="px-4 py-3">{m.residentName || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3 text-xs">{m.tariffName ? `${m.tariffName} · ₹${m.ratePerUnit}/u` : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {can("ELECTRICITY", "create") && <Button size="sm" variant="outline" onClick={() => openReading(m)} data-testid={`button-record-${m.id}`}>Record</Button>}
                        {can("ELECTRICITY", "edit") && <Button size="sm" variant="ghost" onClick={() => openMeter(m)}>Edit</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="readings" className="space-y-4">
          <div className="flex justify-end">
            {can("ELECTRICITY", "create") && <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-upload"><Upload className="w-4 h-4 mr-2" />Bulk Upload</Button>}
          </div>
          <Card><CardContent className="p-0">
            {readings.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No readings yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Date</th><th className="px-4 py-3">Meter</th><th className="px-4 py-3">Reading</th><th className="px-4 py-3">Units</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th />
                </tr></thead>
                <tbody>
                  {readings.map((r) => (
                    <tr key={r.id} className="border-t" data-testid={`reading-row-${r.id}`}>
                      <td className="px-4 py-3 text-xs">{format(new Date(r.readingDate), "dd MMM yyyy")}</td>
                      <td className="px-4 py-3 font-mono">{r.meterNo}</td>
                      <td className="px-4 py-3 font-mono">{r.reading.toFixed(2)}</td>
                      <td className="px-4 py-3 font-mono">{r.unitsConsumed?.toFixed(2) || "—"}</td>
                      <td className="px-4 py-3 font-mono">₹{(r.amount || 0).toFixed(2)}</td>
                      <td className="px-4 py-3">{r.posted ? <Badge>Posted</Badge> : <Badge variant="secondary">Draft</Badge>}</td>
                      <td className="px-4 py-3 text-right">
                        {!r.posted && can("ELECTRICITY", "edit") && (r.amount || 0) > 0 && (
                          <Button size="sm" variant="outline" onClick={() => postReading.mutate(r.id)} disabled={postReading.isPending} data-testid={`button-post-${r.id}`}><Send className="w-3 h-3 mr-1" />Post</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="tariffs" className="space-y-4">
          <div className="flex justify-end">
            {can("ELECTRICITY", "create") && <Button onClick={() => { setTariffForm({ name: "", ratePerUnit: 0, fixedCharge: 0, effectiveFrom: new Date().toISOString().slice(0, 10), isActive: true }); setTariffOpen(true); }} data-testid="button-add-tariff"><Plus className="w-4 h-4 mr-2" />Add Tariff</Button>}
          </div>
          <Card><CardContent className="p-0">
            {tariffs.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No tariffs yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Name</th><th className="px-4 py-3">Rate/Unit</th><th className="px-4 py-3">Fixed</th><th className="px-4 py-3">Effective From</th><th className="px-4 py-3">Status</th>
                </tr></thead>
                <tbody>
                  {tariffs.map((t) => (
                    <tr key={t.id} className="border-t" data-testid={`tariff-row-${t.id}`}>
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <td className="px-4 py-3 font-mono">₹{t.ratePerUnit}</td>
                      <td className="px-4 py-3 font-mono">₹{t.fixedCharge}</td>
                      <td className="px-4 py-3 text-xs">{format(new Date(t.effectiveFrom), "dd MMM yyyy")}</td>
                      <td className="px-4 py-3">{t.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      <FormModal open={meterOpen} onOpenChange={setMeterOpen} title={editMeter ? "Edit Meter" : "New Meter"} onSave={() => saveMeter.mutate(meterForm)} isSaving={saveMeter.isPending}>
        <div className="space-y-4">
          <div><Label>Property *</Label>
            <Select value={meterForm.propertyId} onValueChange={(v) => setMeterForm({ ...meterForm, propertyId: v })}>
              <SelectTrigger data-testid="select-meter-property"><SelectValue /></SelectTrigger>
              <SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Meter No. *</Label><Input value={meterForm.meterNo || ""} onChange={(e) => setMeterForm({ ...meterForm, meterNo: e.target.value })} data-testid="input-meter-no" /></div>
          <div><Label>Label</Label><Input value={meterForm.label || ""} onChange={(e) => setMeterForm({ ...meterForm, label: e.target.value })} placeholder="Common areas, Block A 101..." /></div>
          <div><Label>Tariff</Label>
            <Select value={meterForm.tariffId || "_none"} onValueChange={(v) => setMeterForm({ ...meterForm, tariffId: v === "_none" ? null : v })}>
              <SelectTrigger><SelectValue placeholder="Select tariff" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— None —</SelectItem>
                {tariffs.filter((t) => t.isActive).map((t) => <SelectItem key={t.id} value={t.id}>{t.name} (₹{t.ratePerUnit}/u)</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Assign to Room</Label>
            <Select value={meterForm.roomId || "_none"} onValueChange={(v) => setMeterForm({ ...meterForm, roomId: v === "_none" ? null : v })}>
              <SelectTrigger data-testid="select-meter-room"><SelectValue placeholder="Select room" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— None —</SelectItem>
                {rooms.filter((r) => r.propertyId === meterForm.propertyId).map((r) => <SelectItem key={r.id} value={r.id}>{r.number}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Assign to Resident</Label>
            <Select value={meterForm.residentId || "_none"} onValueChange={(v) => setMeterForm({ ...meterForm, residentId: v === "_none" ? null : v })}>
              <SelectTrigger data-testid="select-meter-resident"><SelectValue placeholder="Select resident" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— None —</SelectItem>
                {residents.filter((r) => r.propertyId === meterForm.propertyId && (!meterForm.roomId || r.roomId === meterForm.roomId)).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">A resident must be assigned before charges can be posted to ledger.</p>
          </div>
        </div>
      </FormModal>

      <FormModal open={tariffOpen} onOpenChange={setTariffOpen} title="New Tariff" onSave={() => saveTariff.mutate(tariffForm)} isSaving={saveTariff.isPending}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={tariffForm.name || ""} onChange={(e) => setTariffForm({ ...tariffForm, name: e.target.value })} data-testid="input-tariff-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Rate / Unit *</Label><Input type="number" step="0.01" value={tariffForm.ratePerUnit ?? ""} onChange={(e) => setTariffForm({ ...tariffForm, ratePerUnit: Number(e.target.value) })} data-testid="input-rate" /></div>
            <div><Label>Fixed Charge</Label><Input type="number" step="0.01" value={tariffForm.fixedCharge ?? ""} onChange={(e) => setTariffForm({ ...tariffForm, fixedCharge: Number(e.target.value) })} /></div>
          </div>
          <div><Label>Effective From *</Label><DatePicker value={tariffForm.effectiveFrom || ""} onChange={(v) => setTariffForm({ ...tariffForm, effectiveFrom: v })} /></div>
        </div>
      </FormModal>

      <FormModal open={bulkOpen} onOpenChange={setBulkOpen} title="Bulk Upload Readings" onSave={() => bulkUpload.mutate()} isSaving={bulkUpload.isPending} saveLabel="Upload">
        <div className="space-y-4">
          <div><Label>Default Reading Date</Label><DatePicker value={bulkDate} onChange={setBulkDate} data-testid="input-bulk-date" /></div>
          <div>
            <Label>Readings (CSV) *</Label>
            <p className="text-xs text-muted-foreground mb-2">One per line: <code className="bg-muted px-1">meterNo,reading[,date]</code></p>
            <textarea
              className="w-full h-48 p-3 font-mono text-xs border rounded bg-card"
              placeholder={"M-101,1234.5\nM-102,890.2,2026-05-01"}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              data-testid="textarea-bulk-readings"
            />
          </div>
        </div>
      </FormModal>

      <FormModal open={readingOpen} onOpenChange={setReadingOpen} title={`Record Reading · ${readingForm.meterNo || ""}`} onSave={() => saveReading.mutate(readingForm)} isSaving={saveReading.isPending}>
        <div className="space-y-4">
          <div><Label>Reading Date *</Label><DatePicker value={readingForm.readingDate || ""} onChange={(v) => setReadingForm({ ...readingForm, readingDate: v })} /></div>
          <div><Label>Reading (kWh) *</Label><Input type="number" step="0.01" value={readingForm.reading} onChange={(e) => setReadingForm({ ...readingForm, reading: e.target.value })} data-testid="input-reading-value" /></div>
          <p className="text-xs text-muted-foreground">Units & charge will be calculated against the previous reading and tariff automatically.</p>
        </div>
      </FormModal>
    </div>
  );
}
