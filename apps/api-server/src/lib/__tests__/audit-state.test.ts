import { describe, expect, it } from "vitest";
import {
  AUDIT_TRANSITIONS,
  REOPENABLE_STATES,
  TEMPLATE_VERSION_TRANSITIONS,
  assertTransition,
  canTransition,
  type AuditState,
  type TemplateVersionLifecycle,
} from "../audit-state.js";

const AUDIT_STATES = Object.keys(AUDIT_TRANSITIONS) as AuditState[];
const TV_STATES = Object.keys(TEMPLATE_VERSION_TRANSITIONS) as TemplateVersionLifecycle[];

describe("audit state machine (spec §4.1)", () => {
  it("allows every legal transition and rejects every other pair", () => {
    for (const from of AUDIT_STATES) {
      for (const to of AUDIT_STATES) {
        const legal = AUDIT_TRANSITIONS[from].includes(to);
        expect(canTransition(AUDIT_TRANSITIONS, from, to)).toBe(legal);
      }
    }
  });

  it("approves/rejects directly from SUBMITTED (PRD §8.5) and never enters UNDER_REVIEW", () => {
    expect(canTransition(AUDIT_TRANSITIONS, "SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransition(AUDIT_TRANSITIONS, "SUBMITTED", "REJECTED")).toBe(true);
    expect(canTransition(AUDIT_TRANSITIONS, "SUBMITTED", "UNDER_REVIEW")).toBe(false);
  });

  it("reopens a finished audit into REJECTED, not straight back into progress", () => {
    // A reopen is the same "send it back" as a rejection, so it lands in the
    // auditor's Rework bucket and re-entry goes through the start gate.
    expect(AUDIT_TRANSITIONS.CLOSED).toEqual(["REJECTED"]);
    expect(AUDIT_TRANSITIONS.APPROVED).toEqual(["CLOSED", "REJECTED"]);
    expect(canTransition(AUDIT_TRANSITIONS, "CLOSED", "IN_PROGRESS")).toBe(false);
    expect(canTransition(AUDIT_TRANSITIONS, "APPROVED", "IN_PROGRESS")).toBe(false);
  });

  it("makes /start the only door into IN_PROGRESS, from SCHEDULED or REJECTED", () => {
    const intoProgress = (Object.entries(AUDIT_TRANSITIONS) as [string, string[]][])
      .filter(([, to]) => to.includes("IN_PROGRESS"))
      .map(([from]) => from)
      .sort();
    // PAUSED is a legacy escape kept only so orphaned rows can exit.
    expect(intoProgress).toEqual(["PAUSED", "REJECTED", "SCHEDULED"]);
  });

  it("lists every reopenable state", () => {
    expect(REOPENABLE_STATES).toEqual(["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CLOSED"]);
    for (const from of REOPENABLE_STATES) {
      expect(canTransition(AUDIT_TRANSITIONS, from, "REJECTED")).toBe(true);
    }
  });

  it("keeps CANCELLED terminal", () => {
    expect(AUDIT_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("rejects illegal transitions with 409 ILLEGAL_TRANSITION and allowed list", () => {
    // FRD-EXE-03 AC: Completed(Approved) audit cannot be started.
    try {
      assertTransition(AUDIT_TRANSITIONS, "APPROVED", "IN_PROGRESS", "AUDIT");
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { statusCode?: number; message?: string; details?: { allowed?: string[] } };
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe("ILLEGAL_TRANSITION");
      expect(err.details?.allowed).toEqual(["CLOSED", "REJECTED"]);
    }
    expect(() => assertTransition(AUDIT_TRANSITIONS, "DRAFT", "IN_PROGRESS", "AUDIT")).toThrow();
    expect(() => assertTransition(AUDIT_TRANSITIONS, "SCHEDULED", "SUBMITTED", "AUDIT")).toThrow();
    expect(() => assertTransition(AUDIT_TRANSITIONS, "REJECTED", "APPROVED", "AUDIT")).toThrow();
  });

  it("supports the execution loop Scheduled→InProgress→Submitted and rework", () => {
    expect(canTransition(AUDIT_TRANSITIONS, "SCHEDULED", "IN_PROGRESS")).toBe(true);
    expect(canTransition(AUDIT_TRANSITIONS, "IN_PROGRESS", "SUBMITTED")).toBe(true);
    expect(canTransition(AUDIT_TRANSITIONS, "REJECTED", "IN_PROGRESS")).toBe(true);
  });

  it("never enters PAUSED (orphaned state; legacy rows can only exit)", () => {
    for (const from of AUDIT_STATES) {
      expect(canTransition(AUDIT_TRANSITIONS, from, "PAUSED")).toBe(false);
    }
    expect(AUDIT_TRANSITIONS.PAUSED).toEqual(["IN_PROGRESS"]);
  });
});

describe("template version lifecycle (spec §5.7)", () => {
  it("published versions are immutable — no path back to DRAFT", () => {
    expect(TEMPLATE_VERSION_TRANSITIONS.PUBLISHED).toEqual(["DEPRECATED"]);
  });

  it("publish is DRAFT→PUBLISHED only; PENDING_APPROVAL is a legacy escape", () => {
    expect(canTransition(TEMPLATE_VERSION_TRANSITIONS, "DRAFT", "PUBLISHED")).toBe(true);
    expect(canTransition(TEMPLATE_VERSION_TRANSITIONS, "DRAFT", "PENDING_APPROVAL")).toBe(false);
    // Legacy pending versions can still be published or bounced back to draft.
    expect(canTransition(TEMPLATE_VERSION_TRANSITIONS, "PENDING_APPROVAL", "DRAFT")).toBe(true);
    expect(canTransition(TEMPLATE_VERSION_TRANSITIONS, "PENDING_APPROVAL", "PUBLISHED")).toBe(true);
  });

  it("ARCHIVED is terminal", () => {
    expect(TEMPLATE_VERSION_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it("rejects every pair not in the map", () => {
    for (const from of TV_STATES) {
      for (const to of TV_STATES) {
        const legal = TEMPLATE_VERSION_TRANSITIONS[from].includes(to);
        expect(canTransition(TEMPLATE_VERSION_TRANSITIONS, from, to)).toBe(legal);
      }
    }
  });
});
