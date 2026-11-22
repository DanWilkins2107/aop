// Runs a node through a `subflow:` or `parallel:` stage: the `branches` rows say where it is. A `flow`
// row runs a type and sits on one of its stages; a `stage` row is one agent stage, which a run works.
// When a branch finishes, its result passes up the tree. Once the node's own stage is finished, the
// caller moves the node on with the outcome returned.

import type { Db } from "../db/db.js";
import { refused } from "../shared/errors.js";
import { newId, now } from "../db/records.js";
import { groupOutcomes, runsBranches, stepOf, type StageGraph } from "../stages/stages.js";
import type { NodeRow } from "../../shared/nodes/types.js";
import { graphFor, stageIsLive, type Graphs } from "./nodeCore.js";
import { holdersOf } from "./nodeViews.js";

export interface BranchRow {
  id: string;
  created_at: string;
  node_id: string;
  parent_id: string | null;
  path: string;
  kind: "flow" | "stage";
  /** The type a flow runs. Null on a stage. */
  type: string | null;
  stage: string;
  /** JSON: how many times the flow has entered each of its stages. */
  loops: string;
  outcome: string | null;
}

/** Where a branch is: the flow it's under, or the node itself with `flow` null. */
interface Holder {
  nodeId: string;
  flow: BranchRow | null;
  /** The path its children's paths start with. Empty for the node. */
  path: string;
}

const join = (...parts: string[]) => parts.filter((part) => part !== "").join("/");

function getBranch(db: Db, id: string): BranchRow | undefined {
  return db.prepare("SELECT * FROM branches WHERE id = ?").get(id) as BranchRow | undefined;
}

export function listBranches(db: Db, nodeId: string): BranchRow[] {
  return db.prepare("SELECT * FROM branches WHERE node_id = ? ORDER BY rowid").all(nodeId) as BranchRow[];
}

function childrenOf(db: Db, nodeId: string, flowId: string | null): BranchRow[] {
  return db.prepare("SELECT * FROM branches WHERE node_id = ? AND parent_id IS ? ORDER BY rowid").all(nodeId, flowId) as BranchRow[];
}

