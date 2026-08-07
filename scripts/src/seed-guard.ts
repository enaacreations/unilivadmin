/**
 * The one check every seed runs before it writes: is this the database you
 * meant?
 *
 * Seeds are the most destructive scripts in the repo — `seed` TRUNCATEs 60+
 * tables, `seed:food` TRUNCATEs the menu rotation, the per-resident rules and
 * the whole order history, `seed:food-extra` rebuilds every per-kitchen menu
 * from the brand templates. All of that is correct on a scratch database and
 * unrecoverable on a live one, and nothing in `pnpm --filter @workspace/scripts
 * run seed:food` names which database it is about to do it to. `DATABASE_URL`
 * is an environment variable: one stale `export` in a shell is the entire
 * distance between the two.
 *
 * The house pattern for a destructive script (clear-food-orders.ts,
 * dedupe-food.ts, drop-dead-columns.ts) is: print the target database, and
 * require an explicit `--yes` before doing the irreversible thing. A seed
 * cannot default to a dry run — seeding IS the point — so it inverts the same
 * rule: it runs silently only against a target that is unambiguously a
 * development one, and demands `--yes` for anything else.
 *
 * A target is "development" only when BOTH hold:
 *   • NODE_ENV is `development` or `test` — fail-closed the same way the API's
 *     config is (apps/api-server/src/config/env.ts): unset is NOT development,
 *     because an unset NODE_ENV is what a bare shell on a server looks like.
 *   • the connection is local — a Unix socket, or localhost/127.0.0.1/::1, or
 *     `host.docker.internal` (the TCP fallback DEPLOYMENT.md §2 documents for
 *     reaching the host's Postgres from a container).
 *
 * Neither signal is sufficient alone: production connects over the host's Unix
 * socket (DEPLOYMENT.md §2), so "local" does not mean "safe"; and a laptop with
 * NODE_ENV=development can hold a production `DATABASE_URL`.
 *
 * `--yes` is not a lock, it is a receipt: the deploy runbook seeds a fresh
 * production database on purpose, and passing the flag makes that an act
 * someone performed rather than one that happened.
 */
import { pool } from "@workspace/db";

/** Hostnames that can only mean "the machine running this script". */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/**
 * How this process is about to reach Postgres, in words a human can check.
 *
 * Parsed by hand rather than with `new URL()`: the socket form the production
 * compose file uses — `postgresql://user:pw@/uniliv?host=/var/run/postgresql`
 * (DEPLOYMENT.md §2) — has an EMPTY authority host, which WHATWG rejects
 * outright. Treating a throw as "not local" would have been safe but would
 * report the deploy's own DSN as unparseable, so the guard would be lying about
 * the one target it most needs to describe accurately.
 */
function connectionTarget(): { host: string; local: boolean } {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    // Raw PG* vars — the alternative DEPLOYMENT.md §2 offers when the password
    // needs characters that are painful to percent-encode in a URL. An unset
    // PGHOST means libpq's default: the local Unix socket.
    const host = process.env["PGHOST"] ?? "";
    return { host: host || "(local socket)", local: host.startsWith("/") || LOCAL_HOSTS.has(host) };
  }
  // An explicit `host=` parameter wins, exactly as libpq treats it.
  const socket = /[?&]host=([^&]*)/.exec(url)?.[1];
  if (socket) {
    const path = decodeURIComponent(socket);
    return { host: path, local: path.startsWith("/") || LOCAL_HOSTS.has(path) };
  }
  // scheme://[user[:pw]@]host[:port]/db… — the password may itself contain '@',
  // so the authority ends at the LAST '@' before the path.
  const authority = url.replace(/^[a-z+]+:\/\//i, "").split(/[/?]/)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1)   // [::1]:5432
    : (hostPort.split(":")[0] ?? "");
  return { host: host || "(local socket)", local: LOCAL_HOSTS.has(host) };
}

/**
 * Announce the target database and stop unless it is a development one or the
 * operator said `--yes`. Throws (rather than exiting) so each seed's own
 * catch/`pool.end()` teardown still runs.
 */
export async function assertSeedTarget(script: string): Promise<void> {
  const { host, local } = connectionTarget();
  const nodeEnv = process.env["NODE_ENV"] ?? "(unset)";
  const isDevEnv = nodeEnv === "development" || nodeEnv === "test";
  const forced = process.argv.includes("--yes");

  // Decide BEFORE connecting. A refusal that needs a working connection is not
  // a refusal — it would depend on the wrong database being reachable, and the
  // operator would read a DNS error instead of the reason they were stopped.
  if (!((local && isDevEnv) || forced)) {
    console.error(
      `\n❌ ${script} refuses to run against ${host}.\n` +
        (local ? "" : "   The connection is not local.\n") +
        (isDevEnv ? "" : `   NODE_ENV is ${nodeEnv}, not development/test.\n`) +
        `   Seeds truncate and rewrite data; on a live database that is not recoverable.\n` +
        `   If this really is the database you meant, re-run with:  -- --yes\n`,
    );
    throw new Error("refusing to seed a non-development database without --yes");
  }

  const { rows } = await pool.query<{ d: string; u: string }>(
    "SELECT current_database() AS d, current_user AS u",
  );
  console.log(
    `Target: ${rows[0]?.d ?? "?"} @ ${host} (user ${rows[0]?.u ?? "?"}, NODE_ENV=${nodeEnv})`,
  );
  if (forced && !(local && isDevEnv)) {
    console.log(`⚠ ${script}: writing to a NON-development target because --yes was passed.`);
  }
}
