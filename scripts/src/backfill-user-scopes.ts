/**
 * Give every pre-existing oversight account a `user_scopes` row before the
 * fail-closed scope resolver goes live.
 *
 *   pnpm --filter @workspace/scripts run backfill:user-scopes            # dry-run
 *   pnpm --filter @workspace/scripts run backfill:user-scopes -- --apply # write
 *
 * DEPLOY ORDER — run this BEFORE the new API image serves traffic.
 *
 * Why it exists: `resolveAccessiblePropertyIds` used to fall open to every
 * property for ZONAL_HEAD / CITY_HEAD / CLUSTER_MANAGER / FNB_ZONAL_HEAD /
 * FNB_SUPERVISOR when they had no scope rows (the old BROAD_FALLBACK set), on a
 * "prevent lockout before scopes are configured" rationale that inverted the
 * control — revoking a head's last grant PROMOTED them to the whole network.
 * That fallback is gone: those roles, plus KITCHEN_MANAGER which never had one,
 * now resolve to `[]` the moment this deploys, unless a grant exists. On a live
 * database that is a silent lockout, because an empty scope answers 200 with an
 * empty list, not a 403.
 *
 * What "locked out" means per role — the roles do NOT all lose the same thing:
 *   • ZONAL_HEAD / CITY_HEAD / CLUSTER_MANAGER / FNB_SUPERVISOR / FNB_ZONAL_HEAD
 *     hold FOOD_* modules, so they lose the food module itself — orders, menu,
 *     dispatch, reports.
 *   • KITCHEN_MANAGER holds NO FOOD_* module at all (permissions.ts: DASHBOARD,
 *     RECIPES, MENU_PLANNING, INVENTORY, INDENTS:create). Every food-ordering
 *     endpoint 403s for it with or without a scope, so no grant here restores
 *     "the food module" to it. What it loses to an empty scope is Kitchen
 *     Operations — menu plans, production logs, kitchen analytics, recipe
 *     feedback (kitchen.ts) — and the property list Menu Planning reads
 *     (properties.ts). That is what a grant repairs, and it is worth repairing.
 *
 * What it does NOT do: invent a geography. A grant is only minted when existing
 * data already states the association (home property, cluster ownership, kitchen
 * contact). Anything else is printed for an operator to grant explicitly through
 * Food → Organization, and the script exits non-zero so a deploy pipeline stops
 * rather than shipping a lockout. KITCHEN_MANAGER is grantable there —
 * FOOD_USER_ROLES (food.ts), which feeds GET /food/food-users, now lists it.
 *
 * SUCCESS MEANS RESOLUTION, NOT EXISTENCE. A grant that expands to nothing — a
 * ZONE whose cities are all deactivated, a cluster with no properties tagged to
 * it — is the same lockout wearing a scope row. So the pass/fail signal for
 * EVERY at-risk account, not just the ones this run minted, is the resolved
 * property count from RESOLVE_SQL below. On a live database most accounts
 * already hold some grant, so "rows exist" would green-light exactly the
 * population this script protects.
 *
 * Idempotent: users whose scope already RESOLVES are skipped, so a second run
 * finds nothing to do. Deliberately revoked users (rows exist, all `is_active`
 * false) are reported but NEVER re-granted — re-granting them would undo the
 * revocation and is exactly the escalation the fail-closed resolver fixed — and
 * they still count as failures, because a run that leaves an account seeing
 * nothing has not succeeded, whatever the reason.
 */
import { db, pool, usersTable, userScopesTable } from "@workspace/db";
import { randomUUID } from "crypto";

const APPLY = process.argv.includes("--apply");
/**
 * Opt in to deriving MORE THAN ONE grant for a single account. Off by default:
 * see `deriveGrants`. Printed in full before anything is written.
 */
const ALLOW_MULTI = process.argv.includes("--allow-multi-target");

/**
 * The roles that lose scope-dependent access on deploy. Five are the old
 * BROAD_FALLBACK set (git show dev:apps/api-server/src/lib/food-service.ts:123);
 * KITCHEN_MANAGER is included because it was never in that set and is not in
 * ALWAYS_GLOBAL either, so it is equally scope-dependent — see the per-role note
 * in the header for what it actually loses.
 */
const ROLES_AT_RISK = [
  "ZONAL_HEAD",
  "CITY_HEAD",
  "CLUSTER_MANAGER",
  "FNB_SUPERVISOR",
  "FNB_ZONAL_HEAD",
  "KITCHEN_MANAGER",
] as const;

