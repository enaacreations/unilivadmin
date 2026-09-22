import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  bigint,
  pgEnum,
  json,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./core";

/* ────────────────────────────────────────────────────────────────────────────
 * Access control — the unified authorization model (Access Controls PRD v1.0).
 *
 * Replaces two sibling scope systems that solved the same problem separately:
 *   user_scopes       (food.ts)         — GLOBAL/ZONE/CITY/KITCHEN/CLUSTER/PROPERTY
 *   audit_role_grants (audit-config.ts) — module role × audit types × node × window
 * Both stay in place until a release AFTER the resolver cuts over; nothing here
 * drops them.
 *
 * Four generalizations, because the PRD enumerates where it should abstract
 * (9 scopes, 7 hierarchy levels, 13 event families):
 *
 *  G1  A node's id IS the underlying entity's id. newId() is randomUUID(), so
 *      ids are unique across tables and every propertyId column already in the
 *      schema is a valid org_nodes.id. That is what lets the ~90 existing food
 *      and audit scoping call sites cut over with zero line changes.
 *      (Survives the planned UUID→bigint migration only because that migration
 *      uses ONE global sequence — per-table serial would collide properties.id=1
 *      with rooms.id=1 and break this. See ID_MIGRATION_PLAN.md §1.)
 *
 *  G2  Descendants are answered by a CLOSURE TABLE, not a materialized path.
 *      Closure needs only eq/inArray, which the test harness (fake-db.ts)
 *      already evaluates; a path column would need LIKE, which it throws on,
 *      plus a text_pattern_ops index — the exact species of index that broke
 *      `drizzle-kit push` round-tripping for user_scopes.
 *
 *  G3  dataScope is ORTHOGONAL to node scope. The PRD's §24 list merges two
 *      axes its own chain separates; splitting them makes all ten of its scopes
 *      fall out of nodeId × includeDescendants × dataScope with no special cases.
 *
 *  G4  One decision function. See apps/api-server/src/lib/access/decide.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The 11 levels the PRD's two hierarchies need, as ONE enum.
 *
 * Postgres enums can only have values APPENDED, so this order is insertion
 * order, NOT hierarchy order. Depth ordering lives in code (ALLOWED_PARENTS in
 * apps/api-server/src/lib/org-tree.ts) precisely so that adding a level later
 * is an append here plus a map entry there — never a reshuffle.
 *
 * COMPANY/REGION/BUILDING/FLOOR/BED have no legacy table and are org-nodes-native
 * from the start. ZONE/CITY/CLUSTER/KITCHEN/PROPERTY/ROOM project from existing
 * tables (see scripts sync job) and those tables remain the write source.
 */
export const orgNodeTypeEnum = pgEnum("org_node_type", [
  "COMPANY",
  "ZONE",
  "REGION",
  "CITY",
  "CLUSTER",
  "KITCHEN",
  "PROPERTY",
  "BUILDING",
  "FLOOR",
  "ROOM",
  "BED",
]);

/**
 * Edge kind in the closure table.
 *
 * TREE   — the single structural parent chain (Company→…→Bed).
 * SERVES — the F&B kitchen spine. A property's structural parent is its cluster;
 *          its kitchen is a SERVICE relation (properties.kitchenId), a genuinely
 *          second parent. Modelling it as a second edge kind rather than a DAG
 *          keeps one table and one discriminator, and makes a future third spine
 *          (a maintenance-vendor spine, say) an enum value rather than a schema.
 */
export const orgPathKindEnum = pgEnum("org_path_kind", ["TREE", "SERVES"]);

/**
 * PRD §23's 13 actions. The legacy four come FIRST and keep their exact spelling
 * so `Permission ⊂ Action` holds and every existing authorize(module, "view")
 * call compiles unchanged.
 */
export const accessActionEnum = pgEnum("access_action", [
  "view",
  "create",
  "edit",
  "delete",
  "submit",
  "approve",
  "reject",
  "assign",
  "complete",
  "verify",
  "export",
  "download",
  "configure",
]);

