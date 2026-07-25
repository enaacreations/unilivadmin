import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-fetch";
import {
  titleCase, type ApiList, type AuditType, type Frequency, type ScheduleRow,
} from "./lib";
import { cn } from "@/lib/utils";
import { ScheduleCreateDialog } from "./schedule-create-dialog";

/* Schedule audits: the active-schedules list, plus a "Schedule an audit"
 * button that opens the reusable create wizard (ScheduleCreateDialog). */

const TYPE_CHIP: Record<AuditType, string> = { UL: "bg-accent/10 text-accent-strong", CM: "bg-info-soft text-info", CX: "bg-muted text-muted-foreground" };
const FREQ_LABEL: Partial<Record<Frequency, string>> = { MONTHLY: "Monthly", WEEKLY: "Weekly", FORTNIGHTLY: "Fortnightly", QUARTERLY: "Quarterly", EVERY_N_DAYS: "Every N days", HALF_YEARLY: "Half-yearly", ANNUALLY: "Annually", CRON: "Custom" };

export function SchedulesPanel({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const [createOpen, setCreateOpen] = React.useState(false);

  const schedulesQuery = useQuery({
    queryKey: ["/audit/schedules"],
    queryFn: () => apiFetch<ApiList<ScheduleRow>>("/audit/schedules?limit=200"),
  });

  return (
    <div className="animate-fade-up space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {!embedded && (
          <div className="min-w-[220px] flex-1">
            <h1 className="font-display text-2xl font-bold tracking-[-0.012em]">Schedule audits</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Pick a template, scope it, set the cadence — assignment is automatic.</p>
          </div>
        )}
        <span className="flex-1" />
        <Button onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" /> Schedule an audit</Button>
      </div>

      <ScheduleCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

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
            <p className="py-6 text-center text-sm text-muted-foreground">No schedules yet — create one with “Schedule an audit”.</p>
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
