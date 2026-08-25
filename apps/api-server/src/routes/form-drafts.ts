import { Router } from "express";
import { db, formDraftsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { newId } from "../lib/id.js";

export const formDraftsRouter = Router();

/**
 * Auto-saved in-progress forms, so closing the app mid-form doesn't lose the work.
 *
 * Ownership *is* the authorization model here: a draft belongs to exactly one
 * user and every query below is filtered by `req.user!.id`, so there is no RBAC
 * module gate — only `authenticate`. Never add a route that takes a userId from
 * the request; that would turn this into a cross-user read of half-typed PII.
 *
 * The key travels as a query param / body field rather than a path segment
 * because keys contain ':' (e.g. "vendor-form:new") and would otherwise need
 * double-encoding to survive Express path parsing.
 */

/** Cap on a single draft's serialized payload. Forms here are text; 256 KB is generous. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Cap on drafts retained per user — oldest are evicted past this. */
const MAX_DRAFTS_PER_USER = 100;
const MAX_KEY_LENGTH = 200;

/** Validates a form key, answering 400 itself. Returns null when invalid. */
function readKey(req: import("express").Request, res: import("express").Response): string | null {
  const raw = (req.method === "GET" || req.method === "DELETE" ? req.query.key : req.body?.key) as unknown;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    res.status(400).json({ success: false, error: "key is required" });
    return null;
  }
  if (key.length > MAX_KEY_LENGTH) {
    res.status(400).json({ success: false, error: `key must be at most ${MAX_KEY_LENGTH} characters` });
    return null;
  }
  return key;
}

/**
 * Every draft the current user has open, newest first. Powers a future
 * "resume where you left off" surface; the per-form hook uses GET /?key= instead.
 */
formDraftsRouter.get("/all", authenticate, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(formDraftsTable)
      .where(eq(formDraftsTable.userId, req.user!.id))
      .orderBy(desc(formDraftsTable.updatedAt));
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** The current user's draft for one form key, or `data: null` when there isn't one. */
formDraftsRouter.get("/", authenticate, async (req, res) => {
  try {
    const key = readKey(req, res);
    if (key == null) return;
    const [row] = await db
      .select()
      .from(formDraftsTable)
      .where(and(eq(formDraftsTable.userId, req.user!.id), eq(formDraftsTable.formKey, key)));
    res.json({ success: true, data: row ?? null });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** Create-or-replace the current user's draft for a form key. */
formDraftsRouter.put("/", authenticate, async (req, res) => {
  try {
    const key = readKey(req, res);
    if (key == null) return;

    const payload = req.body?.payload;
    if (payload == null || typeof payload !== "object") {
      res.status(400).json({ success: false, error: "payload must be an object" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ success: false, error: "Draft is too large to save" });
      return;
    }

    const now = new Date();
    await db
      .insert(formDraftsTable)
      .values({ id: newId(), userId: req.user!.id, formKey: key, payload, updatedAt: now })
      .onConflictDoUpdate({
        target: [formDraftsTable.userId, formDraftsTable.formKey],
        set: { payload, updatedAt: now },
      });

    // Evict the oldest drafts once a user is over the cap, so an abandoned-form
    // habit can't grow this table without bound.
    const keys = await db
      .select({ formKey: formDraftsTable.formKey })
      .from(formDraftsTable)
      .where(eq(formDraftsTable.userId, req.user!.id))
      .orderBy(desc(formDraftsTable.updatedAt));
    for (const stale of keys.slice(MAX_DRAFTS_PER_USER)) {
      await db
        .delete(formDraftsTable)
        .where(and(eq(formDraftsTable.userId, req.user!.id), eq(formDraftsTable.formKey, stale.formKey)));
    }

    res.json({ success: true, data: { key, updatedAt: now } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** Discard a draft — on successful submit, or when the user explicitly drops it. */
formDraftsRouter.delete("/", authenticate, async (req, res) => {
  try {
    const key = readKey(req, res);
    if (key == null) return;
    await db
      .delete(formDraftsTable)
      .where(and(eq(formDraftsTable.userId, req.user!.id), eq(formDraftsTable.formKey, key)));
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default formDraftsRouter;
