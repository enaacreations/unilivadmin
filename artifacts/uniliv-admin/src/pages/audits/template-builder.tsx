import * as React from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Check, ChevronLeft, Eye, Library, Loader2, Lock,
  Plus, Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import {
  EVIDENCE_RULES, NC_SEVERITIES, NON_SCORED_TYPES, QUESTION_TYPES,
  sectionPoints, titleCase,
  type ApiError, type ApiList, type ApiOne, type AutoNcRule, type BankItem,
  type BuilderQuestion, type BuilderSection, type NcSeverity, type QuestionType,
  type RatingScale, type TemplateDetail, type VersionDetail,
} from "./lib";
import { ChoiceOptionsEditor, DuplicateWarning, LifecycleBadge, PublishDialog, useDuplicatePrompts } from "./shared";

/* Template builder (redesign — prototype "Template builder"). Category cards
 * with inline question rows (reorder, mandatory, weight) and a score-model /
 * pass-line sidebar. Wording, response type and options are edited in a details
 * sheet (which surfaces the full question editor) — the same copy-on-insert
 * question the Question Bank seeds. All builder edits require a DRAFT version. */

const QTYPE_LABEL: Record<QuestionType, string> = {
  YES_NO_NA: "Yes / No / N/A",
  PASS_FAIL: "Pass / Fail",
  RATING: "Rating",
  SINGLE_CHOICE: "Single choice",
  MULTI_CHOICE: "Multi choice",
  NUMERIC: "Numeric",
  TEXT: "Text",
  PHOTO: "Photo",
  SIGNATURE: "Signature",
  DATE: "Date",
  INSTRUCTION: "Instruction",
};

/** Category colour palette for the score-model bar (cycled by section index). */
const CAT_COLORS = [
  "bg-accent", "bg-info", "bg-success", "bg-warning",
  "bg-[#7C5CFF]", "bg-[#E86FA6]", "bg-teal-500", "bg-amber-500",
];

const STEP =
  "flex h-6 w-6 items-center justify-center rounded-[7px] border border-border bg-card text-[13px] leading-none text-foreground transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Prompt editor for a builder question with debounced near-duplicate detection.
 * Own component so the useDuplicatePrompts hook obeys the rules of hooks
 * (the Inspector early-returns before the question block).
 */
