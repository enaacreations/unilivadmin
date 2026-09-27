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
 * Actions are NAMED PER FUNCTIONALITY, not drawn from one global list.
 *
 * "Create a property" and "start an audit" are not the same verb wearing two
 * hats, and `FOOD_CONFIRM_DELIVERY.delete` was never a thing anyone could do —
 * a shared enum of thirteen verbs made both look like ordinary cells. The
 * per-functionality manifest (FUNCTIONALITY_ACTIONS in
 * apps/api-server/src/lib/permissions.ts) is the source of truth, and it is
 * code-owned, so:
 *
 *   - a functionality naming a new action is a code change, never a migration
 *   - a stored action the manifest does not name is INERT, not a grant
 *
 * Stored as text for exactly the reason `functionality` is. See the header
 * comment in permissions.ts: module (10) → functionality (56) → named action.
 */

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
export const privilegeEffectEnum = pgEnum("privilege_effect", ["GRANT", "DENY"]);

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

/**
 * Role MEMBERSHIP — the many-to-many that replaces users.role.
 *
 * Deliberately NOT folded into access_grants, even though a grant already has
 * the shape (subject × role × node). A grant with a null nodeId means
 * ORGANIZATION-WIDE SCOPE, and assertGrantIsSafe restricts that to parity roles
 * — so expressing "this person is a Warden" as a grant would make ordinary role
 * assignment a super-admin-only action.
 *
 * Membership stays global; the property axis lives on access_privileges, which
 * is where the requirement actually puts it ("propertyId → functionality").
 * That split also leaves access_grants untouched, so the '*' sentinel keeps
 * working — it simply now reads as "the subject's own role SET".
 */
export const userRolesTable = pgTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** access_roles.key. Text, so a new role is never a pg enum migration. */
    roleKey: text("role_key").notNull(),
    /* Same validity window as a grant: "acting City Head until the 30th" should
     * not depend on someone remembering to take it away. */
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    assignedBy: text("assigned_by"),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
    /*
     * Revoked, not deleted.
     *
     * A hard DELETE erased the fact that someone ever held the role — and
     * "did she have Warden in March?" is exactly the question asked after an
     * incident. The row survives with the answer attached: who turned it off,
     * when, and the reason they gave.
     *
     * readRoles() filters on isActive, so a revoked row grants nothing the
     * moment it flips. Re-granting the same role reuses this row (the unique
     * index makes that the only option) rather than inserting a second one.
     */
    isActive: boolean("is_active").default(true).notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    uniqueIndex("user_roles_uq").on(t.userId, t.roleKey),
    index("user_roles_user_idx").on(t.userId),
  ],
);

/* ── Roles and the capability matrix (hybrid: ceiling in code, cells in data) ── */

