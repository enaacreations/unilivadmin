/**
 * Menu Rules — what a plate must contain, per brand and meal.
 *
 * The old form was a stack of Component / Preparation / Min / Max dropdown rows,
 * which read like a database table rather than a recipe for a meal. This states
 * the rule as the sentence it actually is — "A Uniliv Lunch is 1 Dal, 1–2 Sabzi,
 * 1 Rice…" — with the counts editable in place.
 *
 * Edits are held locally and saved explicitly: a composition rule silently
 * changing under a half-built rotation is not a surprise worth having.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Info, Minus, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { NumberStepper } from "@/components/ui/number-stepper";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, PREPARATION_LABEL,
  type CompositionRule, type CompositionSlot, type Dish, type FoodLookups, type MealType,
  type MenuRotationRow, type MenuRuleSettings,
} from "@/lib/food-api";
import {
  MEAL_SHORT, REPEAT_WITHIN_DAYS, REPEAT_WITHIN_DAYS_MAX, ROTATION_WEEKS, WEEK_DAYS,
  componentLabel, fillPlate, plateKey, plateToItems, rowsToPlates, ruleFor, slotsOf,
} from "./menu-lib";
import { useActiveBrands, useCompositionRules, useDishCatalogue, useKitchens } from "./use-food-masters";

/** Courses offered by the "add course" affordance, in menu order. */
const COURSES = [
  "HOT_FOOD", "SABZI", "DAL", "RICE", "BREAD", "SALAD", "CURD_RAITA",
  "DESSERT", "BEVERAGE", "SNACK", "FRUITS", "CHUTNEY", "PICKLE", "PAPAD_PICKLE",
  "BAKERY", "MILK", "OTHER",
];
/** Courses with fewer qualifying dishes than this can't sustain a 4-week rotation. */
const THIN_CATALOGUE = 3;
const WRITE_CONCURRENCY = 4;

type DraftSlot = CompositionSlot & { key: string };

const toDraft = (slots: CompositionSlot[]): DraftSlot[] =>
  slots.map((s, i) => ({ ...s, key: s.id ?? `new-${i}-${s.component ?? "any"}` }));

/** How a slot's allowance reads: "1", "1–2", or "1+" when uncapped. */
const countLabel = (s: CompositionSlot) =>
  s.maxCount == null ? `${s.minCount}+`
    : s.maxCount !== s.minCount ? `${s.minCount}–${s.maxCount}`
    : `${s.minCount}`;

