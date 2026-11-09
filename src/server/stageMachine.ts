// The node state machine. Every stage change goes through `applyStageChange`, and every stage action
// a human or agent takes on a node is a function here: create, edit, next, move, ask, answer, fail,
// retry, invalidate, restore, block, unblock and split.

import { openSteerSessionNode } from "./claims.js";
import type { Db } from "./db.js";
import { badRequest, refused } from "./errors.js";
import type { EventDataByKind, NodeKind, NodeRow, NodeView, StageChangeVia } from "../shared/api.js";
import { FINISHED_STAGES, isBuiltIn, type OwnActionStage } from "../shared/builtInStages.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import type { StageGraph } from "./stages.js";
import { availableOutcomes, currentGraphs, getNodeRow, graphFor, stageIsLive, turnOf } from "./nodeCore.js";
import { viewOf } from "./nodeViews.js";
import { postMessage } from "./messages.js";
import { addEdge } from "./edges.js";

/** Built-ins with state of their own, which their actions collect. Create and move can't land on them. */
const OWN_ACTIONS = new Map<string, string>(
  Object.entries({
    invalidated: "Use the invalidate action, which requires a reason",
    ask_human_question: "Use the ask action, which requires a question",
    failed: "Use the fail action",
    externally_blocked: "Use the block action, which requires a reason",
    splitting: "Use split start, from an agent stage",
  } satisfies Record<OwnActionStage, string>),
);

function assertNoOwnAction(stage: string): void {
  const action = OWN_ACTIONS.get(stage);
  if (action !== undefined) throw badRequest(action);
}

/** Where a new node goes: the top-level `start`, unless the caller chose a type or a stage. */
function resolveStart(
  graph: StageGraph,
  input: { type?: string | undefined; stage?: string | undefined },
): { type: string; stage: string } {
  if (input.stage === undefined) {
    const type = input.type ?? graph.start;
    const def = graph.types.get(type);
    if (!def) throw badRequest(`Unknown type "${type}". Types: ${[...graph.types.keys()].join(", ")}`);
    return { type, stage: def.start };
  }
  assertNoOwnAction(input.stage);
  if (input.stage === "broken_down") throw refused("Can't start at broken_down: a new node has no subtask children");
  return { type: resolveStageType(graph, graph.start, input.stage, input.type), stage: input.stage };
}

export function createNode(
  db: Db,
  projectId: string,
  input: {
    type?: string | undefined;
    stage?: string | undefined;
    title: string;
    body?: string | undefined;
    parent_id?: string | undefined;
    actor: Actor;
  },
  /** Improvements are created through `createImprovement`, which holds the transaction. */
  kind: NodeKind = "work",
): NodeView {
  const graphs = currentGraphs();
  if (kind === "improvement" && graphs.improvement === null) {
    throw refused("Improvements are off: config.yaml has no improvement_stages");
  }
  const graph = graphFor(graphs, { kind, project_id: projectId });
  const { type, stage } = resolveStart(graph, input);

  const id = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, created_at, project_id, title, body, type, stage, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, now(), projectId, input.title, input.body ?? "", type, stage, kind);
    appendEvent(db, id, input.actor, "node_created", { type, stage, title: input.title });
    // In the same transaction, so a child being split off can't be started before its parent holds it.
    if (input.parent_id !== undefined) {
      if (getNodeRow(db, input.parent_id).project_id !== projectId) {
        throw badRequest(`Parent ${input.parent_id} is in another project`);
      }
      addEdge(db, input.parent_id, { target_id: id, kind: "subtask", actor: input.actor });
    }
  })();
  return viewOf(db, graphs, id);
}

/** Edits the title or description. Each event keeps the old text, because nothing else does. */
export function editNode(
  db: Db,
  nodeId: string,
  input: { title?: string | undefined; body?: string | undefined; actor: Actor },
): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (input.title !== undefined && input.title !== node.title) {
      db.prepare("UPDATE nodes SET title = ? WHERE id = ?").run(input.title, nodeId);
      appendEvent(db, nodeId, input.actor, "title_edited", { previous: node.title });
    }
    if (input.body !== undefined && input.body !== node.body) {
      db.prepare("UPDATE nodes SET body = ? WHERE id = ?").run(input.body, nodeId);
      appendEvent(db, nodeId, input.actor, "description_edited", { previous: node.body });
    }
  })();
  return viewOf(db, graphs, nodeId);
}

