import { Graph, layout } from "@dagrejs/dagre";
import type { EdgeRow } from "../../../src/shared/api.js";

export const CARD_WIDTH = 236;
export const CARD_HEIGHT = 66;

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
}

/** Nodes joined by any edge. Groups and their members keep the order given, by each group's first member. */
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
  return [...groups.values()];
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
  for (const id of nodeIds) {
    const { x, y } = graph.node(id);
    positions.set(id, { x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 });
    width = Math.max(width, x + CARD_WIDTH / 2);
  }
  for (const edge of edges) {
    const points: Point[] = graph.edge({ v: edge.source_id, w: edge.target_id, name: edge.id }).points ?? [];
    routes.set(edge.id, points);
  }
  return { positions, routes, width };
}

/**
 * Lays cards out top to bottom over both kinds of edge, so only an edge ever adds depth. Each
 * unconnected group is laid out alone, then they all sit side by side along the top in the order
 * given. Nothing but `nodeIds` and `edges` goes in, so nothing else can move a card.
 */
export function layoutGraph(nodeIds: string[], edges: LayoutEdge[]): GraphLayout {
  const known = new Set(nodeIds);
  const usable = edges.filter((edge) => known.has(edge.source_id) && known.has(edge.target_id));

  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();
  let x = 0;
  for (const ids of connectedGroups(nodeIds, usable)) {
    const members = new Set(ids);
    const group = layoutGroup(ids, usable.filter((edge) => members.has(edge.source_id)));
    for (const [id, at] of group.positions) positions.set(id, { x: at.x + x, y: at.y });
    for (const [id, points] of group.routes) routes.set(id, points.map((p) => ({ x: p.x + x, y: p.y })));
    x += group.width + GROUP_GAP;
  }
  return { positions, routes };
}

/**
 * What the graph shows. Positions always come from every node, oldest first, so that hiding a node
 * leaves a gap instead of moving the others, and a new unconnected node lands at the right end.
 */
export function graphView<N extends { id: string; created_at: string }, E extends LayoutEdge>(
  allNodes: N[],
  allEdges: E[],
  hidden: (node: N) => boolean,
): GraphLayout & { nodes: N[]; edges: E[] } {
  const oldestFirst = [...allNodes].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const { positions, routes } = layoutGraph(oldestFirst.map((node) => node.id), allEdges);
  const nodes = oldestFirst.filter((node) => !hidden(node));
  const shown = new Set(nodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => shown.has(edge.source_id) && shown.has(edge.target_id));
  return { nodes, edges, positions, routes };
}

export interface FitOptions {
  /** Kept clear on the left and right, and on the top and bottom. */
  padding: Point;
  minZoom: number;
  maxZoom: number;
}

/**
 * The view that shows every card, centred, down to `minZoom`. Past that the graph is too big to
 * read at once, so the view starts at its top left and leaves the rest to panning.
 */
export function fittedViewport(
  positions: Iterable<Point>,
  canvas: { width: number; height: number },
  { padding, minZoom, maxZoom }: FitOptions,
): { x: number; y: number; zoom: number } {
  const points = [...positions];
  if (points.length === 0) return { x: 0, y: 0, zoom: maxZoom };
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const width = Math.max(...points.map((p) => p.x)) + CARD_WIDTH - left;
  const height = Math.max(...points.map((p) => p.y)) + CARD_HEIGHT - top;
  const fit = Math.min((canvas.width - 2 * padding.x) / width, (canvas.height - 2 * padding.y) / height);
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit));
  const offset = (space: number, size: number, pad: number, start: number) => {
    const free = space - size * zoom;
    return (fit >= minZoom && free >= 2 * pad ? free / 2 : pad) - start * zoom;
  };
  return { x: offset(canvas.width, width, padding.x, left), y: offset(canvas.height, height, padding.y, top), zoom };
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
