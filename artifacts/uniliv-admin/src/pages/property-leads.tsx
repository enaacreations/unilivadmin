import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { FormModal } from "@/components/ui/form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, MapPin, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Fix leaflet default icon paths (vite bundling)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const STAGES = ["SCOUTING", "SITE_VISIT", "FEASIBILITY", "MANAGEMENT_REVIEW", "DEAL_CLOSED", "REJECTED"];
const stageColor: Record<string, string> = {
  SCOUTING: "bg-slate-200 text-slate-800",
  SITE_VISIT: "bg-blue-200 text-blue-800",
  FEASIBILITY: "bg-amber-200 text-amber-800",
  MANAGEMENT_REVIEW: "bg-purple-200 text-purple-800",
  DEAL_CLOSED: "bg-green-200 text-green-800",
  REJECTED: "bg-red-200 text-red-800",
};

const schema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  ownerName: z.string().optional(),
  ownerPhone: z.string().optional(),
  totalArea: z.coerce.number().optional(),
  askingRent: z.coerce.number().optional(),
  bedCount: z.coerce.number().optional(),
  stage: z.string(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  notes: z.string().optional(),
});

export default function PropertyLeads() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [stageFilter, setStageFilter] = React.useState<string>("ALL");

  const params = stageFilter !== "ALL" ? `?stage=${stageFilter}&limit=200` : "?limit=200";
  const { data: leadsRes } = useQuery({ queryKey: ["plead", stageFilter], queryFn: () => apiFetch<any>(`/property-leads${params}`) });
  const leads = leadsRes?.data || [];

  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: "", address: "", city: "", stage: "SCOUTING" } });

  const onCreate = form.handleSubmit(async (values) => {
    try {
      await apiFetch("/property-leads", { method: "POST", body: JSON.stringify(values) });
      toast({ title: "Property lead added" });
      setOpen(false); form.reset();
      qc.invalidateQueries({ queryKey: ["plead"] });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  });

  // Map setup
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  const mapInst = React.useRef<L.Map | null>(null);
  const layerRef = React.useRef<L.LayerGroup | null>(null);
  React.useEffect(() => {
    if (!mapRef.current || mapInst.current) return;
    mapInst.current = L.map(mapRef.current).setView([20.5937, 78.9629], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(mapInst.current);
    layerRef.current = L.layerGroup().addTo(mapInst.current);
  }, []);
  React.useEffect(() => {
    if (!layerRef.current || !mapInst.current) return;
    layerRef.current.clearLayers();
    const withCoords = leads.filter((l: any) => l.lat && l.lng);
    withCoords.forEach((l: any) => {
      const marker = L.marker([l.lat, l.lng]).bindPopup(`<b>${l.name}</b><br/>${l.city}<br/>${l.stage}`);
      marker.on("click", () => setActiveId(l.id));
      marker.addTo(layerRef.current!);
    });
    if (withCoords.length) {
      const group = L.featureGroup(withCoords.map((l: any) => L.marker([l.lat, l.lng])));
      mapInst.current!.fitBounds(group.getBounds().pad(0.2));
    }
  }, [leads]);

  return (
    <div className="space-y-4">
      <PageHeader title="Property Acquisition Leads" subtitle="Scouting tracker for new properties" action={<Button onClick={() => { form.reset({ name: "", address: "", city: "", stage: "SCOUTING" }); setOpen(true); }}><Plus className="h-4 w-4 mr-2" />Add Property Lead</Button>} />

      <div className="flex gap-2">
        <Select value={stageFilter} onValueChange={setStageFilter}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All stages</SelectItem>{STAGES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0"><div ref={mapRef} style={{ height: 380, width: "100%" }} className="rounded-md" /></CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {leads.map((l: any) => (
          <Card key={l.id} className="cursor-pointer hover:border-primary transition-colors" onClick={() => setActiveId(l.id)}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div><div className="font-medium">{l.name}</div><div className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" />{l.city}</div></div>
                <Badge className={stageColor[l.stage] || "bg-muted"}>{l.stage.replace(/_/g, " ")}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">{l.address}</div>
              <div className="grid grid-cols-3 gap-1 text-xs pt-1 border-t">
                <div><div className="text-muted-foreground">Area</div><div>{l.totalArea || "—"} sqft</div></div>
                <div><div className="text-muted-foreground">Beds</div><div>{l.bedCount || "—"}</div></div>
                <div><div className="text-muted-foreground">Rent</div><div>{l.askingRent ? `Rs.${l.askingRent}` : "—"}</div></div>
              </div>
            </CardContent>
          </Card>
        ))}
        {!leads.length && <Card className="md:col-span-2 lg:col-span-3"><CardContent className="p-8 text-center text-muted-foreground">No property leads yet</CardContent></Card>}
      </div>

      <FormModal open={open} onOpenChange={setOpen} title="Add Property Lead" onSave={onCreate}>
        <form className="space-y-3">
          <div><Label>Name / Property *</Label><Input {...form.register("name")} /></div>
          <div><Label>Address *</Label><Textarea rows={2} {...form.register("address")} /></div>
          <div className="grid grid-cols-2 gap-3"><div><Label>City *</Label><Input {...form.register("city")} /></div><div><Label>Stage</Label>
            <Select value={form.watch("stage")} onValueChange={(v) => form.setValue("stage", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STAGES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select>
          </div></div>
          <div className="grid grid-cols-2 gap-3"><div><Label>Owner name</Label><Input {...form.register("ownerName")} /></div><div><Label>Owner phone</Label><Input {...form.register("ownerPhone")} /></div></div>
          <div className="grid grid-cols-3 gap-3"><div><Label>Total area</Label><Input type="number" {...form.register("totalArea")} /></div><div><Label>Asking rent</Label><Input type="number" {...form.register("askingRent")} /></div><div><Label>Beds</Label><Input type="number" {...form.register("bedCount")} /></div></div>
          <div className="grid grid-cols-2 gap-3"><div><Label>Lat</Label><Input type="number" step="any" {...form.register("lat")} /></div><div><Label>Lng</Label><Input type="number" step="any" {...form.register("lng")} /></div></div>
          <div><Label>Notes</Label><Textarea rows={3} {...form.register("notes")} /></div>
        </form>
      </FormModal>

      {activeId && <PropertyLeadDetail id={activeId} onClose={() => setActiveId(null)} />}
    </div>
  );
}

function PropertyLeadDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({ queryKey: ["plead-d", id], queryFn: () => apiFetch<any>(`/property-leads/${id}`) });
  const lead = data?.data;
  const [via, setVia] = React.useState<{ occupancy: number; rentPerBed: number; opex: number }>({ occupancy: 85, rentPerBed: 0, opex: 0 });
  React.useEffect(() => {
    if (lead?.viabilityData) setVia({ ...via, ...(lead.viabilityData as any) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead]);

  if (!lead) return null;
  const beds = lead.bedCount || 0;
  const occupiedBeds = beds * (via.occupancy / 100);
  const monthlyRevenue = occupiedBeds * (via.rentPerBed || 0);
  const ebitda = monthlyRevenue - (via.opex || 0);

  const updateStage = async (stage: string) => {
    try {
      await apiFetch(`/property-leads/${id}`, { method: "PUT", body: JSON.stringify({ stage }) });
      qc.invalidateQueries({ queryKey: ["plead"] });
      qc.invalidateQueries({ queryKey: ["plead-d", id] });
      toast({ title: "Stage updated" });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const saveViability = async () => {
    try {
      await apiFetch(`/property-leads/${id}`, { method: "PUT", body: JSON.stringify({ viabilityData: via }) });
      qc.invalidateQueries({ queryKey: ["plead-d", id] });
      toast({ title: "Viability saved" });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  return (
    <Sheet open={true} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader><SheetTitle className="flex justify-between"><span>{lead.name}</span><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button></SheetTitle></SheetHeader>
        <div className="mt-4 space-y-4">
          <div><div className="text-sm text-muted-foreground">{lead.address}, {lead.city}</div></div>
          <div>
            <Label className="text-xs">Stage</Label>
            <Select value={lead.stage} onValueChange={updateStage}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STAGES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-sm">Property Info</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-y-2 text-sm">
              <div className="text-muted-foreground">Owner</div><div>{lead.ownerName || "—"}</div>
              <div className="text-muted-foreground">Owner phone</div><div>{lead.ownerPhone || "—"}</div>
              <div className="text-muted-foreground">Total area</div><div>{lead.totalArea || "—"} sqft</div>
              <div className="text-muted-foreground">Bed count</div><div>{lead.bedCount || "—"}</div>
              <div className="text-muted-foreground">Asking rent</div><div>{lead.askingRent ? `Rs. ${lead.askingRent}` : "—"}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Financial Viability</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div><Label className="text-xs">Occupancy %</Label><Input type="number" value={via.occupancy} onChange={(e) => setVia({ ...via, occupancy: Number(e.target.value) })} /></div>
                <div><Label className="text-xs">Rent / bed</Label><Input type="number" value={via.rentPerBed} onChange={(e) => setVia({ ...via, rentPerBed: Number(e.target.value) })} /></div>
                <div><Label className="text-xs">Opex / mo</Label><Input type="number" value={via.opex} onChange={(e) => setVia({ ...via, opex: Number(e.target.value) })} /></div>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-2 border-t text-sm">
                <div><div className="text-muted-foreground text-xs">Projected revenue</div><div className="font-medium">Rs. {monthlyRevenue.toLocaleString()}</div></div>
                <div><div className="text-muted-foreground text-xs">EBITDA</div><div className={`font-medium ${ebitda >= 0 ? "text-green-600" : "text-destructive"}`}>Rs. {ebitda.toLocaleString()}</div></div>
                <div><div className="text-muted-foreground text-xs">Margin</div><div className="font-medium">{monthlyRevenue ? Math.round((ebitda / monthlyRevenue) * 100) : 0}%</div></div>
              </div>
              <Button size="sm" onClick={saveViability}>Save viability</Button>
            </CardContent>
          </Card>

          <Card><CardHeader><CardTitle className="text-sm">Documents &amp; Photos</CardTitle></CardHeader><CardContent>
            <div className="text-xs text-muted-foreground">{(lead.documents?.length || 0)} documents · {(lead.photos?.length || 0)} photos</div>
          </CardContent></Card>

          {lead.notes && <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground mb-1">Notes</div><div className="text-sm">{lead.notes}</div></CardContent></Card>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
