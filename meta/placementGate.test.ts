import { describe, expect, it } from "vitest";
import { placementProblems } from "./placementGate.js";

const LAYOUT = { "src/area": /^(one|two)\/\w+(\.test)?\.ts$/ };
const NOT_ALLOWED = `not where src/area's layout allows (${LAYOUT["src/area"].source})`;

describe("placementProblems", () => {
  it("accepts files in the allowed subfolders, and tests beside what they test", () => {
    expect(placementProblems(["src/area/one/thing.ts", "src/area/one/thing.test.ts", "src/area/two/other.ts"], LAYOUT)).toEqual([]);
  });

  it("rejects a file at the folder's root, in another subfolder or nested deeper", () => {
    expect(placementProblems(["src/area/stray.ts", "src/area/three/thing.ts", "src/area/one/deep/thing.ts"], LAYOUT)).toEqual([
      `src/area/stray.ts: ${NOT_ALLOWED}`,
      `src/area/three/thing.ts: ${NOT_ALLOWED}`,
      `src/area/one/deep/thing.ts: ${NOT_ALLOWED}`,
    ]);
  });

  it("rejects a test with no file beside it to test", () => {
    expect(placementProblems(["src/area/one/thing.test.ts", "src/area/two/thing.ts"], LAYOUT)).toEqual([
      "src/area/one/thing.test.ts: tests no file beside it",
    ]);
  });

  it("leaves folders without a layout alone, including ones that only share a prefix", () => {
    expect(placementProblems(["src/other/stray.ts", "src/area2/stray.ts", "README.md"], LAYOUT)).toEqual([]);
  });
});
