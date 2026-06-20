import * as React from "react"
import { Minus, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface NumberStepperProps {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

const clamp = (n: number, min?: number, max?: number) => {
  let next = n
  if (typeof min === "number" && next < min) next = min
  if (typeof max === "number" && next > max) next = max
  return next
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
      "aria-label": ariaLabel,
    },
    ref
  ) => {
    const atMin = typeof min === "number" && value <= min
    const atMax = typeof max === "number" && value >= max

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

    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-input bg-transparent",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Decrease"
          disabled={disabled || atMin}
          onClick={() => commit(value - step)}
          className="h-9 w-9 rounded-r-none border-0 border-r border-input"
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
            "h-9 w-14 rounded-none border-0 px-1 text-center tabular-nums",
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
          className="h-9 w-9 rounded-l-none border-0 border-l border-input"
        >
          <Plus />
        </Button>
      </div>
    )
  }
)
NumberStepper.displayName = "NumberStepper"

export { NumberStepper }
