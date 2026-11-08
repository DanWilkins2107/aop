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

/**
 * `roots` and everything under them through `subtask` edges, however deep. A node with several
 * parents is in if any of them is.
 */
export function withDescendants(roots: Iterable<string>, edges: ParentEdge[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "subtask") continue;
    children.set(edge.source_id, [...(children.get(edge.source_id) ?? []), edge.target_id]);
  }
  const found = new Set<string>();
  const queue = [...roots];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (found.has(id)) continue;
    found.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return found;
}
