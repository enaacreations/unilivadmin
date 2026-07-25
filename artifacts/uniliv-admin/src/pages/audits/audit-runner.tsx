import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, ArrowLeft, Camera, CheckCircle2,
  ChevronRight, Eraser, Info, Loader2, Lock, MapPinOff, Pen,
  RotateCcw, Send, Star, X,
} from "lucide-react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { locateOnce } from "@/hooks/use-geolocation";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import { useConfetti } from "@/components/ui/confetti";
import { CameraCapture, type CaptureMeta } from "@/components/audits/camera-capture";
import {
  AUDIT_STATE_BADGE, NON_SCORED_TYPES,
  scoreColorClass, titleCase,
  type ApiError, type ApiOne,
  type RunEvidence, type RunPayload, type RunQuestion, type RunSection,
  type ScaleSnapshot, type SubmitBlocker, type SubmitCheck,
} from "./lib";

/* ── Local answer model ──────────────────────────────────────────────────── */

type SaveState = "idle" | "pending" | "saved" | "error";

interface LocalAnswer {
  answerJson: unknown;
  isNa: boolean;
  notes: string | null;
  responseId: string | null;
  saveState: SaveState;
  /** Bumped on every local edit; a save only lands "saved" if rev is unchanged. */
  rev: number;
}

type AnswersMap = Record<string, LocalAnswer>;

