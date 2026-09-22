/**
 * Every mounted route must be gated and classified.
 *
 * Not a snapshot — a snapshot goes stale exactly when the drift it exists to
 * catch happens. This imports every router module and walks its REAL express
 * stack, asserting:
 *
 *  1. every route carries an authz gate (or is listed as public, with a reason);
 *  2. every route appears in ROUTE_SCOPE, classified scoped or exempt.
 *
 * (2) is the part that does not rot: a new route is unclassified, so it fails
 * until someone answers "does this need property scoping?" — the decision that
 * kept getting skipped, which is how 29 of 37 route files ended up unscoped.
 *
 * Routes are keyed `<file> METHOD /relative/path` rather than by absolute URL.
 * Express 5 replaced each layer's `regexp` with opaque `matchers`, so a mount
 * prefix can no longer be recovered from the stack; the file name is stable,
 * unique, and points a reader straight at the handler.
 */
import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

const { authzTagOf } = await import("../middlewares/authorize.js");
const { ROUTE_SCOPE, PUBLIC_ROUTES } = await import("../lib/route-scope-registry.js");

const ROUTES_DIR = join(import.meta.dirname, "..", "routes");

interface Found { key: string; gated: boolean }

function isRouter(v: unknown): boolean {
  const s = (v as { stack?: unknown })?.stack;
  return Array.isArray(s) && typeof v === "function";
}

function walk(r: unknown, file: string, out: Found[]): void {
  // A router-level `.use(authenticate, authorize(...))` — executive.ts does
  // this — gates every route registered after it, and shows up as a NON-route
  // layer in the same stack. Missing that would report nine gated routes as
  // wide open, so track it as we go rather than looking only inside routes.
  let routerGated = false;
  for (const raw of ((r as { stack: unknown[] }).stack ?? [])) {
    const layer = raw as {
      route?: { path?: string; methods?: Record<string, boolean>; stack?: unknown[] };
      handle?: unknown;
    };
    if (!layer.route) {
      if (authzTagOf(layer.handle)) routerGated = true;
      continue;
    }
    const gated =
      routerGated ||
      (layer.route.stack ?? []).some((h) => authzTagOf((h as { handle?: unknown }).handle));
    for (const m of Object.keys(layer.route.methods ?? {})) {
      out.push({ key: `${file} ${m.toUpperCase()} ${layer.route.path || "/"}`, gated });
    }
  }
}

const found: Found[] = [];
const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts");
for (const f of files) {
  const mod = (await import(join(ROUTES_DIR, f))) as Record<string, unknown>;
  const seen = new Set<unknown>();
  for (const v of Object.values(mod)) {
    if (!isRouter(v) || seen.has(v)) continue;
    seen.add(v);
    walk(v, f.replace(/\.ts$/, ""), found);
  }
}
// De-dupe: a router exported both as default and named appears twice.
const routes = [...new Map(found.map((r) => [r.key, r])).values()];

describe("route coverage", () => {
  it("finds the routes at all (guards the walker itself)", () => {
    // Without a floor, a walker that silently stopped matching express's
    // internals would make every assertion below pass vacuously.
    expect(routes.length).toBeGreaterThan(200);
  });

  it("gates every route, or lists it as deliberately public", () => {
    const ungated = routes.filter((r) => !r.gated).map((r) => r.key)
      .filter((k) => !PUBLIC_ROUTES[k]).sort();
    expect(ungated).toEqual([]);
  });

  it("classifies every route as scoped or exempt", () => {
    const unclassified = routes.map((r) => r.key)
      .filter((k) => !ROUTE_SCOPE[k] && !PUBLIC_ROUTES[k]).sort();
    expect(unclassified).toEqual([]);
  });
});
