import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay,
  isSameMonth, isToday, startOfMonth, startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight, List } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import {
  AUDIT_STATE_CHIP, titleCase,
  type ApiOne, type CalendarAudit, type CalendarProjection,
} from "./lib";

const LEGEND_STATES = ["SCHEDULED", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED"] as const;

/** Month calendar (FRD-SCH-05): materialized audits + projected occurrences
 *  past the materialization horizon, so planners see the full pipeline. */
export default function ScheduleCalendar() {
  const [, navigate] = useLocation();
  const [month, setMonth] = React.useState(() => startOfMonth(new Date()));

  const from = startOfMonth(month);
  const to = endOfMonth(month);

  const calendarQuery = useQuery({
    queryKey: ["/audit/schedules/view/calendar", format(from, "yyyy-MM")],
    queryFn: () =>
      apiFetch<ApiOne<{ audits: CalendarAudit[]; projected: CalendarProjection[] }>>(
        `/audit/schedules/view/calendar?from=${from.toISOString()}&to=${to.toISOString()}`,
      ),
  });

  const days = React.useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(from, { weekStartsOn: 1 }),
        end: endOfWeek(to, { weekStartsOn: 1 }),
      }),
    [from, to],
  );

  const data = calendarQuery.data?.data;
  const auditsOn = (day: Date) =>
    (data?.audits ?? []).filter((a) => isSameDay(new Date(a.scheduledFor), day));
  const projectedOn = (day: Date) =>
    (data?.projected ?? []).filter((p) => isSameDay(new Date(p.occurrence), day));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Schedule Calendar"
        subtitle="Materialized audits (solid, coloured by state) and projected occurrences (dashed) per day."
        breadcrumbs={[
          { label: "Audits" },
          { label: "Schedules", href: "/audits/schedules" },
          { label: "Calendar" },
        ]}
        action={
          <Button variant="outline" size="sm" onClick={() => navigate("/audits/schedules")}>
            <List className="mr-1 h-4 w-4" /> Schedule list
          </Button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="ml-3 font-display text-lg font-semibold">{format(month, "MMMM yyyy")}</h2>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {LEGEND_STATES.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", AUDIT_STATE_CHIP[s])} />
              {titleCase(s)}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm ring-2 ring-destructive" />
            Overdue
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground" />
            Projected
          </span>
        </div>
      </div>

      {calendarQuery.isLoading ? (
        <Skeleton className="h-[560px] w-full" />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <div className="min-w-[840px]">
            <div className="grid grid-cols-7 border-b">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const inMonth = isSameMonth(day, month);
                const audits = inMonth ? auditsOn(day) : [];
                const projected = inMonth ? projectedOn(day) : [];
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      "min-h-[104px] space-y-1 border-b border-r p-1.5 align-top",
                      !inMonth && "bg-muted/40",
                    )}
                  >
                    <p
                      className={cn(
                        "text-xs tabular-nums",
                        isToday(day)
                          ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {format(day, "d")}
                    </p>
                    {audits.map((a) => (
                      <Link
                        key={a.id}
                        href={`/audits/${a.id}`}
                        title={`${a.title}${a.propertyName ? ` · ${a.propertyName}` : ""} — ${titleCase(a.state)}${a.isOverdue ? " (overdue)" : ""}`}
                        className={cn(
                          "block truncate rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
                          AUDIT_STATE_CHIP[a.state] ?? "bg-muted text-muted-foreground",
                          a.isOverdue && "ring-2 ring-destructive",
                        )}
                      >
                        {a.ticketNo}
                      </Link>
                    ))}
                    {projected.map((p, i) => (
                      <div
                        key={`${p.scheduleId}-${i}`}
                        title={`${p.title} — projected, ${p.targetCount} target(s)`}
                        className="truncate rounded border border-dashed border-muted-foreground/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {p.title} ×{p.targetCount}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