interface StageChange {
  stage: string;
  type: string;
  returnStage?: string | null;
  reason?: string | null;
  via: StageChangeVia;
  actor: Actor;
  /** Extra fields for the event's data. */
  detail?: Pick<EventDataByKind["stage_changed"], "outcome" | "reason" | "run_id">;
  /** The agent carries on working through this change, so it keeps its claim. */
  keepsAgentClaim?: boolean;
}

/**
 * The only way a node's stage changes. Leaving a stage clears its `return_stage` and
 * `invalidation_reason`; the event keeps the previous state, which is what restore reads.
 * A human's claim survives. An agent's doesn't, because a stage change ends its run, and marking the
 * run here, in the same transaction, is how the orchestrator finds out.
 */
function applyStageChange(db: Db, node: NodeRow, change: StageChange): void {
  const dropsClaim = node.claimed_by === "agent" && change.keepsAgentClaim !== true;
  db.prepare(
    `UPDATE nodes SET stage = ?, type = ?, return_stage = ?, invalidation_reason = ?, claimed_by = ?
      WHERE id = ?`,
  ).run(
    change.stage,
    change.type,
    change.returnStage ?? null,
    change.reason ?? null,
    dropsClaim ? null : node.claimed_by,
    node.id,
  );
  appendEvent(db, node.id, change.actor, "stage_changed", {
    via: change.via,
    from_stage: node.stage,
    from_type: node.type,
    from_return_stage: node.return_stage,
    to_stage: change.stage,
    to_type: change.type,
    ...change.detail,
  });
  if (dropsClaim) appendEvent(db, node.id, "system", "claim_released", { holder: "agent", via: change.via });
  if (change.keepsAgentClaim !== true) {
    db.prepare(
      `UPDATE runs SET left_via = ?, left_actor = ?, left_at = ?
        WHERE node_id = ? AND status = 'running' AND left_via IS NULL`,
    ).run(change.via, change.actor, now(), node.id);
  }
}

/**
 * An agent gets one outcome. Without this, one that reported and is still exiting could move the
 * node on again from its next stage.
 *
 * `runId` is the run ID the caller sent in `RUN_ID_HEADER`, as every MCP write tool does with its
 * `run_id`. When given, it must be the run on this node now. That is what stops a process left over
 * from an earlier run, which can outlive its run while the clear-up after exit is still finding it,
 * from moving the next run's stage. A steered session sends its own ID instead, which moves only its
 * own node and only while the human's claim holds. It is never the agent run itself, so like a
 * caller with no run ID it gets only the check above.
 */
function assertRunStillOnNode(db: Db, nodeId: string, runId?: string): void {
  const steeredNode = runId === undefined ? undefined : openSteerSessionNode(db, runId);
  if (steeredNode !== undefined && steeredNode !== nodeId) {
    throw refused(`Steered session ${runId} is on node ${steeredNode}, so it can't move node ${nodeId}`);
  }
  const run = db.prepare("SELECT id, left_via FROM runs WHERE node_id = ? AND status = 'running'").get(nodeId) as
    | { id: string; left_via: string | null }
    | undefined;
  if (runId !== undefined && steeredNode === undefined && run?.id !== runId) {
    throw refused(`Agent run ${runId} isn't the run on node ${nodeId}, so it can't move it`);
  }
  if (run?.left_via != null) {
    throw refused("This agent run has already moved the node on, and is expected to exit");
  }
}

/**
 * AOP's own move to `failed`, for a run that ended without reporting. Unlike `fail` it doesn't read
 * `stages.yaml`, because a run can die while that file is invalid and its node must still say so.
 * The caller holds the transaction.
 */
export function markFailed(db: Db, node: NodeRow, input: { reason: string; runId: string }): void {
  applyStageChange(db, node, {
    stage: "failed",
    type: node.type,
    returnStage: node.stage,
    via: "fail",
    actor: "system",
    detail: { reason: input.reason, run_id: input.runId },
  });
}

function hasSubtaskChildren(db: Db, nodeId: string): boolean {
  const child = db
    .prepare("SELECT 1 FROM edges WHERE source_id = ? AND kind = 'subtask' AND removed_at IS NULL LIMIT 1")
    .get(nodeId);
  return child !== undefined;
}

