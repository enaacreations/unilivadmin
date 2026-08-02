import * as React from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, GitBranch, Hammer, MoreHorizontal,
  Pencil, Eye,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  AUDIT_TYPE_LABELS, fmtDate, titleCase,
  type ApiOne, type TemplateDetail,
  type VersionSummary, type WhereUsed,
} from "./lib";
import { TypeBadge, LifecycleBadge, PublishDialog } from "./shared";

/* ── Versions tab ────────────────────────────────────────────────────────── */

function VersionsTab({
  template,
  onWhereUsed,
}: {
  template: TemplateDetail;
  onWhereUsed: (versionId: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [publishVersion, setPublishVersion] = React.useState<VersionSummary | null>(null);
  const [settingsVersion, setSettingsVersion] = React.useState<VersionSummary | null>(null);
  const [settings, setSettings] = React.useState({
    passThresholdPct: "",
    criticalFailGate: false,
    reviewRequired: false,
    changelogNote: "",
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/audit/templates", template.id] });
    qc.invalidateQueries({ queryKey: ["/audit/templates"] });
  };

  const actionMut = useMutation({
    mutationFn: ({ versionId, action, body }: { versionId: string; action: string; body?: unknown }) =>
      apiFetch(`/audit/templates/versions/${versionId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: (_res, vars) => {
      toast({ title: `Version ${vars.action.replace(/-/g, " ")} done` });
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Action failed", variant: "destructive" }),
  });

  const newDraftMut = useMutation({
    mutationFn: (fromVersionId: string) =>
      apiFetch(`/audit/templates/${template.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ fromVersionId }),
      }),
    onSuccess: () => {
      toast({ title: "New draft created" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Draft failed", variant: "destructive" }),
  });

  const settingsMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/templates/versions/${settingsVersion!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          passThresholdPct: settings.passThresholdPct === "" ? null : Number(settings.passThresholdPct),
          criticalFailGate: settings.criticalFailGate,
          reviewRequired: settings.reviewRequired,
          ...(settings.changelogNote.trim() ? { changelogNote: settings.changelogNote.trim() } : {}),
        }),
      }),
    onSuccess: () => {
      toast({ title: "Version settings saved" });
      setSettingsVersion(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const openSettings = (v: VersionSummary) => {
    setSettings({
      passThresholdPct: v.passThresholdPct != null ? String(Number(v.passThresholdPct)) : "",
      criticalFailGate: v.criticalFailGate,
      reviewRequired: v.reviewRequired,
      changelogNote: v.changelogNote ?? "",
    });
    setSettingsVersion(v);
  };

  const builderPath = (v: VersionSummary) =>
    `/audits/templates/${template.id}/versions/${v.id}/builder`;

  const versions = [...template.versions].sort((a, b) => b.versionNo - a.versionNo);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Version</TableHead>
              <TableHead>Lifecycle</TableHead>
              <TableHead>Changelog</TableHead>
              <TableHead>Published</TableHead>
              <TableHead className="w-64 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="font-mono tabular-nums">v{v.versionNo}</TableCell>
                <TableCell><LifecycleBadge lifecycle={v.lifecycle} /></TableCell>
                <TableCell className="max-w-[260px]">
                  <span className="block truncate text-sm text-muted-foreground">
                    {v.changelogNote || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(v.publishedAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {v.lifecycle === "DRAFT" && (
                      <>
                        <Button asChild variant="outline" size="sm">
                          <Link href={builderPath(v)}>
                            <Hammer className="mr-1 h-3.5 w-3.5" /> Open builder
                          </Link>
                        </Button>
                        <Button size="sm" onClick={() => setPublishVersion(v)}>
                          Publish
                        </Button>
                      </>
                    )}
                    {v.lifecycle === "PUBLISHED" && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={builderPath(v)}>
                          <Eye className="mr-1 h-3.5 w-3.5" /> View
                        </Link>
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {v.lifecycle === "DRAFT" && (
                          <>
                            <DropdownMenuItem onClick={() => openSettings(v)}>
                              <Pencil className="mr-2 h-4 w-4" /> Settings
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => actionMut.mutate({ versionId: v.id, action: "archive" })}
                            >
                              <Archive className="mr-2 h-4 w-4" /> Archive version
                            </DropdownMenuItem>
                          </>
                        )}
                        {v.lifecycle === "PUBLISHED" && (
                          <>
                            <DropdownMenuItem onClick={() => newDraftMut.mutate(v.id)}>
                              <GitBranch className="mr-2 h-4 w-4" /> New draft from this
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onWhereUsed(v.id)}>
                              Where-used
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => actionMut.mutate({ versionId: v.id, action: "deprecate" })}
                            >
                              Deprecate
                            </DropdownMenuItem>
                          </>
                        )}
                        {v.lifecycle === "DEPRECATED" && (
                          <DropdownMenuItem
                            onClick={() => actionMut.mutate({ versionId: v.id, action: "archive" })}
                          >
                            <Archive className="mr-2 h-4 w-4" /> Archive version
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {versions.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No versions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <PublishDialog
        open={publishVersion != null}
        onOpenChange={(o) => { if (!o) setPublishVersion(null); }}
        versionId={publishVersion?.id ?? null}
        versionNo={publishVersion?.versionNo}
        onPublished={invalidate}
      />

      <FormModal
        open={settingsVersion != null}
        onOpenChange={(o) => { if (!o) setSettingsVersion(null); }}
        title={`v${settingsVersion?.versionNo ?? ""} settings`}
        onSave={() => settingsMut.mutate()}
        isSaving={settingsMut.isPending}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Pass threshold %</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={settings.passThresholdPct}
              onChange={(e) => setSettings((s) => ({ ...s, passThresholdPct: e.target.value }))}
              placeholder="e.g. 80 — empty = no pass/fail verdict"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Critical fail gate</p>
              <p className="text-xs text-muted-foreground">Any critical NC forces a FAIL result.</p>
            </div>
            <Switch
              checked={settings.criticalFailGate}
              onCheckedChange={(c) => setSettings((s) => ({ ...s, criticalFailGate: c }))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Review required</p>
              <p className="text-xs text-muted-foreground">Submitted audits route through a reviewer.</p>
            </div>
            <Switch
              checked={settings.reviewRequired}
              onCheckedChange={(c) => setSettings((s) => ({ ...s, reviewRequired: c }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Changelog note</Label>
            <Textarea
              value={settings.changelogNote}
              onChange={(e) => setSettings((s) => ({ ...s, changelogNote: e.target.value }))}
              rows={3}
            />
          </div>
        </div>
      </FormModal>

    </div>
  );
}

/* ── Where-used tab ──────────────────────────────────────────────────────── */

function WhereUsedTab({
  template,
  versionId,
  setVersionId,
}: {
  template: TemplateDetail;
  versionId: string;
  setVersionId: (id: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [migrateTo, setMigrateTo] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const usageQuery = useQuery({
    queryKey: ["/audit/templates/where-used", versionId],
    queryFn: () =>
      apiFetch<ApiOne<WhereUsed>>(`/audit/templates/versions/${versionId}/where-used`),
    enabled: Boolean(versionId),
  });

  const migrateMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<{ migrated: number }>>(
        `/audit/templates/versions/${versionId}/migrate-schedules`,
        { method: "POST", body: JSON.stringify({ toVersionId: migrateTo }) },
      ),
    onSuccess: (res) => {
      toast({ title: `${res.data.migrated} schedule(s) migrated` });
      setConfirmOpen(false);
      setMigrateTo("");
      qc.invalidateQueries({ queryKey: ["/audit/templates/where-used"] });
      qc.invalidateQueries({ queryKey: ["/audit/schedules"] });
    },
    onError: (e: Error) => {
      setConfirmOpen(false);
      toast({ title: e.message || "Migration failed", variant: "destructive" });
    },
  });

  const versions = [...template.versions].sort((a, b) => b.versionNo - a.versionNo);
  const published = versions.filter((v) => v.lifecycle === "PUBLISHED");
  const migrateTargets = published.filter((v) => v.id !== versionId);
  const usage = usageQuery.data?.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label>Version</Label>
          <Select value={versionId} onValueChange={setVersionId}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Pick a version" /></SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  v{v.versionNo} · {titleCase(v.lifecycle)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {usage && (
          <div className="flex gap-6 pb-1 text-sm">
            <span>
              <span className="font-semibold tabular-nums">{usage.openAudits}</span>{" "}
              <span className="text-muted-foreground">open audits</span>
            </span>
            <span>
              <span className="font-semibold tabular-nums">{usage.totalAudits}</span>{" "}
              <span className="text-muted-foreground">total audits</span>
            </span>
          </div>
        )}
      </div>

      {usageQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Frequency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(usage?.schedules ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link href={`/audits/schedules/${s.id}`} className="font-medium hover:underline">
                      {s.title}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant={s.status === "ACTIVE" ? "default" : "secondary"}>{s.status}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{titleCase(s.frequency)}</TableCell>
                </TableRow>
              ))}
              {(usage?.schedules ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                    No schedules reference this version.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {(usage?.schedules.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-4">
          <div className="space-y-2">
            <Label>Migrate schedules to</Label>
            <Select value={migrateTo} onValueChange={setMigrateTo}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Pick a published version" />
              </SelectTrigger>
              <SelectContent>
                {migrateTargets.map((v) => (
                  <SelectItem key={v.id} value={v.id}>v{v.versionNo} · Published</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={!migrateTo} onClick={() => setConfirmOpen(true)}>
            Migrate
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Moves every schedule on this version to the chosen published version.
            Open audits keep the version they were generated with.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Migrate schedules?"
        description={`${usage?.schedules.length ?? 0} schedule(s) will start generating audits from the selected version. Future occurrences only.`}
        onConfirm={() => migrateMut.mutate()}
        isConfirming={migrateMut.isPending}
        confirmLabel="Migrate"
        variant="default"
      />
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function AuditTemplateDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const builderPath = (vid: string) => `/audits/templates/${params.id}/versions/${vid}/builder`;
  const [tab, setTab] = React.useState("versions");
  const [whereUsedVersionId, setWhereUsedVersionId] = React.useState("");
  const [editOpen, setEditOpen] = React.useState(false);
  const [meta, setMeta] = React.useState({ name: "", category: "", description: "" });

  const templateQuery = useQuery({
    queryKey: ["/audit/templates", params.id],
    queryFn: () => apiFetch<ApiOne<TemplateDetail>>(`/audit/templates/${params.id}`),
    enabled: Boolean(params.id),
  });
  const template = templateQuery.data?.data;

  // Default the where-used picker to the latest published version.
  React.useEffect(() => {
    if (!template || whereUsedVersionId) return;
    const versions = [...template.versions].sort((a, b) => b.versionNo - a.versionNo);
    const pick = versions.find((v) => v.lifecycle === "PUBLISHED") ?? versions[0];
    if (pick) setWhereUsedVersionId(pick.id);
  }, [template, whereUsedVersionId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/audit/templates", params.id] });
    qc.invalidateQueries({ queryKey: ["/audit/templates"] });
  };

  const metaMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/templates/${params.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: meta.name.trim(),
          category: meta.category.trim() || null,
          description: meta.description.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Template updated" });
      setEditOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const archiveMut = useMutation({
    mutationFn: (restore: boolean) =>
      apiFetch(`/audit/templates/${params.id}/archive`, {
        method: "POST",
        body: JSON.stringify(restore ? { restore: true } : {}),
      }),
    onSuccess: () => {
      toast({ title: template?.archivedAt ? "Template restored" : "Template archived" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Action failed", variant: "destructive" }),
  });

  // "Edit questions" on a published-only template forks a fresh draft first, then
  // drops the user into the builder — editing published versions in place isn't allowed.
  const editQuestionsMut = useMutation({
    mutationFn: (fromVersionId?: string) =>
      apiFetch<ApiOne<{ id: string }>>(`/audit/templates/${params.id}/versions`, {
        method: "POST",
        body: JSON.stringify(fromVersionId ? { fromVersionId } : {}),
      }),
    onSuccess: (res) => { invalidate(); navigate(builderPath(res.data.id)); },
    onError: (e: Error) => toast({ title: e.message || "Couldn't start editing", variant: "destructive" }),
  });

  if (templateQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!template) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Template not found"
          breadcrumbs={[{ label: "Audits" }, { label: "Templates", href: "/audits/templates" }]}
        />
      </div>
    );
  }

  const sortedVersions = [...template.versions].sort((a, b) => b.versionNo - a.versionNo);
  const draftVersion = sortedVersions.find((v) => v.lifecycle === "DRAFT");
  const latestPublished = sortedVersions.find((v) => v.lifecycle === "PUBLISHED");

  return (
    <div className="space-y-6">
      <PageHeader
        title={template.name}
        subtitle={template.description || undefined}
        breadcrumbs={[
          { label: "Audits" },
          { label: "Templates", href: "/audits/templates" },
          { label: template.name },
        ]}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={editQuestionsMut.isPending}
              onClick={() =>
                draftVersion
                  ? navigate(builderPath(draftVersion.id))
                  : editQuestionsMut.mutate(latestPublished?.id)
              }
            >
              <Pencil className="mr-1 h-4 w-4" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => archiveMut.mutate(Boolean(template.archivedAt))}
              disabled={archiveMut.isPending}
            >
              {template.archivedAt ? (
                <><ArchiveRestore className="mr-1 h-4 w-4" /> Restore</>
              ) : (
                <><Archive className="mr-1 h-4 w-4" /> Archive</>
              )}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2">
          <TypeBadge type={template.auditType} />
          <span className="text-muted-foreground">{AUDIT_TYPE_LABELS[template.auditType]}</span>
        </span>
        <span className="text-muted-foreground">
          Target: <span className="text-foreground">{titleCase(template.targetType)}</span>
        </span>
        {template.category && (
          <span className="text-muted-foreground">
            Category: <span className="text-foreground">{template.category}</span>
          </span>
        )}
        {template.archivedAt && <Badge variant="outline">Archived {fmtDate(template.archivedAt)}</Badge>}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="where-used">Where-used</TabsTrigger>
        </TabsList>
        <TabsContent value="versions" className="mt-4">
          <VersionsTab
            template={template}
            onWhereUsed={(vid) => { setWhereUsedVersionId(vid); setTab("where-used"); }}
          />
        </TabsContent>
        <TabsContent value="where-used" className="mt-4">
          <WhereUsedTab
            template={template}
            versionId={whereUsedVersionId}
            setVersionId={setWhereUsedVersionId}
          />
        </TabsContent>
      </Tabs>

      <FormModal
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit template"
        onSave={() => metaMut.mutate()}
        isSaving={metaMut.isPending}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Input value={meta.category} onChange={(e) => setMeta((m) => ({ ...m, category: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={meta.description}
              onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
              rows={3}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Audit type and target type are fixed after creation.
          </p>
        </div>
      </FormModal>
    </div>
  );
}
