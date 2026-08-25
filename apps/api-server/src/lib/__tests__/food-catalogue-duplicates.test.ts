/**
 * A dish or ingredient that already exists is REFUSED, not quietly cloned.
 *
 * INVARIANT: the catalogue is keyed on the name people read, so "Aloo Gobi",
 * "aloo gobi" and "Aloo Gobi " are one dish. A dish additionally carries its
 * COURSE in that identity — "Rice" the rice and "Rice" the dessert are two
 * dishes — which is exactly the identity the bulk importer already enforces
 * (routes/bulk.ts), so the sheet and the drawer cannot disagree about what a
 * duplicate is.
 *
 * Why it matters more than tidiness: the shared-ingredient block compares
 * dishes by ingredient ID. A second "Aloo" row means two aloo dishes no longer
 * share an ingredient, and the check that exists to keep them off the same
 * plate silently stops firing. A duplicate dish splits per-resident portions,
 * consumption and waste reporting across two rows that read identically in
 * every picker.
 *
 * Two layers, both pinned here:
 *   1. The handler PRE-CHECK, which owns the message — it names the row already
 *      on file and whether it is retired. Most of this file is about that.
 *   2. `uq_dish_name_component` / `uq_ingredient_name` (schema/food.ts), which
 *      catch the concurrent create the pre-check structurally cannot see. The
 *      last describe() pins the mapping from that violation onto the same 409;
 *      without it the race is a 500.
 *
 * These assertions run the REAL queries against seeded rows (fake-db evaluates
 * the drizzle condition tree), so the case-insensitive match is genuinely
 * exercised rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, dishesTable, dishIngredientsTable, ingredientsTable } from "@workspace/db";
import { resetDb, seedDb } from "./helpers/fake-db.js";
import { callRoute } from "./helpers/call-route.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

/**
 * Arms the next INSERT to fail, so the concurrent-create race can be staged.
 * Nothing else in the file sets it, and beforeEach disarms it.
 *
 * Via vi.hoisted, NOT the self-import trick the sibling duplicate test uses:
 * that import resolves to a half-initialised module here and `thrower` arrives
 * undefined, which surfaces as every insert 500ing rather than as a clear error.
 */
const { thrower } = vi.hoisted(() => ({ thrower: { next: null as null | (() => Error) } }));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return {
    ...actual,
    db: {
      ...fakeDb,
      // Fires ONCE, then disarms: the handlers insert their audit-log row after
      // the row under test, and that write must not inherit the failure.
      insert: (table: Parameters<typeof fakeDb.insert>[0]) => {
        if (!thrower.next) return fakeDb.insert(table);
        const err = thrower.next();
        thrower.next = null;
        return { values: () => ({ returning: async () => { throw err; } }) };
      },
    },
  };
});

/**
 * A drizzle-wrapped Postgres unique_violation, shaped as one actually arrives:
 * drizzle rewrites `message` into "Failed query: …", so 23505 and the constraint
 * name survive only on `cause`. Copied from the shape pinned by
 * food-config-duplicates.test.ts — see its header for why that matters.
 */
const uniqueViolation = (constraint: string) =>
  Object.assign(new Error(`Failed query: insert into "x" ...`), {
    cause: { code: "23505", constraint, detail: "Key already exists." },
  });

// RBAC is asserted by permissions-sync.test.ts; this file is about the guard,
// so the chain is opened and the caller is set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { foodRouter } from "../../routes/food.js";

const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

const dish = (o: Partial<Record<string, unknown>> & { id: string; name: string; component: string }) => ({
  unit: "SERVING", brands: ["UNILIV"], preparations: ["VEG"], photoUrl: null,
  isQtyLocked: false, lockedPersons: null, isActive: true, ...o,
});
const ingredient = (o: { id: string; name: string; isActive?: boolean }) => ({
  unit: "KG", isActive: true, ...o,
});

