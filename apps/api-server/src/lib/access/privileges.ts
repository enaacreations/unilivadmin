/**
 * Privileges — the property-scoped exception layer above the role matrix.
 *
 * The matrix says what a role may do everywhere. This says the two things it
 * cannot express:
 *
 *   USER subject  — "what may THIS person do that others in the role may not?"
 *   nodeId        — "…and at WHICH property?"
 *
 * Together they make the requirement expressible: one Unit Lead with one
 * functionality at property A and another at property B is two rows, same
 * person, same role, different node.
 *
 * ── Resolution ────────────────────────────────────────────────────────────
 * Among the privileges that match a cell, the winner is the most SPECIFIC one:
 *
 *   1. USER beats ROLE          — a rule about a person beats a rule about their job
 *   2. node beats global        — a rule about a place beats one about everywhere
 *   3. deeper node beats shallower — a property rule beats a city rule
 *   4. role-scoped beats '*'    — a rule written under one role beats one that
 *                                 applies whatever the person holds
 *   5. at equal specificity, DENY beats GRANT
 *
 * The DENY tiebreak is last on purpose. A DENY on the whole organization must NOT quietly
 * outrank a GRANT written for one property — the narrower rule is the more
 * deliberate one, and an admin who writes it expects it to hold.
 *
 * ── Why the node sets are precomputed ─────────────────────────────────────
 * decide() is synchronous by construction (it is called from middleware that
 * cannot await), so it cannot walk the closure table. Instead resolveAccess
 * expands each privilege's node into the set of nodes it covers ONCE, and
 * decide() answers with set lookups. A user has a handful of privileges, so
 * this is one extra query per resolve, not one per decision.
 *
 * CACHED like the matrix, for the same reason: authorize() runs on every
 * request, and a table that changes a few times a month should not cost a round
 * trip each time. Cache is per process with a short TTL plus explicit
 * invalidation on write.
 */
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  db, privilegesTable, orgNodesTable,
  privilegeSetsTable, privilegeSetItemsTable, privilegeSetAssignmentsTable,
} from "@workspace/db";
import { logger } from "../logger.js";
import { descendantIds } from "../org-tree.js";
import type { NamedAction, Functionality } from "../permissions.js";

export type PrivilegeEffect = "GRANT" | "DENY";

/** "FUNCTIONALITY:action" — the same key shape the matrix snapshot uses. */
export const privilegeKey = (functionality: string, action: string) => `${functionality}:${action}`;

export interface ResolvedPrivilege {
  effect: PrivilegeEffect;
  /** USER rules outrank ROLE rules. */
  fromUser: boolean;
  /** null = everywhere; otherwise the node the rule was written at. */
  nodeId: string | null;
  /** Depth of that node, so a property rule outranks a city rule. */
  depth: number;
  /** Every node the rule reaches — the node itself plus everything beneath it. */
  covers: Set<string> | null;
  /** Carried for the preview, so the UI can say WHY. */
  reason: string;
  subjectId: string;
  /** The role this rule hangs under, or '*' when it applies whatever they hold. */
  roleKey: string;
}

/** cell key → the rules touching that cell, unordered. */
export type PrivilegeMap = Map<string, ResolvedPrivilege[]>;

interface Entry { at: number; map: PrivilegeMap }

const TTL_MS = 30_000;
const cache = new Map<string, Entry>();

/** Cache key: privileges depend on the person AND the roles they hold. */
const cacheKey = (userId: string, roleKeys: string[]) => `${userId}|${[...roleKeys].sort().join(",")}`;

