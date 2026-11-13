import { defineConfig } from "vitest/config";

/** The files that start real processes (the server, fake agents, the CLI's entry point), and so are slow. */
const INTEGRATION = [
  "test/server/orchestrator.test.ts",
  "test/server/recovery.test.ts",
  "test/server/startup.test.ts",
  "test/server/runs.test.ts",
  "test/server/consistency.test.ts",
  "src/cli/cli.test.ts",
  "src/cli/main.test.ts",
  "src/cli/commands/init/runInit.test.ts",
  "src/cli/commands/logs.test.ts",
  "src/cli/commands/project.test.ts",
  "src/cli/commands/ps.test.ts",
  "src/cli/commands/reap.test.ts",
  "src/cli/commands/release.test.ts",
  "src/cli/commands/steer.test.ts",
  "src/cli/commands/stop.test.ts",
  "src/mcp/server.test.ts",
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
          include: ["test/**/*.test.ts", "src/**/*.test.ts", "meta/**/*.test.ts"],
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
