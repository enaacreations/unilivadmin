/**
 * Plate composer — the drawer behind every cell of the Menu Rotation board.
 *
 * The meal's composition rule drives the whole form: one card per required
 * course, each showing what it still needs and offering only the dishes that
 * could legally fill it. A dish that would put two of the same raw material on
 * the plate is shown greyed with the reason rather than hidden, so "why can't I
 * pick Aloo Jeera today" answers itself.
 */
import * as React from "react";
import {
  AlertTriangle, CheckCircle2, CircleAlert, CornerDownRight, Search, Sparkles, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useStateDraft } from "@/hooks/use-state-draft";
import { DraftRestoredNotice } from "@/components/ui/draft-restored-notice";
import type { CompositionSlot, Dish, MealType } from "@/lib/food-api";
import { MEAL_LABEL, DAY_LABEL } from "@/lib/food-api";
import {
  allPlateDishIds, candidatesForSlot, componentLabel, fillPlate, ingredientNamesOf, plateVerdict,
  type PlateEntry,
} from "./menu-lib";

/** Veg / non-veg marker, the square-with-a-dot convention used on Indian menus. */
export function PrepDot({ dish, className = "" }: { dish: Dish | undefined; className?: string }) {
  const nonVeg = (dish?.preparations ?? []).includes("NON_VEG");
  return (
    <span
      aria-hidden
      className={`inline-block h-[9px] w-[9px] shrink-0 rounded-[2px] border-[1.5px] ${nonVeg ? "border-destructive" : "border-success"} ${className}`}
      style={{
        background: `radial-gradient(circle, ${nonVeg ? "var(--danger)" : "var(--success)"} 0 2px, transparent 2px)`,
      }}
    />
  );
}

/** Dishes shown per slot before "Show all N" reveals the rest. */
const PICKER_PREVIEW = 6;

