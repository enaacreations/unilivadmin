import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // Unit tests cover pure logic only (state machines, hashing, scoring) and
    // never touch the database — but importing @workspace/db constructs the
    // pool config at module load, so give it a connection string. The pool
    // only connects when queried, which these tests never do.
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgresql://vitest@localhost:5432/vitest",
    },
  },
});