/**
 * The axis PRD §24 collapses into its scope list (G3).
 *   ALL      — every row inside the node scope
 *   TEAM     — rows belonging to the caller's reporting subtree (§26, dynamic)
 *   ASSIGNED — rows assigned to the caller ("Assigned Tasks")
 *   SELF     — rows about the caller ("Self")
 */
export const accessDataScopeEnum = pgEnum("access_data_scope", [
  "ALL",
  "TEAM",
  "ASSIGNED",
  "SELF",
]);

/**
 * A per-person exception to the role matrix.
 *
 * GRANT adds a capability the person's role does not carry; DENY removes one it
 * does. Both are EXCEPTIONS, never the primary mechanism — the role matrix
 * stays the thing you reason about, and this table is the short list of people
 * who differ from it. That is why every row carries a reason and may carry an
 * expiry: an override without either is how an org loses track of who can do
 * what.
 */
export const accessOverrideEffectEnum = pgEnum("access_override_effect", ["GRANT", "DENY"]);

/** A grant attaches to one user, or to every holder of a role. */
export const accessSubjectTypeEnum = pgEnum("access_subject_type", ["USER", "ROLE"]);

/**
 * PRD §27: an employee has one PRIMARY property and any number of SECONDARY
 * ones. GRANT is everything else (a region grant, an audit-type grant, …), so
 * assignment and authorization share one table instead of drifting apart.
 */
export const accessAssignmentKindEnum = pgEnum("access_assignment_kind", [
  "PRIMARY",
  "SECONDARY",
  "GRANT",
]);

/* ── The tree ─────────────────────────────────────────────────────────────── */

export const orgNodesTable = pgTable(
  "org_nodes",
  {
    /** G1: the SAME id as the entity this node represents. */
    id: text("id").primaryKey(),
    nodeType: orgNodeTypeEnum("node_type").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => orgNodesTable.id),
    /**
     * "/<rootId>/…/<selfId>/". Display, sort and debugging ONLY — never queried
     * with LIKE (G2). Kept because diagnosing a broken tree without it is misery.
     */
    path: text("path").notNull(),
    depth: integer("depth").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    /**
     * Mirrors the source row's active flag. Scope expansion does NOT traverse
     * inactive nodes, matching what food-service's expandZonesToCities already
     * does — a retired cluster must not keep conferring access to its properties.
     */
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("org_nodes_parent_idx").on(t.parentId),
    index("org_nodes_type_idx").on(t.nodeType),
    // Plain columns, plain IS NOT NULL predicate — the user_scopes idiom. An
    // expression index here would make every `push` DROP and re-CREATE it,
    // destroying "push says nothing to do" as a drift signal.
    uniqueIndex("org_nodes_type_code_uq").on(t.nodeType, t.code).where(sql`code is not null`),
  ],
);

export const orgNodeClosureTable = pgTable(
  "org_node_closure",
  {
    ancestorId: text("ancestor_id")
      .notNull()
      .references(() => orgNodesTable.id, { onDelete: "cascade" }),
    descendantId: text("descendant_id")
      .notNull()
      .references(() => orgNodesTable.id, { onDelete: "cascade" }),
    /** 0 on the self-row every node has. */
    depth: integer("depth").notNull(),
    pathKind: orgPathKindEnum("path_kind").notNull(),
  },
  (t) => [
    // pathKind is part of the key: a property is reachable from its city BOTH
    // structurally and (via a kitchen) as a served node, and those are different
    // facts that must both be storable.
    primaryKey({ columns: [t.ancestorId, t.descendantId, t.pathKind] }),
    index("org_node_closure_descendant_idx").on(t.descendantId, t.pathKind),
  ],
);

/* ── Grants ───────────────────────────────────────────────────────────────── */

