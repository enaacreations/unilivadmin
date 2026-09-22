import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search, ShieldCheck, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  accessApi,
  accessKeys,
  activityApi,
  activityKeys,
  type ActivityEvent,
  type ActivityLabel,
} from "@/lib/access-api";
import { ScreenHeader, Card, Badge, EmptyState } from "./ui";

/**
 * Activity trail (PRD §29).
 *
 * §29 requires each event to record User, Timestamp, Action, Entity, Previous
 * value, New value and "Reason where required" — so a row is not a log line,
 * it is a change with a before and an after. The list stays scannable and the
 * diff opens on demand; `changedKeys` is what lets the collapsed row say how
 * much moved without loading the payload.
 */

const CAT_TONE: Record<string, "coral" | "violet" | "ok" | "warn" | "danger" | "info" | "neutral"> = {
  ACCESS: "violet",
  SECURITY: "danger",
  LIFECYCLE: "ok",
  CONFIG: "info",
  DATA: "neutral",
};

/** A readable sentence for the row, from the event key. */
function headline(e: ActivityEvent): string {
  const verb = e.event.replace(/_/g, " ").toLowerCase();
  const subject = e.entityLabel ?? e.entityId ?? e.entityType;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} — ${subject}`;
}

type Labels = Record<string, ActivityLabel>;
/** module key → its display label, from the manifest the matrix screen uses. */
type ModuleLabels = Record<string, string>;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** `includeDescendants` → "Include descendants". */
function humanKey(k: string): string {
  const s = k.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A single permission cell as the matrix editor sends it. */
interface MatrixChange { roleKey: string; module: string; action: string; allowed: boolean }

function isMatrixChange(v: unknown): v is MatrixChange {
  const o = v as Record<string, unknown> | null;
  return (
    !!o && typeof o === "object" && !Array.isArray(o) &&
    typeof o["module"] === "string" && typeof o["action"] === "string" && typeof o["allowed"] === "boolean"
  );
}

function Scalar({ text, strike, title }: { text: string; strike?: boolean; title?: string }) {
  return <span className={cn("break-words", strike && "line-through")} title={title}>{text}</span>;
}

/** A resolved id: the name, its level, and the raw id kept on hover. */
function IdValue({ id, labels, strike }: { id: string; labels: Labels; strike?: boolean }) {
  const hit = labels[id];
  if (!hit) return <span title={id} className="font-mono text-[11px] text-[var(--ink3)]">{id.slice(0, 8)}…</span>;
  return (
    <span className={cn("break-words", strike && "line-through")} title={id}>
      {hit.label}
      {hit.subtype && (
        <span className="ml-1.5 font-mono text-[10px] uppercase text-[var(--ink3)]">{hit.subtype.toLowerCase()}</span>
      )}
    </span>
  );
}

/** One permission cell, read as a sentence rather than as a record. */
function MatrixChangeLine({ c, modules, withRole }: { c: MatrixChange; modules: ModuleLabels; withRole: boolean }) {
  return (
    <span className="flex flex-wrap items-baseline gap-1.5">
      <span
        className={cn(
          "rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.04em]",
          c.allowed
            ? "bg-[var(--success-bg)] text-[var(--success)]"
            : "bg-[var(--danger-bg)] text-[var(--danger)]",
        )}
      >
        {c.allowed ? "Allowed" : "Denied"}
      </span>
      {withRole && <span className="font-medium">{c.roleKey}</span>}
      <span>{modules[c.module] ?? humanKey(c.module)}</span>
      <span className="text-[var(--muted)]">· {c.action}</span>
    </span>
  );
}

/** A list, capped — a 40-cell matrix save should not push the row off screen. */
function ListValue({ items, render }: { items: unknown[]; render: (v: unknown, i: number) => React.ReactNode }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? items : items.slice(0, 6);
  return (
    <span className="flex flex-col gap-1">
      {shown.map((v, i) => <span key={i}>{render(v, i)}</span>)}
      {items.length > shown.length && (
        <button
          onClick={() => setAll(true)}
          className="self-start text-[11px] font-medium text-[var(--accent-strong)] hover:underline"
        >
          Show all {items.length}
        </button>
      )}
    </span>
  );
}

/**
 * One before/after value, rendered for a human.
 *
 * This table is the answer to "what actually changed?", so raw JSON is a
 * non-answer — `[{"roleKey":"WARDEN","module":"DASHBOARD",…}]` makes the reader
 * parse a payload to learn something the row could simply have said. So:
 *
 *  - an id becomes the name the server resolved for it (raw id on hover — it is
 *    still what you paste into a query when debugging);
 *  - a permission cell becomes "Allowed · Dashboard · view";
 *  - any other object becomes labelled key/value lines, one per field;
 *  - timestamps and booleans get read as dates and yes/no, not as ISO and true.
 *
 * Nothing is hidden, only rendered — every key in the payload still appears.
 */
function Value({
  v, labels, modules, strike = false, depth = 0,
}: { v: unknown; labels: Labels; modules: ModuleLabels; strike?: boolean; depth?: number }) {
  if (v === null || v === undefined || v === "") return <Scalar text="—" />;

  if (typeof v === "boolean") return <Scalar text={v ? "Yes" : "No"} strike={strike} />;
  if (typeof v === "number") return <Scalar text={String(v)} strike={strike} />;

  if (typeof v === "string") {
    if (ID_RE.test(v)) return <IdValue id={v} labels={labels} strike={strike} />;
    if (ISO_RE.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return (
          <Scalar
            title={v}
            strike={strike}
            text={d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          />
        );
      }
    }
    return <Scalar text={v} strike={strike} />;
  }

  if (Array.isArray(v)) {
    if (!v.length) return <Scalar text="—" />;
    if (v.every(isMatrixChange)) {
      const roles = new Set(v.map((c) => c.roleKey));
      return (
        <ListValue
          items={v}
          render={(c) => <MatrixChangeLine c={c as MatrixChange} modules={modules} withRole={roles.size > 1} />}
        />
      );
    }
    // Primitives (ids included) read better inline than stacked.
    if (v.every((x) => typeof x !== "object" || x === null)) {
      return (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {v.map((x, i) => <Value key={i} v={x} labels={labels} modules={modules} depth={depth + 1} />)}
        </span>
      );
    }
    return (
      <ListValue
        items={v}
        render={(x, i) => <Value key={i} v={x} labels={labels} modules={modules} depth={depth + 1} />}
      />
    );
  }

  // A plain object: one labelled line per field. Beyond two levels the payload
  // is structure rather than content, so fall back to a compact literal.
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return <Scalar text="—" />;
  if (depth > 2) return <Scalar text={JSON.stringify(v)} strike={strike} />;
  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([k, val]) => (
        <span key={k} className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.05em] text-[var(--ink3)]">{humanKey(k)}</span>
          <Value v={val} labels={labels} modules={modules} depth={depth + 1} />
        </span>
      ))}
    </span>
  );
}

function Row({ e, labels, modules }: { e: ActivityEvent; labels: Labels; modules: ModuleLabels }) {
  const [open, setOpen] = React.useState(false);
  const changed = e.changedKeys ?? [];
  const before = (e.beforeJson ?? {}) as Record<string, unknown>;
  const after = (e.afterJson ?? {}) as Record<string, unknown>;
  const fields = changed.length ? changed : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const tone = CAT_TONE[e.category] ?? "neutral";

  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--muted-bg)]"
      >
        <span
          className={cn(
            "h-7 w-[3px] shrink-0 rounded-full",
            tone === "danger" ? "bg-[var(--danger)]" : tone === "violet" ? "bg-[var(--pop)]" : "bg-[var(--bd2)]",
          )}
        />
        <span className="w-[120px] shrink-0 font-mono text-[10.5px] text-[var(--muted)]">
          {new Date(e.occurredAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
        </span>
        <Badge tone={tone} className="shrink-0">{e.category}</Badge>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{headline(e)}</span>
          <span className="block truncate font-mono text-[10px] text-[var(--ink3)]">
            {e.entityType}{e.entityId ? `:${e.entityId.slice(0, 8)}` : ""}
          </span>
        </span>
        <span className="w-[150px] shrink-0 text-right text-[11.5px] text-[var(--muted)]">
          {e.actorName ?? "System"}
        </span>
        <span className="w-[86px] shrink-0 text-right font-mono text-[10.5px] text-[var(--ink3)]">
          {fields.length ? `${fields.length} field${fields.length === 1 ? "" : "s"}` : ""}
        </span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ink3)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ink3)]" />}
      </button>

      {open && (
        <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-4 pl-[58px] pt-0">
          {e.reason && (
            <div className="mt-3 rounded-r-[9px] border-l-2 border-[var(--accent)] bg-[var(--card)] px-3 py-2.5 text-[12.5px] [text-wrap:pretty]">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                Reason given
              </span>
              {e.reason}
            </div>
          )}

          {(e.fromState || e.toState) && (
            <div className="mt-3 flex items-center gap-2 text-[12.5px]">
              <Badge>{e.fromState ?? "—"}</Badge>
              <span className="text-[var(--muted)]">→</span>
              <Badge tone="ok">{e.toState ?? "—"}</Badge>
            </div>
          )}

          {fields.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-[10px] border border-[var(--border)]">
              <div className="flex bg-[var(--muted-bg)] px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--ink3)]">
                <div className="flex-1">Field</div>
                <div className="flex-[1.4]">Before</div>
                <div className="flex-[1.4]">After</div>
              </div>
              {fields.map((f) => (
                <div key={f} className="flex gap-2 border-t border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12px]">
                  <div className="min-w-0 flex-1 font-mono text-[11px] text-[var(--muted)]">{humanKey(f)}</div>
                  <div className="min-w-0 flex-[1.4] text-[var(--muted)]">
                    <Value v={before[f]} labels={labels} modules={modules} strike />
                  </div>
                  <div className="min-w-0 flex-[1.4] font-medium">
                    <Value v={after[f]} labels={labels} modules={modules} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-[12px] text-[var(--muted)]">No field-level change recorded for this event.</div>
          )}

          {e.hash && (
            <div className="mt-2.5 font-mono text-[10px] text-[var(--ink3)]">
              chain {e.chainKey} · seq {e.seq} · {e.hash.slice(0, 24)}…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TrailScreen() {
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [hasReason, setHasReason] = React.useState(false);

  const facets = useQuery({ queryKey: activityKeys.facets(), queryFn: activityApi.facets });
  // Same manifest the matrix screen loads, so a permission change reads
  // "Dashboard", not "DASHBOARD". Shared cache: no extra request in practice.
  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest, staleTime: 300_000 });
  const moduleLabels = React.useMemo<ModuleLabels>(
    () => Object.fromEntries((manifest.data?.modules ?? []).map((m) => [m.key, m.label])),
    [manifest.data],
  );
  const verify = useQuery({ queryKey: activityKeys.verify("ACCESS"), queryFn: () => activityApi.verify("ACCESS") });

  const params = { search, category, hasReason: hasReason ? "true" : "", limit: "100" };
  const list = useQuery({ queryKey: activityKeys.list(params), queryFn: () => activityApi.list(params) });

  return (
    <>
      <ScreenHeader
        kicker="Activity trail"
        title="Every change, with its reason"
        sub="Who changed what, when, from what to what — and why. Access and security events are hash-chained, so a gap or an edit is detectable."
        actions={
          verify.data && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-[9px] border px-3 py-1.5 text-[11.5px] font-medium",
                verify.data.valid
                  ? "border-[var(--success)] bg-[var(--success-bg)] text-[var(--success)]"
                  : "border-[var(--danger)] bg-[var(--danger-bg)] text-[var(--danger)]",
              )}
            >
              {verify.data.valid ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {verify.data.valid
                ? `Chain verified · ${verify.data.checked} events`
                : `Chain broken at seq ${verify.data.firstBrokenSeq}`}
            </div>
          )
        }
      />

      <div className="flex flex-col gap-3.5 px-6 pb-16 pt-4 sm:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--muted)]" />
            <Input
              className="h-8 w-[240px] pl-7 text-[12.5px]"
              placeholder="Search event, entity or reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["", ...(facets.data?.categories ?? [])].map((c) => (
              <button
                key={c || "all"}
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-[12px]",
                  category === c
                    ? "border-[var(--accent)] bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]"
                    : "border-[var(--border)] text-[var(--muted)]",
                )}
              >
                {c || "All"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setHasReason((v) => !v)}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-[12px]",
              hasReason
                ? "border-[var(--accent)] bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]"
                : "border-[var(--border)] text-[var(--muted)]",
            )}
          >
            Has reason
          </button>
          <span className="ml-auto font-mono text-[11.5px] text-[var(--muted)]">
            {list.data?.meta.total ?? 0} events
          </span>
        </div>

        {list.isLoading ? (
          <Skeleton className="h-96 w-full rounded-xl" />
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <Card className="p-5">
            <EmptyState
              title="No events match"
              sub="Nothing has been recorded for these filters yet."
            />
          </Card>
        ) : (
          <Card>
            {list.data!.data.map((e) => (
              <Row key={e.id} e={e} labels={list.data!.labels ?? {}} modules={moduleLabels} />
            ))}
          </Card>
        )}
      </div>
    </>
  );
}