function insert(db: Db, holder: Holder, row: Pick<BranchRow, "path" | "kind" | "type" | "stage" | "loops">): BranchRow {
  const id = newId();
  db.prepare(
    "INSERT INTO branches (id, created_at, node_id, parent_id, path, kind, type, stage, loops) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, now(), holder.nodeId, holder.flow?.id ?? null, row.path, row.kind, row.type, row.stage, row.loops);
  return getBranch(db, id) as BranchRow;
}

/** Starts a flow of `type` under `holder`, entering its start stage once. */
function startFlow(db: Db, graph: StageGraph, holder: Holder, path: string, type: string): void {
  const start = graph.types.get(type)?.start;
  if (start === undefined) throw refused(`Type "${type}" no longer exists, so branch ${path} can't start`);
  const flow = insert(db, holder, { path, kind: "flow", type, stage: start, loops: JSON.stringify({ [start]: 1 }) });
  enter(db, graph, { nodeId: holder.nodeId, flow, path }, start);
}

/** Creates what `stage`, of the holder's type, runs. The holder is already on it. */
function enter(db: Db, graph: StageGraph, holder: Holder & { type?: string }, stage: string): void {
  const type = holder.flow?.type ?? holder.type;
  if (type === undefined || type === null) throw new Error("A branch's holder has no type");
  const step = stepOf(graph, type, stage);
  if (step.kind === "agent") {
    insert(db, holder, { path: join(holder.path, stage), kind: "stage", type: null, stage, loops: "{}" });
  } else if (step.kind === "subflow") {
    startFlow(db, graph, holder, join(holder.path, stage), step.type);
  } else {
    for (const branch of step.branches) {
      const path = join(holder.path, stage, branch);
      if (graph.types.has(branch)) startFlow(db, graph, holder, path, branch);
      else insert(db, holder, { path, kind: "stage", type: null, stage: branch, loops: "{}" });
    }
  }
}

/** Creates the branches of a node that has just reached a `subflow:` or `parallel:` stage. */
function startBranches(db: Db, graph: StageGraph, node: { id: string; type: string; stage: string }): void {
  enter(db, graph, { nodeId: node.id, flow: null, path: "", type: node.type }, node.stage);
}

export function clearBranches(db: Db, nodeId: string): void {
  db.prepare("DELETE FROM branches WHERE node_id = ?").run(nodeId);
}

/** The flow a branch sits under (null for the node itself), and the step that flow is on. */
function placeOf(db: Db, graph: StageGraph, branch: BranchRow, node: { type: string; stage: string }) {
  const flow = branch.parent_id === null ? null : (getBranch(db, branch.parent_id) as BranchRow);
  const type = flow?.type ?? node.type;
  const stage = flow?.stage ?? node.stage;
  return { flow, type, stage, step: stepOf(graph, type, stage) };
}

/**
 * The outcomes a stage branch can finish with, each with the stage its flow moves on to, or null when
 * it just finishes the branch for its group: its group's, or its flow's stage's own, less those into a
 * stage already entered its `max_loops` times.
 */
function branchMoves(db: Db, graph: StageGraph, branch: BranchRow, node: { type: string; stage: string }): { outcome: string; target: string | null }[] {
  const { flow, type, stage, step } = placeOf(db, graph, branch, node);
  if (step.kind === "parallel") return groupOutcomes(step.gate).map((outcome) => ({ outcome, target: null }));
  const next = [...(graph.types.get(type)?.stages.get(stage) ?? [])];
  if (flow === null) return next.map(([outcome]) => ({ outcome, target: null }));
  return next.filter(([, target]) => !loopsRunOut(graph, flow, target)).map(([outcome, target]) => ({ outcome, target }));
}

/** What a branch's run is working, for its `context` text. Undefined once the branch is gone. */
export function branchOfRun(
  db: Db,
  graph: StageGraph,
  node: { id: string; type: string; stage: string },
  branchId: string,
): { path: string; stage: string; moves: { outcome: string; target: string | null }[] } | undefined {
  const branch = getBranch(db, branchId);
  if (branch === undefined || branch.node_id !== node.id) return undefined;
  return { path: branch.path, stage: branch.stage, moves: branchMoves(db, graph, branch, node) };
}

/** Whether `flow` has entered `target` as many times as its `max_loops` allows. */
function loopsRunOut(graph: StageGraph, flow: BranchRow, target: string): boolean {
  const max = graph.types.get(flow.type as string)?.maxLoops.get(target);
  const loops = JSON.parse(flow.loops) as Record<string, number>;
  return max !== undefined && (loops[target] ?? 0) >= max;
}

/** A finished group's one outcome. Under `all_pass`, a flow branch passes by finishing. */
function groupOutcome(gate: "all_pass" | null, children: BranchRow[]): string {
  if (gate === null) return "done";
  return children.every((child) => child.outcome === "pass" || child.outcome === "done") ? "pass" : "fail";
}

/**
 * Finishes a stage branch with `outcome`, and passes the result up. Returns the outcome the node's
 * own stage finished with, if it has, for the caller to move the node on. Call inside a transaction.
 */
export function finishBranch(
  db: Db,
  graph: StageGraph,
  node: { id: string; type: string; stage: string },
  input: { branchId: string; outcome: string },
): string | null {
  const branch = getBranch(db, input.branchId);
  if (branch === undefined || branch.node_id !== node.id) throw refused("This branch has already moved on");
  if (branch.outcome !== null) throw refused(`Branch ${branch.path} has already finished with "${branch.outcome}"`);
  const outcomes = branchMoves(db, graph, branch, node).map(({ outcome }) => outcome);
  if (!outcomes.includes(input.outcome)) {
    throw refused(`Outcome "${input.outcome}" isn't available on branch ${branch.path}`, { available_outcomes: outcomes });
  }
  return settle(db, graph, node, { ...branch, outcome: input.outcome });
}

/** Records a branch's outcome, then whatever that finishes above it. */
function settle(db: Db, graph: StageGraph, node: { id: string; type: string; stage: string }, branch: BranchRow): string | null {
  db.prepare("UPDATE branches SET outcome = ? WHERE id = ?").run(branch.outcome, branch.id);
  const { flow, step } = placeOf(db, graph, branch, node);

  let outcome = branch.outcome as string;
  if (step.kind === "parallel") {
    const children = childrenOf(db, node.id, flow?.id ?? null);
    if (children.some((child) => child.outcome === null)) return null;
    outcome = groupOutcome(step.gate, children);
  }
  if (flow === null) return outcome;
  const finished = moveFlow(db, graph, flow, outcome);
  return finished === null ? null : settle(db, graph, node, { ...flow, outcome: finished });
}

/** Moves a flow on from its stage with `outcome`. Returns `done` if the flow finished, null if it carries on. */
function moveFlow(db: Db, graph: StageGraph, flow: BranchRow, outcome: string): string | null {
  const type = graph.types.get(flow.type as string);
  const target = type?.stages.get(flow.stage)?.get(outcome);
  if (type === undefined || target === undefined) {
    throw refused(`Branch ${flow.path}: outcome "${outcome}" leads nowhere from stage "${flow.stage}" of type "${flow.type}"`);
  }
  db.prepare("DELETE FROM branches WHERE parent_id = ?").run(flow.id);
  if (target === "done") return "done";

  if (loopsRunOut(graph, flow, target)) throw refused(`Branch ${flow.path}: stage "${target}" has run its max_loops`);
  const loops = JSON.parse(flow.loops) as Record<string, number>;
  loops[target] = (loops[target] ?? 0) + 1;
  db.prepare("UPDATE branches SET stage = ?, loops = ? WHERE id = ?").run(target, JSON.stringify(loops), flow.id);
  enter(db, graph, { nodeId: flow.node_id, flow: { ...flow, stage: target }, path: flow.path }, target);
  return null;
}

/**
 * A branch's run that asked or failed hands the whole node to a human, so the node's other runs stop
 * now: marking them as left by the system, not the agent, means they get no grace period to exit.
 */
export function stopOtherBranches(db: Db, nodeId: string, run: { id: string; branch_id: string | null } | undefined): void {
  if (run?.branch_id == null) return;
  db.prepare("UPDATE runs SET left_actor = 'system' WHERE node_id = ? AND status = 'running' AND id <> ?").run(nodeId, run.id);
}

/** A failure reason from a branch's run names the branch, as the whole node fails. */
export function branchReason(branch: string | null, reason: string | undefined): string | undefined {
  return branch === null ? reason : `Branch ${branch}: ${reason ?? "its agent marked it failed"}`;
}

/**
 * For a branch's run that asked a human (any other run is left alone): stops the node's other runs, and sets the step the branch is
 * in back to its start. A parallel group re-runs whole, with every branch starting afresh; a lone
 * stage needs nothing, as it is still unfinished. Loop counts don't change. Call inside a transaction.
 */
export function restartAskingBranch(
  db: Db,
  graph: StageGraph,
  node: { id: string; type: string; stage: string },
  run: { id: string; branch_id: string | null } | undefined,
): void {
  if (run?.branch_id == null) return;
  stopOtherBranches(db, node.id, run);
  const branch = getBranch(db, run.branch_id);
  if (branch === undefined) return;
  const { flow, stage, step } = placeOf(db, graph, branch, node);
  if (step.kind !== "parallel") return;
  db.prepare("DELETE FROM branches WHERE node_id = ? AND parent_id IS ?").run(node.id, flow?.id ?? null);
  if (flow === null) startBranches(db, graph, node);
  else enter(db, graph, { nodeId: node.id, flow, path: flow.path }, stage);
}

/** A stage branch an agent should start on now, with its node. */
export interface StartableBranch {
  node: NodeRow;
  branch: BranchRow;
}

/**
 * Stage branches an agent should start on now: unfinished, with no run, on a node that isn't held or
 * claimed by anything but its other branches' runs. Starts the branches of any node that has just
 * reached a stage that runs them.
 */
export function startableBranches(db: Db, graphs: Graphs): StartableBranch[] {
  const nodes = db
    .prepare(
      `SELECT * FROM nodes n
        WHERE (claimed_by IS NULL OR (claimed_by = 'agent' AND EXISTS (
                SELECT 1 FROM runs r WHERE r.node_id = n.id AND r.status = 'running' AND r.branch_id IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id AND r.status = 'running' AND r.branch_id IS NULL)
        ORDER BY rowid`,
    )
    .all() as NodeRow[];
  const startable: StartableBranch[] = [];
  for (const node of nodes) {
    const graph = graphFor(graphs, node);
    if (!stageIsLive(graph, node.type, node.stage) || !runsBranches(graph, node.type, node.stage)) continue;
    if (holdersOf(db, node.id).length > 0 || !ensureBranches(db, graph, node)) continue;
    const rows = db
      .prepare(
        `SELECT * FROM branches b WHERE node_id = ? AND kind = 'stage' AND outcome IS NULL
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.branch_id = b.id AND r.status = 'running')
          ORDER BY rowid`,
      )
      .all(node.id) as BranchRow[];
    startable.push(...rows.map((branch) => ({ node, branch })));
  }
  return startable;
}

/** Starts a node's branches if it has none yet. False if they can't start under the current process. */
function ensureBranches(db: Db, graph: StageGraph, node: NodeRow): boolean {
  if (db.prepare("SELECT 1 FROM branches WHERE node_id = ? LIMIT 1").get(node.id) !== undefined) return true;
  try {
    db.transaction(() => startBranches(db, graph, node))();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}
