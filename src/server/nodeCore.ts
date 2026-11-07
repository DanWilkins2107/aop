// What the other node modules share: reading a node row, the graphs a node follows, and the rules
// read straight off them (whether a stage is live, whose turn it is, which outcomes are offered).

import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { notFound } from "./errors.js";
import type { NodeRow, Turn } from "../shared/api.js";
import { AGENT_TURN_STAGES, HUMAN_TURN_STAGES, isBuiltIn } from "../shared/builtInStages.js";
import { EMPTY_GRAPH, type StageGraph } from "./stages.js";

export function getNodeRow(db: Db, id: string): NodeRow {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  if (!node) throw notFound(`No node ${id}`);
  return node;
}

/** Work nodes follow their project's own process or `stages.yaml`, and improvements their own pipeline. */
export interface Graphs {
  work: StageGraph;
  /** Projects with a process of their own, by project ID. */
  projects: Map<string, StageGraph>;
  /** Null while improvements are off, which leaves every improvement on a stage that doesn't exist. */
  improvement: StageGraph | null;
  /** Whether outcomes leading to `raise_pr` are offered: `improvements_path` is inside a git repo. */
  raisePrAvailable: boolean;
}

/** The stage an improvement's outcome must not lead to unless Raise PR is possible. */
export const RAISE_PR_STAGE = "raise_pr";

export function graphsOf(config: AopConfig): Graphs {
  return {
    work: config.graph,
    projects: new Map([...config.projectStages].map(([id, own]) => [id, own.graph])),
    improvement: config.improvementGraph,
    raisePrAvailable: config.improvementsRepo !== null,
  };
}

/** The process a node follows, or a new node in that project would. */
export function graphFor(graphs: Graphs, node: Pick<NodeRow, "kind" | "project_id">): StageGraph {
  if (node.kind === "improvement") return graphs.improvement ?? EMPTY_GRAPH;
  return graphs.projects.get(node.project_id) ?? graphs.work;
}

/** Read from disk whenever they have changed, so edits to the process files apply without a restart. */
export function currentGraphs(): Graphs {
  return graphsOf(loadConfig());
}

/** Whether a node of this type can sit on this stage under its current process. */
export function stageIsLive(graph: StageGraph, type: string, stage: string): boolean {
  if (isBuiltIn(stage) && stage !== "scheduled") return true;
  return graph.types.get(type)?.stages.has(stage) ?? false;
}

export function turnOf(graph: StageGraph, node: NodeRow): Turn | null {
  if (HUMAN_TURN_STAGES.includes(node.stage)) return "human";
  if (AGENT_TURN_STAGES.includes(node.stage)) return "agent";
  if (!stageIsLive(graph, node.type, node.stage)) return null;
  return graph.stages.get(node.stage)?.turn ?? null;
}

function outcomesOf(graph: StageGraph, node: NodeRow): Map<string, string> {
  // A scheduled node's one outcome is for the scheduler: it says where the child starts.
  if (node.stage === "scheduled") return new Map();
  return graph.types.get(node.type)?.stages.get(node.stage) ?? new Map();
}

/** The outcomes a node offers now. An improvement can't head for `raise_pr` without a git repo. */
export function availableOutcomes(graphs: Graphs, node: NodeRow): Map<string, string> {
  const outcomes = outcomesOf(graphFor(graphs, node), node);
  if (node.kind !== "improvement" || graphs.raisePrAvailable) return outcomes;
  return new Map([...outcomes].filter(([, target]) => target !== RAISE_PR_STAGE));
}
