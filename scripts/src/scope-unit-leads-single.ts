/**
 * Enforce one-property-per-unit-lead in the DATA (current policy). Each UNIT_LEAD is
 * trimmed to exactly one PROPERTY scope — their home property (users.property_id)
 * when it's among their scopes, otherwise the first — and any extra property scopes
 * are removed. users.property_id is aligned to the kept property.
 *
 * The app's multi-property support is intentionally left intact (we may need it
 * later); this script ONLY adjusts seed/data so each lead currently maps to one
 * property. Dry-run by default; pass --apply to write. Targets whichever DB
 * DATABASE_URL points at — run against local first, then prod.
 *
 *   set -a; . ./.env.api; set +a
 *   pnpm --filter @workspace/scripts run scope:unit-leads            # dry-run
 *   pnpm --filter @workspace/scripts run scope:unit-leads -- --apply  # write
 */
import { db, pool, usersTable, userScopesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const leads = await db
    .select({ id: usersTable.id, name: usersTable.name, propertyId: usersTable.propertyId })
    .from(usersTable)
    .where(eq(usersTable.role, "UNIT_LEAD"))
    .orderBy(usersTable.name);

  console.log(`\n${leads.length} unit lead(s) · mode ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  let changed = 0;
  for (const lead of leads) {
    const scopes = await db
      .select()
      .from(userScopesTable)
      // Live grants only — an already-revoked row is not an "extra" scope.
      .where(and(
        eq(userScopesTable.userId, lead.id),
        eq(userScopesTable.scopeLevel, "PROPERTY"),
        eq(userScopesTable.isActive, true),
      ));
    const propIds = scopes.map((s) => s.propertyId).filter((x): x is string => !!x);

    // Keep the home property if it's one of the scopes, else the first scope, else home.
    const keepId =
      lead.propertyId && propIds.includes(lead.propertyId)
        ? lead.propertyId
        : propIds[0] ?? lead.propertyId ?? null;
    if (!keepId) {
      console.log(`  -  ${lead.name}: no property assigned — skipped`);
      continue;
    }

    const extra = scopes.filter((s) => s.propertyId !== keepId);
    const fixHome = lead.propertyId !== keepId;
    if (extra.length === 0 && !fixHome) {
      console.log(`  ✓  ${lead.name}: already single (${keepId})`);
      continue;
    }

    console.log(`  →  ${lead.name}: keep ${keepId} · remove ${extra.length} extra scope${extra.length === 1 ? "" : "s"}${fixHome ? ` · set home=${keepId}` : ""}`);
    if (APPLY) {
      // SOFT revoke, matching the product (food.ts DELETE /scopes flips isActive
      // rather than deleting, H5): the row is the audit trail of who was granted
      // what, and a re-grant reactivates it instead of hitting uq_user_scopes_grant_*.
      for (const s of extra) {
        await db.update(userScopesTable).set({ isActive: false }).where(eq(userScopesTable.id, s.id));
      }
      if (fixHome) await db.update(usersTable).set({ propertyId: keepId }).where(eq(usersTable.id, lead.id));
    }
    changed++;
  }

  console.log(`\n${APPLY ? "Updated" : "Would update"} ${changed} unit lead(s)\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
