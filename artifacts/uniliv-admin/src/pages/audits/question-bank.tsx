import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Archive, ArchiveRestore, Camera } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  EVIDENCE_RULES, NON_SCORED_TYPES, QUESTION_TYPES, apiFetchAll,
  type ApiOne, type BankItem, type EvidenceRule, type QuestionType,
} from "./lib";
import { DuplicateWarning, useDuplicatePrompts } from "./shared";
import { cn } from "@/lib/utils";

/* Question bank (redesign — prototype "Question bank"). Write once, reuse
 * across every template; inserting into a template copies the item so drafts
 * stay independent (copy-on-insert). Bank items hold the prompt, response type,
 * tags, default weight and evidence rule — rating scales and choice options are
 * configured later on the template question, not here. */

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

const EVIDENCE_LABEL: Record<EvidenceRule, string> = {
  NONE: "Not required",
  OPTIONAL: "Optional",
  REQUIRED_ON_FAIL: "Required on issue",
  ALWAYS_REQUIRED: "Always required",
};

interface BankForm {
  prompt: string;
  helpText: string;
  type: QuestionType;
  defaultWeight: number;
  defaultEvidenceRule: EvidenceRule;
  tags: string[];
  numericUnit: string;
}

const EMPTY_FORM: BankForm = {
  prompt: "",
  helpText: "",
  type: "RATING",
  defaultWeight: 5,
  defaultEvidenceRule: "NONE",
  tags: [],
  numericUnit: "",
};

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-[6px] text-[12px] font-semibold transition-colors",
        active
          ? "border-accent bg-accent text-accent-foreground"
          : "border-border bg-card text-foreground hover:border-accent",
      )}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{children}</div>;
}

