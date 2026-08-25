import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalDrafts,
  omitFields,
  readLocalDraft,
  removeLocalDraft,
  writeLocalDraft,
} from "@/lib/form-drafts";

/**
 * The local tier of form-draft persistence. This is the half that decides
 * whether a half-typed form comes back after the app is closed — and, just as
 * importantly, whether it comes back for the *wrong user* on a shared machine.
 *
 * The server tier isn't covered here: those functions only wrap apiFetch and
 * swallow errors, so there is no logic to pin down that mocking fetch wouldn't
 * simply restate.
 */

/** localStorage doesn't exist in the node test environment. */
function installFakeStorage(impl?: Partial<Storage>) {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    ...impl,
  };
  vi.stubGlobal("localStorage", store);
  return map;
}

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local draft storage", () => {
  it("round-trips a draft", () => {
    writeLocalDraft("user-1", "vendor-form:new", {
      values: { name: "Acme" },
      extra: ["Groceries"],
      savedAt: 1000,
    });
    expect(readLocalDraft("user-1", "vendor-form:new")).toEqual({
      values: { name: "Acme" },
      extra: ["Groceries"],
      savedAt: 1000,
    });
  });

  it("keeps two users' drafts of the same form apart", () => {
    writeLocalDraft("user-1", "vendor-form:new", { values: { name: "Acme" }, savedAt: 1 });
    writeLocalDraft("user-2", "vendor-form:new", { values: { name: "Globex" }, savedAt: 2 });

    expect(readLocalDraft<{ name: string }, unknown>("user-1", "vendor-form:new")?.values.name).toBe("Acme");
    expect(readLocalDraft<{ name: string }, unknown>("user-2", "vendor-form:new")?.values.name).toBe("Globex");
  });

  it("keeps a create draft apart from an edit draft of the same form", () => {
    writeLocalDraft("user-1", "vendor-form:new", { values: { name: "New" }, savedAt: 1 });
    writeLocalDraft("user-1", "vendor-form:v9", { values: { name: "Edited" }, savedAt: 2 });

    expect(readLocalDraft<{ name: string }, unknown>("user-1", "vendor-form:new")?.values.name).toBe("New");
    expect(readLocalDraft<{ name: string }, unknown>("user-1", "vendor-form:v9")?.values.name).toBe("Edited");
  });

  it("returns null for a missing draft", () => {
    expect(readLocalDraft("user-1", "nope")).toBeNull();
  });

  it("treats a corrupt entry as no draft rather than handing it to form.reset()", () => {
    localStorage.setItem("uniliv_draft:user-1:vendor-form:new", "{not json");
    expect(readLocalDraft("user-1", "vendor-form:new")).toBeNull();

    // Structurally valid JSON, but not an envelope — no savedAt to compare
    // against the server copy, so it can't be trusted either.
    localStorage.setItem("uniliv_draft:user-1:other", JSON.stringify({ values: { a: 1 } }));
    expect(readLocalDraft("user-1", "other")).toBeNull();
  });

  it("removes a single draft without touching the others", () => {
    writeLocalDraft("user-1", "a", { values: { x: 1 }, savedAt: 1 });
    writeLocalDraft("user-1", "b", { values: { x: 2 }, savedAt: 1 });

    removeLocalDraft("user-1", "a");
    expect(readLocalDraft("user-1", "a")).toBeNull();
    expect(readLocalDraft("user-1", "b")).not.toBeNull();
  });

  it("clears every user's drafts on logout but leaves unrelated keys alone", () => {
    writeLocalDraft("user-1", "a", { values: { x: 1 }, savedAt: 1 });
    writeLocalDraft("user-2", "b", { values: { x: 2 }, savedAt: 1 });
    localStorage.setItem("uniliv_remember", "1");

    clearLocalDrafts();

    expect(readLocalDraft("user-1", "a")).toBeNull();
    expect(readLocalDraft("user-2", "b")).toBeNull();
    expect(localStorage.getItem("uniliv_remember")).toBe("1");
  });

  it("stays silent when storage is unavailable — autosave must never break the form", () => {
    installFakeStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      getItem: () => {
        throw new Error("SecurityError");
      },
    });

    expect(() => writeLocalDraft("user-1", "a", { values: { x: 1 }, savedAt: 1 })).not.toThrow();
    expect(readLocalDraft("user-1", "a")).toBeNull();
  });
});

describe("omitFields", () => {
  it("passes values through untouched when nothing is omitted", () => {
    const v = { a: 1, b: 2 };
    expect(omitFields(v, undefined)).toEqual(v);
    expect(omitFields(v, [])).toEqual(v);
  });

  it("drops only the named fields", () => {
    expect(omitFields({ name: "A", password: "hunter2", pan: "X" }, ["password"])).toEqual({
      name: "A",
      pan: "X",
    });
  });

  it("keeps omitted fields out of storage entirely", () => {
    writeLocalDraft("user-1", "form", {
      values: omitFields({ name: "A", secret: "s" }, ["secret"]),
      savedAt: 1,
    });
    const raw = localStorage.getItem("uniliv_draft:user-1:form")!;
    expect(raw).not.toContain("secret");
  });
});
