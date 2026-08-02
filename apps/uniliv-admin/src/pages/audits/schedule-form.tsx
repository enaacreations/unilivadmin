import * as React from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  DAYS_OF_WEEK, FREQUENCIES, FREQUENCY_LABELS, REMINDER_OPTIONS,
  type ApiList, type ApiOne, type Frequency, type ScheduleDetail, type TemplateRow,
} from "./lib";
import { TypeBadge } from "./shared";

interface FormState {
  title: string;
  templateId: string;
  frequency: Frequency;
  intervalDays: string;
  dayOfWeek: string;
  cron: string;
  timeOfDay: string;
  windowStart: string;
  windowEnd: string;
  reminder: string; // "none" | minutes as string
  assigneeKind: "ROLE_AT_TARGET" | "USER";
  assigneeRole: "UNIT_LEAD" | "CLUSTER_MANAGER";
  assigneeUserId: string;
  propertyIds: string[]; // PROPERTY targets
  roomIds: string[]; // ROOM targets
}

const EMPTY: FormState = {
  title: "",
  templateId: "",
  frequency: "MONTHLY",
  intervalDays: "1",
  dayOfWeek: "1",
  cron: "",
  timeOfDay: "09:00",
  windowStart: "",
  windowEnd: "",
  reminder: "none",
  assigneeKind: "ROLE_AT_TARGET",
  assigneeRole: "UNIT_LEAD",
  assigneeUserId: "",
  propertyIds: [],
  roomIds: [],
};

const dateOnly = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toISOString().slice(0, 10) : "";

/** Create/edit form for recurring audit programs. `/audits/schedules/new` has
 *  no :id param → create mode; otherwise the schedule loads into the form. */
