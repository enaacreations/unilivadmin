import * as React from "react";
import { format, parse, isValid } from "date-fns";
import { Calendar as CalendarIcon, X } from "lucide-react";
import { Controller, type Control } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * App-wide date pickers built on the shadcn Calendar. The on-the-wire value is an
 * ISO date string `yyyy-MM-dd` (or `yyyy-MM-ddTHH:mm` for the datetime variant) —
 * a drop-in replacement for native `<input type="date">` that avoids the IST
 * day-shift you get from `new Date(isoString)` parsing in UTC.
 */

const ISO = "yyyy-MM-dd";
const ISO_DT = "yyyy-MM-dd'T'HH:mm";

function parseLocal(value: string | null | undefined, fmt: string): Date | undefined {
  if (!value) return undefined;
  const d = parse(value, fmt, new Date());
  return isValid(d) ? d : undefined;
}

export interface DatePickerProps {
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Inclusive bounds, `yyyy-MM-dd`. */
  min?: string;
  max?: string;
  id?: string;
  clearable?: boolean;
  /** date-fns display format for the trigger label. */
  displayFormat?: string;
  "data-testid"?: string;
  "aria-label"?: string;
}

export function DatePicker({
  value, onChange, placeholder = "Pick a date", disabled, className,
  min, max, id, clearable, displayFormat = "dd MMM yyyy", ...rest
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseLocal(value, ISO);
  const minD = parseLocal(min, ISO);
  const maxD = parseLocal(max, ISO);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid={rest["data-testid"]}
          aria-label={rest["aria-label"]}
          className={cn("w-full justify-start text-left font-normal", !selected && "text-muted-foreground", className)}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate">{selected ? format(selected, displayFormat) : placeholder}</span>
          {clearable && selected && !disabled && (
            <X
              className="ml-auto h-4 w-4 shrink-0 opacity-60 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); onChange(""); }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => { if (d) onChange(format(d, ISO)); setOpen(false); }}
          disabled={(date) => (!!minD && date < minD) || (!!maxD && date > maxD)}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateTimePickerProps extends Omit<DatePickerProps, "displayFormat"> {
  /** Value is `yyyy-MM-ddTHH:mm`. */
}

export function DateTimePicker({
  value, onChange, placeholder = "Pick date & time", disabled, className, min, max, id, ...rest
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false);
  const dt = parseLocal(value, ISO_DT) ?? parseLocal(value, ISO);
  const datePart = dt ? format(dt, ISO) : "";
  const timePart = dt ? format(dt, "HH:mm") : "";

  const emit = (d: string, t: string) => {
    if (!d) { onChange(""); return; }
    onChange(`${d}T${t || "00:00"}`);
  };

  const minD = parseLocal(min, ISO);
  const maxD = parseLocal(max, ISO);

  return (
    <div className={cn("flex gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            data-testid={rest["data-testid"]}
            aria-label={rest["aria-label"]}
            className={cn("flex-1 justify-start text-left font-normal", !dt && "text-muted-foreground")}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
            <span className="truncate">{dt ? format(dt, "dd MMM yyyy") : placeholder}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={dt}
            defaultMonth={dt}
            onSelect={(d) => { if (d) emit(format(d, ISO), timePart); setOpen(false); }}
            disabled={(date) => (!!minD && date < minD) || (!!maxD && date > maxD)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        value={timePart}
        disabled={disabled || !datePart}
        onChange={(e) => emit(datePart, e.target.value)}
        className="w-[7.5rem]"
        aria-label="Time"
      />
    </div>
  );
}

/** React-Hook-Form bound DatePicker. Stores `yyyy-MM-dd`. */
export function ControlledDatePicker({
  control, name, ...props
}: { control: Control<any>; name: string } & Omit<DatePickerProps, "value" | "onChange">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <DatePicker value={field.value ?? ""} onChange={field.onChange} {...props} />
      )}
    />
  );
}
