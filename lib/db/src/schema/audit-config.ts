import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  pgEnum,
  json,
  index,
} from "drizzle-orm/pg-core";
import { usersTable, propertiesTable } from "./core";
import { zonesTable, citiesTable, clustersTable } from "./food";

/* ────────────────────────────────────────────────────────────────────────────
 * Audit & Inspection — configuration tables (spec §5.8 / FRD FA-16).
 * Everything here is runtime data read by the audit module; every mutation is
 * recorded as a CONFIG_CHANGE event in audit_events (FR-AD-10).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Module-internal persona roles (FRD §2), granted per user via audit_role_grants. */
export const auditModuleRoleEnum = pgEnum("audit_module_role", [
  "ADMIN",
  "SCHEDULER",
  "AUDITOR",
  "AUDITEE",
  "REVIEWER",
  "VIEWER",
]);

/** Org-node scope levels for grants (audit hierarchy: Zone → City → Cluster → Property). */
export const auditScopeLevelEnum = pgEnum("audit_scope_level", [
  "GLOBAL",
  "ZONE",
  "CITY",
  "CLUSTER",
  "PROPERTY",
]);

/**
 * Rating scales (FR-AD-02). Published template versions snapshot their scale
 * into template_version.rating_scale_snapshot, so edits here never affect
 * historical scores.
 */
export const auditRatingScalesTable = pgTable("audit_rating_scales", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const auditRatingOptionsTable = pgTable("audit_rating_options", {
  id: text("id").primaryKey(),
  scaleId: text("scale_id")
    .notNull()
    .references(() => auditRatingScalesTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  color: text("color"),
  orderIndex: integer("order_index").notNull(),
  /** Score multiplier in percent (0–100), e.g. Good = 94. */
  multiplierPct: numeric("multiplier_pct").notNull(),
  /** N/A behaviour: excluded from numerator & denominator by default (D-1). */
  isExcludedNa: boolean("is_excluded_na").default(false).notNull(),
});

/** Score % → label bands (FRD-ADM-02). Service validates contiguous, non-overlapping, 0–100. */
export const auditPerformanceBandsTable = pgTable("audit_performance_bands", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  minPct: numeric("min_pct").notNull(),
  maxPct: numeric("max_pct").notNull(),
  color: text("color"),
  orderIndex: integer("order_index").notNull(),
});

/**
 * Numbering schemes per object type (FR-AD-06), e.g. UNI-AUD-{seq}.
 * Allocation: UPDATE … SET next_seq = next_seq + 1 RETURNING inside the insert
 * transaction (row-lock serialized), wrapped in withUniqueRetry.
 */
export const auditNumberingSchemesTable = pgTable("audit_numbering_schemes", {
  id: text("id").primaryKey(),
  objectType: text("object_type").notNull().unique(),
  prefix: text("prefix").notNull(),
  /** Pattern with {prefix} and {seq} placeholders; default "{prefix}-{seq}". */
  pattern: text("pattern").default("{prefix}-{seq}").notNull(),
  nextSeq: integer("next_seq").default(1).notNull(),
  padWidth: integer("pad_width"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Scoped module-role grants (FRD-ACC-02/05, D-10): module role × audit types ×
 * org node × validity window. Coexists with users.role — the platform role
 * gates endpoints via ROLE_PERMISSIONS; grants are the fine-grained truth
 * resolved per request by resolveAuditAccess(). SUPER_ADMIN / OPS_EXCELLENCE
 * are implicitly global-all and need no rows.
 */
export const auditRoleGrantsTable = pgTable(
  "audit_role_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    moduleRole: auditModuleRoleEnum("module_role").notNull(),
    /** Audit types this grant covers, e.g. ["UL","CM"]. */
    auditTypes: json("audit_types").$type<string[]>().default([]).notNull(),
    scopeLevel: auditScopeLevelEnum("scope_level").notNull(),
    zoneId: text("zone_id").references(() => zonesTable.id),
    cityId: text("city_id").references(() => citiesTable.id),
    clusterId: text("cluster_id").references(() => clustersTable.id),
    propertyId: text("property_id").references(() => propertiesTable.id),
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedBy: text("revoked_by"),
    /** Stamped by the daily sweep when the expiry GRANT_CHANGE event is written (dedupe). */
    expiryEventAt: timestamp("expiry_event_at"),
  },
  (table) => [index("audit_role_grants_user_id_idx").on(table.userId)],
);

/**
 * Module settings (key → JSON value). Dedicated table (not system_config) so
 * every change routes through the module's evented config writer (FR-AD-10).
 * Keys: na_counts_against, lookahead_days, auto_close_days,
 * report_share_ttl_hours, org_timezone.
 */
export const auditAppSettingsTable = pgTable("audit_app_settings", {
  key: text("key").primaryKey(),
  valueJson: json("value_json"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
