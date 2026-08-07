/**
 * Duplicate master-data codes answer 409, never 500.
 *
 * INVARIANT: a unique violation the database rejected is caller input, so it is
 * reported as a 409 naming the collision. Falling through to a generic 500 tells
 * an operator who typed an existing Kitchen ID that the server is broken.
 *
 * The bug this pins was a DETECTOR bug, not a missing guard. `POST /brands` did
 * have duplicate handling — `err.message.toLowerCase().includes("unique")` — but
 * it could never fire: drizzle replaces the driver's message with
 * "Failed query: <sql> params: …", and the pg detail (`code`, `constraint`)
 * survives only on `err.cause`. So the test looked for a word that had already
 * been thrown away, and every duplicate brand code returned 500. `POST /kitchens`
 * had no handling at all. Both are now on `isUniqueViolation`, which reads the
 * cause chain — the same helper the meal-window and cut-off handlers use.
 *
 * The error shape below is copied from a real failure observed against the
 * running server, message text and all, so a future change to how drizzle wraps
 * driver errors fails HERE rather than silently reintroducing the 500.
 */
import { describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/call-route.js";

vi.hoisted(() => {
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
});

/**
 * A drizzle-wrapped Postgres unique_violation, shaped exactly as one arrives at
 * a handler: the message is rewritten and carries no usable detail, and 23505 +
 * the constraint name live on `cause`.
 */
class DrizzleQueryError extends Error {
  override cause: { code: string; constraint: string; detail: string };
  constructor(table: string, constraint: string) {
    super(`Failed query: insert into "${table}" ("id", "code", "name") values ($1, $2, $3) returning "id"\nparams: x,DUP,Dup`);
    this.name = "DrizzleQueryError";
    this.cause = {
      code: "23505",
      constraint,
      detail: `Key (code)=(DUP) already exists.`,
    };
  }
}

/** The word the broken detector looked for is genuinely absent from the message. */
const brandDuplicate = () => new DrizzleQueryError("food_brands", "food_brands_code_unique");
const kitchenDuplicate = () => new DrizzleQueryError("kitchens", "kitchens_code_unique");

/** What should be thrown when the failure is NOT a duplicate — still a 500. */
const unrelatedFailure = () => Object.assign(new Error("connection terminated unexpectedly"), {
  cause: { code: "57P01" },
});

const thrower = { next: null as null | (() => Error) };

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  const { thrower: t } = await import("./food-config-duplicates.test.js");
  return {
    ...actual,
    db: {
      ...fakeDb,
      insert: () => ({
        values: () => ({
          returning: async () => {
            if (t.next) throw t.next();
            return [{ id: "new-1" }];
          },
        }),
      }),
    },
  };
});

// RBAC is asserted by permissions-sync.test.ts; this file is about the error
// mapping, so the chain is opened and the caller is set on the request.
vi.mock("../../middlewares/auth.js", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

export { thrower };

const { foodOpsRouter } = await import("../../routes/food-ops.js");

const USER = { id: "u-1", email: "u1@uniliv.com", role: "SUPER_ADMIN", propertyId: null };

async function post(url: string, body: unknown) {
  return callRoute(foodOpsRouter, { method: "POST", url, body, user: USER });
}

describe("duplicate master-data code → 409, not 500", () => {
  it("POST /brands reports a duplicate brand code as 409", async () => {
    thrower.next = brandDuplicate;
    const res = await post("/brands", { code: "UNILIV", name: "Dup Brand" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Brand code already exists" });
  });

  it("POST /kitchens reports a duplicate kitchen code as 409", async () => {
    thrower.next = kitchenDuplicate;
    const res = await post("/kitchens", { code: "KIT-BLR-KMG", name: "Dup Kitchen" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Kitchen code already exists" });
  });

  it("the rewritten drizzle message really does hide the violation", () => {
    // The regression guard: if this ever stops being true, a message-sniffing
    // detector would start working again and someone may "simplify" back to one.
    // While it IS true, only the cause chain can classify the error.
    const err = brandDuplicate();
    expect(err.message.toLowerCase()).not.toContain("unique");
    expect(err.message.toLowerCase()).not.toContain("duplicate");
    expect(err.cause.code).toBe("23505");
  });

  it("a non-duplicate failure is still a 500 and is logged", async () => {
    // The 409 must not swallow genuine faults — only 23505 maps to it.
    thrower.next = unrelatedFailure;
    const res = await post("/brands", { code: "NEWCODE", name: "New Brand" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error" });
  });

  it("both handlers still validate before touching the database", async () => {
    thrower.next = brandDuplicate;
    expect((await post("/brands", { name: "No Code" })).status).toBe(400);
    expect((await post("/kitchens", { name: "No Code" })).status).toBe(400);
  });
});
