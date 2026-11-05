import { Graph, layout } from "@dagrejs/dagre";
import type { EventView, NodeView, TypeView } from "../../../src/shared/api.js";
import { humanize } from "./format.js";
import type { Point } from "./layout.js";
import { GLOBAL_STAGES } from "./stageStyle.js";

/** `exit` is somewhere a type leads out to: a finish, or another type. */
export type BoxKind = "stage" | "exit" | "current" | "return";

export interface StageBox {
  name: string;
  label: string;
  kind: BoxKind;
  /** Centre of the box. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageLink {
  id: string;
  label: string;
  points: Point[];
  labelAt: Point | null;
}

export interface StageDrawing {
  boxes: StageBox[];
  links: StageLink[];
  width: number;
  height: number;
}

const BOX_HEIGHT = 30;
const BOX_CHAR_WIDTH = 7.2;
const BOX_PADDING = 22;
const LABEL_CHAR_WIDTH = 6;
const LABEL_PADDING = 6;
const LABEL_HEIGHT = 14;
const MARGIN = 6;

const linkId = (stage: string, outcome: string) => `${stage}:${outcome}`;

/**
 * The outcomes that go back to a stage on the way to them, walking from the type's start. Laying
 * these out as forward edges and then flipping them keeps the start on top and the route in order.
 */
function loopsBack(type: TypeView): Set<string> {
  const nextOf = new Map(type.stages.map((s) => [s.name, s.next]));
  const loops = new Set<string>();
  const seen = new Set<string>();
  const onPath = new Set<string>();
  const walk = (stage: string) => {
    seen.add(stage);
    onPath.add(stage);
    for (const { outcome, target } of nextOf.get(stage) ?? []) {
      if (onPath.has(target) && target !== stage) loops.add(linkId(stage, outcome));
      else if (!seen.has(target)) walk(target);
    }
    onPath.delete(stage);
  };
  walk(type.start);
  for (const { name } of type.stages) if (!seen.has(name)) walk(name);
  return loops;
}

/**
 * Lays out a type's stages with every outcome as an edge, so that forks and loops show as they are.
 * `current` is null when no node is being shown, as on the process page.
 */
export function stageDrawing(type: TypeView, current: string | null, returnTo: string | null): StageDrawing {
  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 22, edgesep: 12, ranksep: 26, marginx: MARGIN, marginy: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));

  const own = new Set(type.stages.map((s) => s.name));
  const kindOf = (name: string): BoxKind => {
    if (name === current) return "current";
    if (name === returnTo) return "return";
    return own.has(name) ? "stage" : "exit";
  };
  const addBox = (name: string) => {
    if (graph.hasNode(name)) return;
    const label = humanize(name);
    graph.setNode(name, { label, width: label.length * BOX_CHAR_WIDTH + BOX_PADDING, height: BOX_HEIGHT });
  };

  addBox(type.start);
  for (const stage of type.stages) addBox(stage.name);
  const loops = loopsBack(type);
  const links: { id: string; from: string; to: string; label: string; flipped: boolean }[] = [];
  for (const stage of type.stages) {
    for (const { outcome, target } of stage.next) {
      addBox(target);
      const id = linkId(stage.name, outcome);
      const label = humanize(outcome);
      const flipped = loops.has(id);
      const [from, to] = flipped ? [target, stage.name] : [stage.name, target];
      links.push({ id, from, to, label, flipped });
      graph.setEdge(from, to, { width: label.length * LABEL_CHAR_WIDTH + LABEL_PADDING, height: LABEL_HEIGHT, labelpos: "c" }, id);
    }
  }
  // A global stage lives outside the pipeline. Anything else off the type, like `splitting`, sits beside it.
  if (current !== null && !GLOBAL_STAGES.includes(current)) addBox(current);

  layout(graph);

  const boxes: StageBox[] = graph.nodes().map((name: string) => {
    const { x, y, width, height, label } = graph.node(name);
    return { name, label: label ?? name, kind: kindOf(name), x, y, width, height };
  });
  const drawn: StageLink[] = links.map(({ id, from, to, label, flipped }) => {
    const edge = graph.edge({ v: from, w: to, name: id });
    const points: Point[] = edge.points ?? [];
    return {
      id,
      label,
      points: flipped ? [...points].reverse() : points,
      labelAt: typeof edge.x === "number" && typeof edge.y === "number" ? { x: edge.x, y: edge.y } : null,
    };
  });
  const { width = 0, height = 0 } = graph.graph();
  return { boxes, links: drawn, width, height };
}

function record(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/**
 * The stage a node on a global stage came from. Invalidating doesn't store a `return_stage`, so
 * that one comes from the event that entered it. `events` is oldest first.
 */
export function originalStage(node: NodeView, events: EventView[]): string | null {
  if (node.return_stage) return node.return_stage;
  for (const event of [...events].reverse()) {
    const data = record(event.data);
    if (event.kind === "stage_changed" && data["to_stage"] === node.stage && typeof data["from_stage"] === "string") {
      return data["from_stage"];
    }
  }
  return null;
}