export function MenuRulesEditor({ focus }: { focus?: { brand: string; meal: MealType } } = {}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const brands = useActiveBrands();
  const { data: kitchens = [] } = useKitchens();
  const { data: dishes = [] } = useDishCatalogue();
  const { data: rules = [], isLoading } = useCompositionRules();

  const [brand, setBrand] = React.useState(focus?.brand ?? "");
  const [meal, setMeal] = React.useState<MealType>(focus?.meal ?? "LUNCH");
  const [draft, setDraft] = React.useState<DraftSlot[] | null>(null);
  const [genKitchen, setGenKitchen] = React.useState("");

  // F&B managers run exactly one kitchen: no picker on the generate panel, and
  // generation pins to their own kitchen (listKitchens is unscoped, so "first
  // kitchen" would be wrong for them).
  const { role } = usePermissions();
  const kitchenBound = role === "FNB_MANAGER";
  const { data: lookups } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
    enabled: kitchenBound,
  });

  // The two rule switches. Org-wide, so no brand/meal in the key — flipping one
  // here changes what the server accepts for every plate.
  const { data: ruleSettings } = useQuery<MenuRuleSettings>({
    queryKey: foodKeys.menuRuleSettings(),
    queryFn: () => foodApi.menuRuleSettings(),
  });
  const saveRules = useMutation({
    mutationFn: (b: Partial<MenuRuleSettings>) => foodApi.updateMenuRuleSettings(b),
    onSuccess: (fresh, sent) => {
      qc.setQueryData(foodKeys.menuRuleSettings(), fresh);
      // The board reads the same settings to decide what to flag, so a changed
      // window has to reach it rather than waiting for a refetch.
      qc.invalidateQueries({ queryKey: foodKeys.menuRuleSettings() });
      // Say which way it went — a switch sliding back on failure is otherwise
      // the only feedback, and it is easy to miss.
      const [[key, value]] = Object.entries(sent) as [[keyof MenuRuleSettings, boolean | number]];
      if (key === "repeatWithinDays") {
        toast({ title: `Repeats now flagged within ${value} day${value === 1 ? "" : "s"}` });
        return;
      }
      const label = key === "ingredientClashBlocks"
        ? "Shared-ingredient block"
        : "Repeat flag";
      toast({ title: `${label} turned ${value ? "on" : "off"}` });
    },
    onError: (e: any) => toast({ title: e?.message || "Could not change the rule", variant: "destructive" }),
  });
  /** Falls back to the shipped default until the settings land. */
  const repeatDays = ruleSettings?.repeatWithinDays ?? REPEAT_WITHIN_DAYS;
  const repeatOn = ruleSettings?.flagRepeatsWithin3Days !== false;

  // The window is edited in place, inside the rule's own sentence: the number is
  // a control, and the stepper only exists while it is being changed. It opens
  // by itself when the rule is switched on — the one moment the window is worth
  // a second look — and stays reachable afterwards for the rare later edit.
  const [editingDays, setEditingDays] = React.useState(false);
  const [draftDays, setDraftDays] = React.useState(repeatDays);
  const dayEditorRef = React.useRef<HTMLSpanElement>(null);

  // Track the saved value while idle, so re-opening never starts from a stale draft.
  React.useEffect(() => {
    if (!editingDays) setDraftDays(repeatDays);
  }, [repeatDays, editingDays]);

  // Clicking away or pressing Escape abandons the edit rather than committing
  // it — an org-wide rule should not change because a click landed elsewhere.
  React.useEffect(() => {
    if (!editingDays) return;
    const dismiss = () => { setDraftDays(repeatDays); setEditingDays(false); };
    const onDown = (e: MouseEvent) => {
      if (!dayEditorRef.current?.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [editingDays, repeatDays]);

  const commitDays = () => {
    if (draftDays === repeatDays) { setEditingDays(false); return; }
    saveRules.mutate({ repeatWithinDays: draftDays }, { onSuccess: () => setEditingDays(false) });
  };

  // Arriving from a rotation cell that had no rule — open on the exact plate
  // that was missing rather than making the user find it again.
  React.useEffect(() => {
    if (!focus) return;
    setBrand(focus.brand);
    setMeal(focus.meal);
  }, [focus?.brand, focus?.meal]);

  React.useEffect(() => { if (!brand && brands.length) setBrand(brands[0]!.code); }, [brands, brand]);
  React.useEffect(() => {
    if (genKitchen || !kitchens.length || !role) return;
    if (kitchenBound && !lookups) return;
    const mine = kitchenBound ? lookups?.myKitchenIds?.[0] : null;
    setGenKitchen(mine ?? kitchens[0]!.id);
  }, [kitchens, genKitchen, role, kitchenBound, lookups]);
  // Switching brand or meal abandons an unsaved edit to the previous rule.
  React.useEffect(() => { setDraft(null); }, [brand, meal]);

  const rule: CompositionRule | null = React.useMemo(
    () => ruleFor(rules, brand, meal), [rules, brand, meal],
  );
  const saved = React.useMemo(() => toDraft(slotsOf(rule)), [rule]);
  const slots = draft ?? saved;
  const dirty = draft !== null;
  const brandName = brands.find((b) => b.code === brand)?.name ?? brand;

  const edit = (fn: (s: DraftSlot[]) => DraftSlot[]) => setDraft((d) => fn(d ?? saved));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        brand, mealType: meal, kitchenId: rule?.kitchenId ?? null, name: rule?.name ?? null,
        // slotLabel + preparation are preserved from the saved rule; this editor
        // only moves counts and courses, and must not quietly drop the rest.
        slots: slots.map((s, i) => ({
          slotLabel: s.slotLabel ?? null,
          component: s.component ?? null,
          preparation: s.preparation ?? null,
          minCount: s.minCount,
          maxCount: s.maxCount,
          sortOrder: i,
        })),
      };
      return rule ? foodApi.updateCompositionRule(rule.id, body) : foodApi.createCompositionRule(body);
    },
    onSuccess: () => {
      toast({ title: `${brandName} ${MEAL_LABEL[meal]} rule saved` });
      qc.invalidateQueries({ queryKey: ["food", "composition-rules"] });
      setDraft(null);
    },
    onError: (e: any) => toast({ title: e?.message || "Could not save the rule", variant: "destructive" }),
  });

  // ── qualifying dishes ──────────────────────────────────────────────────────
  const qualifying = (s: CompositionSlot) => dishes.filter((d) =>
    d.isActive
    && (d.brands ?? []).includes(brand)
    && (!s.component || d.component === s.component)
    && (!s.preparation || (d.preparations ?? []).includes(s.preparation)));

  const minTotal = slots.reduce((a, s) => a + s.minCount, 0);
  const addable = COURSES.filter((c) => !slots.some((s) => s.component === c));

  if (isLoading) return <p className="py-10 text-center text-sm text-muted-foreground">Loading rules…</p>;

  return (
    <div className="space-y-4">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-primary">Menu Rules</h2>
          <p className="text-sm text-muted-foreground">
            What a plate must contain, per brand and meal. Everything in the rotation is validated against this.
          </p>
        </div>
        {brands.length > 1 && (
          <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
            {brands.map((b) => (
              <button
                key={b.code} type="button" onClick={() => setBrand(b.code)} aria-pressed={b.code === brand}
                className={`inline-flex items-center rounded-md px-3 py-1 text-sm font-medium transition-all ${
                  b.code === brand ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {MEAL_TYPES.map((m) => (
          <button
            key={m} type="button" onClick={() => setMeal(m)} aria-pressed={m === meal}
            className={`rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors ${
              m === meal
                ? "border-accent bg-accent/10 text-accent-strong"
                : "border-border bg-card text-muted-foreground hover:bg-muted"
            }`}
          >
            {MEAL_SHORT[m]}
          </button>
        ))}
      </div>

      {/* ── the plate ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card px-6 py-5">
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">The plate</p>
          {dirty && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-warning">Unsaved changes</span>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Discard</Button>
              <Button
                size="sm" className="bg-accent text-white hover:bg-accent/90"
                disabled={save.isPending} onClick={() => save.mutate()}
              >
                <Check className="mr-1.5 h-3.5 w-3.5" /> {save.isPending ? "Saving…" : "Save rule"}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 leading-loose">
          <span className="font-display text-lg font-semibold">
            A {brandName} {MEAL_SHORT[meal]} is
          </span>

          {slots.map((s, i) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-2 rounded-lg border bg-card py-1 pl-3 pr-1.5"
            >
              <span className="text-[15px] font-medium">
                {s.slotLabel || componentLabel(s.component)}
                {s.preparation && (
                  <span className="ml-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {PREPARATION_LABEL[s.preparation] ?? s.preparation}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-0.5">
                <Button
                  variant="outline" size="icon" className="h-6 w-6"
                  aria-label={`Fewer ${componentLabel(s.component)}`}
                  onClick={() => edit((d) => d.map((x, j) => {
                    if (j !== i) return x;
                    if (x.maxCount == null) return { ...x, minCount: Math.max(0, x.minCount - 1) };
                    if (x.maxCount > x.minCount) return { ...x, maxCount: x.maxCount - 1 };
                    return x.minCount > 0 ? { ...x, minCount: x.minCount - 1, maxCount: x.minCount - 1 } : x;
                  }))}
                >
                  <Minus className="h-2.5 w-2.5" />
                </Button>
                <span className="min-w-9 text-center font-mono text-sm">{countLabel(s)}</span>
                <Button
                  variant="outline" size="icon" className="h-6 w-6"
                  aria-label={`More ${componentLabel(s.component)}`}
                  onClick={() => edit((d) => d.map((x, j) => {
                    if (j !== i) return x;
                    if (x.maxCount == null) return { ...x, minCount: x.minCount + 1 };
                    if (x.maxCount > x.minCount) return { ...x, minCount: x.minCount + 1 };
                    return { ...x, maxCount: x.minCount + 1 };
                  }))}
                >
                  <Plus className="h-2.5 w-2.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-6 w-6"
                  aria-label={`Remove ${componentLabel(s.component)} from the plate`}
                  onClick={() => edit((d) => d.filter((_, j) => j !== i))}
                >
                  <X className="h-2.5 w-2.5" />
                </Button>
              </span>
            </span>
          ))}

          {slots.length === 0 && (
            <span className="text-sm text-muted-foreground">
              nothing yet — add the courses this meal must have.
            </span>
          )}

          <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <Plus className="h-3.5 w-3.5" /> add course
            {addable.slice(0, 5).map((c) => (
              <button
                key={c} type="button"
                onClick={() => edit((d) => [...d, {
                  key: `new-${c}-${d.length}`, slotLabel: null, component: c, preparation: null,
                  minCount: 1, maxCount: 1, sortOrder: d.length,
                }])}
                className="rounded-full border px-2 py-0.5 text-xs transition-colors hover:border-accent/50 hover:bg-muted"
              >
                {componentLabel(c)}
              </button>
            ))}
          </span>
        </div>

        <p className="mt-3.5 text-xs text-muted-foreground">
          {minTotal} dish{minTotal === 1 ? "" : "es"} minimum per plate ·{" "}
          {slots.length * WEEK_DAYS.length * ROTATION_WEEKS.length} slots to fill across 4 rotation weeks
        </p>
      </div>

      {/* ── enforcement + catalogue depth ────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card px-4 py-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Variety &amp; safety rules
          </p>
          <div className="flex flex-col gap-3">
            {/* Real settings, stored in system_config and read by the server on
                every rotation write — not decoration. Turning the first one off
                genuinely stops the API rejecting clashing plates. */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium">No two dishes may share an ingredient</p>
                <p className="text-[11px] text-muted-foreground">
                  {ruleSettings?.ingredientClashBlocks === false
                    ? "Off — plates with a shared ingredient can be saved."
                    : "Enforced on save — the server rejects a plate that clashes."}
                </p>
              </div>
              <Switch
                checked={ruleSettings?.ingredientClashBlocks ?? true}
                disabled={!ruleSettings || saveRules.isPending}
                onCheckedChange={(v) => saveRules.mutate({ ingredientClashBlocks: v })}
                aria-label="Block plates whose dishes share an ingredient"
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                {/* The window lives in the sentence. Off, it is plain prose;
                    on, the number is the control that changes it. */}
                {!repeatOn ? (
                  <p className="text-sm">
                    No dish repeats within {repeatDays} day{repeatDays === 1 ? "" : "s"}
                  </p>
                ) : editingDays ? (
                  <span ref={dayEditorRef} className="flex flex-wrap items-center gap-1.5 text-sm">
                    No dish repeats within
                    <NumberStepper
                      value={draftDays}
                      onChange={setDraftDays}
                      min={1}
                      max={REPEAT_WITHIN_DAYS_MAX}
                      size="sm"
                      disabled={saveRules.isPending}
                      aria-label="Days within which a repeat is flagged"
                    />
                    day{draftDays === 1 ? "" : "s"}
                    <Button
                      size="sm"
                      className="bg-accent text-white hover:bg-accent/90"
                      disabled={saveRules.isPending}
                      onClick={commitDays}
                    >
                      {saveRules.isPending ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      size="sm" variant="ghost" disabled={saveRules.isPending}
                      onClick={() => { setDraftDays(repeatDays); setEditingDays(false); }}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <p className="text-sm">
                    No dish repeats within{" "}
                    <button
                      type="button"
                      onClick={() => { setDraftDays(repeatDays); setEditingDays(true); }}
                      className="border-b border-dashed border-accent-strong font-medium text-accent-strong hover:border-solid"
                      title="Change the repeat window"
                    >
                      {repeatDays}
                    </button>{" "}
                    day{repeatDays === 1 ? "" : "s"}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {!repeatOn
                    ? "Off — repeats are not flagged while picking."
                    : editingDays
                      ? draftDays >= REPEAT_WITHIN_DAYS_MAX
                        ? "The whole rotation — a dish is flagged wherever else it appears for this meal."
                        : `A dish served for the same meal ${draftDays} day${draftDays === 1 ? "" : "s"} either side is flagged.`
                      : "Repeats are flagged as you pick, never blocked — the kitchen decides."}
                </p>
              </div>
              <Switch
                checked={ruleSettings?.flagRepeatsWithin3Days ?? true}
                disabled={!ruleSettings || saveRules.isPending}
                onCheckedChange={(v) => {
                  saveRules.mutate({ flagRepeatsWithin3Days: v });
                  // Switching the rule ON is the one moment the window is worth
                  // a second look, so open the editor with it; switching off
                  // closes whatever was open.
                  setDraftDays(repeatDays);
                  setEditingDays(v);
                }}
                aria-label={`Flag dishes repeated within ${repeatDays} days`}
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card px-4 py-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Dishes that qualify today
          </p>
          {slots.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Add a course to see its depth.</p>
          ) : (
            <div className="flex h-[104px] items-end gap-2">
              {slots.map((s) => {
                const n = qualifying(s).length;
                return (
                  <div key={s.key} className="flex h-full flex-1 flex-col justify-end text-center">
                    <p className="font-mono text-[11px] font-medium">{n}</p>
                    <div
                      className={`rounded-t ${n < THIN_CATALOGUE ? "bg-warning" : "bg-accent/55"}`}
                      style={{ height: `${Math.max(6, Math.min(64, n * 7))}px` }}
                      title={`${n} ${componentLabel(s.component)} dish${n === 1 ? "" : "es"} for ${brandName}`}
                    />
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">
                      {componentLabel(s.component).split(" ")[0]}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
          {slots.some((s) => qualifying(s).length < THIN_CATALOGUE) && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
              <Info className="mt-px h-3 w-3 shrink-0" />
              A course with fewer than {THIN_CATALOGUE} dishes will repeat heavily across four weeks.
            </p>
          )}
        </div>
      </div>

      <GenerateFromRule
        brand={brand} brandName={brandName} rules={rules} dishes={dishes}
        kitchens={kitchens} kitchenId={genKitchen} onKitchenChange={setGenKitchen}
        canPickKitchen={!kitchenBound}
        dirty={dirty}
      />
    </div>
  );
}

/**
 * Fills every empty meal across all four weeks from the current rules.
 *
 * Reads the whole rotation for the brand + kitchen (not just the visible week)
 * because "what's still empty" is a question about the rotation as a whole.
 */
function GenerateFromRule({
  brand, brandName, rules, dishes, kitchens, kitchenId, onKitchenChange, canPickKitchen, dirty,
}: {
  brand: string;
  brandName: string;
  rules: CompositionRule[];
  dishes: Dish[];
  kitchens: { id: string; name: string }[];
  kitchenId: string;
  onKitchenChange: (v: string) => void;
  canPickKitchen: boolean;
  dirty: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const params = { kitchenId, brand };
  const { data: rows = [] } = useQuery<MenuRotationRow[]>({
    queryKey: foodKeys.rotation(params),
    queryFn: () => foodApi.listRotation(params),
    enabled: !!kitchenId && !!brand,
  });

  const dishById = React.useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);
  // listRotation returns all four weeks here, so bucket by week before folding.
  const platesByWeek = React.useMemo(() => {
    const out = new Map<number, ReturnType<typeof rowsToPlates>>();
    for (const w of ROTATION_WEEKS) out.set(w, rowsToPlates(rows.filter((r) => r.rotationWeek === w)));
    return out;
  }, [rows]);

  const empties = React.useMemo(() => {
    let n = 0;
    for (const w of ROTATION_WEEKS) {
      for (const meal of MEAL_TYPES) {
        for (const day of WEEK_DAYS) {
          if (!(platesByWeek.get(w)?.get(plateKey(day, meal))?.length)) n++;
        }
      }
    }
    return n;
  }, [platesByWeek]);

  const generate = useMutation({
    mutationFn: async () => {
      const writes: { week: number; day: number; meal: MealType; items: ReturnType<typeof plateToItems> }[] = [];
      let seed = 2;
      for (const w of ROTATION_WEEKS) {
        for (const meal of MEAL_TYPES) {
          const slots = slotsOf(ruleFor(rules, brand, meal, kitchenId));
          if (!slots.length) continue;
          for (const day of WEEK_DAYS) {
            if (platesByWeek.get(w)?.get(plateKey(day, meal))?.length) continue;
            const plate = fillPlate([], slots, brand, dishById, dishes, (seed += 5));
            if (plate.length) writes.push({ week: w, day, meal, items: plateToItems(plate) });
          }
        }
      }
      let failed = 0;
      for (let i = 0; i < writes.length; i += WRITE_CONCURRENCY) {
        await Promise.all(writes.slice(i, i + WRITE_CONCURRENCY).map(async (v) => {
          try {
            await foodApi.replaceRotationSlot({
              kitchenId, brand, rotationWeek: v.week, dayOfWeek: v.day, mealType: v.meal, items: v.items,
            });
          } catch { failed++; }
        }));
      }
      return { total: writes.length, failed };
    },
    onSuccess: ({ total, failed }) => {
      qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] });
      if (!total) { toast({ title: "Nothing to generate — no empty meals for this brand" }); return; }
      toast({
        title: `${total - failed} of ${total} meals filled`,
        description: failed ? `${failed} could not be filled — open them on the board to see why.` : undefined,
        variant: failed ? "destructive" : undefined,
      });
    },
    onError: (e: any) => toast({ title: e?.message || "Generation failed", variant: "destructive" }),
  });

  return (
    <div className="rounded-xl border border-accent bg-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-display text-sm font-semibold text-primary">Generate the rotation from these rules</p>
          <p className="text-xs text-muted-foreground">
            {dirty
              ? "Save the rule above first — generation uses the saved rules."
              : empties
                ? `${empties} meal${empties === 1 ? "" : "s"} across the 4 weeks are still empty for ${brandName}.`
                : `Every meal in all 4 weeks is filled for ${brandName}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canPickKitchen && kitchens.length > 1 && (
            <Select value={kitchenId} onValueChange={onKitchenChange}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Kitchen" /></SelectTrigger>
              <SelectContent>
                {kitchens.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button
            className="bg-accent text-white hover:bg-accent/90"
            disabled={dirty || !empties || generate.isPending || !kitchenId}
            onClick={() => generate.mutate()}
          >
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            {generate.isPending ? "Filling…" : "Fill every empty meal"}
          </Button>
        </div>
      </div>
    </div>
  );
}
