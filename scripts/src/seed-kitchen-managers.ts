/**
 * One F&B manager login per kitchen — safe to run on ANY environment.
 *
 *   pnpm --filter @workspace/scripts run seed:kitchen-managers
 *
 * This exists as a standalone entry point because `seed:food-extra`, which also
 * calls seedKitchenManagers(), is NOT safe on a live environment: it runs
 * `DELETE FROM food_menu_rotation WHERE kitchen_id IS NOT NULL` and rebuilds
 * every per-kitchen menu from the brand templates, discarding hand-edited
 * menus. This script only ever INSERTs users and rewrites the scope rows of the
 * accounts it owns.
 *
 * The model (see api-server `resolveAccessibleKitchenIds`): a manager sees the
 * orders of every property tagged to their kitchen, drives its prep/dispatch,
 * and edits that kitchen's menu rotation and nothing else.
 *
 * Idempotent: users upsert-skip on any unique conflict (id / email / username),
 * and scope rows are RECONCILED (never deleted) for these user ids only.
 * Existing accounts — including the org-wide `fnbmanager@uniliv.com` — are
 * never touched.
 */
import { db, pool } from "@workspace/db";
import { usersTable, kitchensTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import { assertSeedTarget } from "./seed-guard.js";
import { syncUserScopes, describeScopeSync } from "./user-scopes.js";

/** Stable user id for a kitchen's manager, e.g. KIT-BLR-WF → user_fnb_kit_blr_wf. */
export const kitchenManagerUserId = (kitchenCode: string) =>
  `user_fnb_${kitchenCode.toLowerCase().replace(/-/g, "_")}`;

/** Login local-part for a kitchen, e.g. KIT-BLR-WF → fnb.blr-wf. */
export const kitchenManagerSlug = (kitchenCode: string) =>
  `fnb.${kitchenCode.replace(/^KIT-/, "").toLowerCase()}`;

export async function seedKitchenManagers(): Promise<number> {
  console.log("  per-kitchen F&B manager logins...");
  const kitchens = await db
    .select({
      id: kitchensTable.id,
      code: kitchensTable.code,
      name: kitchensTable.name,
      contactName: kitchensTable.contactName,
      contactPhone: kitchensTable.contactPhone,
    })
    .from(kitchensTable)
    .orderBy(kitchensTable.code);
  if (!kitchens.length) {
    console.log("  ⚠ no kitchens yet — skipping kitchen F&B managers");
    return 0;
  }

  const passwordHash = await bcrypt.hash("Admin@123", 10);
  const userIds: string[] = [];
  for (const k of kitchens) {
    const slug = kitchenManagerSlug(k.code);
    const userId = kitchenManagerUserId(k.code);
    userIds.push(userId);
    await db
      .insert(usersTable)
      .values({
        id: userId,
        name: k.contactName ?? `${k.name} F&B Manager`,
        email: `${slug}@uniliv.com`,
        username: slug,
        phone: k.contactPhone,
        designation: `F&B Manager — ${k.name}`,
        role: "FNB_MANAGER",
        propertyId: null,
        passwordHash,
        isActive: true,
        updatedAt: new Date(),
      })
      // No target → skip on ANY unique conflict (id, email or username), so
      // re-runs never crash and an existing password is never overwritten.
      .onConflictDoNothing();
  }

  // Reconcile, never DELETE: revocation is a soft `is_active` flag (H5), so
  // deleting a manager's grant here would erase a deliberate access decision
  // instead of the seed re-stating the one it owns. See user-scopes.ts.
  const sync = await syncUserScopes(
    userIds,
    kitchens.map((k, i) => ({
      userId: userIds[i]!,
      scopeLevel: "KITCHEN" as const,
      kitchenId: k.id,
    })),
  );
  console.log(`  ✓ ${kitchens.length} kitchen-scoped F&B managers (fnb.<kitchen>@uniliv.com / Admin@123) — scopes: ${describeScopeSync(sync)}`);
  for (const k of kitchens) console.log(`      ${kitchenManagerSlug(k.code)}@uniliv.com → ${k.code} (${k.name})`);
  return kitchens.length;
}

// Standalone entry point. seed-food-extra imports the function instead.
const isEntryPoint = process.argv[1]?.includes("seed-kitchen-managers");
if (isEntryPoint) {
  // Guard the standalone entry point only: when seed:food-extra calls the
  // function it has already asserted the same target for itself.
  assertSeedTarget("seed:kitchen-managers")
    .then(() => seedKitchenManagers())
    .then(async () => {
      console.log("✅ Kitchen F&B managers seeded");
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("❌ Seed failed:", err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
