import { describe, expect, it } from "vitest";
import { importBoundaryProblems } from "./importBoundaryGate.js";

const BROWSER = { "src/area": { folders: [], packages: ["zod"], browser: true } };
const lines = (...code: string[]) => code.join("\n");

describe("importBoundaryProblems", () => {
  it("accepts imports inside the folder and of its packages", () => {
    expect(
      importBoundaryProblems(
        {
          "src/area/one/thing.ts": lines('import { a } from "../two/other.js";', 'import type { z } from "zod";', 'export * from "./near.js";'),
          "src/area/two/other.ts": 'const later = await import("zod/v4");',
        },
        BROWSER,
      ),
    ).toEqual([]);
  });

  it("rejects imports that leave the folder, other packages and Node's modules", () => {
    expect(
      importBoundaryProblems(
        {
          "src/area/one/thing.ts": lines(
            'import { a } from "../../server/db.js";',
            'import y from "yaml";',
            'import s from "@scope/name/deep";',
            'import fs from "node:fs";',
            'import "../../area2/x.js";',
          ),
        },
        BROWSER,
      ),
    ).toEqual([
      "src/area/one/thing.ts: imports ../../server/db.js, which is outside src/area",
      "src/area/one/thing.ts: imports yaml, a package src/area may not use",
      "src/area/one/thing.ts: imports @scope/name/deep, a package src/area may not use",
      "src/area/one/thing.ts: imports node:fs, which needs Node, and the browser loads src/area",
      "src/area/one/thing.ts: imports ../../area2/x.js, which is outside src/area",
    ]);
  });

  it("rejects Node's globals in a folder the browser loads, but not the word in prose", () => {
    expect(
      importBoundaryProblems(
        {
          "src/area/one/env.ts": 'export const home = process.env["HOME"];',
          "src/area/one/prose.ts": lines("// The process page, and a process. Nothing more.", 'export const process = "/process";'),
        },
        BROWSER,
      ),
    ).toEqual(["src/area/one/env.ts: uses process, which needs Node, and the browser loads src/area"]);
  });

  it("lets a folder import the others it names, any package when none are listed, and Node outside the browser", () => {
    expect(
      importBoundaryProblems(
        {
          "src/tools/run.ts": lines('import { a } from "../area/one/thing.js";', 'import y from "yaml";', 'import fs from "node:fs";', "const here = process.cwd();"),
          "src/tools/bad.ts": 'import { b } from "../server/db.js";',
        },
        { "src/tools": { folders: ["src/area"] } },
      ),
    ).toEqual(["src/tools/bad.ts: imports ../server/db.js, which is outside src/tools"]);
  });

  it("leaves tests and folders without a boundary alone", () => {
    expect(
      importBoundaryProblems(
        {
          "src/area/one/thing.test.ts": lines('import { it } from "vitest";', 'import fs from "node:fs";'),
          "src/other/thing.ts": 'import fs from "node:fs";',
        },
        BROWSER,
      ),
    ).toEqual([]);
  });
});
