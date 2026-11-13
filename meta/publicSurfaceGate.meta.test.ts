import { expect, it } from "vitest";
import { publicSurfaceProblems, type Surfaces } from "./publicSurfaceGate.js";
import { repoSources } from "./repo.js";

// One entry per folder whose public files are settled.
const SURFACES: Surfaces = {
  // `main.ts` is the bin, and the prompts' tests read the commands' usage.
  "src/cli": ["src/cli/main.ts", "src/cli/commands/registry.ts"],
  // The server starts the MCP server, and the prompts' tests read the tools' names.
  "src/mcp": ["src/mcp/server.ts", "src/mcp/tools/registry.ts"],
};

it("nothing imports past a folder's public files", () => {
  const sources = Object.fromEntries(Object.entries(repoSources("src", "test", "web/src", "meta")).filter(([file]) => /\.(ts|tsx|mjs)$/.test(file)));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(publicSurfaceProblems(sources, SURFACES)).toEqual([]);
});
