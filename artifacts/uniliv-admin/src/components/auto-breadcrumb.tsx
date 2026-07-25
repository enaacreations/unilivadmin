import * as React from "react"

/**
 * Coordinates the layout's auto-generated "{Section} › Details" breadcrumb with
 * pages that render their own (richer) breadcrumb — e.g. `PageHeader` with a
 * `breadcrumbs` prop. Without this, a detail page that supplies its own
 * breadcrumb would show two stacked breadcrumbs (the layout's + its own).
 *
 * The Layout provides the context; a page calls `useSuppressLayoutBreadcrumb`
 * to hide the layout crumb while it is mounted. The toggle runs in a layout
 * effect (before paint), so no duplicate crumb is ever visible.
 */
type AutoBreadcrumbCtx = { setSuppressed: (v: boolean) => void }

const AutoBreadcrumbContext = React.createContext<AutoBreadcrumbCtx | null>(null)

export function AutoBreadcrumbProvider({
  setSuppressed,
  children,
}: {
  setSuppressed: (v: boolean) => void
  children: React.ReactNode
}) {
  const value = React.useMemo(() => ({ setSuppressed }), [setSuppressed])
  return <AutoBreadcrumbContext.Provider value={value}>{children}</AutoBreadcrumbContext.Provider>
}

/** Call from a page that renders its own breadcrumb. Pass `active=false` (e.g.
 *  when no breadcrumb is provided) to leave the layout crumb visible. */
export function useSuppressLayoutBreadcrumb(active: boolean) {
  const ctx = React.useContext(AutoBreadcrumbContext)
  React.useLayoutEffect(() => {
    if (!ctx || !active) return
    ctx.setSuppressed(true)
    return () => ctx.setSuppressed(false)
  }, [ctx, active])
}
