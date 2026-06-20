import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

type BoundedScrollSize = "sm" | "md" | "lg" | "page"

const sizeMaxHeight: Record<BoundedScrollSize, string> = {
  sm: "40vh",
  md: "50vh",
  lg: "60vh",
  page: "calc(100vh - 220px)",
}

export interface BoundedScrollProps
  extends React.ComponentPropsWithoutRef<typeof ScrollArea> {
  /**
   * Preset max-height bucket. Ignored when `maxHeight` is provided.
   * @default "lg"
   */
  size?: BoundedScrollSize
  /**
   * Explicit CSS max-height (e.g. "320px", "70vh"). Overrides `size`.
   */
  maxHeight?: string
}

/**
 * BoundedScroll — a fixed-height scroll container so long lists/tables never
 * grow the page. Content scrolls inside a capped viewport instead.
 *
 * Wraps the flat ScrollArea primitive. Use `size` for the standard buckets or
 * `maxHeight` to pin an exact height.
 */
const BoundedScroll = React.forwardRef<
  React.ElementRef<typeof ScrollArea>,
  BoundedScrollProps
>(({ size = "lg", maxHeight, className, style, children, ...props }, ref) => {
  const computedMaxHeight = maxHeight ?? sizeMaxHeight[size]

  return (
    <ScrollArea
      ref={ref}
      className={cn("h-full", className)}
      style={{ maxHeight: computedMaxHeight, ...style }}
      {...props}
    >
      {children}
    </ScrollArea>
  )
})
BoundedScroll.displayName = "BoundedScroll"

export { BoundedScroll }
