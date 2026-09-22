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
  | "DENY_UNKNOWN_MODULE"
  | "DENY_ACTION_NOT_ON_MODULE"
  | "DENY_ROLE_LACKS_CAPABILITY"
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

export interface PreviewAction {
  action: string;
  allow: boolean;
  reason: ReasonCode;
  detail: string;
  via: string | null;
}

export interface PreviewModule {
  key: string;
  noAccess: boolean;
  actions: PreviewAction[];
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

/** A per-employee exception to their role's matrix. */
export interface UserOverride {
  id: string;
  userId: string;
  module: string;
  /** Display name for the module, resolved server-side. */
  label: string;
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
  role: { current: string; incoming: string; changes: boolean };
  grants: {
    incoming: Array<{ roleKey: string; nodeId: string | null; nodeName: string | null; assignmentKind: string; dataScope: string; includeDescendants: boolean; expiresAt: string | null }>;
    replacing: Array<{ roleKey: string; nodeId: string | null; nodeName: string | null; assignmentKind: string; dataScope: string; includeDescendants: boolean; expiresAt: string | null }>;
  };
  overrides: {
    incoming: Array<{ module: string; label: string; action: string; effect: string; reason: string; expiresAt: string | null }>;
    replacing: Array<{ module: string; label: string; action: string; effect: string }>;
  };
}

export interface ManifestModule {
  key: string;
  label: string;
  family: string;
  actions: string[];
  protected: boolean;
}

export interface Manifest {
  actions: string[];
  families: string[];
  modules: ManifestModule[];
}

export interface AccessRole {
  key: string;
  label: string;
  /** Non-null for a MODULE role (a persona inside one module, e.g. Auditor). */
  scopeModule: string | null;
  description: string | null;
  rank: number;
  isSystem: boolean;
  isActive: boolean;
  computed: boolean;
  holders: number;
  cells: number | null;
}

export interface MatrixCell {
  roleKey: string;
  module: string;
  action: string;
  computed: boolean;
}

export interface MatrixResponse {
  version: number;
  source: "db" | "code";
  modules: Array<{ key: string; actions: string[]; protected: boolean }>;
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

export const accessKeys = {
  manifest: () => ["access", "manifest"] as const,
  roles: () => ["access", "roles"] as const,
  matrix: (roleKey?: string) => ["access", "matrix", roleKey ?? "all"] as const,
  assignments: (userId: string) => ["access", "assignments", userId] as const,
  users: () => ["access", "users"] as const,
  nodes: () => ["access", "nodes"] as const,
  grants: (subjectId?: string) => ["access", "grants", subjectId ?? "all"] as const,
  preview: (userId: string, nodeId: string | null) => ["access", "preview", userId, nodeId ?? "any"] as const,
  overrides: (userId: string) => ["access", "overrides", userId] as const,
  clonePlan: (from: string, to: string) => ["access", "clone-plan", from, to] as const,
};

export const accessApi = {
  manifest: () => apiFetch<ApiOne<Manifest>>("/access/manifest").then((r) => r.data),
  roles: () => apiFetch<ApiOne<AccessRole[]>>("/access/roles").then((r) => r.data),
  matrix: (roleKey?: string) =>
    apiFetch<ApiOne<MatrixResponse>>(`/access/matrix${roleKey ? `?roleKey=${encodeURIComponent(roleKey)}` : ""}`).then((r) => r.data),
  saveMatrix: (body: { version: number; reason: string; changes: Array<{ roleKey: string; module: string; action: string; allowed: boolean }> }) =>
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
  createRole: (body: { key: string; label?: string; rank?: number; cloneFrom?: string; reason: string }) =>
    apiFetch<ApiOne<{ role: AccessRole; clonedCells: number; version: number }>>("/access/roles", {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => r.data),
  overrides: (userId: string) =>
    apiFetch<ApiOne<UserOverride[]>>(`/access/overrides/${encodeURIComponent(userId)}`).then((r) => r.data),
  setOverride: (
    userId: string,
    body: { module: string; action: string; effect: "GRANT" | "DENY" | "INHERIT"; reason: string; expiresAt?: string | null },
  ) =>
    apiFetch<ApiOne<{ effect: string; module: string; action: string; roleAllows: boolean }>>(
      `/access/overrides/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ).then((r) => r.data),
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
