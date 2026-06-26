/**
 * Importer: load the scraped uniliv.in catalogue into `properties`,
 * `property_photos`, and R2 object storage.
 * ------------------------------------------------------------------------------
 * Reads scripts/data/uniliv-properties.json (produced by scrape-uniliv.ts) and,
 * for each property:
 *
 *   1. UPSERTS the property — matched by portfolioAttributes->>'sourceUrl' so a
 *      re-run UPDATES the existing row instead of creating a duplicate. New rows
 *      get an auto-generated PROP-<CITY3>-<NNN> code (per-city sequence, the same
 *      scheme as routes/properties.ts generatePropertyCode).
 *   2. PHOTOS — fetches each image, putObject() to R2 under
 *      properties/<propertyId>/<index>-<basename>, and inserts a property_photos
 *      row (first image is the hero). An image whose sourceUrl already has a
 *      property_photos row is SKIPPED (idempotent). Each image is wrapped in its
 *      own try/catch so one bad URL never aborts the run.
 *
 * Idempotent + re-runnable: stable property match on sourceUrl, stable photo
 * skip on sourceUrl. Safe to run repeatedly.
 *
 * Run:  set -a; . ./.env; set +a
 *       pnpm --filter @workspace/scripts run import:uniliv
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, pool, propertiesTable, propertyPhotosTable } from "@workspace/db";
import { sql, ilike, eq } from "drizzle-orm";
import {
  putObject,
  isStorageConfigured,
  StorageNotConfiguredError,
} from "@workspace/storage";

/* ────────────────────────────────────────────────────────────────────────────
 * Types mirroring the scraped JSON shape.
 * ──────────────────────────────────────────────────────────────────────────── */
type ScrapedProperty = {
  name: string;
  city: string;
  citySlug: string;
  gender: string;
  title: string;
  address: string | null;
  lat: string | number | null;
  lng: string | number | null;
  mapsUrl: string | null;
  sourceUrl: string;
  priceRange: string[];
  sharingTypes: string[];
  amenities: string[];
  heroImage: string | null;
  images: string[];
};

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "uniliv-properties.json");

/** 3-letter uppercase abbrev of a city (letters only, padded) — mirrors routes/properties.ts. */
function cityAbbrev(city: string): string {
  const letters = (city || "").toUpperCase().replace(/[^A-Z]/g, "");
  return (letters.slice(0, 3) || "XXX").padEnd(3, "X");
}

/**
 * Generate a unique human-readable property code PROP-<CITY3>-<NNN>. Per-city
 * sequence = (count of existing codes for that city prefix) + 1, bumped until the
 * candidate is free. Mirrors generatePropertyCode() in routes/properties.ts.
 */
async function generatePropertyCode(city: string): Promise<string> {
  const prefix = `PROP-${cityAbbrev(city)}-`;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(propertiesTable)
    .where(ilike(propertiesTable.code, `${prefix}%`));
  let n = (row?.c ?? 0) + 1;
  for (let i = 0; i < 10000; i++) {
    const candidate = `${prefix}${String(n).padStart(3, "0")}`;
    const [hit] = await db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(eq(propertiesTable.code, candidate));
    if (!hit) return candidate;
    n++;
  }
  return `${prefix}${String(n).padStart(3, "0")}-${randomUUID().slice(0, 4)}`;
}

/** Map a city to its Indian state (covers the catalogue cities; fallback "Unknown"). */
function stateForCity(city: string): string {
  const c = (city || "").toLowerCase();
  if (c.includes("noida") || c.includes("greater noida")) return "Uttar Pradesh";
  if (c.includes("delhi")) return "Delhi";
  if (c.includes("gurgaon") || c.includes("gurugram")) return "Haryana";
  if (c.includes("jaipur")) return "Rajasthan";
  if (c.includes("bengaluru") || c.includes("bangalore")) return "Karnataka";
  return "Unknown";
}

/** Extract a 6-digit pincode from an address string, else null. */
function pincodeFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}

