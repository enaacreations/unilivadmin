import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests cover pure frontend logic only (API-client display helpers, query
// serialisation, export-URL builders) and never render components or hit the
// network, so the default node environment is enough — no jsdom required. The
// `@` alias mirrors vite.config.ts so `@/lib/...` imports resolve.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
  },
});
