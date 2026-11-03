import type { EventView, NodeView, TypeView } from "../../../src/shared/api.js";
import { FINISHED_STAGES } from "./stageStyle.js";

export type StepState = "current" | "visited" | "skipped" | "future";

export interface PipelineStep {
  stage: string;
  state: StepState;
  /** Outcomes that leave the line: sending work back, or out to another type. */
  others: { outcome: string; target: string; back: boolean }[];
}

export interface Pipeline {
  rail: PipelineStep[];
  /** Stages off the longest route through the type. */
  branches: { from: string | null; steps: PipelineStep[] }[];
  /** Set when the node's stage isn't drawn on the line: a built-in side state or a removed stage. */
  side: { stage: string; anchor: string | null } | null;
  /** Earlier types this node passed through, oldest first. */
  cameFrom: string[];
}

interface Shape {
  rail: string[];
  terminal: string | null;
  branches: { from: string | null; stages: string[] }[];
}

function predecessor(forward: Map<string, string[]>, stage: string, placed: Set<string>): string | null {
  for (const [from, targets] of forward) {
    if (placed.has(from) && targets.includes(stage)) return from;
  }
  return null;
}

/**
 * Lays a type's stages out as one line: the longest route from `start`, ignoring edges that go
 * back, with anything left over as branches.
 */
export function shapeOf(type: TypeView): Shape {
  const nextOf = new Map(type.stages.map((s) => [s.name, s.next]));
  const forward = new Map<string, string[]>();
  const seen = new Set<string>();
  const onPath = new Set<string>();

  const walk = (stage: string) => {
    seen.add(stage);
    onPath.add(stage);
    const targets: string[] = [];
    for (const { target } of nextOf.get(stage) ?? []) {
      if (!nextOf.has(target) || onPath.has(target) || targets.includes(target)) continue;
      targets.push(target);
      if (!seen.has(target)) walk(target);
    }
    forward.set(stage, targets);
    onPath.delete(stage);
  };
  if (nextOf.has(type.start)) walk(type.start);
  for (const stage of nextOf.keys()) if (!seen.has(stage)) walk(stage);

  const longestFrom = (stage: string, placed: Set<string>, memo = new Map<string, string[]>()): string[] => {
    const known = memo.get(stage);
    if (known) return known;
    let best: string[] = [];
    for (const target of forward.get(stage) ?? []) {
      if (placed.has(target)) continue;
      const path = longestFrom(target, placed, memo);
      if (path.length > best.length) best = path;
    }
    const path = [stage, ...best];
    memo.set(stage, path);
    return path;
  };

  const placed = new Set<string>();
  const rail = nextOf.has(type.start) ? longestFrom(type.start, placed) : [];
  rail.forEach((stage) => placed.add(stage));

  const branches: Shape["branches"] = [];
  for (;;) {
    const remaining = [...nextOf.keys()].filter((stage) => !placed.has(stage));
    const entry = remaining.find((stage) => predecessor(forward, stage, placed) !== null) ?? remaining[0];
    if (entry === undefined) break;
    const from = predecessor(forward, entry, placed);
    const stages = longestFrom(entry, placed);
    stages.forEach((stage) => placed.add(stage));
    branches.push({ from, stages });
  }

  const last = rail[rail.length - 1];
  const lastNext = last === undefined ? [] : (nextOf.get(last) ?? []);
  const terminal = lastNext.find(({ target }) => FINISHED_STAGES.includes(target))?.target ?? null;
  return { rail, terminal, branches };
}

function record(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** Where a node has been, by type, read from its events. */
function historyOf(events: EventView[]): { type: string; stage: string }[] {
  const visits: { type: string; stage: string }[] = [];
  const add = (type: unknown, stage: unknown) => {
    if (typeof type === "string" && typeof stage === "string") visits.push({ type, stage });
  };
  for (const event of events) {
    const data = record(event.data);
    if (event.kind === "node_created") add(data["type"], data["stage"]);
    if (event.kind === "stage_changed") {
      add(data["from_type"], data["from_stage"]);
      add(data["to_type"], data["to_stage"]);
    }
  }
  return visits;
}

/** The stage a node left to reach its current one, for side states with no `return_stage`. */
function stageBefore(node: NodeView, events: EventView[]): string | null {
  for (const event of [...events].reverse()) {
    const data = record(event.data);
    if (event.kind === "stage_changed" && data["to_stage"] === node.stage && typeof data["from_stage"] === "string") {
      return data["from_stage"];
    }
  }
  return null;
}

/** `events` is oldest first. `type` is undefined when the node's type is gone from `stages.yaml`. */
export function pipelineFor(node: NodeView, type: TypeView | undefined, events: EventView[]): Pipeline {
  const shape: Shape = type ? shapeOf(type) : { rail: [], terminal: null, branches: [] };
  const history = historyOf(events);
  const visited = new Set(history.filter((v) => v.type === node.type).map((v) => v.stage));
  const cameFrom = [...new Set(history.map((v) => v.type))].filter((t) => t !== node.type);

  const line = shape.terminal ? [...shape.rail, shape.terminal] : [...shape.rail];
  const inBranch = shape.branches.some((b) => b.stages.includes(node.stage));
  // A human move can finish a node on a type that has no route to that stage.
  if (!line.includes(node.stage) && !inBranch && FINISHED_STAGES.includes(node.stage)) line.push(node.stage);

  const onLine = line.includes(node.stage) || inBranch;
  const side = onLine ? null : { stage: node.stage, anchor: node.return_stage ?? stageBefore(node, events) };

  const nextOf = new Map(type?.stages.map((s) => [s.name, s.next]) ?? []);
  const reached = (stage: string) => stage === node.stage || visited.has(stage);
  const furthest = line.reduce((best, stage, i) => (reached(stage) ? i : best), -1);

  const step = (stage: string, position: number, sequence: string[]): PipelineStep => {
    let state: StepState = "future";
    if (stage === node.stage) state = "current";
    else if (visited.has(stage)) state = "visited";
    else if (sequence === line && position < furthest) state = "skipped";
    const following = sequence[position + 1];
    const others = (nextOf.get(stage) ?? [])
      .filter(({ target }) => target !== following)
      .map(({ outcome, target }) => {
        const at = sequence.indexOf(target);
        return { outcome, target, back: at !== -1 && at <= position };
      });
    return { stage, state, others };
  };

  return {
    rail: line.map((stage, i) => step(stage, i, line)),
    branches: shape.branches.map((branch) => ({
      from: branch.from,
      steps: branch.stages.map((stage, i) => step(stage, i, branch.stages)),
    })),
    side,
    cameFrom,
  };
}
