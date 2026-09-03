/**
 * Ingredients — the list the shared-ingredient block actually runs on.
 *
 * The table this replaces showed name / unit / status and nothing about
 * consequence. Here every row carries how many dishes depend on it, so an
 * "unused" ingredient is visibly safe to delete and a heavily-used one visibly
 * isn't.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { FormModal } from "@/components/ui/form-modal";
import { type BulkColumn } from "@/components/bulk-upload-dialog";
import { ImportExportMenu } from "@/components/import-export-menu";
import { useToast } from "@/hooks/use-toast";
import { foodApi, type Ingredient } from "@/lib/food-api";
import { findDuplicateIngredient } from "./menu-lib";
import { FoodQueryError } from "./query-error";
import { useDishCatalogue, useIngredients } from "./use-food-masters";

const ING_UNITS = ["G", "KG", "ML", "LITRE", "PCS", "PLATE", "SERVING"];

/** Template columns for the bulk import — keys are the row keys POST /bulk/ingredients reads. */
const INGREDIENT_BULK_COLUMNS: BulkColumn[] = [
  { key: "name", label: "name", required: true, hint: "ingredient name, e.g. Aloo. Must not already exist" },
  { key: "unit", label: "unit", required: true, hint: `default unit — one of ${ING_UNITS.join(", ")}` },
  { key: "isActive", label: "isActive", hint: "true / false. Blank = true" },
];

type IngDraft = {
  id: string | null; name: string; unit: string; isActive: boolean;
  /** Dishes per day allowed, "" for no limit. Kept as a string so the field can
   *  be emptied mid-edit without snapping to a number. */
  maxPerDay: string;
};

/** `canEdit` mirrors the server's FOOD_SETTINGS:edit gate (M16) — see
 *  DishesCatalogue for why a view-only principal reaches this tab at all. */
