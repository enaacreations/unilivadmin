/**
 * Dishes — the catalogue as cards rather than a table.
 *
 * A dish is only useful if you can see, at a glance, what it's made of, what it
 * pairs with, how much of it a resident gets, and whether anything on the
 * rotation actually uses it. A table row hid all five behind columns; a card
 * shows them together, and the "Not in the rotation" flag surfaces dead
 * catalogue entries that used to be invisible.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES,
  type Dish, type MenuRotationRow, type PerResidentRule,
} from "@/lib/food-api";
import { MEAL_SHORT, componentLabel } from "./menu-lib";
import { DishDrawer, draftFromDish, type DishDraft } from "./dish-drawer";
import { PrepDot } from "./plate-composer";
import { useActiveBrands, useDishCatalogue, useIngredients } from "./use-food-masters";

export function DishesCatalogue() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const brands = useActiveBrands();
  const { data: dishes = [], isLoading } = useDishCatalogue();
  const { data: ingredients = [] } = useIngredients();

  const [search, setSearch] = React.useState("");
  const [facet, setFacet] = React.useState("ALL");
  const [draft, setDraft] = React.useState<DishDraft | null>(null);
  const [delTarget, setDelTarget] = React.useState<Dish | null>(null);

  // Portion rules and rotation usage are read once for the whole catalogue —
  // both are per-dish badges, and a query each would be an N+1 on render.
  const { data: portionRules = [] } = useQuery<PerResidentRule[]>({
    queryKey: foodKeys.rules({}), queryFn: () => foodApi.listRules(),
  });
  const { data: rotation = [] } = useQuery<MenuRotationRow[]>({
    queryKey: foodKeys.rotation({}), queryFn: () => foodApi.listRotation(),
  });

  const usage = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rotation) m.set(r.dishId, (m.get(r.dishId) ?? 0) + 1);
    return m;
  }, [rotation]);

  const portionsByDish = React.useMemo(() => {
    const m = new Map<string, PerResidentRule[]>();
    for (const r of portionRules) m.set(r.dishId, [...(m.get(r.dishId) ?? []), r]);
    return m;
  }, [portionRules]);

  const del = useMutation({
    mutationFn: (id: string) => foodApi.deleteDish(id),
    onSuccess: () => {
      toast({ title: "Dish deleted" });
      qc.invalidateQueries({ queryKey: ["food", "dishes"] });
      qc.invalidateQueries({ queryKey: ["food", "menu-rotation"] });
      setDelTarget(null);
    },
    onError: (e: any) => toast({ title: e?.message || "Could not delete the dish", variant: "destructive" }),
  });

  const openEdit = async (d: Dish) => {
    // The list carries ingredients and sides, so the drawer opens fully
    // populated; rules arrive separately inside the drawer.
    const rules = await foodApi.listRules({ dishId: d.id }).catch(() => []);
    setDraft(draftFromDish(d, brands.map((b) => b.code), rules));
  };

  const q = search.trim().toLowerCase();
  const filtered = dishes.filter((d) => {
    if (facet !== "ALL" && d.component !== facet) return false;
    if (!q) return true;
    return d.name.toLowerCase().includes(q)
      || (d.ingredients ?? []).some((i) => (i.ingredientName ?? "").toLowerCase().includes(q));
  });

  const facets = ["ALL", ...[...new Set(dishes.map((d) => d.component))].sort()];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-primary">Dishes</h2>
          <p className="text-sm text-muted-foreground">
            {dishes.length} dish{dishes.length === 1 ? "" : "es"} · {usage.size} used in the rotation
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or ingredient" aria-label="Search dishes" className="pl-9"
            />
          </div>
          <Button
            className="bg-accent text-white hover:bg-accent/90"
            onClick={() => setDraft(draftFromDish(null, brands.map((b) => b.code), []))}
          >
            <Plus className="mr-2 h-4 w-4" /> New dish
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {facets.map((f) => (
          <button
            key={f} type="button" onClick={() => setFacet(f)} aria-pressed={f === facet}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              f === facet ? "border-accent bg-accent/10 font-medium text-accent-strong" : "border-border bg-card hover:bg-muted"
            }`}
          >
            {f === "ALL" ? `All ${dishes.length}` : `${componentLabel(f)} ${dishes.filter((d) => d.component === f).length}`}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading the catalogue…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
          No dish matches that search.
        </p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((d) => {
            const uses = usage.get(d.id) ?? 0;
            const rules = portionsByDish.get(d.id) ?? [];
            const sides = (d.sideDishIds ?? []).length;
            return (
              <div key={d.id} className={`rounded-xl border bg-card px-3.5 py-3 ${d.isActive ? "" : "opacity-60"}`}>
                <div className="flex items-start gap-2">
                  <PrepDot dish={d} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">{d.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {componentLabel(d.component)} · {d.unit}
                      {!d.isActive && " · Inactive"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit dish" onClick={() => openEdit(d)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete dish" onClick={() => setDelTarget(d)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {(d.ingredients ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(d.ingredients ?? []).map((i) => (
                      <span key={i.ingredientId} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {i.ingredientName ?? "—"}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {MEAL_TYPES.map((m) => {
                    const forMeal = rules.filter((r) => r.mealType === m);
                    if (!forMeal.length) return null;
                    const qtys = [...new Set(forMeal.map((r) => String(r.qtyPerResident)))];
                    return (
                      <span key={m} className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
                        {MEAL_SHORT[m]} {qtys.join(" / ")}
                      </span>
                    );
                  })}
                  {sides > 0 && (
                    <span className="rounded-full border px-1.5 py-px text-[10px] text-accent-strong">
                      {sides} side option{sides === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className={`text-[10px] ${uses ? "text-muted-foreground" : "text-warning"}`}>
                    {uses ? `In ${uses} plate${uses === 1 ? "" : "s"}` : "Not in the rotation"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DishDrawer
        open={!!draft} onOpenChange={(o) => !o && setDraft(null)}
        draft={draft} setDraft={setDraft}
        dishes={dishes} ingredients={ingredients} brands={brands}
        onSaved={() => setDraft(null)}
      />

      <FormModal
        open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)}
        title="Confirm Delete" saveLabel="Delete" isSaving={del.isPending}
        onSave={() => delTarget && del.mutate(delTarget.id)}
      >
        <p className="text-sm text-muted-foreground">
          Delete <span className="font-medium text-foreground">{delTarget?.name}</span>?
          {(usage.get(delTarget?.id ?? "") ?? 0) > 0 && (
            <> It is currently on {usage.get(delTarget!.id)} rotation plate(s), which will lose it.</>
          )}
        </p>
      </FormModal>
    </div>
  );
}
