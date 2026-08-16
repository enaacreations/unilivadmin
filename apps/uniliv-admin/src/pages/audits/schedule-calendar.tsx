import * as React from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay,
  isSameMonth, isToday, startOfMonth, startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import {
  AUDIT_STATE_CHIP, describeRecurrence, titleCase, toDateKey,
  type ApiOne, type CalendarAudit, type CalendarProjection, type CalendarSkip,
  type RecurrenceRule,
} from "./lib";
import { RecurrenceEditor } from "./recurrence-editor";

const LEGEND_STATES = ["SCHEDULED", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED"] as const;

/**
 * Month calendar (FRD-SCH-05): materialized audits + projected occurrences past
 * the materialization horizon, so planners see the full pipeline.
 *
 * Rendered as a view of the Schedules page rather than a page of its own — the
 * list and the calendar are two readings of the same thing.
 */
export function ScheduleCalendarPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canEdit = can("AUDIT_SCHEDULES", "edit");
  const [month, setMonth] = React.useState(() => startOfMonth(new Date()));
  /** The occurrence a "this and following" edit is being composed for. */
  const [splitting, setSplitting] = React.useState<{ p: CalendarProjection; date: Date } | null>(null);

  const from = startOfMonth(month);
  const to = endOfMonth(month);

  const calendarQuery = useQuery({
    queryKey: ["/audit/schedules/view/calendar", format(from, "yyyy-MM")],
    queryFn: () =>
      apiFetch<ApiOne<{ audits: CalendarAudit[]; projected: CalendarProjection[]; skipped: CalendarSkip[] }>>(
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
  const skippedOn = (day: Date) =>
    (data?.skipped ?? []).filter((s) => s.date === toDateKey(day));

  const refresh = () => qc.invalidateQueries({ queryKey: ["/audit/schedules/view/calendar"] });

  const occurrenceMut = useMutation({
    mutationFn: ({ scheduleId, date, action }: { scheduleId: string; date: string; action: "skip" | "restore" }) =>
      apiFetch(`/audit/schedules/${scheduleId}/occurrences/${action}`, {
        method: "POST",
        body: JSON.stringify({ date }),
      }),
    onSuccess: (_r, v) => {
      toast({ title: v.action === "skip" ? "Occurrence skipped" : "Occurrence restored" });
      refresh();
    },
    onError: (e: Error) => toast({ title: e.message || "Could not update", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
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
          <span className="flex items-center gap-1 line-through decoration-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground/40" />
            Skipped
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
                const skipped = inMonth ? skippedOn(day) : [];
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
                    {projected.map((p, i) => {
                      const label = `${p.title} ×${p.targetCount}`;
                      const chip = (
                        <div
                          title={`${p.title} — projected, ${p.targetCount} target(s)`}
                          className={cn(
                            "truncate rounded border border-dashed border-muted-foreground/50 px-1.5 py-0.5 text-left text-[11px] text-muted-foreground",
                            canEdit && "w-full cursor-pointer hover:border-solid hover:bg-muted/60",
                          )}
                        >
                          {label}
                        </div>
                      );
                      if (!canEdit) return <div key={`${p.scheduleId}-${i}`}>{chip}</div>;
                      return (
                        <Popover key={`${p.scheduleId}-${i}`}>
                          <PopoverTrigger asChild>
                            <button type="button" className="w-full">{chip}</button>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-60 p-1.5">
                            <p className="px-2 pb-1.5 pt-1 text-[12px] font-semibold">{p.title}</p>
                            <p className="px-2 pb-2 text-[11.5px] text-muted-foreground">
                              {format(day, "EEEE d MMM yyyy")} · {p.targetCount} target(s)
                            </p>
                            <button
                              type="button"
                              disabled={occurrenceMut.isPending}
                              onClick={() =>
                                occurrenceMut.mutate({ scheduleId: p.scheduleId, date: toDateKey(day), action: "skip" })
                              }
                              className="w-full rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
                            >
                              Skip this occurrence
                            </button>
                            <button
                              type="button"
                              onClick={() => setSplitting({ p, date: day })}
                              className="w-full rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
                            >
                              Change this and following…
                            </button>
                          </PopoverContent>
                        </Popover>
                      );
                    })}
                    {skipped.map((sk, i) => (
                      <div
                        key={`skip-${sk.scheduleId}-${i}`}
                        title={`${sk.title} — skipped`}
                        className="flex items-center gap-1 truncate rounded border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/60"
                      >
                        <span className="truncate line-through">{sk.title}</span>
                        {canEdit && (
                          <button
                            type="button"
                            title="Restore this occurrence"
                            disabled={occurrenceMut.isPending}
                            onClick={() =>
                              occurrenceMut.mutate({ scheduleId: sk.scheduleId, date: sk.date, action: "restore" })
                            }
                            className="ml-auto shrink-0 rounded p-0.5 hover:bg-muted"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {splitting && (
        <SplitDialog
          projection={splitting.p}
          date={splitting.date}
          onClose={() => setSplitting(null)}
          onDone={() => {
            setSplitting(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * "This and following": the original schedule is truncated to end the day
 * before this occurrence, and a successor carries the new cadence forward from
 * it. Two schedules by design — the audits already generated stay attached to
 * the original, which the trail depends on.
 */
function SplitDialog({
  projection, date, onClose, onDone,
}: {
  projection: CalendarProjection;
  date: Date;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [rule, setRule] = React.useState<RecurrenceRule>({
    freq: "WEEKLY",
    interval: 1,
    byWeekday: [date.getDay()],
    end: { kind: "NEVER" },
  });

  const splitMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/schedules/${projection.scheduleId}/split`, {
        method: "POST",
        body: JSON.stringify({ fromDate: toDateKey(date), recurrence: rule }),
      }),
    onSuccess: () => {
      toast({ title: "Schedule split — the new cadence starts from this date" });
      onDone();
    },
    onError: (e: Error) => toast({ title: e.message || "Split failed", variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Change this and following</DialogTitle>
          <DialogDescription>
            {projection.title} — from {format(date, "EEEE d MMM yyyy")} onward.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-1">
          <span className="text-[11.5px] font-semibold text-muted-foreground">New cadence</span>
          <RecurrenceEditor value={rule} onChange={setRule} startDate={date} />
          <p className="rounded-[9px] bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
            Occurrences before this date keep the current cadence. {describeRecurrence(rule)} applies
            from {format(date, "d MMM")}.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={splitMut.isPending} onClick={() => splitMut.mutate()}>
            {splitMut.isPending ? "Splitting…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
