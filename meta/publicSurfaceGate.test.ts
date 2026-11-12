import { describe, expect, it } from "vitest";
import { publicSurfaceProblems } from "./publicSurfaceGate.js";

const SURFACES = { "src/area": ["src/area/entry.ts"] };

describe("publicSurfaceProblems", () => {
  it("accepts imports of a public file from outside, and of any file from inside", () => {
    expect(
      publicSurfaceProblems(
        {
          "src/other/thing.ts": 'import { a } from "../area/entry.js";',
          "test/other/thing.test.ts": 'const later = await import("../../src/area/entry.js");',
          "src/area/entry.ts": 'import { b } from "./deep/inner.js";',
          "src/area/deep/inner.ts": 'import { z } from "zod";',
        },
        SURFACES,
      ),
    ).toEqual([]);
  });

  it("rejects imports of any other file from outside, by code or by tests", () => {
    expect(
      publicSurfaceProblems(
        {
          "src/other/thing.ts": 'import { b } from "../area/deep/inner.js";',
          "test/other/thing.test.ts": 'import { fake } from "../../src/area/fake.helpers.js";',
        },
        SURFACES,
      ),
    ).toEqual([
      "src/other/thing.ts: imports ../area/deep/inner.js, which isn't one of src/area's public files (src/area/entry.ts)",
      "test/other/thing.test.ts: imports ../../src/area/fake.helpers.js, which isn't one of src/area's public files (src/area/entry.ts)",
    ]);
  });

  it("leaves folders without a surface alone, including ones that only share a prefix", () => {
    expect(publicSurfaceProblems({ "src/other/thing.ts": 'import { c } from "../area2/inner.js";' }, SURFACES)).toEqual([]);
  });
});
