import { expect, it } from "vitest";
import { helperPlacementProblems } from "./helperPlacementGate.js";
import { repoSources } from "./repo.js";

// The folders whose test helpers are settled.
const FOLDERS = ["src/cli", "src/mcp"];

it("a helper that tests in two or more folders use is in a test-shared folder", () => {
  const sources = Object.fromEntries(Object.entries(repoSources("src", "test", "web/src", "meta")).filter(([file]) => /\.(ts|tsx|mjs)$/.test(file)));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(helperPlacementProblems(sources, FOLDERS)).toEqual([]);
});
