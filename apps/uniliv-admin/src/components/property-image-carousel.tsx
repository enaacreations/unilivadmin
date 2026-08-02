import * as React from "react";
import { Image as ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";

/**
 * Read-only image carousel for property photos.
 *
 * - empty   -> sizing box with a centered placeholder icon
 * - 1 image -> the single image, no arrows / no dots
 * - 2+      -> embla carousel with hover arrows + dot indicators
 *
 * `fit="contain"` shows the whole image (letterboxed on a muted backdrop) at the
 * box height — good for a detail viewer where you don't want a tall, cropped hero.
 * `fit="cover"` (default) fills the box — good for card banners.
 * Pass `onImageClick` to make images open a lightbox (adds a zoom cursor).
 */
export function PropertyImageCarousel({
  images,
  alt = "Property photo",
  aspectClassName = "aspect-[16/7]",
  fit = "cover",
  onImageClick,
  className,
}: {
  images: string[];
  alt?: string;
  aspectClassName?: string;
  fit?: "cover" | "contain";
  onImageClick?: (index: number) => void;
  className?: string;
}): React.JSX.Element {
  const [api, setApi] = React.useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  React.useEffect(() => {
    if (!api) return;
    const onSelect = () => setSelectedIndex(api.selectedScrollSnap());
    onSelect();
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api]);

  const wrapperClass = cn("overflow-hidden rounded-lg bg-surface", className);

  // A single image cell — handles cover/contain fit + optional click-to-zoom.
  const cell = (src: string, i: number) => (
    <div
      className={cn(
        aspectClassName,
        "w-full",
        fit === "contain" && "flex items-center justify-center bg-muted/30",
        onImageClick && "cursor-zoom-in",
      )}
      onClick={onImageClick ? () => onImageClick(i) : undefined}
    >
      <img
        src={src}
        alt={`${alt} ${i + 1}`}
        draggable={false}
        className={fit === "contain" ? "max-h-full max-w-full object-contain" : "h-full w-full object-cover"}
      />
    </div>
  );

  // Empty -> placeholder
  if (images.length === 0) {
    return (
      <div className={wrapperClass}>
        <div className={cn(aspectClassName, "flex w-full items-center justify-center text-muted-foreground")}>
          <ImageIcon className="h-7 w-7" />
        </div>
      </div>
    );
  }

  // Single image -> no controls
  if (images.length === 1) {
    return <div className={wrapperClass}>{cell(images[0], 0)}</div>;
  }

  // Multiple images -> carousel with arrows + dots
  return (
    <div className={cn("group relative", wrapperClass)}>
      <Carousel setApi={setApi} opts={{ loop: true }} className="w-full">
        <CarouselContent className="ml-0">
          {images.map((src, i) => (
            <CarouselItem key={i} className="pl-0">
              {cell(src, i)}
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>

      {/* Edge-centered prev/next — reveal on hover, subtle translucent pill */}
      <button
        type="button"
        aria-label="Previous image"
        onClick={() => api?.scrollPrev()}
        className="absolute left-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100 hover:bg-black/55 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Next image"
        onClick={() => api?.scrollNext()}
        className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100 hover:bg-black/55 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-1.5">
        {images.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Go to image ${i + 1}`}
            aria-current={i === selectedIndex}
            onClick={() => api?.scrollTo(i)}
            className={cn(
              "pointer-events-auto h-1.5 rounded-full transition-all",
              i === selectedIndex ? "w-4 bg-white" : "w-1.5 bg-white/60 hover:bg-white/80",
            )}
          />
        ))}
      </div>
    </div>
  );
}
