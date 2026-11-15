import { expect, it } from "vitest";
import { type SharedUse, sharedUseProblems } from "./sharedUseGate.js";
import { repoSources } from "./repo.js";

const SHARED: SharedUse[] = [
  // `src/shared` holds only what two or more of the other sides use.
  { shared: "src/shared", users: ["src/server", "src/cli", "src/mcp", "web/src"] },
  // A side's own `shared/` holds only what two or more of its files use.
  { shared: "src/cli/shared", users: ["src/cli"], byFile: true },
  { shared: "src/mcp/shared", users: ["src/mcp"], byFile: true },
];

it.each(SHARED)("everything in $shared is used by two or more users", (use) => {
  const sources = repoSources(use.shared, ...use.users);
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(sharedUseProblems(sources, use)).toEqual([]);
});
