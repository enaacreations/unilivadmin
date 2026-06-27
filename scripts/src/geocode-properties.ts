/**
 * Geocode seeded properties to rooftop/locality-accurate coordinates.
 * ------------------------------------------------------------------------------
 * The uniliv.in-IMPORTED properties already carry accurate coordinates (kept
 * untouched). The SEEDED properties were given their city centre + a small
 * jitter, so their map pins land in the right city but not the right locality.
 *
 * This script forward-geocodes each seeded property's real address via Nominatim
 * (the same provider the app's /geocode endpoint uses) and updates lat/lng when a
 * confident, nearby match is found. Imported rows (portfolioAttributes->>'sourceUrl'
 * is set) are NEVER touched.
 *
 * Safety:
 *   - Dry-run by default; pass --apply to write.
 *   - India-restricted query + a distance guard: a geocode result further than
 *     MAX_KM from the property's current (city-centre) pin is rejected, so a bad
 *     match can never fling a pin to another city.
 *   - Nominatim usage policy honoured: 1 request/second, descriptive User-Agent.
 *
 * Targets whichever DB `DATABASE_URL` points at — run it against local first.
 *
 * Run (local):
 *   set -a; . ./.env; set +a
 *   pnpm --filter @workspace/scripts run geocode:properties            # dry-run
 *   pnpm --filter @workspace/scripts run geocode:properties -- --apply  # write
 *
 * Run (prod): export DATABASE_URL=<prod-url> before the command above.
 */
import { db, pool, propertiesTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const USER_AGENT = "UnilivAdmin/1.0 (ops@uniliv.com)";
/** Reject a geocode result further than this from the current (city-centre) pin. */
const MAX_KM = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Forward { lat: number; lon: number; displayName: string }

async function forwardGeocode(q: string): Promise<Forward | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
  const json = (await resp.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const hit = Array.isArray(json) ? json[0] : undefined;
  if (!hit || hit.lat === undefined || hit.lon === undefined) return null;
  const lat = Number(hit.lat), lon = Number(hit.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon, displayName: hit.display_name || "" };
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

const fmt = (lat: number | null, lng: number | null) =>
  lat == null || lng == null ? "—" : `${lat.toFixed(5)},${lng.toFixed(5)}`;

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: propertiesTable.id,
      name: propertiesTable.name,
      address: propertiesTable.address,
      city: propertiesTable.city,
      state: propertiesTable.state,
      lat: propertiesTable.lat,
      lng: propertiesTable.lng,
      sourceUrl: sql<string | null>`${propertiesTable.portfolioAttributes}->>'sourceUrl'`,
    })
    .from(propertiesTable)
    .orderBy(propertiesTable.city, propertiesTable.name);

  const seeded = rows.filter((r) => !r.sourceUrl);
  const imported = rows.length - seeded.length;
  console.log(
    `\nMode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}  ·  ` +
    `${rows.length} properties — ${imported} imported (kept), ${seeded.length} seeded (geocoding)\n`,
  );

  let updated = 0, kept = 0, errors = 0;
  for (const p of seeded) {
    const q = [p.address, p.city, p.state].filter(Boolean).join(", ");
    let res: Forward | null = null;
    try {
      res = await forwardGeocode(q);
    } catch (e) {
      errors++;
      console.log(`  !  ${p.name} (${p.city}): geocode error — ${(e as Error).message}; keep ${fmt(p.lat, p.lng)}`);
      await sleep(1100);
      continue;
    }
    await sleep(1100); // Nominatim: max 1 request/second

    if (!res) {
      kept++;
      console.log(`  -  ${p.name} (${p.city}): no match; keep ${fmt(p.lat, p.lng)}`);
      continue;
    }
    const dist = p.lat != null && p.lng != null ? haversineKm(p.lat, p.lng, res.lat, res.lon) : 0;
    if (p.lat != null && dist > MAX_KM) {
      kept++;
      console.log(`  x  ${p.name} (${p.city}): match ${dist.toFixed(0)}km away — reject; keep ${fmt(p.lat, p.lng)}`);
      continue;
    }
    updated++;
    console.log(
      `  ✓  ${p.name} (${p.city}): ${fmt(p.lat, p.lng)} → ${res.lat.toFixed(5)},${res.lon.toFixed(5)} ` +
      `(${dist.toFixed(1)}km) · ${res.displayName.slice(0, 64)}`,
    );
    if (APPLY) {
      await db.update(propertiesTable)
        .set({ lat: res.lat, lng: res.lon, updatedAt: new Date() })
        .where(eq(propertiesTable.id, p.id));
    }
  }

  console.log(
    `\n${APPLY ? "Updated" : "Would update"} ${updated} · kept ${kept}` +
    `${errors ? ` · ${errors} errors` : ""} · ${imported} imported untouched\n`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
