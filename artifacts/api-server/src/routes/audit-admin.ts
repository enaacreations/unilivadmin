/**
 * Audit & Inspection — admin console routes (PRD §8.8 Settings, OE-only).
 * Role grants (access runtime), rating scales, performance bands and the
 * slim module-settings editor. Every mutation is recorded via
 * writeConfigChange into the hash-chained trail (immutable-logs NFR).
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditAppSettingsTable,
  auditPerformanceBandsTable,
  auditRatingOptionsTable,
  auditRatingScalesTable,
  auditRoleGrantsTable,
  usersTable,
  zonesTable,
  citiesTable,
  clustersTable,
  propertiesTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { httpError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { writeConfigChange } from "../lib/audit-events.js";
import { auditActor } from "../lib/audit-service.js";

const router: IRouter = Router();

/* ── Role grants (FR-AD-01, FRD-ACC-02/05) ─────────────────────────────────── */

const AUDIT_TYPES = ["UL", "CM", "CX"] as const;
const MODULE_ROLES = ["ADMIN", "SCHEDULER", "AUDITOR", "AUDITEE", "REVIEWER", "VIEWER"] as const;
const SCOPE_LEVELS = ["GLOBAL", "ZONE", "CITY", "CLUSTER", "PROPERTY"] as const;

const grantSchema = z.object({
  userId: z.string().min(1),
  moduleRole: z.enum(MODULE_ROLES),
  auditTypes: z.array(z.enum(AUDIT_TYPES)).min(1),
  scopeLevel: z.enum(SCOPE_LEVELS),
  zoneId: z.string().nullish(),
  cityId: z.string().nullish(),
  clusterId: z.string().nullish(),
  propertyId: z.string().nullish(),
  effectiveFrom: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullish(),
});

/** The org-node id column that must be present for each scope level. */
const SCOPE_NODE_FIELD: Record<string, "zoneId" | "cityId" | "clusterId" | "propertyId" | null> = {
  GLOBAL: null,
  ZONE: "zoneId",
  CITY: "cityId",
  CLUSTER: "clusterId",
  PROPERTY: "propertyId",
};

function validateGrantNode(g: z.infer<typeof grantSchema>): string | null {
  const field = SCOPE_NODE_FIELD[g.scopeLevel];
  if (field && !g[field]) return `scopeLevel ${g.scopeLevel} requires ${field}`;
  return null;
}

router.get(
  "/grants",
  authenticate,
  authorize("AUDIT_ADMIN", "view"),
  async (req, res) => {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const userId = req.query["userId"] as string | undefined;
    const activeOnly = req.query["active"] === "true";

    const conditions = [];
    if (userId) conditions.push(eq(auditRoleGrantsTable.userId, userId));
    if (activeOnly) {
      const now = new Date();
      conditions.push(
        isNull(auditRoleGrantsTable.revokedAt),
        lte(auditRoleGrantsTable.effectiveFrom, now),
        or(
          isNull(auditRoleGrantsTable.expiresAt),
          gte(auditRoleGrantsTable.expiresAt, now),
        ),
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditRoleGrantsTable)
      .where(where);
    const rows = await db
      .select({
        grant: auditRoleGrantsTable,
        userName: usersTable.name,
        userEmail: usersTable.email,
        userRole: usersTable.role,
      })
      .from(auditRoleGrantsTable)
      .leftJoin(usersTable, eq(usersTable.id, auditRoleGrantsTable.userId))
      .where(where)
      .orderBy(desc(auditRoleGrantsTable.grantedAt))
      .limit(limit)
      .offset(offset);

    res.json({
      success: true,
      data: rows.map((r) => ({ ...r.grant, userName: r.userName, userEmail: r.userEmail, userRole: r.userRole })),
      meta: buildMeta(countRow?.count ?? 0, page, limit),
    });
  },
);

router.post(
  "/grants",
  authenticate,
  authorize("AUDIT_ADMIN", "create"),
  async (req, res) => {
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) {
      throw httpError(400, "Invalid grant", parsed.error.flatten());
    }
    const nodeError = validateGrantNode(parsed.data);
    if (nodeError) throw httpError(400, nodeError);

    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, parsed.data.userId));
    if (!user) throw httpError(404, "User not found");

    const actor = auditActor(req);
    const grant = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(auditRoleGrantsTable)
        .values({
          id: newId(),
          userId: parsed.data.userId,
          moduleRole: parsed.data.moduleRole,
          auditTypes: parsed.data.auditTypes,
          scopeLevel: parsed.data.scopeLevel,
          zoneId: parsed.data.zoneId ?? null,
          cityId: parsed.data.cityId ?? null,
          clusterId: parsed.data.clusterId ?? null,
          propertyId: parsed.data.propertyId ?? null,
          effectiveFrom: parsed.data.effectiveFrom ?? new Date(),
          expiresAt: parsed.data.expiresAt ?? null,
          grantedBy: actor.id,
        })
        .returning();
      await writeConfigChange(tx, {
        entityType: "GRANT",
        entityId: row!.id,
        actorId: actor.id,
        actorRole: actor.role,
        before: null,
        after: row,
        kind: "GRANT_CHANGE",
      });
      return row!;
    });
    res.status(201).json({ success: true, data: grant });
  },
);

