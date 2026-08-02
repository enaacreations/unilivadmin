import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetIotDevices, getGetIotDevicesQueryKey, useGetIotLatest, getGetIotLatestQueryKey } from "@workspace/api-client-react";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api-fetch";
import { useAppStore } from "@/lib/store";
import { usePermissions } from "@/lib/use-permissions";
import { PageHeader } from "@/components/page-header";
import { GlobalPropertyScopeBanner } from "@/components/property-scope-banner";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FormModal } from "@/components/ui/form-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Radio, Plus, KeyRound, Activity, Wifi, WifiOff, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, formatDistanceToNow } from "date-fns";

const DEVICE_TYPES = ["SMART_LOCK", "ENERGY_METER", "TEMP_SENSOR", "OCCUPANCY", "LEAK", "OTHER"];
const ADAPTERS = ["GENERIC", "SMART_LOCK", "ENERGY_METER", "TEMP_SENSOR"];

interface Device { id: string; name: string; deviceType: string; adapter: string; status: string; propertyId: string; propertyName?: string; roomId?: string | null; roomNumber?: string | null; endpoint?: string | null; lastSeenAt?: string | null; ingestionToken: string; }
interface Reading { id: string; deviceId: string; deviceName?: string; deviceType?: string; metric: string; value: number | null; recordedAt: string; rawPayload?: any; }
interface Latest { deviceId: string; name: string; deviceType: string; status: string; lastSeenAt: string | null; latest: { metric: string; value: number | null; recordedAt: string; raw?: any } | null; }

