import * as React from "react"
import { History, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** "3 minutes ago" / "yesterday", rough on purpose — the exact second is noise here. */
function relativeTime(ts: number | null): string {
  if (!ts) return "earlier"
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return "moments ago"
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

interface DraftRestoredNoticeProps {
  /** `restored` from useFormDraft — renders nothing when false. */
  show: boolean
  /** `restoredAt` from useFormDraft. */
  savedAt?: number | null
  /** Throw the draft away and put the original values back. */
  onDiscard: () => void
  /** Acknowledge and keep the restored values. */
  onDismiss: () => void
  className?: string
}

/**
 * Tells the user their half-finished form was brought back, and gives them the
 * one-click way out. Auto-restoring silently would be the worse trade: on an
 * edit form the user would have no way to tell restored draft values apart from
 * the record's real ones.
 */
export function DraftRestoredNotice({
  show,
  savedAt,
  onDiscard,
  onDismiss,
  className,
}: DraftRestoredNoticeProps) {
  if (!show) return null
  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex items-start gap-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2.5 text-sm text-amber-900",
        "dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
        className,
      )}
      data-testid="draft-restored-notice"
    >
      <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1 leading-snug">
        <p className="font-medium">Unsaved changes restored</p>
        <p className="text-xs opacity-90">
          We brought back what you were typing {relativeTime(savedAt ?? null)}.
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
        onClick={onDiscard}
        data-testid="button-discard-draft"
      >
        Start fresh
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="mt-0.5 shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
