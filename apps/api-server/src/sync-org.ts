/**
 * Build the org-tree projection (`org_nodes` + closure) from the source rows,
 * then backfill `access_grants` from the legacy scopes.
 *
 *   pnpm --filter @workspace/api-server run org:sync
 *
 * WHY THIS EXISTS: `syncOrgNodes()` / `backfillAccessGrants()` are only ever
 * called incrementally (on a property/room/kitchen write) — there was no way to
 * build the whole projection for a freshly provisioned database, so `org_nodes`
 * came up EMPTY and the UAM Access/Entities views had no places to resolve
 * against. This is the org-tree twin of `roles:sync`.
 *
 * Safe to re-run: syncOrgNodes rebuilds the projection from source, and the
 * backfill inserts with onConflictDoNothing.
 */
import { syncOrgNodes, backfillAccessGrants } from "./lib/org-sync.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const nodes = await syncOrgNodes();
  logger.info({ ...nodes }, "org_nodes projected from source rows");

  const grants = await backfillAccessGrants();
  logger.info({ ...grants }, "access_grants backfilled from legacy scopes");

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "org sync failed");
  process.exit(1);
});
