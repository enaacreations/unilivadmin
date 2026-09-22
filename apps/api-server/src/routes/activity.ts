/**
 * Activity trail read API (PRD §29).
 *
 * §29 requires each event to capture User, Timestamp, Action, Entity, Previous
 * value, New value, and "Reason where required" — so this returns the
 * before/after pair and the reason as first-class fields, not buried in a blob.
 *
 * Two things the legacy /settings/audit-log got wrong and this does not:
 *  - facets come from the CODE registry, not two selectDistinct full scans on
 *    an unindexed table per page load;
 *  - the read is SCOPED, so a property-bound viewer sees their own estate.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, activityEventsTable, usersTable } from "@workspace/db";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { scopedPropertyId, sendAuthzError } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { ACTIVITY_EVENTS, type EventDef } from "../lib/activity/events.js";
import { resolveLabels } from "../lib/activity/labels.js";

const router: IRouter = Router();

/** Filter vocabulary, from the registry — no table scan. */
router.get("/facets", authenticate, authorize("AUDIT_LOG", "view"), (_req, res) => {
  // `satisfies` narrows each entry to its own literal type, so the union has
  // no common `chainKey`. Widen to the declared shape to read it.
  const registry = ACTIVITY_EVENTS as unknown as Record<string, EventDef>;
  const events = Object.entries(registry).map(([key, def]) => ({
    key,
    category: def.category,
    entityType: def.entityType,
    reasonRequired: def.reasonRequired,
    chained: !!def.chainKey,
  }));
  res.json({
    success: true,
    data: {
      events,
      categories: [...new Set(events.map((e) => e.category))].sort(),
      entityTypes: [...new Set(events.map((e) => e.entityType))].sort(),
    },
  });
});

router.get("/", authenticate, authorize("AUDIT_LOG", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;

    const conds = [];
    if (q["event"]) conds.push(eq(activityEventsTable.event, q["event"]));
    if (q["category"]) conds.push(eq(activityEventsTable.category, q["category"]));
    if (q["entityType"]) conds.push(eq(activityEventsTable.entityType, q["entityType"]));
    if (q["actorId"]) conds.push(eq(activityEventsTable.actorId, q["actorId"]));
    if (q["entityId"]) conds.push(eq(activityEventsTable.entityId, q["entityId"]));
    if (q["hasReason"] === "true") conds.push(isNotNull(activityEventsTable.reason));
    if (q["from"]) {
      const d = new Date(q["from"]);
      if (!Number.isNaN(d.getTime())) conds.push(gte(activityEventsTable.occurredAt, d));
    }
    if (q["to"]) {
      const d = new Date(q["to"]);
      if (!Number.isNaN(d.getTime())) conds.push(lte(activityEventsTable.occurredAt, d));
    }
    if (q["search"]) {
      const s = `%${q["search"]}%`;
      conds.push(or(
        ilike(activityEventsTable.event, s),
        ilike(activityEventsTable.entityLabel, s),
        ilike(activityEventsTable.reason, s),
      )!);
    }

    // A property-bound viewer sees their own estate. Rows with no property are
    // org-wide events (a role change, a matrix edit) and stay visible: hiding
    // them would tell a warden that nothing happened when something did.
    const scope = scopedPropertyId(req);
    if (scope) {
      conds.push(or(eq(activityEventsTable.propertyId, scope), sql`${activityEventsTable.propertyId} is null`)!);
    }

    const where = conds.length ? and(...conds) : undefined;

    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(activityEventsTable)
      .where(where);

    const rows = await db
      .select({
        e: activityEventsTable,
        actorName: usersTable.name,
        actorEmail: usersTable.email,
      })
      .from(activityEventsTable)
      .leftJoin(usersTable, eq(activityEventsTable.actorId, usersTable.id))
      .where(where)
      .orderBy(desc(activityEventsTable.seq))
      .limit(limit)
      .offset(offset);

    // Names for the ids inside the before/after payloads. Three batched queries
    // for the whole page — an unresolved id simply stays an id, so a deleted
    // node never blanks a row out.
    const labels = await resolveLabels(rows.map((r) => r.e));

    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.e,
        // Null actor is the system actor (a scheduler, the materializer) — say
        // so rather than rendering a blank cell.
        actorName: r.actorName ?? (r.e.actorId ? null : "System"),
        actorEmail: r.actorEmail,
      })),
      labels,
      meta: buildMeta(count?.n ?? 0, page, limit),
    });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * Chain integrity for one stream.
 *
 * Bounded to a single chainKey on purpose: verifying "everything" would walk
 * all of history, which is the property that made the audit module's single
 * global chain unusable at platform scale.
 */
router.get("/verify", authenticate, authorize("AUDIT_LOG", "view"), async (req, res) => {
  const chainKey = (req.query["chainKey"] as string | undefined) ?? "ACCESS";
  const rows = await db
    .select({ seq: activityEventsTable.seq, hash: activityEventsTable.hash, prevHash: activityEventsTable.prevHash })
    .from(activityEventsTable)
    .where(eq(activityEventsTable.chainKey, chainKey))
    .orderBy(activityEventsTable.seq);

  let prev = "GENESIS";
  let brokenAt: number | null = null;
  for (const r of rows) {
    if (r.prevHash !== prev) { brokenAt = r.seq; break; }
    prev = r.hash ?? prev;
  }
  res.json({
    success: true,
    data: { chainKey, checked: rows.length, valid: brokenAt === null, firstBrokenSeq: brokenAt, verifiedAt: new Date() },
  });
});

export { router as activityRouter };
export default router;
