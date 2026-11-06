import { defineConfig } from "vitest/config";

/** The files that start real processes (the server, fake agents, the CLI's entry point), and so are slow. */
const INTEGRATION = [
  "test/server/orchestrator.test.ts",
  "test/server/recovery.test.ts",
  "test/server/startup.test.ts",
  "test/server/cli.smoke.test.ts",
  "test/cli/init.test.ts",
];

export default defineConfig({
  test: {
    // Points AOP_HOME at a temp dir before any test code runs.
    setupFiles: ["test/server/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: INTEGRATION,
          // Generous for in-process tests, because the dev machine is Windows and often busy.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: INTEGRATION,
          // Process lookups and kills on Windows are PowerShell calls, a second or more each.
          testTimeout: 90_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
