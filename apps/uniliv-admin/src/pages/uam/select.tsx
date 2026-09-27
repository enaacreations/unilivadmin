import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import "./uam.css";

/**
 * The module's one select.
 *
 * Every picker in UAM is this component, so they behave identically: a field
 * that shows the answer, and a panel that opens ON TOP of it holding a search
 * and the choices. A native <select> could not do the two things this module
 * needs most — search a list of fifty properties, and group choices under
 * headings so "Roles" and "Users", or "Complaints" and "Audit", are visibly
 * different kinds of thing rather than one flat alphabet.
 *
 * ── Why the panel covers the field ───────────────────────────────────────
 * When the panel is searchable it carries its own input, and showing that
 * BELOW the closed field puts two identical prompts on screen, one of them
 * dead. A negative offset of exactly the trigger height lands the search row
 * where the field's text was, so the control appears to become the search box.
 * A panel with no search has nothing to replace the field with, so it opens
 * below and leaves the current value readable. That rule is `covers` here.
 *
 * ── Why not portal the list out of <Command> ─────────────────────────────
 * The alternative — making the trigger literally be the CommandInput — needs
 * CommandList to live in the portalled popover while the input stays outside.
 * cmdk resolves its highlighted item by querying its own DOM subtree, and a
 * portalled list leaves that subtree. Covering gets the same feel with none of
 * that risk.
 */

export interface UamOption {
  value: string;
  label: string;
  /** Right-aligned secondary text: an email, a holder count, a reason. */
  hint?: string;
  /** Heading this option sits under. Groups render in first-seen order. */
  group?: string;
  /** Leading mark — an avatar, a shield, a swatch. */
  icon?: React.ReactNode;
  /** Dimmed: still choosable, but it will not do much (a disabled role). */
  muted?: boolean;
  /** Shown on the TRIGGER when this option is the value ("role", "person"). */
  kind?: string;
}

/** Above this many choices, scanning stops working and people want to type. */
const SEARCH_THRESHOLD = 8;

/** Trigger height in px — the panel offsets by exactly this to cover it. */
const TRIGGER_H = 40;

export function UamSelect({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  searchPlaceholder,
  emptyText = "Nothing by that name.",
  searchable,
  topN,
  disabled,
  className = "",
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: UamOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Defaults to true once the list is long enough to be worth searching. */
  searchable?: boolean;
  /** Show only this many per group until something is typed. */
  topN?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const canSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const searching = query.trim().length > 0;
  const selected = options.find((o) => o.value === value);

  // Groups in first-seen order; ungrouped options fall under one nameless
  // group so a flat list renders without a stray heading.
  const groups = React.useMemo(() => {
    const out = new Map<string, UamOption[]>();
    for (const o of options) {
      const key = o.group ?? "";
      out.set(key, [...(out.get(key) ?? []), o]);
    }
    return [...out.entries()];
  }, [options]);

  /** Whatever is picked stays in view, so reopening shows the current answer. */
  const shown = (list: UamOption[]) => {
    if (searching || !topN) return list;
    const top = list.slice(0, topN);
    const cur = list.find((o) => o.value === value);
    return cur && !top.includes(cur) ? [...top, cur] : top;
  };
  const hidden = topN && !searching
    ? groups.reduce((n, [, list]) => n + (list.length - shown(list).length), 0)
    : 0;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-expanded={open}
          className={`uam-input uam-input-fill flex h-10 items-center gap-2 text-left ${className}`}
        >
          {selected ? (
            <>
              {selected.icon}
              <span className="min-w-0 flex-1 truncate">{selected.label}</span>
              {selected.kind && (
                <span className="shrink-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                  {selected.kind}
                </span>
              )}
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--ink3)" }}>
              {placeholder}
            </span>
          )}
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      {/* `uam` on the content: Radix portals it out of the sheet, and the
          module's tokens are scoped to that class. */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={canSearch ? -TRIGGER_H : 6}
        avoidCollisions={!canSearch}
        className="uam uam-picker w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
        style={{ background: "var(--surface)", borderColor: "var(--line)" }}
      >
        <Command
          className="bg-transparent"
          filter={(val, search) => (val.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          {canSearch && (
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? placeholder}
              // Matches TRIGGER_H so the search row lands exactly where the
              // closed field's text was — no jump when it opens.
              className="h-10 text-[13.5px]"
            />
          )}
          <CommandList className="max-h-[300px]">
            <CommandEmpty className="py-6 text-center text-[13.5px]" style={{ color: "var(--ink3)" }}>
              {emptyText}
            </CommandEmpty>
            {groups.map(([heading, list]) => (
              <CommandGroup key={heading} heading={heading || undefined}>
                {shown(list).map((o) => (
                  <CommandItem
                    key={o.value}
                    // cmdk matches on this, so the hint is searchable too: an
                    // email finds a person, a holder count never gets in the way.
                    value={`${o.label} ${o.hint ?? ""} ${o.value}`}
                    onSelect={() => { onChange(o.value); setOpen(false); }}
                    // cmdk marks the highlighted row with data-selected, which
                    // the shared CommandItem paints in the APP's accent —
                    // unreadable against this module's palette.
                    className="cursor-pointer gap-2.5 py-2 text-[13.5px] data-[selected=true]:bg-[var(--sel)] data-[selected=true]:text-[var(--ink)]"
                    style={{ color: "var(--ink)", opacity: o.muted ? 0.6 : 1 }}
                  >
                    {o.icon}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && (
                      <span
                        className="shrink-0 truncate text-[12px]"
                        style={{ color: "var(--ink3)", maxWidth: 150 }}
                      >
                        {o.hint}
                      </span>
                    )}
                    {o.value === value && (
                      <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>

          {/* Without this the short list reads as the whole list. */}
          {hidden > 0 && (
            <div
              className="px-3 py-2 text-[12px]"
              style={{ borderTop: "1px solid var(--line)", color: "var(--ink3)" }}
            >
              Type to search {hidden} more.
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