export const accessGrantsTable = pgTable(
  "access_grants",
  {
    id: text("id").primaryKey(),
    subjectType: accessSubjectTypeEnum("subject_type").notNull(),
    /** users.id when USER; access_roles.key when ROLE. */
    subjectId: text("subject_id").notNull(),
    /**
     * The role this grant confers. '*' means "the subject's own users.role".
     *
     * NOT NULL with a sentinel rather than nullable, deliberately: the unique
     * indexes below would otherwise need the NULLS-DISTINCT dance that forced
     * user_scopes into six paired partial indexes.
     */
    roleKey: text("role_key").default("*").notNull(),
    /** null = the whole organization. Subsumes the PRD's GLOBAL / "Organization". */
    nodeId: text("node_id").references(() => orgNodesTable.id),
    /**
     * false ⇒ EXACTLY this node, which is what the PRD's "Specific Building /
     * Floor / Room" scopes are. Defaults true because every grant migrating in
     * from user_scopes/audit_role_grants is subtree-shaped; the mint endpoint
     * refuses true on a ROOM or BED node so the default cannot silently widen a
     * deliberately narrow grant.
     */
    includeDescendants: boolean("include_descendants").default(true).notNull(),
    /**
     * Traverse SERVES edges as well as TREE.
     *
     * Defaults FALSE on purpose. Only the food spine follows kitchens today; if
     * this defaulted true, an audit CITY grant would silently pick up
     * kitchen-served properties outside its own cluster. food-scope.test.ts's
     * `p-hyd-outsider` fixture exists precisely because the two spines disagree
     * in live data. Only the food backfill sets this true.
     */
    followLinks: boolean("follow_links").default(false).notNull(),
    dataScope: accessDataScopeEnum("data_scope").default("ALL").notNull(),
    /**
     * Module-defined discriminators, e.g. the audit module reads these as its
     * audit types (["UL","CM"]) — the generalized replacement for
     * audit_role_grants.auditTypes.
     *
     * $defaultFn, NOT a column DEFAULT: drizzle-kit cannot round-trip an array
     * default, which is the other way this repo has lost its push drift signal.
     */
    qualifiers: json("qualifiers").$type<string[]>().$defaultFn(() => []).notNull(),
    assignmentKind: accessAssignmentKindEnum("assignment_kind").default("GRANT").notNull(),
    /* Validity window — carried over from audit_role_grants, which had it, and
     * granted to the food side, which did not. Expiry takes effect immediately
     * by predicate; the daily sweep only writes the event. */
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    /** Soft revoke. Carries strictly more information than user_scopes.isActive. */
    revokedAt: timestamp("revoked_at"),
    revokedBy: text("revoked_by"),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    /** Stamped by the expiry sweep so it does not re-emit the same event. */
    expiryEventAt: timestamp("expiry_event_at"),
  },
  (t) => [
    index("access_grants_subject_idx").on(t.subjectType, t.subjectId),
    index("access_grants_node_idx").on(t.nodeId),
    // Two paired partial uniques, not six: roleKey's '*' sentinel means no
    // column in the key is ever NULL except nodeId, which the predicates split.
    // Fixes audit_role_grants having NO uniqueness at all (duplicate grants were
    // insertable, making "revoke the grant" ambiguous).
    uniqueIndex("access_grants_node_uq")
      .on(t.subjectType, t.subjectId, t.roleKey, t.nodeId, t.dataScope)
      .where(sql`node_id is not null and revoked_at is null`),
    uniqueIndex("access_grants_org_uq")
      .on(t.subjectType, t.subjectId, t.roleKey, t.dataScope)
      .where(sql`node_id is null and revoked_at is null`),
  ],
);

/* ── Roles and the capability matrix (hybrid: ceiling in code, cells in data) ── */

