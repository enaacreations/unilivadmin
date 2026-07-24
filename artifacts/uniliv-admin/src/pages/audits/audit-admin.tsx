import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Building2, Database, Pencil, Plus, RefreshCw,
  ShieldOff, Save, Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  fmtDateTime,
  type ApiOne, type FeatureToggles, type MasterData, type PerformanceBand,
  type RatingScale, type WeightMode,
} from "./lib";
import { TrailExplorerPanel } from "./trail-explorer";

/**
 * Audit & Inspection — admin console hub (FA-16). P1 ships the tabs every
 * later feature reads: Role Grants (FR-AD-01), Numbering (FR-AD-06) and module
 * Settings. Rating scales/bands (P2), attachment policy (P3), SLA/notification
 * rules/timers/bank candidates (P4) and master data (P5) join as they land.
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

/* ── Rating Scales tab (FR-AD-02) ──────────────────────────────────────────── */

interface ScaleOptionDraft {
  label: string;
  multiplierPct: string;
  color: string;
  isExcludedNa: boolean;
}

function RatingScalesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const scalesQuery = useQuery({
    queryKey: ["/audit/admin/rating-scales"],
    queryFn: () => apiFetch<ApiList<RatingScale>>("/audit/admin/rating-scales"),
  });

  const [editing, setEditing] = React.useState<RatingScale | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<{ name: string; active: boolean; options: ScaleOptionDraft[] }>({
    name: "",
    active: true,
    options: [],
  });

  const openEditor = (scale: RatingScale | null) => {
    setEditing(scale);
    setDraft(
      scale
        ? {
            name: scale.name,
            active: scale.active,
            options: [...scale.options]
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .map((o) => ({
                label: o.label,
                multiplierPct: String(Number(o.multiplierPct)),
                color: o.color ?? "",
                isExcludedNa: o.isExcludedNa,
              })),
          }
        : {
            name: "",
            active: true,
            options: [
              { label: "Good", multiplierPct: "100", color: "", isExcludedNa: false },
              { label: "Poor", multiplierPct: "0", color: "", isExcludedNa: false },
            ],
          },
    );
    setModalOpen(true);
  };

  const setOption = (i: number, patch: Partial<ScaleOptionDraft>) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    }));

  const moveOption = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.options.length) return d;
      const options = [...d.options];
      [options[i], options[j]] = [options[j]!, options[i]!];
      return { ...d, options };
    });

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        active: draft.active,
        options: draft.options.map((o, i) => ({
          label: o.label.trim(),
          color: o.color.trim() || null,
          orderIndex: i,
          multiplierPct: Number(o.multiplierPct),
          isExcludedNa: o.isExcludedNa,
        })),
      };
      return editing
        ? apiFetch(`/audit/admin/rating-scales/${editing.id}`, { method: "PUT", body: JSON.stringify(body) })
        : apiFetch("/audit/admin/rating-scales", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: editing ? "Scale updated" : "Scale created" });
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ["/audit/admin/rating-scales"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const canSave =
    draft.name.trim() &&
    draft.options.length > 0 &&
    draft.options.every((o) => o.label.trim() && o.multiplierPct !== "" && !Number.isNaN(Number(o.multiplierPct)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          RATING questions score answer × multiplier. Published template versions
          keep their frozen snapshot — edits here affect future publishes only.
        </p>
        <Button size="sm" onClick={() => openEditor(null)}>
          <Plus className="mr-1 h-4 w-4" /> New scale
        </Button>
      </div>

      {scalesQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(scalesQuery.data?.data ?? []).map((scale) => (
            <Card key={scale.id}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    {scale.name}
                    {scale.active ? (
                      <Badge>Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => openEditor(scale)}>
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {[...scale.options]
                    .sort((a, b) => a.orderIndex - b.orderIndex)
                    .map((o) => (
                      <Badge key={o.id} variant="outline" className="tabular-nums">
                        {o.label} · {Number(o.multiplierPct)}%
                        {o.isExcludedNa && <span className="ml-1 text-muted-foreground">(N/A)</span>}
                      </Badge>
                    ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {(scalesQuery.data?.data ?? []).length === 0 && (
            <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
              No rating scales yet — templates need one before RATING questions can score.
            </p>
          )}
        </div>
      )}

      <FormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={editing ? `Edit scale — ${editing.name}` : "New rating scale"}
        onSave={() => {
          if (!canSave) {
            toast({ title: "Every option needs a label and multiplier %", variant: "destructive" });
            return;
          }
          saveMut.mutate();
        }}
        isSaving={saveMut.isPending}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">The active scale backs new RATING questions.</p>
            </div>
            <Switch
              checked={draft.active}
              onCheckedChange={(c) => setDraft((d) => ({ ...d, active: c }))}
            />
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            <div className="space-y-2">
              {draft.options.map((o, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded-md border p-2">
                  <div className="flex flex-col">
                    <Button
                      variant="ghost" size="sm" className="h-5 w-5 p-0"
                      disabled={i === 0}
                      onClick={() => moveOption(i, -1)}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="h-5 w-5 p-0"
                      disabled={i === draft.options.length - 1}
                      onClick={() => moveOption(i, 1)}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="grid flex-1 grid-cols-[1fr_72px_88px] gap-1.5">
                    <Input
                      placeholder="Label"
                      value={o.label}
                      onChange={(e) => setOption(i, { label: e.target.value })}
                    />
                    <Input
                      type="number"
                      placeholder="%"
                      value={o.multiplierPct}
                      onChange={(e) => setOption(i, { multiplierPct: e.target.value })}
                    />
                    <Input
                      placeholder="Color"
                      value={o.color}
                      onChange={(e) => setOption(i, { color: e.target.value })}
                    />
                  </div>
                  <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                    <Switch
                      checked={o.isExcludedNa}
                      onCheckedChange={(c) => setOption(i, { isExcludedNa: c })}
                    />
                    N/A
                  </label>
                  <Button
                    variant="ghost" size="sm" className="h-7 w-7 p-0"
                    onClick={() => setDraft((d) => ({ ...d, options: d.options.filter((_, j) => j !== i) }))}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  options: [...d.options, { label: "", multiplierPct: "0", color: "", isExcludedNa: false }],
                }))
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add option
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            N/A options are excluded from scoring by default (D-1). Published
            versions keep their snapshot of this scale.
          </p>
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

/* ── Numbering tab (FR-AD-06) ──────────────────────────────────────────────── */

interface NumberingScheme {
  objectType: string;
  prefix: string;
  pattern: string;
  nextSeq: number;
  padWidth: number | null;
}

const NUMBERING_DEFAULTS: NumberingScheme[] = [
  { objectType: "AUDIT", prefix: "UNI-AUD", pattern: "{prefix}-{seq}", nextSeq: 4500, padWidth: null },
  { objectType: "NC", prefix: "UNI-NC", pattern: "{prefix}-{seq}", nextSeq: 1, padWidth: null },
  { objectType: "REPORT", prefix: "UNI-RPT", pattern: "{prefix}-{seq}", nextSeq: 1, padWidth: null },
];

function NumberingCard({ scheme, saved }: { scheme: NumberingScheme; saved: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(scheme);
  React.useEffect(() => setDraft(scheme), [scheme]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/admin/numbering/${scheme.objectType}`, {
        method: "PUT",
        body: JSON.stringify({
          prefix: draft.prefix,
          pattern: draft.pattern,
          nextSeq: Number(draft.nextSeq),
          padWidth: draft.padWidth ? Number(draft.padWidth) : undefined,
        }),
      }),
    onSuccess: () => {
      toast({ title: `${scheme.objectType} numbering saved` });
      qc.invalidateQueries({ queryKey: ["/audit/admin/numbering"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const preview = draft.pattern
    .replace("{prefix}", draft.prefix)
    .replace("{seq}", draft.padWidth ? String(draft.nextSeq).padStart(draft.padWidth, "0") : String(draft.nextSeq));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          {scheme.objectType}
          {!saved && <Badge variant="secondary">not configured</Badge>}
        </CardTitle>
        <CardDescription>
          Next: <span className="font-mono tabular-nums">{preview}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Prefix</Label>
            <Input value={draft.prefix} onChange={(e) => setDraft((d) => ({ ...d, prefix: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Pattern</Label>
            <Input value={draft.pattern} onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Next sequence</Label>
            <Input
              type="number"
              min={1}
              value={draft.nextSeq}
              onChange={(e) => setDraft((d) => ({ ...d, nextSeq: Number(e.target.value) }))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Pad width (optional)</Label>
            <Input
              type="number"
              min={0}
              value={draft.padWidth ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, padWidth: e.target.value ? Number(e.target.value) : null }))}
            />
          </div>
        </div>
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          <Save className="mr-1 h-3.5 w-3.5" /> Save
        </Button>
      </CardContent>
    </Card>
  );
}

function NumberingTab() {
  const query = useQuery({
    queryKey: ["/audit/admin/numbering"],
    queryFn: () => apiFetch<ApiList<NumberingScheme>>("/audit/admin/numbering"),
  });
  const rows = query.data?.data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Human-readable numbers per object type, e.g. <span className="font-mono">UNI-AUD-4501</span>.
        Changing a scheme affects future objects only.
      </p>
      {query.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {NUMBERING_DEFAULTS.map((d) => {
            const existing = rows.find((r) => r.objectType === d.objectType);
            return (
              <NumberingCard
                key={d.objectType}
                scheme={existing ?? d}
                saved={Boolean(existing)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Settings tab ──────────────────────────────────────────────────────────── */

const SETTING_DEFS: { key: string; label: string; description: string; type: "boolean" | "number" | "string"; fallback: unknown }[] = [
  { key: "na_counts_against", label: "N/A counts against score", description: "Default OFF: N/A answers are excluded from numerator and denominator (D-1).", type: "boolean", fallback: false },
  { key: "publish_co_approval_required", label: "Publish co-approval", description: "Require a second approver before a template version publishes (FR-TM-04).", type: "boolean", fallback: false },
  { key: "lookahead_days", label: "Recurrence look-ahead (days)", description: "How far ahead the materializer creates Upcoming audits.", type: "number", fallback: 7 },
  { key: "auto_close_days", label: "Auto-close delay (days)", description: "Days after approval (with all NCs resolved) before auto-close. 0 = immediate.", type: "number", fallback: 0 },
  { key: "adhoc_default_weight", label: "Ad-hoc item weight", description: "Fixed weight for auditor-added items — not editable in the field (D-6).", type: "number", fallback: 3 },
  { key: "manual_nudge_per_hour", label: "Manual nudges per hour", description: "Rate limit for manual reminders per audit (FRD-NTF-04).", type: "number", fallback: 1 },
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

/* ── Severity & SLA tab (FR-AD-03) ─────────────────────────────────────────── */

interface EscalationStep { trigger: "ON_RAISE" | "PCT_ELAPSED" | "ON_BREACH"; pct?: number; audience: string }
interface SeveritySla {
  id: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  capaDueHours: number;
  reminderLeadHours: number;
  escalationChainJson: EscalationStep[];
}
const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
const AUDIENCES = ["REVIEWERS", "OWNER_MANAGER", "REGION_HEAD"] as const;
const TRIGGERS = ["ON_RAISE", "PCT_ELAPSED", "ON_BREACH"] as const;

function SlaCard({ sla }: { sla: SeveritySla }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<SeveritySla>(sla);
  React.useEffect(() => setDraft(sla), [sla]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/admin/severity-slas/${draft.severity}`, {
        method: "PUT",
        body: JSON.stringify({
          capaDueHours: Number(draft.capaDueHours),
          reminderLeadHours: Number(draft.reminderLeadHours),
          escalationChainJson: draft.escalationChainJson,
        }),
      }),
    onSuccess: () => {
      toast({ title: `${draft.severity} SLA saved` });
      qc.invalidateQueries({ queryKey: ["/audit/admin/severity-slas"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const setStep = (i: number, patch: Partial<EscalationStep>) =>
    setDraft((d) => ({ ...d, escalationChainJson: d.escalationChainJson.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }));

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">{sla.severity}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">CAPA due (hours)</Label>
            <Input type="number" min={1} value={draft.capaDueHours} onChange={(e) => setDraft((d) => ({ ...d, capaDueHours: Number(e.target.value) }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Reminder lead (hours)</Label>
            <Input type="number" min={0} value={draft.reminderLeadHours} onChange={(e) => setDraft((d) => ({ ...d, reminderLeadHours: Number(e.target.value) }))} />
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Escalation chain</Label>
          {draft.escalationChainJson.map((step, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select value={step.trigger} onValueChange={(v) => setStep(i, { trigger: v as EscalationStep["trigger"] })}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>{TRIGGERS.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
              {step.trigger === "PCT_ELAPSED" && (
                <Input type="number" min={1} max={100} className="w-20" value={step.pct ?? 50} onChange={(e) => setStep(i, { pct: Number(e.target.value) })} />
              )}
              <Select value={step.audience} onValueChange={(v) => setStep(i, { audience: v })}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{AUDIENCES.map((a) => <SelectItem key={a} value={a}>{a.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDraft((d) => ({ ...d, escalationChainJson: d.escalationChainJson.filter((_, idx) => idx !== i) }))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, escalationChainJson: [...d.escalationChainJson, { trigger: "ON_BREACH", audience: "REVIEWERS" }] }))}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add step
          </Button>
        </div>
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}><Save className="mr-1 h-3.5 w-3.5" /> Save</Button>
      </CardContent>
    </Card>
  );
}

function SlaTab() {
  const query = useQuery({
    queryKey: ["/audit/admin/severity-slas"],
    queryFn: () => apiFetch<{ success: boolean; data: SeveritySla[] }>("/audit/admin/severity-slas"),
  });
  const rows = query.data?.data ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Per-severity CAPA due windows, reminder lead time and escalation chains. Template/org overrides can be layered later.</p>
      {query.isLoading ? <Skeleton className="h-64 w-full" /> : (
        <div className="grid gap-4 md:grid-cols-3">
          {SEVERITIES.map((sev) => {
            const existing = rows.find((r) => r.severity === sev);
            return <SlaCard key={sev} sla={existing ?? { id: sev, severity: sev, capaDueHours: sev === "CRITICAL" ? 48 : sev === "MAJOR" ? 168 : 720, reminderLeadHours: 12, escalationChainJson: [] }} />;
          })}
        </div>
      )}
    </div>
  );
}

/* ── Notification rules tab (FR-AD-04) ─────────────────────────────────────── */

interface NotificationRule {
  id: string;
  eventKey: string;
  channelsJson: string[];
  audienceJson: string[];
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  active: boolean;
}
const CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;

function NotificationRulesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<NotificationRule | null>(null);

  const query = useQuery({
    queryKey: ["/audit/admin/notification-rules"],
    queryFn: () => apiFetch<{ success: boolean; data: NotificationRule[] }>("/audit/admin/notification-rules"),
  });
  const rules = query.data?.data ?? [];

  const saveMut = useMutation({
    mutationFn: (r: NotificationRule) =>
      apiFetch(`/audit/admin/notification-rules/${r.eventKey}`, {
        method: "PUT",
        body: JSON.stringify({
          channelsJson: r.channelsJson, audienceJson: r.audienceJson,
          subjectTemplate: r.subjectTemplate, bodyTemplate: r.bodyTemplate, active: r.active,
        }),
      }),
    onSuccess: () => { toast({ title: "Rule saved" }); setEditing(null); qc.invalidateQueries({ queryKey: ["/audit/admin/notification-rules"] }); },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });
  const testMut = useMutation({
    mutationFn: (eventKey: string) => apiFetch(`/audit/admin/notification-rules/${eventKey}/test-send`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => toast({ title: "Test notification sent to you" }),
    onError: (e: Error) => toast({ title: e.message || "Test failed", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Which channels and audiences fire per event. In-app is always available; WhatsApp is a fast-follow (D-5).</p>
      {query.isLoading ? <Skeleton className="h-64 w-full" /> : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead><TableHead>Channels</TableHead><TableHead>Audience</TableHead>
                <TableHead>Active</TableHead><TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.eventKey}</TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{r.channelsJson.map((c) => <Badge key={c} variant="outline">{c}</Badge>)}</div></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.audienceJson.join(", ")}</TableCell>
                  <TableCell><Badge variant={r.active ? "default" : "secondary"}>{r.active ? "on" : "off"}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(r)}><Pencil className="mr-1 h-3.5 w-3.5" /> Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => testMut.mutate(r.eventKey)} disabled={testMut.isPending}>Test</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FormModal
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.eventKey ?? ""}
        onSave={() => editing && saveMut.mutate(editing)}
        isSaving={saveMut.isPending}
      >
        {editing && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Channels</Label>
              <div className="flex gap-4">
                {CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={editing.channelsJson.includes(c)}
                      onCheckedChange={(v) => setEditing((e) => e && ({ ...e, channelsJson: v ? [...e.channelsJson, c] : e.channelsJson.filter((x) => x !== c) }))}
                    />
                    {c}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox checked={false} disabled /> WhatsApp (soon)
                </label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Audience (comma-separated)</Label>
              <Input value={editing.audienceJson.join(", ")} onChange={(e) => setEditing((prev) => prev && ({ ...prev, audienceJson: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            </div>
            <div className="space-y-2">
              <Label>Subject template</Label>
              <Input value={editing.subjectTemplate ?? ""} onChange={(e) => setEditing((prev) => prev && ({ ...prev, subjectTemplate: e.target.value }))} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editing.active} onCheckedChange={(v) => setEditing((prev) => prev && ({ ...prev, active: v }))} />
              <Label>Active</Label>
            </div>
          </div>
        )}
      </FormModal>
    </div>
  );
}

/* ── Attachment policies tab (FR-AD-05) ────────────────────────────────────── */

interface PolicyRow { id: string; level: string; maxFiles: number; maxSizeMb: number; allowedMimeJson: string[] }
const POLICY_LEVELS = ["AUDIT", "RESPONSE", "NC", "CAPA", "SUBMISSION"] as const;

function PolicyRowEditor({ policy }: { policy: PolicyRow }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(policy);
  React.useEffect(() => setDraft(policy), [policy]);
  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/audit/admin/attachment-policies/${draft.level}`, {
      method: "PUT",
      body: JSON.stringify({ maxFiles: Number(draft.maxFiles), maxSizeMb: Number(draft.maxSizeMb), allowedMimeJson: draft.allowedMimeJson }),
    }),
    onSuccess: () => { toast({ title: `${draft.level} policy saved` }); qc.invalidateQueries({ queryKey: ["/audit/admin/attachment-policies"] }); },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });
  return (
    <TableRow>
      <TableCell className="font-medium">{draft.level}</TableCell>
      <TableCell><Input type="number" min={1} max={20} className="w-20" value={draft.maxFiles} onChange={(e) => setDraft((d) => ({ ...d, maxFiles: Number(e.target.value) }))} /></TableCell>
      <TableCell><Input type="number" min={1} max={100} className="w-20" value={draft.maxSizeMb} onChange={(e) => setDraft((d) => ({ ...d, maxSizeMb: Number(e.target.value) }))} /></TableCell>
      <TableCell><Input className="w-72" value={draft.allowedMimeJson.join(", ")} onChange={(e) => setDraft((d) => ({ ...d, allowedMimeJson: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))} /></TableCell>
      <TableCell><Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>Save</Button></TableCell>
    </TableRow>
  );
}

function AttachmentPoliciesTab() {
  const query = useQuery({
    queryKey: ["/audit/admin/attachment-policies"],
    queryFn: () => apiFetch<{ success: boolean; data: PolicyRow[] }>("/audit/admin/attachment-policies"),
  });
  const rows = query.data?.data ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Per-level upload limits, enforced on the server at upload.</p>
      {query.isLoading ? <Skeleton className="h-56 w-full" /> : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Level</TableHead><TableHead>Max files</TableHead><TableHead>Max MB</TableHead><TableHead>Allowed MIME</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {POLICY_LEVELS.map((level) => {
                const existing = rows.find((r) => r.level === level);
                return <PolicyRowEditor key={level} policy={existing ?? { id: level, level, maxFiles: 5, maxSizeMb: 25, allowedMimeJson: ["image/jpeg", "image/png"] }} />;
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ── Bank candidates tab (D-4) ─────────────────────────────────────────────── */

interface BankCandidate {
  id: string;
  prompt: string;
  type: string;
  proposerName: string | null;
  ticketNo: string | null;
  status: string;
  createdAt: string;
}

function BankCandidatesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["/audit/admin/bank-candidates"],
    queryFn: () => apiFetch<{ success: boolean; data: BankCandidate[] }>("/audit/admin/bank-candidates?status=PENDING"),
  });
  const rows = query.data?.data ?? [];
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "reject" }) =>
      apiFetch(`/audit/admin/bank-candidates/${id}/${action}`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_d, v) => { toast({ title: v.action === "accept" ? "Added to question bank" : "Candidate rejected" }); qc.invalidateQueries({ queryKey: ["/audit/admin/bank-candidates"] }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Ad-hoc items proposed by auditors during execution (D-4) — accept promotes them into the question bank.</p>
      {query.isLoading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No pending candidates. Ad-hoc items proposed by auditors appear here.</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Prompt</TableHead><TableHead>Type</TableHead><TableHead>Proposed by</TableHead><TableHead>From</TableHead><TableHead className="w-44" /></TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-md">{c.prompt}</TableCell>
                  <TableCell><Badge variant="outline">{c.type}</Badge></TableCell>
                  <TableCell className="text-sm">{c.proposerName ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{c.ticketNo ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => decide.mutate({ id: c.id, action: "accept" })} disabled={decide.isPending}>Accept</Button>
                      <Button variant="ghost" size="sm" onClick={() => decide.mutate({ id: c.id, action: "reject" })} disabled={decide.isPending}>Reject</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ── Feature Toggles tab ───────────────────────────────────────────────────── */

const TOGGLE_DEFS: { key: keyof FeatureToggles; label: string; description: string }[] = [
  { key: "show_weightage", label: "Show weightage", description: "Display per-question weights in the runner and reports." },
  { key: "score_display", label: "Show scores", description: "Surface provisional and frozen scores to auditors." },
  { key: "show_priority_column", label: "Priority column", description: "Add a priority column to the audit register and queues." },
  { key: "verify_stage_default", label: "Verify stage by default", description: "New templates require reviewer verification of findings by default." },
  { key: "allow_reopen", label: "Allow reopen", description: "Let reviewers reopen an approved/closed audit." },
  { key: "zero_tolerance_default", label: "Zero-tolerance default", description: "Any critical NC forces a FAIL by default on new templates." },
  { key: "create_form_show_description", label: "Create form — description", description: "Show the description field on the New Audit form." },
  { key: "create_form_show_assignee", label: "Create form — assignee", description: "Show the assignee picker on the New Audit form." },
  { key: "create_form_show_schedule", label: "Create form — schedule", description: "Show the schedule fields on the New Audit form." },
];

function FeatureTogglesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["/audit/admin/feature-toggles"],
    queryFn: () => apiFetch<ApiOne<FeatureToggles>>("/audit/admin/feature-toggles"),
  });
  const toggles = query.data?.data;

  const saveMut = useMutation({
    mutationFn: (patch: Partial<FeatureToggles>) =>
      apiFetch("/audit/admin/feature-toggles", { method: "PUT", body: JSON.stringify(patch) }),
    // Optimistic: patch the cache, roll back on error.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ["/audit/admin/feature-toggles"] });
      const prev = qc.getQueryData<ApiOne<FeatureToggles>>(["/audit/admin/feature-toggles"]);
      if (prev) {
        qc.setQueryData<ApiOne<FeatureToggles>>(["/audit/admin/feature-toggles"], {
          ...prev,
          data: { ...prev.data, ...patch },
        });
      }
      return { prev };
    },
    onError: (e: Error, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(["/audit/admin/feature-toggles"], ctx.prev);
      toast({ title: e.message || "Save failed", variant: "destructive" });
    },
    onSuccess: () => toast({ title: "Feature toggle saved" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["/audit/admin/feature-toggles"] }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Module-wide feature switches. Changes save immediately and apply to new
        activity; frozen audits/reports keep the settings they were run under.
      </p>
      {query.isLoading || !toggles ? (
        <Skeleton className="h-80 w-full" />
      ) : (
        <Card>
          <CardContent className="pt-2">
            {/* Weight mode segmented control */}
            <div className="flex flex-col gap-2 border-b py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-xl">
                <p className="text-sm font-medium">Weight display mode</p>
                <p className="text-xs text-muted-foreground">
                  How weights render — as raw numeric points or as a percentage of the section total.
                </p>
              </div>
              <ToggleGroup
                type="single"
                variant="outline"
                value={toggles.weight_mode}
                onValueChange={(v) => { if (v) saveMut.mutate({ weight_mode: v as WeightMode }); }}
              >
                <ToggleGroupItem value="numeric">Numeric</ToggleGroupItem>
                <ToggleGroupItem value="percentage">Percentage</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {TOGGLE_DEFS.map((def) => (
              <div
                key={def.key}
                className="flex flex-col gap-2 border-b py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="max-w-xl">
                  <p className="text-sm font-medium">{def.label}</p>
                  <p className="text-xs text-muted-foreground">{def.description}</p>
                </div>
                <Switch
                  checked={Boolean(toggles[def.key])}
                  disabled={saveMut.isPending}
                  onCheckedChange={(checked) => saveMut.mutate({ [def.key]: checked } as Partial<FeatureToggles>)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Master Data tab ───────────────────────────────────────────────────────── */

function MasterDataTab() {
  const query = useQuery({
    queryKey: ["/audit/admin/master-data"],
    queryFn: () => apiFetch<ApiOne<MasterData>>("/audit/admin/master-data"),
  });
  const d = query.data?.data;
  const cityName = React.useMemo(
    () => new Map((d?.cities ?? []).map((c) => [c.id, c.name])),
    [d],
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Org hierarchy and properties are host-owned and synced in — read-only here.
      </p>
      {query.isLoading || !d ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* Sync banner */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Badge variant={d.sync.status === "SYNCED" ? "success" : "outline"}>{d.sync.status}</Badge>
            <span className="text-muted-foreground">
              Source: <span className="text-foreground">{d.sync.source}</span>
            </span>
            <span className="text-muted-foreground">
              Last synced: <span className="text-foreground">{fmtDateTime(d.sync.lastSyncedAt)}</span>
            </span>
          </div>

          {/* Counts */}
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard title="Zones" value={d.counts.zones} icon={Database} />
            <StatCard title="Cities" value={d.counts.cities} icon={Database} />
            <StatCard title="Clusters" value={d.counts.clusters} icon={Database} />
            <StatCard title="Properties" value={d.counts.properties} icon={Building2} />
            <StatCard title="Rooms" value={d.counts.rooms} icon={Building2} />
          </div>

          {/* Properties table (read-only) */}
          <div className="overflow-x-auto rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="text-right">Audits generated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.properties.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.city ?? cityName.get(p.clusterId ?? "") ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.auditsGenerated}</TableCell>
                  </TableRow>
                ))}
                {d.properties.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                      No properties synced yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function AuditAdmin() {
  const { can } = usePermissions();
  const showTrail = can("AUDIT_TRAIL", "view");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Admin"
        subtitle="Role grants, numbering and module configuration — every change is recorded in the hash-chained trail."
        breadcrumbs={[{ label: "Audits" }, { label: "Audit Admin" }]}
      />
      <Tabs defaultValue="grants">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            <TabsTrigger value="grants">Role Grants</TabsTrigger>
            <TabsTrigger value="rating-scales">Rating Scales</TabsTrigger>
            <TabsTrigger value="bands">Bands</TabsTrigger>
            <TabsTrigger value="sla">Severity &amp; SLA</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="policies">Attachments</TabsTrigger>
            <TabsTrigger value="candidates">Bank Candidates</TabsTrigger>
            <TabsTrigger value="feature-toggles">Feature Toggles</TabsTrigger>
            <TabsTrigger value="master-data">Master Data</TabsTrigger>
            <TabsTrigger value="numbering">Numbering</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            {showTrail && <TabsTrigger value="trail">Trail</TabsTrigger>}
          </TabsList>
        </div>
        <TabsContent value="grants" className="mt-4">
          <GrantsTab />
        </TabsContent>
        <TabsContent value="rating-scales" className="mt-4">
          <RatingScalesTab />
        </TabsContent>
        <TabsContent value="bands" className="mt-4">
          <BandsTab />
        </TabsContent>
        <TabsContent value="sla" className="mt-4">
          <SlaTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationRulesTab />
        </TabsContent>
        <TabsContent value="policies" className="mt-4">
          <AttachmentPoliciesTab />
        </TabsContent>
        <TabsContent value="candidates" className="mt-4">
          <BankCandidatesTab />
        </TabsContent>
        <TabsContent value="feature-toggles" className="mt-4">
          <FeatureTogglesTab />
        </TabsContent>
        <TabsContent value="master-data" className="mt-4">
          <MasterDataTab />
        </TabsContent>
        <TabsContent value="numbering" className="mt-4">
          <NumberingTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
        {showTrail && (
          <TabsContent value="trail" className="mt-4">
            <TrailExplorerPanel embedded />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
