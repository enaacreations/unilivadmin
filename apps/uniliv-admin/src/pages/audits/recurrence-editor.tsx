/**
 * Google-Calendar-style recurrence picker: a preset dropdown plus a Custom…
 * dialog, editing the `RecurrenceRule` the scheduling engine consumes directly.
 *
 * Presets are anchored on the schedule's start date the way Calendar does it —
 * "Weekly on Friday" means whatever weekday `startDate` falls on — so changing
 * the start date re-labels the presets and re-derives the selected rule.
 */
import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DAYS_OF_WEEK,
  describeRecurrence,
  matchRecurrencePreset,
  recurrencePresets,
  toDateKey,
  weekdayPositionInMonth,
  type RecurrenceEnd,
  type RecurrenceRule,
} from "./lib";

const CUSTOM = "__custom__";
const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const UNITS = [
  { v: "DAILY", one: "day", many: "days" },
  { v: "WEEKLY", one: "week", many: "weeks" },
  { v: "MONTHLY", one: "month", many: "months" },
  { v: "YEARLY", one: "year", many: "years" },
] as const;
/** Rough 5-field shape check; the server re-validates before saving. */
const CRON_RE = /^(\S+\s+){4}\S+$/;

export function RecurrenceEditor({
  value,
  onChange,
  startDate,
  disabled,
}: {
  value: RecurrenceRule;
  onChange: (rule: RecurrenceRule) => void;
  startDate: Date;
  disabled?: boolean;
}) {
  const [customOpen, setCustomOpen] = React.useState(false);
  const presets = React.useMemo(() => recurrencePresets(startDate), [startDate]);
  const matched = matchRecurrencePreset(value, startDate);

  return (
    <>
      <div className="flex gap-1.5">
        <Select
          value={matched ?? CUSTOM}
          disabled={disabled}
          onValueChange={(key) => {
            if (key === CUSTOM) {
              setCustomOpen(true);
              return;
            }
            const preset = presets.find((p) => p.key === key);
            if (preset) onChange(preset.rule);
          }}
        >
          <SelectTrigger className="h-9 w-full text-[13px]">
            {/* A custom rule has no preset label, so show its description instead. */}
            <SelectValue>{matched ? presets.find((p) => p.key === matched)!.label : describeRecurrence(value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        {/* Selecting "Custom…" when the rule is already custom is a no-op change
            for the Select, so re-opening the dialog needs its own control. */}
        {!matched && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-9 shrink-0 text-[12.5px]"
            onClick={() => setCustomOpen(true)}
          >
            Edit
          </Button>
        )}
      </div>

      <CustomRecurrenceDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        value={value}
        startDate={startDate}
        onSave={(rule) => {
          onChange(rule);
          setCustomOpen(false);
        }}
      />
    </>
  );
}

function CustomRecurrenceDialog({
  open, onOpenChange, value, startDate, onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: RecurrenceRule;
  startDate: Date;
  onSave: (rule: RecurrenceRule) => void;
}) {
  // A CRON or NONE rule has no custom-dialog representation — open on a weekly
  // rule anchored to the start date rather than showing empty controls.
  const seed = React.useCallback((): RecurrenceRule => {
    if (value.freq === "NONE") {
      return { freq: "WEEKLY", interval: 1, byWeekday: [startDate.getDay()], end: { kind: "NEVER" } };
    }
    return value;
  }, [value, startDate]);

  const [draft, setDraft] = React.useState<RecurrenceRule>(seed);
  // Re-seed whenever the dialog opens so a cancelled edit is discarded.
  React.useEffect(() => {
    if (open) setDraft(seed());
  }, [open, seed]);

  const patch = (p: Partial<RecurrenceRule>) => setDraft((d) => ({ ...d, ...p }));
  const monthlyByPos = draft.bySetPos != null;
  const pos = weekdayPositionInMonth(startDate);

  const setFreq = (freq: RecurrenceRule["freq"]) => {
    // Each unit needs its own by-parts; carrying stale ones over produces
    // contradictory rules (e.g. a weekly rule holding a bySetPos).
    if (freq === "WEEKLY") {
      patch({ freq, byWeekday: draft.byWeekday?.length ? draft.byWeekday : [startDate.getDay()], bySetPos: null, byMonthDay: null });
    } else if (freq === "MONTHLY") {
      patch({ freq, byMonthDay: startDate.getDate(), bySetPos: null, byWeekday: [startDate.getDay()] });
    } else if (freq === "YEARLY") {
      patch({ freq, byMonth: startDate.getMonth() + 1, byMonthDay: startDate.getDate(), bySetPos: null, byWeekday: [] });
    } else if (freq === "CRON") {
      // AFTER is unrepresentable for cron (the server rejects it) — reset it.
      patch({
        freq,
        byWeekday: [], byMonthDay: null, bySetPos: null,
        end: draft.end.kind === "AFTER" ? { kind: "NEVER" } : draft.end,
      });
    } else {
      patch({ freq, byWeekday: [], byMonthDay: null, bySetPos: null });
    }
  };

  const toggleWeekday = (d: number) => {
    const on = draft.byWeekday ?? [];
    const next = on.includes(d) ? on.filter((x) => x !== d) : [...on, d].sort((a, b) => a - b);
    // At least one weekday must stay selected or the rule can never fire.
    if (next.length) patch({ byWeekday: next });
  };

  const setEnd = (end: RecurrenceEnd) => patch({ end });
  const invalid =
    (draft.freq === "WEEKLY" && !draft.byWeekday?.length) ||
    (draft.freq === "CRON" && !CRON_RE.test((draft.cron ?? "").trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader><DialogTitle>Custom recurrence</DialogTitle></DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="flex items-center gap-2">
            <Label className="text-[13px]">{draft.freq === "CRON" ? "Repeat on" : "Repeat every"}</Label>
            {draft.freq !== "CRON" && (
              <Input
                type="number"
                min={1}
                max={365}
                value={draft.interval}
                onChange={(e) => patch({ interval: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                className="h-9 w-16 text-[13px]"
              />
            )}
            <Select value={draft.freq} onValueChange={(v) => setFreq(v as RecurrenceRule["freq"])}>
              <SelectTrigger className="h-9 w-[120px] text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u.v} value={u.v}>{draft.interval > 1 ? u.many : u.one}</SelectItem>
                ))}
                <SelectItem value="CRON">cron expression</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.freq === "CRON" && (
            <div className="grid gap-1.5">
              <Label className="text-[13px]">Cron expression</Label>
              <Input
                value={draft.cron ?? ""}
                onChange={(e) => patch({ cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                className="h-9 font-mono text-[13px]"
              />
              <p className="text-[11.5px] text-muted-foreground">
                minute hour day-of-month month day-of-week
              </p>
            </div>
          )}

          {draft.freq === "WEEKLY" && (
            <div className="grid gap-1.5">
              <Label className="text-[13px]">Repeat on</Label>
              <div className="flex gap-1.5">
                {DAY_INITIALS.map((initial, d) => {
                  const on = draft.byWeekday?.includes(d) ?? false;
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-label={DAYS_OF_WEEK[d]}
                      aria-pressed={on}
                      onClick={() => toggleWeekday(d)}
                      className={cn(
                        "h-8 w-8 rounded-full border text-[12px] font-semibold transition-colors",
                        on
                          ? "border-accent bg-accent text-white"
                          : "border-border bg-card text-foreground/70 hover:border-accent/50",
                      )}
                    >
                      {initial}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {draft.freq === "MONTHLY" && (
            <Select
              value={monthlyByPos ? "POS" : "DAY"}
              onValueChange={(v) =>
                v === "POS"
                  ? patch({ bySetPos: pos, byWeekday: [startDate.getDay()], byMonthDay: null })
                  : patch({ bySetPos: null, byMonthDay: startDate.getDate() })
              }
            >
              <SelectTrigger className="h-9 text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DAY">Monthly on day {startDate.getDate()}</SelectItem>
                <SelectItem value="POS">
                  {recurrencePresets(startDate).find((p) => p.key === "MONTHLY")!.label}
                </SelectItem>
              </SelectContent>
            </Select>
          )}

          <div className="grid gap-1.5">
            <Label className="text-[13px]">Ends</Label>
            <div className="grid gap-2">
              <EndRow on={draft.end.kind === "NEVER"} onSelect={() => setEnd({ kind: "NEVER" })} label="Never" />
              <EndRow
                on={draft.end.kind === "ON"}
                onSelect={() => setEnd({ kind: "ON", date: toDateKey(startDate) })}
                label="On"
              >
                <Input
                  type="date"
                  disabled={draft.end.kind !== "ON"}
                  value={draft.end.kind === "ON" ? draft.end.date : ""}
                  onChange={(e) => setEnd({ kind: "ON", date: e.target.value })}
                  className="h-8 w-[150px] text-[13px]"
                />
              </EndRow>
              {draft.freq !== "CRON" && (
              <EndRow
                on={draft.end.kind === "AFTER"}
                onSelect={() => setEnd({ kind: "AFTER", count: 13 })}
                label="After"
              >
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  disabled={draft.end.kind !== "AFTER"}
                  value={draft.end.kind === "AFTER" ? draft.end.count : ""}
                  onChange={(e) => setEnd({ kind: "AFTER", count: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                  className="h-8 w-16 text-[13px]"
                />
                <span className="text-[12.5px] text-muted-foreground">occurrences</span>
              </EndRow>
              )}
            </div>
          </div>

          <p className="rounded-[9px] bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">
            {describeRecurrence(draft)}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={invalid} onClick={() => onSave(draft)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndRow({
  on, onSelect, label, children,
}: {
  on: boolean;
  onSelect: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={label}
        onClick={onSelect}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
          on ? "border-accent" : "border-border",
        )}
      >
        {on && <span className="h-[7px] w-[7px] rounded-full bg-accent" />}
      </button>
      <span className="w-12 text-[13px]">{label}</span>
      {children}
    </div>
  );
}