function hasAnswer(a: LocalAnswer | undefined): boolean {
  return !!a && (a.isNa || (a.answerJson != null && a.answerJson !== ""));
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function SaveDot({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === "idle") return null;
  if (state === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-xs text-red-600"
        title="Save failed — tap to retry"
      >
        <span className="h-2 w-2 rounded-full bg-red-500" /> retry
      </button>
    );
  }
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        state === "pending" ? "animate-pulse bg-amber-500" : "bg-emerald-500"
      }`}
      title={state === "pending" ? "Saving…" : "Saved"}
    />
  );
}

/** Inline pointer-drawn signature pad → PNG data URL (esign-sign prior art). */
function SignaturePad({ onSave, disabled }: { onSave: (dataUrl: string) => void; disabled?: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = React.useState(false);

  React.useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#0F172A";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const getPos = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    };
  };

  const clear = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    setHasInk(false);
  };

  return (
    <div className="space-y-2">
      <div className="rounded-md border-2 border-dashed bg-white">
        <canvas
          ref={canvasRef}
          width={600}
          height={200}
          className={`h-40 w-full touch-none ${disabled ? "pointer-events-none opacity-60" : "cursor-crosshair"}`}
          onPointerDown={(e) => {
            if (disabled) return;
            drawingRef.current = true;
            lastRef.current = getPos(e);
            (e.target as Element).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drawingRef.current) return;
            const ctx = canvasRef.current!.getContext("2d")!;
            const p = getPos(e);
            const last = lastRef.current!;
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            lastRef.current = p;
            setHasInk(true);
          }}
          onPointerUp={() => { drawingRef.current = false; lastRef.current = null; }}
          onPointerLeave={() => { drawingRef.current = false; lastRef.current = null; }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={clear} disabled={disabled}>
          <Eraser className="mr-1 h-3.5 w-3.5" /> Clear
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled || !hasInk}
          onClick={() => onSave(canvasRef.current!.toDataURL("image/png"))}
        >
          <Pen className="mr-1 h-3.5 w-3.5" /> Save signature
        </Button>
      </div>
    </div>
  );
}

/* ── Answer inputs by type ───────────────────────────────────────────────── */

function AnswerInput({
  question, local, snapshot, editable, onAnswer,
}: {
  question: RunQuestion;
  local: LocalAnswer | undefined;
  snapshot: ScaleSnapshot | null;
  editable: boolean;
  onAnswer: (answerJson: unknown) => void;
}) {
  const a = (local?.answerJson ?? {}) as Record<string, unknown>;

  switch (question.type) {
    case "YES_NO_NA":
    case "PASS_FAIL": {
      const values = question.type === "YES_NO_NA" ? ["YES", "NO", "NA"] : ["PASS", "FAIL"];
      const current = String(a["value"] ?? "");
      // Prototype segmented buttons — the "good" answer fills success, the
      // "bad" answer fills danger, N/A fills muted; unselected stay outlined.
      const tone: Record<string, string> = {
        YES: "bg-success text-white border-transparent",
        PASS: "bg-success text-white border-transparent",
        NO: "bg-destructive text-white border-transparent",
        FAIL: "bg-destructive text-white border-transparent",
        NA: "bg-muted-foreground text-white border-transparent",
      };
      return (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
          {values.map((v) => {
            const selected = current === v;
            return (
              <button
                key={v}
                type="button"
                disabled={!editable}
                // Re-tapping the current answer is a no-op (matches the old
                // ToggleGroup) so it doesn't fire a redundant save.
                onClick={() => { if (current !== v) onAnswer({ value: v }); }}
                className={cn(
                  "inline-flex h-11 w-full items-center justify-center rounded-[10px] border px-3 text-sm font-semibold transition-colors disabled:opacity-60",
                  selected ? tone[v] : "border-border bg-background text-foreground hover:bg-muted",
                )}
              >
                {v === "NA" ? "N/A" : titleCase(v)}
              </button>
            );
          })}
        </div>
      );
    }
    case "RATING": {
      const options = [...(snapshot?.options ?? [])].sort(
        (x, y) => (x.orderIndex ?? 0) - (y.orderIndex ?? 0),
      );
      const current = a["optionId"] != null ? String(a["optionId"]) : null;
      if (options.length === 0) {
        return <p className="text-sm text-muted-foreground">No rating scale snapshot on this version.</p>;
      }
      // Short/numeric scales fit one even row; text labels tile into 2 columns
      // that fill the width (no more ragged, half-empty rows).
      const compact = options.every((o) => (o.label ?? "").length <= 4);
      return (
        <div className={compact ? "flex gap-2" : "grid grid-cols-2 gap-2"}>
          {options.map((o) => {
            const selected = current === o.id;
            return (
              <button
                key={o.id}
                type="button"
                disabled={!editable}
                onClick={() => onAnswer({ optionId: o.id })}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border px-3 text-sm font-medium transition-colors disabled:opacity-60",
                  compact ? "flex-1" : "w-full",
                  !compact && o.isExcludedNa && "col-span-2",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : o.isExcludedNa
                      ? "border-dashed bg-transparent text-muted-foreground hover:bg-muted"
                      : "bg-card hover:bg-muted",
                )}
              >
                {o.color && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: o.color }}
                  />
                )}
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "SINGLE_CHOICE": {
      const current = a["optionId"] != null ? String(a["optionId"]) : "";
      return (
        <RadioGroup
          value={current}
          onValueChange={(v) => onAnswer({ optionId: v })}
          disabled={!editable}
          className="gap-1"
        >
          {(question.optionsJson ?? []).map((o) => (
            <Label
              key={o.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border bg-card px-3 text-base font-normal has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={o.id} />
              {o.label}
            </Label>
          ))}
        </RadioGroup>
      );
    }
    case "MULTI_CHOICE": {
      const ids = Array.isArray(a["optionIds"]) ? (a["optionIds"] as unknown[]).map(String) : [];
      return (
        <div className="grid gap-1">
          {(question.optionsJson ?? []).map((o) => {
            const checked = ids.includes(o.id);
            return (
              <Label
                key={o.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border bg-card px-3 text-base font-normal"
              >
                <Checkbox
                  checked={checked}
                  disabled={!editable}
                  onCheckedChange={(c) => {
                    const next = c ? [...ids, o.id] : ids.filter((x) => x !== o.id);
                    onAnswer(next.length ? { optionIds: next } : null);
                  }}
                />
                {o.label}
              </Label>
            );
          })}
        </div>
      );
    }
    case "NUMERIC": {
      const raw = a["value"];
      const value = raw == null ? "" : String(raw);
      const n = value === "" ? null : Number(value);
      const min = question.numericMin != null ? Number(question.numericMin) : null;
      const max = question.numericMax != null ? Number(question.numericMax) : null;
      const outOfRange =
        n != null && !Number.isNaN(n) && ((min != null && n < min) || (max != null && n > max));
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="decimal"
              value={value}
              disabled={!editable}
              onChange={(e) => {
                const v = e.target.value;
                onAnswer(v === "" ? null : { value: Number(v) });
              }}
              className={`min-h-11 max-w-[180px] text-base ${
                outOfRange ? "border-red-500 ring-2 ring-red-500/40 focus-visible:ring-red-500" : ""
              }`}
            />
            {question.numericUnit && (
              <span className="text-sm text-muted-foreground">{question.numericUnit}</span>
            )}
          </div>
          {(min != null || max != null) && (
            <p className={`text-xs ${outOfRange ? "text-red-600" : "text-muted-foreground"}`}>
              Range: {min ?? "−∞"} – {max ?? "∞"}
              {outOfRange ? " · out of range (scores 0)" : ""}
            </p>
          )}
        </div>
      );
    }
    case "TEXT": {
      const value = a["value"] == null ? "" : String(a["value"]);
      return (
        <Textarea
          value={value}
          disabled={!editable}
          rows={3}
          className="text-base"
          placeholder="Type your observation…"
          onChange={(e) => onAnswer(e.target.value.trim() === "" ? null : { value: e.target.value })}
        />
      );
    }
    case "DATE": {
      const value = a["value"] == null ? "" : String(a["value"]);
      return (
        <DatePicker
          value={value}
          disabled={!editable}
          onChange={(v) => onAnswer(v ? { value: v } : null)}
          clearable
          className="min-h-11 max-w-[220px]"
        />
      );
    }
    case "SIGNATURE": {
      const dataUrl = a["dataUrl"] != null ? String(a["dataUrl"]) : null;
      if (dataUrl) {
        return (
          <div className="space-y-2">
            <div className="inline-block rounded-md border bg-white p-2">
              <img src={dataUrl} alt="Signature" className="max-h-24" />
            </div>
            {editable && (
              <div>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={() => onAnswer(null)}>
                  <Eraser className="mr-1 h-3.5 w-3.5" /> Redo
                </Button>
              </div>
            )}
          </div>
        );
      }
      return <SignaturePad disabled={!editable} onSave={(url) => onAnswer({ dataUrl: url })} />;
    }
    case "INSTRUCTION":
      return null;
    case "PHOTO":
      return (
        <p className="text-sm text-muted-foreground">
          Answered by attaching a photo below.
        </p>
      );
    default:
      return null;
  }
}

/* ── Question card ───────────────────────────────────────────────────────── */

function QuestionCard({
  question, local, snapshot, editable, evidence, maxFiles, flash,
  onAnswer, onNotes, onRetry, onOpenCamera, onDeleteEvidence,
}: {
  question: RunQuestion;
  local: LocalAnswer | undefined;
  snapshot: ScaleSnapshot | null;
  editable: boolean;
  evidence: RunEvidence[];
  maxFiles: number;
  flash: boolean;
  onAnswer: (answerJson: unknown) => void;
  onNotes: (notes: string) => void;
  onRetry: () => void;
  onOpenCamera: () => void;
  onDeleteEvidence: (eid: string) => void;
}) {
  const [notesOpen, setNotesOpen] = React.useState(!!local?.notes);
  React.useEffect(() => {
    if (local?.notes) setNotesOpen(true);
  }, [local?.notes]);

  if (question.type === "INSTRUCTION") {
    return (
      <div id={`q-${question.id}`} className="rounded-lg border bg-info/5 p-4">
        <div className="flex gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <div>
            <p className="text-sm font-medium">{question.prompt}</p>
            {question.helpText && (
              <p className="mt-1 text-sm text-muted-foreground">{question.helpText}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const answered = hasAnswer(local);
  const scorable = !NON_SCORED_TYPES.has(question.type) && question.weight > 0;
  const cameraDisabled =
    !editable || (question.type !== "PHOTO" && !local?.responseId) || evidence.length >= maxFiles;

  return (
    <div
      id={`q-${question.id}`}
      className={`rounded-lg border bg-card p-4 transition-shadow ${
        flash ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          {/* Prompt row */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium leading-snug">
                {question.prompt}
                {question.mandatory && (
                  <Star className="ml-1 inline h-3 w-3 fill-amber-500 text-amber-500" aria-label="Mandatory" />
                )}
              </p>
              {question.helpText && (
                <p className="mt-0.5 text-sm text-muted-foreground">{question.helpText}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {scorable && (
                <Badge variant="outline" className="tabular-nums" title="Weight">
                  w{question.weight}
                </Badge>
              )}
              {question.adHoc && <Badge variant="secondary">ad-hoc</Badge>}
              <SaveDot state={local?.saveState ?? "idle"} onRetry={onRetry} />
            </div>
          </div>

          {/* Answer input */}
          <AnswerInput
            question={question}
            local={local}
            snapshot={snapshot}
            editable={editable}
            onAnswer={onAnswer}
          />

          {/* Notes */}
          {notesOpen ? (
            <Textarea
              value={local?.notes ?? ""}
              disabled={!editable}
              rows={2}
              placeholder="Notes…"
              className="text-base"
              onChange={(e) => onNotes(e.target.value)}
            />
          ) : (
            editable && (
              <button
                type="button"
                onClick={() => setNotesOpen(true)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                + Add note
              </button>
            )
          )}

          {/* Evidence strip */}
          {question.evidenceRule !== "NONE" || evidence.length > 0 || question.type === "PHOTO" ? (
            <div className="flex flex-wrap items-center gap-2">
              {evidence.map((e) => (
                <span key={e.id} className="group relative">
                  <a href={e.url ?? undefined} target="_blank" rel="noreferrer">
                    <img
                      src={e.thumbUrl ?? e.url ?? undefined}
                      alt={e.originalName ?? "Evidence"}
                      className="h-14 w-14 rounded-md border object-cover"
                    />
                  </a>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => onDeleteEvidence(e.id)}
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full border bg-card p-0.5 text-muted-foreground shadow group-hover:block"
                      aria-label="Delete evidence"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={cameraDisabled}
                onClick={onOpenCamera}
                title={
                  question.type !== "PHOTO" && !local?.responseId
                    ? "Answer first, then attach evidence"
                    : undefined
                }
              >
                <Camera className="mr-1.5 h-4 w-4" />
                {evidence.length}/{maxFiles}
              </Button>
              {question.evidenceRule === "ALWAYS_REQUIRED" && evidence.length === 0 && (
                <span className="text-xs text-amber-600">Evidence required</span>
              )}
              {question.evidenceRule === "REQUIRED_ON_FAIL" && (
                <span className="text-xs text-muted-foreground">Evidence required on fail</span>
              )}
            </div>
          ) : null}

          {!answered && question.mandatory && (
            <p className="text-xs text-amber-600">Mandatory — answer before submitting.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Runner page ─────────────────────────────────────────────────────────── */

export default function AuditRunner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { me } = usePermissions();
  const { confetti, fire: fireConfetti } = useConfetti();

  const runQuery = useQuery({
    queryKey: ["/audits", id, "run"],
    queryFn: () => apiFetch<ApiOne<RunPayload>>(`/audits/${id}/run`),
  });
  const run = runQuery.data?.data;
  const audit = run?.audit;
  const snapshot = run?.scaleSnapshot ?? null;
  const sections: RunSection[] = React.useMemo(() => run?.sections ?? [], [run]);
  const allQuestions = React.useMemo(() => sections.flatMap((s) => s.questions), [sections]);

  const isAssignee = !!me?.id && !!audit && me.id === audit.assigneeId;
  const editable = isAssignee && audit?.state === "IN_PROGRESS";

  /* — Local answers + autosave — */
  const [answers, setAnswers] = React.useState<AnswersMap>({});
  const answersRef = React.useRef<AnswersMap>(answers);
  answersRef.current = answers;
  const timersRef = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflightRef = React.useRef(new Map<string, Promise<unknown>>());

  // Seed/merge server responses; never clobber local edits still saving.
  React.useEffect(() => {
    if (!run) return;
    setAnswers((prev) => {
      const next = { ...prev };
      for (const r of run.responses) {
        const existing = next[r.questionId];
        if (!existing || existing.saveState === "idle" || existing.saveState === "saved") {
          next[r.questionId] = {
            answerJson: r.answerJson,
            isNa: r.isNa,
            notes: r.notes,
            responseId: r.id,
            saveState: existing?.saveState ?? "idle",
            rev: existing?.rev ?? 0,
          };
        } else {
          next[r.questionId] = { ...existing, responseId: r.id };
        }
      }
      return next;
    });
  }, [run]);

  const invalidateRun = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/audits", id, "run"] });
    qc.invalidateQueries({ queryKey: ["/audits", id] });
  }, [qc, id]);

  const doSave = React.useCallback(
    (qid: string): Promise<unknown> => {
      const local = answersRef.current[qid];
      if (!local) return Promise.resolve();
      const revAtSend = local.rev;
      // isNa (and all scoring) is derived server-side from the answer.
      const promise = apiFetch<ApiOne<{ id: string }>>(
        `/audits/${id}/responses/${qid}`,
        {
          method: "PUT",
          body: JSON.stringify({
            answerJson: local.answerJson,
            notes: local.notes,
          }),
        },
      )
        .then((res) => {
          setAnswers((prev) => {
            const cur = prev[qid];
            if (!cur) return prev;
            return {
              ...prev,
              [qid]: {
                ...cur,
                responseId: res.data.id,
                saveState: cur.rev === revAtSend ? "saved" : cur.saveState,
              },
            };
          });
        })
        .catch((e: Error) => {
          setAnswers((prev) => {
            const cur = prev[qid];
            return cur ? { ...prev, [qid]: { ...cur, saveState: "error" } } : prev;
          });
          toast({ title: "Save failed", description: e.message, variant: "destructive" });
        })
        .finally(() => {
          if (inflightRef.current.get(qid) === promise) inflightRef.current.delete(qid);
        });
      inflightRef.current.set(qid, promise);
      return promise;
    },
    [id, toast],
  );

  const queueSave = React.useCallback(
    (qid: string) => {
      const existing = timersRef.current.get(qid);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        qid,
        setTimeout(() => {
          timersRef.current.delete(qid);
          void doSave(qid);
        }, 500),
      );
    },
    [doSave],
  );

  /** Fire every debounced save immediately and wait for the wire to go quiet. */
  const flushPendingSaves = React.useCallback(async () => {
    for (const [qid, timer] of timersRef.current) {
      clearTimeout(timer);
      timersRef.current.delete(qid);
      void doSave(qid);
    }
    await Promise.allSettled([...inflightRef.current.values()]);
  }, [doSave]);

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  const setAnswer = React.useCallback(
    (question: RunQuestion, answerJson: unknown) => {
      setAnswers((prev) => {
        const cur = prev[question.id];
        return {
          ...prev,
          [question.id]: {
            answerJson,
            // Server derives isNa (and all scoring) on save; the refetch
            // reconciles this local placeholder.
            isNa: false,
            notes: cur?.notes ?? null,
            responseId: cur?.responseId ?? null,
            saveState: "pending",
            rev: (cur?.rev ?? 0) + 1,
          },
        };
      });
      queueSave(question.id);
    },
    [queueSave],
  );

  const setNotes = React.useCallback(
    (question: RunQuestion, notes: string) => {
      setAnswers((prev) => {
        const cur = prev[question.id];
        return {
          ...prev,
          [question.id]: {
            answerJson: cur?.answerJson ?? null,
            isNa: cur?.isNa ?? false,
            notes: notes === "" ? null : notes,
            responseId: cur?.responseId ?? null,
            saveState: "pending",
            rev: (cur?.rev ?? 0) + 1,
          },
        };
      });
      queueSave(question.id);
    },
    [queueSave],
  );

  /* — Derived progress (scoring is server-side at submit) — */
  const progress = React.useMemo(() => {
    const applicable = allQuestions.filter((q) => q.type !== "INSTRUCTION");
    const answered = applicable.filter((q) => hasAnswer(answers[q.id]));
    const mandatoryLeft = applicable.filter((q) => q.mandatory && !hasAnswer(answers[q.id])).length;
    return { total: applicable.length, answered: answered.length, mandatoryLeft };
  }, [allQuestions, answers]);

  /* — Accordion: default-open the first incomplete section — */
  const [openSection, setOpenSection] = React.useState<string>("");
  const defaultedRef = React.useRef(false);
  React.useEffect(() => {
    if (defaultedRef.current || sections.length === 0 || !run) return;
    defaultedRef.current = true;
    const answeredIds = new Set(
      run.responses
        .filter((r) => r.isNa || (r.answerJson != null && r.answerJson !== ""))
        .map((r) => r.questionId),
    );
    const firstIncomplete = sections.find((s) =>
      s.questions.some((q) => q.type !== "INSTRUCTION" && !answeredIds.has(q.id)),
    );
    setOpenSection((firstIncomplete ?? sections[0])!.id);
  }, [sections, run]);

  /* — Evidence by question — */
  const evidenceByResponse = React.useMemo(() => {
    const map = new Map<string, RunEvidence[]>();
    for (const e of run?.evidence ?? []) {
      if (e.kind !== "RESPONSE" || !e.responseId) continue;
      const list = map.get(e.responseId) ?? [];
      list.push(e);
      map.set(e.responseId, list);
    }
    return map;
  }, [run?.evidence]);
  const hasSubmissionProof = React.useMemo(
    () =>
      (run?.evidence ?? []).some(
        (e) => e.kind === "SUBMISSION_PROOF" && e.isLiveCapture && e.geoLat != null,
      ),
    [run?.evidence],
  );

  /* — State transitions from the runner — */
  const [transitionBusy, setTransitionBusy] = React.useState(false);
  const startAudit = async () => {
    setTransitionBusy(true);
    try {
      const body: Record<string, unknown> = {};
      const geo = await locateOnce();
      if (geo) body["geo"] = { lat: geo.lat, lng: geo.lng };
      await apiFetch(`/audits/${id}/start`, { method: "POST", body: JSON.stringify(body) });
      invalidateRun();
    } catch (e) {
      toast({ title: (e as Error).message || "Action failed", variant: "destructive" });
    } finally {
      setTransitionBusy(false);
    }
  };

  /* — Camera targets — */
  const [cameraTarget, setCameraTarget] = React.useState<
    | { kind: "response"; question: RunQuestion }
    | { kind: "submission" }
    | null
  >(null);

  const uploadEvidence = async (dataUrl: string, thumbDataUrl: string, meta: CaptureMeta) => {
    if (!cameraTarget) return;
    try {
      if (cameraTarget.kind === "submission") {
        await apiFetch(`/audits/${id}/evidence`, {
          method: "POST",
          body: JSON.stringify({
            dataUrl,
            thumbDataUrl,
            kind: "SUBMISSION_PROOF",
            isLiveCapture: meta.source === "live-camera",
            capturedAt: meta.capturedAt,
            geo: meta.geo ?? undefined,
          }),
        });
        toast({ title: "Submission proof captured" });
        invalidateRun();
        qc.invalidateQueries({ queryKey: ["/audits", id, "submit-check"] });
        return;
      }
      const question = cameraTarget.question;
      let responseId = answersRef.current[question.id]?.responseId ?? null;
      if (!responseId) {
        // PHOTO questions are "answered" by their evidence — create the row first.
        const res = await apiFetch<ApiOne<{ id: string }>>(
          `/audits/${id}/responses/${question.id}`,
          { method: "PUT", body: JSON.stringify({ answerJson: { value: "captured" } }) },
        );
        responseId = res.data.id;
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            answerJson: { value: "captured" },
            isNa: false,
            notes: prev[question.id]?.notes ?? null,
            responseId,
            saveState: "saved",
            rev: (prev[question.id]?.rev ?? 0) + 1,
          },
        }));
      }
      await apiFetch(`/audits/${id}/evidence`, {
        method: "POST",
        body: JSON.stringify({
          dataUrl,
          thumbDataUrl,
          kind: "RESPONSE",
          responseId,
          isLiveCapture: meta.source === "live-camera",
          capturedAt: meta.capturedAt,
          geo: meta.geo ?? undefined,
        }),
      });
      toast({ title: "Evidence attached" });
      invalidateRun();
    } catch (e) {
      const err = e as ApiError;
      toast({
        title: "Evidence rejected",
        description: err.message,
        variant: "destructive",
      });
      throw err; // keep the capture dialog open
    }
  };

  const deleteEvidence = async (eid: string) => {
    try {
      await apiFetch(`/audits/${id}/evidence/${eid}`, { method: "DELETE" });
      invalidateRun();
    } catch (e) {
      toast({ title: (e as Error).message || "Delete failed", variant: "destructive" });
    }
  };

  /* — Submit sheet — */
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [flashQid, setFlashQid] = React.useState<string | null>(null);
  const [submitResult, setSubmitResult] = React.useState<{
    pct: number | null;
    result: string | null;
    band: string | null;
  } | null>(null);

  const checkQuery = useQuery({
    queryKey: ["/audits", id, "submit-check"],
    queryFn: () => apiFetch<ApiOne<SubmitCheck>>(`/audits/${id}/submit-check`),
    enabled: sheetOpen && !submitResult,
    refetchOnWindowFocus: false,
  });
  const blockers = checkQuery.data?.data.blockers ?? [];
  const onlyLivePhoto =
    blockers.length > 0 && blockers.every((b) => b.kind === "LIVE_PHOTO_REQUIRED");
  const canSubmit = checkQuery.data?.data.canSubmit === true;

  const openSubmitSheet = async () => {
    setSheetOpen(true);
    await flushPendingSaves();
    qc.invalidateQueries({ queryKey: ["/audits", id, "submit-check"] });
  };

  const jumpToBlocker = (b: SubmitBlocker) => {
    if (!b.questionId) return;
    setSheetOpen(false);
    if (b.sectionId) setOpenSection(b.sectionId);
    setFlashQid(b.questionId);
    setTimeout(() => {
      document.getElementById(`q-${b.questionId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    setTimeout(() => setFlashQid(null), 2500);
  };

  const submitMut = useMutation({
    mutationFn: async () => {
      await flushPendingSaves();
      const geo = await locateOnce();
      return apiFetch<{
        success: boolean;
        data: {
          score: { earnedRaw: number; maxRaw: number; pct: number | null };
          result: string | null;
          band: string | null;
        };
      }>(`/audits/${id}/submit`, {
        method: "POST",
        body: JSON.stringify(geo ? { geo: { lat: geo.lat, lng: geo.lng } } : {}),
      });
    },
    onSuccess: (res) => {
      setSubmitResult({
        pct: res.data.score.pct,
        result: res.data.result,
        band: res.data.band,
      });
      fireConfetti();
      toast({ variant: "success", title: "Audit sent for review 🎉" });
      invalidateRun();
      qc.invalidateQueries({ queryKey: ["/audits"] });
    },
    onError: (e: ApiError) => {
      qc.invalidateQueries({ queryKey: ["/audits", id, "submit-check"] });
      toast({
        title: e.message === "LIVE_PHOTO_REQUIRED" ? "Live photo required" : "Submission blocked",
        description:
          e.message === "LIVE_PHOTO_REQUIRED"
            ? "Capture the live geotagged photo below, then submit."
            : e.message,
        variant: "destructive",
      });
    },
  });

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (runQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (runQuery.isError || !run || !audit) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm">{(runQuery.error as Error)?.message || "Could not load the audit."}</p>
        <Button variant="outline" size="sm" onClick={() => runQuery.refetch()}>
          <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  const responsePolicy = run.policies.response;
  // Conduct redesign: gate the questions behind a dedicated Start screen so the
  // auditor does one thing at a time (matches "Audit App Prototype.dc.html").
  const notStarted = isAssignee && (audit.state === "SCHEDULED" || audit.state === "REJECTED");
  // Per-category weight% = share of total scorable question weight (sections carry no weight of their own).
  const totalWeight = sections.reduce(
    (sum, s) => sum + s.questions.reduce((a, q) => a + (NON_SCORED_TYPES.has(q.type) ? 0 : Math.max(0, q.weight || 0)), 0),
    0,
  );

  return (
    <div className="mx-auto max-w-3xl pb-40">
      {confetti}
      {/* Compact sticky header — title inline, ticket shown once, progress inside */}
      <div className="sticky top-0 z-30 -mx-4 mb-4 border-b bg-background px-4 py-3 shadow-[0_4px_10px_-6px_rgba(36,26,21,0.25)] sm:-mx-6 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <Link
              href={`/audits/${id}`}
              className="inline-flex min-h-9 items-center text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[15px] font-bold leading-tight tracking-[-0.012em]">
                {audit.title}
              </div>
              <div className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
                {audit.ticketNo}{audit.propertyName ? ` · ${audit.propertyName}` : ""}
              </div>
            </div>
            <Badge variant={AUDIT_STATE_BADGE[audit.state] ?? "outline"} className="shrink-0">{titleCase(audit.state)}</Badge>
            {!notStarted && audit.startGeoLat != null && (
              <span className="hidden shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-bold text-success sm:inline">📍 GPS ✓</span>
            )}
            {audit.startedAt && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground">
                {new Date(audit.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          {progress.total > 0 && !notStarted && (
            <div className="mt-2">
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-brand-gradient transition-[width] duration-300"
                  style={{ width: `${Math.round((progress.answered / progress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {progress.answered} of {progress.total} answered
                {progress.mandatoryLeft > 0 ? ` · ${progress.mandatoryLeft} required left` : " · all required done"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* State gates */}
      {notStarted && (
        <div className="mx-auto flex max-w-md animate-fade-up flex-col gap-3.5">
          {/* Target card */}
          <div className="rounded-[14px] bg-brand-gradient p-[2px]">
            <div className="rounded-[12px] bg-card p-[18px] text-center">
              <div className="font-display text-2xl font-extrabold tracking-[-0.012em]">
                {audit.roomNumber ? `Room ${audit.roomNumber}` : audit.propertyName ?? audit.title}
              </div>
              <div className="mt-1 text-[12.5px] text-muted-foreground">
                {[audit.propertyName, audit.roomNumber ? `Room ${audit.roomNumber}` : null].filter(Boolean).join(" · ") || audit.ticketNo}
              </div>
              <span className="mt-2.5 inline-block rounded-full bg-muted px-3 py-[5px] text-[11.5px] font-bold text-muted-foreground">
                {progress.total} question{progress.total === 1 ? "" : "s"} · ~{Math.max(5, Math.round(progress.total * 0.7))} min
              </span>
            </div>
          </div>
          {/* Auto-captured */}
          <div className="rounded-[14px] border border-border bg-card p-4">
            <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
              Auto-captured before you begin
            </div>
            <div className="flex items-center gap-3 border-b border-dashed border-border py-2.5">
              <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-success text-[17px] text-white">📍</span>
              <div className="flex-1">
                <div className="text-[13.5px] font-bold">Location (GPS)</div>
                {/* TODO(backend): GPS-matches-property verification not surfaced by the run payload yet. */}
                <div className="font-mono text-[11.5px] text-muted-foreground">Captured & stamped the moment you start</div>
              </div>
            </div>
            <div className="flex items-center gap-3 py-2.5">
              <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-success text-[17px] text-white">🕐</span>
              <div className="flex-1">
                <div className="text-[13.5px] font-bold">Start time</div>
                <div className="font-mono text-[11.5px] text-muted-foreground">Recorded when you tap Start</div>
              </div>
            </div>
          </div>
          <div className="rounded-[12px] bg-info-soft px-3.5 py-[11px] text-[12px] font-semibold text-info">
            🔒 {audit.state === "REJECTED"
              ? "This audit was rejected — start the rework. Location and start time are re-stamped."
              : "Location and start time are attached to this audit and can't be edited later."}
          </div>
          <Button
            className="h-[50px] w-full rounded-[12px] text-[15px] font-bold"
            disabled={transitionBusy}
            onClick={() => void startAudit()}
          >
            {transitionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {audit.state === "REJECTED" ? "Start rework →" : "Start audit →"}
          </Button>
        </div>
      )}
      {!editable && !(isAssignee && ["SCHEDULED", "REJECTED"].includes(audit.state)) && (
        <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {!isAssignee
            ? "You are not the assignee — read-only view."
            : "Responses are frozen in this state — read-only view."}
        </div>
      )}

      {/* Sections */}
      {!notStarted && (
      <Accordion
        type="single"
        collapsible
        value={openSection}
        onValueChange={(v) => setOpenSection(v)}
        className="space-y-3"
      >
        {sections.map((section) => {
          const applicable = section.questions.filter((q) => q.type !== "INSTRUCTION");
          const answeredCount = applicable.filter((q) => hasAnswer(answers[q.id])).length;
          const secWeight = section.questions.reduce(
            (a, q) => a + (NON_SCORED_TYPES.has(q.type) ? 0 : Math.max(0, q.weight || 0)),
            0,
          );
          const secWeightPct = totalWeight > 0 ? Math.round((secWeight / totalWeight) * 100) : 0;
          const isOpen = openSection === section.id;
          return (
            <AccordionItem
              key={section.id}
              value={section.id}
              className="scroll-mt-24 border-none"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <span className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                  <span className="truncate text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">{section.title}</span>
                  {section.audience && (
                    <Badge variant="outline" className="hidden sm:inline-flex">{section.audience}</Badge>
                  )}
                  <span className="flex-1" />
                  {secWeightPct > 0 && (
                    <span className="hidden font-mono text-[10.5px] text-muted-foreground sm:inline">weight {secWeightPct}%</span>
                  )}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {answeredCount}/{applicable.length}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {/* Perf (NFR-02): only the open section renders its questions. */}
                {isOpen && (
                  <div className="space-y-3">
                    {section.questions.map((q) => {
                      const local = answers[q.id];
                      const evidence = local?.responseId
                        ? evidenceByResponse.get(local.responseId) ?? []
                        : [];
                      return (
                        <QuestionCard
                          key={q.id}
                          question={q}
                          local={local}
                          snapshot={snapshot}
                          editable={editable}
                          evidence={evidence}
                          maxFiles={responsePolicy.maxFiles}
                          flash={flashQid === q.id}
                          onAnswer={(answerJson) => setAnswer(q, answerJson)}
                          onNotes={(notes) => setNotes(q, notes)}
                          onRetry={() => void doSave(q.id)}
                          onOpenCamera={() => setCameraTarget({ kind: "response", question: q })}
                          onDeleteEvidence={(eid) => void deleteEvidence(eid)}
                        />
                      );
                    })}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      )}

      {/* Bottom submit dock (scoring is server-side at submit) */}
      {!notStarted && (
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)] md:left-64">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="truncate text-right text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">
                {progress.answered}/{progress.total}
              </span>{" "}
              answered
              {progress.mandatoryLeft > 0 && (
                <span className="text-warning"> · {progress.mandatoryLeft} mandatory left</span>
              )}
            </p>
            <Progress
              value={progress.total > 0 ? (progress.answered / progress.total) * 100 : 0}
              className="mt-1.5 h-2"
            />
          </div>
          <Button
            className="min-h-11 shrink-0"
            disabled={!editable}
            onClick={() => void openSubmitSheet()}
          >
            <Send className="mr-2 h-4 w-4" /> Submit
          </Button>
        </div>
      </div>
      )}

      {/* Submit sheet */}
      <Drawer
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o);
          if (!o && submitResult) {
            navigate(`/audits/${id}`);
            toast({ title: "Audit submitted" });
          }
        }}
      >
        <DrawerContent className="mx-auto max-w-lg">
          {submitResult ? (
            <div className="space-y-4 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center">
              <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
              <DrawerTitle className="font-display">Audit submitted</DrawerTitle>
              <div className="space-y-1">
                <p className={`text-4xl font-bold tabular-nums ${scoreColorClass(submitResult.pct)}`}>
                  {submitResult.pct != null ? `${Number(submitResult.pct).toFixed(1)}%` : "—"}
                </p>
                <div className="flex items-center justify-center gap-2">
                  {submitResult.result && (
                    <Badge variant={submitResult.result === "PASS" ? "success" : "destructive"}>
                      {submitResult.result}
                    </Badge>
                  )}
                  {submitResult.band && <Badge variant="outline">{submitResult.band}</Badge>}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {audit.reviewRequired
                  ? "Sent to Ops Excellence for review — you'll be alerted when it's decided."
                  : "Auto-approved — no review required."}
                {/* TODO(backend): on-time streak + WhatsApp alert (prototype) not returned yet. */}
              </p>
              <Button
                className="min-h-11 w-full"
                onClick={() => {
                  setSheetOpen(false);
                  navigate(`/audits/${id}`);
                  toast({ title: "Audit submitted" });
                }}
              >
                Go to audit
              </Button>
            </div>
          ) : (
            <div className="space-y-4 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <DrawerHeader className="p-0 text-left">
                <DrawerTitle className="font-display">Submit audit</DrawerTitle>
                <DrawerDescription>
                  Responses freeze and the score is computed once — no edits after this.
                </DrawerDescription>
              </DrawerHeader>

              {checkQuery.isFetching ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking…
                </div>
              ) : blockers.length > 0 ? (
                <div className="space-y-2">
                  {blockers
                    .filter((b) => b.kind !== "LIVE_PHOTO_REQUIRED")
                    .map((b, i) => (
                      <button
                        key={`${b.kind}-${b.questionId ?? i}`}
                        type="button"
                        onClick={() => jumpToBlocker(b)}
                        className="flex min-h-11 w-full items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      >
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {b.kind === "UNANSWERED_MANDATORY" ? "Unanswered: " : "Evidence missing: "}
                          {b.prompt ?? b.questionId}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      </button>
                    ))}
                </div>
              ) : null}

              {/* Live submission proof step */}
              {!checkQuery.isFetching && (onlyLivePhoto || canSubmit) && (
                <div className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Live geotagged photo</p>
                      <p className="text-xs text-muted-foreground">
                        {hasSubmissionProof && !onlyLivePhoto
                          ? "Captured — you're good to go."
                          : "Required proof of presence, captured in-app with GPS."}
                      </p>
                    </div>
                    {onlyLivePhoto ? (
                      <Button
                        size="sm"
                        className="min-h-11 shrink-0"
                        onClick={() => setCameraTarget({ kind: "submission" })}
                      >
                        <Camera className="mr-1.5 h-4 w-4" /> Capture
                      </Button>
                    ) : (
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                    )}
                  </div>
                </div>
              )}

              {!checkQuery.isFetching && !onlyLivePhoto && blockers.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <MapPinOff className="mr-1 inline h-3.5 w-3.5" />
                  Fix the items above first — the live photo step follows.
                </p>
              )}

              <Button
                className="min-h-11 w-full"
                disabled={!canSubmit || submitMut.isPending}
                onClick={() => submitMut.mutate()}
              >
                {submitMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Submit audit
              </Button>
            </div>
          )}
        </DrawerContent>
      </Drawer>

      {/* Camera */}
      <CameraCapture
        open={cameraTarget != null}
        onOpenChange={(o) => { if (!o) setCameraTarget(null); }}
        purpose={cameraTarget?.kind === "submission" ? "submission-proof" : "evidence"}
        auditorName={me?.name ?? "Auditor"}
        onCapture={uploadEvidence}
      />

    </div>
  );
}
