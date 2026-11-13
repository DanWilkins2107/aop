import { expect, it } from "vitest";
import { type Layout, placementProblems } from "./placementGate.js";
import { repoFiles } from "./repo.js";

// One entry per folder whose layout is settled. What each subfolder is for is in the
// `aop-conventions` skill.
const LAYOUT: Layout = {
  // A folder per concept, nested if a concept needs its own shared part. Nothing at the root.
  "src/shared": /^(\w+\/)+\w+(\.test)?\.ts$/,
  // `server.ts` alone at the root, a file per tool (or a folder, once it needs a second file), and
  // what two or more files of mcp use.
  // `main.ts` (the bin) and `cli.ts` (which finds and runs a command) alone at the root, a file per
  // command (or a folder, once it needs a second file) with `registry.ts` listing them, and what two
  // or more files of cli use.
  "src/cli": /^((main|cli)(\.test)?\.ts|commands\/(\w+\/)?\w+(\.test)?\.ts|shared\/\w+(\.test|\.helpers)?\.ts)$/,
  "src/mcp": /^(server(\.test)?\.ts|tools\/(\w+\/)?\w+(\.test)?\.ts|shared\/\w+(\.test|\.helpers)?\.ts)$/,
};

it("every file sits where its folder's layout allows", () => {
  const files = repoFiles(...Object.keys(LAYOUT));
  expect(files.length).toBeGreaterThan(0);
  expect(placementProblems(files, LAYOUT)).toEqual([]);
});
