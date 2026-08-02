import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, ChevronRight, Truck, MapPin, ChefHat,
  Search, Phone, AlertTriangle, Car,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FormModal } from "@/components/ui/form-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys,
  type Agency, type AgencyVehicle, type AgencyLocation, type AgencyKitchenLink,
  type Kitchen, type VehicleType,
} from "@/lib/food-api";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const labelize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Contact-field validators — mirror the backend rules in food.ts (zEmail/zPhone).
const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isValidPhone = (s: string) => {
  if (!/^\+?[0-9\s\-()]+$/.test(s)) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
};

const VEHICLE_TYPES: VehicleType[] = ["VAN", "BIKE", "TRUCK", "CAR", "TEMPO", "OTHER"];

// Small confirm-delete helper modal (mirrors food-settings).
function ConfirmDelete({
  open, onOpenChange, label, onConfirm, isDeleting,
}: { open: boolean; onOpenChange: (o: boolean) => void; label: string; onConfirm: () => void; isDeleting: boolean }) {
  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Confirm Delete" onSave={onConfirm} isSaving={isDeleting} saveLabel="Delete">
      <p className="text-sm text-muted-foreground">
        Are you sure you want to delete <span className="font-medium text-foreground">{label}</span>? This action cannot be undone.
      </p>
    </FormModal>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Agencies tab — searchable list, active toggle, per-agency detail with
 * Locations / Vehicles / Serves-kitchens (B3-11/12/13).
 * ════════════════════════════════════════════════════════════════════════════ */
export function AgenciesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();
  const canManage = can("FOOD_ORG", "edit");

  const [search, setSearch] = React.useState("");
  const params = { search: search.trim() || undefined };
  const { data: agencies = [], isLoading, isError, refetch } = useQuery<Agency[]>({
    queryKey: foodKeys.agencies(params),
    queryFn: () => foodApi.listAgencies(params),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "agencies"] });
    qc.invalidateQueries({ queryKey: foodKeys.lookups() });
  };

  // ── Agency create / edit / delete ──
  const [agOpen, setAgOpen] = React.useState(false);
  const [agEdit, setAgEdit] = React.useState<Agency | null>(null);
  const [agForm, setAgForm] = React.useState({ name: "", phone: "", contactName: "", email: "", isActive: true });
  const [agDel, setAgDel] = React.useState<Agency | null>(null);

  const agSave = useMutation({
    mutationFn: () => {
      const b = { name: agForm.name.trim(), phone: agForm.phone.trim() || null, contactName: agForm.contactName.trim() || null, email: agForm.email.trim() || null, isActive: agForm.isActive };
      return agEdit ? foodApi.updateAgency(agEdit.id, b) : foodApi.createAgency(b);
    },
    onSuccess: () => { toast({ title: agEdit ? "Agency updated" : "Agency created" }); invalidate(); setAgOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Could not save agency", variant: "destructive" }),
  });
  const agDelMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteAgency(id),
    onSuccess: () => { toast({ title: "Agency deactivated" }); invalidate(); setAgDel(null); },
    onError: (e: any) => toast({ title: e?.message || "Could not delete agency", variant: "destructive" }),
  });
  // Quick active toggle from the list row.
  const agToggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => foodApi.updateAgency(id, { isActive }),
    onSuccess: () => { toast({ title: "Agency updated" }); invalidate(); },
    onError: (e: any) => toast({ title: e?.message || "Could not update agency", variant: "destructive" }),
  });

  const openAgCreate = () => { setAgEdit(null); setAgForm({ name: "", phone: "", contactName: "", email: "", isActive: true }); setAgOpen(true); };
  const openAgEdit = (a: Agency) => { setAgEdit(a); setAgForm({ name: a.name, phone: a.phone ?? "", contactName: a.contactName ?? "", email: a.email ?? "", isActive: a.isActive }); setAgOpen(true); };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">Delivery Agencies</CardTitle>
            <CardDescription className="text-xs">
              Agencies that fulfil dispatch — each with service locations, vehicles, and the kitchens they serve. A dispatch picks an agency, then a vehicle.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search agencies…" className="pl-9" />
            </div>
            {canManage && (
              <Button size="sm" className="shrink-0 bg-accent text-white hover:bg-accent/90" onClick={openAgCreate}>
                <Plus className="mr-1 h-4 w-4" /> Add Agency
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading agencies…</p>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 py-8 text-center">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <p className="text-sm text-destructive">Could not load agencies.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </div>
          ) : agencies.length === 0 ? (
            <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              {search.trim() ? "No agencies match your search." : "No agencies yet. Add one to get started."}
            </p>
          ) : (
            <BoundedScroll size="lg">
              <div className="space-y-2 pr-3">
                {agencies.map((a) => (
                  <AgencyRow
                    key={a.id}
                    agency={a}
                    canManage={canManage}
                    onEdit={() => openAgEdit(a)}
                    onDelete={() => setAgDel(a)}
                    onToggleActive={(isActive) => agToggle.mutate({ id: a.id, isActive })}
                    invalidate={invalidate}
                  />
                ))}
              </div>
            </BoundedScroll>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit Agency */}
      <FormModal
        open={agOpen}
        onOpenChange={setAgOpen}
        title={agEdit ? "Edit Agency" : "Add Agency"}
        onSave={() => {
          if (!agForm.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
          if (agForm.email.trim() && !isValidEmail(agForm.email.trim())) { toast({ title: "Enter a valid email address", variant: "destructive" }); return; }
          if (agForm.phone.trim() && !isValidPhone(agForm.phone.trim())) { toast({ title: "Enter a valid phone number (10–15 digits)", variant: "destructive" }); return; }
          agSave.mutate();
        }}
        isSaving={agSave.isPending}
        saveLabel={agEdit ? "Save" : "Create"}
      >
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={agForm.name} onChange={(e) => setAgForm({ ...agForm, name: e.target.value })} placeholder="e.g. Swift Logistics" autoFocus /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Contact name</Label><Input value={agForm.contactName} onChange={(e) => setAgForm({ ...agForm, contactName: e.target.value })} /></div>
            <div>
              <Label>Phone</Label>
              <Input
                value={agForm.phone}
                onChange={(e) => setAgForm({ ...agForm, phone: e.target.value })}
                className={cx("font-mono", agForm.phone.trim() && !isValidPhone(agForm.phone.trim()) && "border-destructive focus-visible:ring-destructive")}
                inputMode="tel"
                placeholder="e.g. 9876543210"
              />
              {agForm.phone.trim() && !isValidPhone(agForm.phone.trim()) && (
                <p className="mt-1 text-xs text-destructive">Enter a valid phone number (10–15 digits).</p>
              )}
            </div>
          </div>
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              value={agForm.email}
              onChange={(e) => setAgForm({ ...agForm, email: e.target.value })}
              className={cx(agForm.email.trim() && !isValidEmail(agForm.email.trim()) && "border-destructive focus-visible:ring-destructive")}
              placeholder="e.g. ops@agency.com"
            />
            {agForm.email.trim() && !isValidEmail(agForm.email.trim()) && (
              <p className="mt-1 text-xs text-destructive">Enter a valid email address.</p>
            )}
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <Label>Active</Label>
            <Switch checked={agForm.isActive} onCheckedChange={(v) => setAgForm({ ...agForm, isActive: v })} />
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!agDel} onOpenChange={(o) => !o && setAgDel(null)} label={agDel?.name ?? ""} onConfirm={() => agDel && agDelMut.mutate(agDel.id)} isDeleting={agDelMut.isPending} />
    </div>
  );
}

