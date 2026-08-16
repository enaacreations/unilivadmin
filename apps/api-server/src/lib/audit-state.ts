/**
 * Audit & Inspection — guarded state machines (spec §4.1 / §5.7).
 *
 * Transition maps as data (same idiom as food's DISPATCH_TRANSITIONS)
 * plus executors that validate the map, apply state-specific column updates
 * and append a hash-chained STATE_CHANGE event in the SAME transaction.
 * Illegal transitions throw 409 ILLEGAL_TRANSITION; callers log a
 * DENIED_ATTEMPT event outside the failed transaction (FRD-EXE-03 AC).
 *
 * `Overdue` is a derived flag on audits, never a state.
 */
import { eq } from "drizzle-orm";
import { auditsTable } from "@workspace/db";
import { httpError } from "./authz.js";
import { appendAuditEvent, type DbLike } from "./audit-events.js";

export type AuditState =
  | "DRAFT"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "PAUSED"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "REJECTED"
  | "APPROVED"
  | "CLOSED"
  | "CANCELLED";

export type TemplateVersionLifecycle =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "PUBLISHED"
  | "DEPRECATED"
  | "ARCHIVED";

/**
 * Audit lifecycle (spec §4.1, trimmed to the PRD v1.0 review flow).
 *
 * Every submit routes to SUBMITTED; reviewers approve or reject from there.
 *
 * REJECTED is the single "send it back" state: a review rejection AND an
 * Operations Excellence reopen of a finished audit both land there, and it is
 * a resting state the audit actually commits to — the auditor's Rework bucket.
 * The only way out is POST /audits/:id/start, which demands a fresh geotagged
 * start photo, so every rework re-proves presence exactly like a first run.
 *
 * PAUSED / UNDER_REVIEW / CANCELLED are orphaned states kept only so legacy
 * rows can exit them — nothing enters them anymore.
 */
export const AUDIT_TRANSITIONS: Record<AuditState, AuditState[]> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["SUBMITTED"],
  PAUSED: ["IN_PROGRESS"], // legacy escape only
  SUBMITTED: ["APPROVED", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"], // legacy escape only
  REJECTED: ["IN_PROGRESS"],
  APPROVED: ["CLOSED", "REJECTED"],
  CLOSED: ["REJECTED"],
  CANCELLED: [],
};

/** States a finished audit can be reopened from (OE only, guarded by callers). */
export const REOPENABLE_STATES: AuditState[] = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CLOSED"];

/**
 * TemplateVersion lifecycle (spec §5.7). Published versions are immutable.
 * Publish is DRAFT→PUBLISHED only; PENDING_APPROVAL is an orphaned value kept
 * so legacy pending versions can still be published or bounced back.
 */
export const TEMPLATE_VERSION_TRANSITIONS: Record<
  TemplateVersionLifecycle,
  TemplateVersionLifecycle[]
> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PENDING_APPROVAL: ["PUBLISHED", "DRAFT"], // legacy escape only
  PUBLISHED: ["DEPRECATED"],
  DEPRECATED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransition<S extends string>(
  map: Record<S, S[]>,
  from: S,
  to: S,
): boolean {
  return (map[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(
  map: Record<S, S[]>,
  from: S,
  to: S,
  entity: string,
): void {
  if (!canTransition(map, from, to)) {
    throw httpError(409, "ILLEGAL_TRANSITION", {
      entity,
      from,
      to,
      allowed: map[from] ?? [],
    });
  }
}

export interface TransitionActor {
  /** Null = system actor (P6). */
  id: string | null;
  role?: string | null;
}

export interface AuditTransitionCtx {
  actor: TransitionActor;
  reason?: string | null;
  /** Auto-captured at Start/Submit (FRD-EXE-14); auditor-uneditable. */
  geo?: { lat: number; lng: number } | null;
}

/**
 * Apply a validated audit transition: state column, state-specific timestamp
 * side-effects, and the STATE_CHANGE event — all in the caller's transaction.
 * Business guards (submit gate, close gate, reopen authority) are enforced by
 * the calling service BEFORE this runs; this function owns only the machine.
 */
export async function applyAuditTransition(
  tx: DbLike,
  audit: { id: string; state: string; startedAt: Date | null; reopenCount: number },
  to: AuditState,
  ctx: AuditTransitionCtx,
): Promise<void> {
  const from = audit.state as AuditState;
  assertTransition(AUDIT_TRANSITIONS, from, to, "AUDIT");

  const now = new Date();
  const set: Record<string, unknown> = { state: to, updatedAt: now };

  if (to === "IN_PROGRESS") {
    /* Every entry into IN_PROGRESS comes through /start, which has already
       validated a fresh geotagged start photo — so a rework re-stamps the
       start time and location instead of inheriting the first attempt's.
       Leaving them stale also inflated durationSeconds on every rework. */
    set["startedAt"] = now;
    if (ctx.geo) {
      set["startGeoLat"] = ctx.geo.lat;
      set["startGeoLng"] = ctx.geo.lng;
    }
  }
  if (to === "REJECTED" && (from === "APPROVED" || from === "CLOSED")) {
    // OE reopen of a finished audit (FRD-REV-06): caller verified authority
    // and reason. Clear the completion stamps so the row reads as open again.
    set["reopenCount"] = audit.reopenCount + 1;
    set["closedAt"] = null;
    set["approvedAt"] = null;
  }
  if (to === "SUBMITTED" || (to === "APPROVED" && from === "SUBMITTED")) {
    // Atomic submit stamps submittedAt/geo/duration itself (it owns scoring);
    // only fill the basics here for safety if the caller didn't.
    set["isOverdue"] = false;
  }
  if (to === "APPROVED") set["approvedAt"] = now;
  if (to === "CLOSED") set["closedAt"] = now;
  if (to === "CANCELLED") {
    set["cancelledAt"] = now;
    if (ctx.reason) set["cancelReason"] = ctx.reason;
  }

  await tx.update(auditsTable).set(set).where(eq(auditsTable.id, audit.id));

  await appendAuditEvent(tx, {
    entityType: "AUDIT",
    entityId: audit.id,
    auditId: audit.id,
    actorId: ctx.actor.id,
    actorRole: ctx.actor.role ?? null,
    kind: "STATE_CHANGE",
    fromState: from,
    toState: to,
    reason: ctx.reason ?? null,
  });
}

