import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";

/**
 * Bidirectional geocoding (forward: address → lat/lon, reverse: lat/lon → address).
 *
 * Provider-swappable: the active provider is read from process.env.GEOCODE_PROVIDER
 * (default "nominatim"). Today only OpenStreetMap / Nominatim is wired — it's free
 * and needs no API key. To swap in Mappls / Google later, add a branch in the two
 * provider helpers below (forwardGeocode / reverseGeocode) keyed on PROVIDER; the
 * route handlers and the client contract stay unchanged.
 *
 * Nominatim usage policy: max 1 request/second, and a valid User-Agent identifying
 * the app is REQUIRED (requests without one are blocked). We keep a tiny in-memory
 * LRU-ish cache to avoid re-hitting the API for repeated identical lookups (e.g. a
 * user toggling the form open/closed); it is best-effort only, not a rate limiter.
 */

const PROVIDER = process.env["GEOCODE_PROVIDER"] || "nominatim";

// Nominatim requires a descriptive UA with contact info (per its usage policy).
const USER_AGENT = "UnilivAdmin/1.0 (ops@uniliv.com)";

export interface ForwardResult {
  lat: number;
  lon: number;
  displayName: string;
}
export interface ReverseResult {
  displayName: string;
  address: string;
  pincode: string;
}

// ── Tiny in-memory cache (best-effort; capped so it can't grow unbounded). ──────
const CACHE_MAX = 200;
const cache = new Map<string, unknown>();
function cacheGet<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}
function cacheSet(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

// ── Provider helpers ────────────────────────────────────────────────────────────
// Each returns the parsed shape or null on no-match. Upstream/network errors throw
// and are turned into a 502 by the handlers (we never crash the process).

async function forwardGeocode(q: string): Promise<ForwardResult | null> {
  if (PROVIDER === "nominatim") {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) throw new Error(`Nominatim forward ${resp.status}`);
    const json = (await resp.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const hit = Array.isArray(json) ? json[0] : undefined;
    if (!hit || hit.lat === undefined || hit.lon === undefined) return null;
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    return { lat, lon, displayName: hit.display_name || "" };
  }
  // Unknown provider configured — treat as not-implemented rather than crash.
  throw new Error(`Unsupported GEOCODE_PROVIDER: ${PROVIDER}`);
}

async function reverseGeocode(lat: number, lon: number): Promise<ReverseResult | null> {
  if (PROVIDER === "nominatim") {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}`;
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) throw new Error(`Nominatim reverse ${resp.status}`);
    const json = (await resp.json()) as {
      display_name?: string;
      address?: Record<string, string> & { postcode?: string };
    };
    if (!json || !json.display_name) return null;
    const addr = json.address || {};
    // Build a readable single-line address from the most useful parts, falling
    // back to display_name. postcode is surfaced separately so the form can fill
    // its pincode field.
    const parts = [
      addr["road"],
      addr["neighbourhood"] || addr["suburb"],
      addr["city"] || addr["town"] || addr["village"] || addr["county"],
      addr["state"],
    ].filter(Boolean);
    const formatted = parts.length ? parts.join(", ") : json.display_name;
    return { displayName: json.display_name, address: formatted, pincode: addr.postcode || "" };
  }
  throw new Error(`Unsupported GEOCODE_PROVIDER: ${PROVIDER}`);
}

const router = Router();

// GET /geocode/forward?q=<address text> → { lat, lon, displayName } | 404
router.get("/forward", authenticate, async (req, res) => {
  const q = String(req.query["q"] ?? "").trim();
  if (!q) {
    res.status(400).json({ success: false, error: "q is required" });
    return;
  }
  const cacheKey = `f:${q.toLowerCase()}`;
  const cached = cacheGet<ForwardResult>(cacheKey);
  if (cached) {
    res.json({ success: true, data: cached });
    return;
  }
  try {
    const result = await forwardGeocode(q);
    if (!result) {
      res.status(404).json({ success: false, error: "No match for that address" });
      return;
    }
    cacheSet(cacheKey, result);
    res.json({ success: true, data: result });
  } catch (err) {
    req.log.error(err);
    // Upstream/provider failure — never crash; signal a bad-gateway upstream error.
    res.status(502).json({ success: false, error: "Geocoding provider unavailable" });
  }
});

// GET /geocode/reverse?lat=&lon= → { displayName, address, pincode } | 404
router.get("/reverse", authenticate, async (req, res) => {
  const lat = Number(req.query["lat"]);
  const lon = Number(req.query["lon"]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ success: false, error: "lat and lon are required" });
    return;
  }
  const cacheKey = `r:${lat},${lon}`;
  const cached = cacheGet<ReverseResult>(cacheKey);
  if (cached) {
    res.json({ success: true, data: cached });
    return;
  }
  try {
    const result = await reverseGeocode(lat, lon);
    if (!result) {
      res.status(404).json({ success: false, error: "No address for those coordinates" });
      return;
    }
    cacheSet(cacheKey, result);
    res.json({ success: true, data: result });
  } catch (err) {
    req.log.error(err);
    res.status(502).json({ success: false, error: "Geocoding provider unavailable" });
  }
});

export default router;
