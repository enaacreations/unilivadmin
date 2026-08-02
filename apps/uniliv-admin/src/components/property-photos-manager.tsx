import * as React from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { foodApi, foodKeys } from "@/lib/food-api";
import {
  getGetPropertiesQueryKey,
  getGetPropertyQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { FileUpload } from "@/components/ui/file-upload";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Image as ImageIcon, Star, Trash2 } from "lucide-react";
import { ImageLightbox } from "@/components/image-lightbox";

// Read a picked image File into a downscaled JPEG data URL kept comfortably under
// the global body-parser ~1mb cap (max edge 1600px, quality 0.82). Falls back to a
// raw FileReader data URL if canvas decoding fails (e.g. unsupported format).
async function fileToDownscaledDataUrl(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode image"));
      el.src = rawDataUrl;
    });
    const MAX_EDGE = 1600;
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return rawDataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return rawDataUrl;
  }
}

// Reusable property-photos management component — gallery + upload + hero/delete
// controls. Edit-only (needs an existing property id). Callers supply their own
// spacing/border via `className`.
export function PropertyPhotosManager({
  propertyId,
  className,
}: {
  propertyId: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  const { data: photos = [], isLoading } = useQuery({
    queryKey: foodKeys.propertyPhotos(propertyId),
    queryFn: () => foodApi.listPropertyPhotos(propertyId),
  });

  const urls = React.useMemo(
    () => photos.filter((p) => p.url).map((p) => p.url) as string[],
    [photos],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: foodKeys.propertyPhotos(propertyId) });
    // Hero changes the property's heroImageUrl on list/detail payloads.
    queryClient.invalidateQueries({ queryKey: getGetPropertiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPropertyQueryKey(propertyId) });
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      await foodApi.createPropertyPhoto(propertyId, {
        dataUrl,
        isHero: photos.length === 0, // first photo becomes the hero by default
      });
      toast({ title: "Photo uploaded" });
      invalidate();
    } catch (e: any) {
      toast({ title: e?.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const setHero = async (photoId: string) => {
    setBusyId(photoId);
    try {
      await foodApi.updatePropertyPhoto(propertyId, photoId, { isHero: true });
      invalidate();
    } catch (e: any) {
      toast({ title: e?.message || "Failed to set hero", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const removePhoto = async (photoId: string) => {
    setBusyId(photoId);
    try {
      await foodApi.deletePropertyPhoto(propertyId, photoId);
      toast({ title: "Photo deleted" });
      invalidate();
    } catch (e: any) {
      toast({ title: e?.message || "Failed to delete", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={className}>
      <Label className="flex items-center gap-1.5 mb-2">
        <ImageIcon className="w-4 h-4" /> Photos
      </Label>
      <FileUpload
        accept="image/jpeg,image/png,image/webp,image/gif"
        onFileSelect={handleFile}
        label={uploading ? "Uploading…" : "Click or drag an image here to upload"}
        subtext="JPEG, PNG, WebP or GIF. Large images are downscaled automatically."
        data-testid="upload-property-photo"
      />
      {isLoading ? (
        <p className="text-xs text-muted-foreground mt-3">Loading photos…</p>
      ) : photos.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-3">No photos yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 mt-3">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className={`group relative aspect-video overflow-hidden rounded-lg border bg-surface${photo.url ? " cursor-zoom-in" : ""}`}
              data-testid={`property-photo-${photo.id}`}
              onClick={
                photo.url
                  ? () => {
                      const idx = urls.indexOf(photo.url!);
                      if (idx >= 0) setLightboxIndex(idx);
                    }
                  : undefined
              }
            >
              {photo.url ? (
                <img
                  src={photo.url}
                  alt={photo.caption || "Property photo"}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-6 w-6" />
                </div>
              )}
              {photo.isHero && (
                <Badge className="absolute left-1.5 top-1.5 gap-1 bg-accent text-white">
                  <Star className="h-3 w-3 fill-current" /> Hero
                </Badge>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                {!photo.isHero && (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="h-7 w-7"
                    disabled={busyId === photo.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setHero(photo.id);
                    }}
                    aria-label="Set as hero"
                    data-testid={`button-set-hero-${photo.id}`}
                  >
                    <Star className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="h-7 w-7 text-destructive"
                  disabled={busyId === photo.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    removePhoto(photo.id);
                  }}
                  aria-label="Delete photo"
                  data-testid={`button-delete-photo-${photo.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ImageLightbox
        images={urls}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  );
}
