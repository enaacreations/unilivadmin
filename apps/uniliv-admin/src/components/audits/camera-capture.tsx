import * as React from "react";
import { Camera, CameraOff, Check, Loader2, MapPin, MapPinOff, RotateCcw, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useGeolocation, type GeoPosition } from "@/hooks/use-geolocation";
import {
  drawWatermark, fileToDownscaledDataUrl, thumbnailFromDataUrl, videoFrameToDataUrl,
} from "@/lib/image";

export interface CaptureMeta {
  /** ISO timestamp taken at the moment of capture. */
  capturedAt: string;
  geo: GeoPosition | null;
  source: "live-camera" | "file";
}

export interface CameraCaptureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** submission-proof = GPS mandatory, no file fallback (D-9 / FRD-EXE-13). */
  purpose: "evidence" | "submission-proof";
  auditorName: string;
  onCapture: (dataUrl: string, thumbDataUrl: string, meta: CaptureMeta) => void | Promise<void>;
}

function istTimestamp(d = new Date()): string {
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

function geoLine(position: GeoPosition | null): string {
  if (!position) return "no location";
  return `${position.lat.toFixed(5)},${position.lng.toFixed(5)} ±${Math.round(position.accuracyM)}m`;
}

/**
 * Full-screen live camera capture with timestamp/GPS/auditor watermarking.
 * `purpose="submission-proof"` blocks the shutter until GPS is locked and
 * never renders a gallery fallback; `purpose="evidence"` treats GPS as
 * optional and offers an "Upload file" fallback (marked isLiveCapture=false
 * by the caller via meta.source).
 */
export function CameraCapture({
  open, onOpenChange, purpose, auditorName, onCapture,
}: CameraCaptureProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [cameraState, setCameraState] = React.useState<"starting" | "live" | "denied" | "error">("starting");
  const [preview, setPreview] = React.useState<{ dataUrl: string; meta: CaptureMeta } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const { status: geoStatus, position, locate } = useGeolocation();

  const fakeCaptureEnabled =
    import.meta.env.DEV && typeof localStorage !== "undefined" &&
    localStorage.getItem("FAKE_CAPTURE") === "1";

  const stopStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startStream = React.useCallback(async () => {
    stopStream();
    setCameraState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraState("live");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setCameraState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
    }
  }, [stopStream]);

  // Open → start camera + GPS; close/unmount → stop tracks (NFR hygiene).
  React.useEffect(() => {
    if (!open) return;
    setPreview(null);
    setBusy(false);
    void startStream();
    locate();
    return () => stopStream();
  }, [open, startStream, locate, stopStream]);

  // Re-attach the stream if the <video> mounts after getUserMedia resolves.
  React.useEffect(() => {
    if (cameraState === "live" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraState, preview]);

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video) return;
    const capturedAt = new Date();
    const dataUrl = videoFrameToDataUrl(video, {
      watermarkLines: [istTimestamp(capturedAt), geoLine(position), auditorName],
    });
    setPreview({
      dataUrl,
      meta: { capturedAt: capturedAt.toISOString(), geo: position, source: "live-camera" },
    });
  };

  /** DEV-only: synthesizes a frame + fixed geo so flows run without hardware. */
  const takeTestFrame = () => {
    const capturedAt = new Date();
    const fakeGeo: GeoPosition = { lat: 12.9716, lng: 77.5946, accuracyM: 5 };
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#111827";
    ctx.font = "bold 24px ui-monospace, monospace";
    ctx.fillText("TEST FRAME", 220, 220);
    ctx.font = "16px ui-monospace, monospace";
    ctx.fillText(capturedAt.toISOString(), 140, 260);
    drawWatermark(ctx, 640, 480, [istTimestamp(capturedAt), geoLine(fakeGeo), auditorName]);
    setPreview({
      dataUrl: canvas.toDataURL("image/jpeg", 0.82),
      meta: { capturedAt: capturedAt.toISOString(), geo: fakeGeo, source: "live-camera" },
    });
  };

  const confirmPhoto = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const thumb = await thumbnailFromDataUrl(preview.dataUrl);
      await onCapture(preview.dataUrl, thumb, preview.meta);
      onOpenChange(false);
    } catch {
      // onCapture failed (e.g. policy 422) — the caller has surfaced the
      // error; stay open so the user can retake or retry.
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      const thumb = await thumbnailFromDataUrl(dataUrl);
      await onCapture(dataUrl, thumb, {
        capturedAt: new Date().toISOString(),
        geo: position,
        source: "file",
      });
      onOpenChange(false);
    } catch {
      // Caller surfaced the error; keep the dialog open.
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const needsGps = purpose === "submission-proof";
  const gpsReady = geoStatus === "ready" && position != null;
  const shutterDisabled = cameraState !== "live" || (needsGps && !gpsReady);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 left-0 top-0 flex flex-col gap-0 rounded-none border-0 bg-black p-0 text-white [&>button]:text-white">
        <DialogTitle className="sr-only">
          {purpose === "submission-proof" ? "Submission proof photo" : "Capture evidence"}
        </DialogTitle>

        {/* Status bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 pr-12">
          <p className="text-sm font-medium">
            {purpose === "submission-proof" ? "Live submission proof" : "Capture evidence"}
          </p>
          {gpsReady ? (
            <Badge className="border-transparent bg-emerald-500/20 text-emerald-300">
              <MapPin className="mr-1 h-3 w-3" /> {geoLine(position)}
            </Badge>
          ) : geoStatus === "locating" ? (
            <Badge className="border-transparent bg-amber-500/20 text-amber-300">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Locating…
            </Badge>
          ) : (
            <Badge className="border-transparent bg-white/10 text-white/70">
              <MapPinOff className="mr-1 h-3 w-3" /> no location
            </Badge>
          )}
        </div>

        {/* Viewport */}
        <div className="relative flex-1 overflow-hidden">
          {preview ? (
            <img src={preview.dataUrl} alt="Captured frame" className="h-full w-full object-contain" />
          ) : cameraState === "denied" || cameraState === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
              <CameraOff className="h-10 w-10 text-white/60" />
              <div className="space-y-1">
                <p className="font-medium">
                  {cameraState === "denied" ? "Camera permission denied" : "Camera unavailable"}
                </p>
                <p className="max-w-sm text-sm text-white/60">
                  {cameraState === "denied"
                    ? "Allow camera access for this site in your browser settings, then retry."
                    : "The camera could not be started on this device."}
                </p>
              </div>
              <Button variant="secondary" className="min-h-11" onClick={() => void startStream()}>
                <RotateCcw className="mr-2 h-4 w-4" /> Retry
              </Button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              {cameraState === "starting" && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Controls */}
        <div className="space-y-3 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {preview ? (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                className="min-h-11 flex-1 max-w-40"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                <RotateCcw className="mr-2 h-4 w-4" /> Retake
              </Button>
              <Button className="min-h-11 flex-1 max-w-40" disabled={busy} onClick={confirmPhoto}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Use photo
              </Button>
            </div>
          ) : (
            <>
              {needsGps && !gpsReady && (
                <p className="text-center text-sm text-amber-300">
                  {geoStatus === "denied"
                    ? "Location permission denied — submission proof requires GPS."
                    : "Waiting for GPS…"}
                  {geoStatus !== "locating" && (
                    <Button
                      variant="link"
                      size="sm"
                      className="ml-1 h-auto p-0 text-amber-300 underline"
                      onClick={locate}
                    >
                      Retry
                    </Button>
                  )}
                </p>
              )}
              <div className="flex items-center justify-center gap-4">
                <Button
                  size="lg"
                  className="h-16 w-16 rounded-full border-4 border-white/40 bg-white text-black hover:bg-white/90"
                  disabled={shutterDisabled || busy}
                  onClick={takePhoto}
                  aria-label="Take photo"
                >
                  <Camera className="h-6 w-6" />
                </Button>
              </div>
              <div className="flex items-center justify-center gap-3">
                {purpose === "evidence" && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-white/70 hover:bg-white/10 hover:text-white"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-2 h-4 w-4" /> Upload file
                    </Button>
                  </>
                )}
                {fakeCaptureEnabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 text-white/70 hover:bg-white/10 hover:text-white"
                    disabled={busy}
                    onClick={takeTestFrame}
                  >
                    Use test frame
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