function assertCanEnter(db: Db, node: NodeRow, stage: string): void {
  if (stage === "broken_down" && !hasSubtaskChildren(db, node.id)) {
    throw refused("Can't move to broken_down: the node has no subtask children");
  }
}

/** A split's blocks belong on its children. A human move skips this, as the escape hatch. */
function assertBlocksMoved(db: Db, node: NodeRow): void {
  const edge = db
    .prepare(
      `SELECT 1 FROM edges WHERE (source_id = @id OR target_id = @id)
        AND kind = 'blocks' AND removed_at IS NULL LIMIT 1`,
    )
    .get({ id: node.id });
  if (edge !== undefined) {
    throw refused("Can't move to broken_down: the node still has blocks edges. Move them to the relevant children first");
  }
}

function assertAgentStage(graph: StageGraph, node: NodeRow, action: string): void {
  if (turnOf(graph, node) !== "agent") {
    throw refused(`Can't ${action}: stage "${node.stage}" is not an agent stage`);
  }
}

/**
 * Refuses a return to a stage that has since been removed. A human move is the way out of that.
 * Going back to `splitting` restarts the agent stage that began the split, so that must exist too.
 */
function assertCanReturn(graph: StageGraph, type: string, stage: string, returnStage: string | null): void {
  for (const target of stage === "splitting" && returnStage !== null ? [stage, returnStage] : [stage]) {
    if (!stageIsLive(graph, type, target)) {
      throw refused(`Can't return to "${target}": it no longer exists in type "${type}". Use a human move instead`);
    }
  }
}

type StageEntry = Pick<EventDataByKind["stage_changed"], "from_stage" | "from_type" | "from_return_stage">;

/** What the latest stage change made through `via` left behind, read from its event. */
function lastEntry(db: Db, nodeId: string, via: StageChangeVia): StageEntry | undefined {
  const event = db
    .prepare(
      `SELECT data FROM events
        WHERE node_id = ? AND kind = 'stage_changed' AND json_extract(data, '$.via') = ?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(nodeId, via) as { data: string } | undefined;
  return event ? (JSON.parse(event.data) as StageEntry) : undefined;
}

/**
 * Where an answer or a retry sends a node. Going back to `splitting` needs a `return_stage` of its
 * own: the agent stage that began the split, which is what gets restarted.
 */
function returnPlacement(
  db: Db,
  graph: StageGraph,
  node: NodeRow,
  stage: string,
): { stage: string; returnStage: string | null } {
  if (stage !== "splitting") {
    assertCanReturn(graph, node.type, stage, null);
    return { stage, returnStage: null };
  }
  const origin = lastEntry(db, node.id, "split_start")?.from_stage;
  if (origin === undefined) throw refused("Can't return to splitting: no event records what began the split");
  assertCanReturn(graph, node.type, stage, origin);
  return { stage, returnStage: origin };
}

export function next(
  db: Db,
  nodeId: string,
  input: { outcome: string; actor: Actor; runId?: string | undefined },
): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (input.actor === "agent" || input.runId !== undefined) assertRunStillOnNode(db, nodeId, input.runId);
    if (node.stage === "scheduled") {
      throw refused("Can't call next on a scheduled node: it stays there and creates children when it fires");
    }
    if (!stageIsLive(graph, node.type, node.stage)) {
      throw refused(`Stage "${node.stage}" no longer exists in type "${node.type}". A human must move this node`);
    }
    if (input.actor === "agent" && turnOf(graph, node) === "human") {
      throw refused(`Stage "${node.stage}" is a human turn, so an agent can't report its outcome`);
    }
    const outcomes = availableOutcomes(graphs, node);
    const target = outcomes.get(input.outcome);
    if (target === undefined) {
      throw refused(`Outcome "${input.outcome}" isn't available at stage "${node.stage}" of type "${node.type}"`, {
        available_outcomes: [...outcomes.keys()],
      });
    }

    // Validation guarantees the target is a stage in this type, another type, done or broken_down.
    const enteredType = graph.types.get(node.type)?.stages.has(target) ? undefined : graph.types.get(target);
    const toType = enteredType ? target : node.type;
    const toStage = enteredType ? enteredType.start : target;

    assertCanEnter(db, node, toStage);
    if (toStage === "broken_down") assertBlocksMoved(db, node);
    applyStageChange(db, node, {
      stage: toStage,
      type: toType,
      via: "next",
      actor: input.actor,
      detail: { outcome: input.outcome },
    });
  })();
  return viewOf(db, graphs, nodeId);
}

