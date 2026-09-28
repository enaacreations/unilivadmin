/**
 * Provision `roles` + `role_functionalities` from the code matrix.
 *
 *   pnpm --filter @workspace/api-server run roles:sync
 *
 * WHY THIS EXISTS: nothing called `seedMatrix`. It had been written, tested and
 * then never wired to anything, so a freshly provisioned database came up with
 * an empty `roles` table — no role definitions at all, however many times the
 * seeds were run. The roles in the reference database were there only because
 * somebody had applied SQL by hand.
 *
 * Safe to re-run. It upserts the definition of every role the manifest declares
 * and replaces that role's cells, and it REPORTS roles the manifest no longer
 * declares rather than deleting them — retiring a role revokes it from whoever
 * holds it, which is a migration with a decision behind it, not a side effect of
 * provisioning.
 */
import { seedMatrix } from "./lib/access/matrix.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const report = await seedMatrix(null);
  logger.info(
    { roles: report.roles, cells: report.cells, computed: report.skippedSystem },
    "roles synced from the code matrix",
  );

  if (report.unknown.length) {
    logger.warn(
      { roles: report.unknown },
      "roles exist in the database that the manifest does not declare — left untouched; " +
        "retire them with a migration if that is intended",
    );
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "role sync failed");
  process.exit(1);
});
