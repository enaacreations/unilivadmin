import * as React from "react"
import { useLocation } from "wouter"

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"

export type CommandNavItem = {
  title: string
  href: string
  group: string
  icon?: any
}

export function CommandPalette({ items }: { items: CommandNavItem[] }) {
  const [open, setOpen] = React.useState(false)
  const [, setLocation] = useLocation()

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key?.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  // Preserve item order while grouping by `group`.
  const groups = React.useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, CommandNavItem[]>()

    for (const item of items) {
      if (!byGroup.has(item.group)) {
        byGroup.set(item.group, [])
        order.push(item.group)
      }
      byGroup.get(item.group)!.push(item)
    }

    return order.map((group) => ({ group, items: byGroup.get(group)! }))
  }, [items])

  const handleSelect = React.useCallback(
    (href: string) => {
      setOpen(false)
      setLocation(href)
    },
    [setLocation]
  )

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map(({ group, items: groupItems }) => (
          <CommandGroup key={group} heading={group}>
            {groupItems.map((item) => {
              const Icon = item.icon
              return (
                <CommandItem
                  key={item.href}
                  value={`${item.title} ${item.group}`}
                  onSelect={() => handleSelect(item.href)}
                >
                  {Icon ? <Icon className="text-muted-foreground" aria-hidden /> : null}
                  <span>{item.title}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
