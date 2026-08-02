import { Router, json } from "express";
import { db } from "@workspace/db";
import { propertiesTable, residentsTable, usersTable, foodCutoffsTable, propertyPhotosTable } from "@workspace/db";
import { eq, sql, ilike, or, and, inArray, asc } from "drizzle-orm";
import { putObject, getObjectUrl, deleteObject, isStorageConfigured } from "@workspace/storage";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, assertPropertyAccess } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { resolveKitchenForPincode, isActiveBrand, resolveAccessiblePropertyIds } from "../lib/food-service.js";
import { writeAuditLog } from "../lib/wallet-service.js";

const router = Router();

/** Client-writable property columns (never id/createdAt/updatedAt). */
const PROPERTY_FIELDS = [
  "name",
  "address",
  "city",
  "state",
  "pincode",
  "lat",
  "lng",
  "totalBeds",
  "status",
  "portfolioType",
  "portfolioAttributes",
  "wardenId",
  "phone",
  "email",
  "amenities",
  "brand",
  "kitchenId",
  "code",
] as const;

/** Roles that can be tagged as a property's unit-lead in the property form. */
const UNIT_LEAD_ROLES = ["UNIT_LEAD", "WARDEN"] as const;

/** 3-letter uppercase abbrev of a city (letters only, padded). */
function cityAbbrev(city: string): string {
  const letters = (city || "").toUpperCase().replace(/[^A-Z]/g, "");
  return (letters.slice(0, 3) || "XXX").padEnd(3, "X");
}

/**
 * Generate a unique human-readable property code PROP-<CITY3>-<NNN>. The sequence
 * is per-city: next = (count of existing codes for that city prefix) + 1, then we
 * bump until the candidate is free (so collisions from manual/edited codes can't
 * produce a duplicate).
 */
async function generatePropertyCode(city: string): Promise<string> {
  const prefix = `PROP-${cityAbbrev(city)}-`;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(propertiesTable)
    .where(ilike(propertiesTable.code, `${prefix}%`));
  let n = (row?.c ?? 0) + 1;
  // Bump on collision (existing manual override could already hold the candidate).
  // Cap the loop defensively; 10k codes per city is far beyond realistic.
  for (let i = 0; i < 10000; i++) {
    const candidate = `${prefix}${String(n).padStart(3, "0")}`;
    const [hit] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.code, candidate));
    if (!hit) return candidate;
    n++;
  }
  // Fallback: suffix a short unique token if we somehow exhausted the range.
  return `${prefix}${String(n).padStart(3, "0")}-${newId().slice(0, 4)}`;
}

/**
 * Re-tag the given users as this property's unit-leads (users.propertyId). Only
 * UNIT_LEAD/WARDEN rows in the list are moved; ids of other roles are ignored.
 * We do NOT clear previously-tagged leads not in the list (additive tagging) to
 * keep behavior predictable and avoid surprising un-assignments.
 */
async function assignUnitLeads(propertyId: string, unitLeadIds: unknown): Promise<void> {
  if (!Array.isArray(unitLeadIds)) return;
  const ids = unitLeadIds.map((x) => String(x)).filter(Boolean);
  if (!ids.length) return;
  await db
    .update(usersTable)
    .set({ propertyId, updatedAt: new Date() })
    .where(and(inArray(usersTable.id, ids), inArray(usersTable.role, UNIT_LEAD_ROLES as unknown as never[])));
}

/**
 * Upsert the per-(brand, property) kitchen cut-off override from the property
 * form. Empty/undefined time → no-op (the brand/global default applies). Mirrors
 * the dedup logic in food-ops.ts cutoff-config (Postgres treats NULL as distinct,
 * but here propertyId is always set so the unique index covers it).
 */
