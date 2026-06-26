/**
 * scrape-uniliv.ts — Pull Uniliv's live property catalogue + photos from the public
 * marketing site (uniliv.in) into scripts/data/uniliv-properties.json, which the
 * importer (import-uniliv-properties.ts) then loads into the DB + R2.
 *
 * The property URL list below was derived from the site's "Our Homes" nav
 * (city pages -> property cards). The script re-fetches each detail page LIVE so
 * address / coordinates / price / amenities / photos stay current; only the URL
 * set is pinned (the property roster changes rarely). Re-run to refresh:
 *   pnpm --filter @workspace/scripts run scrape:uniliv
 *
 * Authorised scrape: uniliv.in is the operator's own marketing site.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Seed = { name: string; city: string; citySlug: string; gender: string; detailUrl: string; mapsUrl: string | null; thumb: string };

// Roster captured from the city pages under uniliv.in "Our Homes".
const SEED: Seed[] = [
  // Noida
  { name: "Huddle Stays Vega", city: "Noida", citySlug: "noida", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-noida-sector-104/", mapsUrl: "https://maps.app.goo.gl/UBkLg3uGrh6aL7nf7", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-vega-card-thumbnail.webp" },
  { name: "Huddle Stays Aries", city: "Noida", citySlug: "noida", gender: "Coliving", detailUrl: "https://uniliv.in/coliving-pg-in-noida-sector-104/", mapsUrl: "https://maps.app.goo.gl/452AhuXiBa8tGwP66", thumb: "https://uniliv.in/wp-content/uploads/2025/09/huddle-stays-aries-card-thumbnail.jpeg" },
  // New Delhi
  { name: "Huddle Stays Atlas", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/premium-boys-pg-in-rohini-sector-16/", mapsUrl: "https://maps.app.goo.gl/nCRbgV9emjYBizbMA", thumb: "https://uniliv.in/wp-content/uploads/2026/03/Huddle-stays-atlas-thumbnail-1.jpg" },
  { name: "Uniliv Cedar", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/premium-girls-pg-in-rajouri-garden/", mapsUrl: null, thumb: "https://uniliv.in/wp-content/uploads/2026/06/uniliv-cedar-card-thumbnaill.webp" },
  { name: "Uniliv Oak", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/pg-in-saket-oak-house/", mapsUrl: "https://maps.app.goo.gl/SAeGXC4bevCR4QYs5", thumb: "https://uniliv.in/wp-content/uploads/2025/07/uniliv-oak-card-thumbnail.webp" },
  { name: "Uniliv Aspen", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-vikram-vihar-delhi/", mapsUrl: "https://maps.app.goo.gl/SZjK4drBRjkTgi7U8", thumb: "https://uniliv.in/wp-content/uploads/2025/07/uniliv-aspen-card-thumbnail.webp" },
  { name: "Huddle Stays Boys", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-saket-delhi-near-shaheed-bhagat-singh-college/", mapsUrl: "https://maps.app.goo.gl/QN7fA1jaWcHwvR3g7", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-saket-card-thumbnail.webp" },
  { name: "Huddle Stays Nova", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/best-girls-pg-in-saiyad-ul-ajaib-saket/", mapsUrl: "https://maps.app.goo.gl/tN9c4JYZu7ckbBBYA", thumb: "https://uniliv.in/wp-content/uploads/2025/07/Huddle-Stays-Nova-card-thumbnail.webp" },
  { name: "Uniliv Birch", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-shakti-nagar/", mapsUrl: "https://maps.app.goo.gl/iqBPdzt26WHDiELh7", thumb: "https://uniliv.in/wp-content/uploads/2026/04/uniliv-birch-card-thumbnaill.png" },
  { name: "Huddle Stays Astra", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-kamla-nagar/", mapsUrl: "https://maps.app.goo.gl/x8T3m4vqjwJQ9z1H9", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-astra-card-thumbnail.webp" },
  { name: "Uniliv Clove", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-rajouri-garden-delhi/", mapsUrl: "https://maps.app.goo.gl/LQYwbw4jV8xGZMKp7", thumb: "https://uniliv.in/wp-content/uploads/2026/06/uniliv-clove-card-thumbnail-1.webp" },
  { name: "Uniliv Pine", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-nehru-enclave-delhi/", mapsUrl: null, thumb: "https://uniliv.in/wp-content/uploads/2025/07/Uniliv-Pine-card-thumbnail-1.webp" },
  { name: "Huddle Stays Nash", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-rohini-sector-16/", mapsUrl: "https://maps.app.goo.gl/4Re2bAn4BUofEkKe9", thumb: "https://uniliv.in/wp-content/uploads/2025/07/Huddle-stays-nash-card-thumbnail.webp" },
  { name: "Huddle Stays Virgo", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-vijay-nagar-new-delhi/", mapsUrl: "https://maps.app.goo.gl/BavTs43omAVnR1Et8", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-virgo-card-thumbnail.webp" },
  { name: "Uniliv Hemlock", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/premium-girls-pg-in-vijay-nagar/", mapsUrl: "https://maps.app.goo.gl/CWEe6zT9QuUBmqEF8", thumb: "https://uniliv.in/wp-content/uploads/2025/07/uniliv-hemlock-header.webp" },
  { name: "Huddle Stays Castor", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-maidan-garhi-new-delhi/", mapsUrl: "https://maps.app.goo.gl/cGjQtQMbwMDs56kz9", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-juniper-card-thumbnail.webp" },
  { name: "Huddle Stays Cosmo", city: "New Delhi", citySlug: "delhi", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-khirki-extension/", mapsUrl: "https://maps.app.goo.gl/zF2CHXTELqT7kZ2w7", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-cosmo-card-thumbnail.png" },
  { name: "Huddle Stays Zeta", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-zamrudpur-greater-kailash/", mapsUrl: "https://maps.app.goo.gl/QNmW8BwJz9gzFqaUA", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-zeta-card-thumbnail.webp" },
  { name: "Uniliv Elm", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-kailash-colony-delhi/", mapsUrl: "https://maps.app.goo.gl/rDH3nhMtceeQ9DFS8", thumb: "https://uniliv.in/wp-content/uploads/2025/07/uniliv-elm-card-thumbnail-1.webp" },
  { name: "Uniliv Juniper", city: "New Delhi", citySlug: "delhi", gender: "Female", detailUrl: "https://uniliv.in/girls-pg-in-satya-niketan/", mapsUrl: "https://maps.app.goo.gl/cGjQtQMbwMDs56kz9", thumb: "https://uniliv.in/wp-content/uploads/2025/10/uniliv-juniper-image-1-1.jpg" },
  // Bengaluru
  { name: "Uniliv Banyan", city: "Bengaluru", citySlug: "bengaluru", gender: "Coliving", detailUrl: "https://uniliv.in/coliving-pg-in-sg-palya-bengaluru/", mapsUrl: "https://maps.app.goo.gl/TpuisxJmuozC4GRD7", thumb: "https://uniliv.in/wp-content/uploads/2025/09/compressed-uniliv-banyan-header-thumbnail.webp" },
  // Greater Noida
  { name: "Uniliv Olive", city: "Greater Noida", citySlug: "greater-noida", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-knowledge-park-3-greater-noida/", mapsUrl: "https://maps.app.goo.gl/XSRq9W4mVNq5Zd1e8", thumb: "https://uniliv.in/wp-content/uploads/2026/06/uniliv-olive-card-thumbnail.webp" },
  // Gurgaon
  { name: "Huddle Stays Gurgaon", city: "Gurgaon", citySlug: "gurgaon", gender: "Female", detailUrl: "https://uniliv.in/huddle-stays/", mapsUrl: "https://maps.app.goo.gl/SSNzZxYnQLiT6XpM6", thumb: "https://uniliv.in/wp-content/uploads/2025/07/huddle-stays-gurgaon-card-thumbnail-1.webp" },
  // Jaipur
  { name: "Uniliv Spruce", city: "Jaipur", citySlug: "jaipur", gender: "Male", detailUrl: "https://uniliv.in/boys-pg-in-sitapura-jaipur/", mapsUrl: "https://maps.app.goo.gl/ScYzK6MJhk2PGY3L8", thumb: "https://uniliv.in/wp-content/uploads/2026/06/Uniliv-spruce-card-thumbnaill.webp" },
];

const GENERIC = /footer|masking|background|delhi-university|join-us|two\.jpg|banner-bg|whatsapp|partner|press-|testimonial|google-review|play-store|app-store|-collage|amenit|icon-|placeholder|favicon/i;
const AMENITY_WORDS = ["WiFi", "Meals", "Food", "Laundry", "Housekeeping", "AC", "Power Backup", "Security", "CCTV", "Parking", "Gym", "Common Area", "Refrigerator", "RO Water", "Hot Water", "Washing Machine", "Fully Furnished", "Daily Cleaning"];
const SHARING_WORDS = ["Single", "Double", "Triple", "Quadruple", "Twin Sharing", "Dormitory"];

function walkLd(roots: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const w = (o: unknown) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { o.forEach(w); return; }
    const obj = o as Record<string, unknown>;
    flat.push(obj);
    if (obj["@graph"]) w(obj["@graph"]);
    for (const v of Object.values(obj)) if (v && typeof v === "object") w(v);
  };
  roots.forEach(w);
  return flat;
}

function stripSize(u: string): string {
  return u.replace(/-\d+x\d+(\.\w+)(\?.*)?$/, "$1");
}

async function scrapeDetail(seed: Seed) {
  let html = "";
  try {
    const res = await fetch(seed.detailUrl, { headers: { "User-Agent": "Mozilla/5.0 UnilivAdminImporter/1.0" } });
    html = await res.text();
  } catch (e) {
    return {
      name: seed.name, city: seed.city, citySlug: seed.citySlug, gender: seed.gender,
      title: null as string | null, address: null as string | null, lat: null as string | null, lng: null as string | null,
      mapsUrl: seed.mapsUrl, sourceUrl: seed.detailUrl,
      priceRange: [] as string[], sharingTypes: [] as string[], amenities: [] as string[],
      heroImage: seed.thumb as string | null, images: [] as string[], error: `fetch failed: ${(e as Error).message}`,
    };
  }

  // JSON-LD: address + geo
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
  const flat = walkLd(ldBlocks);
  const addrNode = flat.find((o) => o["address"]);
  let address: string | null = null;
  if (addrNode) {
    const a = addrNode["address"] as Record<string, string> | string;
    address = typeof a === "string" ? a : [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(", ");
  }
  const geoNode = flat.find((o) => o["geo"] && ((o["geo"] as Record<string, unknown>).latitude || (o["geo"] as Record<string, unknown>).longitude)) || flat.find((o) => o["latitude"] && o["longitude"]);
  let lat: string | null = null, lng: string | null = null;
  if (geoNode) {
    const g = (geoNode["geo"] as Record<string, unknown>) || geoNode;
    lat = g["latitude"] != null ? String(g["latitude"]) : null;
    lng = g["longitude"] != null ? String(g["longitude"]) : null;
  }
  if (lat == null) {
    const m = html.match(/!3d(-?\d+\.\d{3,})!4d(-?\d+\.\d{3,})/) || html.match(/@(-?\d+\.\d{3,}),(-?\d+\.\d{3,})/);
    if (m) { lat = m[1]; lng = m[2]; }
  }

  // images
  const rawImgs = [...html.matchAll(/https:\/\/uniliv\.in\/wp-content\/uploads\/[^\s"'\\)]+?\.(?:jpe?g|png|webp)/gi)].map((m) => stripSize(m[0]));
  const images = [...new Set(rawImgs.filter((s) => !GENERIC.test(s)))];

  // price / amenities / sharing from raw text
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");
  const priceRange = [...new Set((text.match(/₹\s?[\d,]{3,}/g) || []).map((s) => s.replace(/\s/g, "")))].slice(0, 8);
  const amenities = AMENITY_WORDS.filter((wd) => new RegExp(wd.replace(/ /g, "\\s*"), "i").test(text));
  const sharingTypes = SHARING_WORDS.filter((wd) => new RegExp("\\b" + wd, "i").test(text));
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);

  const ordered = [seed.thumb, ...images].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  return {
    name: seed.name, city: seed.city, citySlug: seed.citySlug, gender: seed.gender,
    title: titleMatch ? titleMatch[1].trim() : null,
    address, lat, lng, mapsUrl: seed.mapsUrl, sourceUrl: seed.detailUrl,
    priceRange, sharingTypes, amenities,
    heroImage: seed.thumb || ordered[0] || null,
    images: ordered.slice(0, 20),
  };
}

async function main() {
  console.log(`Scraping ${SEED.length} Uniliv properties from uniliv.in ...`);
  const out: Awaited<ReturnType<typeof scrapeDetail>>[] = [];
  for (const seed of SEED) {
    const r = await scrapeDetail(seed);
    const imgs = r.images.length;
    const coords = r.lat ? "geo" : "no-geo";
    console.log(`  • ${seed.city.padEnd(13)} ${seed.name.padEnd(22)} ${String(imgs).padStart(2)} imgs  ${coords}${r.error ? "  ⚠ " + r.error : ""}`);
    out.push(r);
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "../data/uniliv-properties.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  const withGeo = out.filter((p) => p.lat).length;
  const totalImgs = out.reduce((a, p) => a + p.images.length, 0);
  console.log(`\nWrote ${out.length} properties (${withGeo} with coords, ${totalImgs} images) -> ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
