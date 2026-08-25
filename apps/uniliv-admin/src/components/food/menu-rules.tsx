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
import { Check, Info, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { NumberStepper } from "@/components/ui/number-stepper";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import {
  foodApi, foodKeys, MEAL_TYPES, MEAL_LABEL, PREPARATION_LABEL,
  type CompositionRule, type CompositionSlot, type FoodLookups, type MealType,
  type MenuRuleSettings,
} from "@/lib/food-api";
import {
  MEAL_SHORT, REPEAT_WITHIN_DAYS, REPEAT_WITHIN_DAYS_MAX, ROTATION_WEEKS, WEEK_DAYS,
  componentLabel, ruleFor, slotsOf,
} from "./menu-lib";
import { useActiveBrands, useCompositionRules, useDishCatalogue, useKitchens } from "./use-food-masters";
import { FoodQueryError } from "./query-error";
import { useStateDraft } from "@/hooks/use-state-draft";
import { DraftRestoredNotice } from "@/components/ui/draft-restored-notice";

/**
 * Radix Select forbids an empty-string item value, so the "no kitchen scope"
 * option needs a sentinel. It is mapped back to "" on both edges.
 */
const ALL_KITCHENS = "__ALL__";

/** Courses offered by the "add course" affordance, in menu order. */
const COURSES = [
  "HOT_FOOD", "SABZI", "DAL", "RICE", "BREAD", "SALAD", "CURD_RAITA",
  "DESSERT", "BEVERAGE", "SNACK", "FRUITS", "CHUTNEY", "PICKLE", "PAPAD_PICKLE",
  "BAKERY", "MILK", "OTHER",
];
/** Courses with fewer qualifying dishes than this can't sustain a 4-week rotation. */
const THIN_CATALOGUE = 3;

type DraftSlot = CompositionSlot & { key: string };

const toDraft = (slots: CompositionSlot[]): DraftSlot[] =>
  slots.map((s, i) => ({ ...s, key: s.id ?? `new-${i}-${s.component ?? "any"}` }));

/** How a slot's allowance reads: "1", "1–2", or "1+" when uncapped. */
const countLabel = (s: CompositionSlot) =>
  s.maxCount == null ? `${s.minCount}+`
    : s.maxCount !== s.minCount ? `${s.minCount}–${s.maxCount}`
    : `${s.minCount}`;

/** `canEdit` mirrors the server's FOOD_SETTINGS:edit gate (M16) — a view-only
 *  principal reads the plate definition but cannot save or edit it. */
export function MenuRulesEditor({
  canEdit = true, orgWideConfig = true,
  focus, kitchenId, onKitchenChange, brand, onBrandChange, allKitchens, onAllKitchensChange,
}: {
  canEdit?: boolean;
  orgWideConfig?: boolean;
  focus?: { brand: string; meal: MealType };
  /** Shared with the Menu tab — see RotationBoard for why the page owns these. */
  kitchenId: string;
  onKitchenChange: (v: string) => void;
  brand: string;
  onBrandChange: (v: string) => void;
  /** True = editing the brand default rather than `kitchenId`. Page-owned too. */
  allKitchens: boolean;
  onAllKitchensChange: (v: boolean) => void;
}) {
  // H4: the two "Variety & safety rules" switches below live in system_config
  // under a single org-wide key, so PUT /food/system-config/menu-rules 403s any
  // kitchen- or property-scoped caller. The composition rules on this same tab
  // are NOT org-wide (they carry a kitchenId), so this narrows only the switches.
  const canEditGlobalRules = canEdit && orgWideConfig;
  const qc = useQueryClient();
  const { toast } = useToast();

  const brands = useActiveBrands();
  const { data: kitchens = [] } = useKitchens();
  const { data: dishes = [], isError: dishesError } = useDishCatalogue();
  // A failed rules read must not render as "this brand has no plate rule": the
  // editor would then offer an empty plate whose Save CREATES a second rule
  // alongside the one that is really there.
  const { data: rules = [], isLoading, isError: rulesError, refetch: refetchRules } = useCompositionRules();

  const setBrand = onBrandChange;
  const [meal, setMeal] = React.useState<MealType>(focus?.meal ?? "LUNCH");
  const [draft, setDraft] = React.useState<DraftSlot[] | null>(null);

  // F&B managers run exactly one kitchen (listKitchens is unscoped, so "first
  // kitchen" would be wrong for them).
  const { role } = usePermissions();
  const kitchenBound = role === "FNB_MANAGER";
  // The defaulting effect below waits on this, so a failed read leaves
  // `genKitchen` empty and the generate panel permanently inert with no reason
  // given. Pass the failure down so the panel can say why.
  const { data: lookups, isError: lookupsError } = useQuery<FoodLookups>({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
    enabled: kitchenBound,
  });
  // The plate DEFINITION is brand-wide (kitchenId null) — it governs what every
  // kitchen on the brand may build — so the server refuses it for a
  // kitchen-restricted caller (H4). `orgWideConfig` arrives from the page, which
  // derives it from `myKitchenIds` on an always-enabled lookups query (null =
  // unrestricted); role alone cannot tell, because an org-wide F&B manager exists
  // and a KITCHEN-scoped KITCHEN_MANAGER / FNB_SUPERVISOR is restricted without
  // being an FNB_MANAGER. The local `lookups` query below is a different job — it
  // pins the GENERATE panel to an F&B manager's own kitchen — and is deliberately
  // only enabled for that role.

  // ── Scope ────────────────────────────────────────────────────────────────
  // Two states: the brand default every kitchen follows, or one specific
  // kitchen. The KITCHEN comes from the page so it stays in step with the Menu
  // tab; only "am I on the default or on that kitchen" is local, because the
  // Menu tab has no equivalent of "all kitchens" to sync with.
  //
  // Kitchen, not property, is the finest scope a rule can be ENFORCED at: the
  // rotation is one plate per (kitchen, brand), so every property a kitchen
  // serves eats the same plate and two properties on one kitchen cannot satisfy
  // conflicting rules.
  //
  const scopeAll = allKitchens;
  const setScopeAll = onAllKitchensChange;
  const scopeKitchen = scopeAll ? "" : kitchenId;
  const scopeArgs = scopeKitchen ? { kitchenId: scopeKitchen } : {};
  const scopeName = kitchens.find((k) => k.id === scopeKitchen)?.name ?? "";

  // The two rule switches, resolved for the current scope. On the brand default
  // these are the org-wide values and flipping one changes every plate; on a
  // kitchen, the write lands as an override for that kitchen alone.
  const { data: ruleSettings } = useQuery<MenuRuleSettings>({
    queryKey: foodKeys.menuRuleSettings(scopeArgs),
    queryFn: () => foodApi.menuRuleSettings(scopeArgs),
  });
  const saveRules = useMutation({
    mutationFn: (b: Partial<MenuRuleSettings>) =>
      foodApi.updateMenuRuleSettings({ ...b, ...scopeArgs }),
    onSuccess: (fresh, sent) => {
      qc.setQueryData(foodKeys.menuRuleSettings(scopeArgs), fresh);
      // Invalidate the whole family, not just this scope: a global change moves
      // what every property inherits, and the board reads these too.
      qc.invalidateQueries({ queryKey: ["food", "menu-rule-settings"] });
      // Say which way it went — a switch sliding back on failure is otherwise
      // the only feedback, and it is easy to miss.
      // Name the scope: "turned off" reads as org-wide, and doing that to every
      // property when you meant one is the expensive mistake here.
      const where = scopeName ? ` for ${scopeName}` : " everywhere";
      const [[key, value]] = Object.entries(sent) as [[keyof MenuRuleSettings, boolean | number]];
      if (key === "repeatWithinDays") {
        toast({ title: `Repeats now flagged within ${value} day${value === 1 ? "" : "s"}${where}` });
        return;
      }
      const label = key === "ingredientClashBlocks"
        ? "Shared-ingredient block"
        : "Repeat flag";
      toast({ title: `${label} turned ${value ? "on" : "off"}${where}` });
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
  // Seed the SHARED kitchen if this tab is the first one opened. Same rule as
  // the board: the caller's own kitchen when they are bound to one, else the
  // first. Guarded on `kitchenId` so it never overwrites a live choice.
  React.useEffect(() => {
    if (kitchenId || !kitchens.length || !role) return;
    if (kitchenBound && !lookups) return;
    const mine = kitchenBound ? lookups?.myKitchenIds?.[0] : null;
    onKitchenChange(mine ?? kitchens[0]!.id);
  }, [kitchens, kitchenId, role, kitchenBound, lookups, onKitchenChange]);
  // Switching brand, meal or scope abandons an unsaved edit to the previous rule.
  React.useEffect(() => { setDraft(null); }, [brand, meal, scopeKitchen]);

  // `draft` is null until the plate is actually edited, which makes it both the
  // autosave value and the "is there anything to save" flag. Keyed to the exact
  // rule being edited — brand, meal and scope — because the effect above throws
  // the edit away when any of those change, and a resumed draft must not land on
  // a different rule than the one it was typed against.
  const plateRuleDraft = useStateDraft(draft, {
    key: `menu-rule-form:${brand}:${meal}:${scopeKitchen || "all-kitchens"}`,
    onRestore: setDraft,
  });

  const rule: CompositionRule | null = React.useMemo(
    () => ruleFor(rules, brand, meal, scopeKitchen || null, null),
    [rules, brand, meal, scopeKitchen],
  );
  /**
   * Does the resolved rule BELONG to the scope on screen, or is it inherited
   * from the brand default? This decides update-vs-create on save: editing an
   * inherited rule must fork a new kitchen row, never rewrite the brand default
   * under every other kitchen that still follows it.
   */
  const ruleIsOwn = !!rule && (rule.kitchenId ?? null) === (scopeKitchen || null);
  const inherited = !!rule && !ruleIsOwn;
  const saved = React.useMemo(() => toDraft(slotsOf(rule)), [rule]);
  const slots = draft ?? saved;
  const dirty = draft !== null;
  const brandName = brands.find((b) => b.code === brand)?.name ?? brand;

  const edit = (fn: (s: DraftSlot[]) => DraftSlot[]) => setDraft((d) => fn(d ?? saved));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        brand, mealType: meal,
        kitchenId: scopeKitchen || null,
        // Rules are authored per kitchen; the finer property scope exists in the
        // resolver but nothing here writes it.
        propertyId: null,
        name: rule?.name ?? null,
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
      // Only update in place when the rule is the scope's OWN row; an inherited
      // one is forked into a new rule for this scope instead.
      return ruleIsOwn && rule
        ? foodApi.updateCompositionRule(rule.id, body)
        : foodApi.createCompositionRule(body);
    },
    onSuccess: () => {
      toast({
        title: scopeName
          ? `${scopeName} ${MEAL_LABEL[meal]} rule saved`
          : `${brandName} ${MEAL_LABEL[meal]} rule saved`,
        ...(inherited
          ? { description: `${scopeName} now has its own rule and no longer follows the ${brandName} default.` }
          : {}),

      });
      qc.invalidateQueries({ queryKey: ["food", "composition-rules"] });
      plateRuleDraft.clearDraft();
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
  // M16 — the plate is a WRITE surface. The Save button already knew that; the
  // per-slot +/−/× buttons did not, so a view-only or kitchen-scoped principal
  // could rearrange the plate and then find no way to save and no reason given.
  // One gate for every control that edits the draft.
  const canEditPlate = canEdit && orgWideConfig;

  if (rulesError) {
    return (
      <FoodQueryError
        label="the menu rules"
        hint="Nothing on this tab can be trusted until the saved rules load — editing or generating now would work from a blank plate."
        onRetry={() => refetchRules()}
      />
    );
  }
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
        <div className="flex flex-wrap items-center gap-2">
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
          {/* Kitchen switcher, same control as the Menu tab. Default is the
              brand-wide rule every kitchen follows; picking a kitchen narrows
              the rule AND the two switches below to that kitchen alone. The
              "all kitchens" entry has to stay — every rule authored before this
              picker existed lives there, and it is the fallback for any kitchen
              without its own. */}
          {kitchens.length > 0 && (
            <Select
              value={scopeKitchen || ALL_KITCHENS}
              onValueChange={(v) => {
                if (v === ALL_KITCHENS) { setScopeAll(true); return; }
                // Picking a kitchen here also moves the Menu tab to it. Going
                // back to "all kitchens" deliberately does NOT — the board has
                // no such state, so there would be nothing to move it to.
                setScopeAll(false);
                onKitchenChange(v);
              }}
            >
              <SelectTrigger className="h-9 w-[240px]" aria-label="Which kitchens this rule applies to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_KITCHENS}>All kitchens ({brandName} default)</SelectItem>
                {kitchens.map((k) => (
                  <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Inherited means the fields below are showing the WIDER rule. Saying so
          is what stops an edit here reading as an edit to just this kitchen when
          it would in fact fork a new rule (or, before this scope existed, quietly
          rewrite the shared one under every kitchen). */}
      {scopeKitchen && inherited && (
        <p className="flex items-start gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {scopeName} follows the {brandName} default. Saving a change here gives it its own
            rule — the other kitchens keep the shared one.
          </span>
        </p>
      )}

      <DraftRestoredNotice
        show={plateRuleDraft.restored}
        savedAt={plateRuleDraft.restoredAt}
        onDiscard={plateRuleDraft.discardDraft}
        onDismiss={plateRuleDraft.dismissRestored}
      />

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
          {/* Say why the controls are inert — for BOTH reasons they can be. */}
          {!canEditPlate && (
            <span className="text-xs text-muted-foreground">
              {canEdit
                ? "This plate applies to every kitchen on the brand — only an org-wide administrator can change it."
                : "Read-only — you don’t have permission to change the plate."}
            </span>
          )}
          {dirty && canEditPlate && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-warning">Unsaved changes</span>
              <Button variant="ghost" size="sm" onClick={plateRuleDraft.discardDraft}>Discard</Button>
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
                  disabled={!canEditPlate}
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
                  disabled={!canEditPlate}
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
                  disabled={!canEditPlate}
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

          {/* An "add course" box with nothing addable in it is a dead affordance. */}
          {canEditPlate && (
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
          )}
        </div>

        <p className="mt-3.5 text-xs text-muted-foreground">
          {minTotal} dish{minTotal === 1 ? "" : "es"} minimum per plate ·{" "}
          {slots.length * WEEK_DAYS.length * ROTATION_WEEKS.length} slots to fill across 4 rotation weeks
        </p>
      </div>

      {/* ── enforcement + catalogue depth ────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card px-4 py-4">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Variety &amp; safety rules
          </p>
          {/* These switches follow the same scope as the rule above. Without the
              line the two blocks look independent, and "off" would read as
              org-wide when it is one property — or the reverse. */}
          <p className="mb-3 text-[11px] text-muted-foreground">
            {scopeName
              ? `Applies to ${scopeName} only — other kitchens keep their own settings.`
              : "Applies to every kitchen. Pick a kitchen above to set these for one kitchen."}
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
                disabled={!canEditGlobalRules || !ruleSettings || saveRules.isPending}
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
                disabled={!canEditGlobalRules || !ruleSettings || saveRules.isPending}
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
          {/* A failed catalogue read scores every course at 0 and lights the
              "will repeat heavily" warning — say it's unknown, don't say zero. */}
          {dishesError ? (
            <p className="py-6 text-center text-xs text-destructive">
              Could not load the dish catalogue — depth is unknown.
            </p>
          ) : slots.length === 0 ? (
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
          {!dishesError && slots.some((s) => qualifying(s).length < THIN_CATALOGUE) && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
              <Info className="mt-px h-3 w-3 shrink-0" />
              A course with fewer than {THIN_CATALOGUE} dishes will repeat heavily across four weeks.
            </p>
          )}
        </div>
      </div>

    </div>
  );
}
