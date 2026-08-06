/**
 * The food module's one failed-fetch state.
 *
 * Invariant: a failed query must never render as "no data". Every food board
 * used to swallow its error into an empty state, so a 403 or a dropped request
 * read as a quiet day. Mirrors the inline block food-agencies.tsx already used.
 */
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FoodQueryError({
  label, hint, onRetry,
}: {
  /** What failed to load, e.g. "orders" — reads as "Could not load orders." */
  label: string;
  hint?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-destructive/40 bg-destructive/5 px-6 py-10 text-center">
      <AlertTriangle className="h-5 w-5 text-destructive" />
      <p className="text-sm text-destructive">Could not load {label}.</p>
      {hint && <p className="max-w-md text-[13px] text-muted-foreground">{hint}</p>}
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
