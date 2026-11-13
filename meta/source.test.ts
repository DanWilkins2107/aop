import { describe, expect, it } from "vitest";
import { exportsOf, importedFile, importsOf } from "./source.js";

describe("importsOf", () => {
  it("reads named imports, before any as, and marks other kinds unnamed", () => {
    expect(
      importsOf(
        [
          'import { a, type B, c as d } from "./x.js";',
          'import type { E } from "./y.js";',
          'import all from "./z.js";',
          'export * from "./w.js";',
          'import "./side.js";',
        ].join("\n"),
      ),
    ).toEqual([
      { specifier: "./x.js", names: ["a", "B", "c"] },
      { specifier: "./y.js", names: ["E"] },
      { specifier: "./z.js", names: null },
      { specifier: "./w.js", names: null },
      { specifier: "./side.js", names: null },
    ]);
  });
});

describe("exportsOf", () => {
  it("reads declarations, and lists what it can't", () => {
    expect(exportsOf("export type A = 1;\nexport async function b() {}\nexport default 1;")).toEqual({
      exports: [
        { name: "A", isType: true },
        { name: "b", isType: false },
      ],
      unreadable: ["export default 1;"],
    });
  });
});

describe("importedFile", () => {
  it("resolves a relative import to its .ts file, and a package to null", () => {
    expect(importedFile("src/a/b.ts", "../c/d.js")).toBe("src/c/d.ts");
    expect(importedFile("src/a/b.ts", "zod")).toBeNull();
  });
});
