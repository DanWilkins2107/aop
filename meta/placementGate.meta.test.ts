import { expect, it } from "vitest";
import { type Layout, placementProblems } from "./placementGate.js";
import { repoFiles } from "./repo.js";

// One entry per folder whose layout is settled. What each subfolder is for is in the
// `aop-conventions` skill.
const LAYOUT: Layout = {
  // `server.ts` alone at the root, a file per tool (or a folder, once it needs a second file), and
  // what two or more files of mcp use.
  "src/mcp": /^(server(\.test)?\.ts|tools\/(\w+\/)?\w+(\.test)?\.ts|shared\/\w+(\.test|\.helpers)?\.ts)$/,
};

it("every file sits where its folder's layout allows", () => {
  const files = repoFiles(...Object.keys(LAYOUT));
  expect(files.length).toBeGreaterThan(0);
  expect(placementProblems(files, LAYOUT)).toEqual([]);
});
