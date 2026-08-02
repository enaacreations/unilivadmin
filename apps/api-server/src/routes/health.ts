import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Liveness: is the process up? Cheap, no dependencies — used by the container
// healthcheck. Must NOT touch the DB (a DB blip shouldn't kill the container).
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: can we actually serve traffic (DB reachable)? Returns 503 when not,
// so a load balancer can pull the instance out of rotation without killing it.
router.get("/readyz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ success: true, status: "ready", db: "up" });
  } catch {
    res.status(503).json({ success: false, status: "not-ready", db: "down" });
  }
});

export default router;
