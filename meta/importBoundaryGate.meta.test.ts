import { expect, it } from "vitest";
import { type Boundaries, importBoundaryProblems } from "./importBoundaryGate.js";
import { repoSources } from "./repo.js";

// One entry per folder whose boundary is settled. A file takes the first entry it's under, so a
// subfolder comes before its parent.
const BOUNDARIES: Boundaries = {
  // `init` writes the config the server reads, and `serve` runs the server, so only they reach it.
  "src/cli/commands/init": { folders: ["src/cli/shared", "src/shared", "src/server"] },
  "src/cli/commands/serve": { folders: ["src/cli/shared", "src/shared", "src/server"] },
  // Every other command is an HTTP call to the server, through `shared/api.ts`.
  "src/cli/commands": { folders: ["src/cli/shared", "src/shared"] },
  "src/cli/shared": { folders: ["src/shared"] },
  // What's left is `main.ts` and `cli.ts`.
  "src/cli": { folders: ["src/shared"] },
  // A tool reaches the board only through `ToolApi`, never the server's own code.
  "src/mcp/tools": { folders: ["src/mcp/shared", "src/shared"] },
  "src/mcp/shared": { folders: ["src/shared"] },
  // What's left is `server.ts`, the one file that builds the API app the tools call.
  "src/mcp": { folders: ["src/shared", "src/server"] },
  // Every side imports it and the browser loads it, so it imports nothing, not even a package.
  "src/shared": { folders: [], packages: [], browser: true },
};

it("no import leaves its folder's boundary", () => {
  const sources = repoSources(...Object.keys(BOUNDARIES));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(importBoundaryProblems(sources, BOUNDARIES)).toEqual([]);
});
