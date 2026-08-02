/**
 * Canvas image helpers for audit evidence capture — generalized from the
 * downscale logic in property-photos-manager (left untouched to avoid
 * regressions). All outputs are JPEG data URLs sized to stay comfortably
 * under the API's body-parser caps.
 */

/**
 * Read a picked image File into a downscaled JPEG data URL (max edge
 * `maxEdge`px). Falls back to the raw FileReader data URL if canvas decoding
 * fails (e.g. an unsupported format).
 */
export async function fileToDownscaledDataUrl(
  file: File,
  maxEdge = 1600,
  quality = 0.82,
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
  try {
    const img = await loadImage(rawDataUrl);
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return rawDataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return rawDataUrl;
  }
}

export interface VideoFrameOptions {
  /** Lines drawn onto a semi-transparent strip at the bottom of the frame. */
  watermarkLines?: string[];
  maxEdge?: number;
  quality?: number;
}

/**
 * Grab the current frame of a playing `<video>` into a JPEG data URL,
 * optionally stamping watermark lines (timestamp / GPS / auditor) onto a
 * semi-transparent black strip along the bottom edge.
 */
export function videoFrameToDataUrl(
  video: HTMLVideoElement,
  { watermarkLines, maxEdge = 1600, quality = 0.82 }: VideoFrameOptions = {},
): string {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(1, maxEdge / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(video, 0, 0, w, h);
  drawWatermark(ctx, w, h, watermarkLines);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Bottom watermark strip: semi-transparent black rect + 12px white mono lines. */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lines: string[] | undefined,
): void {
  const visible = (lines ?? []).filter(Boolean);
  if (visible.length === 0) return;
  const lineHeight = 16;
  const padding = 8;
  const stripHeight = visible.length * lineHeight + padding * 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, height - stripHeight, width, stripHeight);
  ctx.fillStyle = "#ffffff";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  visible.forEach((line, i) => {
    ctx.fillText(line, padding, height - stripHeight + padding + i * lineHeight, width - padding * 2);
  });
}

/** Downscale an existing data URL into a small JPEG thumbnail (max edge 320px). */
export async function thumbnailFromDataUrl(dataUrl: string, maxEdge = 320): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.75);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image"));
    el.src = src;
  });
}
