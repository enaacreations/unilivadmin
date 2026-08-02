import * as React from "react";
import { Building2, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useGetProperties, getGetPropertiesQueryKey } from "@workspace/api-client-react";

/**
 * A prominent, dismissible banner that names the single property a page's data is
 * scoped to. Use it on any list/dashboard that can be filtered to one property
 * (via a URL `?propertyId=` deep-link or the global selector) so the active scope
 * is never ambiguous — the gap this closes is "the data is filtered but nothing
 * on screen says to which property".
 *
 * Presentational on purpose: the caller resolves `propertyName` from whatever
 * property source it can already access (food lookups, the properties list, …)
 * and supplies `onClear` to drop the scope. Renders nothing when not scoped.
 */
export function PropertyScopeBanner({
  propertyName,
  subtitle,
  onClear,
  clearLabel = "Show all properties",
  note = "Everything on this page is filtered to this property.",
  className,
}: {
  /** Resolved property name. When null/empty the banner renders nothing. */
  propertyName: string | null | undefined;
  /** Optional secondary line (e.g. city, brand, cluster). */
  subtitle?: string | null;
  /** Clears the property scope. Omit to render a non-dismissible (read-only) banner. */
  onClear?: () => void;
  clearLabel?: string;
  note?: string;
  className?: string;
}) {
  if (!propertyName) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-2.5",
        className,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Building2 className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-widest text-accent/80">Viewing one property</p>
        <p className="truncate text-sm font-semibold leading-tight text-foreground">
          {propertyName}
          {subtitle ? <span className="font-normal text-muted-foreground"> · {subtitle}</span> : null}
        </p>
      </div>
      {note && <span className="hidden md:block max-w-[18rem] truncate text-xs text-muted-foreground">{note}</span>}
      {onClear && (
        <Button
          variant="outline"
          size="sm"
          onClick={onClear}
          className="shrink-0 gap-1.5 border-accent/30 bg-card text-foreground hover:bg-accent/10"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          {clearLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Drop-in banner driven by the GLOBAL property selector (sidebar). Renders nothing
 * unless a property is selected app-wide; otherwise names it and offers a one-click
 * "Show all properties" that resets the global scope. Use on any page that filters
 * by the global property so the active scope is echoed on the page itself, not only
 * in the sidebar.
 *
 * Co-living pages resolve the name from the canonical /properties list (default).
 * Food pages, whose roles can't read /properties, pass `properties` from food
 * lookups so the fetch is skipped and names still resolve.
 */
export function GlobalPropertyScopeBanner({
  properties: provided,
  note,
}: {
  properties?: Array<{ id: string; name: string; city?: string | null }>;
  note?: string;
}) {
  const { propertyId, setPropertyId } = useAppStore();
  const { data } = useGetProperties(undefined, {
    query: { queryKey: getGetPropertiesQueryKey(), enabled: !provided },
  });
  if (!propertyId) return null;
  const list = provided ?? ((data?.data || []) as Array<{ id: string; name: string; city?: string | null }>);
  const prop = list.find((p) => p.id === propertyId);
  return (
    <PropertyScopeBanner
      propertyName={prop?.name ?? "Selected property"}
      subtitle={prop?.city ?? undefined}
      onClear={() => setPropertyId(null)}
      note={note}
    />
  );
}
