/**
 * Fills every empty meal across all four weeks from the saved menu rules.
 *
 * Lives on the Menu tab, not Menu Rules: it calls replaceRotationSlot, so it
 * WRITES ROTATION ROWS. Sitting on the rules tab it needed its own kitchen
 * picker to say where those rows went, which put two identical-looking kitchen
 * selects on one tab meaning different things. Here it inherits the board's
 * kitchen — the verb and its target are the same control.
 *
 * Reads the whole rotation for the brand + kitchen (not just the visible week)
 * because "what's still empty" is a question about the rotation as a whole.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  foodApi, foodKeys, MEAL_TYPES,
  type MealType, type MenuRotationRow,
} from "@/lib/food-api";
import {
  ROTATION_WEEKS, WEEK_DAYS,
  fillPlate, plateKey, plateToItems, rowsToPlates, ruleFor, slotsOf,
} from "./menu-lib";
import { useCompositionRules, useDishCatalogue } from "./use-food-masters";

/** Rotation writes go out in small batches — the API is per-slot. */
const WRITE_CONCURRENCY = 4;

export function GenerateFromRule({
  kitchenId, brand, brandName,
}: {
  kitchenId: string;
  brand: string;
  brandName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: dishes = [] } = useDishCatalogue();
  const { data: rules = [] } = useCompositionRules();

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
          // Same scope the board grades against: this kitchen's rule if it has
          // one, otherwise the brand default.
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
          <p className="font-display text-sm font-semibold text-primary">Generate the rotation from the menu rules</p>
          <p className="text-xs text-muted-foreground">
            {empties
              ? `${empties} meal${empties === 1 ? "" : "s"} across the 4 weeks are still empty for ${brandName}.`
              : `Every meal in all 4 weeks is filled for ${brandName}.`}
          </p>
        </div>
        <Button
          className="bg-accent text-white hover:bg-accent/90"
          disabled={!empties || generate.isPending || !kitchenId}
          onClick={() => generate.mutate()}
        >
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          {generate.isPending ? "Filling…" : "Fill every empty meal"}
        </Button>
      </div>
    </div>
  );
}
