import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  titleCase, type ApiList, type AuditType, type Frequency, type ScheduleRow,
  type TemplateRow,
} from "./lib";
import { cn } from "@/lib/utils";

/* Schedule audits (redesign — prototype OE "Schedule audits"): a one-pass
 * wizard — pick a template, scope it by city, set the cadence — assignment is
 * automatic (ROLE_AT_TARGET). Below: the active schedules list. */

const TYPE_CHIP: Record<AuditType, string> = { UL: "bg-accent/10 text-accent-strong", CM: "bg-info-soft text-info", CX: "bg-muted text-muted-foreground" };
const FREQ_OPTS: { v: Frequency; label: string }[] = [
  { v: "MONTHLY", label: "Monthly" },
  { v: "FORTNIGHTLY", label: "Fortnightly" },
  { v: "WEEKLY", label: "Weekly" },
  { v: "QUARTERLY", label: "Quarterly" },
];
const FREQ_LABEL: Partial<Record<Frequency, string>> = { MONTHLY: "Monthly", WEEKLY: "Weekly", FORTNIGHTLY: "Fortnightly", QUARTERLY: "Quarterly", EVERY_N_DAYS: "Every N days", HALF_YEARLY: "Half-yearly", ANNUALLY: "Annually", CRON: "Custom" };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type TargetProp = { id: string; name: string; city: string | null };

