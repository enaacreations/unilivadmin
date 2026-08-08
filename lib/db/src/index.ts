import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
const hasPgEnv = !!(process.env.PGHOST || process.env.PGDATABASE);

if (!connectionString && !hasPgEnv) {
  throw new Error(
    "Database config missing. Set DATABASE_URL, or the standard PG* vars " +
      "(PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE). PG* avoids URL-encoding " +
      "passwords that contain characters like / or #.",
  );
}

// With no connectionString, node-postgres reads the PG* env vars directly,
// which sidesteps URL-encoding pitfalls for special-character passwords.
//
// Pool is bounded with sane timeouts so a burst of slow queries can't exhaust
// Postgres connections or pile up unbounded. Tunable via PG_POOL_* env vars.
// SSL is opt-in (PGSSL=true / sslmode in the URL); the default deployment talks
// to host Postgres over a Unix socket, where TLS is neither needed nor available.
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const useSsl =
  process.env["PGSSL"] === "true" ||
  /sslmode=require/.test(process.env["DATABASE_URL"] || "");

/**
 * Invariant: every `timestamp` (no time zone) column in this database holds UTC
 * WALL-CLOCK — 09:00 IST is stored as 03:30. The app half already holds: Drizzle
 * serialises a JS Date with `toISOString()` and parses it back as `value +
 * "+0000"`, and the IST helpers in apps/api-server/src/lib/tz.ts build instants
 * explicitly via Date.UTC.
 *
 * The DB half did NOT hold. `defaultNow()` renders `now()` in the SESSION
 * timezone, which on these boxes is Asia/Kolkata, so DB-written and app-written
 * timestamps landed in the same column on two clocks 5h30m apart — a
 * food_menu_shares row read as revoked before it was created, and
 * notification_outbox `sent_at` preceded `created_at`, making delivery latency
 * negative. It also double-shifted every analytics bucket that follows the
 * `to_char(col + interval '330 minutes', …)` UTC→IST-calendar-day convention.
 *
 * Pinning the session to UTC puts `now()`, `localtimestamp` and every
 * timestamp↔timestamptz coercion on the same clock the app writes. PGOPTIONS is
 * appended last so an operator can still override (later `-c` wins).
 */
const pgOptions = ["-c TimeZone=UTC", process.env["PGOPTIONS"] || ""].filter(Boolean).join(" ");

export const pool = new Pool({
  ...(connectionString ? { connectionString } : {}),
  options: pgOptions,
  max: num(process.env["PG_POOL_MAX"], 10),
  idleTimeoutMillis: num(process.env["PG_IDLE_TIMEOUT_MS"], 30_000),
  connectionTimeoutMillis: num(process.env["PG_CONN_TIMEOUT_MS"], 10_000),
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// A pool-level error (e.g. an idle backend dropped by Postgres) must not crash
// the process; log and let node-postgres re-establish on the next checkout.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] idle client error", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
