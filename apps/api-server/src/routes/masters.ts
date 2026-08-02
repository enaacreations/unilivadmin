/**
 * Masters API (B3-2) — one generic, registry-driven router for the master /
 * dropdown-source data admins manage from Settings (brands, cities, clusters,
 * zones, kitchens).
 *
 * A single REGISTRY maps each `masterType` to its drizzle table, label, column
 * descriptors, searchable columns and default ordering. Every endpoint then
 * operates generically off that descriptor, so adding a new master is a matter
 * of one registry entry rather than a new set of CRUD routes.
 *
 * Conventions mirror the rest of the API: zod safeParse validation, the
 * { success, error } envelope, `newId()` ids, default isActive=true, and the
 * shared export-service encoders (toCsv/toXls/toPdf — CSV formula-injection
 * safe). All routes authenticate + authorize on FOOD_SETTINGS.
 */
import { Router } from "express";
import {
  db,
  foodBrandsTable,
  citiesTable,
  clustersTable,
  zonesTable,
  kitchensTable,
} from "@workspace/db";
import { and, or, eq, ilike, inArray, asc, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";
import { toCsv, toPdf, toXls, fileDateStamp } from "../lib/export-service.js";
import { z } from "zod";

export const mastersRouter: Router = Router();

/* ════════════════════════════════════════════════════════════════════════
 * Registry
 *
 * Each column descriptor drives validation, list projection, create/update
 * whitelisting and export rendering:
 *   key       camelCase drizzle column name (also the API field name)
 *   label     human header (export + frontend form label)
 *   type      "string" | "boolean" | "id" — drives coercion + validation
 *   required  must be present & non-empty on create
 *   editable  may be set on create/update (false → server-managed/read-only)
 * `isActive` is always present and always editable (status toggles).
 * ════════════════════════════════════════════════════════════════════════ */

type ColType = "string" | "boolean" | "id";

interface MasterColumn {
  key: string;
  label: string;
  type: ColType;
  required?: boolean;
  editable?: boolean;
}

interface MasterDef {
  table: PgTable & Record<string, PgColumn>;
  label: string;
  columns: MasterColumn[];
  /** Columns the free-text `q` filter searches across (string columns only). */
  searchable: string[];
  /** Column the list is ordered by. */
  orderBy: string;
}

const REGISTRY: Record<string, MasterDef> = {
  brands: {
    table: foodBrandsTable as never,
    label: "Brands",
    columns: [
      { key: "code", label: "Code", type: "string", required: true, editable: true },
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "isActive", label: "Active", type: "boolean", editable: true },
    ],
    searchable: ["code", "name"],
    orderBy: "name",
  },
  cities: {
    table: citiesTable as never,
    label: "Cities",
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "zoneId", label: "Zone", type: "id", editable: true },
      { key: "isActive", label: "Active", type: "boolean", editable: true },
    ],
    searchable: ["name"],
    orderBy: "name",
  },
  clusters: {
    table: clustersTable as never,
    label: "Clusters",
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "cityId", label: "City", type: "id", required: true, editable: true },
      { key: "isActive", label: "Active", type: "boolean", editable: true },
    ],
    searchable: ["name"],
    orderBy: "name",
  },
  zones: {
    table: zonesTable as never,
    label: "Zones",
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "code", label: "Code", type: "string", editable: true },
      { key: "isActive", label: "Active", type: "boolean", editable: true },
    ],
    searchable: ["name", "code"],
    orderBy: "name",
  },
  kitchens: {
    table: kitchensTable as never,
    label: "Kitchens",
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "code", label: "Code", type: "string", required: true, editable: true },
      { key: "brand", label: "Brand", type: "string", editable: true },
      { key: "address", label: "Address", type: "string", editable: true },
      { key: "city", label: "City", type: "string", editable: true },
      { key: "state", label: "State", type: "string", editable: true },
      { key: "pincode", label: "Pincode", type: "string", editable: true },
      { key: "contactName", label: "Contact Name", type: "string", editable: true },
      { key: "contactPhone", label: "Contact Phone", type: "string", editable: true },
      { key: "contactEmail", label: "Contact Email", type: "string", editable: true },
      { key: "cityId", label: "City (ref)", type: "id", editable: true },
      { key: "clusterId", label: "Cluster (ref)", type: "id", editable: true },
      { key: "isActive", label: "Active", type: "boolean", editable: true },
    ],
    searchable: ["name", "code", "city", "pincode"],
    orderBy: "name",
  },
};

const MASTER_TYPES = Object.keys(REGISTRY);

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Resolve a registry def by type, or 404 and return null. */
function defOr404(req: { params: Record<string, string> }, res: any): MasterDef | null {
  const def = REGISTRY[req.params["type"]!];
  if (!def) {
    res.status(404).json({ success: false, error: "Unknown master type" });
    return null;
  }
  return def;
}

