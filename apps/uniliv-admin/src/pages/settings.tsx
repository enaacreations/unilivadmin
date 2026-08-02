import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { Check, X } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";

const COMPLAINT_CATEGORIES = ["ELECTRICAL","PLUMBING","HOUSEKEEPING","INTERNET","SECURITY","FOOD","LAUNDRY","OTHER"];

const CURRENCY_OPTIONS = [
  { value: "INR", label: "INR — Indian Rupee (₹)" },
  { value: "USD", label: "USD — US Dollar ($)" },
  { value: "EUR", label: "EUR — Euro (€)" },
  { value: "GBP", label: "GBP — British Pound (£)" },
  { value: "AED", label: "AED — UAE Dirham (د.إ)" },
];
const TIMEZONE_OPTIONS = [
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London",
  "America/New_York", "America/Los_Angeles", "UTC",
].map((tz) => ({ value: tz, label: tz }));

type GeneralSettings = { organization: string; currency: string; timezone: string; supportEmail: string };
const GENERAL_DEFAULTS: GeneralSettings = { organization: "UNILIV Co-Living", currency: "INR", timezone: "Asia/Kolkata", supportEmail: "support@uniliv.com" };

function GeneralTab({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [form, setForm] = React.useState<GeneralSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("uniliv_general_settings") || "{}");
      return { ...GENERAL_DEFAULTS, ...saved };
    } catch { return GENERAL_DEFAULTS; }
  });
  const [saved, setSaved] = React.useState(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const onSave = () => {
    localStorage.setItem("uniliv_general_settings", JSON.stringify(form));
    setSaved(form);
    toast({ title: "General settings saved" });
  };

  return (
    <Card>
      <CardHeader><CardTitle>General</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Organization</Label>
            <Input value={form.organization} onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))} disabled={!canEdit} />
          </div>
          <div>
            <Label>Currency</Label>
            <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))} disabled={!canEdit}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CURRENCY_OPTIONS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Timezone</Label>
            <Combobox
              options={TIMEZONE_OPTIONS}
              value={form.timezone}
              onChange={(v) => setForm((f) => ({ ...f, timezone: v || GENERAL_DEFAULTS.timezone }))}
              placeholder="Select timezone"
              searchPlaceholder="Search timezones…"
              disabled={!canEdit}
            />
          </div>
          <div>
            <Label>Support Email</Label>
            <Input type="email" value={form.supportEmail} onChange={(e) => setForm((f) => ({ ...f, supportEmail: e.target.value }))} disabled={!canEdit} />
          </div>
        </div>
        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={!dirty} data-testid="button-save-general">Save Changes</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SLATab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ data: Array<{ id: string; category: string; slaHours: number }> }>({
    queryKey: ["/settings/sla"], queryFn: () => apiFetch("/settings/sla"),
  });
  const update = useMutation({
    mutationFn: ({ category, slaHours }: { category: string; slaHours: number }) =>
      apiFetch(`/settings/sla/${category}`, { method: "PUT", body: JSON.stringify({ slaHours }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/settings/sla"] }); toast({ title: "SLA updated" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const map = new Map((data?.data || []).map((r) => [r.category, r.slaHours]));
  return (
    <Card>
      <CardHeader><CardTitle>Complaint SLA Configuration</CardTitle></CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2">Category</th><th>SLA (hours)</th><th /></tr></thead>
          <tbody>
            {COMPLAINT_CATEGORIES.map((c) => (
              <SLARow key={c} category={c} hours={map.get(c) ?? 24} canEdit={canEdit} onSave={(h) => update.mutate({ category: c, slaHours: h })} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SLARow({ category, hours, canEdit, onSave }: { category: string; hours: number; canEdit: boolean; onSave: (h: number) => void }) {
  const [val, setVal] = React.useState(hours);
  React.useEffect(() => setVal(hours), [hours]);
  return (
    <tr className="border-b">
      <td className="py-2">{category}</td>
      <td><Input type="number" value={val} onChange={(e) => setVal(Number(e.target.value))} disabled={!canEdit} className="w-32" /></td>
      <td className="text-right">{canEdit && <Button size="sm" variant="outline" onClick={() => onSave(val)} disabled={val === hours}>Save</Button>}</td>
    </tr>
  );
}

function RoutingTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: routings } = useQuery<{ data: any[] }>({ queryKey: ["/settings/routing"], queryFn: () => apiFetch("/settings/routing") });
  const { data: properties } = useQuery<{ data: any[] }>({ queryKey: ["/properties"], queryFn: () => apiFetch("/properties") });
  const { data: users } = useQuery<{ data: any[] }>({ queryKey: ["/users"], queryFn: () => apiFetch("/users") });
  const [propertyId, setPropertyId] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [assignedTo, setAssignedTo] = React.useState("");

  const create = useMutation({
    mutationFn: () => apiFetch("/settings/routing", { method: "POST", body: JSON.stringify({ propertyId, category, assignedTo }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/settings/routing"] }); toast({ title: "Routing rule added" }); setPropertyId(""); setCategory(""); setAssignedTo(""); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/settings/routing/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/settings/routing"] }),
  });

  const userMap = new Map((users?.data || []).map((u: any) => [u.id, u.name]));
  const propMap = new Map((properties?.data || []).map((p: any) => [p.id, p.name]));

  return (
    <Card>
      <CardHeader><CardTitle>Complaint Routing Rules</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="grid grid-cols-4 gap-2 items-end">
            <div><label className="text-xs">Property</label>
              <Select value={propertyId} onValueChange={setPropertyId}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{(properties?.data || []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><label className="text-xs">Category</label>
              <Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{COMPLAINT_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><label className="text-xs">Assignee</label>
              <Select value={assignedTo} onValueChange={setAssignedTo}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{(users?.data || []).map((u: any) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <Button onClick={() => create.mutate()} disabled={!propertyId || !category || !assignedTo}>Add Rule</Button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2">Property</th><th>Category</th><th>Assignee</th><th /></tr></thead>
          <tbody>
            {(routings?.data || []).map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-2">{propMap.get(r.propertyId) || r.propertyId}</td>
                <td>{r.category}</td>
                <td>{userMap.get(r.assignedTo) || r.assignedTo}</td>
                <td className="text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}>Remove</Button>}</td>
              </tr>
            ))}
            {!(routings?.data?.length) && <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No routing rules</td></tr>}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function NotificationsTab() {
  const TYPES = [
    { key: "COMPLAINT_SLA_BREACH", label: "Complaint SLA breach" },
    { key: "PAYMENT_OVERDUE", label: "Payment overdue (daily 9am)" },
    { key: "LEAVE_APPROVAL_PENDING", label: "Leave approval pending" },
    { key: "INDENT_APPROVAL_PENDING", label: "Indent approval pending" },
    { key: "LOW_STOCK", label: "Low stock" },
    { key: "DOCUMENT_EXPIRY", label: "Vendor document expiry (30 days)" },
    { key: "LEASE_RENEWAL", label: "Lease renewal (60 days)" },
  ];
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("uniliv_notif_settings") || "{}"); } catch { return {}; }
  });
  const toggle = (k: string) => {
    const next = { ...enabled, [k]: !(enabled[k] ?? true) };
    setEnabled(next);
    localStorage.setItem("uniliv_notif_settings", JSON.stringify(next));
  };
  return (
    <Card>
      <CardHeader><CardTitle>Notification Types</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {TYPES.map((t) => {
            const on = enabled[t.key] ?? true;
            return (
              <div key={t.key} className="flex items-center justify-between p-3 border rounded">
                <div><div className="font-medium text-sm">{t.label}</div><div className="text-xs text-muted-foreground">{t.key}</div></div>
                <Button variant={on ? "default" : "outline"} size="sm" onClick={() => toggle(t.key)}>{on ? "Enabled" : "Disabled"}</Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function IntegrationsTab() {
  const { data } = useQuery<{ data: Array<{ name: string; enabled: boolean; configured: boolean }> }>({
    queryKey: ["/settings/integrations"], queryFn: () => apiFetch("/settings/integrations"),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Integrations</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {(data?.data || []).map((i) => (
            <div key={i.name} className="flex items-center justify-between p-3 border rounded">
              <div className="flex items-center gap-3">
                {i.configured ? <Check className="w-5 h-5 text-success" /> : <X className="w-5 h-5 text-muted-foreground" />}
                <div><div className="font-medium text-sm">{i.name}</div><div className="text-xs text-muted-foreground">{i.configured ? "Configured" : "Not configured — set environment variables"}</div></div>
              </div>
              <Badge variant={i.configured ? "default" : "outline"}>{i.configured ? "Connected" : "Not Connected"}</Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function KycGateTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ data: { enabled: boolean } }>({
    queryKey: ["/settings/kyc-gate"], queryFn: () => apiFetch("/settings/kyc-gate"),
  });
  const enabled = !!data?.data?.enabled;
  const update = useMutation({
    mutationFn: (next: boolean) => apiFetch("/settings/kyc-gate", { method: "PUT", body: JSON.stringify({ enabled: next }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/settings/kyc-gate"] }); toast({ title: "Saved" }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Resident Activation Gate</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When enabled, residents cannot be set to <strong>ACTIVE</strong> until they have at least one
          verified KYC record and one signed e-sign agreement.
        </p>
        <div className="flex items-center justify-between p-3 border rounded">
          <div>
            <div className="font-medium text-sm">Require verified KYC + signed agreement before activation</div>
            <div className="text-xs text-muted-foreground">Affects all resident PUTs that set status=ACTIVE.</div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={enabled ? "default" : "outline"} data-testid="badge-kyc-gate">{enabled ? "Enabled" : "Disabled"}</Badge>
            <Button
              size="sm"
              variant={enabled ? "destructive" : "default"}
              disabled={!canEdit || update.isPending}
              onClick={() => update.mutate(!enabled)}
              data-testid="button-toggle-kyc-gate"
            >
              {enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WalletConfigTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: propertiesRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = (propertiesRes as any)?.data || [];
  const [propertyId, setPropertyId] = React.useState<string>("");

  React.useEffect(() => {
    if (properties.length > 0 && !propertyId) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  const configQK = ["/wallet/config", propertyId];
  const { data: configRes } = useQuery<{
    data: { minimumBalance: number; lowBalanceAlert: number; isEnabled: boolean; topupNotes: string | null };
  }>({
    queryKey: configQK,
    queryFn: () => apiFetch(`/wallet/config/${propertyId}`),
    enabled: !!propertyId,
  });
  const cfg = configRes?.data;

  const [form, setForm] = React.useState({ isEnabled: true, minimumBalance: "0", lowBalanceAlert: "200", topupNotes: "" });

  React.useEffect(() => {
    if (cfg) {
      setForm({
        isEnabled: cfg.isEnabled,
        minimumBalance: String(cfg.minimumBalance ?? 0),
        lowBalanceAlert: String(cfg.lowBalanceAlert ?? 200),
        topupNotes: cfg.topupNotes || "",
      });
    }
  }, [cfg]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/wallet/config/${propertyId}`, {
      method: "PUT",
      body: JSON.stringify({
        isEnabled: form.isEnabled,
        minimumBalance: Number(form.minimumBalance),
        lowBalanceAlert: Number(form.lowBalanceAlert),
        topupNotes: form.topupNotes || null,
      }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: configQK }); toast({ title: "Wallet config saved" }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Wallet Settings</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Configure wallet behaviour per property — minimum balance enforcement, low-balance alert threshold, and top-up instructions shown to staff.</p>
          <div>
            <Label>Property</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger className="w-64"><SelectValue placeholder="Select property" /></SelectTrigger>
              <SelectContent>
                {properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {propertyId && (
            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between p-3 border rounded">
                <div>
                  <div className="font-medium text-sm">Wallet Enabled</div>
                  <div className="text-xs text-muted-foreground">Residents at this property can use the wallet system.</div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={form.isEnabled ? "default" : "outline"}>{form.isEnabled ? "Enabled" : "Disabled"}</Badge>
                  {canEdit && (
                    <Button size="sm" variant={form.isEnabled ? "destructive" : "default"} onClick={() => setForm((f) => ({ ...f, isEnabled: !f.isEnabled }))}>
                      {form.isEnabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Minimum Balance (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={form.minimumBalance}
                    onChange={(e) => setForm((f) => ({ ...f, minimumBalance: e.target.value }))}
                    disabled={!canEdit}
                    data-testid="input-wallet-min-balance"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Wallet pay will be blocked if balance would fall below this amount.</p>
                </div>
                <div>
                  <Label>Low Balance Alert Threshold (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={form.lowBalanceAlert}
                    onChange={(e) => setForm((f) => ({ ...f, lowBalanceAlert: e.target.value }))}
                    disabled={!canEdit}
                    data-testid="input-wallet-low-alert"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Wallets below this threshold are flagged as Low Balance in the overview.</p>
                </div>
              </div>
              <div>
                <Label>Top-up Notes (shown to staff during top-up)</Label>
                <Textarea
                  rows={3}
                  value={form.topupNotes}
                  onChange={(e) => setForm((f) => ({ ...f, topupNotes: e.target.value }))}
                  disabled={!canEdit}
                  placeholder="e.g. Accept cash only. Issue a handwritten receipt..."
                  data-testid="textarea-wallet-topup-notes"
                />
              </div>
              {canEdit && (
                <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-wallet-config">
                  {save.isPending ? "Saving…" : "Save Wallet Config"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ElectricityTariffsTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ data: Array<{ id: string; name: string; ratePerUnit: number; fixedCharge: number; effectiveFrom: string; isActive: boolean }> }>({
    queryKey: ["/electricity/tariffs"], queryFn: () => apiFetch("/electricity/tariffs"),
  });
  const tariffs = data?.data || [];
  const [form, setForm] = React.useState({ name: "", ratePerUnit: "", fixedCharge: "0", effectiveFrom: new Date().toISOString().slice(0, 10) });
  const create = useMutation({
    mutationFn: () => apiFetch("/electricity/tariffs", {
      method: "POST",
      body: JSON.stringify({ ...form, ratePerUnit: Number(form.ratePerUnit), fixedCharge: Number(form.fixedCharge), isActive: true }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/electricity/tariffs"] }); toast({ title: "Tariff added" }); setForm({ name: "", ratePerUnit: "", fixedCharge: "0", effectiveFrom: new Date().toISOString().slice(0, 10) }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Electricity Tariffs</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Define tariff plans for electricity meters. Active rate at the time of recording is applied to compute charges automatically.</p>
        {canEdit && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end p-3 border rounded bg-surface">
            <div><label className="text-xs">Name</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Standard" data-testid="input-tariff-name-settings" /></div>
            <div><label className="text-xs">Rate / unit</label><Input type="number" step="0.01" value={form.ratePerUnit} onChange={(e) => setForm({ ...form, ratePerUnit: e.target.value })} data-testid="input-tariff-rate-settings" /></div>
            <div><label className="text-xs">Fixed charge</label><Input type="number" step="0.01" value={form.fixedCharge} onChange={(e) => setForm({ ...form, fixedCharge: e.target.value })} /></div>
            <div><label className="text-xs">Effective from</label><DatePicker value={form.effectiveFrom} onChange={(v) => setForm({ ...form, effectiveFrom: v })} /></div>
            <Button onClick={() => create.mutate()} disabled={!form.name || !form.ratePerUnit || create.isPending} data-testid="button-add-tariff-settings">Add Tariff</Button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2">Name</th><th>Rate</th><th>Fixed</th><th>Effective From</th><th>Status</th></tr></thead>
          <tbody>
            {tariffs.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No tariffs configured.</td></tr>
            ) : tariffs.map((t) => (
              <tr key={t.id} className="border-b" data-testid={`tariff-row-settings-${t.id}`}>
                <td className="py-2 font-medium">{t.name}</td>
                <td className="font-mono">₹{t.ratePerUnit}</td>
                <td className="font-mono">₹{t.fixedCharge}</td>
                <td className="text-xs">{new Date(t.effectiveFrom).toLocaleDateString()}</td>
                <td>{t.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// OTP / login-security caps (#5/#6) — SUPER_ADMIN only. Mirrors the system_config
// keys read live by the OTP service. Bounds match the backend validation.
const OTP_FIELDS = [
  { key: "OTP_MAX_ATTEMPTS", label: "Max verification attempts", help: "Wrong-code guesses allowed before a challenge locks.", min: 1, max: 10 },
  { key: "OTP_MAX_RESEND", label: "Max resends per challenge", help: "How many times a resident can request a new code.", min: 1, max: 10 },
  { key: "OTP_EXPIRY_MINUTES", label: "Code validity (minutes)", help: "How long an OTP stays valid after it is sent.", min: 1, max: 60 },
] as const;

function OtpSecurityTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ data: Record<string, number> }>({
    queryKey: ["/settings/otp-config"], queryFn: () => apiFetch("/settings/otp-config"),
  });
  const [form, setForm] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (data?.data) {
      setForm(Object.fromEntries(OTP_FIELDS.map((f) => [f.key, String(data.data[f.key] ?? "")])));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => apiFetch("/settings/otp-config", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(OTP_FIELDS.map((f) => [f.key, Number(form[f.key])]))),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/settings/otp-config"] }); toast({ title: "OTP settings saved" }); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const dirty = !!data?.data && OTP_FIELDS.some((f) => Number(form[f.key]) !== data.data[f.key]);
  const valid = OTP_FIELDS.every((f) => {
    const n = Number(form[f.key]);
    return Number.isInteger(n) && n >= f.min && n <= f.max;
  });

  return (
    <Card>
      <CardHeader><CardTitle>OTP / Login Security</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Caps applied to every login and account-recovery OTP challenge. Changes take effect immediately for
          newly issued codes.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {OTP_FIELDS.map((f) => (
            <div key={f.key}>
              <Label>{f.label}</Label>
              <Input
                type="number"
                min={f.min}
                max={f.max}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                data-testid={`input-otp-${f.key}`}
              />
              <p className="text-xs text-muted-foreground mt-1">{f.help} (Allowed {f.min}–{f.max}.)</p>
            </div>
          ))}
        </div>
        <Button onClick={() => save.mutate()} disabled={!dirty || !valid || save.isPending} data-testid="button-save-otp-config">
          {save.isPending ? "Saving…" : "Save OTP Settings"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { can, role } = usePermissions();
  const canEdit = can("SETTINGS", "edit");
  const canEditElectricity = can("ELECTRICITY", "edit");
  const isSuperAdmin = isSuperAdminRole(role);
  return (
    <>
      <PageHeader title="Settings" subtitle="System configuration, integrations, and audit" />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="sla">SLA</TabsTrigger>
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="kyc-gate" data-testid="tab-kyc-gate">KYC Gate</TabsTrigger>
          <TabsTrigger value="electricity-tariffs" data-testid="tab-electricity-tariffs">Electricity Tariffs</TabsTrigger>
          <TabsTrigger value="wallet" data-testid="tab-wallet-settings">Wallet</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="otp-security" data-testid="tab-otp-security">OTP / Login Security</TabsTrigger>}
        </TabsList>
        <TabsContent value="general"><GeneralTab canEdit={canEdit} /></TabsContent>
        <TabsContent value="sla"><SLATab canEdit={canEdit} /></TabsContent>
        <TabsContent value="routing"><RoutingTab canEdit={canEdit} /></TabsContent>
        <TabsContent value="notifications"><NotificationsTab /></TabsContent>
        <TabsContent value="integrations"><IntegrationsTab /></TabsContent>
        <TabsContent value="kyc-gate"><KycGateTab canEdit={canEdit} /></TabsContent>
        <TabsContent value="electricity-tariffs"><ElectricityTariffsTab canEdit={canEditElectricity} /></TabsContent>
        <TabsContent value="wallet"><WalletConfigTab canEdit={canEdit} /></TabsContent>
        {isSuperAdmin && <TabsContent value="otp-security"><OtpSecurityTab /></TabsContent>}
      </Tabs>
    </>
  );
}