export default function ScheduleForm() {
  const params = useParams<{ id?: string }>();
  const editId = params.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [templateTouched, setTemplateTouched] = React.useState(false);
  const [roomPropertyId, setRoomPropertyId] = React.useState("");
  const [roomLabels, setRoomLabels] = React.useState<Record<string, string>>({});
  const loadedRef = React.useRef<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /* ── Reference data ────────────────────────────────────────────────────── */

  const templatesQuery = useQuery({
    queryKey: ["/audit/templates"],
    queryFn: () => apiFetch<ApiList<TemplateRow>>("/audit/templates?limit=200"),
  });
  const propertiesQuery = useQuery({
    queryKey: ["/properties", "schedule-form"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string }>>("/properties?limit=100"),
  });
  const usersQuery = useQuery({
    queryKey: ["/users", "schedule-form"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string; role: string }>>("/users?limit=100"),
  });
  const roomsQuery = useQuery({
    queryKey: ["/rooms", roomPropertyId],
    queryFn: () =>
      apiFetch<ApiList<{ id: string; number: string; floor: number | null; wing: string | null }>>(
        `/rooms?propertyId=${roomPropertyId}&limit=500`,
      ),
    enabled: Boolean(roomPropertyId),
  });

  const detailQuery = useQuery({
    queryKey: ["/audit/schedules", editId],
    queryFn: () => apiFetch<ApiOne<ScheduleDetail>>(`/audit/schedules/${editId}`),
    enabled: Boolean(editId),
  });

  // Schedulable = published latest version, never CX (ruling C-3).
  const eligibleTemplates = React.useMemo(
    () =>
      (templatesQuery.data?.data ?? []).filter(
        (t) => !t.archivedAt && t.lifecycle === "PUBLISHED" && t.auditType !== "CX",
      ),
    [templatesQuery.data],
  );
  const selectedTemplate =
    (templatesQuery.data?.data ?? []).find((t) => t.id === form.templateId) ?? null;
  const targetType = selectedTemplate?.targetType ?? null;

  // Populate the form once from the loaded schedule (edit mode).
  React.useEffect(() => {
    const s = detailQuery.data?.data;
    if (!s || loadedRef.current === s.id) return;
    loadedRef.current = s.id;
    setForm({
      title: s.title,
      templateId: s.templateId,
      frequency: s.frequency,
      intervalDays: s.intervalDays != null ? String(s.intervalDays) : "1",
      dayOfWeek: s.dayOfWeek != null ? String(s.dayOfWeek) : "1",
      cron: s.cron ?? "",
      timeOfDay: s.timeOfDay,
      windowStart: dateOnly(s.windowStart),
      windowEnd: dateOnly(s.windowEnd),
      reminder: s.reminderOffsetMinutes != null ? String(s.reminderOffsetMinutes) : "none",
      assigneeKind: s.assigneeRule.kind,
      assigneeRole: s.assigneeRule.kind === "ROLE_AT_TARGET" ? s.assigneeRule.role : "UNIT_LEAD",
      assigneeUserId: s.assigneeRule.kind === "USER" ? s.assigneeRule.userId : "",
      propertyIds: s.targets.filter((t) => t.targetType === "PROPERTY").map((t) => t.propertyId!).filter(Boolean),
      roomIds: s.targets.filter((t) => t.targetType === "ROOM").map((t) => t.roomId!).filter(Boolean),
    });
    const labels: Record<string, string> = {};
    for (const t of s.targets) {
      if (t.roomId) labels[t.roomId] = `${t.propertyName ?? ""} · ${t.roomNumber ?? t.roomId}`;
    }
    setRoomLabels(labels);
    const firstRoomProp = s.targets.find((t) => t.targetType === "ROOM")?.propertyId;
    if (firstRoomProp) setRoomPropertyId(firstRoomProp);
  }, [detailQuery.data]);

  /* ── Submit ────────────────────────────────────────────────────────────── */

  const buildBody = () => {
    const targets =
      targetType === "ROOM"
        ? form.roomIds.map((roomId) => ({ targetType: "ROOM" as const, roomId }))
        : form.propertyIds.map((propertyId) => ({ targetType: "PROPERTY" as const, propertyId }));
    return {
      title: form.title.trim(),
      // On edit, keep the pinned version unless the planner re-picked a template.
      ...(!editId || templateTouched
        ? { templateVersionId: selectedTemplate?.latestVersionId }
        : {}),
      frequency: form.frequency,
      intervalDays: form.frequency === "EVERY_N_DAYS" ? Number(form.intervalDays) : null,
      dayOfWeek: form.frequency === "WEEKLY" ? Number(form.dayOfWeek) : null,
      cron: form.frequency === "CRON" ? form.cron.trim() : null,
      timeOfDay: form.timeOfDay,
      windowStart: form.windowStart,
      windowEnd: form.windowEnd || null,
      reminderOffsetMinutes: form.reminder === "none" ? null : Number(form.reminder),
      assigneeRule:
        form.assigneeKind === "USER"
          ? { kind: "USER" as const, userId: form.assigneeUserId }
          : { kind: "ROLE_AT_TARGET" as const, role: form.assigneeRole },
      targets,
    };
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const body = buildBody();
      return editId
        ? apiFetch(`/audit/schedules/${editId}`, { method: "PATCH", body: JSON.stringify(body) })
        : apiFetch("/audit/schedules", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: editId ? "Schedule updated — future occurrences only" : "Schedule created" });
      qc.invalidateQueries({ queryKey: ["/audit/schedules"] });
      navigate("/audits/schedules");
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const targetCount = targetType === "ROOM" ? form.roomIds.length : form.propertyIds.length;
  const validationError = !form.title.trim()
    ? "Title is required."
    : !form.templateId
      ? "Pick a template."
      : !form.timeOfDay
        ? "Pick a time of day."
        : !form.windowStart
          ? "Pick a window start date."
          : form.frequency !== "CRON" && !form.windowEnd
            ? "Recurring schedules need a window end date."
            : form.frequency === "CRON" && !form.cron.trim()
              ? "Enter a cron expression (5 fields)."
              : form.assigneeKind === "USER" && !form.assigneeUserId
                ? "Pick an assignee."
                : targetCount === 0
                  ? "Pick at least one target."
                  : null;

  if (editId && detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={editId ? "Edit Schedule" : "New Schedule"}
        subtitle={
          editId
            ? "Changes apply to future occurrences only — audits already materialized are untouched."
            : "Recurring audit program: template, cadence, assignment rule and targets."
        }
        breadcrumbs={[
          { label: "Audits" },
          { label: "Schedules", href: "/audits/schedules" },
          { label: editId ? "Edit" : "New" },
        ]}
      />

      {editId && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" />
          Edits affect future occurrences only. Un-started future drafts regenerate
          from the new definition.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Program</CardTitle>
            <CardDescription>What runs, and how often.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="e.g. Monthly Hygiene — North Cluster"
              />
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              <Select
                value={form.templateId}
                onValueChange={(v) => {
                  setTemplateTouched(true);
                  setForm((f) => ({ ...f, templateId: v, propertyIds: [], roomIds: [] }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a published template" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · v{t.latestVersionNo} ({t.auditType})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Published versions only. CX templates are ad-hoc and cannot be scheduled.
              </p>
              {selectedTemplate && (
                <div className="flex items-center gap-2 text-sm">
                  <TypeBadge type={selectedTemplate.auditType} />
                  <span className="text-muted-foreground">
                    audits {selectedTemplate.targetType === "ROOM" ? "rooms" : "properties"} ·
                    pinned to v{selectedTemplate.latestVersionNo}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Frequency</Label>
                <Select value={form.frequency} onValueChange={(v) => set("frequency", v as Frequency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((f) => (
                      <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.frequency === "EVERY_N_DAYS" && (
                <div className="space-y-2">
                  <Label>Interval (days)</Label>
                  <Select value={form.intervalDays} onValueChange={(v) => set("intervalDays", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 1 ? "Every day" : `Every ${n} days`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.frequency === "WEEKLY" && (
                <div className="space-y-2">
                  <Label>Day of week</Label>
                  <Select value={form.dayOfWeek} onValueChange={(v) => set("dayOfWeek", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAYS_OF_WEEK.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.frequency === "CRON" && (
                <div className="space-y-2">
                  <Label>Cron expression</Label>
                  <Input
                    value={form.cron}
                    onChange={(e) => set("cron", e.target.value)}
                    placeholder="0 9 * * 1"
                    className="font-mono"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label>Time of day</Label>
                <Input
                  type="time"
                  value={form.timeOfDay}
                  onChange={(e) => set("timeOfDay", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Window start</Label>
                <Input
                  type="date"
                  value={form.windowStart}
                  onChange={(e) => set("windowStart", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Window end{form.frequency === "CRON" ? " (optional)" : ""}</Label>
                <Input
                  type="date"
                  value={form.windowEnd}
                  onChange={(e) => set("windowEnd", e.target.value)}
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
            </div>

            <div className="space-y-2">
              <Label>Assignee</Label>
              <RadioGroup
                value={form.assigneeKind}
                onValueChange={(v) => set("assigneeKind", v as FormState["assigneeKind"])}
                className="space-y-1"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="ROLE_AT_TARGET" /> Role at target
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="USER" /> Specific user
                </label>
              </RadioGroup>
              {form.assigneeKind === "ROLE_AT_TARGET" ? (
                <Select
                  value={form.assigneeRole}
                  onValueChange={(v) => set("assigneeRole", v as FormState["assigneeRole"])}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UNIT_LEAD">Unit Lead of the target</SelectItem>
                    <SelectItem value="CLUSTER_MANAGER">Cluster Manager of the target</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Select
                  value={form.assigneeUserId}
                  onValueChange={(v) => set("assigneeUserId", v)}
                >
                  <SelectTrigger><SelectValue placeholder="Pick a user" /></SelectTrigger>
                  <SelectContent>
                    {(usersQuery.data?.data ?? []).map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} · {u.role.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Targets
              {targetCount > 0 && (
                <Badge variant="secondary" className="ml-2 tabular-nums">{targetCount}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {targetType === "ROOM"
                ? "This template audits rooms — pick a property, then its rooms."
                : targetType === "PROPERTY"
                  ? "One audit is generated per property per occurrence."
                  : "Pick a template first — its target type decides what you select here."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {targetType === "PROPERTY" && (
              <div className="max-h-[380px] space-y-1 overflow-y-auto rounded-md border p-2">
                {(propertiesQuery.data?.data ?? []).map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      checked={form.propertyIds.includes(p.id)}
                      onCheckedChange={(checked) =>
                        set(
                          "propertyIds",
                          checked
                            ? [...form.propertyIds, p.id]
                            : form.propertyIds.filter((x) => x !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
                {(propertiesQuery.data?.data ?? []).length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">No properties.</p>
                )}
              </div>
            )}

            {targetType === "ROOM" && (
              <>
                <Select value={roomPropertyId} onValueChange={setRoomPropertyId}>
                  <SelectTrigger><SelectValue placeholder="Pick a property" /></SelectTrigger>
                  <SelectContent>
                    {(propertiesQuery.data?.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {roomPropertyId && (
                  <div className="max-h-[280px] space-y-1 overflow-y-auto rounded-md border p-2">
                    {roomsQuery.isLoading && <Skeleton className="h-20 w-full" />}
                    {(roomsQuery.data?.data ?? []).map((r) => {
                      const propertyName =
                        (propertiesQuery.data?.data ?? []).find((p) => p.id === roomPropertyId)?.name ?? "";
                      return (
                        <label
                          key={r.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            checked={form.roomIds.includes(r.id)}
                            onCheckedChange={(checked) => {
                              set(
                                "roomIds",
                                checked
                                  ? [...form.roomIds, r.id]
                                  : form.roomIds.filter((x) => x !== r.id),
                              );
                              if (checked) {
                                setRoomLabels((m) => ({ ...m, [r.id]: `${propertyName} · ${r.number}` }));
                              }
                            }}
                          />
                          Room {r.number}
                          {r.wing && <span className="text-xs text-muted-foreground">· {r.wing}</span>}
                        </label>
                      );
                    })}
                    {!roomsQuery.isLoading && (roomsQuery.data?.data ?? []).length === 0 && (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        No rooms in this property.
                      </p>
                    )}
                  </div>
                )}
                {form.roomIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {form.roomIds.map((id) => (
                      <Badge
                        key={id}
                        variant="secondary"
                        className="cursor-pointer"
                        onClick={() => set("roomIds", form.roomIds.filter((x) => x !== id))}
                        title="Click to remove"
                      >
                        {roomLabels[id] ?? id} ✕
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            )}

            {!targetType && (
              <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                Waiting for a template…
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => saveMut.mutate()}
          disabled={Boolean(validationError) || saveMut.isPending}
        >
          {editId ? "Save changes" : "Create schedule"}
        </Button>
        <Button variant="outline" onClick={() => navigate("/audits/schedules")}>
          Cancel
        </Button>
        {validationError && (
          <p className="text-sm text-muted-foreground">{validationError}</p>
        )}
      </div>
    </div>
  );
}
