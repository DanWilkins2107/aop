import { describe, expect, it } from "vitest";
import { diffLines, diffStats, splitLines, withContext } from "../../web/src/lib/diff.js";

const marks = (before: string | null, after: string) =>
  diffLines(before, after).map((line) => `${{ same: " ", add: "+", remove: "-" }[line.kind]}${line.text}`);

describe("diffLines", () => {
  it("marks kept, added and removed lines in order", () => {
    expect(marks("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(marks("1\n2\n3\n4\n", "1\n3\n2\n4\n").filter((l) => l[0] !== " ")).toHaveLength(2);
  });

  it("shows a new file as all added", () => {
    expect(marks(null, "one\ntwo\n")).toEqual(["+one", "+two"]);
    expect(diffStats(diffLines(null, "one\ntwo\n"))).toEqual({ added: 2, removed: 0 });
  });

  it("finds no changes in identical text, whatever the line endings", () => {
    expect(diffStats(diffLines("x\r\ny\r\n", "x\ny\n"))).toEqual({ added: 0, removed: 0 });
  });

  it("numbers lines on each side", () => {
    const lines = diffLines("a\nb\n", "b\n");
    expect(lines).toEqual([
      { kind: "remove", text: "a", oldLine: 1, newLine: null },
      { kind: "same", text: "b", oldLine: 2, newLine: 1 },
    ]);
  });

  it("treats a missing final newline as the same lines", () => {
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("withContext", () => {
  it("keeps three lines around each change and folds the rest", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "LINE 10");
    const chunks = withContext(diffLines(before, after));
    expect(chunks.map((c) => (c.kind === "skipped" ? c.count : c.lines.length))).toEqual([7, 8, 6]);
    expect(chunks[0]).toEqual({ kind: "skipped", count: 7 });
  });
});
