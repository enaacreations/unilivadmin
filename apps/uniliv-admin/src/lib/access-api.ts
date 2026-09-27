/**
 * Access Control API client (PRD §30/§31).
 *
 * Follows the food-api.ts / masters-api.ts convention: apiFetch + `.then` unwrap,
 * structured query keys. These endpoints are not in openapi.yaml — like the rest
 * of the audit and food surfaces, they are hand-written.
 */
import { apiFetch } from "@/lib/api-fetch";

type ApiOne<T> = { success: boolean; data: T };

/** Mirrors ReasonCode in apps/api-server/src/lib/access/decide.ts. */
export type ReasonCode =
  | "ALLOW_SYSTEM_ROLE"
  | "ALLOW_ROLE_CAPABILITY"
  | "ALLOW_IMPLIED_CAPABILITY"
  | "ALLOW_USER_OVERRIDE"
  | "ALLOW_ROLE_PRIVILEGE"
  | "DENY_UNKNOWN_FUNCTIONALITY"
  | "DENY_ACTION_NOT_ON_FUNCTIONALITY"
  | "DENY_ROLE_LACKS_CAPABILITY"
  | "DENY_USER_OVERRIDE"
  | "DENY_ROLE_PRIVILEGE"
  | "DENY_NO_GRANT"
  | "DENY_NODE_OUT_OF_SCOPE"
  | "DENY_DATA_SCOPE";

export interface AccessUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleKey: string | null;
  propertyId: string | null;
  isActive: boolean;
}

export interface OrgNode {
  id: string;
  nodeType: string;
  parentId: string | null;
  name: string;
  depth: number;
  isActive: boolean;
}

export interface AccessGrantRow {
  id: string;
  subjectType: string;
  subjectId: string;
  roleKey: string;
  nodeId: string | null;
  includeDescendants: boolean;
  followLinks: boolean;
  dataScope: string;
  qualifiers: string[];
  assignmentKind: string;
  effectiveFrom: string;
  expiresAt: string | null;
  revokedAt: string | null;
  nodeName: string | null;
  nodeType: string | null;
  userName: string | null;
  userEmail: string | null;
}

export interface PreviewAction extends Pick<NamedAction, "label" | "description" | "id"> {
  action: string;
  allow: boolean;
  reason: ReasonCode;
  detail: string;
  via: string | null;
}

export interface PreviewFunctionality {
  key: string;
  label: string;
  noAccess: boolean;
  actions: PreviewAction[];
}

/**
 * A module row in the preview. `noAccess` / `heldCount` are FOLDS the server
 * computed from the functionality rows below — they let the UI collapse a wholly
 * denied module to one line without walking its children, and they are never a
 * separate answer.
 */
export interface PreviewModule {
  key: string;
  label: string;
  noAccess: boolean;
  heldCount: number;
  totalCount: number;
  functionalities: PreviewFunctionality[];
}

export interface AccessPreview {
  subject: { id: string; name: string; email: string; role: string; roleKey: string; isActive: boolean };
  evaluatedAt: string;
  evaluatedAtNode: string | null;
  scope: {
    unrestricted: boolean;
    nodeIds: string[] | null;
    propertyIds: string[] | null;
    kitchenIds: string[] | null;
    dataScope: string;
  };
  grants: Array<{ roleKey: string; nodeIds: string[] | null; propertyIds: string[] | null; dataScope: string; qualifiers: string[]; assignmentKind: string }>;
  nodes: Array<{ id: string; name: string; level: string }> | null;
  modules: PreviewModule[];
}

/** The rungs of the org tree a role can be handed out on. */
export type AnchorLevel = "ZONE" | "CITY" | "CLUSTER" | "KITCHEN" | "PROPERTY";

export const ANCHOR_WORD: Record<AnchorLevel, string> = {
  ZONE: "zone",
  CITY: "city",
  CLUSTER: "cluster",
  KITCHEN: "kitchen",
  PROPERTY: "property",
};

