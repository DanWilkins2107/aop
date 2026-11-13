import { expect, it } from "vitest";
import { type SharedUse, sharedUseProblems } from "./sharedUseGate.js";
import { repoSources } from "./repo.js";

// `src/shared` holds only what two or more of the other sides use.
const SHARED: SharedUse = { shared: "src/shared", users: ["src/server", "src/cli", "src/mcp", "web/src"] };

it("everything shared is used by two or more sides", () => {
  const sources = repoSources(SHARED.shared, ...SHARED.users);
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(sharedUseProblems(sources, SHARED)).toEqual([]);
});
