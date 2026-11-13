import { describe, expect, it } from "vitest";
import { exportShapeProblems } from "./exportShapeGate.js";

const FOLDERS = ["src/area"];

describe("exportShapeProblems", () => {
  it("accepts one value per file, named as the file, and types in types.ts", () => {
    expect(
      exportShapeProblems(
        {
          "src/area/stages/isBuiltIn.ts": "export function isBuiltIn() {}",
          "src/area/stages/finished_stages.ts": "export const FINISHED_STAGES = [];",
          "src/area/stages/types.ts": "export type Stage = string;\nexport interface View {}",
          "src/area/stages/isBuiltIn.test.ts": "export const anything = 1;\nexport type T = 1;",
          "src/other/many.ts": "export const a = 1;\nexport const b = 2;",
        },
        FOLDERS,
      ),
    ).toEqual([]);
  });

  it("rejects more than one value, a misnamed file, types outside types.ts, values in it, and export lists", () => {
    expect(
      exportShapeProblems(
        {
          "src/area/a/two.ts": "export const one = 1;\nexport function two() {}",
          "src/area/a/wrong.ts": "export const right = 1;",
          "src/area/a/typed.ts": "export const typed = 1;\nexport type Extra = 1;",
          "src/area/a/types.ts": "export const value = 1;",
          "src/area/a/again.ts": 'export { again } from "./x.js";',
        },
        FOLDERS,
      ),
    ).toEqual([
      "src/area/a/two.ts: exports 2 values (one, two): one per file",
      "src/area/a/wrong.ts: exports right: name the file after its export",
      "src/area/a/typed.ts: exports the type Extra: types go in the folder's types.ts",
      "src/area/a/types.ts: exports value, which isn't a type: give it a file of its own",
      "src/area/a/again.ts: `export { again } from \"./x.js\";` isn't a declaration: export each thing where it's declared",
      "src/area/a/again.ts: exports 0 values (): one per file",
    ]);
  });
});