/** One place a role was handed out at, for one person. */
export interface RoleAnchor {
  id: string;
  name: string;
  nodeType: string;
  /** false = an older placement that applies whatever role they hold. */
  scopedToRole: boolean;
  includeDescendants: boolean;
}

/** A property a role reaches, and the anchor it came through. */
export interface RoleProperty {
  id: string;
  name: string;
  viaId: string;
  viaName: string;
  viaType: string;
}

export interface RoleTreeEntry {
  roleKey: string;
  label: string;
  anchorLevel: AnchorLevel | null;
  isSystem: boolean;
  anchors: RoleAnchor[];
  properties: RoleProperty[];
}

export interface RoleTree {
  user: { id: string; name: string; email: string };
  roles: RoleTreeEntry[];
}

/** One CRUD cell of the per-property grid. */
export interface GridCell extends Pick<NamedAction, "label" | "description" | "id"> {
  action: string;
  /**
   * false = the manifest no longer names this action. The server sends only
   * real permissions, so this is for cells the CLIENT builds from stored grants:
   * such a row is shown struck through, because a grant nobody can see is a
   * grant nobody will remove.
   */
  inManifest: boolean;
  /** What THIS role's matrix gives — what makes one role's grid differ. */
  roleAllows: boolean;
  /** What the person actually gets here, across every role plus exceptions. */
  allowed: boolean;
  reason: string;
  detail: string;
}

export interface GridFunctionality {
  functionality: string;
  label: string;
  cells: GridCell[];
}

export interface GridModule {
  key: string;
  label: string;
  functionalities: GridFunctionality[];
}

/** One person a role change would reach. */
export interface RoleHolderImpact {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  /** This is the role their account resolves as — the highest-ranked they hold. */
  isPrimary: boolean;
  otherRoles: string[];
  /** Nothing else to fall back on if this role stops giving anything. */
  losesEverything: boolean;
}

export interface RoleImpact {
  roleKey: string;
  label: string;
  isActive: boolean;
  isSystem: boolean;
  counts: { holders: number; primary: number; losesEverything: number; activeHolders: number };
  holders: RoleHolderImpact[];
}

/** A per-employee exception to their role's matrix. */
export interface UserOverride {
  id: string;
  userId: string;
  functionality: string;
  /** Display name for the functionality, resolved server-side. */
  label: string;
  /** The module it belongs to — derived server-side from the functionality. */
  module: string;
  action: string;
  effect: "GRANT" | "DENY";
  reason: string;
  effectiveFrom: string;
  expiresAt: string | null;
  grantedBy: string | null;
  grantedAt: string;
  /** Whether it is inside its validity window right now. */
  live: boolean;
}

/** The dry run behind "copy this person's access". */
export interface CloneAccessPlan {
  from: { id: string; name: string; email: string; role: string };
  to: { id: string; name: string; email: string; role: string };
  /** Role SETS, since a user holds several. */
  role: { current: string[]; incoming: string[]; changes: boolean };
  grants: {
    incoming: Array<{ roleKey: string; nodeId: string | null; nodeName: string | null; assignmentKind: string; dataScope: string; includeDescendants: boolean; expiresAt: string | null }>;
    replacing: Array<{ roleKey: string; nodeId: string | null; nodeName: string | null; assignmentKind: string; dataScope: string; includeDescendants: boolean; expiresAt: string | null }>;
  };
  overrides: {
    incoming: Array<{ functionality: string; label: string; module: string; action: string; effect: string; reason: string; expiresAt: string | null }>;
    replacing: Array<{ functionality: string; label: string; module: string; action: string; effect: string }>;
  };
}

/** A role a user holds. Users hold a set; capability is the union. */
export interface HeldRole {
  roleKey: string;
  label: string | null;
  rank: number | null;
  /** Whether the ROLE is enabled for everyone — not this person's membership. */
  isActive: boolean | null;
  assignedAt: string;
  expiresAt: string | null;
  /** Whether THIS person's membership is on. Revoked rows survive, switched off. */
  held: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  live: boolean;
}