type ScopeLevel = "PROPERTY" | "CLUSTER" | "KITCHEN";
type Grant = { level: ScopeLevel; targetId: string; label: string };

type Candidate = {
  id: string;
  email: string;
  name: string;
  role: string;
  property_id: string | null;
  rows_all: number;
  rows_live: number;
};

/**
 * Replicates `resolveAccessiblePropertyIds` (apps/api-server/src/lib/food-service.ts)
 * in one statement, across BOTH live spines — zone → city → cluster →
 * properties.cluster_id and zone → city → kitchen → properties.kitchen_id — and
 * including `users.property_id`, which the resolver seeds the set with before it
 * reads any grant. Anything this counts as zero sees nothing in the app.
 *
 * `is_active` is applied exactly where the resolver applies it: on the nodes it
 * TRAVERSES (zone → cities, city → clusters, city → kitchens), never on a
 * DIRECTLY granted target, whose own `user_scopes.is_active` governs it. Omitting
 * those predicates would count access the app refuses to grant and report a
 * lockout as healthy — the false pass this whole check exists to prevent.
 *
 * (seed-food.ts's `assertScopesResolve` is the same idea with an INNER JOIN, so
 * it cannot see a user with no scope rows at all — the actual lockout.)
 */
const RESOLVE_SQL = `
  SELECT u.id, u.email, u.role::text AS role, count(DISTINCT p.id)::int AS n
    FROM users u
    LEFT JOIN user_scopes s ON s.user_id = u.id AND s.is_active
    LEFT JOIN properties p ON
         (p.id = u.property_id)
      OR (s.scope_level = 'GLOBAL')
      OR (s.scope_level = 'PROPERTY' AND p.id = s.property_id)
      OR (s.scope_level = 'KITCHEN'  AND p.kitchen_id = s.kitchen_id)
      OR (s.scope_level = 'CLUSTER'  AND p.cluster_id = s.cluster_id)
      OR (s.scope_level = 'CITY'     AND (
             p.kitchen_id IN (SELECT k.id FROM kitchens k WHERE k.city_id = s.city_id AND k.is_active)
          OR p.cluster_id IN (SELECT c.id FROM clusters c WHERE c.city_id = s.city_id AND c.is_active)))
      OR (s.scope_level = 'ZONE'     AND (
             p.kitchen_id IN (SELECT k.id FROM kitchens k JOIN cities ci ON ci.id = k.city_id
                               WHERE ci.zone_id = s.zone_id AND ci.is_active AND k.is_active)
          OR p.cluster_id IN (SELECT c.id FROM clusters c JOIN cities ci ON ci.id = c.city_id
                               WHERE ci.zone_id = s.zone_id AND ci.is_active AND c.is_active)))
   WHERE u.id = ANY($1)
   GROUP BY u.id, u.email, u.role
   ORDER BY u.role, u.email`;

/** Resolved property count per user id. Users with no row resolve to zero. */
async function resolveCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { rows } = await pool.query<{ id: string; n: number }>(RESOLVE_SQL, [ids]);
  for (const r of rows) out.set(r.id, r.n);
  return out;
}

type Derivation =
  | { kind: "grants"; grants: Grant[] }
  /** More targets than one account should silently inherit — needs a decision. */
  | { kind: "too-broad"; source: string; grants: Grant[] }
  | { kind: "none" };

/**
 * The narrowest grant existing data already states, in narrowing order. Nothing
 * here guesses: each source is a column whose whole purpose is that association.
 *
 * ONE TARGET IS THE DEFAULT. `clusters.manager_id` and `kitchens.contact_email`
 * are ownership columns, not scope columns: a single ops account can sit on many
 * of them (the dev database has one CLUSTER_MANAGER named on 9 clusters), and
 * minting a grant per row hands that account most of the network under the
 * heading "derived from existing data". A backfill must not be the thing that
 * decides an account's reach is that wide. So a multi-row source is reported,
 * not minted, unless the operator passes --allow-multi-target — at which point
 * every target is printed before it is written.
 */