export function SchedulesPanel({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tpl, setTpl] = React.useState<TemplateRow | null>(null);
  const [cities, setCities] = React.useState<Set<string>>(new Set());
  const [freq, setFreq] = React.useState<Frequency>("MONTHLY");
  const [dueDay, setDueDay] = React.useState(23);

  const templatesQuery = useQuery({
    queryKey: ["/audit/templates", "schedule-wizard"],
    queryFn: () => apiFetch<ApiList<TemplateRow>>("/audit/templates?limit=100"),
  });
  const templates = (templatesQuery.data?.data ?? []).filter((t) => t.lifecycle === "PUBLISHED");

  const propsQuery = useQuery({
    queryKey: ["/audits/target-properties", tpl?.auditType],
    queryFn: () => apiFetch<ApiList<TargetProp>>(`/audits/target-properties?auditType=${tpl!.auditType}`),
    enabled: !!tpl,
  });
  const properties = propsQuery.data?.data ?? [];
  const cityList = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const p of properties) { const c = p.city ?? "—"; m.set(c, (m.get(c) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [properties]);
  const scopedProps = React.useMemo(() => properties.filter((p) => cities.has(p.city ?? "—")), [properties, cities]);

  const schedulesQuery = useQuery({
    queryKey: ["/audit/schedules"],
    queryFn: () => apiFetch<ApiList<ScheduleRow>>("/audit/schedules?limit=200"),
  });

  const assigneeRole: "UNIT_LEAD" | "CLUSTER_MANAGER" = tpl?.auditType === "UL" ? "UNIT_LEAD" : "CLUSTER_MANAGER";
  const monthly = freq === "MONTHLY" || freq === "QUARTERLY";

  const createMut = useMutation({
    mutationFn: async () => {
      if (!tpl) throw new Error("Pick a template");
      // Scope → targets: PROPERTY templates use the properties directly; ROOM
      // templates expand to every schedulable room in the scoped properties.
      let targets: Array<{ targetType: "PROPERTY"; propertyId: string } | { targetType: "ROOM"; roomId: string }>;
      if (tpl.targetType === "ROOM") {
        const lists = await Promise.all(
          scopedProps.map((p) => apiFetch<ApiList<{ id: string }>>(`/audits/target-rooms?propertyId=${p.id}&auditType=${tpl.auditType}`)),
        );
        targets = lists.flatMap((l) => l.data).map((r) => ({ targetType: "ROOM" as const, roomId: r.id }));
      } else {
        targets = scopedProps.map((p) => ({ targetType: "PROPERTY" as const, propertyId: p.id }));
      }
      if (targets.length === 0) throw new Error("No targets in scope");
      const now = new Date();
      const ws = monthly ? new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, 28)) : now;
      const we = new Date(ws.getFullYear() + 1, ws.getMonth(), ws.getDate());
      const body = {
        title: `${tpl.name} · ${[...cities].join(", ")}`,
        templateVersionId: tpl.latestVersionId,
        frequency: freq,
        intervalDays: null,
        dayOfWeek: freq === "WEEKLY" ? 1 : null,
        cron: null,
        timeOfDay: "09:00",
        windowStart: iso(ws),
        windowEnd: iso(we),
        reminderOffsetMinutes: null,
        assigneeRule: { kind: "ROLE_AT_TARGET" as const, role: assigneeRole },
        targets,
      };
      return apiFetch("/audit/schedules", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: "Schedule created — instances will generate on cadence" });
      setTpl(null); setCities(new Set());
      qc.invalidateQueries({ queryKey: ["/audit/schedules"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Could not create the schedule", variant: "destructive" }),
  });

  const canCreate = !!tpl && scopedProps.length > 0 && !createMut.isPending;

  return (
    <div className="animate-fade-up space-y-5">
      {!embedded && (
        <div>
          <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Schedule audits</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">One pass: pick a template, scope it, set the cadence — assignment is automatic.</p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid gap-6 lg:grid-cols-3">
            {/* 1 · Template */}
            <div>
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">1 · Template</div>
              {templatesQuery.isLoading ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-[11px]" />)}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {templates.map((t) => {
                    const on = tpl?.id === t.id;
                    return (
                      <button key={t.id} type="button" onClick={() => { setTpl(t); setCities(new Set()); }}
                        className={cn("rounded-[11px] border px-[13px] py-[11px] text-left", on ? "border-accent bg-accent/5" : "border-border bg-card hover:border-accent/50")}>
                        <div className="flex items-center gap-2">
                          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] font-mono text-[9.5px] font-bold", TYPE_CHIP[t.auditType])}>{t.auditType}</span>
                          <span className="flex-1 truncate text-[13px] font-bold">{t.name}</span>
                          {on && <span className="text-sm font-bold text-accent">✓</span>}
                        </div>
                        <div className="mt-1 pl-9 text-[11px] text-muted-foreground">{titleCase(t.targetType)} audit · v{t.latestVersionNo}</div>
                      </button>
                    );
                  })}
                  {templates.length === 0 && <p className="text-sm text-muted-foreground">No published templates.</p>}
                </div>
              )}
            </div>

            {/* 2 · Scope */}
            <div>
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">2 · Scope</div>
              {!tpl ? (
                <p className="text-sm text-muted-foreground">Pick a template first.</p>
              ) : propsQuery.isLoading ? (
                <Skeleton className="h-24 w-full rounded-[11px]" />
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {cityList.map(([c, n]) => {
                      const on = cities.has(c);
                      return (
                        <button key={c} type="button" onClick={() => setCities((s) => { const x = new Set(s); x.has(c) ? x.delete(c) : x.add(c); return x; })}
                          className={cn("rounded-full border px-3 py-[7px] text-[12.5px] font-semibold", on ? "border-accent bg-accent text-white" : "border-border bg-card text-foreground/80 hover:border-accent/50")}>
                          {c} · {n}
                        </button>
                      );
                    })}
                    {cityList.length === 0 && <p className="text-sm text-muted-foreground">No schedulable properties.</p>}
                  </div>
                  <div className="mt-3 rounded-[11px] border border-border bg-background px-[13px] py-[11px]">
                    <div className="flex items-baseline gap-1.5"><span className="font-display text-[22px] font-extrabold text-accent-strong">{scopedProps.length}</span><span className="text-xs text-muted-foreground">properties in scope</span></div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{tpl.targetType === "ROOM" ? "Every room in scope gets its own audit" : "Every property gets its own audit instance"}</div>
                  </div>
                </>
              )}
            </div>

            {/* 3 · Cadence & assignee */}
            <div>
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">3 · Cadence &amp; assignee</div>
              <div className="flex flex-wrap gap-1.5">
                {FREQ_OPTS.map((f) => {
                  const on = freq === f.v;
                  return (
                    <button key={f.v} type="button" onClick={() => setFreq(f.v)}
                      className={cn("rounded-full border px-3 py-[7px] text-[12.5px] font-semibold", on ? "border-accent bg-accent text-white" : "border-border bg-card text-foreground/80 hover:border-accent/50")}>{f.label}</button>
                  );
                })}
              </div>
              {monthly && (
                <div className="mt-2.5 flex items-center gap-2 text-[12.5px] text-foreground/80">
                  Due day of month
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setDueDay((d) => Math.max(1, d - 1))} className="h-7 w-7 rounded-[7px] border border-border bg-card text-sm">−</button>
                    <span className="w-8 text-center font-mono text-[13px] font-bold">{dueDay}</span>
                    <button type="button" onClick={() => setDueDay((d) => Math.min(28, d + 1))} className="h-7 w-7 rounded-[7px] border border-border bg-card text-sm">+</button>
                  </div>
                </div>
              )}
              <div className="mt-2.5 rounded-[11px] bg-info-soft px-3 py-2.5 text-[11.5px] font-semibold text-info">
                ⚡ Auto-assigned to the <strong>{titleCase(assigneeRole)}</strong> of each {tpl?.targetType === "ROOM" ? "room's property" : "property"}. Notified in-app.
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <span className="text-[13.5px] font-semibold">
              {tpl ? <>{tpl.name} · {FREQ_LABEL[freq]}{monthly ? `, due ${dueDay}` : ""} · {scopedProps.length} {tpl.targetType === "ROOM" ? "properties (rooms)" : "properties"}</> : "Pick a template to begin"}
            </span>
            <span className="flex-1" />
            <Button className="h-[44px] px-5" disabled={!canCreate} onClick={() => createMut.mutate()}>
              {createMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Schedule →
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active schedules */}
      <Card>
        <CardContent className="px-[18px] py-4">
          <div className="mb-2.5 flex items-center">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Active schedules</span>
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-muted-foreground">{schedulesQuery.data?.data.length ?? 0}</span>
          </div>
          {schedulesQuery.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : (schedulesQuery.data?.data.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No schedules yet — create one above.</p>
          ) : (
            schedulesQuery.data!.data.map((s) => (
              <button key={s.id} type="button" onClick={() => navigate(`/audits/schedules/${s.id}`)}
                className="flex w-full items-center gap-3 border-b border-dashed border-border py-[9px] text-left last:border-0">
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] font-mono text-[9.5px] font-bold", TYPE_CHIP[s.auditType])}>{s.auditType}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-bold">{s.title}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">{s.targetCount} targets · {FREQ_LABEL[s.frequency] ?? titleCase(s.frequency)} · {s.assigneeRule.kind === "ROLE_AT_TARGET" ? `${titleCase(s.assigneeRule.role)}s` : "assigned"}</div>
                </div>
                <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{s.auditsGenerated} generated</span>
                <span className={cn("rounded-full px-[10px] py-[3px] text-[10.5px] font-bold", s.status === "ACTIVE" ? "bg-success-soft text-success" : "bg-muted text-muted-foreground")}>{titleCase(s.status)}</span>
              </button>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function Schedules() {
  return <SchedulesPanel />;
}