export default function QuestionBank() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tagFilter, setTagFilter] = React.useState("ALL");
  const [search, setSearch] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [tagsExpanded, setTagsExpanded] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BankItem | null>(null);
  const [form, setForm] = React.useState<BankForm>(EMPTY_FORM);
  const [newTag, setNewTag] = React.useState("");

  const bankQuery = useQuery({
    queryKey: ["/audit/bank", "register"],
    queryFn: () => apiFetchAll<BankItem>("/audit/bank?includeArchived=1"),
  });
  const tagsQuery = useQuery({
    queryKey: ["/audit/bank/tags"],
    queryFn: () => apiFetch<ApiOne<string[]>>("/audit/bank/tags"),
  });
  const knownTags = tagsQuery.data?.data ?? [];

  const rows = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return (bankQuery.data ?? []).filter(
      (i) =>
        (showArchived || !i.archivedAt) &&
        (tagFilter === "ALL" || i.tags.includes(tagFilter)) &&
        (!q || i.prompt.toLowerCase().includes(q)),
    );
  }, [bankQuery.data, tagFilter, search, showArchived]);

  const totalCount = React.useMemo(
    () => (bankQuery.data ?? []).filter((i) => !i.archivedAt).length,
    [bankQuery.data],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/audit/bank"] });
    qc.invalidateQueries({ queryKey: ["/audit/bank/tags"] });
  };

  const duplicateMatches = useDuplicatePrompts(editorOpen ? form.prompt : "", editing?.id);

  const saveMut = useMutation({
    mutationFn: () => {
      const scored = !NON_SCORED_TYPES.has(form.type);
      const body = {
        prompt: form.prompt.trim(),
        helpText: form.helpText.trim() || null,
        type: form.type,
        defaultWeight: scored ? Math.max(0, Math.trunc(form.defaultWeight || 0)) : 0,
        defaultEvidenceRule: form.defaultEvidenceRule,
        tags: form.tags.map((t) => t.trim()).filter(Boolean),
        numericUnit: form.type === "NUMERIC" ? form.numericUnit.trim() || null : null,
      };
      return editing
        ? apiFetch(`/audit/bank/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : apiFetch("/audit/bank", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: editing ? "Question updated" : "Question added to the bank" });
      setEditorOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Save failed", variant: "destructive" }),
  });

  const archiveMut = useMutation({
    mutationFn: ({ id, restore }: { id: string; restore: boolean }) =>
      apiFetch(`/audit/bank/${id}/archive`, {
        method: "POST",
        body: JSON.stringify(restore ? { restore: true } : {}),
      }),
    onSuccess: (_r, vars) => {
      toast({ title: vars.restore ? "Question restored" : "Question archived" });
      setEditorOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Action failed", variant: "destructive" }),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setNewTag("");
    setEditorOpen(true);
  };

  const openEdit = (item: BankItem) => {
    setEditing(item);
    setForm({
      prompt: item.prompt,
      helpText: item.helpText ?? "",
      type: item.type,
      defaultWeight: item.defaultWeight,
      defaultEvidenceRule: item.defaultEvidenceRule,
      tags: [...item.tags],
      numericUnit: item.numericUnit ?? "",
    });
    setNewTag("");
    setEditorOpen(true);
  };

  const toggleTag = (tag: string) =>
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }));

  const addNewTag = () => {
    const t = newTag.trim();
    if (!t) return;
    setForm((f) => (f.tags.includes(t) ? f : { ...f, tags: [...f.tags, t] }));
    setNewTag("");
  };

  const scored = !NON_SCORED_TYPES.has(form.type);
  // editor tag pills = known tags ∪ any freeform tags already on the form
  const editorTags = React.useMemo(
    () => Array.from(new Set([...knownTags, ...form.tags])),
    [knownTags, form.tags],
  );

  return (
    <div className="animate-fade-up space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="mb-0.5 font-display text-2xl font-bold tracking-[-0.012em]">Question bank</h1>
          <p className="text-sm text-muted-foreground">
            Write once, reuse across every template — <span className="tabular-nums">{totalCount}</span> questions.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" /> New question
        </Button>
      </div>

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search questions…" className="pl-9" />
          </div>
          <span className="flex-1" />
          {tagFilter !== "ALL" && (
            <button onClick={() => setTagFilter("ALL")} className="text-[12px] font-semibold text-accent-strong hover:underline">
              Clear tag: {tagFilter}
            </button>
          )}
          <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} />
            Archived
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill active={tagFilter === "ALL"} onClick={() => setTagFilter("ALL")}>All</Pill>
          {(tagsExpanded ? knownTags : knownTags.slice(0, 16)).map((t) => (
            <Pill key={t} active={tagFilter === t} onClick={() => setTagFilter(t)}>{t}</Pill>
          ))}
          {knownTags.length > 16 && (
            <button
              onClick={() => setTagsExpanded((v) => !v)}
              className="rounded-full border border-dashed border-border px-3 py-[6px] text-[12px] font-semibold text-muted-foreground hover:border-accent hover:text-accent-strong"
            >
              {tagsExpanded ? "Show fewer" : `+${knownTags.length - 16} more`}
            </button>
          )}
        </div>
      </div>

      {editorOpen && (
        <Card className="animate-fade-up border-accent">
          <CardContent className="space-y-4 p-[18px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">
                {editing ? "Edit question" : "New question"}
              </span>
              {editing && editing.usageCount > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">used in {editing.usageCount}</span>
              )}
            </div>

            <div>
              <FieldLabel>Question</FieldLabel>
              <Input
                value={form.prompt}
                onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                placeholder="e.g. Bed linen fresh and changed?"
                className="text-[14px] font-semibold"
              />
              <DuplicateWarning matches={duplicateMatches} />
            </div>

            <div>
              <FieldLabel>Help text (optional)</FieldLabel>
              <Input
                value={form.helpText}
                onChange={(e) => setForm((f) => ({ ...f, helpText: e.target.value }))}
                placeholder="A hint shown to the auditor under the question"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel>Response type</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {QUESTION_TYPES.map((t) => (
                    <Pill key={t} active={form.type === t} onClick={() => setForm((f) => ({ ...f, type: t }))}>
                      {QTYPE_LABEL[t]}
                    </Pill>
                  ))}
                </div>
              </div>
              <div>
                <FieldLabel>Tags</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {editorTags.map((t) => (
                    <Pill key={t} active={form.tags.includes(t)} onClick={() => toggleTag(t)}>{t}</Pill>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNewTag(); } }}
                    placeholder="Add a tag…"
                    className="h-9"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addNewTag} disabled={!newTag.trim()}>Add</Button>
                </div>
              </div>
            </div>

            {form.type === "NUMERIC" && (
              <div className="flex items-center gap-3 rounded-[10px] border border-border bg-background px-3 py-2.5">
                <span className="text-[12px] font-bold text-foreground">Unit</span>
                <Input
                  value={form.numericUnit}
                  onChange={(e) => setForm((f) => ({ ...f, numericUnit: e.target.value }))}
                  placeholder="e.g. ppm, °C, count"
                  className="h-9 flex-1"
                />
              </div>
            )}

            {scored && (
              <div className="flex items-center gap-3 rounded-[10px] border border-border bg-background px-3 py-2.5">
                <span className="flex-1 text-[12px] font-bold text-foreground">Default weight</span>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, defaultWeight: Math.max(0, f.defaultWeight - 1) }))}
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-card text-foreground hover:border-accent"
                >−</button>
                <span className="w-9 text-center font-mono text-[15px] font-bold tabular-nums">{form.defaultWeight}</span>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, defaultWeight: f.defaultWeight + 1 }))}
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-card text-foreground hover:border-accent"
                >+</button>
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                <Camera className="h-3 w-3" /> Photo evidence
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EVIDENCE_RULES.map((r) => (
                  <Pill key={r} active={form.defaultEvidenceRule === r} onClick={() => setForm((f) => ({ ...f, defaultEvidenceRule: r }))}>
                    {EVIDENCE_LABEL[r]}
                  </Pill>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={archiveMut.isPending}
                  onClick={() => archiveMut.mutate({ id: editing.id, restore: Boolean(editing.archivedAt) })}
                >
                  {editing.archivedAt ? (
                    <><ArchiveRestore className="mr-1 h-4 w-4" /> Restore</>
                  ) : (
                    <><Archive className="mr-1 h-4 w-4" /> Archive</>
                  )}
                </Button>
              )}
              <span className="flex-1" />
              <Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button
                type="button"
                disabled={!form.prompt.trim() || saveMut.isPending}
                onClick={() => saveMut.mutate()}
              >
                {saveMut.isPending ? "Saving…" : "Save question"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {bankQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[52px] rounded-[10px]" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center">
            <p className="text-sm text-muted-foreground">
              {search || tagFilter !== "ALL" ? "No questions match your filters." : "The bank is empty — add your first question."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="px-4 py-1.5">
            {rows.map((b) => (
              <div
                key={b.id}
                className={cn(
                  "flex items-center gap-3 border-b border-dashed border-border py-[11px] last:border-0",
                  b.archivedAt && "opacity-60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold">{b.prompt}</span>
                    {b.archivedAt && <span className="shrink-0 rounded-full bg-muted px-2 py-[1px] text-[10px] font-bold text-muted-foreground">Archived</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">{b.tags.length ? b.tags.join(" · ") : "Untagged"}</div>
                </div>
                <span className="hidden shrink-0 rounded-full border border-border bg-background px-2.5 py-[3px] text-[10.5px] font-bold text-foreground sm:inline">
                  {QTYPE_LABEL[b.type]}
                </span>
                <span className="hidden w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground md:inline">used in {b.usageCount}</span>
                <Button variant="outline" size="sm" onClick={() => openEdit(b)}>Edit</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
