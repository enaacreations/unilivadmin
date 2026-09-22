import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared vocabulary for the Access Control screens.
 *
 * From the Access Control redesign. Two rules run through all of it:
 *
 *  - Human label first, machine key second. 53 SCREAMING_SNAKE module keys as
 *    primary labels is what made the old preview read as a wall; the key stays
 *    as mono subtext where an engineer still needs it.
 *  - A denial is a thing you can see, not an omission. Every refused state has
 *    a rendering and a reason, because "why can't they?" is the question these
 *    screens exist to answer.
 */

/* ── Page furniture ────────────────────────────────────────────────────────── */

export function ScreenHeader({
  kicker, title, sub, actions,
}: {
  kicker: string;
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--card)] px-6 pb-4 pt-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
            {kicker}
          </div>
          <h1 className="font-display text-[27px] font-bold leading-tight tracking-[-0.02em]">
            {title}
          </h1>
          {sub && (
            <p className="mt-1.5 max-w-[62ch] text-[13px] text-[var(--muted)] [text-wrap:pretty]">
              {sub}
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]", className)}>
      {children}
    </div>
  );
}

export function CardHead({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-[18px] py-[13px]">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
        {children}
      </div>
      {right}
    </div>
  );
}

/* ── Badges ────────────────────────────────────────────────────────────────── */

type Tone = "neutral" | "coral" | "violet" | "ok" | "warn" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-[var(--muted-bg)] text-[var(--muted)] border-[var(--border)]",
  coral: "bg-[var(--coral-bg)] text-[var(--accent-strong)] border-[var(--accent)]",
  violet: "bg-[var(--violet-bg)] text-[var(--pop)] border-[var(--pop)]",
  ok: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]",
  warn: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]",
  danger: "bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger)]",
  info: "bg-[var(--info-bg)] text-[var(--info)] border-[var(--info)]",
};

