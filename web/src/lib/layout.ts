import { Graph, layout } from "@dagrejs/dagre";
import type { EdgeRow } from "../../../src/shared/api.js";

export const CARD_WIDTH = 236;
export const CARD_HEIGHT = 84;

/** Roughly a desktop canvas, so that unconnected work fills the view instead of one long row. */
const TARGET_ASPECT = 1.9;
const GROUP_GAP = 56;

type LayoutEdge = Pick<EdgeRow, "id" | "source_id" | "target_id" | "kind">;

export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  /** Top-left corner of each card. */
  positions: Map<string, Point>;
  /** Each edge's route, from source to target. */
  routes: Map<string, Point[]>;
}

interface Group extends GraphLayout {
  width: number;
  height: number;
}

/** Nodes joined by any edge, biggest group first and otherwise in the order given. */
function connectedGroups(nodeIds: string[], edges: LayoutEdge[]): string[][] {
  const parent = new Map(nodeIds.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) parent.set(find(edge.source_id), find(edge.target_id));

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

function layoutGroup(nodeIds: string[], edges: LayoutEdge[]): Group {
  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 44, ranksep: 72, acyclicer: "greedy" });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const id of nodeIds) graph.setNode(id, { width: CARD_WIDTH, height: CARD_HEIGHT });
  for (const edge of edges) {
    // Parent and child should sit closer than a blocker and what it holds.
    graph.setEdge(edge.source_id, edge.target_id, { weight: edge.kind === "subtask" ? 3 : 1 }, edge.id);
  }
  layout(graph);

  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();
  let width = 0;
  let height = 0;
  for (const id of nodeIds) {
    const { x, y } = graph.node(id);
    positions.set(id, { x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 });
    width = Math.max(width, x + CARD_WIDTH / 2);
    height = Math.max(height, y + CARD_HEIGHT / 2);
  }
  for (const edge of edges) {
    const points: Point[] = graph.edge({ v: edge.source_id, w: edge.target_id, name: edge.id }).points ?? [];
    routes.set(edge.id, points);
  }
  return { positions, routes, width, height };
}

/**
 * Lays cards out top to bottom over both kinds of edge. Dagre would line every unconnected group
 * up along the top, so each is laid out alone and then packed into rows.
 */
export function layoutGraph(nodeIds: string[], edges: LayoutEdge[]): GraphLayout {
  const known = new Set(nodeIds);
  const usable = edges.filter((edge) => known.has(edge.source_id) && known.has(edge.target_id));
  const groups = connectedGroups(nodeIds, usable).map((ids) => {
    const members = new Set(ids);
    return layoutGroup(ids, usable.filter((edge) => members.has(edge.source_id)));
  });

  const area = groups.reduce((sum, g) => sum + (g.width + GROUP_GAP) * (g.height + GROUP_GAP), 0);
  const widest = groups.reduce((most, g) => Math.max(most, g.width), 0);
  const rowWidth = Math.max(widest, Math.sqrt(area * TARGET_ASPECT));

  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const group of groups) {
    if (x > 0 && x + group.width > rowWidth) {
      x = 0;
      y += rowHeight + GROUP_GAP;
      rowHeight = 0;
    }
    for (const [id, at] of group.positions) positions.set(id, { x: at.x + x, y: at.y + y });
    for (const [id, points] of group.routes) routes.set(id, points.map((p) => ({ x: p.x + x, y: p.y + y })));
    x += group.width + GROUP_GAP;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return { positions, routes };
}

/** An SVG path through a route, rounding each corner. */
export function smoothPath(points: Point[]): string {
  const [first, ...rest] = points;
  const last = rest[rest.length - 1];
  if (!first || !last) return "";
  const midpoint = (a: Point, b: Point) => `${(a.x + b.x) / 2} ${(a.y + b.y) / 2}`;
  let path = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i] as Point;
    const after = points[i + 1] as Point;
    path += ` Q ${corner.x} ${corner.y} ${midpoint(corner, after)}`;
  }
  return `${path} L ${last.x} ${last.y}`;
}