export const accessRolesTable = pgTable("access_roles", {
  /** SCREAMING_SNAKE, joinable to users.role_key. e.g. "WARDEN", "AUDIT.AUDITOR". */
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  /**
   * null for a platform role (users.role). Non-null names the module a role
   * belongs to — this is how audit_role_grants' ADMIN/SCHEDULER/AUDITOR/AUDITEE/
   * REVIEWER/VIEWER become data instead of a second parallel enum.
   */
  scopeModule: text("scope_module"),
  /** Replaces ROLE_RANK in lib/authz.ts — the third of four role taxonomies. */
  rank: integer("rank").default(0).notNull(),
  /**
   * The built-ins whose cells are COMPUTED, never stored (SUPER_ADMIN,
   * OPS_EXCELLENCE, AUDIT_READONLY). The matrix editor refuses every write
   * against them: that, not a reachability check, is the real lockout backstop.
   */
  isSystem: boolean("is_system").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const accessRolePermissionsTable = pgTable(
  "access_role_permissions",
  {
    id: text("id").primaryKey(),
    /** Plain text, not an FK: must survive a role rename debate, and the
     *  push-force-while-serving deploy model punishes FK churn. */
    roleKey: text("role_key").notNull(),
    /** Plain text, NOT an enum — adding a module must never need a DB migration. */
    module: text("module").notNull(),
    action: accessActionEnum("action").notNull(),
    allowed: boolean("allowed").default(true).notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("access_role_permissions_uq").on(t.roleKey, t.module, t.action),
    index("access_role_permissions_role_idx").on(t.roleKey),
  ],
);

/**
 * Per-EMPLOYEE overrides on top of the role matrix.
 *
 * The role answers "what may a warden do?"; this answers "what may THIS warden
 * do that other wardens may not?". Inheritance is preserved for everything not
 * listed here, which is the whole point: editing the WARDEN row still reaches
 * every warden, including the ones carrying an override on a different cell.
 *
 * Resolution order in decide(): DENY beats GRANT beats the role. A row is
 * therefore the ONLY way one person's answer differs from their role's, which
 * keeps "why can she do this?" a one-query question.
 *
 * Deliberately NOT soft-deleted. Clearing an override means the person returns
 * to their role's answer, and a revoked_at row that no longer affects anything
 * would still show up in every "who has exceptions?" review. The history lives
 * on the hash-chained ACCESS stream, which is the copy that must survive.
 */
export const accessUserPermissionsTable = pgTable(
  "access_user_permissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Plain text, mirroring access_role_permissions — a new module is never a migration. */
    module: text("module").notNull(),
    action: accessActionEnum("action").notNull(),
    effect: accessOverrideEffectEnum("effect").notNull(),
    /** NOT NULL: an exception nobody can account for later is the failure mode. */
    reason: text("reason").notNull(),
    /* Same validity window as a grant, so "cover for two weeks" is expressible
     * without anyone having to remember to take it away. */
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // One live answer per cell per person. No partial predicate needed, because
    // clearing an override deletes the row rather than revoking it.
    uniqueIndex("access_user_permissions_uq").on(t.userId, t.module, t.action),
    index("access_user_permissions_user_idx").on(t.userId),
  ],
);

/**
 * Single row, id = 'singleton'. Bumped in the same transaction as any matrix or
 * role write; the process-level matrix cache and the /auth/me access blob both
 * compare against it, so a stale client can detect it is stale rather than
 * silently acting on an old answer.
 */
export const accessMatrixVersionTable = pgTable("access_matrix_version", {
  id: text("id").primaryKey(),
  version: bigint("version", { mode: "number" }).default(0).notNull(),
  updatedBy: text("updated_by").references(() => usersTable.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Types shared with the resolver ───────────────────────────────────────── */

export type OrgNodeType = (typeof orgNodeTypeEnum.enumValues)[number];
export type OrgPathKind = (typeof orgPathKindEnum.enumValues)[number];
export type AccessAction = (typeof accessActionEnum.enumValues)[number];
export type AccessDataScope = (typeof accessDataScopeEnum.enumValues)[number];
export type AccessSubjectType = (typeof accessSubjectTypeEnum.enumValues)[number];
export type AccessAssignmentKind = (typeof accessAssignmentKindEnum.enumValues)[number];
export type AccessOverrideEffect = (typeof accessOverrideEffectEnum.enumValues)[number];
