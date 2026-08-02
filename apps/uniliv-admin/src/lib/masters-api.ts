/**
 * Masters (reference-data) — typed API client.
 *
 * Thin wrappers over apiFetch for the generic /api/masters endpoints, plus the
 * shared types and a query-key factory. Every master (brands, cities, clusters,
 * zones, kitchens, …) is driven by the same registry-backed CRUD surface, so a
 * single config-driven table page (master-table.tsx) and hub (masters.tsx) can
 * render them all. Mirrors the food-api.ts convention (apiFetch + .then unwrap,
 * structured query keys, *ExportUrl helpers for the apiDownload pattern).
 */
import { apiFetch } from "@/lib/api-fetch";

// ─── Domain types ────────────────────────────────────────────────────────────
/** Column metadata returned by the registry. `id`/`createdAt`/`updatedAt` are
 *  server-managed and never appear here. `isActive` is always editable. */
export type MasterColumnType = "string" | "boolean" | "id";

export interface MasterColumn {
  key: string;
  label: string;
  type: MasterColumnType;
  required?: boolean;
  editable?: boolean;
}

/** One row of any master — opaque, keyed by the registry columns plus the
 *  server-managed id/timestamps. */
export type MasterRow = Record<string, unknown> & {
  id: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** A registered master as surfaced by GET /masters (hub tiles). */
export interface MasterSummary {
  type: string;
  label: string;
  count: number;
  manageable: boolean;
}

/** Full list response: the type's rows plus its column metadata so the generic
 *  table can render itself without a hard-coded schema. The list endpoint
 *  returns the rows; columns come from the bundled registry (below) keyed by
 *  type. We expose both via mastersApi.list(). */
export type BulkAction = "activate" | "deactivate" | "delete";

export interface BulkResult {
  action: BulkAction;
  affected: number;
  skipped: number;
}

export type ExportFmt = "csv" | "xlsx" | "pdf";

type Envelope<T> = { success: boolean; data: T; error?: string; details?: unknown };

/** Free-text + include-inactive filter shared by list and export. */
export interface MasterListParams {
  q?: string;
  includeInactive?: boolean;
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ─── Front-end column registry ───────────────────────────────────────────────
// Mirrors the backend /masters registry so the generic table can render forms,
// headers and export labels without a metadata round-trip. Keep in sync with the
// server registry. `id`/`createdAt`/`updatedAt` are server-managed (omitted).
// `isActive` is always the last, always-editable column.
const ACTIVE: MasterColumn = { key: "isActive", label: "Active", type: "boolean", editable: true };

export interface MasterRegistryEntry {
  type: string;
  label: string;
  columns: MasterColumn[];
  searchable: string[];
}

export const MASTER_REGISTRY: Record<string, MasterRegistryEntry> = {
  brands: {
    type: "brands",
    label: "Brands",
    searchable: ["code", "name"],
    columns: [
      { key: "code", label: "Code", type: "string", required: true, editable: true },
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      ACTIVE,
    ],
  },
  cities: {
    type: "cities",
    label: "Cities",
    searchable: ["name"],
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "zoneId", label: "Zone", type: "id", editable: true },
      ACTIVE,
    ],
  },
  clusters: {
    type: "clusters",
    label: "Clusters",
    searchable: ["name"],
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "cityId", label: "City", type: "id", required: true, editable: true },
      ACTIVE,
    ],
  },
  zones: {
    type: "zones",
    label: "Zones",
    searchable: ["name", "code"],
    columns: [
      { key: "name", label: "Name", type: "string", required: true, editable: true },
      { key: "code", label: "Code", type: "string", editable: true },
      ACTIVE,
    ],
  },
  kitchens: {
    type: "kitchens",
    label: "Kitchens",
    searchable: ["name", "code", "city", "pincode"],
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
      { key: "cityId", label: "City (linked)", type: "id", editable: true },
      { key: "clusterId", label: "Cluster", type: "id", editable: true },
      ACTIVE,
    ],
  },
};

/** Registry lookup for a type, or undefined for an unknown master. */
export function masterRegistry(type: string): MasterRegistryEntry | undefined {
  return MASTER_REGISTRY[type];
}

/** Editable columns (what POST/PATCH bodies may carry). Excludes nothing the
 *  registry already marks editable — id/timestamps are not in the registry. */
export function editableColumns(entry: MasterRegistryEntry): MasterColumn[] {
  return entry.columns.filter((c) => c.editable);
}

// ─── Query-key factory (stable, structured) ──────────────────────────────────
export const masterKeys = {
  hub: () => ["masters", "hub"] as const,
  list: (type: string, p: MasterListParams = {}) => ["masters", "list", type, p] as const,
};

// ─── API surface ─────────────────────────────────────────────────────────────
export const mastersApi = {
  /** GET /masters — hub tiles (one entry per registered master, count incl inactive). */
  hub: () => apiFetch<Envelope<MasterSummary[]>>(`/masters`).then((r) => r.data),

  /** GET /masters/:type — full rows, filtered by q + includeInactive, ordered by registry orderBy. */
  list: (type: string, p: MasterListParams = {}) =>
    apiFetch<Envelope<MasterRow[]>>(`/masters/${type}${qs(p as Record<string, unknown>)}`).then((r) => r.data),

  /** POST /masters/:type — body = editable cols (camelCase). 201 → created row. */
  create: (type: string, body: Record<string, unknown>) =>
    apiFetch<Envelope<MasterRow>>(`/masters/${type}`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.data),

  /** PATCH /masters/:type/:id — body = any subset of editable cols incl isActive. */
  update: (type: string, id: string, body: Record<string, unknown>) =>
    apiFetch<Envelope<MasterRow>>(`/masters/${type}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.data),

  /** DELETE /masters/:type/:id — 409 when FK-referenced (deactivate instead). */
  remove: (type: string, id: string) =>
    apiFetch<Envelope<MasterRow>>(`/masters/${type}/${id}`, { method: "DELETE" }).then((r) => r.data),

  /** POST /masters/:type/bulk — { ids, action }. delete skips FK-referenced rows. */
  bulk: (type: string, ids: string[], action: BulkAction) =>
    apiFetch<Envelope<BulkResult>>(`/masters/${type}/bulk`, {
      method: "POST",
      body: JSON.stringify({ ids, action }),
    }).then((r) => r.data),

  /** GET /masters/:type/export.:fmt — absolute /api URL for apiDownload. */
  exportUrl: (type: string, fmt: ExportFmt, p: MasterListParams = {}) =>
    `/api/masters/${type}/export.${fmt}${qs(p as Record<string, unknown>)}`,

  /** Dated download filename matching the server's Content-Disposition. */
  exportFilename: (type: string, fmt: ExportFmt) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `masters-${type}-${stamp}.${fmt}`;
  },
};