export default function IoTPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { propertyId } = useAppStore();
  const { can, me } = usePermissions();
  const isSingleProperty = Boolean(me?.propertyId);
  const [tab, setTab] = React.useState("devices");

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];

  const iotParams = propertyId ? { propertyId } : {};

  const { data: devRes, isLoading } = useGetIotDevices(iotParams, { query: { queryKey: getGetIotDevicesQueryKey(iotParams) } });
  const devices = (devRes?.data || []) as unknown as Device[];

  const { data: latestRes } = useGetIotLatest(iotParams, { query: { queryKey: getGetIotLatestQueryKey(iotParams), refetchInterval: 30_000 } });
  const latest = (latestRes?.data || []) as unknown as Latest[];

  const { data: readingsRes } = useQuery<{ data: Reading[] }>({
    queryKey: ["iot-readings", propertyId], queryFn: () => apiFetch(`/iot/readings${propertyId ? `?propertyId=${propertyId}` : ""}`),
  });
  const readings: Reading[] = readingsRes?.data || [];

  const onlineCount = latest.filter((l) => l.status === "ACTIVE" && l.lastSeenAt && Date.now() - new Date(l.lastSeenAt).getTime() < 600_000).length;
  const stale = latest.filter((l) => !l.lastSeenAt || Date.now() - new Date(l.lastSeenAt).getTime() > 3600_000).length;

  const [devOpen, setDevOpen] = React.useState(false);
  const [editDev, setEditDev] = React.useState<Device | null>(null);
  const [devForm, setDevForm] = React.useState<any>({});
  const [createdToken, setCreatedToken] = React.useState<{ deviceId: string; token: string; deviceName: string } | null>(null);

  const openDev = (d?: Device) => {
    setEditDev(d || null);
    setDevForm(d ? { ...d } : { propertyId: propertyId || properties[0]?.id, status: "ACTIVE", deviceType: "ENERGY_METER", adapter: "GENERIC" });
    setDevOpen(true);
  };

  const saveDev = useMutation({
    mutationFn: (d: any) => apiFetch<{ data: Device }>(`/iot/devices${editDev ? `/${editDev.id}` : ""}`, { method: editDev ? "PUT" : "POST", body: JSON.stringify(d) }),
    onSuccess: (res) => {
      toast({ title: editDev ? "Device updated" : "Device registered" });
      qc.invalidateQueries({ queryKey: ["iot-devices"] });
      setDevOpen(false);
      if (!editDev && res.data?.ingestionToken) {
        setCreatedToken({ deviceId: res.data.id, token: res.data.ingestionToken, deviceName: res.data.name });
      }
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const rotateMut = useMutation({
    mutationFn: (id: string) => apiFetch<{ data: { ingestionToken: string } }>(`/iot/devices/${id}/rotate-token`, { method: "POST", body: "{}" }),
    onSuccess: (res, id) => {
      const dev = devices.find((d) => d.id === id);
      setCreatedToken({ deviceId: id, token: res.data.ingestionToken, deviceName: dev?.name || "" });
      qc.invalidateQueries({ queryKey: ["iot-devices"] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const copyToken = (t: string) => { navigator.clipboard.writeText(t); toast({ title: "Token copied" }); };

  return (
    <div className="space-y-6">
      <PageHeader title="IoT Integration" subtitle="Device registry and live telemetry" />

      <GlobalPropertyScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Devices" value={devices.length} icon={Radio} />
        <StatCard title="Online (10m)" value={onlineCount} icon={Wifi} />
        <StatCard title="Stale (>1h)" value={stale} icon={WifiOff} />
        <StatCard title="Recent Events" value={readings.length} icon={Activity} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="devices" data-testid="tab-iot-devices">Devices</TabsTrigger>
          <TabsTrigger value="live" data-testid="tab-iot-live">Live</TabsTrigger>
          <TabsTrigger value="readings" data-testid="tab-iot-readings">Recent Readings</TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="space-y-4">
          <div className="flex justify-end">
            {can("IOT", "create") && <Button onClick={() => openDev()} data-testid="button-add-device"><Plus className="w-4 h-4 mr-2" />Register Device</Button>}
          </div>
          <Card><CardContent className="p-0">
            {isLoading ? <div className="p-8 text-center text-muted-foreground">Loading...</div> : devices.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No devices registered yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">Name</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Adapter</th><th className="px-4 py-3">{isSingleProperty ? "Room" : "Property / Room"}</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Last Seen</th><th />
                </tr></thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id} className="border-t" data-testid={`device-row-${d.id}`}>
                      <td className="px-4 py-3 font-medium">{d.name}</td>
                      <td className="px-4 py-3 text-xs"><Badge variant="outline">{d.deviceType}</Badge></td>
                      <td className="px-4 py-3 text-xs">{d.adapter}</td>
                      <td className="px-4 py-3 text-xs">{isSingleProperty ? (d.roomNumber || "—") : <>{d.propertyName}{d.roomNumber ? ` · ${d.roomNumber}` : ""}</>}</td>
                      <td className="px-4 py-3"><Badge variant={d.status === "ACTIVE" ? "default" : "secondary"}>{d.status}</Badge></td>
                      <td className="px-4 py-3 text-xs">{d.lastSeenAt ? formatDistanceToNow(new Date(d.lastSeenAt), { addSuffix: true }) : "Never"}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {can("IOT", "edit") && <Button size="sm" variant="outline" onClick={() => rotateMut.mutate(d.id)} data-testid={`button-rotate-${d.id}`}><KeyRound className="w-3 h-3 mr-1" />Rotate</Button>}
                        {can("IOT", "edit") && <Button size="sm" variant="ghost" onClick={() => openDev(d)}>Edit</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="live" className="space-y-4">
          <BoundedScroll size="lg">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {latest.length === 0 ? <div className="col-span-3 p-12 text-center text-muted-foreground">No data yet.</div> : latest.map((l) => {
              const seenMs = l.lastSeenAt ? Date.now() - new Date(l.lastSeenAt).getTime() : null;
              const online = l.status === "ACTIVE" && seenMs != null && seenMs < 600_000;
              return (
                <Card key={l.deviceId} data-testid={`live-${l.deviceId}`}>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{l.name}</div>
                      {online ? <Badge><Wifi className="w-3 h-3 mr-1" />Online</Badge> : <Badge variant="secondary"><WifiOff className="w-3 h-3 mr-1" />Stale</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{l.deviceType}</div>
                    {l.latest ? (
                      <div className="pt-2 border-t">
                        <div className="text-xs text-muted-foreground">{l.latest.metric}</div>
                        <div className="text-2xl font-display font-bold">{l.latest.value != null ? l.latest.value : "—"}</div>
                        <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(l.latest.recordedAt), { addSuffix: true })}</div>
                      </div>
                    ) : <div className="text-xs text-muted-foreground pt-2">No readings received yet.</div>}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </BoundedScroll>
        </TabsContent>

        <TabsContent value="readings" className="space-y-4">
          <Card><CardContent className="p-0">
            {readings.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">No telemetry yet.</div>
            ) : (
              <BoundedScroll size="lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left sticky top-0 z-10"><tr>
                  <th className="px-4 py-3">When</th><th className="px-4 py-3">Device</th><th className="px-4 py-3">Metric</th><th className="px-4 py-3">Value</th>
                </tr></thead>
                <tbody>
                  {readings.map((r) => (
                    <tr key={r.id} className="border-t" data-testid={`reading-${r.id}`}>
                      <td className="px-4 py-3 text-xs">{format(new Date(r.recordedAt), "dd MMM HH:mm:ss")}</td>
                      <td className="px-4 py-3">{r.deviceName} <span className="text-xs text-muted-foreground">({r.deviceType})</span></td>
                      <td className="px-4 py-3 font-mono text-xs">{r.metric}</td>
                      <td className="px-4 py-3 font-mono">{r.value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </BoundedScroll>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      <FormModal open={devOpen} onOpenChange={setDevOpen} title={editDev ? "Edit Device" : "Register Device"} onSave={() => saveDev.mutate(devForm)} isSaving={saveDev.isPending}>
        <div className="space-y-4">
          <div><Label>Property *</Label>
            <Select value={devForm.propertyId} onValueChange={(v) => setDevForm({ ...devForm, propertyId: v })}>
              <SelectTrigger data-testid="select-dev-property"><SelectValue /></SelectTrigger>
              <SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Name *</Label><Input value={devForm.name || ""} onChange={(e) => setDevForm({ ...devForm, name: e.target.value })} data-testid="input-dev-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Device Type *</Label>
              <Select value={devForm.deviceType} onValueChange={(v) => setDevForm({ ...devForm, deviceType: v })}>
                <SelectTrigger data-testid="select-dev-type"><SelectValue /></SelectTrigger>
                <SelectContent>{DEVICE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Adapter</Label>
              <Select value={devForm.adapter} onValueChange={(v) => setDevForm({ ...devForm, adapter: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ADAPTERS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div><Label>Endpoint URL</Label><Input value={devForm.endpoint || ""} onChange={(e) => setDevForm({ ...devForm, endpoint: e.target.value })} placeholder="https://..." /></div>
          <div><Label>Status</Label>
            <Select value={devForm.status} onValueChange={(v) => setDevForm({ ...devForm, status: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{["ACTIVE","INACTIVE","OFFLINE"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      <FormModal open={!!createdToken} onOpenChange={(v) => !v && setCreatedToken(null)} title="Device Ingestion Token" showFooter={false}>
        <div className="space-y-4">
          <div className="text-sm">Save this token now — it will not be shown again. Use it as a Bearer token when sending telemetry to <code className="bg-muted px-1">POST /api/iot/ingest</code>.</div>
          <div className="font-medium">{createdToken?.deviceName}</div>
          <div className="flex items-center gap-2">
            <Input readOnly value={createdToken?.token || ""} className="font-mono text-xs" data-testid="input-token" />
            <Button size="icon" variant="outline" onClick={() => createdToken && copyToken(createdToken.token)}><Copy className="w-4 h-4" /></Button>
          </div>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">{`curl -X POST $API/iot/ingest \\
  -H "Authorization: Bearer ${createdToken?.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"deviceId":"${createdToken?.deviceId}","metric":"reading","value":42}'`}</pre>
          <div className="flex justify-end"><Button onClick={() => setCreatedToken(null)} data-testid="button-token-done">Done</Button></div>
        </div>
      </FormModal>
    </div>
  );
}