export function PlateComposer({
  open, onOpenChange, day, meal, week, brand, brandName, slots, ruleMissing,
  dishes, dishById, initialPlate, nearby, serviceTime, onSave, isSaving, onGoToRules, draftKey,
  clashBlocks = true, canEdit = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  day: number;
  meal: MealType;
  week: number;
  brand: string;
  brandName: string;
  slots: CompositionSlot[];
  ruleMissing: boolean;
  dishes: Dish[];
  dishById: Map<string, Dish>;
  initialPlate: PlateEntry[];
  nearby: Map<string, string>;
  serviceTime?: string | null;
  onSave: (plate: PlateEntry[]) => void;
  isSaving: boolean;
  /** Jumps to the Menu Rules tab so a missing rule can be fixed without hunting. */
  onGoToRules?: () => void;
  /**
   * The shared-ingredient rule from Menu Rules. When off, clashes are not
   * surfaced anywhere in this drawer and the save is not blocked — matching the
   * server, which also stops rejecting them. Off means silent, not "shown but
   * harmless": a warning that survives its own off-switch reads as a bug.
   */
  clashBlocks?: boolean;
  /** Mirrors the server's FOOD_SETTINGS:edit gate (M16) — read-only principals
   *  can open and read a plate, but every control that changes it is inert. */
  canEdit?: boolean;
  /**
   * Autosave identity for this cell, supplied by the parent because a cell is
   * only unique WITHIN a kitchen and this drawer never sees the kitchen id.
   * Null switches autosave off.
   */
  draftKey?: string | null;
}) {
  const [draft, setDraft] = React.useState<PlateEntry[]>(initialPlate);
  const [search, setSearch] = React.useState<Record<string, string>>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  // Re-seed whenever a different cell is opened; the drawer instance is reused.
  React.useEffect(() => {
    if (!open) return;
    setDraft(initialPlate.map((e) => ({ dishId: e.dishId, sideDishIds: [...e.sideDishIds] })));
    setSearch({});
    setExpanded({});
    // initialPlate is a fresh array each render — key off the cell identity instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, day, meal, week, brand]);

  // Declared after the re-seed above so the baseline it snapshots is the plate
  // this cell actually opened with, not the previous cell's leftovers.
  const plateDraft = useStateDraft(draft, {
    key: draftKey ?? null,
    enabled: open,
    onRestore: setDraft,
  });

  const verdict = React.useMemo(() => plateVerdict(draft, slots, dishById), [draft, slots, dishById]);
  const onPlate = allPlateDishIds(draft);

  const removeDish = (dishId: string) => setDraft((d) => d.filter((e) => e.dishId !== dishId));
  const addDish = (dishId: string) => setDraft((d) => [...d, { dishId, sideDishIds: [] }]);
  const toggleSide = (parentId: string, sideId: string) =>
    setDraft((d) => d.map((e) => e.dishId !== parentId ? e : {
      ...e,
      sideDishIds: e.sideDishIds.includes(sideId)
        ? e.sideDishIds.filter((x) => x !== sideId)
        : [...e.sideDishIds, sideId],
    }));

  const blocked = clashBlocks && verdict.clashes.length > 0;

  /**
   * Dishes on THIS plate that also run within 3 days, with where.
   *
   * Derived from the live draft, not the saved cell, so it responds as you add
   * and remove. `nearby` already arrives empty when the repeat rule is switched
   * off, so this needs no separate gate — off stays silent here too.
   */
  const plateRepeats = React.useMemo(
    () => [...new Set(allPlateDishIds(draft))]
      .filter((id) => nearby.has(id))
      .map((id) => ({
        dishId: id,
        where: nearby.get(id)!,
        name: dishById.get(id)?.name ?? "A dish",
      })),
    [draft, nearby, dishById],
  );
  const short = verdict.total - verdict.met;
  const saveLabel = blocked ? "Resolve the clash to save"
    : verdict.ok ? "Save plate"
    : `Save anyway (${short} short)`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[660px]">
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="shrink-0 border-b bg-card px-6 py-4">
          <div className="flex items-start justify-between">
            <div>
              <SheetTitle className="font-display text-xl font-semibold text-primary">
                {DAY_LABEL[day]} · {MEAL_LABEL[meal]}
              </SheetTitle>
              <SheetDescription className="mt-0.5 text-xs">
                {brandName} · Week {week}{serviceTime ? ` · serves ${serviceTime}` : ""}
              </SheetDescription>
            </div>
            <div className="flex items-center gap-1 pr-7">
              {/* M16 — every control that edits the draft follows the save gate.
                  Only Save knew about canEdit, so a view-only principal could
                  rebuild the whole plate and then find no way to keep it. */}
              <Button
                variant="outline" size="icon" className="h-8 w-8" disabled={!canEdit}
                title="Clear plate" onClick={() => setDraft([])}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {/* Nothing to measure without a rule — a "0 of 0 slots met" bar would
              read as a full, healthy plate. */}
          {!ruleMissing && (
            <div className="mt-3 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full transition-all ${verdict.ok ? "bg-success" : "bg-warning"}`}
                  style={{ width: `${Math.round((verdict.met / Math.max(1, verdict.total)) * 100)}%` }}
                />
              </div>
              <span className={`whitespace-nowrap text-xs font-medium ${blocked ? "text-destructive" : verdict.ok ? "text-success" : "text-warning"}`}>
                {blocked ? "Blocked — ingredient clash" : `${verdict.met} of ${verdict.total} slots met`}
              </span>
            </div>
          )}
        </div>

        {/* ── slots ──────────────────────────────────────────────────────── */}
        <div className="flex-1 space-y-2.5 overflow-y-auto bg-background px-6 py-4">
          <DraftRestoredNotice
            show={plateDraft.restored}
            savedAt={plateDraft.restoredAt}
            onDiscard={plateDraft.discardDraft}
            onDismiss={plateDraft.dismissRestored}
          />
          {/* No rule → clear-only. Dishes can't be added (the server refuses
              too), but whatever is already here stays visible and removable so
              a plate built before the rule existed never gets stranded. */}
          {ruleMissing && (
            <>
              <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                No menu rule is set for {brandName} {MEAL_LABEL[meal]} yet, so this plate can’t be
                built or checked. Define the courses under{" "}
                {onGoToRules ? (
                  <button
                    type="button" onClick={onGoToRules}
                    className="font-medium text-accent-strong underline underline-offset-2"
                  >
                    Menu Rules
                  </button>
                ) : (
                  <span className="font-medium text-foreground">Menu Rules</span>
                )}{" "}
                first.
              </div>

              {draft.length > 0 && (
                <div className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between px-3.5 pb-1.5 pt-2.5">
                    <span className="text-sm font-semibold text-primary">On this plate</span>
                    <span className="text-[11px] text-muted-foreground">
                      {draft.length} dish{draft.length === 1 ? "" : "es"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 px-3.5 pb-3">
                    {draft.map((e) => (
                      <div key={e.dishId} className="flex items-center gap-3 rounded-lg bg-muted px-2.5 py-2">
                        <PrepDot dish={dishById.get(e.dishId)} />
                        <span className="flex-1 text-sm font-medium">
                          {dishById.get(e.dishId)?.name ?? e.dishId}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!ruleMissing && verdict.rows.map((row, ri) => {
            const slot = row.slot;
            const slotId = slot.id ?? `${slot.component ?? "any"}-${ri}`;
            const met = row.dishIds.length >= slot.minCount;
            const canAdd = row.dishIds.length < (slot.maxCount ?? 99);
            const title = slot.slotLabel || componentLabel(slot.component);
            const need = slot.maxCount && slot.maxCount !== slot.minCount
              ? `needs ${slot.minCount}–${slot.maxCount}` : `needs ${slot.minCount}`;

            const all = canAdd ? candidatesForSlot(slot, brand, onPlate, dishById, dishes, nearby, clashBlocks) : [];
            const q = (search[slotId] ?? "").trim().toLowerCase();
            const matched = q ? all.filter((c) => c.dish.name.toLowerCase().includes(q)) : all;
            // With no query we preview six and let "Show all N" reveal the rest,
            // so nothing in the catalogue is unreachable behind a scroll.
            const isOpen = !!q || expanded[slotId];
            const shown = isOpen ? matched : matched.slice(0, PICKER_PREVIEW);
            const hidden = matched.length - shown.length;

            return (
              <div
                key={slotId}
                className={`rounded-xl border bg-card ${met ? "" : "border-warning bg-warning-soft/40"}`}
              >
                <div className="flex items-center justify-between px-3.5 pb-1.5 pt-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-primary">{title}</span>
                    <span className="text-[11px] text-muted-foreground">{need}</span>
                  </div>
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${met ? "text-success" : "text-warning"}`}>
                    {met ? <CheckCircle2 className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
                    {met ? "met" : `pick ${slot.minCount - row.dishIds.length}`}
                  </span>
                </div>

                {/* chosen dishes + their accompaniments */}
                <div className="flex flex-col gap-1.5 px-3.5 pb-1.5">
                  {row.dishIds.map((id) => {
                    const dish = dishById.get(id);
                    const entry = draft.find((e) => e.dishId === id);
                    const sideOptions = (dish?.sideDishIds ?? [])
                      .map((sid) => dishById.get(sid))
                      .filter((x): x is Dish => !!x && x.isActive);
                    const ings = ingredientNamesOf(dish);
                    return (
                      <div key={id} className="rounded-lg bg-muted px-2.5 py-2">
                        <div className="flex items-center gap-3">
                          <PrepDot dish={dish} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{dish?.name ?? id}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {ings.length ? ings.join(" · ") : "No ingredients recorded"}
                            </p>
                          </div>
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={!canEdit}
                            title={`Remove ${dish?.name ?? "dish"}`} onClick={() => removeDish(id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {sideOptions.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t pt-1.5">
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <CornerDownRight className="h-3 w-3" /> Served with
                            </span>
                            {sideOptions.map((sd) => {
                              const on = entry?.sideDishIds.includes(sd.id) ?? false;
                              // A side is checked against everything else already
                              // on the plate — pairing must not smuggle in a clash.
                              const used = new Map<string, string>();
                              for (const other of onPlate.filter((x) => x !== sd.id)) {
                                for (const g of dishById.get(other)?.ingredients ?? []) {
                                  used.set(g.ingredientId, g.ingredientName ?? "an ingredient");
                                }
                              }
                              const hit = (on || !clashBlocks)
                                ? undefined
                                : (sd.ingredients ?? []).find((g) => used.has(g.ingredientId));
                              return (
                                <button
                                  key={sd.id} type="button" disabled={!!hit || !canEdit}
                                  onClick={() => toggleSide(id, sd.id)}
                                  className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                                    on ? "border-accent bg-accent text-white"
                                      : hit ? "border-border text-muted-foreground opacity-50"
                                      : "border-border text-muted-foreground hover:border-accent/50 hover:bg-muted"
                                  }`}
                                >
                                  {on ? "✓ " : "+ "}{sd.name}
                                  {hit && <span className="ml-1 text-destructive">shares {used.get(hit.ingredientId)}</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* picker — an add affordance, so it follows the save gate too. */}
                {canAdd && canEdit && (
                  <div className="px-3.5 pb-3">
                    <div className="relative mb-2">
                      <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={search[slotId] ?? ""}
                        onChange={(e) => setSearch((s) => ({ ...s, [slotId]: e.target.value }))}
                        placeholder={`Search ${all.length} ${componentLabel(slot.component).toLowerCase()} dish${all.length === 1 ? "" : "es"}…`}
                        className="h-8 pl-8 text-xs"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {shown.map((c) => (
                        <button
                          key={c.dish.id} type="button" disabled={c.blocked}
                          onClick={() => addDish(c.dish.id)}
                          title={c.blocked ? c.note : `Add ${c.dish.name}`}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            c.blocked
                              ? "border-border text-muted-foreground opacity-45"
                              : "border-border bg-card hover:border-accent/50 hover:bg-muted"
                          }`}
                        >
                          <PrepDot dish={c.dish} />
                          {c.dish.name}
                          {c.note && (
                            <span className={`text-[10px] ${c.blocked ? "text-destructive" : "text-muted-foreground"}`}>
                              {c.note}
                            </span>
                          )}
                          {(c.dish.sideDishIds ?? []).length > 0 && (
                            <span className="text-[9px] uppercase tracking-wider text-accent-strong">+ sides</span>
                          )}
                        </button>
                      ))}
                      {(hidden > 0 || (isOpen && !q && matched.length > PICKER_PREVIEW)) && (
                        <button
                          type="button"
                          onClick={() => setExpanded((s) => ({ ...s, [slotId]: !s[slotId] }))}
                          className="inline-flex items-center rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                        >
                          {hidden > 0 ? `Show all ${matched.length}` : "Show fewer"}
                        </button>
                      )}
                      {shown.length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          {q
                            ? `No ${componentLabel(slot.component).toLowerCase()} dish matches “${search[slotId]}”.`
                            : `No dish of this course is available for ${brandName} — add one in the Dishes tab.`}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Dishes on the plate that no slot asked for. Only meaningful when a
              rule exists — with no slots every dish lands here, which read as
              the whole menu being off-rule. */}
          {!ruleMissing && verdict.extras.length > 0 && (
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between px-3.5 pb-1.5 pt-2.5">
                <span className="text-sm font-semibold text-primary">Off-rule extras</span>
                <span className="text-[11px] text-muted-foreground">not required by the rule</span>
              </div>
              <div className="flex flex-col gap-1.5 px-3.5 pb-3">
                {verdict.extras.map((id) => (
                  <div key={id} className="flex items-center gap-3 rounded-lg bg-muted px-2.5 py-2">
                    <PrepDot dish={dishById.get(id)} />
                    <span className="flex-1 text-sm font-medium">{dishById.get(id)?.name ?? id}</span>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7" disabled={!canEdit}
                      title="Remove" onClick={() => removeDish(id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {blocked && (
            <div className="rounded-xl bg-danger-soft px-3.5 py-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Ingredient clash — this plate can’t be saved
              </p>
              {verdict.clashes.map((c) => (
                <p key={c.ingredientId} className="text-xs leading-relaxed text-destructive">
                  {c.a} and {c.b} both use {c.ingredientName} — swap one of them.
                </p>
              ))}
            </div>
          )}

          {/* The board cell can only afford a few words, so the repeat reads as a
              tiny marker there. Here there is room to name each dish and say
              exactly where else it runs — and it sits alongside a clash rather
              than being outranked by one, since the drawer has the space. */}
          {plateRepeats.length > 0 && (
            <div className="rounded-xl bg-danger-soft px-3.5 py-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-destructive">
                <CircleAlert className="h-3.5 w-3.5" />
                {plateRepeats.length === 1
                  ? "1 dish repeats within 3 days"
                  : `${plateRepeats.length} dishes repeat within 3 days`}
              </p>
              {plateRepeats.map((r) => (
                <p key={r.dishId} className="text-xs leading-relaxed text-destructive">
                  {r.name} is also served {r.where}.
                </p>
              ))}
              <p className="mt-1 text-[11px] leading-relaxed text-destructive/80">
                Repeats are only flagged, never blocked — save it if the kitchen wants it.
              </p>
            </div>
          )}

        </div>

        {/* ── footer ─────────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-card px-6 py-3.5">
          {!ruleMissing && canEdit && (
            <Button
              variant="outline" size="sm"
              onClick={() => setDraft((d) => fillPlate(d, slots, brand, dishById, dishes, 7))}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Auto-fill rest
            </Button>
          )}
          <div className="flex flex-1 items-center justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {/* Clearing is the one write the server still accepts without a rule,
                so it's the only action offered — a partial removal would 422. */}
            {!canEdit ? null : ruleMissing ? (
              <Button
                variant="destructive"
                disabled={draft.length === 0 || isSaving}
                onClick={() => { plateDraft.clearDraft(); onSave([]); }}
              >
                {isSaving ? "Clearing…" : "Clear plate"}
              </Button>
            ) : (
              <Button
                className="bg-accent text-white hover:bg-accent/90"
                disabled={blocked || isSaving}
                onClick={() => { plateDraft.clearDraft(); onSave(draft); }}
              >
                {isSaving ? "Saving…" : saveLabel}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