/** A property-scoped access right, on a user or on a role. */
export interface Privilege {
  id: string;
  subjectType: "USER" | "ROLE";
  subjectId: string;
  /** The FUNCTIONALITY the exception is on — the enforced unit. */
  functionality: string;
  /** Its display name, resolved server-side. */
  label: string;
  /** The module it belongs to, derived server-side. For grouping only. */
  module: string;
  moduleLabel: string;
  action: string;
  nodeId: string | null;
  nodeName: string | null;
  nodeType: string | null;
  effect: "GRANT" | "DENY";
  reason: string;
  effectiveFrom: string;
  expiresAt: string | null;
  /** True when it came from a role the user holds rather than the user. */
  inherited?: boolean;
  live: boolean;
  /** The permission's own words, from the manifest. */
  actionLabel: string;
  actionDescription: string;
  permissionId: string;
  /** The approval it was granted on. The link is short-lived and minted per read. */
  approvalFilename: string | null;
  approvalSize: number | null;
  approvalUrl: string | null;
}

export interface UamUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  designation: string | null;
  phone: string | null;
  role: string;
  propertyId: string | null;
  isActive: boolean;
  userType: "INTERNAL" | "EXTERNAL";
  dob: string | null;
  gender: string | null;
  lastLogin: string | null;
  createdAt: string;
}

export interface UamUserDetail extends UamUser {
  roles: HeldRole[];
  privileges: Privilege[];
}

/** The list view counts holders; the detail view names them. */
export interface RoleDetail extends Omit<AccessRole, "holders"> {
  permissions: Array<{ functionality: string; action: string; label: string; module: string }>;
  holders: Array<{ id: string; name: string; email: string; isActive: boolean }>;
  privileges: Privilege[];
}

/**
 * One permission, as the server names it.
 *
 * `key` is the action ("add_property"), `id` the full identifier
 * ("operations.properties.add_property"), and `description` the single line the
 * UI shows wherever this access is granted, listed or explained. All three come
 * from the server so the words on the screen and the rule being enforced cannot
 * drift apart.
 */
export interface NamedAction {
  key: string;
  label: string;
  description: string;
  id: string;
}

export interface ManifestFunctionality {
  key: string;
  label: string;
  /** The module that owns it. */
  module: string;
  /** The permissions THIS functionality defines — not a shared verb list. */
  actions: NamedAction[];
  /** Only a parity role may change this cell. */
  protected: boolean;
}

export interface ManifestModule {
  key: string;
  label: string;
  description: string;
  functionalities: ManifestFunctionality[];
}

/**
 * The access vocabulary, as the three-level tree the server declares:
 * module → functionality → action.
 *
 * `functionalities` is the same set flattened, for the screens that legitimately
 * want one list (the privilege picker, the preview filter) — served rather than
 * re-derived so the two orders cannot diverge.
 */
export interface Manifest {
  modules: ManifestModule[];
  functionalities: ManifestFunctionality[];
}

export interface AccessRole {
  key: string;
  label: string;
  /** Non-null for a MODULE role (a persona inside one module, e.g. Auditor) — a
   *  Module key such as "AUDITS". */
  scopeModule: string | null;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  computed: boolean;
  holders: number;
  cells: number | null;
  /** The rung this role is handed out on; null = it carries no place at all. */
  anchorLevel: AnchorLevel | null;
}

/** A cell is (role, functionality, action). The module is derived, never sent. */
export interface MatrixCell {
  roleKey: string;
  functionality: string;
  action: string;
  computed: boolean;
}

export interface MatrixResponse {
  version: number;
  source: "db" | "code";
  modules: Array<{
    key: string;
    label: string;
    functionalities: Array<{ key: string; label: string; actions: NamedAction[]; protected: boolean }>;
  }>;
  cells: MatrixCell[];
}

export interface ActivityEvent {
  id: string;
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  event: string;
  category: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  propertyId: string | null;
  fromState: string | null;
  toState: string | null;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  changedKeys: string[] | null;
  reason: string | null;
  chainKey: string | null;
  hash: string | null;
  prevHash: string | null;
}

