import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  AUDIT_TYPE_LABELS, REMINDER_OPTIONS,
  type ApiList, type ApiOne, type AuditType,
} from "./lib";
import { TypeBadge } from "./shared";

/** Conduct-scoped template row from GET /audits/conductable-templates. */
interface ConductableTemplate {
  id: string;
  name: string;
  auditType: AuditType;
  targetType: "PROPERTY" | "ROOM";
  category: string | null;
  latestVersionId: string;
  latestVersionNo: number;
}

interface FormState {
  auditType: AuditType | "";
  templateId: string;
  title: string;
  description: string;
  propertyId: string;
  roomId: string;
  scheduledFor: string;
  dueAt: string;
  reminder: string; // "none" | minutes as string
}

const EMPTY: FormState = {
  auditType: "",
  templateId: "",
  title: "",
  description: "",
  propertyId: "",
  roomId: "",
  scheduledFor: "",
  dueAt: "",
  reminder: "none",
};

/**
 * One-off / ad-hoc audit creation (FRD one-off; unblocks the CX audit
 * workflow). A full-page form: type → published template → target, assigned to
 * yourself, with an optional schedule. POST /audits → navigate to the created
 * audit's detail.
 */
export default function NewAudit(
  { inDialog = false, onDone }: { inDialog?: boolean; onDone?: (id?: string) => void } = {},
) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { me } = usePermissions();

  const [form, setForm] = React.useState<FormState>(EMPTY);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /* ── Reference data ────────────────────────────────────────────────────── */

  // Conductable templates — the conduct-scoped endpoint returns only PUBLISHED
  // templates for audit types the caller may conduct, so it works for the CX
  // team (who lack AUDIT_TEMPLATES/PROPERTIES read permission).
  const templatesQuery = useQuery({
    queryKey: ["/audits/conductable-templates"],
    queryFn: () =>
      apiFetch<ApiList<ConductableTemplate>>("/audits/conductable-templates"),
    staleTime: 5 * 60_000,
  });
  const allTemplates = templatesQuery.data?.data ?? [];

  const visibleTypes = React.useMemo(
    () => (["UL", "CM", "CX"] as AuditType[]).filter((t) => allTemplates.some((tp) => tp.auditType === t)),
    [allTemplates],
  );

  // Preselect when only one conductable type (common for the CX team).
  React.useEffect(() => {
    if (!form.auditType && visibleTypes.length === 1) {
      set("auditType", visibleTypes[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTypes]);

  const runnableTemplates = React.useMemo(
    () => allTemplates.filter((t) => t.auditType === form.auditType && t.latestVersionId),
    [allTemplates, form.auditType],
  );
  const selectedTemplate = runnableTemplates.find((t) => t.id === form.templateId) ?? null;
  const targetType = selectedTemplate?.targetType ?? null;

  const propertiesQuery = useQuery({
    queryKey: ["/audits/target-properties", form.auditType],
    queryFn: () =>
      apiFetch<ApiList<{ id: string; name: string; city: string | null }>>(
        `/audits/target-properties?auditType=${form.auditType}`,
      ),
    enabled: Boolean(form.auditType),
  });
  const roomsQuery = useQuery({
    queryKey: ["/audits/target-rooms", form.propertyId, form.auditType],
    queryFn: () =>
      apiFetch<ApiList<{ id: string; number: string; floor: number | null }>>(
        `/audits/target-rooms?propertyId=${form.propertyId}&auditType=${form.auditType}`,
      ),
    enabled: targetType === "ROOM" && Boolean(form.propertyId),
  });

  /* ── Submit ────────────────────────────────────────────────────────────── */

  const buildBody = () => {
    const body: Record<string, unknown> = {
      templateVersionId: selectedTemplate!.latestVersionId,
      title: form.title.trim(),
      targetType,
    };
    if (form.description.trim()) body.description = form.description.trim();
    if (targetType === "ROOM") {
      body.roomId = form.roomId;
      body.propertyId = form.propertyId;
    } else {
      body.propertyId = form.propertyId;
    }
    // One-off audits are always self-assigned.
    if (me?.id) body.assigneeId = me.id;
    if (form.scheduledFor) body.scheduledFor = new Date(form.scheduledFor).toISOString();
    if (form.dueAt) body.dueAt = new Date(form.dueAt).toISOString();
    if (form.reminder !== "none") body.reminderOffsetMinutes = Number(form.reminder);
    return body;
  };

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<{ id: string; ticketNo: string }>>("/audits", {
        method: "POST",
        body: JSON.stringify(buildBody()),
      }),
    onSuccess: (res) => {
      toast({ title: `Audit ${res.data.ticketNo ?? ""} created`.trim() });
      qc.invalidateQueries({ queryKey: ["/audits"] });
      qc.invalidateQueries({ queryKey: ["/audits/my"] });
      if (onDone) onDone(res.data.id);
      else navigate(`/audits/${res.data.id}`);
    },
    onError: (e: Error) => toast({ title: e.message || "Could not create audit", variant: "destructive" }),
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  const validationError = !form.auditType
    ? "Pick an audit type."
    : !form.templateId
      ? "Pick a published template."
      : !form.title.trim()
        ? "Title is required."
        : !form.propertyId
          ? "Pick a property."
          : targetType === "ROOM" && !form.roomId
            ? "Pick a room."
            : form.scheduledFor && form.dueAt && new Date(form.dueAt) < new Date(form.scheduledFor)
              ? "Due date is before the scheduled date."
              : null;

  return (
    <div className={inDialog ? "space-y-6" : "mx-auto max-w-4xl space-y-6"}>
      {!inDialog && (
        <PageHeader
          title="New Audit"
          subtitle="Create a one-off (ad-hoc) audit from a published template — target, assignee and optional schedule."
          breadcrumbs={[{ label: "Audits" }, { label: "New Audit" }]}
        />
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* What ────────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What</CardTitle>
            <CardDescription>Audit type, template and title.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Audit type</Label>
              {templatesQuery.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : visibleTypes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You don't have permission to conduct any audit types.
                </p>
              ) : (
                <Select
                  value={form.auditType || undefined}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, auditType: v as AuditType, templateId: "" }))
                  }
                >
                  <SelectTrigger><SelectValue placeholder="Pick an audit type" /></SelectTrigger>
                  <SelectContent>
                    {visibleTypes.map((t) => (
                      <SelectItem key={t} value={t}>{AUDIT_TYPE_LABELS[t]} ({t})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              <Select
                value={form.templateId}
                disabled={!form.auditType || templatesQuery.isLoading}
                onValueChange={(v) => setForm((f) => ({ ...f, templateId: v, propertyId: "", roomId: "" }))}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      !form.auditType ? "Pick a type first"
                      : templatesQuery.isLoading ? "Loading…"
                      : "Pick a published template"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {runnableTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · v{t.latestVersionNo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.auditType && !templatesQuery.isLoading && runnableTemplates.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No published templates for this type yet.
                </p>
              )}
              {selectedTemplate && (
                <div className="flex items-center gap-2 text-sm">
                  <TypeBadge type={selectedTemplate.auditType} />
                  <span className="text-muted-foreground">
                    audits {selectedTemplate.targetType === "ROOM" ? "a room" : "a property"} ·
                    pinned to v{selectedTemplate.latestVersionNo}
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="e.g. Surprise CX check — North Wing"
              />
            </div>

            <div className="space-y-2">
              <Label>Description <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
                placeholder="Why this audit is being raised…"
              />
            </div>
          </CardContent>
        </Card>

        {/* Where + who ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Target & assignee</CardTitle>
            <CardDescription>
              {targetType === "ROOM"
                ? "This template audits a room — pick a property, then a room."
                : targetType === "PROPERTY"
                  ? "This template audits a property."
                  : "Pick a template first — its target type decides what you select."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Property</Label>
              <Select
                value={form.propertyId}
                disabled={!targetType}
                onValueChange={(v) => setForm((f) => ({ ...f, propertyId: v, roomId: "" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={targetType ? "Pick a property" : "Pick a template first"} />
                </SelectTrigger>
                <SelectContent>
                  {(propertiesQuery.data?.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {targetType === "ROOM" && (
              <div className="space-y-2">
                <Label>Room</Label>
                <Select
                  value={form.roomId}
                  disabled={!form.propertyId || roomsQuery.isLoading}
                  onValueChange={(v) => set("roomId", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={roomsQuery.isLoading ? "Loading rooms…" : "Pick a room"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(roomsQuery.data?.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        Room {r.number}{r.floor != null ? ` · Floor ${r.floor}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Assignee</Label>
              <p className="text-sm text-muted-foreground">
                Assigned to you{me?.name ? ` (${me.name})` : ""} — you conduct
                this audit.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Schedule ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Schedule <span className="text-sm font-normal text-muted-foreground">(optional)</span></CardTitle>
          <CardDescription>Leave blank to make the audit due immediately.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Scheduled for</Label>
            <Input
              type="datetime-local"
              value={form.scheduledFor}
              onChange={(e) => set("scheduledFor", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Due at</Label>
            <Input
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => set("dueAt", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Reminder</Label>
            <Select value={form.reminder} onValueChange={(v) => set("reminder", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No reminder</SelectItem>
                {REMINDER_OPTIONS.map((r) => (
                  <SelectItem key={r.minutes} value={String(r.minutes)}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Actions ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Button
          onClick={() => createMut.mutate()}
          disabled={Boolean(validationError) || createMut.isPending}
        >
          Create audit
        </Button>
        <Button variant="outline" onClick={() => (onDone ? onDone() : navigate("/audits/my"))}>Cancel</Button>
        {validationError && <p className="text-sm text-muted-foreground">{validationError}</p>}
      </div>
    </div>
  );
}
