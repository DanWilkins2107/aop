import { describe, expect, it } from "vitest";
import type { EdgeRow } from "../../src/shared/api/types.js";
import { ancestorsOf, withDescendants } from "../../web/src/lib/ancestry.js";

type Edge = Pick<EdgeRow, "source_id" | "target_id" | "kind">;
const subtask = (source_id: string, target_id: string): Edge => ({ source_id, target_id, kind: "subtask" });
const blocks = (source_id: string, target_id: string): Edge => ({ source_id, target_id, kind: "blocks" });
const nodes = ["root", "mid", "leaf", "other"].map((id) => ({ id }));
const [root, , leaf] = nodes as [{ id: string }, { id: string }, { id: string }];
const ids = (chain: { id: string }[]) => chain.map((n) => n.id);

describe("ancestors", () => {
  it("lists subtask parents oldest first", () => {
    const edges = [subtask("mid", "leaf"), subtask("root", "mid")];
    expect(ids(ancestorsOf(leaf, nodes, edges))).toEqual(["root", "mid"]);
    expect(ancestorsOf(root, nodes, edges)).toEqual([]);
  });

  it("ignores blocking edges", () => {
    expect(ancestorsOf(leaf, nodes, [blocks("mid", "leaf")])).toEqual([]);
  });

  it("follows only the first subtask parent", () => {
    const edges = [subtask("mid", "leaf"), subtask("other", "leaf"), subtask("root", "mid")];
    expect(ids(ancestorsOf(leaf, nodes, edges))).toEqual(["root", "mid"]);
  });

  it("stops at a parent it doesn't know", () => {
    expect(ids(ancestorsOf(leaf, nodes, [subtask("mid", "leaf"), subtask("gone", "mid")]))).toEqual(["mid"]);
  });

  it("stops at a cycle", () => {
    const edges = [subtask("mid", "leaf"), subtask("root", "mid"), subtask("leaf", "root")];
    expect(ids(ancestorsOf(leaf, nodes, edges))).toEqual(["root", "mid"]);
  });
});

describe("descendants", () => {
  const sorted = (set: Set<string>) => [...set].sort();

  it("takes in every subtask child, however deep", () => {
    const edges = [subtask("root", "mid"), subtask("mid", "leaf"), subtask("other", "x")];
    expect(sorted(withDescendants(["root"], edges))).toEqual(["leaf", "mid", "root"]);
    expect(sorted(withDescendants(["mid"], edges))).toEqual(["leaf", "mid"]);
  });

  it("ignores blocking edges", () => {
    expect(sorted(withDescendants(["root"], [blocks("root", "mid")]))).toEqual(["root"]);
  });

  it("takes a child with several parents if any of them is in", () => {
    const edges = [subtask("root", "leaf"), subtask("other", "leaf")];
    expect(sorted(withDescendants(["other"], edges))).toEqual(["leaf", "other"]);
  });

  it("stops at a cycle", () => {
    const edges = [subtask("root", "mid"), subtask("mid", "root")];
    expect(sorted(withDescendants(["root"], edges))).toEqual(["mid", "root"]);
  });

  it("is empty with no roots", () => {
    expect(withDescendants([], [subtask("root", "mid")]).size).toBe(0);
  });
});