/**
 * Display names for the ids that appear inside a row's before/after payload,
 * resolved server-side (see api-server lib/activity/labels.ts). Keyed by id;
 * an id with no entry is one nothing could be found for and is shown raw.
 */
export interface ActivityLabel {
  label: string;
  kind: "node" | "user" | "property";
  subtype?: string;
}

export interface ActivityFacets {
  events: Array<{ key: string; category: string; entityType: string; reasonRequired: boolean; chained: boolean }>;
  categories: string[];
  entityTypes: string[];
}

export const activityKeys = {
  facets: () => ["activity", "facets"] as const,
  list: (p: Record<string, string>) => ["activity", "list", p] as const,
  verify: (chainKey: string) => ["activity", "verify", chainKey] as const,
};

export const activityApi = {
  facets: () => apiFetch<ApiOne<ActivityFacets>>("/activity/facets").then((r) => r.data),
  list: (params: Record<string, string>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return apiFetch<{
      success: boolean;
      data: ActivityEvent[];
      labels: Record<string, ActivityLabel>;
      meta: { total: number };
    }>(`/activity${qs ? `?${qs}` : ""}`);
  },
  verify: (chainKey = "ACCESS") =>
    apiFetch<ApiOne<{ chainKey: string; checked: number; valid: boolean; firstBrokenSeq: number | null }>>(
      `/activity/verify?chainKey=${encodeURIComponent(chainKey)}`,
    ).then((r) => r.data),
};

/* ── The permission catalogue and privilege sets ──────────────────────────── */

/** One row of the Privileges tab: a permission the system defines, and its use. */
export interface CataloguePermission extends NamedAction {
  functionality: string;
  functionalityLabel: string;
  module: string;
  moduleLabel: string;
  action: string;
  /** The roles whose matrix grants it — empty means no role does. */
  roles: string[];
  /** How many privileges are written against it, in either direction. */
  exceptions: number;
}

/** A permission inside a set, with the words every screen shows for it. */
export interface PrivilegeSetItem extends NamedAction {
  functionality: string;
  functionalityLabel: string;
  module: string;
  action: string;
  /** false = the manifest no longer names it; shown struck through, not dropped. */
  inManifest: boolean;
}

/**
 * A named group of permissions.
 *
 * `holders` is the blast radius: a set is a LIVE reference, so editing it
 * changes everyone holding it. The number is shown before an edit saves, for the
 * same reason a role edit shows one.
 */
export interface PrivilegeSet {
  id: string;
  key: string;
  name: string;
  description: string;
  effect: "GRANT" | "DENY";
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  items: PrivilegeSetItem[];
  holders: number;
}

/** A set as held by one subject. */
export interface HeldPrivilegeSet {
  assignmentId: string;
  setId: string;
  key: string;
  name: string;
  description: string;
  effect: "GRANT" | "DENY";
  isActive: boolean;
  roleKey: string;
  nodeId: string | null;
  reason: string;
  expiresAt: string | null;
  approvalFilename: string | null;
  approvalUrl: string | null;
  items: PrivilegeSetItem[];
}

/** The approval a privilege was granted on, as the browser hands it over. */
export interface ApprovalUpload {
  /** `data:<mime>;base64,<payload>` — the same convention audit evidence uses. */
  dataUrl: string;
  filename: string;
}

