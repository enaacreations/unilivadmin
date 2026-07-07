import * as React from "react"
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export interface NumberStepperProps {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  /** "sm" renders a compact h-7 control for dense rows (e.g. per-dish lists). */
  size?: "default" | "sm"
  /** Spinner layout: value with stacked up/down arrows instead of −/+ ends. */
  spin?: boolean
  "aria-label"?: string
  /** Static unit label shown after the input (used when `unitOptions` is absent). */
  unit?: string
  /** When provided, renders a compact unit dropdown next to the input. */
  unitOptions?: string[]
  /** Called with the newly selected unit. */
  onUnitChange?: (unit: string) => void
}

const clamp = (n: number, min?: number, max?: number) => {
  let next = n
  if (typeof min === "number" && next < min) next = min
  if (typeof max === "number" && next > max) next = max
  return next
}

// Full labels for unit dropdown codes. The option VALUE stays the raw code;
// only the displayed text is mapped. Unknown codes fall back to the raw value.
const UNIT_LABELS: Record<string, string> = {
  G: "Grams",
  g: "Grams",
  KG: "Kilograms",
  kg: "Kilograms",
  ML: "Millilitres",
  LITRE: "Litres",
  PCS: "Pieces",
  PLATE: "Plate",
  SERVING: "Serving",
  gram: "Grams",
  unit: "Unit",
}

// Weight units that auto-convert between one another.
const WEIGHT_UNITS = new Set(["kg", "gram", "g"])
const isKg = (u: string) => u === "kg"
const isGram = (u: string) => u === "gram" || u === "g"

/**
 * Convert `n` from `from` unit to `to` unit when both are weight units.
 * kg -> gram/g = x1000, gram/g -> kg = /1000. Otherwise returns `n` unchanged.
 */
const convertValue = (n: number, from: string, to: string): number => {
  if (!WEIGHT_UNITS.has(from) || !WEIGHT_UNITS.has(to)) return n
  if (isKg(from) && isGram(to)) return n * 1000
  if (isGram(from) && isKg(to)) return n / 1000
  return n
}

const NumberStepper = React.forwardRef<HTMLInputElement, NumberStepperProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      step = 1,
      disabled,
      className,
      size = "default",
      spin = false,
      "aria-label": ariaLabel,
      unit,
      unitOptions,
      onUnitChange,
    },
    ref
  ) => {
    const atMin = typeof min === "number" && value <= min
    const atMax = typeof max === "number" && value >= max
    const sm = size === "sm"

    const commit = (next: number) => {
      if (disabled) return
      onChange(clamp(next, min, max))
    }

    const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      // Ignore empty / non-numeric input; only commit parsable numbers.
      if (raw === "") return
      const parsed = Number(raw)
      if (Number.isNaN(parsed)) return
      commit(parsed)
    }

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      // Normalize on blur so the field never shows an out-of-range value.
      const parsed = Number(e.target.value)
      if (Number.isNaN(parsed)) return
      const next = clamp(parsed, min, max)
      if (next !== value) onChange(next)
    }

    const handleUnitChange = (next: string) => {
      if (disabled) return
      const prev = unit
      // Auto-convert the numeric value for weight<->weight switches; emit via onChange.
      if (typeof prev === "string" && prev !== next && !Number.isNaN(value)) {
        const converted = convertValue(value, prev, next)
        if (converted !== value) onChange(clamp(converted, min, max))
      }
      onUnitChange?.(next)
    }

    if (spin) {
      const arrowCls = cn(
        "flex flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        sm ? "w-5" : "w-6"
      )
      return (
        <div
          role="group"
          aria-label={ariaLabel}
          className={cn(
            "inline-flex items-stretch overflow-hidden rounded-md border border-input bg-transparent",
            sm ? "h-7" : "h-9",
            disabled && "cursor-not-allowed opacity-50",
            className
          )}
        >
          <Input
            ref={ref}
            type="number"
            inputMode="numeric"
            value={Number.isNaN(value) ? "" : value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={ariaLabel}
            onChange={handleInput}
            onBlur={handleBlur}
            className={cn(
              "h-full rounded-none border-0 px-1 text-center tabular-nums",
              sm ? "w-10 text-xs" : "w-12",
              "focus-visible:ring-0 focus-visible:border-transparent",
              "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            )}
          />
          <div className="flex flex-col border-l border-input">
            <button type="button" aria-label="Increase" disabled={disabled || atMax}
              onClick={() => commit(value + step)} className={cn(arrowCls, "border-b border-input")}>
              <ChevronUp className={sm ? "h-3 w-3" : "h-3.5 w-3.5"} />
            </button>
            <button type="button" aria-label="Decrease" disabled={disabled || atMin}
              onClick={() => commit(value - step)} className={arrowCls}>
              <ChevronDown className={sm ? "h-3 w-3" : "h-3.5 w-3.5"} />
            </button>
          </div>
          {unit ? (
            <span className={cn("self-center pl-1 pr-2 text-muted-foreground", sm ? "text-xs" : "text-sm")}>{unit}</span>
          ) : null}
        </div>
      )
    }

    const stepper = (
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center rounded-md border border-input bg-transparent",
          sm ? "h-7" : "h-9",
          disabled && "cursor-not-allowed opacity-50",
          !unitOptions && className
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Decrease"
          disabled={disabled || atMin}
          onClick={() => commit(value - step)}
          className={cn(
            "rounded-r-none border-0 border-r border-input",
            sm ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5" : "h-9 w-9"
          )}
        >
          <Minus />
        </Button>
        <Input
          ref={ref}
          type="number"
          inputMode="decimal"
          value={Number.isNaN(value) ? "" : value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={handleInput}
          onBlur={handleBlur}
          className={cn(
            "rounded-none border-0 px-1 text-center tabular-nums",
            sm ? "h-7 w-12 text-xs" : "h-9 w-14",
            "focus-visible:ring-0 focus-visible:border-transparent",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          )}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Increase"
          disabled={disabled || atMax}
          onClick={() => commit(value + step)}
          className={cn(
            "rounded-l-none border-0 border-l border-input",
            sm ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5" : "h-9 w-9"
          )}
        >
          <Plus />
        </Button>
        {!unitOptions && unit ? (
          <span className={cn("pl-1 pr-2 text-muted-foreground", sm ? "text-xs" : "text-sm")}>{unit}</span>
        ) : null}
      </div>
    )

    if (!unitOptions) return stepper

    return (
      <div className={cn("inline-flex items-center gap-1.5", className)}>
        {stepper}
        <Select
          value={unit}
          onValueChange={handleUnitChange}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label="Unit"
            className="h-9 w-auto min-w-[4.5rem] gap-1 px-2 text-sm"
          >
            <SelectValue placeholder="Unit" />
          </SelectTrigger>
          <SelectContent>
            {unitOptions.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {UNIT_LABELS[opt] ?? opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }
)
NumberStepper.displayName = "NumberStepper"

export { NumberStepper }