export function invalidatePrivileges(userId?: string): void {
  if (!userId) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

/** A role's privileges reach every holder, so a role write clears everything. */
export function invalidateAllPrivileges(): void {
  cache.clear();
}

function liveWindow(now: Date) {
  return and(
    lte(privilegesTable.effectiveFrom, now),
    or(isNull(privilegesTable.expiresAt), gt(privilegesTable.expiresAt, now)),
  );
}

/**
 * The fields the ladder reads off a rule. Real privilege rows have more; an
 * expanded set item has exactly these, which is why the two can share a loop.
 */
interface Rule {
  effect: string;
  subjectType: string;
  subjectId: string;
  roleKey: string;
  nodeId: string | null;
  reason: string;
  functionality: string;
  action: string;
}

/**
 * Every live set assigned to this user or their roles, expanded into rules.
 *
 * The set's effect and the assignment's node/window/reason apply to each item —
 * one decision, made once, standing for all of them. `reason` names the set so
 * the answer to "why can they do this?" is "the Night audit cover set", not an
 * unattributed rule that looks hand-written.
 */
async function readSetRules(
  userId: string,
  roleKeys: string[],
  held: Set<string>,
  now: Date,
): Promise<Rule[]> {
  const subjectMatch = roleKeys.length
    ? or(
        and(eq(privilegeSetAssignmentsTable.subjectType, "USER"), eq(privilegeSetAssignmentsTable.subjectId, userId)),
        and(eq(privilegeSetAssignmentsTable.subjectType, "ROLE"), inArray(privilegeSetAssignmentsTable.subjectId, roleKeys)),
      )
    : and(eq(privilegeSetAssignmentsTable.subjectType, "USER"), eq(privilegeSetAssignmentsTable.subjectId, userId));

  // Named columns rather than the whole row: this join feeds the gate on every
  // request, and the four assignment fields below are all the ladder reads.
  const assignments = await db
    .select({
      setId: privilegeSetAssignmentsTable.setId,
      subjectType: privilegeSetAssignmentsTable.subjectType,
      subjectId: privilegeSetAssignmentsTable.subjectId,
      roleKey: privilegeSetAssignmentsTable.roleKey,
      nodeId: privilegeSetAssignmentsTable.nodeId,
      reason: privilegeSetAssignmentsTable.reason,
      setName: privilegeSetsTable.name,
      effect: privilegeSetsTable.effect,
      isActive: privilegeSetsTable.isActive,
    })
    .from(privilegeSetAssignmentsTable)
    .innerJoin(privilegeSetsTable, eq(privilegeSetsTable.id, privilegeSetAssignmentsTable.setId))
    .where(
      and(
        subjectMatch,
        isNull(privilegeSetAssignmentsTable.revokedAt),
        lte(privilegeSetAssignmentsTable.effectiveFrom, now),
        or(isNull(privilegeSetAssignmentsTable.expiresAt), gt(privilegeSetAssignmentsTable.expiresAt, now)),
      ),
    );

  // Deactivating a set must stop it granting, without unpicking who holds it —
  // the assignments stay, so re-activating restores exactly what was there.
  const live = assignments.filter((r) => r.isActive && (r.roleKey === "*" || held.has(r.roleKey)));
  if (!live.length) return [];

  const items = await db
    .select()
    .from(privilegeSetItemsTable)
    .where(inArray(privilegeSetItemsTable.setId, [...new Set(live.map((r) => r.setId))]));

  const bySet = new Map<string, typeof items>();
  for (const it of items) bySet.set(it.setId, [...(bySet.get(it.setId) ?? []), it]);

  return live.flatMap((r) =>
    (bySet.get(r.setId) ?? []).map((it) => ({
      effect: r.effect,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      roleKey: r.roleKey,
      nodeId: r.nodeId,
      reason: `${r.setName} — ${r.reason}`,
      functionality: it.functionality,
      action: it.action,
    })),
  );
}

/**
 * Read one user's live privileges — their own, plus those of every role they
 * hold — and expand each one's node into the set it covers.
 */
export async function readPrivileges(
  userId: string,
  roleKeys: string[],
  now = new Date(),
): Promise<PrivilegeMap> {
  const subjectMatch = roleKeys.length
    ? or(
        and(eq(privilegesTable.subjectType, "USER"), eq(privilegesTable.subjectId, userId)),
        and(eq(privilegesTable.subjectType, "ROLE"), inArray(privilegesTable.subjectId, roleKeys)),
      )
    : and(eq(privilegesTable.subjectType, "USER"), eq(privilegesTable.subjectId, userId));

  const all = await db
    .select()
    .from(privilegesTable)
    .where(and(subjectMatch, liveWindow(now)));

  // A role-scoped exception is only real while the person still holds the role.
  // '*' is the pre-existing meaning — applies whatever they hold. Filtering here
  // rather than in SQL keeps the cache key (user + roles) the thing that decides
  // the answer, so revoking a role invalidates exactly what it should.
  const held = new Set(roleKeys);
  const direct = all.filter((r) => r.roleKey === "*" || held.has(r.roleKey));

  // Privilege SETS, expanded here rather than copied at assignment time.
  //
  // This is what makes a set a live reference: the assignment stores a pointer,
  // and the permissions it stands for are read now. Add a permission to "Night
  // audit cover" and everyone covering the night audit has it on their next
  // request — no backfill, and no drift between the set and the people holding
  // it. Every other field (node, window, effect, reason) comes from the
  // assignment, so an expanded rule is indistinguishable from a hand-written one
  // once it reaches the ladder — which is correct: it IS one, just not typed out.
  const fromSets = await readSetRules(userId, roleKeys, held, now);
  const rows = [...direct, ...fromSets];

  const map: PrivilegeMap = new Map();
  if (!rows.length) return map;

  // One expansion per distinct node, not per row: several privileges commonly
  // share a property.
  const nodeIds = [...new Set(rows.map((r) => r.nodeId).filter(Boolean) as string[])];
  const covers = new Map<string, Set<string>>();
  const depths = new Map<string, number>();
  if (nodeIds.length) {
    const [nodes, ...expansions] = await Promise.all([
      db.select({ id: orgNodesTable.id, depth: orgNodesTable.depth })
        .from(orgNodesTable)
        .where(inArray(orgNodesTable.id, nodeIds)),
      ...nodeIds.map((id) => descendantIds([id])),
    ]);
    for (const n of nodes) depths.set(n.id, n.depth);
    nodeIds.forEach((id, i) => {
      // A privilege on a node always covers that node, even when the closure
      // expansion comes back empty (an inactive or leaf node).
      covers.set(id, new Set([id, ...(expansions[i] ?? [])]));
    });
  }

  for (const r of rows) {
    const key = privilegeKey(r.functionality, r.action);
    const list = map.get(key) ?? [];
    list.push({
      effect: r.effect as PrivilegeEffect,
      fromUser: r.subjectType === "USER",
      nodeId: r.nodeId,
      depth: r.nodeId ? depths.get(r.nodeId) ?? 0 : -1,
      covers: r.nodeId ? covers.get(r.nodeId) ?? new Set([r.nodeId]) : null,
      reason: r.reason,
      subjectId: r.subjectId,
      roleKey: r.roleKey,
    });
    map.set(key, list);
  }
  return map;
}

export async function privilegesFor(userId: string, roleKeys: string[]): Promise<PrivilegeMap> {
  const key = cacheKey(userId, roleKeys);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  try {
    const map = await readPrivileges(userId, roleKeys);
    cache.set(key, { at: Date.now(), map });
    return map;
  } catch (err) {
    logger.error({ err, userId }, "privilege load failed — falling back to role-only permissions");
    // Do NOT cache a failure: the next request should retry rather than spend
    // the whole TTL with a DENY silently not applying.
    return hit?.map ?? new Map();
  }
}

/**
 * The winning privilege for one cell at one node, or undefined when no rule
 * applies and the role matrix decides.
 *
 * `nodeId` null means "anywhere in scope" — asked by the nav and by the
 * capability blob, which have no node in hand. There, only global rules apply:
 * a privilege written for one property must not light up a menu everywhere.
 */
export function privilegeOn(
  map: PrivilegeMap | undefined,
  functionality: Functionality,
  action: NamedAction,
  nodeId?: string | null,
): ResolvedPrivilege | undefined {
  // One spelling. Rows, gates and the manifest all say `add_property`; the
  // dual lookup that used to live here existed only to bridge the old verbs.
  const list = map?.get(privilegeKey(functionality, action)) ?? [];
  if (!list.length) return undefined;

  let best: ResolvedPrivilege | undefined;
  for (const p of list) {
    if (p.covers) {
      if (!nodeId || !p.covers.has(nodeId)) continue;
    }
    if (!best) { best = p; continue; }
    best = moreSpecific(best, p);
  }
  return best;
}

/** The precedence ladder, in one place so every consumer agrees. */
function moreSpecific(a: ResolvedPrivilege, b: ResolvedPrivilege): ResolvedPrivilege {
  if (a.fromUser !== b.fromUser) return a.fromUser ? a : b;
  const aScoped = a.covers !== null;
  const bScoped = b.covers !== null;
  if (aScoped !== bScoped) return aScoped ? a : b;
  if (a.depth !== b.depth) return a.depth > b.depth ? a : b;
  // A rule written under one role beats a rule written for the person whatever
  // they hold — same reasoning as node-beats-global, one axis down.
  const aRole = a.roleKey !== "*";
  const bRole = b.roleKey !== "*";
  if (aRole !== bRole) return aRole ? a : b;
  // Equal specificity: the refusal wins.
  if (a.effect !== b.effect) return a.effect === "DENY" ? a : b;
  return a;
}

/** Every cell this user carries a rule on — for the "has exceptions" summary. */
export function privilegeCells(map: PrivilegeMap | undefined): string[] {
  return [...(map?.keys() ?? [])];
}