/* ─── One agency row — header + expandable detail (locations / vehicles / kitchens) ── */
function AgencyRow({
  agency, canManage, onEdit, onDelete, onToggleActive, invalidate,
}: {
  agency: Agency;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (isActive: boolean) => void;
  invalidate: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const contact = [agency.contactName, agency.phone, agency.email].filter(Boolean).join(" · ") || "No contact";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <CollapsibleTrigger className="flex flex-1 items-center gap-2 text-left">
          <ChevronRight className={cx("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Truck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-primary">{agency.name}</span>
          {!agency.isActive && <Badge variant="secondary" className="shrink-0 text-[10px]">Inactive</Badge>}
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {contact}</span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Switch checked={agency.isActive} disabled={!canManage} onCheckedChange={onToggleActive} title="Active" />
          {canManage && (
            <>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} title="Edit agency"><Pencil className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={onDelete} title="Delete agency"><Trash2 className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </div>
      </div>
      <CollapsibleContent>
        <div className="space-y-4 border-t bg-surface/40 p-3">
          {/* Lazily mount detail panels only when expanded so we don't fan-out fetches for collapsed rows. */}
          {open && (
            <>
              <LocationsSection agencyId={agency.id} canManage={canManage} invalidate={invalidate} />
              <VehiclesSection agencyId={agency.id} canManage={canManage} invalidate={invalidate} />
              <ServesKitchensSection agencyId={agency.id} canManage={canManage} />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ─── (1) LOCATIONS sub-table ─────────────────────────────────────────────── */
type LocationForm = { name: string; address: string; city: string; state: string; pincode: string; contactName: string; contactPhone: string };
const emptyLocation: LocationForm = { name: "", address: "", city: "", state: "", pincode: "", contactName: "", contactPhone: "" };

function LocationsSection({ agencyId, canManage, invalidate }: { agencyId: string; canManage: boolean; invalidate: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Agency-scoped read for the locations of just this agency, derived from the
  // full agencies payload (locations are embedded on each Agency).
  const { data: locations = [], isLoading } = useQuery<AgencyLocation[]>({
    queryKey: ["food", "agency-locations", agencyId],
    queryFn: async () => (await foodApi.listAgencies()).find((a) => a.id === agencyId)?.locations ?? [],
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["food", "agency-locations", agencyId] }); invalidate(); };

  const [open, setOpen] = React.useState(false);
  const [edit, setEdit] = React.useState<AgencyLocation | null>(null);
  const [form, setForm] = React.useState<LocationForm>(emptyLocation);
  const [del, setDel] = React.useState<AgencyLocation | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const b = {
        name: form.name.trim(), address: form.address || null, city: form.city || null,
        state: form.state || null, pincode: form.pincode || null,
        contactName: form.contactName || null, contactPhone: form.contactPhone || null,
      };
      return edit ? foodApi.updateAgencyLocation(edit.id, b) : foodApi.createAgencyLocation(agencyId, b);
    },
    onSuccess: () => { toast({ title: edit ? "Location updated" : "Location added" }); refresh(); setOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Could not save location", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteAgencyLocation(id),
    onSuccess: () => { toast({ title: "Location removed" }); refresh(); setDel(null); },
    onError: (e: any) => toast({ title: e?.message || "Could not remove location", variant: "destructive" }),
  });

  const openCreate = () => { setEdit(null); setForm(emptyLocation); setOpen(true); };
  const openEdit = (l: AgencyLocation) => {
    setEdit(l);
    setForm({ name: l.name, address: l.address ?? "", city: l.city ?? "", state: l.state ?? "", pincode: l.pincode ?? "", contactName: l.contactName ?? "", contactPhone: l.contactPhone ?? "" });
    setOpen(true);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" /> Locations
          <Badge variant="secondary" className="text-[10px]">{locations.length}</Badge>
        </span>
        {canManage && <Button variant="outline" size="sm" className="h-7" onClick={openCreate}><Plus className="mr-1 h-3 w-3" /> Add</Button>}
      </div>
      <div className="space-y-1">
        {isLoading ? <p className="text-xs text-muted-foreground">Loading…</p>
          : locations.length === 0 ? <p className="text-xs text-muted-foreground">No service locations yet.</p>
          : locations.map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{l.name}</span>
                  {!l.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  {[l.city, l.state, l.pincode].filter(Boolean).length > 0 && (
                    <span>{[l.city, l.state, l.pincode].filter(Boolean).join(", ")}</span>
                  )}
                  {l.contactPhone && <span className="inline-flex items-center gap-0.5 font-mono"><Phone className="h-3 w-3" />{l.contactPhone}</span>}
                </div>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(l)} title="Edit"><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDel(l)} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          ))}
      </div>

      <FormModal
        open={open}
        onOpenChange={setOpen}
        title={edit ? "Edit Location" : "Add Location"}
        onSave={() => { if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; } save.mutate(); }}
        isSaving={save.isPending}
        saveLabel={edit ? "Save" : "Add"}
      >
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Koramangala Hub" autoFocus /></div>
          <div><Label>Address</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street address" /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>City</Label><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
            <div><Label>State</Label><Input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></div>
            <div><Label>Pincode</Label><Input value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} className="font-mono" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-3">
            <div><Label>Contact name</Label><Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
            <div><Label>Contact phone</Label><Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} className="font-mono" /></div>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!del} onOpenChange={(o) => !o && setDel(null)} label={del?.name ?? ""} onConfirm={() => del && delMut.mutate(del.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

/* ─── (2) VEHICLES sub-table (with search-by-number filter) ───────────────── */
type VehicleForm = { vehicleNumber: string; vehicleType: VehicleType };
const emptyVehicle: VehicleForm = { vehicleNumber: "", vehicleType: "VAN" };

function VehiclesSection({ agencyId, canManage, invalidate }: { agencyId: string; canManage: boolean; invalidate: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: allVehicles = [], isLoading } = useQuery<AgencyVehicle[]>({
    queryKey: ["food", "agency-vehicles", agencyId],
    queryFn: async () => (await foodApi.listAgencies()).find((a) => a.id === agencyId)?.vehicles ?? [],
  });

  const [vSearch, setVSearch] = React.useState("");
  const vehicles = vSearch.trim()
    ? allVehicles.filter((v) => v.vehicleNumber.toLowerCase().includes(vSearch.trim().toLowerCase()))
    : allVehicles;

  const refresh = () => { qc.invalidateQueries({ queryKey: ["food", "agency-vehicles", agencyId] }); invalidate(); };

  const [open, setOpen] = React.useState(false);
  const [edit, setEdit] = React.useState<AgencyVehicle | null>(null);
  const [form, setForm] = React.useState<VehicleForm>(emptyVehicle);
  const [del, setDel] = React.useState<AgencyVehicle | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const b = { vehicleNumber: form.vehicleNumber.trim(), vehicleType: form.vehicleType };
      return edit ? foodApi.updateAgencyVehicle(edit.id, b) : foodApi.createAgencyVehicle(agencyId, b);
    },
    onSuccess: () => { toast({ title: edit ? "Vehicle updated" : "Vehicle added" }); refresh(); setOpen(false); },
    onError: (e: any) => toast({ title: e?.message || "Could not save vehicle", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => foodApi.deleteAgencyVehicle(id),
    onSuccess: () => { toast({ title: "Vehicle removed" }); refresh(); setDel(null); },
    onError: (e: any) => toast({ title: e?.message || "Could not remove vehicle", variant: "destructive" }),
  });

  const openCreate = () => { setEdit(null); setForm(emptyVehicle); setOpen(true); };
  const openEdit = (v: AgencyVehicle) => { setEdit(v); setForm({ vehicleNumber: v.vehicleNumber, vehicleType: v.vehicleType }); setOpen(true); };

  return (
    <div className="border-t pt-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Car className="h-3.5 w-3.5" /> Vehicles
          <Badge variant="secondary" className="text-[10px]">{allVehicles.length}</Badge>
        </span>
        <div className="flex items-center gap-2">
          <div className="relative w-44">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={vSearch} onChange={(e) => setVSearch(e.target.value)} placeholder="Search vehicle no…" className="h-7 pl-7 text-xs" />
          </div>
          {canManage && <Button variant="outline" size="sm" className="h-7" onClick={openCreate}><Plus className="mr-1 h-3 w-3" /> Add</Button>}
        </div>
      </div>
      <div className="space-y-1">
        {isLoading ? <p className="text-xs text-muted-foreground">Loading…</p>
          : allVehicles.length === 0 ? <p className="text-xs text-muted-foreground">No vehicles yet.</p>
          : vehicles.length === 0 ? <p className="text-xs text-muted-foreground">No vehicle matches “{vSearch.trim()}”.</p>
          : vehicles.map((v) => (
            <div key={v.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
              <span className="font-mono text-xs">{v.vehicleNumber}</span>
              <Badge variant="outline" className="text-[10px]">{labelize(v.vehicleType)}</Badge>
              {!v.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
              {canManage && (
                <div className="ml-auto flex items-center gap-0.5">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(v)} title="Edit"><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDel(v)} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          ))}
      </div>

      <FormModal
        open={open}
        onOpenChange={setOpen}
        title={edit ? "Edit Vehicle" : "Add Vehicle"}
        onSave={() => { if (!form.vehicleNumber.trim()) { toast({ title: "Vehicle number is required", variant: "destructive" }); return; } save.mutate(); }}
        isSaving={save.isPending}
        saveLabel={edit ? "Save" : "Add"}
      >
        <div className="space-y-4">
          <div><Label>Vehicle Number *</Label><Input value={form.vehicleNumber} onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })} className="font-mono" placeholder="KA05AB1234" autoFocus /></div>
          <div>
            <Label>Type</Label>
            <Select value={form.vehicleType} onValueChange={(v) => setForm({ ...form, vehicleType: v as VehicleType })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{VEHICLE_TYPES.map((t) => <SelectItem key={t} value={t}>{labelize(t)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>

      <ConfirmDelete open={!!del} onOpenChange={(o) => !o && setDel(null)} label={del?.vehicleNumber ?? ""} onConfirm={() => del && delMut.mutate(del.id)} isDeleting={delMut.isPending} />
    </div>
  );
}

/* ─── (3) SERVES KITCHENS — multi-select checkbox list + count badge ──────── */
function ServesKitchensSection({ agencyId, canManage }: { agencyId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: kitchens = [], isLoading: kitchensLoading } = useQuery<Kitchen[]>({
    queryKey: foodKeys.kitchens(),
    queryFn: () => foodApi.listKitchens(),
  });
  const { data: linked = [], isLoading: linkedLoading, isError } = useQuery<AgencyKitchenLink[]>({
    queryKey: foodKeys.agencyKitchens(agencyId),
    queryFn: () => foodApi.getAgencyKitchens(agencyId),
  });

  // Local draft of selected kitchen ids — seeded from the server links, mutated
  // by the checkboxes, persisted via setAgencyKitchens on Save.
  const linkedIds = React.useMemo(() => linked.map((k) => k.id), [linked]);
  const [selected, setSelected] = React.useState<string[] | null>(null);
  React.useEffect(() => { setSelected(null); }, [agencyId]);
  const current = selected ?? linkedIds;

  const dirty = selected !== null && (
    selected.length !== linkedIds.length || selected.some((id) => !linkedIds.includes(id))
  );

  const save = useMutation({
    mutationFn: () => foodApi.setAgencyKitchens(agencyId, current),
    onSuccess: () => {
      toast({ title: "Served kitchens updated" });
      qc.invalidateQueries({ queryKey: foodKeys.agencyKitchens(agencyId) });
      // Refresh the reverse (kitchen→agencies) views + lookups that embed kitchenIds.
      qc.invalidateQueries({ queryKey: ["food", "kitchen-agencies"] });
      qc.invalidateQueries({ queryKey: foodKeys.lookups() });
      setSelected(null);
    },
    onError: (e: any) => toast({ title: e?.message || "Could not update served kitchens", variant: "destructive" }),
  });

  const toggle = (id: string) =>
    setSelected((cur) => {
      const base = cur ?? linkedIds;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  return (
    <div className="border-t pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ChefHat className="h-3.5 w-3.5" /> Serves kitchens
          <Badge variant="secondary" className="text-[10px]">{current.length}</Badge>
        </span>
        {canManage && (
          <Button size="sm" className="h-7" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {kitchensLoading || linkedLoading ? (
        <p className="text-xs text-muted-foreground">Loading kitchens…</p>
      ) : isError ? (
        <p className="text-xs text-destructive">Could not load served kitchens.</p>
      ) : kitchens.length === 0 ? (
        <p className="text-xs text-muted-foreground">No kitchens defined yet.</p>
      ) : (
        <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border bg-card p-2">
          {kitchens.map((k) => {
            const checked = current.includes(k.id);
            return (
              <label key={k.id} className={cx("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60", checked && "bg-accent/5", !canManage && "cursor-default")}>
                <Checkbox checked={checked} disabled={!canManage} onCheckedChange={() => canManage && toggle(k.id)} />
                <ChefHat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{k.name}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">{k.code}</Badge>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
