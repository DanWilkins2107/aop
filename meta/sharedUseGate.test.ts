import { describe, expect, it } from "vitest";
import { sharedUseProblems } from "./sharedUseGate.js";

const USE = { shared: "src/shared", users: ["src/server", "src/web"] };

describe("sharedUseProblems", () => {
  it("accepts an export two sides import, or one side imports and shared code builds on", () => {
    expect(
      sharedUseProblems(
        {
          "src/shared/a/types.ts": "export type Both = 1;\nexport type Base = 1;\nexport type Built = Base | 2;",
          "src/server/x.ts": 'import type { Both, Built } from "../shared/a/types.js";',
          "src/web/y.ts": 'import { type Both, type Built as B } from "../shared/a/types.js";',
          "src/server/z.ts": 'import type { Base } from "../shared/a/types.js";',
        },
        USE,
      ),
    ).toEqual([]);
  });

  it("rejects an export one side or none imports, ignoring tests, and imports that don't name what they take", () => {
    expect(
      sharedUseProblems(
        {
          "src/shared/a/types.ts": "export type One = 1;\nexport type None = 1;",
          "src/server/x.ts": 'import type { One } from "../shared/a/types.js";\nimport * as all from "../shared/a/types.js";',
          "src/web/x.test.ts": 'import type { One, None } from "../shared/a/types.js";',
        },
        USE,
      ),
    ).toEqual([
      "src/server/x.ts: imports ../shared/a/types.js without naming what it takes: import from src/shared by name",
      "src/shared/a/types.ts: only src/server imports One: move it there",
      "src/shared/a/types.ts: nothing outside src/shared imports None: stop exporting it",
    ]);
  });

  it("counts each file as a user with byFile, but not the shared folder's own files", () => {
    expect(
      sharedUseProblems(
        {
          "src/mcp/shared/a.ts": "export const two = 1;",
          "src/mcp/shared/b.ts": 'import { two } from "./a.js";\nexport const one = two;',
          "src/mcp/tools/x.ts": 'import { two } from "../shared/a.js";\nimport { one } from "../shared/b.js";',
          "src/mcp/tools/y.ts": 'import { two } from "../shared/a.js";',
          "src/mcp/tools/y.test.ts": 'import { one } from "../shared/b.js";',        },
        { shared: "src/mcp/shared", users: ["src/mcp"], byFile: true },
      ),
    ).toEqual(["src/mcp/shared/b.ts: only src/mcp/tools/x.ts imports one: move it there"]);
  });
});
