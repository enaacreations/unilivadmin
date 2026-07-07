import * as React from "react";
import { usePermissions } from "./use-permissions";

/**
 * Drops table columns that are constant — and therefore noise — for the
 * current viewer's scope:
 *
 * - `singleProperty`: column ids to drop for property-scoped users (unit
 *   leads / wardens, i.e. `me.propertyId` is set). Their rows all belong to
 *   their one property, so a Property/City column never varies.
 * - `roles`: column ids to drop per role, for columns whose value can only
 *   ever be the viewer themself (e.g. the "Unit Lead" / ordered-by column
 *   when a unit lead is looking at their own orders).
 *
 * Removing (not just hiding) keeps the dropped columns out of the Columns
 * picker and CSV/PDF exports too.
 */
export function useScopedColumns<T>(
  columns: T[],
  opts: {
    singleProperty?: string[];
    roles?: Partial<Record<string, string[]>>;
  },
): T[] {
  const { me, role } = usePermissions();
  const isSingleProperty = Boolean(me?.propertyId);
  return React.useMemo(() => {
    const drop = new Set<string>([
      ...(isSingleProperty ? opts.singleProperty ?? [] : []),
      ...((role && opts.roles?.[role]) ?? []),
    ]);
    if (!drop.size) return columns;
    return columns.filter((c) => {
      const def = c as { id?: unknown; accessorKey?: unknown };
      const id = String(def.id ?? def.accessorKey ?? "");
      return !drop.has(id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isSingleProperty, role]);
}
