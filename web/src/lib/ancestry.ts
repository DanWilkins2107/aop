import type { EdgeRow } from "../../../src/shared/api.js";

type ParentEdge = Pick<EdgeRow, "source_id" | "target_id" | "kind">;

/** Oldest first, following each node's first `subtask` parent. Stops at a missing parent or a cycle. */
export function ancestorsOf<N extends { id: string }>(node: N, nodes: N[], edges: ParentEdge[]): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: N[] = [];
  const seen = new Set([node.id]);
  let current = node.id;
  for (;;) {
    const parentEdge = edges.find((e) => e.kind === "subtask" && e.target_id === current);
    const parent = parentEdge ? byId.get(parentEdge.source_id) : undefined;
    if (!parent || seen.has(parent.id)) return chain;
    seen.add(parent.id);
    chain.unshift(parent);
    current = parent.id;
  }
}
