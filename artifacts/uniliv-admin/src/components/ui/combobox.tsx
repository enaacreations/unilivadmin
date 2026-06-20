import * as React from "react"
import { Check, ChevronsUpDown, Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export type ComboboxOption = {
  value: string
  label: string
  keywords?: string[]
}

export interface ComboboxProps {
  options: ComboboxOption[]
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  allowClear?: boolean
  creatable?: boolean
  createLabel?: (query: string) => string
}

const Combobox = React.forwardRef<HTMLButtonElement, ComboboxProps>(
  (
    {
      options,
      value,
      onChange,
      placeholder = "Select an option",
      searchPlaceholder = "Search…",
      emptyText = "No results found.",
      disabled,
      className,
      allowClear = false,
      creatable = false,
      createLabel = (query) => `Create "${query}"`,
    },
    ref
  ) => {
    const [open, setOpen] = React.useState(false)
    const [query, setQuery] = React.useState("")

    const selected = React.useMemo(
      () => options.find((option) => option.value === value) ?? null,
      [options, value]
    )

    // Display label for the trigger: a matching option's label, otherwise the
    // raw value itself (legacy/custom values not present in `options`).
    const displayLabel =
      selected?.label ?? (value != null && value !== "" ? value : null)

    const hasValue = displayLabel != null

    const showClear = allowClear && hasValue && !disabled

    const trimmedQuery = query.trim()
    const showCreate =
      creatable &&
      trimmedQuery.length > 0 &&
      !options.some(
        (option) => option.label.toLowerCase() === trimmedQuery.toLowerCase()
      )

    const handleCreate = () => {
      onChange(trimmedQuery)
      setQuery("")
      setOpen(false)
    }

    const handleClear = (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      onChange(null)
    }

    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-full justify-between font-normal",
              !hasValue && "text-muted-foreground",
              className
            )}
          >
            <span className="truncate">
              {hasValue ? displayLabel : placeholder}
            </span>
            <span className="ml-2 flex shrink-0 items-center gap-1">
              {showClear ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Clear selection"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={handleClear}
                  className="rounded-sm text-muted-foreground/70 hover:text-foreground"
                >
                  <X className="size-4" />
                </span>
              ) : null}
              <ChevronsUpDown className="size-4 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
        >
          <Command
            filter={(itemValue, search, keywords) => {
              const haystack = [itemValue, ...(keywords ?? [])]
                .join(" ")
                .toLowerCase()
              return haystack.includes(search.toLowerCase()) ? 1 : 0
            }}
          >
            <CommandInput
              placeholder={searchPlaceholder}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-64">
              {showCreate ? null : <CommandEmpty>{emptyText}</CommandEmpty>}
              <CommandGroup>
                {options.map((option) => {
                  const isSelected = option.value === value
                  return (
                    <CommandItem
                      key={option.value}
                      value={option.label}
                      keywords={[option.value, ...(option.keywords ?? [])]}
                      onSelect={() => {
                        onChange(
                          allowClear && isSelected ? null : option.value
                        )
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="truncate">{option.label}</span>
                    </CommandItem>
                  )
                })}
                {showCreate ? (
                  <CommandItem
                    key="__create__"
                    value={`__create__${trimmedQuery}`}
                    keywords={[trimmedQuery]}
                    onSelect={handleCreate}
                  >
                    <Plus className="size-4" />
                    <span className="truncate">
                      {createLabel(trimmedQuery)}
                    </span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    )
  }
)
Combobox.displayName = "Combobox"

export { Combobox }