export const rolesTable = pgTable("roles", {
  /** SCREAMING_SNAKE, joinable to users.role_key. e.g. "WARDEN", "AUDIT.AUDITOR". */
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  /**
   * null for a platform role (users.role). Non-null names the MODULE a role
   * belongs to — a key from the `Module` union, e.g. "AUDITS". This is how
   * audit_role_grants' ADMIN/SCHEDULER/AUDITOR/AUDITEE/REVIEWER/VIEWER become
   * data instead of a second parallel enum.
   *
   * Module keys are disjoint from functionality keys by construction, so this
   * column is never ambiguous about which level it names.
   */
  scopeModule: text("scope_module"),
  /** Replaces ROLE_RANK in lib/authz.ts — the third of four role taxonomies. */
  rank: integer("rank").default(0).notNull(),
  /**
   * The org level this role is HANDED OUT at — not a place, a level.
   *
   * A role never names a property (that is a per-user fact), but it does know
   * the rung it is granted on: a Cluster Manager is given a CLUSTER, a Zonal
   * Head a ZONE, a Unit Lead a PROPERTY. Attaching the role to a user asks for
   * a node of exactly this type, and everything beneath it resolves through the
   * closure table — so properties added to that cluster later are covered with
   * no re-tagging.
   *
   * null = the role carries no place at all (SUPER_ADMIN, FINANCE, HR_MANAGER —
   * the "independent" ones). Those users are org-wide or placed ad hoc.
   */
  anchorLevel: orgNodeTypeEnum("anchor_level"),
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

export const roleFunctionalitiesTable = pgTable(
  "role_functionalities",
  {
    id: text("id").primaryKey(),
    /** Plain text, not an FK: must survive a role rename debate, and the
     *  push-force-while-serving deploy model punishes FK churn. */
    roleKey: text("role_key").notNull(),
    /**
     * The functionality — the middle level of the vocabulary, and the unit that
     * is actually enforced. Plain text, NOT an enum: adding a functionality must
     * never need a DB migration, and the code-owned manifest
     * (ALL_FUNCTIONALITIES) is the ceiling that keeps a stale row inert.
     *
     * The MODULE it belongs to is deliberately NOT stored. It is derived from
     * the manifest (moduleOf), so there is no second copy to drift, and a
     * functionality moving between modules is a code change with no data
     * migration. Storing the parent would also make a module-level wildcard
     * tempting, which would silently grant functionalities added later.
     */
    functionality: text("functionality").notNull(),
    action: text("action").notNull(),
    allowed: boolean("allowed").default(true).notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("role_functionalities_uq").on(t.roleKey, t.functionality, t.action),
    index("role_functionalities_role_idx").on(t.roleKey),
  ],
);

/**
 * PRIVILEGES — property-scoped exceptions on top of the role matrix.
 *
 * The matrix answers "what may a WARDEN do?" globally. This answers the two
 * questions it cannot:
 *
 *   "what may THIS warden do that other wardens may not?"      (subjectType USER)
 *   "what may a warden do AT THIS PROPERTY specifically?"      (nodeId)
 *
 * which together make the requirement expressible: one Unit Lead with one
 * functionality at property A and a different one at property B — two rows,
 * same person, same role, different nodeId.
 *
 * Generalizes the old access_user_permissions in two directions at once:
 * subjectType (so a ROLE can carry scoped privileges too, not just a person)
 * and nodeId (so any privilege can be pinned to a place).
 *
 * Resolution order in decide(): more specific wins — user beats role, node
 * beats global — and at equal specificity DENY beats GRANT. A node privilege
 * applies to everything beneath that node, with the NEAREST ancestor winning,
 * so a property rule overrides a city rule.
 *
 * Deliberately NOT soft-deleted. Clearing a privilege returns the subject to
 * the layer beneath it, and a revoked row that no longer affects anything would
 * still show up in every "who has exceptions?" review. The history that must
 * survive lives on the hash-chained ACCESS stream.
 */
export const privilegesTable = pgTable(
  "privileges",
  {
    id: text("id").primaryKey(),
    subjectType: accessSubjectTypeEnum("subject_type").notNull(),
    /** users.id when USER; access_roles.key when ROLE. */
    subjectId: text("subject_id").notNull(),
    /**
     * WHICH ROLE this exception hangs under, or '*' for "regardless of role".
     *
     * Default '*' mirrors access_grants.role_key and is what every pre-existing
     * row means. A named role makes the exception legible on the screen it is
     * edited from — the per-property CRUD grid sits UNDER a role in the user's
     * Roles tab, so "delete complaints at Koramangala" is really "…as their
     * Unit Lead". It also makes the row die with the membership instead of
     * outliving it as an exception nobody can source.
     *
     * NOT NULL with a sentinel rather than nullable: Postgres treats NULLs as
     * distinct in a unique index, so a nullable column here would let ten
     * conflicting rules coexist on the same cell — the same trap the paired
     * partial uniques below already exist to close.
     */
    roleKey: text("role_key").default("*").notNull(),
    /** Plain text, mirroring role_functionalities — a new functionality is never a migration. */
    functionality: text("functionality").notNull(),
    action: text("action").notNull(),
    /** null = everywhere the subject can already reach. */
    nodeId: text("node_id").references(() => orgNodesTable.id),
    effect: privilegeEffectEnum("effect").notNull(),
    /** NOT NULL: an exception nobody can account for later is the failure mode. */
    reason: text("reason").notNull(),
    /**
     * The APPROVAL this exception was granted on — typically an exported email.
     *
     * `reason` is what the granter typed; this is the evidence behind it, which
     * is what an auditor asks for. Stored as an object key rather than a URL
     * because a URL goes stale and a signed one leaks: the key is resolved to a
     * short-lived link at read time, by whoever is allowed to read it.
     *
     * Nullable — most privileges are routine cover and need no paperwork.
     */
    approvalKey: text("approval_key"),
    approvalFilename: text("approval_filename"),
    approvalSize: integer("approval_size"),
    approvalUploadedBy: text("approval_uploaded_by"),
    approvalUploadedAt: timestamp("approval_uploaded_at"),
    /**
     * The set this privilege came from, when it was not written by hand.
     *
     * Rows expanded from a set carry it so the set can be re-expanded, and so
     * "why does this person have this?" answers "from the Night Audit Cover set"
     * rather than presenting it as somebody's individual decision.
     */
    fromSetId: text("from_set_id"),
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Two paired PARTIAL uniques rather than one: Postgres treats NULLs as
    // distinct in a unique index, so a plain unique including node_id would
    // happily accept ten conflicting "everywhere" rules for the same cell.
    // Same shape access_grants already uses for the same reason.
    uniqueIndex("privileges_node_uq")
      .on(t.subjectType, t.subjectId, t.roleKey, t.functionality, t.action, t.nodeId)
      .where(sql`node_id is not null`),
    uniqueIndex("privileges_global_uq")
      .on(t.subjectType, t.subjectId, t.roleKey, t.functionality, t.action)
      .where(sql`node_id is null`),
    index("privileges_subject_idx").on(t.subjectType, t.subjectId),
    index("privileges_node_idx").on(t.nodeId),
  ],
);


/* ── Privilege sets ───────────────────────────────────────────────────────── */

/**
 * A NAMED GROUP of primitive privileges — "Night audit cover", "Kitchen
 * close-out".
 *
 * The unit people actually reason about. Nobody asks for
 * `audits.audit_execution.close_audit`; they ask to let somebody cover the night
 * audit, which is six permissions that must travel together. Granting them one
 * at a time is how a person ends up with five of the six and a bug that looks
 * like a bug.
 *
 * ── Live reference, not a copy ────────────────────────────────────────────
 * Assigning a set stores a POINTER (see `userPrivilegeSetsTable`), and the
 * resolver expands it at read time. Editing a set therefore changes everyone
 * holding it, which is the whole point: when a permission is added to "Night
 * audit cover", the people covering the night audit get it. The cost is that an
 * edit is a wide change, so the UI says how many people it reaches before it
 * saves — the same warning a role edit gets, for the same reason.
 */
export const privilegeSetsTable = pgTable(
  "privilege_sets",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** Stable, human-typed: `night-audit-cover`. Referenced in tickets. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** What this set is FOR — shown wherever it is offered, so it is not optional. */
    description: text("description").notNull(),
    /**
     * GRANT sets add; DENY sets take away. One effect for the whole set: a set
     * mixing both reads as a rule nobody can predict, and the two halves would
     * resolve at different points in the ladder anyway.
     */
    effect: privilegeEffectEnum("effect").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("privilege_sets_key_uq").on(t.key)],
);

/** One primitive permission inside a set. */
export const privilegeSetItemsTable = pgTable(
  "privilege_set_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    setId: text("set_id").notNull().references(() => privilegeSetsTable.id, { onDelete: "cascade" }),
    /** Text for the same reason everywhere else: a new functionality is never a migration. */
    functionality: text("functionality").notNull(),
    action: text("action").notNull(),
  },
  (t) => [
    uniqueIndex("privilege_set_items_uq").on(t.setId, t.functionality, t.action),
    index("privilege_set_items_set_idx").on(t.setId),
  ],
);

