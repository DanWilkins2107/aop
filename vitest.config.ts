import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Points AOP_HOME at a temp dir before any test code runs.
    setupFiles: ["test/server/setup.ts"],
  },
});
