import { expect, it } from "vitest";
import { repoSources } from "./repo.js";
import { testSharedProblems } from "./testSharedGate.js";

it("only tests import test-shared", () => {
  const sources = Object.fromEntries(Object.entries(repoSources("src", "test", "web/src", "meta")).filter(([file]) => /\.(ts|tsx|mjs)$/.test(file)));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(testSharedProblems(sources)).toEqual([]);
});
