import * as React from "react";
import { usePermissions } from "@/lib/use-permissions";
import type { Module } from "@/lib/permissions";

/**
 * Per-action gating for write controls (PRD §32).
 *
 * PageGuard only ever checked `view`, so a page a user could open showed every
 * button on it — several pages carry comments saying exactly that. This gates
 * the control itself.
 *
 * Framing: the server refuses regardless. Hiding a button is a courtesy, not a
 * boundary; the point is that a user is not invited to do something that will
 * fail. When it does fail, the 403's sentence is what explains it.
 */
export function useCan(module: Module, action = "view"): boolean {
  const { can, isLoading } = usePermissions();
  // FALSE while loading. Rendering a control enabled before authorization is
  // known invites the one click that produces a 403 — better a moment's
  // disabled than a refusal the user has to interpret.
  if (isLoading) return false;
  return can(module, action);
}

export function Can({
  module,
  action = "view",
  mode = "hide",
  reason,
  fallback = null,
  children,
}: {
  module: Module;
  action?: string;
  /**
   * `hide` removes the control — right when its presence would only confuse.
   * `disable` keeps it visible with the reason on hover — right when its
   * absence would make the page look broken, or when the user should know the
   * capability exists and they lack it.
   */
  mode?: "hide" | "disable";
  reason?: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const allowed = useCan(module, action);
  if (allowed) return <>{children}</>;
  if (mode === "hide") return <>{fallback}</>;

  const title = reason ?? `You need ${module}:${action} to do this.`;
  return (
    <span title={title} aria-disabled className="inline-flex cursor-not-allowed opacity-55 [&_*]:pointer-events-none">
      {children}
    </span>
  );
}
