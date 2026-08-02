import * as React from "react"
import { Check, ChevronsUpDown, Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export interface MultiComboboxProps {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  creatable?: boolean
  disabled?: boolean
  className?: string
}

/** Multi-select combobox — selected values render as removable chips inside the
 *  trigger bar; the dropdown searches existing options and can create new ones.
 *  Built on the same Radix Popover + cmdk Command as the single-select Combobox.
 *  Case-insensitive throughout (dedupes "Kitchen" vs "kitchen"). */
export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  creatable = false,
  disabled = false,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const has = (v: string) => value.some((x) => x.toLowerCase() === v.toLowerCase())
  const toggle = (v: string) =>
    has(v) ? onChange(value.filter((x) => x.toLowerCase() !== v.toLowerCase())) : onChange([...value, v])
  const remove = (v: string) => onChange(value.filter((x) => x !== v))

  const trimmed = query.trim()
  const showCreate =
    creatable && trimmed.length > 0 &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase()) &&
    !has(trimmed)
  const create = () => {
    // Canonicalise to an existing option's casing when one matches.
    const canonical = options.find((o) => o.toLowerCase() === trimmed.toLowerCase()) ?? trimmed
    if (!has(canonical)) onChange([...value, canonical])
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery("") }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          {value.length === 0 && <span className="px-1 text-muted-foreground">{placeholder}</span>}
          {value.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pl-2 pr-1 font-medium">
              {t}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Remove ${t}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); remove(t) }}
                className="rounded-sm text-muted-foreground/70 hover:text-foreground"
              >
                <X className="size-3" />
              </span>
            </Badge>
          ))}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 self-center opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command filter={(v, s) => (v.toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64">
            {showCreate ? null : <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem key={opt} value={opt} onSelect={() => toggle(opt)}>
                  <Check className={cn("size-4", has(opt) ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{opt}</span>
                </CommandItem>
              ))}
              {showCreate ? (
                <CommandItem key="__create__" value={`__create__${trimmed}`} keywords={[trimmed]} onSelect={create}>
                  <Plus className="size-4" />
                  <span className="truncate">Add &ldquo;{trimmed}&rdquo;</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
