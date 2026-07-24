import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  AUDIT_TYPES, AUDIT_TYPE_LABELS, fmtDate, titleCase,
  type ApiOne, type ApiList, type AuditType, type Lifecycle, type TargetType, type TemplateRow,
} from "./lib";
import { cn } from "@/lib/utils";

/* Template library (redesign — prototype "Audit templates"). A card grid of
 * every checklist with its latest version, lifecycle and usage — the card
 * click opens the template detail (versions, changelog, publish workflow).
 * Editing a template publishes a new immutable version. */

const TYPE_CHIP: Record<AuditType, { chip: string }> = {
  UL: { chip: "bg-accent/10 text-accent-strong" },
  CM: { chip: "bg-info-soft text-info" },
  CX: { chip: "bg-muted text-muted-foreground" },
};

const LIFECYCLE_TAG: Record<Lifecycle, { label: string; cls: string }> = {
  PUBLISHED: { label: "Published", cls: "bg-success-soft text-success" },
  DRAFT: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  PENDING_APPROVAL: { label: "In review", cls: "bg-warning/15 text-warning" },
  DEPRECATED: { label: "Deprecated", cls: "bg-destructive/10 text-destructive" },
  ARCHIVED: { label: "Archived", cls: "bg-muted text-muted-foreground" },
};

export default function AuditTemplates() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [typeTab, setTypeTab] = React.useState<"ALL" | AuditType>("ALL");
  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    auditType: "UL" as AuditType,
    targetType: "PROPERTY" as TargetType,
    category: "",
  });

  const templatesQuery = useQuery({
    queryKey: ["/audit/templates"],
    queryFn: () => apiFetch<ApiList<TemplateRow>>("/audit/templates?limit=200"),
  });

  const rows = React.useMemo(() => {
    const all = templatesQuery.data?.data ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (t) =>
        (typeTab === "ALL" || t.auditType === typeTab) &&
        (!q || t.name.toLowerCase().includes(q) || (t.category ?? "").toLowerCase().includes(q)),
    );
  }, [templatesQuery.data, typeTab, search]);

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<TemplateRow>>("/audit/templates", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          auditType: form.auditType,
          targetType: form.targetType,
          ...(form.category.trim() ? { category: form.category.trim() } : {}),
        }),
      }),
    onSuccess: (res) => {
      toast({ title: "Template created — v1 draft ready" });
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["/audit/templates"] });
      navigate(`/audits/templates/${res.data.id}`);
    },
    onError: (e: Error) => toast({ title: e.message || "Create failed", variant: "destructive" }),
  });

  const loading = templatesQuery.isLoading;

  return (
    <div className="animate-fade-up space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-0.5 font-display text-2xl font-bold tracking-[-0.012em]">Audit templates</h1>
          <p className="text-sm text-muted-foreground">What each audit asks, in what order, and how it scores.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> New template
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={typeTab} onValueChange={(v) => setTypeTab(v as "ALL" | AuditType)}>
          <TabsList>
            <TabsTrigger value="ALL">All</TabsTrigger>
            {AUDIT_TYPES.map((t) => <TabsTrigger key={t} value={t}>{AUDIT_TYPE_LABELS[t]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="relative min-w-[220px] flex-1 sm:max-w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates…"
            className="pl-9"
          />
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[128px] rounded-[14px]" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center">
            <p className="text-sm text-muted-foreground">
              {search || typeTab !== "ALL" ? "No templates match your filters." : "No templates yet — create your first checklist."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((t) => {
            const tag = LIFECYCLE_TAG[t.lifecycle] ?? LIFECYCLE_TAG.DRAFT;
            return (
              <button
                key={t.id}
                onClick={() => navigate(`/audits/templates/${t.id}`)}
                className="group rounded-[14px] border border-border bg-card p-4 text-left transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline-none"
              >
                <div className="flex items-start gap-2.5">
                  <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] font-mono text-[10.5px] font-bold", TYPE_CHIP[t.auditType].chip)}>
                    {t.auditType}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px] font-bold text-foreground">{t.name}</div>
                    <div className="font-mono text-[10.5px] text-muted-foreground">
                      {titleCase(t.targetType)} audit · v{t.latestVersionNo}
                    </div>
                  </div>
                  <span className={cn("shrink-0 rounded-full px-2.5 py-[3px] text-[10.5px] font-bold", tag.cls)}>{tag.label}</span>
                </div>
                {t.category && (
                  <div className="mt-2 truncate text-[11.5px] text-muted-foreground">{t.category}</div>
                )}
                <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted-foreground">
                  <span><strong className="font-bold text-foreground tabular-nums">{t.activeSchedules}</strong> schedules</span>
                  <span><strong className="font-bold text-foreground tabular-nums">{t.auditsGenerated}</strong> audits run</span>
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">Edited {fmtDate(t.updatedAt)}</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="max-w-[560px] rounded-[11px] bg-info-soft px-[13px] py-[11px] text-[12px] font-semibold text-info">
        Editing publishes a new version — audits already conducted keep the version they were scored with.
      </div>

      <FormModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New template"
        onSave={() => {
          if (!form.name.trim()) {
            toast({ title: "Name is required", variant: "destructive" });
            return;
          }
          createMut.mutate();
        }}
        isSaving={createMut.isPending}
        saveLabel="Create"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Monthly Property Hygiene Audit"
            />
          </div>
          <div className="space-y-2">
            <Label>Audit type</Label>
            <Select
              value={form.auditType}
              onValueChange={(v) => setForm((f) => ({ ...f, auditType: v as AuditType }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {AUDIT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t} · {AUDIT_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Target type</Label>
            <Select
              value={form.targetType}
              onValueChange={(v) => setForm((f) => ({ ...f, targetType: v as TargetType }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PROPERTY">Property</SelectItem>
                <SelectItem value="ROOM">Room</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Category (optional)</Label>
            <Input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="e.g. Hygiene"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            A v1 draft is created automatically — you land in the template to
            build sections and questions next.
          </p>
        </div>
      </FormModal>
    </div>
  );
}
