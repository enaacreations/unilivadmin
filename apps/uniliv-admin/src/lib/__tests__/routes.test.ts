/**
 * Every route must be classified, or PageGuard's fail-closed default locks a
 * real page.
 *
 * PageGuard now refuses anything PATH_TO_MODULE does not map. That is the right
 * default — the old fail-open meant a route added without a mapping was
 * silently ungated — but it is only safe if the two lists cannot drift. This
 * reads App.tsx and asserts every <Route> is either mapped or explicitly
 * public, so adding one without answering "which module gates this?" fails the
 * build rather than the user.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleForPath, isPublicPath } from "../permissions";

const APP = readFileSync(join(import.meta.dirname, "..", "..", "App.tsx"), "utf8");
const routes = [...APP.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]!);

/** A wouter pattern with a concrete value, so the regexes can be tested. */
const concrete = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, "x");

describe("route classification", () => {
  it("finds the routes at all (guards the reader itself)", () => {
    // Without a floor, a regex that stopped matching would make everything
    // below pass vacuously.
    expect(routes.length).toBeGreaterThan(50);
  });

  it("maps or publicly exempts every route", () => {
    const unclassified = routes
      .filter((r) => !moduleForPath(concrete(r)) && !isPublicPath(concrete(r)))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it("refuses an unmapped path rather than rendering it", () => {
    // The behaviour PageGuard depends on. If moduleForPath ever returns a
    // module for an unknown path, the fail-closed branch stops being reachable.
    expect(moduleForPath("/definitely-not-a-real-page")).toBeNull();
    expect(isPublicPath("/definitely-not-a-real-page")).toBe(false);
  });

  it("keeps the refusal page itself reachable", () => {
    // A 403 page that 403s is an infinite loop, and the loop renders as a
    // blank screen rather than an error.
    expect(isPublicPath("/403")).toBe(true);
  });
});
