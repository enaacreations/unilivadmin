/**
 * Every registered activity event must have a producer.
 *
 * PRD §29 names thirteen events. Without this, "we record the thirteen" quietly
 * becomes "we record seven, and the registry still lists thirteen" — the
 * registry reads as coverage while being a wish list.
 *
 * Greps the source for each key rather than inspecting runtime behaviour: a
 * producer is a call site, and a call site is a string in a file. Crude, but it
 * cannot be satisfied by anything except actually writing the event.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY_EVENTS } from "../lib/activity/events.js";

const SRC = join(import.meta.dirname, "..");

/**
 * Events whose producing module does not exist yet, each naming what it waits
 * on. This list shrinks as the PRD's modules land; an entry without a real
 * blocker is how the rule erodes, so keep the reasons concrete.
 */
const AWAITING_MODULE: Record<string, string> = {
  BED_STATUS_CHANGED: "no Bed entity yet (PRD §9) — nothing to change the status of",
  ISSUE_CREATED: "no Issue Management module yet (PRD §12)",
  ISSUE_ASSIGNED: "no Issue Management module yet (PRD §12)",
  ISSUE_CLOSED: "no Issue Management module yet (PRD §12)",
  MAINTENANCE_STATUS_CHANGED: "no Maintenance work-order module yet (PRD §13); complaints is the nearest",
  MENU_MODIFIED: "menu rotation has no approval workflow yet (PRD §19)",
  MENU_APPROVED: "menu rotation has no approval workflow yet (PRD §19)",
  AUDIT_SCORE_CHANGED: "scores are frozen at submit; no post-hoc rescore path exists",
  AUDIT_COMPLETED: "emitted through audit_events' own chain, not the platform trail",
  USER_CREATED: "still on the legacy writeAuditLog adapter",
  USER_UPDATED: "still on the legacy writeAuditLog adapter",
  CONFIG_CHANGED: "still on the legacy writeAuditLog adapter",
  WALLET_TXN: "still on the legacy writeAuditLog adapter",
};

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walkFiles(p, out);
    } else if (e.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

const sources = walkFiles(SRC)
  .filter((f) => !f.includes("/lib/activity/events.ts"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("activity trail coverage", () => {
  it("has a producer for every registered event, or an explicit blocker", () => {
    const orphans = Object.keys(ACTIVITY_EVENTS)
      .filter((key) => !sources.includes(`"${key}"`))
      .filter((key) => !AWAITING_MODULE[key])
      .sort();
    expect(orphans).toEqual([]);
  });

  it("does not list a blocker for an event that already has a producer", () => {
    // Keeps the waiting-list honest: once an event is wired, its excuse must go,
    // otherwise the list stops meaning anything.
    const stale = Object.keys(AWAITING_MODULE)
      .filter((key) => sources.includes(`event: "${key}"`))
      .sort();
    expect(stale).toEqual([]);
  });

  it("records the access-control plane, which is the part that must be traceable", () => {
    for (const key of ["ACCESS_DENIED", "ACCESS_PREVIEWED", "GRANT_CREATED", "GRANT_REVOKED", "ROLE_CHANGED", "PROPERTY_ASSIGNMENT_CHANGED", "SOD_OVERRIDDEN"]) {
      expect(sources, `${key} has no producer`).toContain(`event: "${key}"`);
    }
  });
});
