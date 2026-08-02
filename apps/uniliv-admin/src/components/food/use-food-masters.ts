/** Shared master-data queries for the Service Set tabs. */
import { useQuery } from "@tanstack/react-query";
import {
  foodApi, foodKeys,
  type CompositionRule, type Dish, type Ingredient, type Kitchen,
} from "@/lib/food-api";

/** Live, admin-managed brand list (active only). */
export function useActiveBrands(): { code: string; name: string }[] {
  const { data } = useQuery({ queryKey: foodKeys.brands(), queryFn: () => foodApi.listBrands() });
  return (data ?? []).filter((b) => b.isActive).map((b) => ({ code: b.code, name: b.name }));
}

/**
 * The whole dish catalogue, ingredients included.
 *
 * The board and the plate composer score dishes against each other locally, so
 * they need every dish in hand — paging or per-slot fetching would make the
 * "shares Aloo" check impossible to answer while typing.
 */
export function useDishCatalogue() {
  return useQuery<Dish[]>({ queryKey: foodKeys.dishes({}), queryFn: () => foodApi.listDishes() });
}

export function useIngredients() {
  return useQuery<Ingredient[]>({ queryKey: foodKeys.ingredients(), queryFn: () => foodApi.listIngredients() });
}

export function useKitchens() {
  return useQuery<Kitchen[]>({ queryKey: foodKeys.kitchens(), queryFn: () => foodApi.listKitchens() });
}

export function useCompositionRules() {
  return useQuery<CompositionRule[]>({
    queryKey: foodKeys.compositionRules(),
    queryFn: () => foodApi.listCompositionRules(),
  });
}
