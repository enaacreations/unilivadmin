import { useSearch } from "wouter";

/**
 * Read a single query-string param reactively, e.g. `useQueryParam("propertyId")`
 * on `/food/orders?propertyId=abc` returns "abc". Returns null when absent.
 *
 * Use this so an action button on an entity (a property card, a resident row…)
 * can carry context into a list page — e.g. navigate with `withQuery(...)` and
 * have the destination initialise its filter from the param, instead of landing
 * on the generic, unfiltered page.
 */
export function useQueryParam(key: string): string | null {
  const search = useSearch();
  return new URLSearchParams(search).get(key);
}

/** Build a path with a query string, dropping null/undefined/empty values. */
export function withQuery(
  path: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}
