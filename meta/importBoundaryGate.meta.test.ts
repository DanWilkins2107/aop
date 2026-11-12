import { expect, it } from "vitest";
import { type Boundaries, importBoundaryProblems } from "./importBoundaryGate.js";
import { repoSources } from "./repo.js";

// One entry per folder whose boundary is settled. A file takes the first entry it's under, so a
// subfolder comes before its parent.
const BOUNDARIES: Boundaries = {
  // A tool reaches the board only through `ToolApi`, never the server's own code.
  "src/mcp/tools": { folders: ["src/mcp/shared", "src/shared"] },
  "src/mcp/shared": { folders: ["src/shared"] },
  // What's left is `server.ts`, the one file that builds the API app the tools call.
  "src/mcp": { folders: ["src/shared", "src/server"] },
};

it("no import leaves its folder's boundary", () => {
  const sources = repoSources(...Object.keys(BOUNDARIES));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(importBoundaryProblems(sources, BOUNDARIES)).toEqual([]);
});