function QuestionPromptField({
  questionId,
  prompt,
  readOnly,
  onChange,
}: {
  questionId: string;
  prompt: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  // Only warn for genuinely new prompts, not while reviewing a published version.
  const matches = useDuplicatePrompts(readOnly ? "" : prompt, questionId);
  return (
    <div className="space-y-2">
      <Label>Prompt</Label>
      <Textarea
        value={prompt}
        disabled={readOnly}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
      />
      {!readOnly && <DuplicateWarning matches={matches} />}
    </div>
  );
}

/* ── Trigger-answer options for the auto-NC editor ───────────────────────── */

function triggerOptions(
  q: BuilderQuestion,
  scales: RatingScale[] | undefined,
): { id: string; label: string }[] | null {
  switch (q.type) {
    case "YES_NO_NA":
      return [
        { id: "NO", label: "No" },
        { id: "NA", label: "N/A" },
      ];
    case "PASS_FAIL":
      return [{ id: "FAIL", label: "Fail" }];
    case "RATING": {
      const scale =
        (q.ratingScaleId && scales?.find((s) => s.id === q.ratingScaleId)) ||
        scales?.find((s) => s.active) ||
        scales?.[0];
      if (!scale) return null;
      return [...scale.options]
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((o) => ({ id: o.id, label: `${o.label} (${Number(o.multiplierPct)}%)` }));
    }
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE":
      return (q.optionsJson ?? []).map((o) => ({ id: o.id, label: o.label }));
    default:
      return null;
  }
}

/* ── Inspector (question details sheet) — fully controlled ───────────────── */

function Inspector({
  section,
  question,
  scales,
  readOnly,
  onQuestionChange,
  onSectionChange,
}: {
  section: BuilderSection | undefined;
  question: BuilderQuestion | undefined;
  scales: RatingScale[] | undefined;
  readOnly: boolean;
  onQuestionChange: (qid: string, patch: Record<string, unknown>) => void;
  onSectionChange: (sid: string, patch: Record<string, unknown>) => void;
}) {
  if (!section) {
    return <p className="p-4 text-sm text-muted-foreground">Pick a section to begin.</p>;
  }

  if (!question) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Section</p>
        <div className="space-y-2">
          <Label>Title</Label>
          <Input
            value={section.title}
            disabled={readOnly}
            onChange={(e) => onSectionChange(section.id, { title: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea
            value={section.description ?? ""}
            disabled={readOnly}
            rows={3}
            onChange={(e) => onSectionChange(section.id, { description: e.target.value || null })}
          />
        </div>
        <div className="space-y-2">
          <Label>Audience</Label>
          <Input
            value={section.audience ?? ""}
            disabled={readOnly}
            placeholder="e.g. AUDITOR"
            onChange={(e) => onSectionChange(section.id, { audience: e.target.value || null })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Select a question card to edit its details here.
        </p>
      </div>
    );
  }

  const q = question;
  const autoNc = q.autoNcJson;
  const options = triggerOptions(q, scales);
  const setQ = (patch: Record<string, unknown>) => onQuestionChange(q.id, patch);

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Question</p>
      <QuestionPromptField
        questionId={q.id}
        prompt={q.prompt}
        readOnly={readOnly}
        onChange={(value) => setQ({ prompt: value })}
      />
      <div className="space-y-2">
        <Label>Help text</Label>
        <Input
          value={q.helpText ?? ""}
          disabled={readOnly}
          placeholder="Shown to the auditor under the prompt"
          onChange={(e) => setQ({ helpText: e.target.value || null })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select
            value={q.type}
            disabled={readOnly}
            onValueChange={(v) => setQ({ type: v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUESTION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{titleCase(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Weight</Label>
          <Input
            type="number"
            min={0}
            value={q.weight}
            disabled={readOnly || NON_SCORED_TYPES.has(q.type)}
            onChange={(e) => setQ({ weight: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
          />
          {NON_SCORED_TYPES.has(q.type) && (
            <p className="text-xs text-muted-foreground">Not scored.</p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Mandatory</p>
          <p className="text-xs text-muted-foreground">Must be answered before submit.</p>
        </div>
        <Switch
          checked={q.mandatory}
          disabled={readOnly}
          onCheckedChange={(c) => setQ({ mandatory: c })}
        />
      </div>
      <div className="space-y-2">
        <Label>Evidence rule</Label>
        <Select
          value={q.evidenceRule}
          disabled={readOnly}
          onValueChange={(v) => setQ({ evidenceRule: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {EVIDENCE_RULES.map((r) => (
              <SelectItem key={r} value={r}>{titleCase(r)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {q.type === "NUMERIC" && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label>Unit</Label>
            <Input
              value={q.numericUnit ?? ""}
              disabled={readOnly}
              placeholder="°C"
              onChange={(e) => setQ({ numericUnit: e.target.value || null })}
            />
          </div>
          <div className="space-y-2">
            <Label>Min</Label>
            <Input
              type="number"
              value={q.numericMin ?? ""}
              disabled={readOnly}
              onChange={(e) => setQ({ numericMin: e.target.value === "" ? null : e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Max</Label>
            <Input
              type="number"
              value={q.numericMax ?? ""}
              disabled={readOnly}
              onChange={(e) => setQ({ numericMax: e.target.value === "" ? null : e.target.value })}
            />
          </div>
        </div>
      )}

      {(q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE") && (
        <div className="space-y-2">
          <Label>Answer options</Label>
          <ChoiceOptionsEditor
            value={q.optionsJson ?? []}
            multi={q.type === "MULTI_CHOICE"}
            disabled={readOnly}
            onChange={(opts) => setQ({ optionsJson: opts })}
          />
        </div>
      )}

      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Auto-NC</p>
            <p className="text-xs text-muted-foreground">
              Raise a non-conformance automatically on trigger answers.
            </p>
          </div>
          <Switch
            checked={autoNc != null}
            disabled={readOnly}
            onCheckedChange={(c) =>
              setQ({
                autoNcJson: c
                  ? ({ onAnswers: [], severity: "MAJOR", ownerRule: "AUDITEE_OF_TARGET" } satisfies AutoNcRule)
                  : null,
              })
            }
          />
        </div>
        {autoNc && (
          <>
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select
                value={autoNc.severity}
                disabled={readOnly}
                onValueChange={(v) => setQ({ autoNcJson: { ...autoNc, severity: v as NcSeverity } })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {NC_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Trigger answers</Label>
              {options ? (
                options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Define answer options first — nothing to trigger on yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {options.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={autoNc.onAnswers.includes(o.id)}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            setQ({
                              autoNcJson: {
                                ...autoNc,
                                onAnswers: checked
                                  ? [...autoNc.onAnswers, o.id]
                                  : autoNc.onAnswers.filter((a) => a !== o.id),
                              },
                            })
                          }
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                )
              ) : (
                <Input
                  value={autoNc.onAnswers.join(", ")}
                  disabled={readOnly}
                  placeholder="Comma-separated trigger values"
                  onChange={(e) =>
                    setQ({
                      autoNcJson: {
                        ...autoNc,
                        onAnswers: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">Owner: auditee of target.</p>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Insert-from-bank dialog ─────────────────────────────────────────────── */

function BankDialog({
  open,
  onOpenChange,
  onInsert,
  inserting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (item: BankItem) => void;
  inserting: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const [tag, setTag] = React.useState("ALL");

  const bankQuery = useQuery({
    queryKey: ["/audit/bank", "picker"],
    queryFn: () => apiFetch<ApiList<BankItem>>("/audit/bank?limit=500"),
    enabled: open,
  });
  const tagsQuery = useQuery({
    queryKey: ["/audit/bank/tags"],
    queryFn: () => apiFetch<ApiOne<string[]>>("/audit/bank/tags"),
    enabled: open,
  });

  const items = React.useMemo(() => {
    const all = bankQuery.data?.data ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (i) =>
        (tag === "ALL" || i.tags.includes(tag)) &&
        (!q || i.prompt.toLowerCase().includes(q)),
    );
  }, [bankQuery.data, search, tag]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">Insert from question bank</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="Search prompts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All tags</SelectItem>
              {(tagsQuery.data?.data ?? []).map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="-mx-1 flex-1 space-y-2 overflow-y-auto px-1 py-2">
          {bankQuery.isLoading && <Skeleton className="h-32 w-full" />}
          {items.slice(0, 100).map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.prompt}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">{titleCase(item.type)}</Badge>
                  {!NON_SCORED_TYPES.has(item.type) && (
                    <span className="tabular-nums">{item.defaultWeight} pts</span>
                  )}
                  <span>· used in {item.usageCount}</span>
                  {item.tags.slice(0, 3).map((t) => (
                    <Badge key={t} variant="secondary">{t}</Badge>
                  ))}
                </div>
              </div>
              <Button size="sm" variant="outline" disabled={inserting} onClick={() => onInsert(item)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Insert
              </Button>
            </div>
          ))}
          {!bankQuery.isLoading && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No matching bank items.</p>
          )}
          {items.length > 100 && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Showing first 100 of {items.length} — refine your search.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function TemplateBuilder() {
  const params = useParams<{ id: string; vid: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();

  const versionKey = React.useMemo(
    () => ["/audit/templates/versions", params.vid] as const,
    [params.vid],
  );

  const versionQuery = useQuery({
    queryKey: versionKey,
    queryFn: () => apiFetch<ApiOne<VersionDetail>>(`/audit/templates/versions/${params.vid}`),
    enabled: Boolean(params.vid),
  });
  const templateQuery = useQuery({
    queryKey: ["/audit/templates", params.id],
    queryFn: () => apiFetch<ApiOne<TemplateDetail>>(`/audit/templates/${params.id}`),
    enabled: Boolean(params.id),
  });
  const scalesQuery = useQuery({
    queryKey: ["/audit/admin/rating-scales"],
    queryFn: () => apiFetch<ApiList<RatingScale>>("/audit/admin/rating-scales"),
    retry: false,
  });

  const version = versionQuery.data?.data;
  const template = templateQuery.data?.data;

  const [forcedReadOnly, setForcedReadOnly] = React.useState(false);
  const readOnly = forcedReadOnly || (version != null && version.lifecycle !== "DRAFT");

  const [selectedSectionId, setSelectedSectionId] = React.useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = React.useState<string | null>(null);
  const [saveState, setSaveState] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [bankOpen, setBankOpen] = React.useState(false);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [deleteQuestionId, setDeleteQuestionId] = React.useState<string | null>(null);
  const [deleteSectionId, setDeleteSectionId] = React.useState<string | null>(null);

  const openInspector = () => setSheetOpen(true);

  const sections = React.useMemo(() => {
    const list = [...(version?.sections ?? [])].sort((a, b) => a.orderIndex - b.orderIndex);
    return list.map((s) => ({
      ...s,
      questions: [...s.questions].sort((a, b) => a.orderIndex - b.orderIndex),
    }));
  }, [version]);

  const activeSection =
    sections.find((s) => s.id === selectedSectionId) ?? sections[0];
  const selectedQuestion = activeSection?.questions.find((q) => q.id === selectedQuestionId);

  React.useEffect(() => {
    if (!selectedSectionId && sections.length > 0) setSelectedSectionId(sections[0]!.id);
  }, [sections, selectedSectionId]);

  /* ── Debounced autosave (600ms) with optimistic cache patching ─────────── */

  const pendingRef = React.useRef<{
    kind: "question" | "section";
    id: string;
    patch: Record<string, unknown>;
  } | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pending) return;
    setSaveState("saving");
    const path =
      pending.kind === "question"
        ? `/audit/questions/${pending.id}`
        : `/audit/sections/${pending.id}`;
    apiFetch(path, { method: "PATCH", body: JSON.stringify(pending.patch) })
      .then(() => setSaveState("saved"))
      .catch((e: ApiError) => {
        setSaveState("error");
        toast({ title: e.message || "Save failed", variant: "destructive" });
        if (e.status === 409) setForcedReadOnly(true);
        qc.invalidateQueries({ queryKey: versionKey });
      });
  }, [qc, toast, versionKey]);

  const queueSave = React.useCallback(
    (kind: "question" | "section", id: string, patch: Record<string, unknown>) => {
      if (pendingRef.current && (pendingRef.current.id !== id || pendingRef.current.kind !== kind)) {
        flush();
      }
      pendingRef.current = pendingRef.current
        ? { ...pendingRef.current, patch: { ...pendingRef.current.patch, ...patch } }
        : { kind, id, patch };
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, 600);
    },
    [flush],
  );

  // Flush any pending edit when leaving the page.
  React.useEffect(() => () => flush(), [flush]);

  const patchCache = React.useCallback(
    (fn: (v: VersionDetail) => VersionDetail) => {
      qc.setQueryData<ApiOne<VersionDetail>>(versionKey, (old) =>
        old ? { ...old, data: fn(old.data) } : old,
      );
    },
    [qc, versionKey],
  );

  const onQuestionChange = React.useCallback(
    (qid: string, patch: Record<string, unknown>) => {
      if (readOnly) return;
      patchCache((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          questions: s.questions.map((q) =>
            q.id === qid ? ({ ...q, ...patch } as BuilderQuestion) : q,
          ),
        })),
      }));
      queueSave("question", qid, patch);
    },
    [patchCache, queueSave, readOnly],
  );

  const onSectionChange = React.useCallback(
    (sid: string, patch: Record<string, unknown>) => {
      if (readOnly) return;
      patchCache((v) => ({
        ...v,
        sections: v.sections.map((s) =>
          s.id === sid ? ({ ...s, ...patch } as BuilderSection) : s,
        ),
      }));
      queueSave("section", sid, patch);
    },
    [patchCache, queueSave, readOnly],
  );

  /* ── Structural mutations (immediate) ──────────────────────────────────── */

  const onStructuralError = (e: ApiError) => {
    toast({ title: e.message || "Action failed", variant: "destructive" });
    if (e.status === 409) setForcedReadOnly(true);
    qc.invalidateQueries({ queryKey: versionKey });
  };
  const invalidateVersion = () => qc.invalidateQueries({ queryKey: versionKey });

  const addSectionMut = useMutation({
    mutationFn: (title: string) =>
      apiFetch<ApiOne<BuilderSection>>("/audit/sections", {
        method: "POST",
        body: JSON.stringify({ templateVersionId: params.vid, title }),
      }),
    onSuccess: (res) => {
      setSelectedSectionId(res.data.id);
      setSelectedQuestionId(null);
      invalidateVersion();
    },
    onError: onStructuralError,
  });

  const deleteSectionMut = useMutation({
    mutationFn: (sid: string) => apiFetch(`/audit/sections/${sid}`, { method: "DELETE" }),
    onSuccess: (_r, sid) => {
      setDeleteSectionId(null);
      if (selectedSectionId === sid) {
        setSelectedSectionId(null);
        setSelectedQuestionId(null);
      }
      invalidateVersion();
    },
    onError: onStructuralError,
  });

  const reorderSectionsMut = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch("/audit/sections/reorder", {
        method: "POST",
        body: JSON.stringify({ templateVersionId: params.vid, orderedIds }),
      }),
    onSuccess: invalidateVersion,
    onError: onStructuralError,
  });

  const addQuestionMut = useMutation({
    mutationFn: ({ sid, body }: { sid: string; body: Record<string, unknown> }) =>
      apiFetch<ApiOne<BuilderQuestion>>(`/audit/sections/${sid}/questions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (res, vars) => {
      if (!vars.body["bankItemId"]) {
        setSelectedQuestionId(res.data.id);
        openInspector();
      } else {
        toast({ title: "Question inserted" });
      }
      invalidateVersion();
    },
    onError: onStructuralError,
  });

  const deleteQuestionMut = useMutation({
    mutationFn: (qid: string) => apiFetch(`/audit/questions/${qid}`, { method: "DELETE" }),
    onSuccess: (_r, qid) => {
      setDeleteQuestionId(null);
      if (selectedQuestionId === qid) setSelectedQuestionId(null);
      invalidateVersion();
    },
    onError: onStructuralError,
  });

  const reorderQuestionsMut = useMutation({
    mutationFn: ({ sid, orderedIds }: { sid: string; orderedIds: string[] }) =>
      apiFetch(`/audit/sections/${sid}/questions/reorder`, {
        method: "POST",
        body: JSON.stringify({ orderedIds }),
      }),
    onSuccess: invalidateVersion,
    onError: onStructuralError,
  });

  // Pass line lives on the draft version (PATCH passThresholdPct).
  const passMut = useMutation({
    mutationFn: (pct: number) =>
      apiFetch(`/audit/templates/versions/${params.vid}`, {
        method: "PATCH",
        body: JSON.stringify({ passThresholdPct: pct }),
      }),
    onError: onStructuralError,
  });

  const moveSection = (sid: string, dir: -1 | 1) => {
    const ids = sections.map((s) => s.id);
    const i = ids.indexOf(sid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    patchCache((v) => ({
      ...v,
      sections: v.sections.map((s) => ({ ...s, orderIndex: ids.indexOf(s.id) })),
    }));
    reorderSectionsMut.mutate(ids);
  };

  const moveQuestion = (section: BuilderSection, qid: string, dir: -1 | 1) => {
    const ids = section.questions.map((q) => q.id);
    const i = ids.indexOf(qid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    patchCache((v) => ({
      ...v,
      sections: v.sections.map((s) =>
        s.id !== section.id
          ? s
          : { ...s, questions: s.questions.map((q) => ({ ...q, orderIndex: ids.indexOf(q.id) })) },
      ),
    }));
    reorderQuestionsMut.mutate({ sid: section.id, orderedIds: ids });
  };

  const stepWeight = (q: BuilderQuestion, delta: number) =>
    onQuestionChange(q.id, { weight: Math.max(0, q.weight + delta) });

  const openQuestion = (s: BuilderSection, q: BuilderQuestion) => {
    setSelectedSectionId(s.id);
    setSelectedQuestionId(q.id);
    openInspector();
  };

  const addBlank = (s: BuilderSection) => {
    setSelectedSectionId(s.id);
    addQuestionMut.mutate({ sid: s.id, body: { prompt: "New question", type: "RATING", weight: 5 } });
  };

  const openBank = (s: BuilderSection) => {
    setSelectedSectionId(s.id);
    setBankOpen(true);
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (versionQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-full" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Skeleton className="h-96" /><Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (!version) {
    return (
      <PageHeader
        title="Version not found"
        breadcrumbs={[{ label: "Audits" }, { label: "Templates", href: "/audits/templates" }]}
      />
    );
  }

  const totalPoints = sections.reduce((sum, s) => sum + sectionPoints(s.questions), 0);
  const share = (s: BuilderSection) =>
    totalPoints > 0 ? Math.round((sectionPoints(s.questions) / totalPoints) * 100) : 0;
  const passThreshold =
    version.passThresholdPct != null ? Math.round(Number(version.passThresholdPct)) : 75;

  const stepPass = (delta: number) => {
    if (readOnly) return;
    const next = Math.min(100, Math.max(0, passThreshold + delta));
    if (next === passThreshold) return;
    patchCache((v) => ({ ...v, passThresholdPct: String(next) }));
    passMut.mutate(next);
  };

  return (
    <div className="animate-fade-up space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="icon" className="h-9 w-9 shrink-0">
          <Link href={`/audits/templates/${params.id}`} aria-label="Back to template">
            <ChevronLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-[220px] flex-1">
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold tracking-[-0.012em]">
            {template?.name ?? "Template"}
            <span className="font-mono text-[14px] font-semibold text-muted-foreground">
              v{version.versionNo}{version.lifecycle === "DRAFT" ? " draft" : ""}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Order questions, set mandatory flags and weightage — wording &amp; response types live in the Question Bank.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {saveState === "saving" && (<><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>)}
          {saveState === "saved" && (<><Check className="h-3 w-3 text-success" /> Saved</>)}
          {saveState === "error" && <span className="text-destructive">Save failed</span>}
        </span>
        <LifecycleBadge lifecycle={version.lifecycle} />
        <Button asChild variant="outline" size="sm">
          <Link href={`/audits/templates/${params.id}/versions/${params.vid}/preview`}>
            <Eye className="mr-1 h-4 w-4" /> Preview
          </Link>
        </Button>
        {version.lifecycle === "DRAFT" && !forcedReadOnly && (
          <Button size="sm" onClick={() => setPublishOpen(true)}>Publish v{version.versionNo}</Button>
        )}
      </div>

      {readOnly ? (
        <div className="flex items-center gap-2 rounded-[11px] border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          <Lock className="h-4 w-4 shrink-0" />
          v{version.versionNo} — {titleCase(version.lifecycle)}, immutable. Create a
          new draft from the template's Versions tab to make changes.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {[
            "Create categories to group the checklist",
            "Add questions from the Question Bank",
            "Set order, mandatory flags & weights",
          ].map((t, i) => (
            <span key={t} className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-foreground">
              <strong className="text-accent-strong">{i + 1}</strong> {t}
            </span>
          ))}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left — category cards */}
        <div className="min-w-0 space-y-3">
          {sections.map((s, si) => (
            <Card key={s.id}>
              <CardContent className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  {!readOnly && (
                    <span className="flex flex-col">
                      <button className={cn(STEP, "h-4 w-5 border-none bg-transparent text-muted-foreground hover:text-accent")} disabled={si === 0 || reorderSectionsMut.isPending} onClick={() => moveSection(s.id, -1)}><ArrowUp className="h-3 w-3" /></button>
                      <button className={cn(STEP, "h-4 w-5 border-none bg-transparent text-muted-foreground hover:text-accent")} disabled={si === sections.length - 1 || reorderSectionsMut.isPending} onClick={() => moveSection(s.id, 1)}><ArrowDown className="h-3 w-3" /></button>
                    </span>
                  )}
                  <input
                    value={s.title}
                    disabled={readOnly}
                    onChange={(e) => onSectionChange(s.id, { title: e.target.value })}
                    placeholder="Category name…"
                    className="min-w-0 flex-1 rounded-[7px] bg-transparent px-1.5 py-1 text-[13px] font-bold uppercase tracking-[0.05em] text-accent-strong outline-none focus:bg-background focus:ring-1 focus:ring-border disabled:opacity-100"
                  />
                  <span className="shrink-0 rounded-full bg-muted px-2 py-[2px] font-mono text-[11px] font-bold tabular-nums text-foreground">{share(s)}%</span>
                </div>

                {s.questions.map((q, qi) => {
                  const scored = !NON_SCORED_TYPES.has(q.type);
                  return (
                    <div key={q.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-dashed border-border py-2 last:border-0">
                      {!readOnly && (
                        <span className="flex flex-col">
                          <button className={cn(STEP, "h-4 w-4 border-none bg-transparent text-muted-foreground/70 hover:text-accent")} disabled={qi === 0 || reorderQuestionsMut.isPending} onClick={() => moveQuestion(s, q.id, -1)}><ArrowUp className="h-3 w-3" /></button>
                          <button className={cn(STEP, "h-4 w-4 border-none bg-transparent text-muted-foreground/70 hover:text-accent")} disabled={qi === s.questions.length - 1 || reorderQuestionsMut.isPending} onClick={() => moveQuestion(s, q.id, 1)}><ArrowDown className="h-3 w-3" /></button>
                        </span>
                      )}
                      <span className="w-4 shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{qi + 1}</span>
                      <button
                        onClick={() => openQuestion(s, q)}
                        className="min-w-[130px] flex-1 truncate py-0.5 text-left text-[13px] font-semibold text-foreground hover:text-accent-strong"
                        title="Edit wording, response type & options"
                      >
                        {q.prompt || <span className="text-muted-foreground">Untitled question</span>}
                      </button>
                      <button
                        onClick={() => openQuestion(s, q)}
                        className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-[10.5px] font-bold text-muted-foreground hover:border-accent"
                        title="Response type — edit in details"
                      >
                        {QTYPE_LABEL[q.type]}
                      </button>
                      <button
                        onClick={() => onQuestionChange(q.id, { mandatory: !q.mandatory })}
                        disabled={readOnly}
                        title="Mandatory — must be answered before submit"
                        className={cn(
                          "shrink-0 rounded-[8px] border px-2 py-1 text-[10.5px] font-bold transition-colors disabled:opacity-60",
                          q.mandatory ? "border-accent bg-accent/10 text-accent-strong" : "border-border bg-card text-muted-foreground",
                        )}
                      >
                        {q.mandatory ? "★ Required" : "Optional"}
                      </button>
                      {scored ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="text-[9px] font-bold uppercase tracking-[0.05em] text-muted-foreground/70">wt</span>
                          <button className={cn(STEP, "h-[22px] w-[22px]")} disabled={readOnly} onClick={() => stepWeight(q, -1)}>−</button>
                          <span className="w-6 text-center font-mono text-[12px] font-bold tabular-nums">{q.weight}</span>
                          <button className={cn(STEP, "h-[22px] w-[22px]")} disabled={readOnly} onClick={() => stepWeight(q, 1)}>+</button>
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Not scored</span>
                      )}
                      {!readOnly && (
                        <button className="shrink-0 text-muted-foreground/60 hover:text-destructive" onClick={() => setDeleteQuestionId(q.id)} title="Remove question">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {s.questions.length === 0 && (
                  <p className="py-4 text-center text-[12.5px] text-muted-foreground">No questions yet — add one below.</p>
                )}

                {!readOnly && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" disabled={addQuestionMut.isPending} onClick={() => openBank(s)}>
                      <Library className="mr-1 h-4 w-4" /> Add from bank
                    </Button>
                    <Button variant="ghost" size="sm" disabled={addQuestionMut.isPending} onClick={() => addBlank(s)}>
                      <Plus className="mr-1 h-4 w-4" /> Blank question
                    </Button>
                    <span className="flex-1" />
                    <button className="text-[11.5px] font-semibold text-muted-foreground hover:text-destructive" onClick={() => setDeleteSectionId(s.id)}>
                      Delete category
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {!readOnly && (
            <button
              onClick={() => addSectionMut.mutate("New category")}
              disabled={addSectionMut.isPending}
              className="w-full rounded-[14px] border-[1.5px] border-dashed border-border bg-transparent py-3.5 text-[13.5px] font-bold text-muted-foreground transition-colors hover:border-accent hover:text-accent-strong disabled:opacity-60"
            >
              ＋ Add category
            </button>
          )}

          {sections.length === 0 && readOnly && (
            <p className="rounded-[14px] border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
              This version has no sections.
            </p>
          )}
        </div>

        {/* Right — score model + pass line */}
        <div className="space-y-3.5 lg:sticky lg:top-4">
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Score model</div>
              {totalPoints === 0 ? (
                <p className="py-3 text-center text-[12.5px] text-muted-foreground">Add scored questions to see the weighting.</p>
              ) : (
                <>
                  <div className="mb-2.5 flex h-3 gap-0.5 overflow-hidden rounded-full">
                    {sections.filter((s) => sectionPoints(s.questions) > 0).map((s, i) => (
                      <span key={s.id} className={cn("h-full", CAT_COLORS[i % CAT_COLORS.length])} style={{ width: `${share(s)}%` }} />
                    ))}
                  </div>
                  {sections.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2 py-[3px] text-[11.5px]">
                      <span className={cn("h-2.5 w-2.5 rounded-[3px]", CAT_COLORS[i % CAT_COLORS.length])} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{s.title || "Untitled"}</span>
                      <span className="font-mono font-bold tabular-nums text-foreground">{share(s)}%</span>
                    </div>
                  ))}
                  <div className="mt-2 flex border-t border-dashed border-border pt-2 text-[12px] font-bold">
                    <span className="flex-1">Total possible</span>
                    <span className="font-mono tabular-nums">{totalPoints} pts</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Pass line</div>
              <div className="flex items-center gap-2.5">
                <div className="flex items-baseline gap-1">
                  <span className="font-display text-[26px] font-extrabold text-success">{passThreshold}</span>
                  <span className="text-[11.5px] text-muted-foreground">/100 to pass</span>
                </div>
                <span className="flex-1" />
                {!readOnly && (
                  <>
                    <button className={STEP} disabled={passMut.isPending} onClick={() => stepPass(-1)}>−</button>
                    <button className={STEP} disabled={passMut.isPending} onClick={() => stepPass(1)}>+</button>
                  </>
                )}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Bands: 90+ Excellent · {passThreshold}–89 Good · below {passThreshold} Fail
              </p>
            </CardContent>
          </Card>

          <div className="rounded-[11px] bg-warning/10 px-3 py-2.5 text-[11.5px] font-semibold text-warning">
            Every scored question needs a weight above 0 to publish. Published versions are immutable — historical audits keep the version they were scored with.
          </div>
        </div>
      </div>

      {/* Question details sheet (all viewports) */}
      <Sheet open={sheetOpen && selectedQuestion != null} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="font-display">Question details</SheetTitle>
          </SheetHeader>
          <Inspector
            section={activeSection}
            question={selectedQuestion}
            scales={scalesQuery.data?.data}
            readOnly={readOnly}
            onQuestionChange={onQuestionChange}
            onSectionChange={onSectionChange}
          />
        </SheetContent>
      </Sheet>

      <BankDialog
        open={bankOpen}
        onOpenChange={setBankOpen}
        inserting={addQuestionMut.isPending}
        onInsert={(item) => {
          if (!activeSection) return;
          addQuestionMut.mutate({ sid: activeSection.id, body: { bankItemId: item.id } });
        }}
      />

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionId={params.vid ?? null}
        versionNo={version.versionNo}
        onPublished={invalidateVersion}
      />

      <ConfirmDialog
        open={deleteQuestionId != null}
        onOpenChange={(o) => { if (!o) setDeleteQuestionId(null); }}
        title="Delete question?"
        description="This removes the question from the draft. This cannot be undone."
        onConfirm={() => deleteQuestionMut.mutate(deleteQuestionId!)}
        isConfirming={deleteQuestionMut.isPending}
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={deleteSectionId != null}
        onOpenChange={(o) => { if (!o) setDeleteSectionId(null); }}
        title="Delete category?"
        description="The category and all its questions are removed from the draft. This cannot be undone."
        onConfirm={() => deleteSectionMut.mutate(deleteSectionId!)}
        isConfirming={deleteSectionMut.isPending}
        confirmLabel="Delete"
      />
    </div>
  );
}
