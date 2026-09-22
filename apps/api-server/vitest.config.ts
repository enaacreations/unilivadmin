import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // Unit tests cover pure logic only (state machines, hashing, scoring) and
    // never touch the database — but importing @workspace/db constructs the
    // pool config at module load, so give it a connection string. The pool
    // only connects when queried, which these tests never do.
    //
    // config/env.ts is fail-closed the same way: it THROWS at module load
    // without a strong SESSION_SECRET. Anything that now reads a config
    // constant (the ACCESS_RESOLVER cutover flag in food-service and
    // audit-access) drags it in transitively, so supply one here rather than
    // making every test file hoist its own.
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgresql://vitest@localhost:5432/vitest",
      SESSION_SECRET:
        process.env["SESSION_SECRET"] ??
        "vitest-only-session-secret-vitest-only-session-secret",
    },
  },
});
