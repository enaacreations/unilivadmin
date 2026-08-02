import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Fullscreen image gallery / lightbox.
 *
 * Controlled by `index` (null = closed). Renders a dark, focused viewer with a
 * large contained image, edge prev/next controls, a position counter, a
 * thumbnail filmstrip, and keyboard navigation (←/→ to move, Esc to close).
 *
 * Built on Radix Dialog primitives so it traps focus, locks scroll, and stacks
 * correctly above an already-open dialog (e.g. the Manage Photos modal).
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  alt = "Photo",
}: {
  images: string[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  alt?: string;
}): React.JSX.Element | null {
  const open = index !== null;
  const count = images.length;

  const go = React.useCallback(
    (dir: number) => {
      if (index === null || count === 0) return;
      onIndexChange((index + dir + count) % count);
    },
    [index, count, onIndexChange],
  );

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, go]);

  if (!open || count === 0) return null;

  const ctrl =
    "grid place-items-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={onClose}
          className="fixed inset-0 z-[60] flex items-center justify-center focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">Photo viewer</DialogPrimitive.Title>

          {/* Position counter */}
          {count > 1 && (
            <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium tabular-nums text-white backdrop-blur-sm">
              {index! + 1} / {count}
            </div>
          )}

          {/* Close */}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cn(ctrl, "absolute right-4 top-4 h-9 w-9")}
          >
            <X className="h-5 w-5" />
          </button>

          {/* Main image — clicking it should not close */}
          <img
            src={images[index!]}
            alt={`${alt} ${index! + 1}`}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[92vw] select-none rounded-lg object-contain shadow-2xl"
          />

          {/* Prev / next */}
          {count > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
                className={cn(ctrl, "absolute left-3 top-1/2 h-11 w-11 -translate-y-1/2 sm:left-5")}
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
                className={cn(ctrl, "absolute right-3 top-1/2 h-11 w-11 -translate-y-1/2 sm:right-5")}
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}

          {/* Thumbnail filmstrip */}
          {count > 1 && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-4 left-1/2 flex max-w-[92vw] -translate-x-1/2 gap-2 overflow-x-auto rounded-lg bg-white/5 p-2 backdrop-blur-sm"
            >
              {images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Go to image ${i + 1}`}
                  aria-current={i === index}
                  onClick={() => onIndexChange(i)}
                  className={cn(
                    "h-12 w-16 shrink-0 overflow-hidden rounded-md ring-2 transition",
                    i === index ? "ring-white opacity-100" : "ring-transparent opacity-50 hover:opacity-90",
                  )}
                >
                  <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
                </button>
              ))}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
