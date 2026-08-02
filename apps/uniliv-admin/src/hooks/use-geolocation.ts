import * as React from "react";

export type GeolocationStatus =
  | "idle"
  | "locating"
  | "ready"
  | "denied"
  | "timeout"
  | "unsupported";

export interface GeoPosition {
  lat: number;
  lng: number;
  accuracyM: number;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 60_000,
};

/**
 * One-shot geolocation attempt as a promise. Resolves null on denial/timeout/
 * unsupported — callers that treat GPS as optional (audit start/submit) just
 * proceed without coordinates.
 */
export function locateOnce(): Promise<GeoPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        }),
      () => resolve(null),
      GEO_OPTIONS,
    );
  });
}

/**
 * Reactive geolocation for capture flows: `locate()` starts a high-accuracy
 * getCurrentPosition (10s timeout, 60s cache); `status` distinguishes denial
 * from timeout so the UI can instruct accordingly.
 */
export function useGeolocation({ immediate = false }: { immediate?: boolean } = {}) {
  const [status, setStatus] = React.useState<GeolocationStatus>("idle");
  const [position, setPosition] = React.useState<GeoPosition | null>(null);

  const locate = React.useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unsupported");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        });
        setStatus("ready");
      },
      (err) => {
        setPosition(null);
        setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "timeout");
      },
      GEO_OPTIONS,
    );
  }, []);

  React.useEffect(() => {
    if (immediate) locate();
  }, [immediate, locate]);

  return { status, position, locate };
}
