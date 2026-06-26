import { Router } from "express";
import { db, slaConfigTable, complaintRoutingTable, integrationStatusTable, auditLogTable, usersTable, systemConfigTable } from "@workspace/db";
import { eq, desc, inArray, and, gte, lte, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { isSuperAdmin } from "../lib/authz.js";
import { newId } from "../lib/id.js";
import { writeAuditLog } from "../lib/wallet-service.js";

export const settingsRouter = Router();

// SLA config
settingsRouter.get("/sla", authenticate, authorize("SETTINGS", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(slaConfigTable);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

settingsRouter.put("/sla/:category", authenticate, authorize("SETTINGS", "edit"), async (req, res) => {
  try {
    const cat = req.params["category"] as string;
    const hours = Number(req.body?.slaHours);
    if (!hours) { res.status(400).json({ success: false, error: "slaHours is required" }); return; }
    const [existing] = await db.select().from(slaConfigTable).where(eq(slaConfigTable.category, cat));
    if (existing) {
      const [row] = await db.update(slaConfigTable).set({ slaHours: hours, updatedAt: new Date() }).where(eq(slaConfigTable.category, cat)).returning();
      void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", `SLA:${cat}`, { config: "SLA", category: cat, oldSlaHours: existing.slaHours, newSlaHours: hours }).catch(() => {});
      res.json({ success: true, data: row });
    } else {
      const [row] = await db.insert(slaConfigTable).values({ id: newId(), category: cat, slaHours: hours, updatedAt: new Date() }).returning();
      void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", `SLA:${cat}`, { config: "SLA", category: cat, newSlaHours: hours }).catch(() => {});
      res.json({ success: true, data: row });
    }
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Complaint routing
settingsRouter.get("/routing", authenticate, authorize("SETTINGS", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(complaintRoutingTable);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

settingsRouter.post("/routing", authenticate, authorize("SETTINGS", "edit"), async (req, res) => {
  try {
    const { propertyId, category, assignedTo } = req.body || {};
    if (!propertyId || !category || !assignedTo) { res.status(400).json({ success: false, error: "propertyId, category, assignedTo are required" }); return; }
    const [row] = await db.insert(complaintRoutingTable).values({ id: newId(), propertyId, category, assignedTo, updatedAt: new Date() }).returning();
    void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", `ROUTING:${row.id}`, { config: "COMPLAINT_ROUTING", action: "create", propertyId, category, assignedTo }).catch(() => {});
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

settingsRouter.delete("/routing/:id", authenticate, authorize("SETTINGS", "delete"), async (req, res) => {
  try {
    const routingId = req.params["id"] as string;
    await db.delete(complaintRoutingTable).where(eq(complaintRoutingTable.id, routingId));
    void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", `ROUTING:${routingId}`, { config: "COMPLAINT_ROUTING", action: "delete" }).catch(() => {});
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Integrations
settingsRouter.get("/integrations", authenticate, authorize("SETTINGS", "view"), async (_req, res) => {
  try {
    const rows = await db.select().from(integrationStatusTable);
    const map: Record<string, { enabled: boolean; configured: boolean }> = {};
    for (const r of rows) map[r.name] = { enabled: r.enabled, configured: r.enabled };
    const builtins = [
      { name: "Razorpay", enabled: !!process.env["RAZORPAY_KEY_ID"], configured: !!process.env["RAZORPAY_KEY_ID"] },
      { name: "Twilio", enabled: !!process.env["TWILIO_AUTH_TOKEN"], configured: !!process.env["TWILIO_AUTH_TOKEN"] },
      { name: "SMTP", enabled: !!process.env["SMTP_HOST"], configured: !!process.env["SMTP_HOST"] },
    ];
    res.json({ success: true, data: builtins.map((b) => ({ ...b, ...map[b.name] })) });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// KYC Gate toggle (uses integration_status row "KYC_GATE")
settingsRouter.get("/kyc-gate", authenticate, authorize("SETTINGS", "view"), async (_req, res) => {
  try {
    const [row] = await db.select().from(integrationStatusTable).where(eq(integrationStatusTable.name, "KYC_GATE"));
    res.json({ success: true, data: { enabled: !!row?.enabled } });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

settingsRouter.put("/kyc-gate", authenticate, authorize("SETTINGS", "edit"), async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const [existing] = await db.select().from(integrationStatusTable).where(eq(integrationStatusTable.name, "KYC_GATE"));
    if (existing) {
      await db.update(integrationStatusTable).set({ enabled, updatedAt: new Date() }).where(eq(integrationStatusTable.name, "KYC_GATE"));
    } else {
      await db.insert(integrationStatusTable).values({ id: newId(), name: "KYC_GATE", enabled, updatedAt: new Date() });
    }
    void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", "INTEGRATION:KYC_GATE", { config: "INTEGRATION", name: "KYC_GATE", oldEnabled: existing?.enabled ?? null, newEnabled: enabled }).catch(() => {});
    res.json({ success: true, data: { enabled } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Audit log (SUPER_ADMIN only) — filterable + paginated (compliance).
//
// Query params (all optional):
//   action  exact action match   (e.g. ROLE_CHANGED)
//   entity  exact entity match   (e.g. user | property | settings)
//   userId  exact actor id
//   from    inclusive lower date bound YYYY-MM-DD (createdAt >= 00:00 of that day)
//   to      inclusive upper date bound YYYY-MM-DD (createdAt <= 23:59:59.999 of that day)
//   limit   page size, default 50, capped at 200
//   offset  row offset, default 0
//
// Response: { success, data: rows[], meta: { total, limit, offset } }
//   rows ordered by createdAt desc, each carries userName (left-joined).
settingsRouter.get("/audit-log", authenticate, authorize("AUDIT_LOG", "view"), async (req, res) => {
  try {
    const q = req.query as Record<string, unknown>;

    const conditions = [];
    if (typeof q["action"] === "string" && q["action"]) conditions.push(eq(auditLogTable.action, q["action"]));
    if (typeof q["entity"] === "string" && q["entity"]) conditions.push(eq(auditLogTable.entity, q["entity"]));
    if (typeof q["userId"] === "string" && q["userId"]) conditions.push(eq(auditLogTable.userId, q["userId"]));
    // Date bounds: parse YYYY-MM-DD; `to` is widened to end-of-day so the bound is inclusive.
    if (typeof q["from"] === "string" && q["from"]) {
      const d = new Date(`${q["from"]}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime())) conditions.push(gte(auditLogTable.createdAt, d));
    }
    if (typeof q["to"] === "string" && q["to"]) {
      const d = new Date(`${q["to"]}T23:59:59.999Z`);
      if (!Number.isNaN(d.getTime())) conditions.push(lte(auditLogTable.createdAt, d));
    }
    const where = conditions.length ? and(...conditions) : undefined;

    // Pagination: default 50, hard-capped at 200; non-negative offset.
    const rawLimit = Number(q["limit"]);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 200) : 50;
    const rawOffset = Number(q["offset"]);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogTable).where(where);
    const rows = await db.select({
      id: auditLogTable.id,
      action: auditLogTable.action,
      entity: auditLogTable.entity,
      entityId: auditLogTable.entityId,
      changes: auditLogTable.changes,
      createdAt: auditLogTable.createdAt,
      userId: auditLogTable.userId,
      userName: usersTable.name,
    })
      .from(auditLogTable)
      .leftJoin(usersTable, eq(auditLogTable.userId, usersTable.id))
      .where(where)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json({ success: true, data: rows, meta: { total: countResult.count, limit, offset } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Audit-log facets — distinct actions + entities present in the log, for the
// UI filter dropdowns. SUPER_ADMIN only (same gate as the log itself).
settingsRouter.get("/audit-log/facets", authenticate, authorize("AUDIT_LOG", "view"), async (req, res) => {
  try {
    const actionRows = await db.selectDistinct({ action: auditLogTable.action }).from(auditLogTable).orderBy(auditLogTable.action);
    const entityRows = await db.selectDistinct({ entity: auditLogTable.entity }).from(auditLogTable).orderBy(auditLogTable.entity);
    res.json({
      success: true,
      data: {
        actions: actionRows.map((r) => r.action).filter(Boolean),
        entities: entityRows.map((r) => r.entity).filter(Boolean),
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * OTP / login-security config (system_config) — SUPER_ADMIN only.
 *
 * These keys are read live by otp-service.ts (readConfig). Settings exposed
 * here MUST match the keys otp-service reads, stored as raw JSON scalars under
 * their canonical keys. OTP code length / lockout-minutes are intentionally
 * NOT editable here (length is fixed by SMS template; lockout is a separate
 * concern) — only the resident-facing OTP caps are tunable.
 * ════════════════════════════════════════════════════════════════════════ */

/** Editable OTP keys with their sane integer bounds and seed defaults. */
const OTP_CONFIG_FIELDS = [
  { key: "OTP_MAX_ATTEMPTS", min: 1, max: 10, fallback: 3, description: "Max OTP verification attempts before lock" },
  { key: "OTP_MAX_RESEND", min: 1, max: 10, fallback: 3, description: "Max OTP resends per challenge" },
  { key: "OTP_EXPIRY_MINUTES", min: 1, max: 60, fallback: 10, description: "OTP validity window (minutes)" },
] as const;

/** Coerce a stored JSON scalar (plain or wrapped) to a number, tolerating strings. */
function configToNumber(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  if (typeof raw === "number") return raw;
  if (typeof raw === "object") {
    const v = Object.values(raw as Record<string, unknown>)[0];
    return typeof v === "number" ? v : fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function readOtpConfig(): Promise<Record<string, number>> {
  const keys = OTP_CONFIG_FIELDS.map((f) => f.key);
  const rows = await db.select().from(systemConfigTable).where(inArray(systemConfigTable.key, keys));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, number> = {};
  for (const f of OTP_CONFIG_FIELDS) out[f.key] = configToNumber(byKey.get(f.key), f.fallback);
  return out;
}

// Read current OTP caps. SUPER_ADMIN only (sensitive login-security setting).
settingsRouter.get("/otp-config", authenticate, async (req, res) => {
  try {
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" });
      return;
    }
    res.json({ success: true, data: await readOtpConfig() });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Upsert OTP caps. SUPER_ADMIN only; validates each value is a positive integer in bounds.
settingsRouter.put("/otp-config", authenticate, async (req, res) => {
  try {
    if (!isSuperAdmin(req.user?.role)) {
      res.status(403).json({ success: false, error: "Forbidden — SUPER_ADMIN only" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: Array<{ key: string; value: number; description: string }> = [];
    for (const f of OTP_CONFIG_FIELDS) {
      if (body[f.key] === undefined) continue;
      const n = Number(body[f.key]);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        res.status(400).json({ success: false, error: `${f.key} must be an integer between ${f.min} and ${f.max}` });
        return;
      }
      updates.push({ key: f.key, value: n, description: f.description });
    }
    if (!updates.length) { res.status(400).json({ success: false, error: "Nothing to update" }); return; }

    for (const u of updates) {
      await db.insert(systemConfigTable)
        .values({ id: newId(), key: u.key, value: u.value as never, description: u.description, updatedAt: new Date() })
        .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: u.value as never, updatedAt: new Date() } });
    }
    void writeAuditLog(req.user!.id, "SETTINGS_UPDATED", "settings", "OTP_CONFIG", { config: "OTP", changes: Object.fromEntries(updates.map((u) => [u.key, u.value])) }).catch(() => {});

    res.json({ success: true, data: await readOtpConfig() });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