export function IngredientsGrid({ canEdit = true }: { canEdit?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: ingredients = [], isLoading, isError, refetch } = useIngredients();
  // A failed catalogue read empties `usage`, so every ingredient would be
  // labelled "unused" — the flag people delete on — and the delete dialog would
  // drop its "used by N dishes" warning.
  const { data: dishes = [], isError: dishesError } = useDishCatalogue();
  const usageKnown = !dishesError;

  const [search, setSearch] = React.useState("");
  const [draft, setDraft] = React.useState<IngDraft | null>(null);
  const [delTarget, setDelTarget] = React.useState<Ingredient | null>(null);

  // Exported under the import template's own columns, so a download can be
  // edited and uploaded straight back. Deliberately the whole list, not the
  // current search — a filtered export re-uploads as a partial file.
  const exportRows = React.useMemo(
    () => ingredients.map((r) => ({ name: r.name, unit: r.unit, isActive: String(r.isActive) })),
    [ingredients],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["food", "ingredients"] });
    qc.invalidateQueries({ queryKey: ["food", "dishes"] });
  };

  const usage = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const d of dishes) {
      for (const i of d.ingredients ?? []) m.set(i.ingredientId, (m.get(i.ingredientId) ?? 0) + 1);
    }
    return m;
  }, [dishes]);

  const save = useMutation({
    mutationFn: (d: IngDraft) => {
      const capped = d.maxPerDay.trim();
      const body = {
        name: d.name.trim(), unit: d.unit, isActive: d.isActive,
        // Explicit null is how the limit is CLEARED — undefined would leave the
        // stored one in place, so an emptied field has to send null.
        maxPerDay: capped === "" ? null : Number(capped),
      };
      return d.id ? foodApi.updateIngredient(d.id, body) : foodApi.createIngredient(body);
    },
    onSuccess: (_r, d) => {
      toast({ title: d.id ? "Ingredient updated" : "Ingredient added" });
      invalidate();
      setDraft(null);
    },
    // A duplicate name comes back as a 409 whose `details` says what to do about
    // it instead — surface that rather than just the headline.
    onError: (e: any) => toast({
      title: e?.message || "Could not save the ingredient",
      description: typeof e?.details === "string" ? e.details : undefined,
      variant: "destructive",
    }),
  });

  const del = useMutation({
    mutationFn: (id: string) => foodApi.deleteIngredient(id),
    onSuccess: () => { toast({ title: "Ingredient deleted" }); invalidate(); setDelTarget(null); },
    onError: (e: any) => toast({ title: e?.message || "Could not delete the ingredient", variant: "destructive" }),
  });

  const q = search.trim().toLowerCase();
  const rows = ingredients.filter((r) => !q || r.name.toLowerCase().includes(q));
  const delUses = usage.get(delTarget?.id ?? "") ?? 0;

  // Mirrors the server's 409 on POST/PUT /food/ingredients — see catalogueKey in
  // menu-lib for what counts as the same ingredient. Caught here as well so the
  // collision is named while the user is still typing rather than thrown back at
  // them after a failed save.
  const dupIngredient = draft
    ? findDuplicateIngredient(ingredients, draft.name, draft.id)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-primary">Ingredients</h2>
          <p className="text-sm text-muted-foreground">
            Any two dishes sharing a raw material are blocked from sharing a plate. This list is what that check runs on.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ingredients" aria-label="Search ingredients" className="pl-9"
            />
          </div>
          {/* Export is a read and stays; the import half POSTs /bulk/ingredients. */}
          <ImportExportMenu
            resource="ingredients"
            columns={INGREDIENT_BULK_COLUMNS}
            exportRows={exportRows}
            canImport={canEdit}
            onImported={invalidate}
          />
          {canEdit && (
            <Button
              className="bg-accent text-white hover:bg-accent/90"
              onClick={() => setDraft({ id: null, name: "", unit: "KG", isActive: true, maxPerDay: "" })}
            >
              <Plus className="mr-2 h-4 w-4" /> Add ingredient
            </Button>
          )}
        </div>
      </div>

      {isError ? (
        <FoodQueryError label="the ingredients" onRetry={() => refetch()} />
      ) : isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading ingredients…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
          {q ? "No ingredient matches that search." : "No ingredients yet."}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const uses = usage.get(r.id) ?? 0;
            return (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border bg-card py-1.5 pl-3 pr-2">
                <span className={`flex-1 truncate text-sm font-medium ${r.isActive ? "" : "text-muted-foreground"}`}>
                  {r.name}
                </span>
                <span className="font-mono text-[10px] uppercase text-muted-foreground">{r.unit}</span>
                {r.maxPerDay != null && (
                  <span
                    className="whitespace-nowrap rounded-full bg-accent/10 px-1.5 py-px text-[10px] font-medium text-accent-strong"
                    title={`At most ${r.maxPerDay} dish${r.maxPerDay === 1 ? "" : "es"} with this ingredient per day`}
                  >
                    max {r.maxPerDay}/day
                  </span>
                )}
                {!r.isActive && (
                  <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">Inactive</span>
                )}
                <span className={`whitespace-nowrap text-[11px] ${uses || !usageKnown ? "text-muted-foreground" : "text-warning"}`}>
                  {!usageKnown ? "usage unknown" : uses ? `in ${uses} dish${uses === 1 ? "" : "es"}` : "unused"}
                </span>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7" title="Edit ingredient"
                      onClick={() => setDraft({
                        id: r.id, name: r.name, unit: r.unit, isActive: r.isActive,
                        maxPerDay: r.maxPerDay != null ? String(r.maxPerDay) : "",
                      })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete ingredient" onClick={() => setDelTarget(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── editor ───────────────────────────────────────────────────────── */}
      <Sheet open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
          <div className="shrink-0 border-b bg-card px-6 py-4">
            <SheetTitle className="font-display text-xl font-semibold text-primary">
              {draft?.id ? "Edit ingredient" : "Add ingredient"}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {draft?.id
                ? `Renaming updates every dish that uses it${(usage.get(draft.id) ?? 0) ? ` — ${usage.get(draft.id)} today.` : "."}`
                : "Raw materials only — this is what the shared-ingredient check compares."}
            </SheetDescription>
          </div>

          {draft && (
            <div className="flex-1 overflow-y-auto bg-background px-6 py-5">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</p>
              <Input
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Aloo" aria-label="Ingredient name"
                aria-invalid={!!dupIngredient}
                className={`h-11 text-base ${dupIngredient ? "mb-1.5 border-destructive focus-visible:ring-destructive/30" : "mb-5"}`}
              />
              {dupIngredient && (
                <p className="mb-5 flex items-start gap-1.5 text-[11px] text-destructive">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    “{dupIngredient.name}” is already in the list
                    {dupIngredient.isActive
                      ? " — edit that one instead of adding a second copy."
                      : " but is retired. Reopen it and switch Active back on rather than adding a second copy."}
                  </span>
                </p>
              )}

              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Default unit</p>
              <div className="mb-5 flex flex-wrap gap-1.5">
                {ING_UNITS.map((u) => (
                  <button
                    key={u} type="button" onClick={() => setDraft({ ...draft, unit: u })} aria-pressed={draft.unit === u}
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
                      draft.unit === u ? "border-accent bg-accent/10 font-medium text-accent-strong" : "border-border bg-card hover:bg-muted"
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>

              {/* Rule 2's number. It lives on the INGREDIENT, not in the rule:
                  "at most one aloo dish a day" is a real kitchen rule, "at most
                  one dish with cooking oil" is not, and oil is in a third of the
                  catalogue. One global figure would make almost every day
                  unsatisfiable. Blank = no limit, which is every ingredient
                  until someone says otherwise. */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Max dishes per day
                </p>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={draft.maxPerDay}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || /^\d{1,2}$/.test(v)) setDraft({ ...draft, maxPerDay: v });
                  }}
                  placeholder="No limit"
                  aria-label="Maximum dishes per day carrying this ingredient"
                  className="w-32"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Blank means no limit. Set it to 1 and a day serving two dishes with this
                  ingredient is flagged on the menu board — counting every meal, not each plate.
                  Flagged, never blocked. Shows while “Limit how often an ingredient is used in a
                  day” is on under Menu Rules.
                </p>
              </div>

              <div className="flex items-start justify-between gap-3 rounded-lg border bg-card px-3.5 py-3">
                <div>
                  <p className="text-sm font-medium">Active</p>
                  <p className="text-[11px] text-muted-foreground">
                    Inactive ingredients stay on existing dishes but can’t be added to new ones.
                  </p>
                </div>
                <Switch
                  checked={draft.isActive} onCheckedChange={(v) => setDraft({ ...draft, isActive: v })}
                  aria-label="Active"
                />
              </div>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-2 border-t bg-card px-6 py-3.5">
            <Button
              className="flex-1 bg-accent text-white hover:bg-accent/90"
              disabled={!draft?.name.trim() || !!dupIngredient || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {save.isPending ? "Saving…" : "Save ingredient"}
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </SheetContent>
      </Sheet>

      <FormModal
        open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)}
        title="Confirm Delete" saveLabel="Delete" isSaving={del.isPending}
        onSave={() => delTarget && del.mutate(delTarget.id)}
      >
        <p className="text-sm text-muted-foreground">
          Delete <span className="font-medium text-foreground">{delTarget?.name}</span>?
          {!usageKnown
            ? <> The dish catalogue could not be read, so it is not known which dishes still use it.</>
            : delUses > 0 ? <> It is used by {delUses} dish{delUses === 1 ? "" : "es"}, which will lose it.</> : null}
        </p>
      </FormModal>
    </div>
  );
}