async function upsertPropertyCutoff(propertyId: string, brand: string | null | undefined, cutoffTime: unknown): Promise<void> {
  if (cutoffTime === undefined) return; // field not present → don't touch
  const time = cutoffTime ? String(cutoffTime).trim() : "";
  if (!time) return; // empty → leave any existing override as-is
  if (!brand) return; // a property has one brand; without it there's nothing to key on
  if (!/^\d{1,2}:\d{2}$/.test(time)) return; // ignore malformed HH:MM silently
  const [existing] = await db
    .select({ id: foodCutoffsTable.id })
    .from(foodCutoffsTable)
    .where(and(eq(foodCutoffsTable.brand, brand), eq(foodCutoffsTable.propertyId, propertyId)));
  if (existing) {
    await db.update(foodCutoffsTable).set({ cutoffTime: time, isActive: true, updatedAt: new Date() }).where(eq(foodCutoffsTable.id, existing.id));
  } else {
    await db.insert(foodCutoffsTable).values({ id: newId(), brand, propertyId, cutoffTime: time, isActive: true, updatedAt: new Date() });
  }
}

/** Allowed image content-types and their canonical file extensions. */
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // ~8MB decoded

/**
 * Parse a base64 image data-URL (`data:image/png;base64,...`). Returns the decoded
 * Buffer + the normalized content-type/extension, or null if it isn't a valid,
 * allowed image within the size budget.
 */
function parseImageDataUrl(dataUrl: unknown): { buffer: Buffer; contentType: string; ext: string } | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) return null;
  const contentType = m[1]!.toLowerCase();
  const ext = IMAGE_EXT[contentType];
  if (!ext) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(m[2]!, "base64");
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) return null;
  return { buffer, contentType, ext };
}

/**
 * Resolve a presigned hero-image URL for a single property: the photo flagged
 * isHero, else the lowest sortOrder. Presigning is wrapped so a storage outage
 * degrades to null rather than throwing.
 */
async function heroImageUrlFor(propertyId: string): Promise<string | null> {
  if (!isStorageConfigured()) return null;
  const [photo] = await db
    .select({ storageKey: propertyPhotosTable.storageKey })
    .from(propertyPhotosTable)
    .where(eq(propertyPhotosTable.propertyId, propertyId))
    .orderBy(sql`${propertyPhotosTable.isHero} desc`, asc(propertyPhotosTable.sortOrder))
    .limit(1);
  if (!photo) return null;
  try {
    return await getObjectUrl(photo.storageKey);
  } catch {
    return null;
  }
}

/**
 * Batch hero-image lookup for a list of property ids (avoids N+1). One query
 * pulls every property's photos, we pick the hero (else lowest sortOrder) per
 * property, then presign each — presign failures degrade that entry to null.
 */
async function heroImageUrlMap(propertyIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!propertyIds.length || !isStorageConfigured()) return out;
  const rows = await db
    .select({
      propertyId: propertyPhotosTable.propertyId,
      storageKey: propertyPhotosTable.storageKey,
      isHero: propertyPhotosTable.isHero,
      sortOrder: propertyPhotosTable.sortOrder,
    })
    .from(propertyPhotosTable)
    .where(inArray(propertyPhotosTable.propertyId, propertyIds));

  // Reduce to the best (hero first, then lowest sortOrder) photo per property.
  const best: Record<string, { storageKey: string; isHero: boolean; sortOrder: number }> = {};
  for (const r of rows) {
    const cur = best[r.propertyId];
    const better =
      !cur ||
      (r.isHero && !cur.isHero) ||
      (r.isHero === cur.isHero && r.sortOrder < cur.sortOrder);
    if (better) best[r.propertyId] = { storageKey: r.storageKey, isHero: r.isHero, sortOrder: r.sortOrder };
  }

  await Promise.all(
    Object.entries(best).map(async ([propertyId, photo]) => {
      try {
        out[propertyId] = await getObjectUrl(photo.storageKey);
      } catch {
        out[propertyId] = null;
      }
    })
  );
  return out;
}