/** Seeded so every case starts from the same small, readable catalogue. */
function seedCatalogue() {
  seedDb([
    [dishesTable, [
      dish({ id: "d-aloo", name: "Aloo Gobi", component: "SABZI" }),
      dish({ id: "d-rice", name: "Rice", component: "RICE" }),
      dish({ id: "d-kheer", name: "Kheer", component: "DESSERT", isActive: false }),
    ]],
    [ingredientsTable, [
      ingredient({ id: "i-aloo", name: "Aloo" }),
      ingredient({ id: "i-jeera", name: "Jeera", isActive: false }),
    ]],
    [dishIngredientsTable, []],
  ]);
}

beforeEach(() => { resetDb(); seedCatalogue(); thrower.next = null; });

const post = (url: string, body: unknown) => callRoute(foodRouter, { method: "POST", url, body, user: USER });
const put = (url: string, body: unknown) => callRoute(foodRouter, { method: "PUT", url, body, user: USER });

const countDishes = async () => (await db.select().from(dishesTable)).length;
const countIngredients = async () => (await db.select().from(ingredientsTable)).length;

describe("POST /dishes refuses a duplicate", () => {
  it("refuses the same name in the same course", async () => {
    const res = await post("/dishes", { name: "Aloo Gobi", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Aloo Gobi");
    expect(await countDishes()).toBe(3);
  });

  it("matches regardless of case and surrounding whitespace", async () => {
    // The half a `WHERE name = $1` would miss — and the half people actually
    // type, because the drawer does not trim as they go.
    for (const name of ["aloo gobi", "  Aloo Gobi  ", "ALOO GOBI"]) {
      const res = await post("/dishes", { name, component: "SABZI", unit: "SERVING" });
      expect(res.status, name).toBe(409);
    }
    expect(await countDishes()).toBe(3);
  });

  it("names the course in the refusal, so a re-course reads as the way out", async () => {
    const res = await post("/dishes", { name: "Aloo Gobi", component: "SABZI", unit: "SERVING" });
    expect(res.body.error).toContain("Sabzi");
  });

  it("allows the same name in a DIFFERENT course", async () => {
    // Course is half the identity: Rice-the-rice and Rice-the-dessert are two
    // dishes, and refusing the second would make the catalogue unusable.
    const res = await post("/dishes", { name: "Rice", component: "DESSERT", unit: "SERVING" });
    expect(res.status).toBe(201);
    expect(await countDishes()).toBe(4);
  });

  it("refuses a RETIRED twin, and says to reactivate it", async () => {
    // Deleting a dish only clears isActive, so the row — and every report that
    // joins it by name — is still there. A second copy would be permanent.
    const res = await post("/dishes", { name: "Kheer", component: "DESSERT", unit: "SERVING" });
    expect(res.status).toBe(409);
    expect(String(res.body.details)).toMatch(/reactivate/i);
    expect(await countDishes()).toBe(3);
  });

  it("still creates a genuinely new dish", async () => {
    const res = await post("/dishes", { name: "Bhindi Masala", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Bhindi Masala");
  });
});

describe("PUT /dishes/:id refuses a duplicate", () => {
  it("lets a dish re-save under its own name", async () => {
    // The self-exclusion. Without it every edit of an existing dish — a unit
    // change, a brand tick — would 409 against the dish being edited.
    const res = await put("/dishes/d-aloo", { name: "Aloo Gobi", component: "SABZI", unit: "KG" });
    expect(res.status).toBe(200);
    expect(res.body.data.unit).toBe("KG");
  });

  it("refuses a rename onto another dish", async () => {
    const res = await put("/dishes/d-rice", { name: "aloo gobi", component: "SABZI" });
    expect(res.status).toBe(409);
    // The refusal has to land BEFORE the write, or the rename commits anyway.
    const [row] = await db.select().from(dishesTable).where(eq(dishesTable.id, "d-rice"));
    expect(row!["name"]).toBe("Rice");
  });

  it("refuses a COURSE change that collides, with the name left alone", async () => {
    // Only half the identity is in the body; the other half comes from the row
    // on file. Reading just the body would let this through.
    seedDb([[dishesTable, [
      dish({ id: "d-aloo", name: "Aloo Gobi", component: "SABZI" }),
      dish({ id: "d-aloo-2", name: "Aloo Gobi", component: "HOT_FOOD" }),
    ]]]);
    const res = await put("/dishes/d-aloo-2", { component: "SABZI" });
    expect(res.status).toBe(409);
  });

  it("leaves an edit that touches neither name nor course alone", async () => {
    const res = await put("/dishes/d-aloo", { isQtyLocked: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isQtyLocked).toBe(true);
  });
});

describe("ingredients are one row per raw material", () => {
  it("POST refuses a case-variant duplicate", async () => {
    const res = await post("/ingredients", { name: "aloo", unit: "KG" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Aloo");
    expect(await countIngredients()).toBe(2);
  });

  it("POST refuses a retired twin, and says to reactivate it", async () => {
    const res = await post("/ingredients", { name: "Jeera", unit: "G" });
    expect(res.status).toBe(409);
    expect(String(res.body.details)).toMatch(/reactivate/i);
  });

  it("POST still creates a new ingredient", async () => {
    const res = await post("/ingredients", { name: "Tomato", unit: "KG" });
    expect(res.status).toBe(201);
    expect(await countIngredients()).toBe(3);
  });

  it("PUT lets an ingredient re-save under its own name", async () => {
    const res = await put("/ingredients/i-aloo", { name: "Aloo", unit: "G" });
    expect(res.status).toBe(200);
    expect(res.body.data.unit).toBe("G");
  });

  it("PUT refuses a rename onto another ingredient", async () => {
    const res = await put("/ingredients/i-jeera", { name: "ALOO" });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(ingredientsTable).where(eq(ingredientsTable.id, "i-jeera"));
    expect(row!["name"]).toBe("Jeera");
  });
});

describe("the unique index catches what the pre-check cannot", () => {
  // Two people create "Bhindi Masala" at once: both pre-checks SELECT, both come
  // back empty, and the second INSERT loses to uq_dish_name_component. The row
  // is genuinely a duplicate, so the answer must be the duplicate 409 — a 500
  // here tells the loser the server is broken.
  it("reports a racing dish insert as 409, not 500", async () => {
    thrower.next = () => uniqueViolation("uq_dish_name_component");
    const res = await post("/dishes", { name: "Bhindi Masala", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("reports a racing ingredient insert as 409, not 500", async () => {
    thrower.next = () => uniqueViolation("uq_ingredient_name");
    const res = await post("/ingredients", { name: "Tomato", unit: "KG" });
    expect(res.status).toBe(409);
  });

  it("leaves an UNRELATED unique violation as a 500", async () => {
    // Why the mapping is narrowed by constraint name. A collision on some other
    // index is not a duplicate name, and calling it one would send the user off
    // renaming a dish whose name was never the problem.
    thrower.next = () => uniqueViolation("uq_something_else");
    const res = await post("/dishes", { name: "Bhindi Masala", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(500);
  });

  it("leaves a non-duplicate failure as a 500", async () => {
    thrower.next = () => Object.assign(new Error("connection terminated"), { cause: { code: "57P01" } });
    const res = await post("/dishes", { name: "Bhindi Masala", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(500);
  });

  it("does not reach the index when the pre-check already refused", async () => {
    // Ordering guard: the pre-check must run BEFORE the insert, or every
    // duplicate would return the vaguer race message instead of the one that
    // names the existing row.
    thrower.next = () => uniqueViolation("uq_dish_name_component");
    const res = await post("/dishes", { name: "Aloo Gobi", component: "SABZI", unit: "SERVING" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Aloo Gobi");
    // Still armed — the handler never got as far as the insert.
    expect(thrower.next).not.toBeNull();
  });
});

describe("a dish cannot hold the same ingredient twice", () => {
  it("collapses repeats to one row, keeping the first quantity", async () => {
    // The drawer picks ingredients with a toggle so it cannot send one twice,
    // but the bulk importer and any direct caller can — and a dish holding
    // "Aloo" twice double-counts it in every consumption report.
    const res = await post("/dishes", {
      name: "Aloo Paratha", component: "BREAD", unit: "PCS",
      ingredients: [
        { ingredientId: "i-aloo", quantity: 2, unit: "KG" },
        { ingredientId: "i-aloo", quantity: 9, unit: "KG" },
      ],
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(dishIngredientsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["quantity"]).toBe("2");
  });
});
