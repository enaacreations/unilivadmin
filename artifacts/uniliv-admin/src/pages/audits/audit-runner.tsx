import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, ArrowLeft, Camera, Check, CheckCircle2,
  ChevronRight, Eraser, Info, Loader2, Lock, MapPinOff, Pen, Play, Plus,
  RotateCcw, Send, Star, Trash2, X,
} from "lucide-react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { locateOnce } from "@/hooks/use-geolocation";
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import { useConfetti } from "@/components/ui/confetti";
import { CameraCapture, type CaptureMeta } from "@/components/audits/camera-capture";
import {
  AUDIT_STATE_BADGE, NC_SEVERITIES, NON_SCORED_TYPES,
  resolveMultiplierClient, scoreColorClass, titleCase,
  type ApiError, type ApiList, type ApiOne, type NcSeverity, type QuestionType,
  type RunEvidence, type RunNc, type RunPayload, type RunQuestion, type RunSection,
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

const ADHOC_TYPES: QuestionType[] = ["RATING", "YES_NO_NA", "PASS_FAIL", "TEXT"];

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
        <div className="flex flex-wrap gap-2">
          {values.map((v) => {
            const selected = current === v;
            return (
              <button
                key={v}
                type="button"
                disabled={!editable}
                // Re-tapping the current answer is a no-op (matches the old
                // ToggleGroup) so it doesn't fire a redundant save / re-open
                // the auto-NC dialog.
                onClick={() => { if (current !== v) onAnswer({ value: v }); }}
                className={cn(
                  "inline-flex h-11 min-w-[76px] items-center justify-center rounded-[10px] border px-5 text-sm font-semibold transition-colors disabled:opacity-60",
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
      return (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const selected = current === o.id;
            return (
              <button
                key={o.id}
                type="button"
                disabled={!editable}
                onClick={() => onAnswer({ optionId: o.id })}
                className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm transition-colors disabled:opacity-60 ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : o.isExcludedNa
                      ? "border-dashed bg-transparent text-muted-foreground hover:bg-muted"
                      : "bg-card hover:bg-muted"
                }`}
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
  question, local, snapshot, editable, evidence, nc, ncSuggestedStale, maxFiles,
  bulkMode, bulkSelected, flash,
  onAnswer, onNotes, onRetry, onOpenCamera, onDeleteEvidence, onToggleBulk,
}: {
  question: RunQuestion;
  local: LocalAnswer | undefined;
  snapshot: ScaleSnapshot | null;
  editable: boolean;
  evidence: RunEvidence[];
  nc: RunNc | undefined;
  ncSuggestedStale: boolean;
  maxFiles: number;
  bulkMode: boolean;
  bulkSelected: boolean;
  flash: boolean;
  onAnswer: (answerJson: unknown) => void;
  onNotes: (notes: string) => void;
  onRetry: () => void;
  onOpenCamera: () => void;
  onDeleteEvidence: (eid: string) => void;
  onToggleBulk: (checked: boolean) => void;
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
        {bulkMode && (
          <Checkbox
            className="mt-1"
            checked={bulkSelected}
            onCheckedChange={(c) => onToggleBulk(c === true)}
            aria-label="Select for bulk answer"
          />
        )}
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

          {/* NC chips */}
          {(nc || ncSuggestedStale) && (
            <div className="flex flex-wrap gap-1.5">
              {nc && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" /> {nc.ncNo} · {titleCase(nc.severity)}
                </Badge>
              )}
              {!nc && ncSuggestedStale && (
                <Badge variant="warning" className="gap-1">
                  <AlertTriangle className="h-3 w-3" /> NC suggested
                </Badge>
              )}
            </div>
          )}

          {/* Prototype: a raised finding reads as a full callout, not just a chip. */}
          {nc && (
            <div className="rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px]">
              <div className="mb-0.5 font-semibold text-destructive">A finding was raised</div>
              <div className="text-muted-foreground">
                {nc.description ? `"${nc.description}" — ` : ""}the property team has been asked to fix it before its deadline.
              </div>
            </div>
          )}

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
  const questionById = React.useMemo(
    () => new Map(allQuestions.map((q) => [q.id, q])),
    [allQuestions],
  );

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

  const [ncDialog, setNcDialog] = React.useState<{
    questionId: string;
    responseId: string | null;
    severity: NcSeverity;
    description: string;
  } | null>(null);
  const [ncOwnerRequired, setNcOwnerRequired] = React.useState(false);
  const [ncOwnerId, setNcOwnerId] = React.useState("");
  const [suggestedQids, setSuggestedQids] = React.useState<Set<string>>(new Set());

  const invalidateRun = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/audits", id, "run"] });
    qc.invalidateQueries({ queryKey: ["/audits", id] });
  }, [qc, id]);

  const doSave = React.useCallback(
    (qid: string): Promise<unknown> => {
      const local = answersRef.current[qid];
      if (!local) return Promise.resolve();
      const revAtSend = local.rev;
      const question = questionById.get(qid);
      const promise = apiFetch<ApiOne<{ id: string; ncSuggested: boolean; ncRule: { severity: NcSeverity } | null }>>(
        `/audits/${id}/responses/${qid}`,
        {
          method: "PUT",
          body: JSON.stringify({
            answerJson: local.answerJson,
            isNa: local.isNa,
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
          if (res.data.ncSuggested && question) {
            setNcOwnerRequired(false);
            setNcOwnerId("");
            setNcDialog({
              questionId: qid,
              responseId: res.data.id,
              severity: res.data.ncRule?.severity ?? "MINOR",
              description: `Failed: ${question.prompt}`,
            });
          } else {
            // Answer changed to something clean — drop a stale suggestion chip.
            setSuggestedQids((prev) => {
              if (!prev.has(qid)) return prev;
              const next = new Set(prev);
              next.delete(qid);
              return next;
            });
          }
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
    [id, questionById, toast],
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
      const resolved = resolveMultiplierClient(question, answerJson, snapshot);
      setAnswers((prev) => {
        const cur = prev[question.id];
        return {
          ...prev,
          [question.id]: {
            answerJson,
            isNa: resolved.isNa,
            notes: cur?.notes ?? null,
            responseId: cur?.responseId ?? null,
            saveState: "pending",
            rev: (cur?.rev ?? 0) + 1,
          },
        };
      });
      queueSave(question.id);
    },
    [queueSave, snapshot],
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

  /* — Derived progress & provisional score — */
  const progress = React.useMemo(() => {
    const applicable = allQuestions.filter((q) => q.type !== "INSTRUCTION");
    const answered = applicable.filter((q) => hasAnswer(answers[q.id]));
    const mandatoryLeft = applicable.filter((q) => q.mandatory && !hasAnswer(answers[q.id])).length;
    return { total: applicable.length, answered: answered.length, mandatoryLeft };
  }, [allQuestions, answers]);

  const scoreOf = React.useCallback(
    (questions: RunQuestion[]): number | null => {
      let earned = 0;
      let max = 0;
      for (const q of questions) {
        if (NON_SCORED_TYPES.has(q.type) || q.weight <= 0) continue;
        const local = answers[q.id];
        if (!hasAnswer(local)) continue;
        const r = resolveMultiplierClient(q, local!.answerJson, snapshot);
        if (r.isNa || r.multiplierPct == null) continue;
        earned += (r.multiplierPct / 100) * q.weight;
        max += q.weight;
      }
      return max > 0 ? (earned / max) * 100 : null;
    },
    [answers, snapshot],
  );
  const provisionalPct = React.useMemo(() => scoreOf(allQuestions), [scoreOf, allQuestions]);

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

  /* — Evidence & NCs by question — */
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
  const ncByQuestion = React.useMemo(() => {
    const map = new Map<string, RunNc>();
    for (const nc of run?.ncs ?? []) if (nc.questionId) map.set(nc.questionId, nc);
    return map;
  }, [run?.ncs]);
  const hasSubmissionProof = React.useMemo(
    () =>
      (run?.evidence ?? []).some(
        (e) => e.kind === "SUBMISSION_PROOF" && e.isLiveCapture && e.geoLat != null,
      ),
    [run?.evidence],
  );

  /* — State transitions from the runner — */
  const [transitionBusy, setTransitionBusy] = React.useState(false);
  const startOrResume = async (action: "start" | "resume") => {
    setTransitionBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (action === "start") {
        const geo = await locateOnce();
        if (geo) body["geo"] = { lat: geo.lat, lng: geo.lng };
      }
      await apiFetch(`/audits/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
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

  /* — Auto-NC dialog — */
  const usersQuery = useQuery({
    queryKey: ["/users", "nc-owner-picker"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string; role: string }>>("/users?limit=100"),
    enabled: ncOwnerRequired,
  });
  const ncMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<{ ncNo: string }>>(`/audits/${id}/ncs`, {
        method: "POST",
        body: JSON.stringify({
          responseId: ncDialog?.responseId ?? undefined,
          questionId: ncDialog?.questionId,
          severity: ncDialog?.severity,
          description: ncDialog?.description,
          ...(ncOwnerId ? { ownerId: ncOwnerId } : {}),
        }),
      }),
    onSuccess: (res) => {
      toast({ title: `Finding ${res.data.ncNo} raised` });
      if (ncDialog) {
        setSuggestedQids((prev) => {
          const next = new Set(prev);
          next.delete(ncDialog.questionId);
          return next;
        });
      }
      setNcDialog(null);
      setNcOwnerRequired(false);
      setNcOwnerId("");
      invalidateRun();
    },
    onError: (e: ApiError) => {
      if (e.status === 422 && /owner/i.test(e.message)) {
        setNcOwnerRequired(true);
        toast({
          title: "Pick an owner",
          description: "The property has no Unit Lead — choose who owns this finding.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: e.message || "Could not raise the finding", variant: "destructive" });
    },
  });
  const dismissNcDialog = () => {
    if (ncDialog) setSuggestedQids((prev) => new Set(prev).add(ncDialog.questionId));
    setNcDialog(null);
    setNcOwnerRequired(false);
    setNcOwnerId("");
  };

  /* — Bulk answer — */
  const [bulkSectionId, setBulkSectionId] = React.useState<string | null>(null);
  const [bulkSelected, setBulkSelected] = React.useState<Set<string>>(new Set());
  const [bulkAnswer, setBulkAnswer] = React.useState<string>("");
  const [bulkNote, setBulkNote] = React.useState("");
  const bulkSection = sections.find((s) => s.id === bulkSectionId) ?? null;
  const bulkType: QuestionType | null = React.useMemo(() => {
    if (!bulkSection) return null;
    const counts = new Map<QuestionType, number>();
    for (const q of bulkSection.questions) {
      if (q.type === "RATING" || q.type === "YES_NO_NA" || q.type === "PASS_FAIL") {
        counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
      }
    }
    let best: QuestionType | null = null;
    let bestCount = 0;
    for (const [t, c] of counts) if (c > bestCount) { best = t; bestCount = c; }
    return best;
  }, [bulkSection]);
  const exitBulk = () => {
    setBulkSectionId(null);
    setBulkSelected(new Set());
    setBulkAnswer("");
    setBulkNote("");
  };
  const bulkMut = useMutation({
    mutationFn: () => {
      const answerJson =
        bulkType === "RATING" ? { optionId: bulkAnswer } : { value: bulkAnswer };
      return apiFetch<ApiOne<{ questionId: string; ncSuggested: boolean }[]>>(
        `/audits/${id}/responses/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            questionIds: [...bulkSelected],
            answerJson,
            ...(bulkNote.trim() ? { notes: bulkNote.trim() } : {}),
          }),
        },
      );
    },
    onSuccess: (res) => {
      const suggested = res.data.filter((r) => r.ncSuggested).map((r) => r.questionId);
      if (suggested.length) {
        setSuggestedQids((prev) => {
          const next = new Set(prev);
          for (const qid of suggested) next.add(qid);
          return next;
        });
      }
      toast({
        title: `${res.data.length} answers applied`,
        description: suggested.length ? `${suggested.length} flagged for a finding` : undefined,
      });
      // Reflect immediately, then let the refetch reconcile responseIds.
      const answerJson = bulkType === "RATING" ? { optionId: bulkAnswer } : { value: bulkAnswer };
      setAnswers((prev) => {
        const next = { ...prev };
        for (const qid of bulkSelected) {
          const q = questionById.get(qid);
          const resolved = q ? resolveMultiplierClient(q, answerJson, snapshot) : { isNa: false };
          next[qid] = {
            answerJson,
            isNa: resolved.isNa,
            notes: bulkNote.trim() || prev[qid]?.notes || null,
            responseId: prev[qid]?.responseId ?? null,
            saveState: "saved",
            rev: (prev[qid]?.rev ?? 0) + 1,
          };
        }
        return next;
      });
      exitBulk();
      invalidateRun();
    },
    onError: (e: Error) => toast({ title: e.message || "Bulk answer failed", variant: "destructive" }),
  });

  /* — Ad-hoc questions — */
  const [adhocFor, setAdhocFor] = React.useState<RunSection | null>(null);
  const [adhocPrompt, setAdhocPrompt] = React.useState("");
  const [adhocType, setAdhocType] = React.useState<QuestionType>("RATING");
  const adhocMut = useMutation({
    mutationFn: () =>
      apiFetch(`/audits/${id}/adhoc-questions`, {
        method: "POST",
        body: JSON.stringify({
          sectionId: adhocFor?.id,
          prompt: adhocPrompt.trim(),
          type: adhocType,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Item added" });
      setAdhocFor(null);
      setAdhocPrompt("");
      setAdhocType("RATING");
      invalidateRun();
    },
    onError: (e: Error) => toast({ title: e.message || "Could not add item", variant: "destructive" }),
  });

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
  const bulkActive = bulkSectionId != null;

  return (
    <div className="mx-auto max-w-3xl pb-40">
      {confetti}
      {/* Top bar */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-4 border-b bg-surface/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:-mt-6 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Link
            href={`/audits/${id}`}
            className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="truncate font-mono text-sm font-semibold">{audit.ticketNo}</span>
          <Badge variant={AUDIT_STATE_BADGE[audit.state] ?? "outline"}>{titleCase(audit.state)}</Badge>
          <span className="flex-1" />
          <span className="text-right leading-none" title="Provisional score (answered questions only)">
            <span className={cn("block font-mono text-xl font-semibold tabular-nums", scoreColorClass(provisionalPct))}>
              {provisionalPct != null ? `${provisionalPct.toFixed(0)}%` : "—"}
            </span>
            <span className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground">live score</span>
          </span>
        </div>
      </div>

      {/* Title + progress (prototype) */}
      <h1 className="mb-1 font-display text-xl font-bold tracking-[-0.012em]">{audit.title}</h1>
      <p className="mb-3 text-[13px] text-muted-foreground">
        <span className="font-mono">{audit.ticketNo}</span>
        {audit.propertyName ? ` · ${audit.propertyName}` : ""}
      </p>
      {progress.total > 0 && (
        <>
          <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand-gradient transition-[width] duration-300"
              style={{ width: `${Math.round((progress.answered / progress.total) * 100)}%` }}
            />
          </div>
          <p className="mb-4 text-[13px] text-muted-foreground">
            {progress.answered} of {progress.total} answered
            {progress.mandatoryLeft > 0
              ? ` · ${progress.mandatoryLeft} required left`
              : " · all required done"}
          </p>
        </>
      )}

      {/* State gates */}
      {isAssignee && (audit.state === "SCHEDULED" || audit.state === "REJECTED") && (
        <Card className="mb-4">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Play className="h-8 w-8 text-primary" />
            <p className="font-medium">
              {audit.state === "REJECTED" ? "This audit was rejected — start the rework." : "Ready to begin?"}
            </p>
            <p className="text-sm text-muted-foreground">
              Your location is captured at start (when permitted) and stamped on the record.
            </p>
            <Button className="min-h-11 px-8" disabled={transitionBusy} onClick={() => startOrResume("start")}>
              {transitionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {audit.state === "REJECTED" ? "Start rework" : "Start audit"}
            </Button>
          </CardContent>
        </Card>
      )}
      {isAssignee && audit.state === "PAUSED" && (
        <Card className="mb-4">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Play className="h-8 w-8 text-primary" />
            <p className="font-medium">This audit is paused.</p>
            <Button className="min-h-11 px-8" disabled={transitionBusy} onClick={() => startOrResume("resume")}>
              {transitionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Resume
            </Button>
          </CardContent>
        </Card>
      )}
      {!editable && !(isAssignee && ["SCHEDULED", "PAUSED", "REJECTED"].includes(audit.state)) && (
        <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {!isAssignee
            ? "You are not the assignee — read-only view."
            : "Responses are frozen in this state — read-only view."}
        </div>
      )}

      {/* Sections */}
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
          const sectionPct = scoreOf(section.questions);
          const isOpen = openSection === section.id;
          const inBulk = bulkSectionId === section.id;
          return (
            <AccordionItem
              key={section.id}
              value={section.id}
              className="rounded-lg border bg-card px-4 last:border-b"
            >
              <AccordionTrigger className="hover:no-underline">
                <span className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                  <span className="truncate font-medium">{section.title}</span>
                  {section.audience && (
                    <Badge variant="outline" className="hidden sm:inline-flex">{section.audience}</Badge>
                  )}
                  <span className="flex-1" />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {answeredCount}/{applicable.length}
                  </span>
                  {sectionPct != null && (
                    <span className={`text-xs font-semibold tabular-nums ${scoreColorClass(sectionPct)}`}>
                      {sectionPct.toFixed(0)}%
                    </span>
                  )}
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {/* Perf (NFR-02): only the open section renders its questions. */}
                {isOpen && (
                  <div className="space-y-3">
                    {editable && (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant={inBulk ? "secondary" : "ghost"}
                          size="sm"
                          className="min-h-11 sm:min-h-9"
                          onClick={() => (inBulk ? exitBulk() : (setBulkSectionId(section.id), setBulkSelected(new Set())))}
                        >
                          {inBulk ? "Done selecting" : "Select"}
                        </Button>
                        {inBulk && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-h-11 sm:min-h-9"
                            onClick={() =>
                              setBulkSelected(new Set(applicable.map((q) => q.id)))
                            }
                          >
                            Select all
                          </Button>
                        )}
                      </div>
                    )}
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
                          nc={ncByQuestion.get(q.id)}
                          ncSuggestedStale={suggestedQids.has(q.id)}
                          maxFiles={responsePolicy.maxFiles}
                          bulkMode={inBulk}
                          bulkSelected={bulkSelected.has(q.id)}
                          flash={flashQid === q.id}
                          onAnswer={(answerJson) => setAnswer(q, answerJson)}
                          onNotes={(notes) => setNotes(q, notes)}
                          onRetry={() => void doSave(q.id)}
                          onOpenCamera={() => setCameraTarget({ kind: "response", question: q })}
                          onDeleteEvidence={(eid) => void deleteEvidence(eid)}
                          onToggleBulk={(checked) =>
                            setBulkSelected((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(q.id);
                              else next.delete(q.id);
                              return next;
                            })
                          }
                        />
                      );
                    })}
                    {editable && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 w-full border-dashed"
                        onClick={() => setAdhocFor(section)}
                      >
                        <Plus className="mr-1.5 h-4 w-4" /> Add item
                      </Button>
                    )}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {/* Bulk answer bar */}
      {bulkActive && bulkSection && (
        <div className="fixed inset-x-0 bottom-[76px] z-30 border-t bg-card shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)] md:left-64">
          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-3 sm:px-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Bulk answer · {bulkSelected.size} selected
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={exitBulk}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {bulkType === "RATING" ? (
              <div className="flex flex-wrap gap-2">
                {[...(snapshot?.options ?? [])]
                  .sort((x, y) => (x.orderIndex ?? 0) - (y.orderIndex ?? 0))
                  .map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setBulkAnswer(o.id)}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm ${
                        bulkAnswer === o.id
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-card hover:bg-muted"
                      }`}
                    >
                      {o.color && (
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.color }} />
                      )}
                      {o.label}
                    </button>
                  ))}
              </div>
            ) : bulkType ? (
              <ToggleGroup
                type="single"
                variant="outline"
                value={bulkAnswer}
                onValueChange={(v) => { if (v) setBulkAnswer(v); }}
                className="justify-start"
              >
                {(bulkType === "YES_NO_NA" ? ["YES", "NO", "NA"] : ["PASS", "FAIL"]).map((v) => (
                  <ToggleGroupItem key={v} value={v} className="min-h-11 px-6 text-base">
                    {v === "NA" ? "N/A" : titleCase(v)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <p className="text-sm text-muted-foreground">
                No bulk-answerable questions (Rating / Yes-No / Pass-Fail) in this section.
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
                placeholder="Optional note for all selected"
                className="min-h-11 text-base"
              />
              <Button
                type="button"
                className="min-h-11"
                disabled={bulkSelected.size === 0 || !bulkAnswer || !bulkType || bulkMut.isPending}
                onClick={() => bulkMut.mutate()}
              >
                {bulkMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom progress / submit dock */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)] md:left-64">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">
                {progress.answered}/{progress.total}
              </span>{" "}
              answered
              {progress.mandatoryLeft > 0 && (
                <span className="text-amber-600"> · {progress.mandatoryLeft} mandatory left</span>
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

      {/* Auto-NC dialog */}
      <FormModal
        open={ncDialog != null}
        onOpenChange={(o) => { if (!o) dismissNcDialog(); }}
        title="Raise a finding?"
        onSave={() => { if (ncDialog?.description.trim()) ncMut.mutate(); }}
        isSaving={ncMut.isPending}
        saveLabel="Raise NC"
        cancelLabel="Dismiss"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This answer trips the question's auto-NC rule. Confirm to raise a
            non-conformance for the property team — attach evidence on the
            question afterwards to strengthen it.
          </p>
          <div className="space-y-2">
            <Label>Severity</Label>
            <Select
              value={ncDialog?.severity ?? "MINOR"}
              onValueChange={(v) =>
                setNcDialog((d) => (d ? { ...d, severity: v as NcSeverity } : d))
              }
            >
              <SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                {NC_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={ncDialog?.description ?? ""}
              rows={3}
              className="text-base"
              onChange={(e) =>
                setNcDialog((d) => (d ? { ...d, description: e.target.value } : d))
              }
            />
          </div>
          {ncOwnerRequired && (
            <div className="space-y-2">
              <Label>Owner</Label>
              <p className="text-xs text-muted-foreground">
                The property has no Unit Lead — pick who owns this finding.
              </p>
              <Select value={ncOwnerId} onValueChange={setNcOwnerId}>
                <SelectTrigger className="min-h-11">
                  <SelectValue placeholder={usersQuery.isLoading ? "Loading users…" : "Pick a user"} />
                </SelectTrigger>
                <SelectContent>
                  {(usersQuery.data?.data ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} · {titleCase(u.role)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {usersQuery.isError && (
                <p className="text-xs text-destructive">
                  Couldn't load the user list with your role — ask an admin to
                  assign a Unit Lead to this property, or raise the finding later.
                </p>
              )}
            </div>
          )}
        </div>
      </FormModal>

      {/* Ad-hoc question dialog */}
      <FormModal
        open={adhocFor != null}
        onOpenChange={(o) => { if (!o) setAdhocFor(null); }}
        title={`Add item — ${adhocFor?.title ?? ""}`}
        onSave={() => { if (adhocPrompt.trim()) adhocMut.mutate(); }}
        isSaving={adhocMut.isPending}
        saveLabel="Add item"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Ad-hoc items get a fixed default weight and are queued for the
            question bank (admin review).
          </p>
          <div className="space-y-2">
            <Label>Prompt</Label>
            <Textarea
              value={adhocPrompt}
              rows={3}
              maxLength={500}
              className="text-base"
              placeholder="What should be checked?"
              onChange={(e) => setAdhocPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={adhocType} onValueChange={(v) => setAdhocType(v as QuestionType)}>
              <SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ADHOC_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{titleCase(t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormModal>
    </div>
  );
}
