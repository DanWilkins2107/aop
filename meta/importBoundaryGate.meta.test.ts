import { expect, it } from "vitest";
import { type Boundaries, importBoundaryProblems } from "./importBoundaryGate.js";
import { repoSources } from "./repo.js";

// One entry per folder whose boundary is settled.
const BOUNDARIES: Boundaries = {
  // The browser imports it, so it stands alone. zod is for the request schemas, which the browser
  // imports only as types.
  "src/shared": { folders: [], packages: ["zod"], browser: true },
};

it("no import leaves its folder's boundary", () => {
  const sources = repoSources(...Object.keys(BOUNDARIES));
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(importBoundaryProblems(sources, BOUNDARIES)).toEqual([]);
});
