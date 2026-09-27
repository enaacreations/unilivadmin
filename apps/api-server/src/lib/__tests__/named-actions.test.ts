/**
 * The named-action manifest is the new source of truth for what may be granted.
 *
 * While both vocabularies are live it is also a TRANSLATION table: 330 stored
 * matrix rows, every privilege and 532 gates still speak the old global verbs,
 * and `legacy` is what maps them across. A pair that loses its named home stops
 * being grantable, so these guard the two ways that can go wrong — a verb with
 * nowhere to land, and a name that collides.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_FUNCTIONALITIES, actionDef, namedActionsFor, readActionOf,
  permissionName, moduleOf,
} from "../permissions.js";

describe("named actions", () => {
  it("gives every functionality at least one action", () => {
    for (const f of ALL_FUNCTIONALITIES) {
      expect(namedActionsFor(f).length, f).toBeGreaterThan(0);
    }
  });

  it("keeps action keys unique within a functionality", () => {
    for (const f of ALL_FUNCTIONALITIES) {
      const keys = namedActionsFor(f).map((d) => d.key);
      expect(new Set(keys).size, f).toBe(keys.length);
    }
  });

  /**
   * The READ action is identified by POSITION — first in the list.
   *
   * `readActionOf`, the VIEW level, the read-implication and the system
   * read-only role all resolve through that one rule, so if a functionality
   * ever declares a write first, all four quietly start meaning something else.
   */
  it("declares its read action first, and only one of them", () => {
    for (const f of ALL_FUNCTIONALITIES) {
      const defs = namedActionsFor(f);
      expect(readActionOf(f), f).toBe(defs[0]?.key);
      const reads = defs.filter((d) => /^(view|see|read)_/.test(d.key));
      expect(reads.length, `${f} declares ${reads.length} read-shaped actions`).toBe(1);
      expect(reads[0]!.key, f).toBe(defs[0]!.key);
    }
  });

  it("resolves a def by its key and names the permission from it", () => {
    const f = "PROPERTIES" as const;
    expect(actionDef(f, "add_property")?.label).toBe("Add property");
    expect(permissionName(f, "add_property")).toBe("operations.properties.add_property");
    expect(moduleOf(f)).toBe("OPERATIONS");
  });

  it("refuses an action the functionality does not declare", () => {
    // The manifest ceiling. A verb from the old vocabulary is no longer a
    // permission anywhere, and must not resolve to one.
    expect(actionDef("PROPERTIES", "create")).toBeUndefined();
    expect(actionDef("PROPERTIES", "add_resident")).toBeUndefined();
  });

  it("gives every action a description that says something", () => {
    for (const f of ALL_FUNCTIONALITIES) {
      for (const d of namedActionsFor(f)) {
        expect(d.description.length, `${f}.${d.key}`).toBeGreaterThan(10);
        expect(d.label.length, `${f}.${d.key}`).toBeGreaterThan(2);
      }
    }
  });
});
