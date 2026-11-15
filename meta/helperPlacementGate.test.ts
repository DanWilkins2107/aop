import { describe, expect, it } from "vitest";
import { helperPlacementProblems } from "./helperPlacementGate.js";

const FOLDERS = ["src/cli", "src/mcp"];

describe("helperPlacementProblems", () => {
  it("accepts a helper one folder's tests use, one in test-shared, or one outside the folders", () => {
    expect(
      helperPlacementProblems(
        {
          "src/mcp/tools/a.test.ts": 'import { h } from "./h.helpers.js";\nimport { m } from "../test-shared/m.helpers.js";',
          "src/mcp/tools/b.test.ts": 'import { h } from "./h.helpers.js";',
          "src/mcp/server.test.ts": 'import { m } from "./test-shared/m.helpers.js";',
          "src/mcp/server.ts": 'import { h } from "./tools/h.helpers.js";',
          "src/cli/a.test.ts": 'import { w } from "../../test/w.helpers.js";',
          "src/cli/commands/b.test.ts": 'import { w } from "../../../test/w.helpers.js";',
        },
        FOLDERS,
      ),
    ).toEqual([]);
  });

  it("rejects a helper outside test-shared that tests in two folders use", () => {
    expect(
      helperPlacementProblems(
        {
          "src/mcp/tools/a.test.ts": 'import { h } from "../shared/h.helpers.js";',
          "src/mcp/shared/b.test.ts": 'import { h } from "./h.helpers.js";',
        },
        FOLDERS,
      ),
    ).toEqual(["src/mcp/shared/h.helpers.ts: tests in src/mcp/shared, src/mcp/tools use it: move it to a test-shared folder"]);
  });
});