router.post(
  "/grants/:id/revoke",
  authenticate,
  authorize("AUDIT_ADMIN", "edit"),
  async (req, res) => {
    const [existing] = await db
      .select()
      .from(auditRoleGrantsTable)
      .where(eq(auditRoleGrantsTable.id, req.params["id"] as string));
    if (!existing) throw httpError(404, "Grant not found");
    if (existing.revokedAt) throw httpError(409, "Grant already revoked");

    const actor = auditActor(req);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(auditRoleGrantsTable)
        .set({ revokedAt: new Date(), revokedBy: actor.id })
        .where(eq(auditRoleGrantsTable.id, existing.id))
        .returning();
      await writeConfigChange(tx, {
        entityType: "GRANT",
        entityId: existing.id,
        actorId: actor.id,
        actorRole: actor.role,
        before: existing,
        after: row,
        reason: (req.body?.reason as string) ?? null,
        kind: "GRANT_CHANGE",
      });
      return row!;
    });
    res.json({ success: true, data: updated });
  },
);

/**
 * Org nodes for the grant editor (zone/city/cluster/property pickers) —
 * gated on AUDIT_ADMIN rather than coupling the audit UI to food-module
 * permissions.
 */
router.get(
  "/org-nodes",
  authenticate,
  authorize("AUDIT_ADMIN", "view"),
  async (_req, res) => {
    const [zones, cities, clusters, properties] = await Promise.all([
      db.select({ id: zonesTable.id, name: zonesTable.name }).from(zonesTable).orderBy(zonesTable.name),
      db.select({ id: citiesTable.id, name: citiesTable.name, zoneId: citiesTable.zoneId }).from(citiesTable).orderBy(citiesTable.name),
      db.select({ id: clustersTable.id, name: clustersTable.name, cityId: clustersTable.cityId }).from(clustersTable).orderBy(clustersTable.name),
      db.select({ id: propertiesTable.id, name: propertiesTable.name, clusterId: propertiesTable.clusterId }).from(propertiesTable).orderBy(propertiesTable.name),
    ]);
    res.json({ success: true, data: { zones, cities, clusters, properties } });
  },
);

/* ── Rating scales (FR-AD-02) ──────────────────────────────────────────────── */

const scaleOptionSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(60),
  color: z.string().max(30).nullish(),
  orderIndex: z.number().int().min(0),
  multiplierPct: z.number().min(0).max(100),
  isExcludedNa: z.boolean().optional(),
});
const scaleSchema = z.object({
  name: z.string().min(1).max(100),
  active: z.boolean().optional(),
  options: z.array(scaleOptionSchema).min(2),
});

router.get(
  "/rating-scales",
  authenticate,
  authorize("AUDIT_ADMIN", "view"),
  async (_req, res) => {
    const scales = await db.select().from(auditRatingScalesTable);
    const options = await db
      .select()
      .from(auditRatingOptionsTable)
      .orderBy(auditRatingOptionsTable.orderIndex);
    res.json({
      success: true,
      data: scales.map((s) => ({
        ...s,
        options: options.filter((o) => o.scaleId === s.id),
      })),
    });
  },
);

