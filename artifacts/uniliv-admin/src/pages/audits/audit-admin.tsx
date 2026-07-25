import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldOff, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  fmtDateTime,
  type ApiOne, type PerformanceBand,
} from "./lib";

/**
 * Audit Admin console (PRD v1.0 trim): Role Grants (the access backbone),
 * performance Bands (rating-band thresholds) and module Settings. Rating
 * scales are defined per template in the builder; the removed config tabs
 * (SLA, notification rules, attachments, candidates, toggles, master data,
 * numbering, trail) belonged to subsystems retired from the product.
 */

type ApiList<T> = { success: boolean; data: T[]; meta?: { total: number } };

const AUDIT_TYPES = ["UL", "CM", "CX"] as const;
const MODULE_ROLES = ["ADMIN", "SCHEDULER", "AUDITOR", "AUDITEE", "REVIEWER", "VIEWER"] as const;
const SCOPE_LEVELS = ["GLOBAL", "ZONE", "CITY", "CLUSTER", "PROPERTY"] as const;

interface Grant {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userRole: string | null;
  moduleRole: (typeof MODULE_ROLES)[number];
  auditTypes: string[];
  scopeLevel: (typeof SCOPE_LEVELS)[number];
  zoneId: string | null;
  cityId: string | null;
  clusterId: string | null;
  propertyId: string | null;
  effectiveFrom: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface OrgNodes {
  zones: { id: string; name: string }[];
  cities: { id: string; name: string }[];
  clusters: { id: string; name: string }[];
  properties: { id: string; name: string }[];
}

function grantStatus(g: Grant): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (g.revokedAt) return { label: "REVOKED", variant: "destructive" };
  if (g.expiresAt && new Date(g.expiresAt) < new Date()) return { label: "EXPIRED", variant: "secondary" };
  if (new Date(g.effectiveFrom) > new Date()) return { label: "PENDING", variant: "secondary" };
  return { label: "ACTIVE", variant: "default" };
}

function nodeName(g: Grant, nodes?: OrgNodes): string {
  if (g.scopeLevel === "GLOBAL") return "Global";
  const find = (list: { id: string; name: string }[] | undefined, id: string | null) =>
    (id && list?.find((n) => n.id === id)?.name) || id || "—";
  if (g.scopeLevel === "ZONE") return `Zone · ${find(nodes?.zones, g.zoneId)}`;
  if (g.scopeLevel === "CITY") return `City · ${find(nodes?.cities, g.cityId)}`;
  if (g.scopeLevel === "CLUSTER") return `Cluster · ${find(nodes?.clusters, g.clusterId)}`;
  return `Property · ${find(nodes?.properties, g.propertyId)}`;
}

/* ── Grants tab ────────────────────────────────────────────────────────────── */

function GrantsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);

  const grantsQuery = useQuery({
    queryKey: ["/audit/admin/grants"],
    queryFn: () => apiFetch<ApiList<Grant>>("/audit/admin/grants?limit=100"),
  });
  const nodesQuery = useQuery({
    queryKey: ["/audit/admin/org-nodes"],
    queryFn: () => apiFetch<{ success: boolean; data: OrgNodes }>("/audit/admin/org-nodes"),
  });
  const usersQuery = useQuery({
    queryKey: ["/users", "grant-picker"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string; email: string; role: string }>>("/users?limit=100"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/audit/admin/grants/${id}/revoke`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      toast({ title: "Grant revoked" });
      qc.invalidateQueries({ queryKey: ["/audit/admin/grants"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Revoke failed", variant: "destructive" }),
  });

  // Create-grant form state (controlled; small enough not to need RHF).
  const [form, setForm] = React.useState({
    userId: "",
    moduleRole: "AUDITOR" as (typeof MODULE_ROLES)[number],
    auditTypes: ["UL"] as string[],
    scopeLevel: "PROPERTY" as (typeof SCOPE_LEVELS)[number],
    nodeId: "",
    expiresAt: "",
  });

  const nodeOptions = React.useMemo(() => {
    const nodes = nodesQuery.data?.data;
    if (!nodes) return [];
    switch (form.scopeLevel) {
      case "ZONE": return nodes.zones;
      case "CITY": return nodes.cities;
      case "CLUSTER": return nodes.clusters;
      case "PROPERTY": return nodes.properties;
      default: return [];
    }
  }, [nodesQuery.data, form.scopeLevel]);

  const createMut = useMutation({
    mutationFn: () => {
      const nodeField =
        form.scopeLevel === "ZONE" ? "zoneId"
        : form.scopeLevel === "CITY" ? "cityId"
        : form.scopeLevel === "CLUSTER" ? "clusterId"
        : form.scopeLevel === "PROPERTY" ? "propertyId"
        : null;
      return apiFetch("/audit/admin/grants", {
        method: "POST",
        body: JSON.stringify({
          userId: form.userId,
          moduleRole: form.moduleRole,
          auditTypes: form.auditTypes,
          scopeLevel: form.scopeLevel,
          ...(nodeField ? { [nodeField]: form.nodeId } : {}),
          ...(form.expiresAt ? { expiresAt: form.expiresAt } : {}),
        }),
      });
    },
    onSuccess: () => {
      toast({ title: "Grant created" });
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["/audit/admin/grants"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Create failed", variant: "destructive" }),
  });

  const canSave =
    form.userId &&
    form.auditTypes.length > 0 &&
    (form.scopeLevel === "GLOBAL" || form.nodeId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Module-role grants scoped by org node and audit type (UL/CM/CX). Super
          Admin and Operations Excellence are implicitly global and need no rows.
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="mr-1 h-4 w-4" /> New grant
        </Button>
      </div>

      {grantsQuery.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Module role</TableHead>
                <TableHead>Audit types</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(grantsQuery.data?.data ?? []).map((g) => {
                const status = grantStatus(g);
                return (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="font-medium">{g.userName ?? g.userId}</div>
                      <div className="text-xs text-muted-foreground">{g.userRole?.replace(/_/g, " ")}</div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{g.moduleRole}</Badge></TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {g.auditTypes.map((t) => (
                          <Badge key={t} variant="secondary">{t}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{nodeName(g, nodesQuery.data?.data)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(g.effectiveFrom).toLocaleDateString("en-IN")}
                      {" → "}
                      {g.expiresAt ? new Date(g.expiresAt).toLocaleDateString("en-IN") : "∞"}
                    </TableCell>
                    <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                    <TableCell>
                      {!g.revokedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revokeMut.mutate(g.id)}
                          disabled={revokeMut.isPending}
                        >
                          <ShieldOff className="mr-1 h-3.5 w-3.5" /> Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(grantsQuery.data?.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No grants yet — seed defaults arrive with the audit seed, or create one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <FormModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New role grant"
        onSave={() => createMut.mutate()}
        isSaving={createMut.isPending}
        saveLabel="Create grant"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>User</Label>
            <Select value={form.userId} onValueChange={(v) => setForm((f) => ({ ...f, userId: v }))}>
              <SelectTrigger><SelectValue placeholder="Pick a user" /></SelectTrigger>
              <SelectContent>
                {(usersQuery.data?.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} · {u.role.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Module role</Label>
            <Select
              value={form.moduleRole}
              onValueChange={(v) => setForm((f) => ({ ...f, moduleRole: v as (typeof MODULE_ROLES)[number] }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODULE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Audit types</Label>
            <div className="flex gap-4">
              {AUDIT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.auditTypes.includes(t)}
                    onCheckedChange={(checked) =>
                      setForm((f) => ({
                        ...f,
                        auditTypes: checked
                          ? [...f.auditTypes, t]
                          : f.auditTypes.filter((x) => x !== t),
                      }))
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Scope level</Label>
            <Select
              value={form.scopeLevel}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, scopeLevel: v as (typeof SCOPE_LEVELS)[number], nodeId: "" }))
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCOPE_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.scopeLevel !== "GLOBAL" && (
            <div className="space-y-2">
              <Label>{form.scopeLevel.charAt(0) + form.scopeLevel.slice(1).toLowerCase()}</Label>
              <Select value={form.nodeId} onValueChange={(v) => setForm((f) => ({ ...f, nodeId: v }))}>
                <SelectTrigger><SelectValue placeholder={`Pick a ${form.scopeLevel.toLowerCase()}`} /></SelectTrigger>
                <SelectContent>
                  {nodeOptions.map((n) => (
                    <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Expires (optional)</Label>
            <Input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
          </div>

          {!canSave && (
            <p className="text-xs text-muted-foreground">
              Pick a user, at least one audit type, and an org node (unless Global).
            </p>
          )}
        </div>
      </FormModal>
    </div>
  );
}

/* ── Performance Bands tab (FR-AD-03) ──────────────────────────────────────── */

interface BandDraft {
  label: string;
  minPct: string;
  maxPct: string;
  color: string;
}

function BandsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const bandsQuery = useQuery({
    queryKey: ["/audit/admin/performance-bands"],
    queryFn: () => apiFetch<ApiList<PerformanceBand>>("/audit/admin/performance-bands"),
  });

  const [rows, setRows] = React.useState<BandDraft[] | null>(null);
  const serverRows = bandsQuery.data?.data;

  React.useEffect(() => {
    if (!serverRows || rows !== null) return;
    setRows(
      [...serverRows]
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((b) => ({
          label: b.label,
          minPct: String(Number(b.minPct)),
          maxPct: String(Number(b.maxPct)),
          color: b.color ?? "",
        })),
    );
  }, [serverRows, rows]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiFetch("/audit/admin/performance-bands", {
        method: "PUT",
        body: JSON.stringify({
          bands: (rows ?? []).map((b) => ({
            label: b.label.trim(),
            minPct: Number(b.minPct),
            maxPct: Number(b.maxPct),
            color: b.color.trim() || null,
          })),
        }),
      }),
    onSuccess: () => {
      toast({ title: "Performance bands saved" });
      setRows(null); // re-hydrate from server
      qc.invalidateQueries({ queryKey: ["/audit/admin/performance-bands"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const setRow = (i: number, patch: Partial<BandDraft>) =>
    setRows((r) => (r ?? []).map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Score → label mapping shown on reports (e.g. Excellent / Good / Poor).
        Bands must be contiguous — each min = previous max + 0.01 — and cover
        0–100. The full set saves atomically.
      </p>

      {bandsQuery.isLoading || rows === null ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead className="w-28">Min %</TableHead>
                  <TableHead className="w-28">Max %</TableHead>
                  <TableHead className="w-32">Color</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Input value={b.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        className="tabular-nums"
                        value={b.minPct}
                        onChange={(e) => setRow(i, { minPct: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        className="tabular-nums"
                        value={b.maxPct}
                        onChange={(e) => setRow(i, { maxPct: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        placeholder="#16a34a"
                        value={b.color}
                        onChange={(e) => setRow(i, { color: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0"
                        onClick={() => setRows((r) => (r ?? []).filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No bands — scores render without a label until bands exist.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const last = rows[rows.length - 1];
                const nextMin = last ? (Number(last.maxPct) + 0.01).toFixed(2) : "0";
                setRows((r) => [...(r ?? []), { label: "", minPct: nextMin, maxPct: "100", color: "" }]);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> Add band
            </Button>
            <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
              <Save className="mr-1 h-4 w-4" /> Save all
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Settings tab ──────────────────────────────────────────────────────────── */

const SETTING_DEFS: { key: string; label: string; description: string; type: "boolean" | "number" | "string"; fallback: unknown }[] = [
  { key: "na_counts_against", label: "N/A counts against score", description: "Default OFF: N/A answers are excluded from numerator and denominator (D-1).", type: "boolean", fallback: false },
  { key: "lookahead_days", label: "Recurrence look-ahead (days)", description: "How far ahead the materializer creates Upcoming audits.", type: "number", fallback: 7 },
  { key: "auto_close_days", label: "Auto-close delay (days)", description: "Days after approval before the audit auto-closes. 0 = immediate.", type: "number", fallback: 0 },
  { key: "report_share_ttl_hours", label: "Report share link TTL (hours)", description: "Expiry for signed report share links (D-5).", type: "number", fallback: 72 },
  { key: "org_timezone", label: "Org timezone", description: "Rendering timezone for reports and dashboards (NFR-07).", type: "string", fallback: "Asia/Kolkata" },
];

function SettingRow({ def, value }: { def: (typeof SETTING_DEFS)[number]; value: unknown }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<unknown>(value ?? def.fallback);
  React.useEffect(() => setDraft(value ?? def.fallback), [value, def.fallback]);

  const saveMut = useMutation({
    mutationFn: (v: unknown) =>
      apiFetch(`/audit/admin/settings/${def.key}`, {
        method: "PUT",
        body: JSON.stringify({ value: v }),
      }),
    onSuccess: () => {
      toast({ title: `${def.label} saved` });
      qc.invalidateQueries({ queryKey: ["/audit/admin/settings"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  return (
    <div className="flex flex-col gap-2 border-b py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <p className="text-sm font-medium">{def.label}</p>
        <p className="text-xs text-muted-foreground">{def.description}</p>
      </div>
      <div className="flex items-center gap-2">
        {def.type === "boolean" ? (
          <Switch
            checked={Boolean(draft)}
            onCheckedChange={(checked) => {
              setDraft(checked);
              saveMut.mutate(checked);
            }}
          />
        ) : (
          <>
            <Input
              className="w-40"
              type={def.type === "number" ? "number" : "text"}
              value={String(draft ?? "")}
              onChange={(e) =>
                setDraft(def.type === "number" ? Number(e.target.value) : e.target.value)
              }
            />
            <Button size="sm" variant="outline" onClick={() => saveMut.mutate(draft)} disabled={saveMut.isPending}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SettingsTab() {
  const query = useQuery({
    queryKey: ["/audit/admin/settings"],
    queryFn: () => apiFetch<ApiList<{ key: string; valueJson: unknown }>>("/audit/admin/settings"),
  });
  const values = new Map((query.data?.data ?? []).map((r) => [r.key, r.valueJson]));

  return (
    <Card>
      <CardContent className="pt-2">
        {query.isLoading ? (
          <Skeleton className="my-4 h-64 w-full" />
        ) : (
          SETTING_DEFS.map((def) => (
            <SettingRow key={def.key} def={def} value={values.get(def.key)} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function AuditAdmin() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Settings"
        subtitle="Role grants, rating bands and module settings — every change is recorded in the immutable audit log."
        breadcrumbs={[{ label: "Audits" }, { label: "Settings" }]}
      />
      <Tabs defaultValue="grants">
        <TabsList>
          <TabsTrigger value="grants">Role Grants</TabsTrigger>
          <TabsTrigger value="bands">Bands</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="grants" className="mt-4">
          <GrantsTab />
        </TabsContent>
        <TabsContent value="bands" className="mt-4">
          <BandsTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