/**
 * Finds the type a stage lands in, for a human move or a new node. A stage in `ownType` wins;
 * otherwise the stage must belong to exactly one type, or the caller has to say which.
 */
function resolveStageType(graph: StageGraph, ownType: string, stage: string, type?: string): string {
  const isAnywhere = isBuiltIn(stage) && stage !== "scheduled";
  if (type !== undefined) {
    const def = graph.types.get(type);
    if (!def) throw badRequest(`Unknown type "${type}"`);
    if (!isAnywhere && !def.stages.has(stage)) throw badRequest(`Stage "${stage}" isn't in type "${type}"`);
    return type;
  }
  if (isAnywhere || graph.types.get(ownType)?.stages.has(stage)) return ownType;

  const candidates = [...graph.types].filter(([, def]) => def.stages.has(stage)).map(([name]) => name);
  const [only] = candidates;
  if (only === undefined) throw badRequest(`Stage "${stage}" isn't in any type`);
  if (candidates.length > 1) {
    throw badRequest(`Stage "${stage}" is in several types (${candidates.join(", ")}). Say which with "type"`);
  }
  return only;
}

/** The human escape hatch: move to any stage, regardless of `next`. */
export function move(
  db: Db,
  nodeId: string,
  input: { stage: string; type?: string | undefined },
): NodeView {
  const graphs = currentGraphs();

  assertNoOwnAction(input.stage);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    const type = resolveStageType(graph, node.type, input.stage, input.type);
    assertCanEnter(db, node, input.stage);
    applyStageChange(db, node, {
      stage: input.stage,
      type,
      via: "move",
      actor: "human",
    });
  })();
  return viewOf(db, graphs, nodeId);
}

export function ask(db: Db, nodeId: string, input: { question: string; runId?: string | undefined }): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    assertRunStillOnNode(db, nodeId, input.runId);
    assertAgentStage(graph, node, "ask");
    applyStageChange(db, node, {
      stage: "ask_human_question",
      type: node.type,
      returnStage: node.stage,
      via: "ask",
      actor: "agent",
    });
    postMessage(db, node.id, "ask_human_question", "agent", input.question);
  })();
  return viewOf(db, graphs, nodeId);
}

export function answer(db: Db, nodeId: string, input: { answer: string }): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (node.stage !== "ask_human_question" || node.return_stage === null) {
      throw refused(`Can't answer: the node is at "${node.stage}", not ask_human_question`);
    }
    const placement = returnPlacement(db, graph, node, node.return_stage);
    postMessage(db, node.id, "ask_human_question", "human", input.answer);
    applyStageChange(db, node, { ...placement, type: node.type, via: "answer", actor: "human" });
  })();
  return viewOf(db, graphs, nodeId);
}

export function fail(
  db: Db,
  nodeId: string,
  input: { actor: Actor; reason?: string | undefined; runId?: string | undefined },
): NodeView {
  // `failed` is AOP's record of a run that ended without finishing, or the node's own agent reporting
  // a dead end. A human stops the run instead.
  if (input.actor === "human") {
    throw refused("Only AOP or the node's own agent marks a node failed. Stop its agent run, or move the node");
  }
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (input.actor === "agent" || input.runId !== undefined) assertRunStillOnNode(db, nodeId, input.runId);
    assertAgentStage(graph, node, "fail");
    applyStageChange(db, node, {
      stage: "failed",
      type: node.type,
      returnStage: node.stage,
      via: "fail",
      actor: input.actor,
      ...(input.reason !== undefined ? { detail: { reason: input.reason } } : {}),
    });
    // As with a question, an agent's reason goes on the node for the human who picks it up.
    if (input.actor === "agent" && input.reason !== undefined) {
      postMessage(db, node.id, "failed", "agent", input.reason);
    }
  })();
  return viewOf(db, graphs, nodeId);
}

export function retry(db: Db, nodeId: string): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (node.stage !== "failed" || node.return_stage === null) {
      throw refused(`Can't retry: the node is at "${node.stage}", not failed`);
    }
    const placement = returnPlacement(db, graph, node, node.return_stage);
    applyStageChange(db, node, { ...placement, type: node.type, via: "retry", actor: "human" });
  })();
  return viewOf(db, graphs, nodeId);
}

