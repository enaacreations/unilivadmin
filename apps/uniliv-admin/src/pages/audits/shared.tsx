import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import {
  AUDIT_TYPE_BADGE, LIFECYCLE_BADGE, titleCase,
  type ApiError, type ApiOne, type AuditType, type ChoiceOption, type DuplicateCheck,
  type DuplicateMatch, type Lifecycle,
} from "./lib";

/* ── Badges ──────────────────────────────────────────────────────────────── */

export function TypeBadge({ type }: { type: AuditType }) {
  return <Badge variant={AUDIT_TYPE_BADGE[type] ?? "outline"}>{type}</Badge>;
}

export function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <Badge variant={LIFECYCLE_BADGE[lifecycle] ?? "outline"}>
      {titleCase(lifecycle)}
    </Badge>
  );
}

/* ── Reason dialog (reject / reopen / deny…) ─────────────────────────────── */

/**
 * One-textarea modal for every "verdict + mandatory text" flow. The parent
 * owns the mutation; this resets its text on open and disables save until the
 * (required) text is present.
 */
export function ReasonDialog({
  open, onOpenChange, title, description, label = "Reason", placeholder,
  saveLabel = "Save", isSaving, required = true, onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  saveLabel?: string;
  isSaving?: boolean;
  required?: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = React.useState("");
  React.useEffect(() => { if (open) setText(""); }, [open]);
  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      onSave={() => { if (!required || text.trim()) onSave(text.trim()); }}
      isSaving={isSaving}
      saveLabel={saveLabel}
    >
      <div className="space-y-2">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <Label>{label}{required ? " *" : ""}</Label>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="text-base"
        />
        {required && !text.trim() && (
          <p className="text-xs text-muted-foreground">{label} is required.</p>
        )}
      </div>
    </FormModal>
  );
}

/* ── Structured 422 details renderer ─────────────────────────────────────── */

/**
 * Renders the `details` payload of a 422 in a readable list. Known shapes:
 * `{sections: string[]}`, `{questions: [{id, prompt}]}` (publish validation)
 * and `[{path, error}]` rows. Falls back to JSON.
 */
export function ErrorDetails({ details }: { details: unknown }) {
  if (details == null) return null;

  const items: React.ReactNode[] = [];
  if (Array.isArray(details)) {
    for (const row of details) {
      if (row && typeof row === "object" && "path" in row && "error" in row) {
        const r = row as { path: string; error: string };
        items.push(
          <li key={items.length}>
            <span className="font-mono text-xs">{r.path || "(root)"}</span> — {r.error}
          </li>,
        );
      } else {
        items.push(<li key={items.length}>{String(row)}</li>);
      }
    }
  } else if (typeof details === "object") {
    for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          const label =
            v && typeof v === "object" && "prompt" in (v as object)
              ? (v as { prompt: string }).prompt
              : String(v);
          items.push(
            <li key={items.length}>
              <span className="text-muted-foreground">{key}:</span> {label}
            </li>,
          );
        }
      } else {
        items.push(
          <li key={items.length}>
            <span className="text-muted-foreground">{key}:</span> {String(value)}
          </li>,
        );
      }
    }
  } else {
    items.push(<li key={0}>{String(details)}</li>);
  }

  if (items.length === 0) return null;
  return (
    <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 pl-7 text-sm text-destructive">
      {items}
    </ul>
  );
}

/* ── Near-duplicate warning (question bank + inline builder) ─────────────── */

/**
 * Debounced near-duplicate detector for a prompt field. Calls
 * GET /audit/bank/check-duplicate 500ms after typing settles (min 6 chars),
 * excluding `excludeId` (the item being edited). Non-blocking — returns the
 * matches (similarity ≥ 0.7) for the caller to surface.
 */
