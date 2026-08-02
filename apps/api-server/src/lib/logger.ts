import pino from "pino";

// Pretty logging is gated on its OWN flag (LOG_PRETTY=true), NOT on NODE_ENV.
// pino-pretty runs in a worker thread (thread-stream-worker.mjs) that the slim
// production bundle doesn't ship — so tying it to NODE_ENV meant running the
// server in "development" (or with NODE_ENV unset) crashed the container on boot.
// Decoupling it lets NODE_ENV=development run anywhere (plain JSON, no worker)
// while local dev still gets pretty logs by setting LOG_PRETTY=true (its build
// includes the worker). Default everywhere: plain JSON to stdout.
const usePrettyLogs = process.env.LOG_PRETTY === "true";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(usePrettyLogs
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
