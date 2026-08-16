import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import {
  ASSIGNABLE_ROLES, ASSIGNABLE_ROLE_HINTS, ASSIGNABLE_ROLE_LABELS, describeRecurrence, titleCase,
  type ApiList, type AssignableRole, type AuditType, type RecurrenceRule, type TemplateRow,
} from "./lib";
import { RecurrenceEditor } from "./recurrence-editor";
import { cn } from "@/lib/utils";

const TYPE_CHIP: Record<AuditType, string> = { UL: "bg-accent/10 text-accent-strong", CM: "bg-info-soft text-info", CX: "bg-muted text-muted-foreground" };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type TargetProp = { id: string; name: string; city: string | null };
type ScopeLevel = "ORG" | "ZONE" | "CITY" | "CLUSTER" | "PROPERTY" | "ROOM";
type ScopeOption = { id: string; name: string; sublabel?: string | null };

/** Levels offered in the wizard. ROOM is only meaningful for room templates. */
const SCOPE_LEVELS: { v: ScopeLevel; label: string }[] = [
  { v: "ORG", label: "Whole estate" },
  { v: "ZONE", label: "Zone" },
  { v: "CITY", label: "City" },
  { v: "CLUSTER", label: "Cluster" },
  { v: "PROPERTY", label: "Property" },
];
type UserRow = { id: string; name: string; role: string };
/** Mirrors the two `assigneeRule` shapes the schedules API accepts. */
type AssigneeMode = "ROLE_AT_TARGET" | "USER";

/** Stepper rail dot — reads as completed (✓), current (ringed) or upcoming. */
function StepDot({ n, done, current, last }: { n: number; done: boolean; current: boolean; last?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
          done
            ? "bg-accent text-white"
            : current
              ? "border-2 border-accent bg-accent/10 text-accent-strong"
              : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
      </span>
      {!last && <span className={cn("mt-1 w-px flex-1", done ? "bg-accent/40" : "bg-border")} />}
    </div>
  );
}

function StepTitle({ label, recap }: { label: string; recap?: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
      <span className="text-[13.5px] font-bold">{label}</span>
      {recap && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{recap}</span>}
    </div>
  );
}

const RadioDot = ({ on }: { on: boolean }) => (
  <span className={cn("mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", on ? "border-accent" : "border-border")}>
    {on && <span className="h-[7px] w-[7px] rounded-full bg-accent" />}
  </span>
);

/** The "Schedule an audit" wizard as a self-contained, controlled dialog — a
 *  vertical stepper (template → scope → cadence & assignment). Reused from the
 *  Schedules panel and the Review Queue. Invalidates the schedules list on
 *  success. */
