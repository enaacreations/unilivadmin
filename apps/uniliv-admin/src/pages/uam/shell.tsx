import * as React from "react";
import "./uam.css";

/**
 * The module's page frame.
 *
 * Every screen in User & Access Management opens with the same three lines: a
 * kicker naming the screen and what it is for, the question the screen answers
 * as a headline, and — when it helps — one sentence of plain English
 * underneath. That repetition is the point: an operator learns the shape once.
 *
 * `.uam` is where the module's palette and type live (see uam.css). It is a
 * scope, not a theme switch — the rest of the app keeps its own look.
 */
export function UamPage({
  kicker,
  title,
  lede,
  actions,
  header,
  width = 880,
  children,
}: {
  kicker?: string;
  title?: string;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Replaces the default kicker/title/lede block outright. A person's page
   * leads with an avatar, an inline status and a back link, which is a
   * different shape rather than a variation of this one.
   */
  header?: React.ReactNode;
  /** The design uses 880px for lists and 960px for the access check. */
  width?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="uam -mx-6 -mt-6 min-h-full sm:-mx-8">
      <div
        className="flex flex-col gap-[18px] px-6 py-7 sm:px-8"
        style={{ maxWidth: width, marginInline: "auto" }}
      >
        {header ?? (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2" style={{ flexBasis: 360 }}>
              <span className="uam-kicker font-medium">{kicker}</span>
              <h1 className="uam-title m-0" style={{ textWrap: "balance" }}>
                {title}
              </h1>
              {lede && <p className="uam-lede m-0 max-w-[600px] text-[14.5px]">{lede}</p>}
            </div>
            {actions}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * The state that matters most on an access screen, given its own surface.
 *
 * Used for "these people can sign in and see nothing" — a finding, not a row in
 * a table, because nobody scrolling a list would ever notice it there.
 */
export function UamNotice({
  tone = "warn",
  children,
  action,
}: {
  tone?: "warn" | "block";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const soft = tone === "warn" ? "var(--warn-soft)" : "var(--block-soft)";
  const line = tone === "warn" ? "var(--warn-line)" : "var(--block-line)";
  const dot = tone === "warn" ? "var(--warn)" : "var(--block)";
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[var(--r)] px-3.5 py-3"
      style={{ background: soft, border: `1px solid ${line}` }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
      <div className="min-w-[200px] flex-1 text-[14px] leading-[1.45]">{children}</div>
      {action}
    </div>
  );
}

/** Empty states carry a dashed edge — nothing is wrong, there is just nothing yet. */
export function UamEmpty({
  title,
  text,
  action,
  align = "start",
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
  /**
   * Centred when the empty state IS the panel — a tab with nothing in it reads
   * as a broken layout when its content hugs the left edge of a wide card.
   * Left-aligned when it sits in a column of other left-aligned content.
   */
  align?: "start" | "center";
}) {
  const centered = align === "center";
  return (
    <div
      className={`flex flex-col gap-2 rounded-[var(--r)] px-7 ${centered ? "items-center py-12 text-center" : "items-start py-8"}`}
      style={{ background: "var(--surface)", border: "1px dashed var(--line2)" }}
    >
      <span className="h-9 w-9 rounded-full" style={{ border: "1.5px dashed var(--line2)" }} />
      <span className="uam-title" style={{ fontSize: 18 }}>{title}</span>
      <span className="max-w-[460px] text-[14px] leading-[1.5]" style={{ color: "var(--ink2)" }}>
        {text}
      </span>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Initials, the way every avatar in this module draws them. */
export function UamAvatar({ name, size = 34 }: { name: string; size?: number }) {
  const ini = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold"
      style={{
        width: size, height: size,
        background: "var(--sunk)", border: "1px solid var(--line)",
        color: "var(--ink2)", fontSize: size * 0.37,
      }}
    >
      {ini}
    </span>
  );
}

/**
 * A role is not a person, and a list should not make you read to find out.
 * Square where an avatar is round, so the two are distinguishable at a glance
 * even at 22px in a dropdown row.
 */
export function UamRoleMark({ size = 24 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md font-semibold"
      style={{
        width: size, height: size,
        background: "var(--accent-soft)", border: "1px solid var(--line)",
        color: "var(--accent)", fontSize: Math.max(11, size * 0.42),
      }}
    >
      R
    </span>
  );
}

/** Enabled / Disabled, the module's two most-read words. */
export function UamVerdict({ allow, children }: { allow: boolean; children?: React.ReactNode }) {
  return (
    <span
      className="inline-flex h-6 items-center rounded-full px-[9px] text-[12.5px] font-semibold"
      style={{
        background: allow ? "var(--allow-soft)" : "var(--block-soft)",
        color: allow ? "var(--allow)" : "var(--block)",
      }}
    >
      {children ?? (allow ? "Enabled" : "Disabled")}
    </span>
  );
}

/** A reason, quoted. Serif italic, because it is someone's sentence. */
export function UamReason({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[15px] leading-[1.45]"
      style={{ fontStyle: "italic" }}
    >
      &ldquo;{children}&rdquo;
    </span>
  );
}

export function UamSeg<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="uam-seg overflow-x-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className="uam-seg-item whitespace-nowrap"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