export function useDuplicatePrompts(prompt: string, excludeId?: string | null): DuplicateMatch[] {
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(prompt.trim()), 500);
    return () => clearTimeout(t);
  }, [prompt]);

  const query = useQuery({
    queryKey: ["/audit/bank/check-duplicate", debounced],
    queryFn: () =>
      apiFetch<ApiOne<DuplicateCheck>>(
        `/audit/bank/check-duplicate?prompt=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 6,
    staleTime: 60_000,
    retry: false,
  });

  return React.useMemo(
    () => (query.data?.data.duplicates ?? []).filter((m) => m.id !== excludeId),
    [query.data, excludeId],
  );
}

/** Amber, non-blocking list of near-duplicate prompts with similarity %. */
export function DuplicateWarning({ matches }: { matches: DuplicateMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Similar question{matches.length === 1 ? "" : "s"} already exist — reuse before adding a duplicate.
      </p>
      <ul className="space-y-0.5 pl-5">
        {matches.slice(0, 5).map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1">{m.prompt}</span>
            <span className="shrink-0 tabular-nums">{Math.round(m.similarity * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Choice answer-options editor (question bank + builder) ──────────────── */

export function newOptionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `opt_${Math.random().toString(36).slice(2, 10)}`;
}

/** Traffic-light classes for an option's earn-% — full marks read green, a
 *  zero-credit "wrong" answer reads red, partial credit amber. */
function pctTone(v: number): { edge: string; text: string } {
  if (v >= 75) return { edge: "border-l-success", text: "text-success" };
  if (v >= 50) return { edge: "border-l-amber-500", text: "text-amber-600" };
  return { edge: "border-l-destructive", text: "text-destructive" };
}

/**
 * Add/label/score the answer options a SINGLE_CHOICE / MULTI_CHOICE question
 * offers. Each option's `multiplierPct` (0–100) is how much of the question's
 * weight that choice earns (single = the picked option's %, multi = the average
 * of picked options). Fully controlled — the parent owns persistence.
 */
export function ChoiceOptionsEditor({
  value, onChange, disabled = false, multi = false,
}: {
  value: ChoiceOption[];
  onChange: (options: ChoiceOption[]) => void;
  disabled?: boolean;
  multi?: boolean;
}) {
  const add = () => onChange([...value, { id: newOptionId(), label: "", multiplierPct: 100 }]);
  const patch = (id: string, p: Partial<ChoiceOption>) =>
    onChange(value.map((o) => (o.id === id ? { ...o, ...p } : o)));
  const remove = (id: string) => onChange(value.filter((o) => o.id !== id));

  return (
    <div className="rounded-[10px] border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Answer options</span>
        <span className="text-[10.5px] text-muted-foreground">
          {multi ? "auditor may pick several · score = average of picked" : "auditor picks one · score % = points earned"}
        </span>
      </div>
      {value.length === 0 ? (
        <p className="py-2 text-center text-[12px] text-muted-foreground">
          No options yet — add the choices the auditor picks from.
        </p>
      ) : (
        <div className="space-y-1.5">
          {value.map((o, i) => {
            const tone = pctTone(o.multiplierPct);
            return (
              <div
                key={o.id}
                className={cn(
                  "flex items-center gap-2 rounded-[8px] border border-border border-l-[3px] bg-card py-1 pl-2.5 pr-1",
                  tone.edge,
                )}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  {i + 1}
                </span>
                <Input
                  value={o.label}
                  disabled={disabled}
                  onChange={(e) => patch(o.id, { label: e.target.value })}
                  placeholder="Option label…"
                  className="h-8 flex-1 border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={o.multiplierPct}
                    disabled={disabled}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) =>
                      patch(o.id, { multiplierPct: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })
                    }
                    className={cn(
                      "h-8 w-16 text-right text-[13px] font-bold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                      tone.text,
                    )}
                  />
                  <span className={cn("text-[11px] font-semibold", tone.text)}>%</span>
                </div>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(o.id)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Remove option"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!disabled && (
        <Button type="button" variant="outline" size="sm" className="mt-2 h-8" onClick={add}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add option
        </Button>
      )}
    </div>
  );
}

/* ── Publish dialog (shared by template detail + builder) ────────────────── */

export function PublishDialog({
  open,
  onOpenChange,
  versionId,
  versionNo,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionId: string | null;
  versionNo?: number;
  onPublished?: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (open) { setNote(""); setError(null); }
  }, [open, versionId]);

  const publishMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audit/templates/versions/${versionId}/publish`, {
        method: "POST",
        body: JSON.stringify({ changelogNote: note.trim() }),
      }),
    onSuccess: () => {
      toast({ title: `v${versionNo ?? ""} published` });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["/audit/templates"] });
      onPublished?.();
    },
    onError: (e: ApiError) => setError(e),
  });

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Publish v${versionNo ?? ""}`}
      onSave={() => publishMut.mutate()}
      isSaving={publishMut.isPending}
      saveLabel="Publish"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Publishing freezes this version — content and the rating-scale
          snapshot become immutable. A changelog note is required.
        </p>
        <div className="space-y-2">
          <Label>Changelog note</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed in this version?"
            rows={3}
          />
        </div>
        {error && (
          <div>
            <p className="text-sm font-medium text-destructive">{error.message}</p>
            <ErrorDetails details={error.details} />
          </div>
        )}
      </div>
    </FormModal>
  );
}
