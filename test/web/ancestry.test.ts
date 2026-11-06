import { describe, expect, it } from "vitest";
import type { EdgeRow } from "../../src/shared/api.js";
import { ancestorsOf } from "../../web/src/lib/ancestry.js";

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
