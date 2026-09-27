/**
 * Multi-role equivalence gate.
 *
 * The question this answers is the only one that matters after a resolver
 * change: did anybody's answer move? For every active user × every module ×
 * every action, it compares
 *
 *   BEFORE — the capability their single legacy users.role granted
 *   AFTER  — the union across the roles they now hold
 *
 * and reports every divergence with the role that caused it.
 *
 * A divergence is not automatically a bug: giving someone a second role is
 * SUPPOSED to widen them. So the report separates WIDENED (expected, and
 * attributable to a named extra role) from NARROWED (never expected — it means
 * the union lost something the single role had, which would be a regression).
 *
 *   pnpm --filter @workspace/scripts run verify:multirole
 */
import { db, usersTable, userRolesTable, roleFunctionalitiesTable, rolesTable } from "@workspace/db";
import { and, eq, isNull, gt, or, lte } from "drizzle-orm";

async function main() {
  const now = new Date();

  const users = await db
    .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.isActive, true));

  const memberships = await db
    .select({ userId: userRolesTable.userId, roleKey: userRolesTable.roleKey })
    .from(userRolesTable)
    .innerJoin(rolesTable, eq(rolesTable.key, userRolesTable.roleKey))
    .where(
      and(
        eq(rolesTable.isActive, true),
        lte(userRolesTable.effectiveFrom, now),
        or(isNull(userRolesTable.expiresAt), gt(userRolesTable.expiresAt, now)),
      ),
    );

  const rolesOf = new Map<string, string[]>();
  for (const m of memberships) rolesOf.set(m.userId, [...(rolesOf.get(m.userId) ?? []), m.roleKey]);

  // The matrix, as cells per role.
  const cells = await db
    .select({ roleKey: roleFunctionalitiesTable.roleKey, functionality: roleFunctionalitiesTable.functionality, action: roleFunctionalitiesTable.action })
    .from(roleFunctionalitiesTable)
    .where(eq(roleFunctionalitiesTable.allowed, true));

  const byRole = new Map<string, Set<string>>();
  for (const c of cells) {
    const set = byRole.get(c.roleKey) ?? new Set<string>();
    set.add(`${c.functionality}:${c.action}`);
    byRole.set(c.roleKey, set);
  }

  let widened = 0;
  let narrowed = 0;
  const widenedBy = new Map<string, number>();
  const regressions: string[] = [];

  for (const u of users) {
    const before = byRole.get(u.role) ?? new Set<string>();
    const held = rolesOf.get(u.id) ?? [];
    const after = new Set<string>();
    for (const r of held) for (const cell of byRole.get(r) ?? []) after.add(cell);

    // No membership row yet → the resolver falls back to the legacy column, so
    // BEFORE and AFTER are the same set by construction. Say so rather than
    // reporting a spurious "lost everything".
    if (!held.length) continue;

    for (const cell of after) {
      if (!before.has(cell)) {
        widened++;
        const cause = held.find((r) => r !== u.role && (byRole.get(r)?.has(cell) ?? false)) ?? "(unknown)";
        widenedBy.set(cause, (widenedBy.get(cause) ?? 0) + 1);
      }
    }
    for (const cell of before) {
      if (!after.has(cell)) {
        narrowed++;
        regressions.push(`${u.email} LOST ${cell} (legacy role ${u.role}, now holds ${held.join(", ")})`);
      }
    }
  }

  console.log(`users checked:        ${users.length}`);
  console.log(`cells widened:        ${widened}  (expected — extra roles add capability)`);
  for (const [role, n] of [...widenedBy].sort((a, b) => b[1] - a[1])) {
    console.log(`    via ${role}: ${n}`);
  }
  console.log(`cells NARROWED:       ${narrowed}  (must be 0 — the union cannot lose what the single role had)`);
  for (const r of regressions.slice(0, 20)) console.log(`    ${r}`);

  if (narrowed > 0) {
    console.error("\nFAILED: the multi-role union removed capability somebody previously had.");
    process.exit(1);
  }
  console.log("\nPASS: no user lost any capability in the cutover.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