router.post(
  "/rating-scales",
  authenticate,
  authorize("AUDIT_ADMIN", "create"),
  async (req, res) => {
    const parsed = scaleSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid rating scale", parsed.error.flatten());

    const actor = auditActor(req);
    const created = await db.transaction(async (tx) => {
      const [scale] = await tx
        .insert(auditRatingScalesTable)
        .values({ id: newId(), name: parsed.data.name, active: parsed.data.active ?? true })
        .returning();
      const options = [];
      for (const o of parsed.data.options) {
        const [row] = await tx
          .insert(auditRatingOptionsTable)
          .values({
            id: newId(),
            scaleId: scale!.id,
            label: o.label,
            color: o.color ?? null,
            orderIndex: o.orderIndex,
            multiplierPct: String(o.multiplierPct),
            isExcludedNa: o.isExcludedNa ?? false,
          })
          .returning();
        options.push(row!);
      }
      await writeConfigChange(tx, {
        entityType: "RATING_SCALE",
        entityId: scale!.id,
        actorId: actor.id,
        actorRole: actor.role,
        before: null,
        after: { ...scale, options },
      });
      return { ...scale!, options };
    });
    res.status(201).json({ success: true, data: created });
  },
);

/**
 * Replace a scale's metadata + full option set. Published template versions
 * are unaffected — they snapshot their scale at publish (FRD-TLB-03).
 */
router.put(
  "/rating-scales/:id",
  authenticate,
  authorize("AUDIT_ADMIN", "edit"),
  async (req, res) => {
    const parsed = scaleSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid rating scale", parsed.error.flatten());

    const scaleId = req.params["id"] as string;
    const [existing] = await db
      .select()
      .from(auditRatingScalesTable)
      .where(eq(auditRatingScalesTable.id, scaleId));
    if (!existing) throw httpError(404, "Rating scale not found");
    const existingOptions = await db
      .select()
      .from(auditRatingOptionsTable)
      .where(eq(auditRatingOptionsTable.scaleId, scaleId));

    const actor = auditActor(req);
    const updated = await db.transaction(async (tx) => {
      const [scale] = await tx
        .update(auditRatingScalesTable)
        .set({ name: parsed.data.name, active: parsed.data.active ?? existing.active, updatedAt: new Date() })
        .where(eq(auditRatingScalesTable.id, scaleId))
        .returning();
      await tx.delete(auditRatingOptionsTable).where(eq(auditRatingOptionsTable.scaleId, scaleId));
      const options = [];
      for (const o of parsed.data.options) {
        const [row] = await tx
          .insert(auditRatingOptionsTable)
          .values({
            id: o.id ?? newId(),
            scaleId,
            label: o.label,
            color: o.color ?? null,
            orderIndex: o.orderIndex,
            multiplierPct: String(o.multiplierPct),
            isExcludedNa: o.isExcludedNa ?? false,
          })
          .returning();
        options.push(row!);
      }
      await writeConfigChange(tx, {
        entityType: "RATING_SCALE",
        entityId: scaleId,
        actorId: actor.id,
        actorRole: actor.role,
        before: { ...existing, options: existingOptions },
        after: { ...scale, options },
      });
      return { ...scale!, options };
    });
    res.json({ success: true, data: updated });
  },
);

/* ── Performance bands (FRD-ADM-02) ────────────────────────────────────────── */

const bandsSchema = z.object({
  bands: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        minPct: z.number().min(0).max(100),
        maxPct: z.number().min(0).max(100),
        color: z.string().max(30).nullish(),
      }),
    )
    .min(1),
});

router.get(
  "/performance-bands",
  authenticate,
  authorize("AUDIT_ADMIN", "view"),
  async (_req, res) => {
    const rows = await db
      .select()
      .from(auditPerformanceBandsTable)
      .orderBy(auditPerformanceBandsTable.orderIndex);
    res.json({ success: true, data: rows });
  },
);

