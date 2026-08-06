import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { runSlaCheck } from "./routes/complaints.js";
import { runDueBillingCycles, runDueReminders } from "./routes/finance.js";
import {
  runAuditMaterializer,
  runAuditReminders,
  runAuditOverdueCheck,
  runAuditAutoClose,
} from "./lib/audit-jobs.js";
import { runReportWorker } from "./lib/audit-report-service.js";
import { sweepPendingOutbox } from "@workspace/notify-core";
import { RUN_SCHEDULERS } from "./config/env.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Crash-safety: never let an unhandled rejection/exception silently wedge the
// event loop. Log and exit so the container orchestrator restarts a clean process.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

const scheduledTimers: NodeJS.Timeout[] = [];

// Bind explicitly to 0.0.0.0 so the server is reachable over IPv4 inside
// containers (Linux defaults to IPv6-only when the host is omitted).
const server: Server = app.listen(port, "0.0.0.0", (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, schedulers: RUN_SCHEDULERS }, "Server listening");

  if (RUN_SCHEDULERS) {
    // SLA breach check every 5 minutes (+ once on startup).
    const slaInterval = setInterval(() => {
      runSlaCheck().catch((e) => logger.error({ err: e }, "SLA check failed"));
    }, 5 * 60 * 1000);
    runSlaCheck().catch((e) => logger.error({ err: e }, "SLA check failed"));

    // Finance scheduler: billing cycles + reminders, every hour (+ once on boot).
    const financeInterval = setInterval(() => {
      runDueBillingCycles().catch((e) => logger.error({ err: e }, "Billing cycle scheduler failed"));
      runDueReminders().catch((e) => logger.error({ err: e }, "Reminder scheduler failed"));
    }, 60 * 60 * 1000);
    runDueBillingCycles().catch((e) => logger.error({ err: e }, "Billing cycle scheduler failed (initial)"));
    runDueReminders().catch((e) => logger.error({ err: e }, "Reminder scheduler failed (initial)"));

    // Audit & Inspection jobs (FA-05 / FRD-NTF-02 / spec §4.1): occurrence
    // materializer, pre-occurrence reminders, overdue flagging — every 5 min
    // (+ once on boot for restart catch-up per NFR-04; idempotent by design).
    const auditJobs = () => {
      runAuditMaterializer().catch((e) => logger.error({ err: e }, "Audit materializer failed"));
      runAuditReminders().catch((e) => logger.error({ err: e }, "Audit reminders failed"));
      runAuditOverdueCheck().catch((e) => logger.error({ err: e }, "Audit overdue check failed"));
      runAuditAutoClose().catch((e) => logger.error({ err: e }, "Audit auto-close failed"));
      runReportWorker().catch((e) => logger.error({ err: e }, "Audit report worker failed"));
    };
    const auditInterval = setInterval(auditJobs, 5 * 60 * 1000);
    auditJobs();

    // Notification outbox drain (H3). Request-path inline delivery is bounded-retry
    // and deliberately NOT terminal — a send that exhausts its attempts stays
    // PENDING so it can be retried later. Without a drain that is a different
    // permanent non-delivery, so the api gets its own: the shipped compose file
    // has no notify-service worker, and REDIS_URL may be unset. The sweep charges
    // each pass against MAX_DELIVERY_ATTEMPTS and marks the row FAILED once that
    // budget is spent, so this cannot become a perpetual retry loop.
    // RUN_SCHEDULERS defaults ON (config/env.ts), so this runs by default; the
    // in-flight latch stops a slow pass from overlapping the next tick, and the
    // sweep's atomic per-row claim covers the multi-instance case. Never throws;
    // returns the number of rows it acted on.
    let outboxSweeping = false;
    const outboxInterval = setInterval(() => {
      if (outboxSweeping) return;
      outboxSweeping = true;
      void sweepPendingOutbox()
        .then((n) => { if (n) logger.info({ n }, "notification outbox swept"); })
        .finally(() => { outboxSweeping = false; });
    }, 60_000);

    scheduledTimers.push(slaInterval, financeInterval, auditInterval, outboxInterval);
  }
});

// Graceful shutdown: stop timers, stop accepting connections, drain in-flight
// requests, then close the DB pool. Force-exit if draining stalls.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  for (const t of scheduledTimers) clearInterval(t);

  const force = setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);
  force.unref();

  server.close(async () => {
    try {
      await pool.end();
    } catch (e) {
      logger.error({ err: e }, "Error closing DB pool");
    }
    clearTimeout(force);
    logger.info("Shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