export const accessKeys = {
  manifest: () => ["access", "manifest"] as const,
  roles: () => ["access", "roles"] as const,
  matrix: (roleKey?: string) => ["access", "matrix", roleKey ?? "all"] as const,
  assignments: (userId: string) => ["access", "assignments", userId] as const,
  users: () => ["access", "users"] as const,
  nodes: () => ["access", "nodes"] as const,
  grants: (subjectId?: string) => ["access", "grants", subjectId ?? "all"] as const,
  preview: (userId: string, nodeId: string | null) => ["access", "preview", userId, nodeId ?? "any"] as const,
  privileges: (subjectType: string, subjectId: string) => ["access", "privileges", subjectType, subjectId] as const,
  roleDetail: (key: string) => ["access", "role", key] as const,
  roleImpact: (key: string) => ["access", "role-impact", key] as const,
  userTree: (userId: string) => ["access", "user-tree", userId] as const,
  userGrid: (userId: string, roleKey: string, nodeId: string) => ["access", "user-grid", userId, roleKey, nodeId] as const,
  clonePlan: (from: string, to: string) => ["access", "clone-plan", from, to] as const,
  catalogue: () => ["access", "privilege-catalogue"] as const,
  privilegeSets: () => ["access", "privilege-sets"] as const,
  heldSets: (subjectId: string) => ["access", "privilege-sets", "held", subjectId] as const,
  setHolders: (setId: string) => ["access", "privilege-sets", setId, "holders"] as const,
  uamUsers: (q: Record<string, string>) => ["uam", "users", q] as const,
  uamUser: (id: string) => ["uam", "user", id] as const,
};

export const uamApi = {
  users: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return apiFetch<{ success: boolean; data: UamUser[]; meta: { total: number } }>(`/users${qs ? `?${qs}` : ""}`);
  },
  user: (id: string) => apiFetch<ApiOne<UamUserDetail>>(`/users/${encodeURIComponent(id)}`).then((r) => r.data),
  createUser: (body: Record<string, unknown>) =>
    apiFetch<ApiOne<UamUser & { roles: string[]; copiedPrivileges: number; generatedPassword?: string }>>("/users", {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => r.data),
  updateUser: (id: string, body: Record<string, unknown>) =>
    apiFetch<ApiOne<UamUser>>(`/users/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
  deactivateUser: (id: string, reason: string) =>
    apiFetch<ApiOne<UamUser>>(`/users/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ reason }) }).then((r) => r.data),
  /** `nodeIds` are the places this role is handed out at — a cluster for a
   *  Cluster Manager, one or more properties for a Unit Lead. Omitted for a
   *  role that carries no place of its own. */
  addRole: (id: string, roleKey: string, reason?: string, nodeIds?: string[]) =>
    apiFetch<ApiOne<{ roles: string[] }>>(`/users/${encodeURIComponent(id)}/roles`, {
      method: "POST", body: JSON.stringify({ roleKey, reason, nodeIds }),
    }).then((r) => r.data),
  /** Revokes, keeping the row. The reason is required by the server. */
  removeRole: (id: string, roleKey: string, reason: string) =>
    apiFetch<ApiOne<{ roles: string[] }>>(`/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleKey)}`, {
      method: "DELETE", body: JSON.stringify({ reason }),
    }).then((r) => r.data),
};