/** drizzle column for a registry key (columns are keyed by camelCase name). */
function col(def: MasterDef, key: string): PgColumn {
  return def.table[key] as PgColumn;
}

/** Coerce an incoming value to the column's storage type. */
function coerce(type: ColType, value: unknown): unknown {
  if (type === "boolean") return value === undefined ? undefined : !!value;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return String(value);
}

/** Build the zod schema for create (required cols enforced). */
function createSchema(def: MasterDef): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const c of def.columns) {
    if (!c.editable) continue;
    if (c.type === "boolean") {
      shape[c.key] = z.boolean().optional();
    } else if (c.required) {
      shape[c.key] = z.string().min(1).max(1024);
    } else {
      shape[c.key] = z.union([z.string().max(1024), z.null()]).optional();
    }
  }
  return z.object(shape).passthrough();
}

/** Build the zod schema for update (everything optional). */
function updateSchema(def: MasterDef): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const c of def.columns) {
    if (!c.editable) continue;
    if (c.type === "boolean") shape[c.key] = z.boolean().optional();
    else shape[c.key] = z.union([z.string().max(1024), z.null()]).optional();
  }
  return z.object(shape).passthrough();
}

function validateBody(schema: z.ZodType, req: { body: unknown }, res: any): boolean {
  const p = schema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ success: false, error: "Invalid request", details: p.error.flatten() });
    return false;
  }
  return true;
}

/** A Postgres FK-violation (23503) raised when deleting a referenced row. */
function isFkViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "23503") return true;
  // Some drivers surface the cause nested or only in the message.
  const cause = (err as { cause?: { code?: string } })?.cause;
  if (cause?.code === "23503") return true;
  return /foreign key constraint/i.test(String((err as Error)?.message ?? ""));
}

/* ════════════════════════════════════════════════════════════════════════
 * GET /masters — hub: one row per registered master with its live count.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.get("/", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const out = [];
    for (const type of MASTER_TYPES) {
      const def = REGISTRY[type]!;
      const rows = await db.select({ id: col(def, "id") }).from(def.table);
      out.push({ type, label: def.label, count: rows.length, manageable: true });
    }
    res.json({ success: true, data: out });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * GET /masters/:type — list rows. Search across `searchable`; active-only
 * unless ?includeInactive=true.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.get("/:type", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    const q = String(req.query["q"] ?? "").trim();
    const includeInactive = String(req.query["includeInactive"] ?? "") === "true";

    const conds: SQL[] = [];
    if (!includeInactive) conds.push(eq(col(def, "isActive"), true));
    if (q) {
      const like = `%${q}%`;
      const ors = def.searchable.map((k) => ilike(col(def, k), like));
      const orExpr = ors.length ? or(...ors) : undefined;
      if (orExpr) conds.push(orExpr);
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(def.table).where(where).orderBy(asc(col(def, def.orderBy)));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * POST /masters/:type — create.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.post("/:type", authenticate, authorize("FOOD_SETTINGS", "create"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    if (!validateBody(createSchema(def), req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;

    // Required-column presence (string cols).
    for (const c of def.columns) {
      if (c.required && c.type !== "boolean") {
        const v = b[c.key];
        if (v === undefined || v === null || String(v).trim() === "") {
          res.status(400).json({ success: false, error: `${c.label} is required` });
          return;
        }
      }
    }

    const values: Record<string, unknown> = { id: newId(), updatedAt: new Date() };
    for (const c of def.columns) {
      if (!c.editable) continue;
      if (c.key === "isActive") { values["isActive"] = b["isActive"] === undefined ? true : !!b["isActive"]; continue; }
      const v = coerce(c.type, b[c.key]);
      if (v !== undefined) values[c.key] = v;
    }

    const [row] = await db.insert(def.table).values(values as never).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    const dup = String((err as Error)?.message ?? "").toLowerCase().includes("unique");
    req.log.error(err);
    res.status(dup ? 409 : 500).json({ success: false, error: dup ? "A record with this code already exists" : "Internal server error" });
  }
});

/* ════════════════════════════════════════════════════════════════════════
 * PATCH /masters/:type/:id — update editable cols incl isActive.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.patch("/:type/:id", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    if (!validateBody(updateSchema(def), req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const c of def.columns) {
      if (!c.editable) continue;
      if (!(c.key in b)) continue;
      if (c.key === "isActive") { u["isActive"] = !!b["isActive"]; continue; }
      // Block clearing a required column.
      if (c.required && (b[c.key] === null || String(b[c.key] ?? "").trim() === "")) {
        res.status(400).json({ success: false, error: `${c.label} is required` });
        return;
      }
      u[c.key] = coerce(c.type, b[c.key]);
    }

    const [row] = await db.update(def.table).set(u as never).where(eq(col(def, "id"), req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) {
    const dup = String((err as Error)?.message ?? "").toLowerCase().includes("unique");
    req.log.error(err);
    res.status(dup ? 409 : 500).json({ success: false, error: dup ? "A record with this code already exists" : "Internal server error" });
  }
});

/* ════════════════════════════════════════════════════════════════════════
 * DELETE /masters/:type/:id — hard delete; FK-blocked → 409 deactivate hint.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.delete("/:type/:id", authenticate, authorize("FOOD_SETTINGS", "delete"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    const [row] = await db.delete(def.table).where(eq(col(def, "id"), req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) {
    if (isFkViolation(err)) {
      res.status(409).json({ success: false, error: "In use — deactivate instead." });
      return;
    }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ════════════════════════════════════════════════════════════════════════
 * POST /masters/:type/bulk — { ids, action }. activate/deactivate flip
 * isActive; delete removes rows but SKIPS any that are FK-referenced (the
 * skipped count is reported). All in one transaction.
 * ════════════════════════════════════════════════════════════════════════ */
const bulkSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).min(1),
  action: z.enum(["activate", "deactivate", "delete"]),
}).passthrough();

mastersRouter.post("/:type/bulk", authenticate, authorize("FOOD_SETTINGS", "edit"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    if (!validateBody(bulkSchema, req, res)) return;
    const { ids, action } = req.body as { ids: string[]; action: "activate" | "deactivate" | "delete" };

    const result = await db.transaction(async (tx) => {
      if (action === "activate" || action === "deactivate") {
        const updated = await tx.update(def.table)
          .set({ isActive: action === "activate", updatedAt: new Date() } as never)
          .where(inArray(col(def, "id"), ids)).returning({ id: col(def, "id") });
        return { affected: updated.length, skipped: 0 };
      }
      // delete: attempt each row; FK-referenced rows are skipped (savepoint per row
      // so one failure doesn't abort the whole transaction).
      let affected = 0; let skipped = 0;
      for (const id of ids) {
        try {
          const del = await tx.transaction(async (inner) =>
            inner.delete(def.table).where(eq(col(def, "id"), id)).returning({ id: col(def, "id") }));
          if (del.length) affected += 1;
        } catch (e) {
          if (isFkViolation(e)) { skipped += 1; continue; }
          throw e;
        }
      }
      return { affected, skipped };
    });

    res.json({ success: true, data: { action, ...result } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

/* ════════════════════════════════════════════════════════════════════════
 * GET /masters/:type/export.:fmt(csv|xlsx|pdf) — export rows via the shared
 * export-service encoders. Honours the same q/includeInactive filters as list.
 * Filename: masters-<type>-<datestamp>.<fmt>.
 * ════════════════════════════════════════════════════════════════════════ */
mastersRouter.get("/:type/export.:fmt", authenticate, authorize("FOOD_SETTINGS", "view"), async (req, res) => {
  try {
    const def = defOr404(req, res); if (!def) return;
    const fmt = String(req.params["fmt"] ?? "").toLowerCase();
    if (!["csv", "xlsx", "pdf"].includes(fmt)) {
      res.status(400).json({ success: false, error: "fmt must be csv, xlsx or pdf" });
      return;
    }

    const q = String(req.query["q"] ?? "").trim();
    const includeInactive = String(req.query["includeInactive"] ?? "") === "true";
    const conds: SQL[] = [];
    if (!includeInactive) conds.push(eq(col(def, "isActive"), true));
    if (q) {
      const like = `%${q}%`;
      const ors = def.searchable.map((k) => ilike(col(def, k), like));
      const orExpr = ors.length ? or(...ors) : undefined;
      if (orExpr) conds.push(orExpr);
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(def.table).where(where).orderBy(asc(col(def, def.orderBy)));

    const headers = def.columns.map((c) => c.label);
    const body = rows.map((r) => def.columns.map((c) => {
      const v = (r as Record<string, unknown>)[c.key];
      if (c.type === "boolean") return v ? "Yes" : "No";
      return v == null ? "" : String(v);
    }));
    const table = { title: `${def.label} (Master)`, headers, rows: body };
    const filename = `masters-${req.params["type"]}-${fileDateStamp()}.${fmt}`;

    if (fmt === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toCsv(table));
    } else if (fmt === "pdf") {
      const pdf = await toPdf(table);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(Buffer.from(pdf));
    } else {
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(toXls(table));
    }
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export default mastersRouter;