router.get("/", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;

    // Property-scoped callers (e.g. UNIT_LEAD / WARDEN) only see the properties
    // they're bound to — the same accessible set My Properties resolves. Org-wide
    // roles get null (no restriction). Mirrors GET /food/my-properties.
    const accessibleIds = await resolveAccessiblePropertyIds(req.user!);
    if (accessibleIds !== null && accessibleIds.length === 0) {
      res.json({ success: true, data: [], meta: buildMeta(0, page, limit) });
      return;
    }
    const conds = [
      accessibleIds !== null ? inArray(propertiesTable.id, accessibleIds) : undefined,
      search ? or(ilike(propertiesTable.name, `%${search}%`), ilike(propertiesTable.city, `%${search}%`)) : undefined,
    ].filter(Boolean);
    const where = conds.length ? and(...conds) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(propertiesTable).where(where);
    const rows = await db.select().from(propertiesTable).where(where).limit(limit).offset(offset).orderBy(propertiesTable.createdAt);

    const occupiedMap: Record<string, number> = {};
    await Promise.all(
      rows.map(async (row) => {
        const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));
        occupiedMap[row.id] = r.count || 0;
      })
    );

    // Batch the hero-image lookup for all listed properties (no N+1; storage
    // outages degrade heroImageUrl to null rather than failing the list).
    const heroMap = await heroImageUrlMap(rows.map((p) => p.id));

    res.json({
      success: true,
      data: rows.map(p => ({ ...p, occupiedBeds: occupiedMap[p.id] || 0, heroImageUrl: heroMap[p.id] ?? null })),
      meta: buildMeta(countResult.count, page, limit),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * Assignable unit-leads for the property form's multi-select. Returns UNIT_LEAD /
 * WARDEN users (id, name, email, role, current propertyId so the form can preselect
 * those already tagged to this property). Gated on PROPERTIES view since it's used
 * exclusively by the property add/edit form.
 */
router.get("/assignable-unit-leads", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, propertyId: usersTable.propertyId })
      .from(usersTable)
      .where(and(eq(usersTable.isActive, true), inArray(usersTable.role, UNIT_LEAD_ROLES as unknown as never[])))
      .orderBy(usersTable.name);
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("PROPERTIES", "create"), async (req, res) => {
  try {
    const body = pick(req.body, PROPERTY_FIELDS);

    // ── Food config: brand + kitchen are MANDATORY on create. ───────────────
    // "Without brand and kitchen we cannot create a property" (Persona/admin).
    const brand = body.brand ? String(body.brand).trim() : "";
    if (!brand) {
      res.status(400).json({ success: false, error: "Brand is required." });
      return;
    }
    if (!(await isActiveBrand(brand))) {
      res.status(400).json({ success: false, error: "Unknown or inactive brand." });
      return;
    }
    // Kitchen is auto-derived from the pincode server-side — never trust the
    // client's kitchenId. We re-derive it and require an exact match (so a
    // tampered/stale kitchenId is rejected rather than silently persisted).
    const kitchen = await resolveKitchenForPincode(String(body.pincode ?? ""));
    if (!kitchen) {
      res.status(400).json({ success: false, error: "No kitchen serves this pincode. Change the pincode or contact an admin." });
      return;
    }
    const clientKitchenId = body.kitchenId ? String(body.kitchenId).trim() : "";
    if (!clientKitchenId) {
      res.status(400).json({ success: false, error: "Kitchen is required." });
      return;
    }
    if (clientKitchenId !== kitchen.id) {
      res.status(400).json({ success: false, error: "Kitchen does not match the kitchen mapped to this pincode." });
      return;
    }

    // Property code: use the provided override (editable) if non-empty, else
    // auto-generate PROP-<CITY3>-<NNN> with a per-city sequence (unique-checked).
    const providedCode = body.code ? String(body.code).trim() : "";
    const code = providedCode || (await generatePropertyCode(String(body.city ?? "")));

    const newPropertyId = newId();
    const [row] = await db.insert(propertiesTable).values({
      id: newPropertyId,
      code,
      name: body.name,
      address: body.address,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      lat: body.lat,
      lng: body.lng,
      totalBeds: body.totalBeds,
      status: body.status || "ACTIVE",
      portfolioType: body.portfolioType || "CO_LIVING",
      portfolioAttributes: body.portfolioAttributes || {},
      wardenId: body.wardenId,
      phone: body.phone,
      email: body.email,
      amenities: body.amenities || [],
      brand,
      kitchenId: kitchen.id,
      updatedAt: new Date(),
    }).returning();

    // Tag unit-leads to this property and upsert its kitchen cut-off override.
    await assignUnitLeads(newPropertyId, req.body?.unitLeadIds);
    await upsertPropertyCutoff(newPropertyId, brand, req.body?.cutoffTime);

    res.status(201).json({ success: true, data: { ...row, occupiedBeds: 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    // Property-scoped callers may only open a property in their accessible set.
    const accessibleIds = await resolveAccessiblePropertyIds(req.user!);
    if (accessibleIds !== null && !accessibleIds.includes(req.params["id"]!)) {
      res.status(403).json({ success: false, error: "Outside your property scope" });
      return;
    }
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));

    // Form prefill helpers: the unit-leads currently tagged to this property and
    // the per-(brand, property) kitchen cut-off override (if any).
    const unitLeadIds = (await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.propertyId, row.id), inArray(usersTable.role, UNIT_LEAD_ROLES as unknown as never[]))))
      .map((u) => u.id);
    let cutoffTime: string | null = null;
    if (row.brand) {
      const [c] = await db
        .select({ cutoffTime: foodCutoffsTable.cutoffTime })
        .from(foodCutoffsTable)
        .where(and(eq(foodCutoffsTable.brand, row.brand), eq(foodCutoffsTable.propertyId, row.id)));
      cutoffTime = c?.cutoffTime ?? null;
    }

    const heroImageUrl = await heroImageUrlFor(row.id);

    res.json({ success: true, data: { ...row, occupiedBeds: r.count || 0, unitLeadIds, cutoffTime, heroImageUrl } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("PROPERTIES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, PROPERTY_FIELDS);

    const [existing] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, req.params["id"]!));
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // Property code is editable. An empty string clears nothing meaningful, so we
    // drop a blank value (keeps the existing code) and trim a provided one.
    if (body.code !== undefined) {
      const code = body.code ? String(body.code).trim() : "";
      if (!code) delete body.code; else body.code = code;
    }

    // Brand is freely editable, but if supplied it must be a known active brand.
    if (body.brand !== undefined) {
      const brand = body.brand ? String(body.brand).trim() : "";
      if (!brand || !(await isActiveBrand(brand))) {
        res.status(400).json({ success: false, error: "Unknown or inactive brand." });
        return;
      }
      body.brand = brand;
    }

    // Kitchen is auto-derived from pincode. When the pincode changes (or a
    // kitchenId is supplied), re-derive server-side and validate — the client's
    // kitchenId is never trusted. A pincode with no mapped kitchen is rejected.
    const pincodeChanged = body.pincode !== undefined && String(body.pincode) !== String(existing.pincode);
    if (pincodeChanged || body.kitchenId !== undefined) {
      const pincode = body.pincode !== undefined ? String(body.pincode) : String(existing.pincode);
      const kitchen = await resolveKitchenForPincode(pincode);
      if (!kitchen) {
        res.status(400).json({ success: false, error: "No kitchen serves this pincode. Change the pincode or contact an admin." });
        return;
      }
      if (body.kitchenId !== undefined && String(body.kitchenId).trim() !== kitchen.id) {
        res.status(400).json({ success: false, error: "Kitchen does not match the kitchen mapped to this pincode." });
        return;
      }
      body.kitchenId = kitchen.id; // always persist the server-derived kitchen
    } else {
      // No pincode/kitchen change in this request — don't touch the column.
      delete body.kitchenId;
    }

    const [row] = await db.update(propertiesTable).set({ ...body, updatedAt: new Date() }).where(eq(propertiesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // Audit (fire-and-forget): a status change (e.g. ACTIVE↔INACTIVE) is a
    // compliance-relevant event, logged distinctly with old/new values.
    if (body.status !== undefined && row.status !== existing.status) {
      void writeAuditLog(req.user!.id, "PROPERTY_STATUS_CHANGED", "property", row.id, {
        oldStatus: existing.status, newStatus: row.status, name: row.name, code: row.code,
      }).catch(() => {});
    }

    // Re-tag unit-leads and upsert the cut-off override (brand = the just-saved value).
    await assignUnitLeads(row.id, req.body?.unitLeadIds);
    await upsertPropertyCutoff(row.id, row.brand, req.body?.cutoffTime);

    const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.propertyId, row.id));
    res.json({ success: true, data: { ...row, occupiedBeds: r.count || 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("PROPERTIES", "delete"), async (req, res) => {
  try {
    const propertyId = req.params["id"]!;
    const [existing] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));
    // Audit (fire-and-forget) — capture identifying fields before they're gone.
    void writeAuditLog(req.user!.id, "PROPERTY_DELETED", "property", propertyId, {
      name: existing?.name ?? null, code: existing?.code ?? null, city: existing?.city ?? null, status: existing?.status ?? null,
    }).catch(() => {});
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─── Property photos ──────────────────────────────────────────────────────
// Large image uploads arrive as base64 data-URLs which exceed the small global
// body limit, so the POST route mounts its OWN express.json({limit}) parser.

/** Load a property (id only) or send 404. Returns null after responding. */
async function loadPropertyOr404(propertyId: string, res: import("express").Response): Promise<{ id: string } | null> {
  const [prop] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  if (!prop) {
    res.status(404).json({ success: false, error: "Property not found" });
    return null;
  }
  return prop;
}

/** Render a thrown authz/validation error (403/400) or fall through. */
function sendAuthzError(err: any, res: import("express").Response): boolean {
  if (err?.statusCode === 403 || err?.statusCode === 400) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return true;
  }
  return false;
}

router.get("/:id/photos", authenticate, authorize("PROPERTIES", "view"), async (req, res) => {
  try {
    const propertyId = req.params["id"]!;
    const prop = await loadPropertyOr404(propertyId, res);
    if (!prop) return;
    assertPropertyAccess(req, propertyId);

    const rows = await db
      .select()
      .from(propertyPhotosTable)
      .where(eq(propertyPhotosTable.propertyId, propertyId))
      .orderBy(asc(propertyPhotosTable.sortOrder));

    const data = await Promise.all(
      rows.map(async (p) => {
        let url: string | null = null;
        try {
          url = isStorageConfigured() ? await getObjectUrl(p.storageKey) : null;
        } catch {
          url = null;
        }
        return { id: p.id, url, caption: p.caption, isHero: p.isHero, sortOrder: p.sortOrder };
      })
    );

    res.json({ success: true, data });
  } catch (err: any) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post(
  "/:id/photos",
  authenticate,
  authorize("PROPERTIES", "edit"),
  // Route-LOCAL parser: the global body limit is small; images need headroom.
  json({ limit: "12mb" }),
  async (req, res) => {
    try {
      if (!isStorageConfigured()) {
        res.status(503).json({ success: false, error: "Photo storage is not configured." });
        return;
      }
      const propertyId = req.params["id"]!;
      const prop = await loadPropertyOr404(propertyId, res);
      if (!prop) return;
      assertPropertyAccess(req, propertyId);

      const parsed = parseImageDataUrl(req.body?.dataUrl);
      if (!parsed) {
        res.status(400).json({ success: false, error: "dataUrl must be a base64 image (jpeg/png/webp/gif) under 8MB." });
        return;
      }
      const caption = req.body?.caption != null ? String(req.body.caption) : null;
      const isHero = req.body?.isHero === true;

      const key = `properties/${propertyId}/${newId()}.${parsed.ext}`;
      await putObject(key, parsed.buffer, parsed.contentType);

      const row = await db.transaction(async (tx) => {
        if (isHero) {
          await tx
            .update(propertyPhotosTable)
            .set({ isHero: false })
            .where(eq(propertyPhotosTable.propertyId, propertyId));
        }
        const [{ max }] = await tx
          .select({ max: sql<number>`coalesce(max(${propertyPhotosTable.sortOrder}), -1)::int` })
          .from(propertyPhotosTable)
          .where(eq(propertyPhotosTable.propertyId, propertyId));
        const [inserted] = await tx
          .insert(propertyPhotosTable)
          .values({
            id: newId(),
            propertyId,
            storageKey: key,
            contentType: parsed.contentType,
            caption,
            isHero,
            sortOrder: (max ?? -1) + 1,
          })
          .returning();
        return inserted!;
      });

      let url: string | null = null;
      try {
        url = await getObjectUrl(row.storageKey);
      } catch {
        url = null;
      }

      res.status(201).json({
        success: true,
        data: { id: row.id, url, caption: row.caption, isHero: row.isHero, sortOrder: row.sortOrder },
      });
    } catch (err: any) {
      if (sendAuthzError(err, res)) return;
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

router.patch("/:id/photos/:photoId", authenticate, authorize("PROPERTIES", "edit"), async (req, res) => {
  try {
    const propertyId = req.params["id"]!;
    const photoId = req.params["photoId"]!;
    const prop = await loadPropertyOr404(propertyId, res);
    if (!prop) return;
    assertPropertyAccess(req, propertyId);

    const [existing] = await db
      .select()
      .from(propertyPhotosTable)
      .where(and(eq(propertyPhotosTable.id, photoId), eq(propertyPhotosTable.propertyId, propertyId)));
    if (!existing) {
      res.status(404).json({ success: false, error: "Photo not found" });
      return;
    }

    const patch: { isHero?: boolean; sortOrder?: number; caption?: string | null } = {};
    if (req.body?.isHero !== undefined) patch.isHero = req.body.isHero === true;
    if (req.body?.sortOrder !== undefined) {
      const n = Number(req.body.sortOrder);
      if (!Number.isFinite(n)) {
        res.status(400).json({ success: false, error: "sortOrder must be a number." });
        return;
      }
      patch.sortOrder = Math.trunc(n);
    }
    if (req.body?.caption !== undefined) patch.caption = req.body.caption != null ? String(req.body.caption) : null;

    if (Object.keys(patch).length === 0) {
      res.json({ success: true, data: { id: existing.id, caption: existing.caption, isHero: existing.isHero, sortOrder: existing.sortOrder } });
      return;
    }

    const row = await db.transaction(async (tx) => {
      // Setting this photo as hero clears the flag on the property's other photos.
      if (patch.isHero === true) {
        await tx
          .update(propertyPhotosTable)
          .set({ isHero: false })
          .where(eq(propertyPhotosTable.propertyId, propertyId));
      }
      const [updated] = await tx
        .update(propertyPhotosTable)
        .set(patch)
        .where(eq(propertyPhotosTable.id, photoId))
        .returning();
      return updated!;
    });

    res.json({ success: true, data: { id: row.id, caption: row.caption, isHero: row.isHero, sortOrder: row.sortOrder } });
  } catch (err: any) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id/photos/:photoId", authenticate, authorize("PROPERTIES", "edit"), async (req, res) => {
  try {
    const propertyId = req.params["id"]!;
    const photoId = req.params["photoId"]!;
    const prop = await loadPropertyOr404(propertyId, res);
    if (!prop) return;
    assertPropertyAccess(req, propertyId);

    const [existing] = await db
      .select()
      .from(propertyPhotosTable)
      .where(and(eq(propertyPhotosTable.id, photoId), eq(propertyPhotosTable.propertyId, propertyId)));
    if (!existing) {
      res.status(404).json({ success: false, error: "Photo not found" });
      return;
    }

    // Best-effort object delete; a storage failure must not block removing the row.
    try {
      await deleteObject(existing.storageKey);
    } catch (e) {
      req.log.error(e);
    }
    await db.delete(propertyPhotosTable).where(eq(propertyPhotosTable.id, photoId));

    res.json({ success: true, message: "Deleted" });
  } catch (err: any) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