/** Parse lat/lng to a finite number or null. */
function toGeo(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map scraped gender → portfolioType (Coliving → CO_LIVING, else PG). */
function portfolioTypeForGender(gender: string): "CO_LIVING" | "PG" {
  return (gender || "").trim().toLowerCase() === "coliving" ? "CO_LIVING" : "PG";
}

/** Map scraped gender → portfolioAttributes.gender enum. */
function genderAttr(gender: string): "MALE" | "FEMALE" | "COED" {
  const g = (gender || "").trim().toLowerCase();
  if (g === "female") return "FEMALE";
  if (g === "male") return "MALE";
  return "COED";
}

/** Content-type from a file extension. */
function contentTypeFor(url: string): string {
  const ext = url.split("?")[0]!.split(".").pop()!.toLowerCase();
  switch (ext) {
    case "webp": return "image/webp";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "avif": return "image/avif";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

/** Last path segment of a URL (basename), sanitized for an object key. */
function basenameFor(url: string): string {
  const path = url.split("?")[0]!;
  const seg = path.split("/").pop() || "image";
  return seg.replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
}

/** Find an existing property id whose portfolioAttributes->>'sourceUrl' matches. */
async function findPropertyBySourceUrl(sourceUrl: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM properties WHERE portfolio_attributes->>'sourceUrl' = $1 LIMIT 1`,
    [sourceUrl],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * MAIN
 * ──────────────────────────────────────────────────────────────────────────── */
async function main() {
  console.log("📥 Importing uniliv.in catalogue → properties + property_photos + R2…");

  if (!isStorageConfigured()) {
    throw new StorageNotConfiguredError();
  }

  const raw = await readFile(DATA_FILE, "utf8");
  const catalogue = JSON.parse(raw) as ScrapedProperty[];
  console.log(`  • ${catalogue.length} properties in ${DATA_FILE}`);

  let propsCreated = 0;
  let propsUpdated = 0;
  let geoMissing = 0;
  let photosUploaded = 0;
  let photosSkipped = 0;
  let photosFailed = 0;

  for (const p of catalogue) {
    // ── 1. Upsert property (match by sourceUrl) ─────────────────────────────
    const existingId = await findPropertyBySourceUrl(p.sourceUrl);
    const propertyId = existingId ?? randomUUID();
    const isNew = !existingId;

    const lat = toGeo(p.lat);
    const lng = toGeo(p.lng);
    const hasGeo = lat !== null && lng !== null;
    if (!hasGeo) geoMissing++;

    // NOT NULL columns we default when the source lacks them:
    //   address  → falls back to title, then name (never null).
    //   state    → derived from city, else "Unknown".
    //   pincode  → extracted from address, else "000000".
    //   totalBeds→ 0 (bed inventory not in the scrape).
    const address = (p.address && p.address.trim()) || p.title || p.name;
    const state = stateForCity(p.city);
    const pincode = pincodeFromAddress(p.address) ?? "000000";
    const portfolioType = portfolioTypeForGender(p.gender);

    const portfolioAttributes = {
      gender: genderAttr(p.gender),
      sourceUrl: p.sourceUrl,
      priceRange: p.priceRange ?? [],
      sharingTypes: p.sharingTypes ?? [],
      amenities: p.amenities ?? [],
      importedFrom: "uniliv.in",
    };

    if (isNew) {
      const code = await generatePropertyCode(p.city);
      await db.insert(propertiesTable).values({
        id: propertyId,
        code,
        name: p.name,
        address,
        city: p.city,
        state,
        pincode,
        lat,
        lng,
        totalBeds: 0,
        status: "ACTIVE",
        portfolioType,
        portfolioAttributes,
        amenities: p.amenities ?? [],
        updatedAt: new Date(),
      });
      propsCreated++;
    } else {
      await db
        .update(propertiesTable)
        .set({
          name: p.name,
          address,
          city: p.city,
          state,
          pincode,
          lat,
          lng,
          portfolioType,
          portfolioAttributes,
          amenities: p.amenities ?? [],
          updatedAt: new Date(),
        })
        .where(eq(propertiesTable.id, propertyId));
      propsUpdated++;
    }

    // ── 2. Photos ────────────────────────────────────────────────────────────
    let upHere = 0;
    let skipHere = 0;
    let failHere = 0;
    const images = Array.isArray(p.images) ? p.images : [];
    for (let index = 0; index < images.length; index++) {
      const url = images[index]!;
      try {
        // Skip if a photo row already exists for this source URL (idempotent).
        const existingPhoto = await db
          .select({ id: propertyPhotosTable.id })
          .from(propertyPhotosTable)
          .where(eq(propertyPhotosTable.sourceUrl, url));
        if (existingPhoto.length) {
          skipHere++;
          continue;
        }

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = Buffer.from(await resp.arrayBuffer());
        const contentType =
          resp.headers.get("content-type")?.split(";")[0]?.trim() ||
          contentTypeFor(url);

        const key = `properties/${propertyId}/${index}-${basenameFor(url)}`;
        await putObject(key, bytes, contentType);

        await db.insert(propertyPhotosTable).values({
          id: randomUUID(),
          propertyId,
          storageKey: key,
          contentType,
          sourceUrl: url,
          isHero: index === 0,
          sortOrder: index,
        });
        upHere++;
      } catch (err) {
        failHere++;
        console.warn(
          `    ⚠ photo failed (${p.name} #${index}): ${url} — ${(err as Error).message}`,
        );
      }
    }
    photosUploaded += upHere;
    photosSkipped += skipHere;
    photosFailed += failHere;

    console.log(
      `  ✓ ${isNew ? "created" : "updated"} ${p.name} — photos: ${upHere} uploaded, ${skipHere} skipped` +
        `${failHere ? `, ${failHere} failed` : ""}; geo: ${hasGeo ? "yes" : "MISSING"}`,
    );
  }

  console.log("─".repeat(70));
  console.log(
    `✅ Import done — properties: ${propsCreated} created, ${propsUpdated} updated ` +
      `(${geoMissing} without geo); photos: ${photosUploaded} uploaded, ` +
      `${photosSkipped} skipped, ${photosFailed} failed.`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Import failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
