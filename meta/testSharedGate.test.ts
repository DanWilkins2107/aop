import { describe, expect, it } from "vitest";
import { testSharedProblems } from "./testSharedGate.js";

describe("testSharedProblems", () => {
  it("lets tests and their helpers import test-shared", () => {
    expect(
      testSharedProblems({
        "src/cli/cli.test.ts": 'import { world } from "../../test-shared/world.js";',
        "src/mcp/shared/h.helpers.ts": 'import { world } from "../../../test-shared/world.js";',
        "test-shared/harness.ts": 'import { world } from "./world.js";',
      }),
    ).toEqual([]);
  });

  it("rejects code that isn't a test importing it", () => {
    expect(testSharedProblems({ "src/cli/cli.ts": 'import { world } from "../../test-shared/world.js";' })).toEqual([
      "src/cli/cli.ts: imports ../../test-shared/world.js, and only tests may use test-shared",
    ]);
  });
});
