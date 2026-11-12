import { expect, it } from "vitest";
import { publicSurfaceProblems, type Surfaces } from "./publicSurfaceGate.js";
import { repoSources } from "./repo.js";

// One entry per folder whose public files are settled.
const SURFACES: Surfaces = {
  // The server starts the MCP server, and the prompts' tests read the tools' names.
  "src/mcp": ["src/mcp/server.ts", "src/mcp/tools/registry.ts"],
};

it("nothing imports past a folder's public files", () => {
  const sources = Object.fromEntries(Object.entries(repoSources("src", "test", "web/src", "meta")).filter(([file]) => /\.(ts|tsx|mjs)$/.test(file)));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(publicSurfaceProblems(sources, SURFACES)).toEqual([]);
});