export function ScheduleCreateDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { role } = usePermissions();
  // Naming a single person across a recurring multi-property program is an
  // override of the org chart — keep it to the roles that own the whole audit
  // programme rather than everyone who can reach this dialog.
  const canAssignUser = isSuperAdminRole(role);

  const [tpl, setTpl] = React.useState<TemplateRow | null>(null);
  /* Scope is a RULE against the org hierarchy, not a frozen property list —
     the server re-resolves it at every occurrence, so estate changes are
     picked up without editing the schedule. */
  const [scopeLevel, setScopeLevel] = React.useState<ScopeLevel>("CITY");
  const [scopeIds, setScopeIds] = React.useState<Set<string>>(new Set());
  // The schedule's first occurrence. Presets are anchored on it the way Google
  // Calendar anchors "Weekly on Friday" to the event's own start date.
  const [startDate, setStartDate] = React.useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [timeOfDay, setTimeOfDay] = React.useState("09:00");
  const [rule, setRule] = React.useState<RecurrenceRule>(() => ({
    freq: "MONTHLY",
    interval: 1,
    byMonthDay: new Date().getDate(),
    end: { kind: "NEVER" },
  }));
  const [assigneeMode, setAssigneeMode] = React.useState<AssigneeMode>("ROLE_AT_TARGET");
  const [assigneeUserId, setAssigneeUserId] = React.useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: ["/audit/templates", "schedule-wizard"],
    queryFn: () => apiFetch<ApiList<TemplateRow>>("/audit/templates?limit=100"),
    enabled: open,
  });
  // A template is schedulable if it has ever been published — `lifecycle` tracks
  // the LATEST version, so it flips to DRAFT the moment a new version is forked.
  // Bind to publishedVersionId so authoring a v2 never hides or re-points v1.
  const templates = (templatesQuery.data?.data ?? []).filter((t) => t.publishedVersionId);

  /* People available for a named-individual assignment. Only loaded for the
     roles allowed to override the org chart. */
  const usersQuery = useQuery({
    queryKey: ["/users", "schedule-wizard"],
    queryFn: () => apiFetch<ApiList<UserRow>>("/users?limit=100"),
    enabled: open && canAssignUser,
  });
  const userOptions = React.useMemo(
    () => (usersQuery.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} · ${titleCase(u.role)}` })),
    [usersQuery.data],
  );
  const selectedUser = (usersQuery.data?.data ?? []).find((u) => u.id === assigneeUserId) ?? null;

  /* Options for the chosen level, straight from the org hierarchy. */
  const scopeOptionsQuery = useQuery({
    queryKey: ["/audit/schedules/view/scope-options", scopeLevel],
    queryFn: () => apiFetch<ApiList<ScopeOption>>(`/audit/schedules/view/scope-options?level=${scopeLevel}`),
    enabled: open && scopeLevel !== "ORG",
  });
  const scopeOptions = scopeOptionsQuery.data?.data ?? [];

  const scope = React.useMemo(
    () => ({ level: scopeLevel, ids: scopeLevel === "ORG" ? [] : [...scopeIds] }),
    [scopeLevel, scopeIds],
  );
  const scopeChosen = scopeLevel === "ORG" || scopeIds.size > 0;
  const scopeLabel =
    scopeLevel === "ORG"
      ? "Whole estate"
      : scopeIds.size === 1
        ? (scopeOptions.find((o) => scopeIds.has(o.id))?.name ?? `1 ${scopeLevel.toLowerCase()}`)
        : `${scopeIds.size} ${scopeLevel.toLowerCase()}${scopeLevel === "CITY" ? "ies" : "s"}`.replace("cityies", "cities");

  /* The audit type only SEEDS the persona; the planner can pick any of them.
     `roleTouched` stops the seed from clobbering a deliberate choice when the
     template is changed afterwards. */
  const [assigneeRole, setAssigneeRole] = React.useState<AssignableRole>("UNIT_LEAD");
  const [roleTouched, setRoleTouched] = React.useState(false);
  React.useEffect(() => {
    if (!tpl || roleTouched) return;
    setAssigneeRole(tpl.auditType === "UL" ? "UNIT_LEAD" : "CLUSTER_MANAGER");
  }, [tpl, roleTouched]);
  const targetNoun = tpl?.targetType === "ROOM" ? "room's property" : "property";

  /* Step completion drives both the rail and the footer hint. */
  const assigneeOk = assigneeMode === "ROLE_AT_TARGET" || !!assigneeUserId;
  const step1Done = !!tpl;
  const step2Done = step1Done && scopeChosen;
  const step3Done = step2Done && assigneeOk;
  const blocker = !step1Done
    ? "Pick a template to begin"
    : !step2Done
      ? "Pick a scope for the programme"
      : !assigneeOk
        ? "Pick the person these audits go to"
        : null;

  const reset = () => {
    setTpl(null); setScopeLevel("CITY"); setScopeIds(new Set());
    setAssigneeMode("ROLE_AT_TARGET"); setAssigneeUserId(null);
    setAssigneeRole("UNIT_LEAD"); setRoleTouched(false);
    const d = new Date(); d.setHours(0, 0, 0, 0);
    setStartDate(d); setTimeOfDay("09:00");
    setRule({ freq: "MONTHLY", interval: 1, byMonthDay: d.getDate(), end: { kind: "NEVER" } });
  };

  const createMut = useMutation({
    mutationFn: async () => {
      if (!tpl) throw new Error("Pick a template");
      if (assigneeMode === "USER" && !assigneeUserId) throw new Error("Pick an assignee");
      if (!scopeChosen) throw new Error("Pick a scope");
      const body = {
        title: `${tpl.name} · ${scopeLabel}`,
        templateVersionId: tpl.publishedVersionId,
        // The rule is authoritative — the server derives the legacy cadence
        // columns and the window end from it.
        recurrence: rule,
        timeOfDay,
        windowStart: iso(startDate),
        reminderOffsetMinutes: null,
        assigneeRule:
          assigneeMode === "USER"
            ? { kind: "USER" as const, userId: assigneeUserId! }
            : { kind: "ROLE_AT_TARGET" as const, role: assigneeRole },
        scope,
      };
      return apiFetch("/audit/schedules", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: "Schedule created — instances will generate on cadence" });
      reset();
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["/audit/schedules"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Could not create the schedule", variant: "destructive" }),
  });

  const canCreate = step3Done && !createMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[88vh] max-w-[640px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3 text-left">
          <DialogTitle className="text-base">Schedule an audit</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Step 1 · Template */}
          <div className="flex gap-4">
            <StepDot n={1} done={step1Done} current={!step1Done} />
            <div className="min-w-0 flex-1 pb-6">
              <StepTitle label="Template" recap={tpl ? `${tpl.name} · v${tpl.publishedVersionNo}` : undefined} />
              {templatesQuery.isLoading ? (
                <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-[11px]" />)}</div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {templates.map((t) => {
                    const on = tpl?.id === t.id;
                    // C-3: CX audits are ad-hoc "surprise" audits and the server
                    // 422s any CX schedule. Show it disabled with the reason
                    // rather than hiding it — silence reads as a missing template.
                    const adHocOnly = t.auditType === "CX";
                    return (
                      <button key={t.id} type="button" disabled={adHocOnly}
                        onClick={() => { setTpl(t); setScopeIds(new Set()); }}
                        title={adHocOnly ? "CX audits are ad-hoc only — create them from Audits › New Audit" : undefined}
                        className={cn(
                          "rounded-[11px] border px-[13px] py-[11px] text-left",
                          adHocOnly
                            ? "cursor-not-allowed border-dashed border-border bg-muted/30 opacity-70"
                            : on ? "border-accent bg-accent/5" : "border-border bg-card hover:border-accent/50",
                        )}>
                        <div className="flex items-center gap-2">
                          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] font-mono text-[9.5px] font-bold", TYPE_CHIP[t.auditType])}>{t.auditType}</span>
                          <span className="flex-1 truncate text-[13px] font-bold">{t.name}</span>
                          {on && <span className="text-sm font-bold text-accent">✓</span>}
                        </div>
                        <div className="mt-1 pl-9 text-[11px] text-muted-foreground">
                          {adHocOnly ? (
                            <span>Ad-hoc only — can't be scheduled</span>
                          ) : (
                            <>
                              {titleCase(t.targetType)} audit · v{t.publishedVersionNo}
                              {t.lifecycle !== "PUBLISHED" && t.latestVersionNo > (t.publishedVersionNo ?? 0) && (
                                <span className="text-muted-foreground/70"> · v{t.latestVersionNo} in draft</span>
                              )}
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                  {templates.length === 0 && <p className="text-sm text-muted-foreground">No published templates.</p>}
                </div>
              )}
            </div>
          </div>

          {/* Step 2 · Scope */}
          <div className="flex gap-4">
            <StepDot n={2} done={step2Done} current={step1Done && !step2Done} />
            <div className="min-w-0 flex-1 pb-6">
              <StepTitle
                label="Scope"
                recap={step2Done ? scopeLabel : undefined}
              />
              {!tpl ? (
                <p className="text-sm text-muted-foreground">Pick a template first.</p>
              ) : (
                <>
                  {/* Level first, then which ones — so "one property" and
                      "a whole zone" are the same two clicks. */}
                  <div className="flex flex-wrap gap-1.5">
                    {SCOPE_LEVELS.filter((l) => l.v !== "ROOM" || tpl.targetType === "ROOM").map((l) => (
                      <button
                        key={l.v}
                        type="button"
                        onClick={() => { setScopeLevel(l.v); setScopeIds(new Set()); }}
                        className={cn(
                          "rounded-full border px-3 py-[7px] text-[12.5px] font-semibold",
                          scopeLevel === l.v
                            ? "border-accent bg-accent text-white"
                            : "border-border bg-card text-foreground/80 hover:border-accent/50",
                        )}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>

                  {scopeLevel !== "ORG" && (
                    scopeOptionsQuery.isLoading ? (
                      <Skeleton className="mt-2.5 h-24 w-full rounded-[11px]" />
                    ) : scopeOptions.length === 0 ? (
                      <p className="mt-2.5 text-sm text-muted-foreground">
                        No {scopeLevel.toLowerCase()}s configured.
                      </p>
                    ) : (
                      <div className="mt-2.5 max-h-[190px] overflow-y-auto rounded-[11px] border border-border bg-background">
                        {scopeOptions.map((o) => {
                          const on = scopeIds.has(o.id);
                          return (
                            <button
                              key={o.id}
                              type="button"
                              onClick={() => setScopeIds((s2) => {
                                const x = new Set(s2);
                                x.has(o.id) ? x.delete(o.id) : x.add(o.id);
                                return x;
                              })}
                              className="flex w-full items-center gap-2.5 border-b border-dashed border-border px-3 py-2 text-left last:border-0 hover:bg-muted/50"
                            >
                              <span className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-2",
                                on ? "border-accent bg-accent text-white" : "border-border",
                              )}>
                                {on && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{o.name}</span>
                              {o.sublabel && (
                                <span className="shrink-0 text-[11.5px] text-muted-foreground">{o.sublabel}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )
                  )}

                  <div className="mt-3 rounded-[11px] border border-border bg-background px-[13px] py-[11px]">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-display text-[22px] font-extrabold text-accent-strong">{scopeLabel}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {tpl.targetType === "ROOM"
                        ? "Every room in scope gets its own audit"
                        : "Every property in scope gets its own audit instance"}
                      {" · re-checked every cycle, so new sites are picked up automatically"}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Step 3 · Cadence & assignment — assignment lives here rather than in
              a step of its own: it is one decision, and it only makes sense once
              the scope above is known. */}
          <div className="flex gap-4">
            <StepDot n={3} done={step3Done} current={step2Done && !step3Done} last />
            <div className="min-w-0 flex-1">
              <StepTitle
                label="Cadence & assignment"
                recap={describeRecurrence(rule)}
              />
              <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
                <div className="grid gap-1.5">
                  <span className="text-[11.5px] font-semibold text-muted-foreground">Repeats</span>
                  <RecurrenceEditor value={rule} onChange={setRule} startDate={startDate} />
                </div>
                <div className="grid gap-1.5">
                  <span className="text-[11.5px] font-semibold text-muted-foreground">Starts</span>
                  <div className="flex gap-1.5">
                    <input
                      type="date"
                      value={iso(startDate)}
                      onChange={(e) => {
                        const [y, m, d] = e.target.value.split("-").map(Number);
                        if (y && m && d) setStartDate(new Date(y, m - 1, d));
                      }}
                      className="h-9 rounded-[9px] border border-border bg-card px-2.5 text-[13px]"
                    />
                    <input
                      type="time"
                      value={timeOfDay}
                      onChange={(e) => setTimeOfDay(e.target.value)}
                      className="h-9 rounded-[9px] border border-border bg-card px-2.5 text-[13px]"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[12.5px] font-bold">Who runs it</span>
                  <span className="text-[11.5px] text-muted-foreground">Applied to every audit this schedule generates</span>
                </div>
                <div className="grid gap-2">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setAssigneeMode("ROLE_AT_TARGET")}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setAssigneeMode("ROLE_AT_TARGET"); }}
                    className={cn("cursor-pointer rounded-[11px] border px-[13px] py-[11px] text-left", assigneeMode === "ROLE_AT_TARGET" ? "border-accent bg-accent/5" : "border-border bg-card hover:border-accent/50")}
                  >
                    <div className="flex gap-2">
                      <RadioDot on={assigneeMode === "ROLE_AT_TARGET"} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold">Auto-assign by role</div>
                        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                          Resolved per {targetNoun} when the occurrence generates, so transfers and new
                          properties are picked up automatically. Recommended.
                        </p>

                        {/* Which persona. Whoever holds it at each property runs
                            that property's audit — so one schedule covers an
                            estate without naming anybody. */}
                        {assigneeMode === "ROLE_AT_TARGET" && (
                          <div className="mt-2.5">
                            <div className="flex flex-wrap gap-1.5">
                              {ASSIGNABLE_ROLES.map((r) => (
                                <button
                                  key={r}
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setAssigneeRole(r); setRoleTouched(true); }}
                                  className={cn(
                                    "rounded-full border px-2.5 py-[5px] text-[12px] font-semibold transition-colors",
                                    assigneeRole === r
                                      ? "border-accent bg-accent text-white"
                                      : "border-border bg-card text-foreground/75 hover:border-accent/50",
                                  )}
                                >
                                  {ASSIGNABLE_ROLE_LABELS[r]}
                                </button>
                              ))}
                            </div>
                            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                              Each audit goes to {ASSIGNABLE_ROLE_HINTS[assigneeRole]}. If nobody holds
                              it there, it escalates up the hierarchy rather than going unassigned.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Rendered only for the personas that may override the org chart —
                      a disabled card with no explanation would just look broken. */}
                  {canAssignUser && (
                    <button type="button" onClick={() => setAssigneeMode("USER")}
                      className={cn("rounded-[11px] border px-[13px] py-[11px] text-left", assigneeMode === "USER" ? "border-accent bg-accent/5" : "border-border bg-card hover:border-accent/50")}>
                      <div className="flex gap-2">
                        <RadioDot on={assigneeMode === "USER"} />
                        <div className="min-w-0">
                          <div className="text-[13px] font-bold">Assign to one specific person</div>
                          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                            Every audit from this schedule lands on the same named auditor.
                          </p>
                        </div>
                      </div>
                    </button>
                  )}
                </div>

                {assigneeMode === "USER" && (
                  <div className="mt-2.5 space-y-1.5">
                    <Combobox
                      options={userOptions}
                      value={assigneeUserId}
                      onChange={setAssigneeUserId}
                      allowClear
                      disabled={usersQuery.isLoading}
                      placeholder={usersQuery.isLoading ? "Loading people…" : "Search people by name or role"}
                      searchPlaceholder="Search people…"
                      emptyText="No matching user."
                    />
                    {scopeChosen && (
                      <p className="text-[11.5px] text-muted-foreground">
                        {tpl?.targetType === "ROOM"
                          ? `Every room audit across ${scopeLabel.toLowerCase()} will be assigned to this person.`
                          : `Every audit across ${scopeLabel.toLowerCase()} will be assigned to this person.`}
                      </p>
                    )}
                  </div>
                )}

                {assigneeMode === "ROLE_AT_TARGET" && (
                  <div className="mt-2.5 rounded-[11px] bg-info-soft px-3 py-2.5 text-[11.5px] font-semibold text-info">
                    ⚡ Auto-assigned to the <strong>{titleCase(assigneeRole)}</strong> of each {targetNoun}. Notified in-app.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action bar sits outside the scroll region so the CTA — and the reason
            it is disabled — stay visible while the planner works down the steps. */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">
              {tpl
                ? <>{tpl.name} · {describeRecurrence(rule)} · {scopeLabel}</>
                : "New audit schedule"}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
              {blocker ?? (assigneeMode === "USER"
                ? `Assigned to ${selectedUser?.name ?? "one person"}`
                : `Auto-assigned to the ${titleCase(assigneeRole)} at each ${targetNoun}`)}
            </div>
          </div>
          <Button className="h-[44px] px-5" disabled={!canCreate} onClick={() => createMut.mutate()}>
            {createMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Schedule →
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
