/**
 * Every approval-shaped endpoint must declare separation of duties.
 *
 * Same philosophy as route-coverage: enforce the convention with a test that
 * reads the live router, not with a comment someone has to remember. A new
 * `/approve` route without `enforceSod(...)` fails the build, so the §33 rule
 * cannot quietly apply to three endpoints and no more.
 *
 * Keyed on the PATH rather than the action name because `Permission` is still
 * view/create/edit/delete — the 13-action vocabulary exists but no route gates
 * on `approve` yet. When it does, this should switch to the authz tag.
 */
import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

const { sodTagOf } = await import("../lib/access/sod.js");

const ROUTES_DIR = join(import.meta.dirname, "..", "routes");

/** Paths that decide an outcome someone else produced. */
const APPROVAL_SHAPED = /\/(approve|reject|verify|reopen|confirm-delivery|sign-off|countersign)$/;

/**
 * Approval-shaped paths that legitimately need no SoD check, each with a reason.
 * Keep this list short and argued — it is the escape hatch, and an unexplained
 * entry here is how the rule erodes.
 */
const SOD_EXEMPT: Record<string, string> = {
  // The resident signs their OWN agreement — self-action is the whole point,
  // and the signer is not an approver of someone else's work.
  "kyc-esign POST /sign/:token": "the resident signing their own document",
  // OTP confirmation during password/username recovery. Matched only because
  // the path ends in /verify; there is no record and no second party.
  "auth POST /forgot-password/verify": "OTP step, not an approval of anyone's work",
  "auth POST /forgot-username/verify": "OTP step, not an approval of anyone's work",
};

interface Found { key: string; hasSod: boolean }

const found: Found[] = [];
for (const f of readdirSync(ROUTES_DIR).filter((x) => x.endsWith(".ts") && x !== "index.ts")) {
  const mod = (await import(join(ROUTES_DIR, f))) as Record<string, unknown>;
  const seen = new Set<unknown>();
  for (const v of Object.values(mod)) {
    const st = (v as { stack?: unknown[] })?.stack;
    if (!Array.isArray(st) || typeof v !== "function" || seen.has(v)) continue;
    seen.add(v);
    for (const raw of st) {
      const layer = raw as { route?: { path?: string; methods?: Record<string, boolean>; stack?: unknown[] } };
      if (!layer.route?.path) continue;
      if (!APPROVAL_SHAPED.test(layer.route.path)) continue;
      const hasSod = (layer.route.stack ?? []).some((h) => sodTagOf((h as { handle?: unknown }).handle));
      for (const m of Object.keys(layer.route.methods ?? {})) {
        // Deciding someone else's work is always a write. A GET whose path ends
        // in /verify is reading a verification, not performing one — e.g.
        // GET /activity/verify checks chain integrity. Filtering by method
        // removes that whole class rather than growing the exemption list.
        if (m.toLowerCase() === "get") continue;
        found.push({ key: `${f.replace(/\.ts$/, "")} ${m.toUpperCase()} ${layer.route.path}`, hasSod });
      }
    }
  }
}
const routes = [...new Map(found.map((r) => [r.key, r])).values()];

describe("separation-of-duties coverage", () => {
  it("finds the approval endpoints at all (guards the sweep itself)", () => {
    expect(routes.length).toBeGreaterThan(3);
  });

  it("declares enforceSod on every approval-shaped route", () => {
    const missing = routes
      .filter((r) => !r.hasSod)
      .map((r) => r.key)
      .filter((k) => !SOD_EXEMPT[k])
      .sort();
    expect(missing).toEqual([]);
  });
});
