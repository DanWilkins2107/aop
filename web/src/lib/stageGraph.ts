import { Graph, layout } from "@dagrejs/dagre";
import type { EventView } from "../../../src/shared/events/types.js";
import type { NodeView } from "../../../src/shared/nodes/types.js";
import type { TypeView } from "../../../src/shared/stages/types.js";
import { GLOBAL_STAGES } from "./globalStages.js";
import { humanize } from "./format.js";
import type { Point } from "./layout.js";

/** `exit` is somewhere a type leads out to: a finish, or another type. */
export type BoxKind = "stage" | "exit" | "current" | "return";

type TypeStage = TypeView["stages"][number];

export interface Rect {
  /** Centre of the rectangle. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A `parallel:` group's branches, stacked inside its box, and the gate bar they finish at. */
export interface StageGroup {
  branches: (Rect & { name: string; label: string })[];
  gate: Rect & { label: string };
}

export interface StageBox extends Rect {
  /** Unique in the drawing: a stage inside an opened sub-workflow is `outer/inner`. */
  name: string;
  label: string;
  kind: BoxKind;
  /** Set on a `subflow:` stage that can be opened: the type it runs. */
  subflow?: string;
  group?: StageGroup;
}

/** An opened sub-workflow, drawn round its type's stages. */
export interface StageFrame extends Rect {
  name: string;
  label: string;
}

export interface StageLink {
  id: string;
  label: string;
  points: Point[];
  labelAt: Point | null;
  /** A loop back into a stage with `max_loops`. */
  dashed: boolean;
}

export interface StageDrawing {
  boxes: StageBox[];
  frames: StageFrame[];
  links: StageLink[];
  width: number;
  height: number;
}

export interface DrawingOptions {
  /** Every type, so that `subflow:` stages can be opened. */
  types?: TypeView[];
  /** The `subflow:` stages to draw opened, by box name. */
  expanded?: ReadonlySet<string>;
}

const BOX_HEIGHT = 30;
const BOX_CHAR_WIDTH = 7.2;
const BOX_PADDING = 22;
const LABEL_CHAR_WIDTH = 6;
const LABEL_PADDING = 6;
const LABEL_HEIGHT = 14;
const MARGIN = 6;
const BRANCH_HEIGHT = 24;
const BRANCH_GAP = 4;
const GROUP_PADDING = 6;
const GROUP_TITLE = 22;
const GATE_HEIGHT = 16;
const OPEN_MARK_WIDTH = 14;

const linkId = (stage: string, outcome: string) => `${stage}:${outcome}`;
const boxWidth = (label: string) => label.length * BOX_CHAR_WIDTH + BOX_PADDING;

/** What the gate bar under a parallel group says. */
export function gateLabel(gate: TypeStage["gate"]): string {
  return gate === "all_pass" ? "All pass" : "All done";
}

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

function groupSize(label: string, branches: string[]): { width: number; height: number } {
  const widest = Math.max(boxWidth(label), ...branches.map((b) => boxWidth(humanize(b)) + 2 * GROUP_PADDING));
  const stack = branches.length * BRANCH_HEIGHT + (branches.length - 1) * BRANCH_GAP;
  return { width: widest, height: GROUP_TITLE + stack + GROUP_PADDING + GATE_HEIGHT };
}

function groupParts(box: Rect, branches: string[], gate: TypeStage["gate"]): StageGroup {
  const top = box.y - box.height / 2;
  return {
    branches: branches.map((name, i) => ({
      name,
      label: humanize(name),
      x: box.x,
      y: top + GROUP_TITLE + i * (BRANCH_HEIGHT + BRANCH_GAP) + BRANCH_HEIGHT / 2,
      width: box.width - 2 * GROUP_PADDING,
      height: BRANCH_HEIGHT,
    })),
    gate: { label: gateLabel(gate), x: box.x, y: box.y + box.height / 2 - GATE_HEIGHT / 2, width: box.width, height: GATE_HEIGHT },
  };
}

interface PendingLink {
  id: string;
  from: string;
  to: string;
  label: string;
  flipped: boolean;
  dashed: boolean;
}

/**
 * Lays out a type's stages with every outcome as an edge, so that forks and loops show as they are.
 * `current` is null when no node is being shown, as on the process page. An opened `subflow:` stage
 * is a frame round its type's stages: links go into that type's start and out of its exits.
 */
export function stageDrawing(type: TypeView, current: string | null, returnTo: string | null, options: DrawingOptions = {}): StageDrawing {
  const graph = new Graph({ multigraph: true, compound: true });
  graph.setGraph({ rankdir: "TB", nodesep: 22, edgesep: 12, ranksep: 26, marginx: MARGIN, marginy: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));

  const types = new Map((options.types ?? []).map((t) => [t.name, t]));
  const expanded = options.expanded ?? new Set<string>();
  const kinds = new Map<string, BoxKind>();
  const subflows = new Map<string, string>();
  const groups = new Map<string, TypeStage>();
  const frames = new Map<string, string>();
  const links: PendingLink[] = [];

  const addNode = (id: string, label: string, size: { width: number; height: number }, parent: string | null) => {
    graph.setNode(id, { label, ...size });
    if (parent !== null) graph.setParent(id, parent);
  };
  const addBox = (id: string, label: string, kind: BoxKind, parent: string | null) => {
    if (graph.hasNode(id)) return;
    addNode(id, label, { width: boxWidth(label), height: BOX_HEIGHT }, parent);
    kinds.set(id, kind);
  };

  /**
   * Draws `t` with its box names under `prefix`, inside the frame `parent`, and returns where a link
   * into it lands. `path` holds the types already open, so a cycle can't open forever.
   */
  const drawType = (t: TypeView, prefix: string, parent: string | null, path: string[]): string => {
    const top = prefix === "";
    const stageOf = new Map(t.stages.map((s) => [s.name, s]));
    const kindOf = (name: string): BoxKind => {
      if (top && name === current) return "current";
      if (top && name === returnTo) return "return";
      return stageOf.has(name) ? "stage" : "exit";
    };
    // A link into an opened sub-workflow lands on its start.
    const entries = new Map<string, string>();

    const place = (name: string) => {
      const id = prefix + name;
      if (graph.hasNode(id)) return;
      const stage = stageOf.get(name);
      const inner = stage?.subflow === undefined ? undefined : types.get(stage.subflow);
      const openable = inner !== undefined && !path.includes(inner.name);
      if (openable && expanded.has(id)) {
        graph.setNode(id, { label: humanize(name) });
        if (parent !== null) graph.setParent(id, parent);
        frames.set(id, humanize(name));
        entries.set(name, drawType(inner, `${id}/`, id, [...path, inner.name]));
        return;
      }
      if (stage?.parallel) {
        addNode(id, humanize(name), groupSize(humanize(name), stage.parallel), parent);
        kinds.set(id, kindOf(name));
        groups.set(id, stage);
        return;
      }
      addBox(id, humanize(name), kindOf(name), parent);
      if (openable) {
        subflows.set(id, inner.name);
        // Room for the arrow that says it opens.
        graph.node(id).width += OPEN_MARK_WIDTH;
      }
    };

    place(t.start);
    for (const stage of t.stages) place(stage.name);
    for (const stage of t.stages) for (const { target } of stage.next) place(target);
    const entry = (name: string) => entries.get(name) ?? prefix + name;

    const loops = loopsBack(t);
    for (const stage of t.stages) {
      const opened = entries.has(stage.name);
      for (const { outcome, target } of stage.next) {
        // An opened sub-workflow's outcome leaves from its exit of the same name.
        let from = prefix + stage.name;
        if (opened) {
          from = `${from}/${outcome}`;
          addBox(from, humanize(outcome), "exit", prefix + stage.name);
        }
        const flipped = loops.has(linkId(stage.name, outcome));
        const cap = flipped ? stageOf.get(target)?.max_loops : undefined;
        links.push({
          id: linkId(prefix + stage.name, outcome),
          from,
          to: entry(target),
          label: cap === undefined ? humanize(outcome) : `${humanize(outcome)} ≤${cap}`,
          flipped,
          dashed: cap !== undefined,
        });
      }
    }
    return entry(t.start);
  };

  drawType(type, "", null, [type.name]);
  // A global stage lives outside the pipeline. Anything else off the type, like `splitting`, sits beside it.
  if (current !== null && !GLOBAL_STAGES.includes(current)) addBox(current, humanize(current), "current", null);

  const ends = (link: PendingLink) => (link.flipped ? { v: link.to, w: link.from } : { v: link.from, w: link.to });
  for (const link of links) {
    const { v, w } = ends(link);
    graph.setEdge(v, w, { width: link.label.length * LABEL_CHAR_WIDTH + LABEL_PADDING, height: LABEL_HEIGHT, labelpos: "c" }, link.id);
  }

  layout(graph);

  const boxes: StageBox[] = [];
  const drawnFrames: StageFrame[] = [];
  for (const name of graph.nodes() as string[]) {
    const { x, y, width, height, label } = graph.node(name);
    const frame = frames.get(name);
    if (frame !== undefined) {
      drawnFrames.push({ name, label: frame, x, y, width, height });
      continue;
    }
    const box: StageBox = { name, label: label ?? name, kind: kinds.get(name) ?? "exit", x, y, width, height };
    const subflow = subflows.get(name);
    if (subflow !== undefined) box.subflow = subflow;
    const group = groups.get(name);
    if (group?.parallel) box.group = groupParts(box, group.parallel, group.gate);
    boxes.push(box);
  }
  const drawn: StageLink[] = links.map((link) => {
    const edge = graph.edge({ ...ends(link), name: link.id });
    const points: Point[] = edge.points ?? [];
    return {
      id: link.id,
      label: link.label,
      points: link.flipped ? [...points].reverse() : points,
      labelAt: typeof edge.x === "number" && typeof edge.y === "number" ? { x: edge.x, y: edge.y } : null,
      dashed: link.dashed,
    };
  });
  const { width = 0, height = 0 } = graph.graph();
  return { boxes, frames: drawnFrames, links: drawn, width, height };
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
