import app from "./app";
import { logger } from "./lib/logger";
import { runSlaCheck } from "./routes/complaints.js";
import { runDueBillingCycles, runDueReminders } from "./routes/finance.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bind explicitly to 0.0.0.0 so the server is reachable over IPv4 inside
// containers (Linux defaults to IPv6-only when the host is omitted).
app.listen(port, "0.0.0.0", (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // SLA breach check every 5 minutes
  const slaInterval = setInterval(() => {
    runSlaCheck().catch((e) => logger.error({ err: e }, "SLA check failed"));
  }, 5 * 60 * 1000);
  // Run once on startup
  runSlaCheck().catch((e) => logger.error({ err: e }, "SLA check failed"));

  // Finance scheduler: billing cycles + reminders, every hour
  const financeInterval = setInterval(() => {
    runDueBillingCycles().catch((e) => logger.error({ err: e }, "Billing cycle scheduler failed"));
    runDueReminders().catch((e) => logger.error({ err: e }, "Reminder scheduler failed"));
  }, 60 * 60 * 1000);
  // Also kick off once on boot so a fresh dev env has data
  runDueBillingCycles().catch((e) => logger.error({ err: e }, "Billing cycle scheduler failed (initial)"));
  runDueReminders().catch((e) => logger.error({ err: e }, "Reminder scheduler failed (initial)"));

  process.on("SIGTERM", () => { clearInterval(slaInterval); clearInterval(financeInterval); });
});