export function Badge({
  tone = "neutral", mono, title, className, children,
}: {
  tone?: Tone; mono?: boolean; title?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        mono && "font-mono text-[9.5px] uppercase tracking-wide",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Node type marker — always mono and small; it is a classifier, not a label. */
export function NodeType({ type }: { type: string }) {
  return (
    <span className="shrink-0 rounded bg-[var(--muted-bg)] px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[var(--muted)]">
      {type}
    </span>
  );
}

export function GrantStatus({ status }: { status: "active" | "pending" | "expired" | "revoked" }) {
  const tone: Record<typeof status, Tone> = {
    active: "ok", pending: "info", expired: "neutral", revoked: "danger",
  } as never;
  return <Badge tone={tone[status]}>{status}</Badge>;
}

/* ── Matrix cell ───────────────────────────────────────────────────────────── */

export type CellState = "held" | "not-held" | "inherited" | "unavailable" | "protected";

/**
 * One capability cell.
 *
 * Five states, each visually distinct because conflating any two of them is how
 * an admin misreads the grid: `unavailable` (the action does not exist on this
 * module) must not look like `not-held` (it exists and is withheld), and
 * `inherited` must not look editable when it is computed.
 */
export function Cell({
  state, mark, title, onClick, size = 26,
}: {
  state: CellState; mark?: string; title?: string; onClick?: () => void; size?: number;
}) {
  const base = "inline-flex items-center justify-center rounded-md border text-[10px] font-semibold transition-colors";
  const styles: Record<CellState, string> = {
    held: "bg-[var(--accent)] text-white border-[var(--accent)]",
    "not-held": "bg-transparent text-[var(--ink3)] border-[var(--bd2)] hover:border-[var(--accent)]",
    inherited: "hatch border-[var(--bd2)] text-transparent cursor-not-allowed",
    unavailable: "bg-[var(--muted-bg)] border-transparent text-transparent cursor-not-allowed",
    protected: "bg-[var(--violet-bg)] border-[var(--pop)] text-[var(--pop)] cursor-not-allowed",
  };
  const interactive = onClick && (state === "held" || state === "not-held");
  return (
    <button
      type="button"
      title={title}
      disabled={!interactive}
      onClick={interactive ? onClick : undefined}
      style={{ width: size, height: size }}
      className={cn(base, styles[state], interactive ? "cursor-pointer" : "")}
    >
      {mark}
    </button>
  );
}

/** Compact per-family/module heat strip — one tick per action. */
export function HeatStrip({ cells }: { cells: Array<{ state: CellState; title: string }> }) {
  return (
    <span className="flex gap-[3px]">
      {cells.map((c, i) => (
        <span
          key={i}
          title={c.title}
          className={cn(
            "h-3 w-[7px] rounded-[2px]",
            c.state === "held" && "bg-[var(--accent)]",
            c.state === "not-held" && "border border-[var(--bd2)]",
            c.state === "unavailable" && "bg-[var(--muted-bg)]",
            c.state === "inherited" && "hatch border border-[var(--bd2)]",
            c.state === "protected" && "bg-[var(--violet-bg)] border border-[var(--pop)]",
          )}
        />
      ))}
    </span>
  );
}

/* ── Verdict ───────────────────────────────────────────────────────────────── */

/**
 * The headline answer, before any detail.
 *
 * The old preview made a reader assemble the verdict themselves from ~400
 * pills. This states it in a sentence and puts the evidence underneath.
 */
export function Verdict({
  tone, kicker, line, sub, children,
}: {
  tone: "ok" | "warn" | "danger" | "neutral";
  kicker: string; line: string; sub?: string; children?: React.ReactNode;
}) {
  const rail: Record<string, string> = {
    ok: "bg-[var(--success)]", warn: "bg-[var(--warning)]",
    danger: "bg-[var(--danger)]", neutral: "bg-[var(--bd2)]",
  };
  const text: Record<string, string> = {
    ok: "text-[var(--success)]", warn: "text-[var(--warning)]",
    danger: "text-[var(--danger)]", neutral: "text-[var(--muted)]",
  };
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <div className={cn("absolute inset-y-0 left-0 w-[3px]", rail[tone])} />
      <div className="px-5 pb-5 pt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className={cn("h-[7px] w-[7px] rounded-full", rail[tone])} />
          <span className={cn("text-[10.5px] font-semibold uppercase tracking-[0.08em]", text[tone])}>
            {kicker}
          </span>
        </div>
        <div className="max-w-[60ch] font-display text-[20px] font-semibold leading-snug tracking-[-0.015em] [text-wrap:pretty]">
          {line}
        </div>
        {sub && <p className="mt-2 max-w-[74ch] text-[13px] text-[var(--muted)] [text-wrap:pretty]">{sub}</p>}
        {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  );
}

/** Small stat tiles — hairline-separated, flat, no shadows. */
export function StatGrid({ items }: { items: Array<{ n: React.ReactNode; label: string }> }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--border)] [grid-template-columns:repeat(auto-fit,minmax(84px,1fr))]">
      {items.map((s, i) => (
        <div key={i} className="bg-[var(--card)] px-3 py-[11px]">
          <div className="font-display text-[20px] font-bold leading-none tracking-[-0.02em]">{s.n}</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.05em] text-[var(--muted)]">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Dashed empty state — distinct from an error, which is bordered and red. */
export function EmptyState({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-dashed border-[var(--bd2)] px-5 py-6 text-center">
      <div className="font-display text-[13.5px] font-semibold">{title}</div>
      {sub && <div className="mx-auto mt-1 max-w-[48ch] text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">{sub}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, sub, onRetry }: { title: string; sub?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-[10px] border border-[var(--danger)] bg-[var(--danger-bg)] px-4 py-[13px]">
      <div className="text-[13px] font-semibold text-[var(--danger)]">{title}</div>
      {sub && <div className="mt-1 text-[11.5px] text-[var(--muted)]">{sub}</div>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-lg border border-[var(--danger)] px-3 py-1.5 text-[11.5px] font-semibold text-[var(--danger)]"
        >
          Retry
        </button>
      )}
    </div>
  );
}