/** Human-only: only a human can invalidate, from any stage. */
export function invalidate(db: Db, nodeId: string, input: { reason: string; actor: Actor }): NodeView {
  assertHuman(input.actor, "invalidate a node");
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage === "invalidated") throw refused("The node is already invalidated");
    applyStageChange(db, node, {
      stage: "invalidated",
      type: node.type,
      reason: input.reason,
      via: "invalidate",
      actor: "human",
      detail: { reason: input.reason },
    });
  })();
  return viewOf(db, graphs, nodeId);
}

/** Returns an invalidated node to where it was, read from the event that invalidated it. */
export function restore(db: Db, nodeId: string): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (node.stage !== "invalidated") {
      throw refused(`Can't restore: the node is at "${node.stage}", not invalidated`);
    }
    // Invalidating is the only way in: create and move refuse this stage.
    const from = lastEntry(db, node.id, "invalidate");
    if (!from) throw refused("Can't restore: no event records where this node was invalidated from");

    assertCanReturn(graph, from.from_type, from.from_stage, from.from_return_stage);
    applyStageChange(db, node, {
      stage: from.from_stage,
      type: from.from_type,
      returnStage: from.from_return_stage,
      via: "restore",
      actor: "human",
    });
  })();
  return viewOf(db, graphs, nodeId);
}

function assertHuman(actor: Actor, action: string): void {
  if (actor !== "human") throw refused(`Only a human can ${action}`);
}

/** Waits on something outside AOP. Human-only, and the reason is posted to the node. */
export function block(db: Db, nodeId: string, input: { reason: string; actor: Actor }): NodeView {
  assertHuman(input.actor, "mark a node externally blocked");
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (FINISHED_STAGES.includes(node.stage) || node.stage === "invalidated" || node.stage === "externally_blocked") {
      throw refused(`Can't block: the node is at "${node.stage}"`);
    }
    applyStageChange(db, node, {
      stage: "externally_blocked",
      type: node.type,
      returnStage: node.stage,
      via: "block",
      actor: "human",
      detail: { reason: input.reason },
    });
    postMessage(db, node.id, "externally_blocked", "human", input.reason);
  })();
  return viewOf(db, graphs, nodeId);
}

/** Returns a blocked node to where it was, including that stage's own `return_stage`. */
export function unblock(db: Db, nodeId: string, input: { actor: Actor }): NodeView {
  assertHuman(input.actor, "unblock a node");
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    if (node.stage !== "externally_blocked" || node.return_stage === null) {
      throw refused(`Can't unblock: the node is at "${node.stage}", not externally_blocked`);
    }
    const returnStage = lastEntry(db, node.id, "block")?.from_return_stage ?? null;
    assertCanReturn(graph, node.type, node.return_stage, returnStage);
    applyStageChange(db, node, {
      stage: node.return_stage,
      type: node.type,
      returnStage,
      via: "unblock",
      actor: "human",
    });
  })();
  return viewOf(db, graphs, nodeId);
}

/** Lets an agent create children and edges without any of them starting early. */
export function splitStart(db: Db, nodeId: string, input: { runId?: string | undefined } = {}): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node);
    assertRunStillOnNode(db, nodeId, input.runId);
    if (node.stage === "splitting") throw refused("The node is already splitting");
    assertAgentStage(graph, node, "start a split");
    applyStageChange(db, node, {
      stage: "splitting",
      type: node.type,
      // The agent stage that began the split, which an answer or a retry restarts.
      returnStage: node.stage,
      via: "split_start",
      actor: "agent",
      keepsAgentClaim: true,
    });
  })();
  return viewOf(db, graphs, nodeId);
}

export function splitFinish(db: Db, nodeId: string, input: { runId?: string | undefined } = {}): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    assertRunStillOnNode(db, nodeId, input.runId);
    if (node.stage !== "splitting") {
      throw refused(`Can't finish a split: the node is at "${node.stage}", not splitting`);
    }
    assertCanEnter(db, node, "broken_down");
    assertBlocksMoved(db, node);
    applyStageChange(db, node, { stage: "broken_down", type: node.type, via: "split_finish", actor: "agent" });
  })();
  return viewOf(db, graphs, nodeId);
}