/**
 * A set assigned to a subject — a person or a role — optionally at one place.
 *
 * Deliberately the same shape as a privilege: subject, role it hangs under,
 * node, validity window and a reason. A set is a bundle of privileges, so the
 * things that qualify one qualify all of them, and the resolver can expand a
 * row here into privileges without inventing any of those fields.
 */
export const privilegeSetAssignmentsTable = pgTable(
  "privilege_set_assignments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    setId: text("set_id").notNull().references(() => privilegeSetsTable.id, { onDelete: "cascade" }),
    subjectType: accessSubjectTypeEnum("subject_type").notNull(),
    /** users.id when USER; access_roles.key when ROLE. */
    subjectId: text("subject_id").notNull(),
    roleKey: text("role_key").default("*").notNull(),
    /** null = everywhere the subject can already reach. */
    nodeId: text("node_id").references(() => orgNodesTable.id),
    reason: text("reason").notNull(),
    approvalKey: text("approval_key"),
    approvalFilename: text("approval_filename"),
    approvalSize: integer("approval_size"),
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    uniqueIndex("privilege_set_assignments_node_uq")
      .on(t.setId, t.subjectType, t.subjectId, t.roleKey, t.nodeId)
      .where(sql`node_id is not null and revoked_at is null`),
    uniqueIndex("privilege_set_assignments_global_uq")
      .on(t.setId, t.subjectType, t.subjectId, t.roleKey)
      .where(sql`node_id is null and revoked_at is null`),
    index("privilege_set_assignments_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

export type PrivilegeSet = typeof privilegeSetsTable.$inferSelect;
export type PrivilegeSetItem = typeof privilegeSetItemsTable.$inferSelect;
export type PrivilegeSetAssignment = typeof privilegeSetAssignmentsTable.$inferSelect;

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
/** A named action key, e.g. `add_property`. Validated against the manifest, not the DB. */
export type AccessAction = string;
export type AccessDataScope = (typeof accessDataScopeEnum.enumValues)[number];
export type AccessSubjectType = (typeof accessSubjectTypeEnum.enumValues)[number];
export type AccessAssignmentKind = (typeof accessAssignmentKindEnum.enumValues)[number];
export type AccessOverrideEffect = (typeof privilegeEffectEnum.enumValues)[number];
export type AccessPrivilege = typeof privilegesTable.$inferSelect;
export type UserRoleRow = typeof userRolesTable.$inferSelect;
