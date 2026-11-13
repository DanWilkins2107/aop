import { expect, it } from "vitest";
import { exportShapeProblems } from "./exportShapeGate.js";
import { repoSources } from "./repo.js";

// The folders whose files keep to one export each.
const FOLDERS = ["src/shared"];

it("every file keeps to one export, and types to the folder's types.ts", () => {
  const sources = repoSources(...FOLDERS);
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(exportShapeProblems(sources, FOLDERS)).toEqual([]);
});