/** Replace the full band set. Validates contiguous, non-overlapping, 0–100. */
router.put(
  "/performance-bands",
  authenticate,
  authorize("AUDIT_ADMIN", "edit"),
  async (req, res) => {
    const parsed = bandsSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid bands", parsed.error.flatten());

    const sorted = [...parsed.data.bands].sort((a, b) => a.minPct - b.minPct);
    for (const b of sorted) {
      if (b.minPct > b.maxPct) throw httpError(422, `Band "${b.label}": min > max`);
    }
    if (sorted[0]!.minPct !== 0) throw httpError(422, "Bands must start at 0%");
    if (sorted[sorted.length - 1]!.maxPct !== 100) throw httpError(422, "Bands must end at 100%");
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.minPct - sorted[i - 1]!.maxPct;
      if (gap <= 0) throw httpError(422, `Bands "${sorted[i - 1]!.label}" and "${sorted[i]!.label}" overlap`);
      if (gap > 0.01000001) throw httpError(422, `Gap between "${sorted[i - 1]!.label}" and "${sorted[i]!.label}" — bands must be contiguous (next min = prev max + 0.01)`);
    }

    const existing = await db.select().from(auditPerformanceBandsTable);
    const actor = auditActor(req);
    const saved = await db.transaction(async (tx) => {
      await tx.delete(auditPerformanceBandsTable);
      const rows = [];
      for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i]!;
        const [row] = await tx
          .insert(auditPerformanceBandsTable)
          .values({
            id: newId(),
            label: b.label,
            minPct: String(b.minPct),
            maxPct: String(b.maxPct),
            color: b.color ?? null,
            orderIndex: i,
          })
          .returning();
        rows.push(row!);
      }
      await writeConfigChange(tx, {
        entityType: "PERFORMANCE_BANDS",
        entityId: "bands",
        actorId: actor.id,
        actorRole: actor.role,
        before: existing,
        after: rows,
      });
      return rows;
    });
    res.json({ success: true, data: saved });
  },
);

/* ── Module settings ───────────────────────────────────────────────────────── */

/** The only keys the runtime still consumes (PRD-trimmed surface). */
const SETTING_KEYS = [
  "na_counts_against",
  "org_timezone",
  "auto_close_days",
  "lookahead_days",
  "report_share_ttl_hours",
] as const;

router.get(
  "/settings",
  authenticate,
  authorize("AUDIT_ADMIN", "view"),
  async (_req, res) => {
    const rows = await db.select().from(auditAppSettingsTable);
    res.json({
      success: true,
      data: rows.filter((r) => (SETTING_KEYS as readonly string[]).includes(r.key)),
    });
  },
);

router.put(
  "/settings/:key",
  authenticate,
  authorize("AUDIT_ADMIN", "edit"),
  async (req, res) => {
    const key = req.params["key"] as string;
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw httpError(400, `Unknown setting key — allowed: ${SETTING_KEYS.join(", ")}`);
    }
    if (!("value" in (req.body ?? {}))) throw httpError(400, "Body must include { value }");

    const [existing] = await db
      .select()
      .from(auditAppSettingsTable)
      .where(eq(auditAppSettingsTable.key, key));

    const actor = auditActor(req);
    const row = await db.transaction(async (tx) => {
      const values = {
        valueJson: req.body.value as unknown,
        updatedBy: actor.id,
        updatedAt: new Date(),
      };
      let saved;
      if (existing) {
        [saved] = await tx
          .update(auditAppSettingsTable)
          .set(values)
          .where(eq(auditAppSettingsTable.key, key))
          .returning();
      } else {
        [saved] = await tx
          .insert(auditAppSettingsTable)
          .values({ key, ...values })
          .returning();
      }
      await writeConfigChange(tx, {
        entityType: "SETTING",
        entityId: key,
        actorId: actor.id,
        actorRole: actor.role,
        before: existing ?? null,
        after: saved,
      });
      return saved!;
    });
    res.json({ success: true, data: row });
  },
);

export { router as auditAdminRouter };