async function deriveGrants(u: Candidate): Promise<Derivation> {
  // 1. Home property. The resolver already honours users.property_id, but an
  //    explicit PROPERTY row makes the access visible and repairable in Food →
  //    Organization and survives a later change to the user's home property.
  //    Single-valued by construction, so it can never widen.
  if (u.property_id) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM properties WHERE id = $1`,
      [u.property_id],
    );
    if (rows.length) {
      return {
        kind: "grants",
        grants: [{ level: "PROPERTY", targetId: u.property_id, label: `property ${rows[0]!.name}` }],
      };
    }
  }

  // 2. Clusters this user manages — `clusters.manager_id` exists for exactly
  //    this (PRD §4.2, "Cluster Manager who owns this cluster").
  const clusters = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM clusters WHERE manager_id = $1 AND is_active ORDER BY name`,
    [u.id],
  );
  if (clusters.rowCount) {
    const grants = clusters.rows.map((c) => ({
      level: "CLUSTER" as const,
      targetId: c.id,
      label: `cluster ${c.name}`,
    }));
    return clusters.rows.length > 1
      ? { kind: "too-broad", source: "clusters.manager_id", grants }
      : { kind: "grants", grants };
  }

  // 3. Kitchens whose contact address IS this account — the one-login-per-kitchen
  //    model the F&B/kitchen roles are built on (see seed-kitchen-managers.ts).
  //    Same multi-target rule as clusters: a shared ops mailbox on every kitchen
  //    row is a mailbox, not a mandate.
  const kitchens = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM kitchens
      WHERE is_active AND lower(contact_email) = lower($1) ORDER BY code`,
    [u.email],
  );
  if (kitchens.rowCount) {
    const grants = kitchens.rows.map((k) => ({
      level: "KITCHEN" as const,
      targetId: k.id,
      label: `kitchen ${k.code} (${k.name})`,
    }));
    return kitchens.rows.length > 1
      ? { kind: "too-broad", source: "kitchens.contact_email", grants }
      : { kind: "grants", grants };
  }

  return { kind: "none" };
}

const list = (grants: Grant[]) => grants.map((g) => `${g.level}: ${g.label}`).join(", ");

async function main(): Promise<void> {
  const { rows: candidates } = await pool.query<Candidate>(
    `SELECT u.id, u.email, u.name, u.role::text AS role, u.property_id,
            (SELECT count(*)::int FROM user_scopes s WHERE s.user_id = u.id) AS rows_all,
            (SELECT count(*)::int FROM user_scopes s WHERE s.user_id = u.id AND s.is_active) AS rows_live
       FROM users u
      WHERE u.is_active AND u.role::text = ANY($1)
      ORDER BY u.role, u.email`,
    [[...ROLES_AT_RISK]],
  );

  console.log(
    `\n${candidates.length} scope-dependent account(s) · mode ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}` +
      `${ALLOW_MULTI ? " · --allow-multi-target ON" : ""}\n`,
  );

  // The pass/fail signal, for every candidate — not just the ones minted below.
  // "Holds a grant" and "sees something" are different questions and only the
  // second one matters.
  const before = await resolveCounts(candidates.map((c) => c.id));

  const revoked: Candidate[] = [];
  const emptyGrant: Candidate[] = [];
  const tooBroad: { user: Candidate; source: string; grants: Grant[] }[] = [];
  const undecidable: Candidate[] = [];
  const planned: { user: Candidate; grants: Grant[] }[] = [];

  for (const u of candidates) {
    const n = before.get(u.id) ?? 0;
    const tag = `  ${u.email.padEnd(30)} ${u.role.padEnd(16)}`;

    if (n > 0) {
      console.log(`  ✓${tag}resolves to ${n} propert${n === 1 ? "y" : "ies"}`);
      continue;
    }
    if (u.rows_live > 0) {
      // Grants exist and are live, yet expand to nothing: a deactivated city, a
      // cluster with no properties tagged to it. Minting a second grant on top
      // would WIDEN an account whose reach an admin already decided — the fix is
      // to repair the geography or re-target the grant, both operator calls.
      emptyGrant.push(u);
      console.log(`  ✗${tag}holds ${u.rows_live} live grant(s) that expand to ZERO properties`);
      continue;
    }
    if (u.rows_all > 0) {
      // Rows exist but every one is revoked. That is a deliberate act, not a
      // gap — minting a replacement would silently reverse it. Still a failure:
      // the account sees nothing and the run must not report success.
      revoked.push(u);
      console.log(`  ✗${tag}all ${u.rows_all} grant(s) revoked — NOT re-granted`);
      continue;
    }

    const d = await deriveGrants(u);
    if (d.kind === "none") {
      undecidable.push(u);
      console.log(`  ✗${tag}nothing derivable — needs an explicit grant`);
      continue;
    }
    if (d.kind === "too-broad" && !ALLOW_MULTI) {
      tooBroad.push({ user: u, source: d.source, grants: d.grants });
      console.log(`  ✗${tag}${d.grants.length} targets from ${d.source} — too broad to derive`);
      continue;
    }
    planned.push({ user: u, grants: d.grants });
    console.log(
      `  →${tag}${APPLY ? "grant" : "would grant"} ${list(d.grants)}` +
        (d.kind === "too-broad" ? `  [--allow-multi-target: ${d.grants.length} targets]` : ""),
    );
  }

  if (APPLY && planned.length) {
    const values = planned.flatMap(({ user, grants }) =>
      grants.map((g) => ({
        id: randomUUID(),
        userId: user.id,
        scopeLevel: g.level,
        zoneId: null,
        cityId: null,
        clusterId: g.level === "CLUSTER" ? g.targetId : null,
        kitchenId: g.level === "KITCHEN" ? g.targetId : null,
        propertyId: g.level === "PROPERTY" ? g.targetId : null,
      })),
    );
    // Only users with ZERO scope rows reach here, so there is nothing to
    // conflict with; a re-run finds them resolving and skips them.
    await db.insert(userScopesTable).values(values);
    console.log(`\n  ✓ inserted ${values.length} grant(s) for ${planned.length} user(s)`);
  }

  // Re-read the same signal after writing. A minted grant is not a fix until it
  // expands to a property, and only a post-write check can tell the two apart.
  const plannedIds = new Set(planned.map((p) => p.user.id));
  const after = APPLY && planned.length ? await resolveCounts(candidates.map((c) => c.id)) : before;
  if (APPLY && planned.length) {
    const ok = [...plannedIds].filter((id) => (after.get(id) ?? 0) > 0).length;
    console.log(`  ✓ ${ok}/${plannedIds.size} backfilled account(s) now resolve to at least one property`);
  }

  // In a dry run the planned accounts have not been written yet, so their zero
  // is expected rather than a finding; everything else that resolves to zero is
  // work an operator has to finish.
  const unresolved = candidates.filter(
    (c) => (after.get(c.id) ?? 0) === 0 && !(!APPLY && plannedIds.has(c.id)),
  );

  if (emptyGrant.length) {
    console.log(`\n❌ ${emptyGrant.length} account(s) hold live grants that expand to ZERO properties.`);
    console.log("  Nothing is tagged to the granted geography. Repair it, or re-target the grant in");
    console.log("  Food → Organization — a backfill must not widen a scope an admin already set:");
    for (const u of emptyGrant) console.log(`     ${u.email} (${u.role}) — ${u.name}`);
  }

  if (revoked.length) {
    console.log(`\n❌ ${revoked.length} account(s) hold only REVOKED grants. They will see nothing.`);
    console.log("  Re-granting is a policy decision, not a backfill — do it in Food → Organization,");
    console.log("  or deactivate the account. Either way this run has NOT succeeded:");
    for (const u of revoked) console.log(`     ${u.email} (${u.role}) — ${u.name}`);
  }

  if (tooBroad.length) {
    console.log(`\n❌ ${tooBroad.length} account(s) have more than one derivable target.`);
    console.log("  Deriving all of them would hand the account the whole list. Grant the right one in");
    console.log("  Food → Organization, or re-run with -- --apply --allow-multi-target to take all:");
    for (const t of tooBroad) {
      console.log(`     ${t.user.email} (${t.user.role}) — ${t.grants.length} from ${t.source}:`);
      for (const g of t.grants) console.log(`        ${g.level}: ${g.label}`);
    }
  }

  if (undecidable.length) {
    console.log(`\n❌ ${undecidable.length} account(s) have NO scope and nothing to derive one from.`);
    console.log("  Grant each a scope in Food → Organization (Zone / City / Cluster / Kitchen /");
    console.log("  Property) before the new API serves traffic:");
    for (const u of undecidable) console.log(`     ${u.email} (${u.role}) — ${u.name}`);
  }

  if (!APPLY && planned.length) {
    console.log(`\nRe-run with -- --apply to write ${planned.length} account(s)' grants.`);
  }

  if (unresolved.length) {
    console.log(`\n⚠ ${unresolved.length} account(s) resolve to zero properties and will see nothing.`);
    console.log("  Resolve them before deploying:");
    for (const u of unresolved) console.log(`     ${u.email} (${u.role})`);
    await pool.end();
    process.exit(1);
  }

  console.log("\n✅ every scope-dependent account resolves to at least one property");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