export const accessApi = {
  manifest: () => apiFetch<ApiOne<Manifest>>("/access/manifest").then((r) => r.data),
  roles: () => apiFetch<ApiOne<AccessRole[]>>("/access/roles").then((r) => r.data),
  matrix: (roleKey?: string) =>
    apiFetch<ApiOne<MatrixResponse>>(`/access/matrix${roleKey ? `?roleKey=${encodeURIComponent(roleKey)}` : ""}`).then((r) => r.data),
  saveMatrix: (body: { version: number; reason: string; changes: Array<{ roleKey: string; functionality: string; action: string; allowed: boolean }> }) =>
    apiFetch<ApiOne<{ version: number; applied: number }>>("/access/matrix", {
      method: "PUT", body: JSON.stringify(body),
    }).then((r) => r.data),
  createGrant: (body: {
    subjectId: string; roleKey: string; nodeId: string | null;
    includeDescendants: boolean; followLinks: boolean; dataScope: string;
    assignmentKind?: string; expiresAt?: string | null;
  }) => apiFetch<ApiOne<AccessGrantRow>>("/access/grants", { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  revokeGrant: (id: string, reason: string) =>
    apiFetch<ApiOne<AccessGrantRow>>(`/access/grants/${id}/revoke`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
  restoreGrant: (id: string, reason: string) =>
    apiFetch<ApiOne<AccessGrantRow>>(`/access/grants/${id}/restore`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
  assignments: (userId: string) =>
    apiFetch<ApiOne<{ primary: { id: string; nodeId: string; nodeName: string } | null; secondary: Array<{ id: string; nodeId: string; nodeName: string }> }>>(
      `/access/assignments/${encodeURIComponent(userId)}`,
    ).then((r) => r.data),
  setAssignments: (userId: string, body: { primaryNodeId: string | null; secondaryNodeIds: string[]; reason: string }) =>
    apiFetch<ApiOne<unknown>>(`/access/assignments/${encodeURIComponent(userId)}`, {
      method: "PUT", body: JSON.stringify(body),
    }).then((r) => r.data),
  createRole: (body: { key: string; label?: string; cloneFrom?: string; reason: string; anchorLevel?: AnchorLevel | null }) =>
    apiFetch<ApiOne<{ role: AccessRole; clonedCells: number; version: number }>>("/access/roles", {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => r.data),
  catalogue: () =>
    apiFetch<ApiOne<{ permissions: CataloguePermission[]; total: number }>>("/access/privilege-catalogue")
      .then((r) => r.data),
  privilegeSets: () =>
    apiFetch<ApiOne<PrivilegeSet[]>>("/access/privilege-sets").then((r) => r.data),
  heldSets: (subjectId: string) =>
    apiFetch<ApiOne<HeldPrivilegeSet[]>>(`/access/privilege-sets/held/${encodeURIComponent(subjectId)}`)
      .then((r) => r.data),
  setHolders: (setId: string) =>
    apiFetch<ApiOne<Array<{ assignmentId: string; subjectType: string; subjectId: string; name: string | null; email: string | null; nodeId: string | null; expiresAt: string | null }>>>(
      `/access/privilege-sets/${setId}/holders`,
    ).then((r) => r.data),
  createPrivilegeSet: (body: {
    name: string; description: string; effect: "GRANT" | "DENY";
    items: Array<{ functionality: string; action: string }>;
  }) =>
    apiFetch<ApiOne<{ id: string; key: string }>>("/access/privilege-sets", {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => r.data),
  updatePrivilegeSet: (id: string, body: {
    name: string; description: string; effect: "GRANT" | "DENY"; isActive?: boolean;
    items: Array<{ functionality: string; action: string }>;
  }) =>
    apiFetch<ApiOne<{ id: string; holders: number }>>(`/access/privilege-sets/${id}`, {
      method: "PUT", body: JSON.stringify(body),
    }).then((r) => r.data),
  assignPrivilegeSet: (id: string, body: {
    subjectType: "USER" | "ROLE"; subjectId: string; roleKey?: string;
    nodeId?: string | null; reason: string; expiresAt?: string | null;
    approval?: ApprovalUpload | null;
  }) =>
    apiFetch<ApiOne<{ id: string }>>(`/access/privilege-sets/${id}/assign`, {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => r.data),
  revokePrivilegeSet: (assignmentId: string, reason: string) =>
    apiFetch<ApiOne<unknown>>(`/access/privilege-set-assignments/${assignmentId}`, {
      method: "DELETE", body: JSON.stringify({ reason }),
    }),
  privileges: (subjectType: "USER" | "ROLE", subjectId: string) =>
    apiFetch<ApiOne<{ heldRoles: string[]; privileges: Privilege[] }>>(
      `/access/privileges?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`,
    ).then((r) => r.data),
  setPrivilege: (body: {
    subjectType: "USER" | "ROLE";
    subjectId: string;
    functionality: string;
    action: string;
    nodeId?: string | null;
    effect: "GRANT" | "DENY" | "INHERIT";
    reason: string;
    expiresAt?: string | null;
    /** The email or document this was approved on. Optional — most need none. */
    approval?: ApprovalUpload | null;
  }) =>
    apiFetch<ApiOne<{ effect: string; functionality: string; action: string; baseAllows: boolean }>>(
      "/access/privileges",
      { method: "PUT", body: JSON.stringify(body) },
    ).then((r) => r.data),
  /** The Roles tab: every role, the places it was handed out at, and what those reach. */
  userTree: (userId: string) =>
    apiFetch<ApiOne<RoleTree>>(`/access/users/${encodeURIComponent(userId)}/tree`).then((r) => r.data),
  /** The CRUD table for one property under one role. Loaded when an accordion opens. */
  userGrid: (userId: string, roleKey: string, nodeId: string) =>
    apiFetch<ApiOne<{ modules: GridModule[] }>>(
      `/access/users/${encodeURIComponent(userId)}/grid?roleKey=${encodeURIComponent(roleKey)}&nodeId=${encodeURIComponent(nodeId)}`,
    ).then((r) => r.data),
  setGridCell: (userId: string, body: {
    roleKey: string; nodeId: string; functionality: string; action: string; allowed: boolean; reason: string;
  }) =>
    apiFetch<ApiOne<{ outcome: string; allowed: boolean; baseAllows: boolean }>>(
      `/access/users/${encodeURIComponent(userId)}/grid`,
      { method: "PUT", body: JSON.stringify(body) },
    ).then((r) => r.data),
  /** Change WHERE one role applies, without touching any other role's places. */
  setRoleScope: (userId: string, body: { roleKey: string; nodeIds: string[]; reason: string }) =>
    apiFetch<ApiOne<{ roleKey: string; nodeIds: string[] }>>(
      `/access/users/${encodeURIComponent(userId)}/role-scope`,
      { method: "PUT", body: JSON.stringify(body) },
    ).then((r) => r.data),
  /** Who disabling this role would reach, and who it would leave with nothing. */
  roleImpact: (key: string) =>
    apiFetch<ApiOne<RoleImpact>>(`/access/roles/${encodeURIComponent(key)}/impact`).then((r) => r.data),
  roleDetail: (key: string) =>
    apiFetch<ApiOne<RoleDetail>>(`/access/roles/${encodeURIComponent(key)}`).then((r) => r.data),
  updateRole: (key: string, body: { label?: string; description?: string; reason?: string; anchorLevel?: AnchorLevel | null }) =>
    apiFetch<ApiOne<AccessRole>>(`/access/roles/${encodeURIComponent(key)}`, {
      method: "PUT", body: JSON.stringify(body),
    }).then((r) => r.data),
  setRoleEnabled: (key: string, enabled: boolean, reason: string) =>
    apiFetch<ApiOne<AccessRole>>(`/access/roles/${encodeURIComponent(key)}/${enabled ? "enable" : "disable"}`, {
      method: "POST", body: JSON.stringify({ reason }),
    }).then((r) => r.data),
  clonePlan: (fromUserId: string, toUserId: string) =>
    apiFetch<ApiOne<CloneAccessPlan>>(
      `/access/clone-access/${encodeURIComponent(fromUserId)}/${encodeURIComponent(toUserId)}`,
    ).then((r) => r.data),
  cloneAccess: (body: { fromUserId: string; toUserId: string; reason: string; role?: boolean; grants?: boolean; overrides?: boolean }) =>
    apiFetch<ApiOne<{ role: boolean; grants: number; overrides: number; removedGrants: number; removedOverrides: number }>>(
      "/access/clone-access",
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.data),
  users: () => apiFetch<ApiOne<AccessUser[]>>("/access/users").then((r) => r.data),
  nodes: () => apiFetch<ApiOne<OrgNode[]>>("/access/nodes").then((r) => r.data),
  grants: (subjectId?: string) =>
    apiFetch<ApiOne<AccessGrantRow[]>>(
      subjectId ? `/access/grants?subjectId=${encodeURIComponent(subjectId)}` : "/access/grants",
    ).then((r) => r.data),
  preview: (userId: string, nodeId?: string | null) =>
    apiFetch<ApiOne<AccessPreview>>(
      `/access/preview/${encodeURIComponent(userId)}${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""}`,
    ).then((r) => r.data),
};
