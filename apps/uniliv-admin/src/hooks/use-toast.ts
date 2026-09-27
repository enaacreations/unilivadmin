import * as React from "react";
import { toast as sonner } from "sonner";

/**
 * Toasts, backed by sonner.
 *
 * ── Why an adapter rather than a rewrite ──────────────────────────────────
 * 602 call sites across the app already say `toast({ title, description })`.
 * Rewriting every one of them to sonner's own API would be a very large diff
 * whose only product is a different spelling, so the shape stays and the
 * rendering changes underneath it. This also keeps the ONE place where a
 * variant is turned into a colour, instead of 602 places choosing for
 * themselves.
 *
 * ── The variants ──────────────────────────────────────────────────────────
 * The colour carries meaning, so it is picked from what happened, not from
 * taste:
 *
 *   success      it worked, and something changed
 *   destructive  it failed, or was refused — the existing spelling, kept so the
 *                321 call sites that already say it need no edit
 *   warning      nothing failed yet, but the person has to fix something first
 *                (a missing field, an unmet precondition)
 *   info         a statement with no outcome attached
 *   default      unclassified; neutral, which is what everything used to be
 *
 * `destructive` is sonner's `error` and `warning` is its `warning`; the names
 * differ because ours is the name 321 call sites already use and renaming it
 * would be churn for no gain.
 */
export type ToastVariant = "default" | "success" | "destructive" | "warning" | "info";

export interface ToastInput {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** Milliseconds. Errors default to longer, because they are read, not glanced at. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

/** Sonner takes strings; a ReactNode title from an older call site is rendered as-is. */
function text(node: React.ReactNode): string | React.ReactNode {
  return node ?? "";
}

/**
 * A refusal is read; a confirmation is glanced at.
 *
 * Errors and warnings stay up long enough to finish the sentence and decide
 * what to do, which the old fixed duration did not allow for.
 */
const DURATION: Record<ToastVariant, number> = {
  default: 4000,
  success: 3500,
  info: 4000,
  warning: 6000,
  destructive: 8000,
};

export function toast({ title, description, variant = "default", duration, action }: ToastInput) {
  const opts = {
    description: description ? text(description) : undefined,
    duration: duration ?? DURATION[variant],
    ...(action ? { action: { label: action.label, onClick: action.onClick } } : {}),
  };
  const body = text(title);

  switch (variant) {
    case "success": return { id: String(sonner.success(body, opts)) };
    case "destructive": return { id: String(sonner.error(body, opts)) };
    case "warning": return { id: String(sonner.warning(body, opts)) };
    case "info": return { id: String(sonner.info(body, opts)) };
    default: return { id: String(sonner(body, opts)) };
  }
}

/**
 * Kept so `const { toast } = useToast()` keeps working everywhere.
 *
 * sonner holds its own state outside React, so there is nothing to subscribe
 * to and nothing to re-render — which is most of why the 191-line reducer this
 * replaced is gone.
 */
export function useToast() {
  return {
    toast,
    dismiss: (id?: string) => (id ? sonner.dismiss(id) : sonner.dismiss()),
  };
}
