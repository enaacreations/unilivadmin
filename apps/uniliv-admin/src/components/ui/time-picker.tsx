import * as React from "react";
import { Clock, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * Structured 24h time picker. Replaces free-text "HH:MM" inputs (cut-off /
 * service times) where typos like "9:5" or "2100" slip through. Renders a
 * searchable list of discrete slots over a Popover + cmdk Command.
 *
 * The on-the-wire value is a zero-padded 24h string `"HH:MM"` (or `null` when
 * empty). Each slot is shown as 24h `"HH:MM"` with a faint 12h hint, e.g.
 * `21:00 · 9:00 PM`, so operators can scan in whichever format they think in.
 */

export interface TimePickerProps {
  /** Selected time as zero-padded 24h `"HH:MM"`, or `null`/`""` when unset. */
  value?: string | null;
  /** Called with the chosen slot as `"HH:MM"`. */
  onChange: (value: string) => void;
  /** Slot granularity in minutes. Default 15. */
  stepMinutes?: number;
  /** Inclusive lower bound `"HH:MM"`. Slots before this are excluded. */
  minTime?: string;
  /** Inclusive upper bound `"HH:MM"`. Slots after this are excluded. */
  maxTime?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/** Parse `"HH:MM"` into minutes since midnight, or `null` if malformed. */
function toMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Format minutes-since-midnight as zero-padded 24h `"HH:MM"`. */
function format24(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Format minutes-since-midnight as a 12h hint, e.g. `9:00 PM` / `12:30 AM`. */
function format12(totalMinutes: number): string {
  const h24 = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export function TimePicker({
  value,
  onChange,
  stepMinutes = 15,
  minTime,
  maxTime,
  placeholder = "Select time",
  disabled,
  className,
  id,
  ...rest
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false);

  // Build the slot list once per bounds/step change.
  const slots = React.useMemo(() => {
    const step = stepMinutes > 0 ? stepMinutes : 15;
    const lower = toMinutes(minTime) ?? 0;
    const upper = toMinutes(maxTime) ?? 23 * 60 + 59;
    const out: number[] = [];
    for (let t = 0; t <= 23 * 60 + 45; t += step) {
      if (t < lower || t > upper) continue;
      out.push(t);
    }
    return out;
  }, [stepMinutes, minTime, maxTime]);

  const selectedMinutes = toMinutes(value ?? null);
  const selected24 = selectedMinutes != null ? format24(selectedMinutes) : null;

  // Scroll the active slot into view whenever the list opens.
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open || selected24 == null) return;
    const id = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('[data-selected-value="true"]')
        ?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, selected24]);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={rest["aria-label"]}
          data-testid={rest["data-testid"]}
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal",
            !selected24 && "text-muted-foreground",
            className
          )}
        >
          <Clock className="mr-2 h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate tabular-nums">
            {selected24 ?? placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-52 p-0" align="start">
        <Command
          // Match on the 24h value, the 12h hint, and the bare hour digits.
          filter={(itemValue, search) => {
            const q = search.replace(/\s+/g, "").toLowerCase();
            if (!q) return 1;
            return itemValue.replace(/\s+/g, "").toLowerCase().includes(q) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search time…" />
          <CommandList ref={listRef} className="max-h-64">
            <CommandEmpty>No matching time.</CommandEmpty>
            {slots.map((t) => {
              const v24 = format24(t);
              const v12 = format12(t);
              const isSelected = v24 === selected24;
              return (
                <CommandItem
                  key={v24}
                  // cmdk lowercases the value; include both formats for search.
                  value={`${v24} ${v12}`}
                  data-selected-value={isSelected || undefined}
                  onSelect={() => {
                    onChange(v24);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 text-accent-strong",
                      isSelected ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="tabular-nums font-medium">{v24}</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {v12}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

TimePicker.displayName = "TimePicker";
