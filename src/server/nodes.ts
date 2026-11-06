// The node state machine. Every stage change goes through `applyStageChange`, and every action a human
// or agent takes on a node is a function here: next, move, ask, block, split, claim, and so on. Also
// owns messages, links, edges and events, and `toView`, which derives what a node row doesn't store.

import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { badRequest, notFound, refused } from "./errors.js";
import type {
  EdgeRow,
  EventDataByKind,
  EventView,
  HolderVia,
  LinkRow,
  MessageRow,
  NodeKind,
  NodeRow,
  NodeView,
  StageChangeVia,
  Turn,
} from "../shared/api.js";
import {
  AGENT_TURN_STAGES,
  FINISHED_STAGES,
  HUMAN_TURN_STAGES,
  isBuiltIn,
  type OwnActionStage,
} from "../shared/builtInStages.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import { cronProblem } from "./cron.js";
import { EMPTY_GRAPH, type StageGraph } from "./stages.js";

export type { EdgeRow, EventView, LinkRow, MessageRow, NodeRow, NodeView };

export function getNodeRow(db: Db, id: string): NodeRow {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  if (!node) throw notFound(`No node ${id}`);
  return node;
}

/** Work nodes follow `stages.yaml`, and improvements their own pipeline. */
export interface Graphs {
  work: StageGraph;
  /** Null while improvements are off, which leaves every improvement on a stage that doesn't exist. */
  improvement: StageGraph | null;
  /** Whether outcomes leading to `raise_pr` are offered: `improvements_path` is inside a git repo. */
  raisePrAvailable: boolean;
}

/** The stage an improvement's outcome must not lead to unless Raise PR is possible. */
export const RAISE_PR_STAGE = "raise_pr";

export function graphsOf(config: AopConfig): Graphs {
  return { work: config.graph, improvement: config.improvementGraph, raisePrAvailable: config.improvementsRepo !== null };
}

export function graphFor(graphs: Graphs, kind: NodeKind): StageGraph {
  return kind === "improvement" ? (graphs.improvement ?? EMPTY_GRAPH) : graphs.work;
}

/** Read from disk whenever they have changed, so edits to the process files apply without a restart. */
function currentGraphs(): Graphs {
  return graphsOf(loadConfig());
}

/** Whether a node of this type can sit on this stage under the current `stages.yaml`. */
function stageIsLive(graph: StageGraph, type: string, stage: string): boolean {
  if (isBuiltIn(stage) && stage !== "scheduled") return true;
  return graph.types.get(type)?.stages.has(stage) ?? false;
}

function turnOf(graph: StageGraph, node: NodeRow): Turn | null {
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
function availableOutcomes(graphs: Graphs, node: NodeRow): Map<string, string> {
  const outcomes = outcomesOf(graphFor(graphs, node.kind), node);
  if (node.kind !== "improvement" || graphs.raisePrAvailable) return outcomes;
  return new Map([...outcomes].filter(([, target]) => target !== RAISE_PR_STAGE));
}

/** Invalidated ancestors of a node. Derived at read time; being invalidated by a parent is never stored. */
export function invalidatedAncestors(db: Db, nodeId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT source_id FROM edges
          WHERE target_id = ? AND kind = 'subtask' AND removed_at IS NULL
         UNION
         SELECT e.source_id FROM edges e JOIN ancestors a ON e.target_id = a.id
          WHERE e.kind = 'subtask' AND e.removed_at IS NULL
       )
       SELECT n.id FROM nodes n JOIN ancestors a ON a.id = n.id
        WHERE n.stage = 'invalidated' AND n.id <> ?`,
    )
    .all(nodeId, nodeId) as { id: string }[];
  return rows.map((row) => row.id);
}

export interface Holder {
  id: string;
  stage: string;
  via: HolderVia;
}

/**
 * Everything stopping an agent starting on this node. Empty means nothing is.
 *
 * - `blocks`: a blocker that isn't `done`. An `invalidated` one still blocks, so that a human has
 *   to decide, and a `broken_down` one only has blocks left if a human moved it there.
 * - `split`: a parent part-way through a split. That includes one waiting on a human: its
 *   `return_stage` is `splitting`, or it's externally blocked from a question or failure that was.
 * - `invalidated_parent`: an invalidated ancestor, through `subtask` edges.
 */
export function holdersOf(db: Db, nodeId: string): Holder[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.stage, 'blocks' AS via FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE e.target_id = @id AND e.kind = 'blocks' AND e.removed_at IS NULL
          AND n.stage <> 'done'
       UNION ALL
       SELECT n.id, n.stage, 'split' AS via FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE e.target_id = @id AND e.kind = 'subtask' AND e.removed_at IS NULL
          AND (n.stage = 'splitting' OR n.return_stage = 'splitting'
            OR (n.stage = 'externally_blocked' AND n.return_stage IN ('ask_human_question', 'failed')
              AND (SELECT json_extract(ev.data, '$.from_return_stage') FROM events ev
                    WHERE ev.node_id = n.id AND ev.kind = 'stage_changed'
                      AND json_extract(ev.data, '$.via') = 'block'
                    ORDER BY ev.rowid DESC LIMIT 1) = 'splitting'))`,
    )
    .all({ id: nodeId }) as Holder[];
  const ancestors = invalidatedAncestors(db, nodeId).map(
    (id): Holder => ({ id, stage: "invalidated", via: "invalidated_parent" }),
  );
  return [...rows, ...ancestors];
}

interface LatestRun {
  id: string;
  status: string;
}

/** A node as `holdersIn` needs it: what the holder rules read. */
type HolderState = Pick<NodeRow, "id" | "stage" | "return_stage">;

/**
 * `holdersOf` for many nodes at once, in two or three queries instead of several per node, with the
 * same holders in the same order. `nodes` must be every node of `projectIds`, in rowid order: an edge
 * never leaves its project, so that's everywhere a holder can be. Returns each node's holders.
 */
function holdersIn(db: Db, nodes: HolderState[], projectIds: string[]): Map<string, Holder[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = db
    .prepare(
      `SELECT e.source_id, e.target_id, e.kind FROM edges e JOIN nodes n ON n.id = e.target_id
        WHERE n.project_id IN (SELECT value FROM json_each(?)) AND e.removed_at IS NULL
          AND e.kind IN ('blocks', 'subtask')
        ORDER BY e.rowid`,
    )
    .all(JSON.stringify(projectIds)) as { source_id: string; target_id: string; kind: "blocks" | "subtask" }[];

  const incoming = new Map<string, { source: HolderState; kind: "blocks" | "subtask" }[]>();
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source_id);
    if (source === undefined) continue;
    let into = incoming.get(edge.target_id);
    if (into === undefined) incoming.set(edge.target_id, (into = []));
    into.push({ source, kind: edge.kind });
    if (edge.kind === "subtask") {
      let above = parents.get(edge.target_id);
      if (above === undefined) parents.set(edge.target_id, (above = []));
      above.push(edge.source_id);
    }
  }

  // A parent externally blocked from a question or failure still holds its children if that came from splitting.
  const blockedParents = new Set<string>();
  for (const edge of edges) {
    const source = byId.get(edge.source_id);
    if (
      edge.kind === "subtask" &&
      source?.stage === "externally_blocked" &&
      (source.return_stage === "ask_human_question" || source.return_stage === "failed")
    ) {
      blockedParents.add(source.id);
    }
  }
  const blockedFromSplit = new Set<string>();
  if (blockedParents.size > 0) {
    const rows = db
      .prepare(
        `SELECT node_id, json_extract(data, '$.from_return_stage') AS from_return_stage FROM events
          WHERE rowid IN (SELECT MAX(rowid) FROM events
                           WHERE node_id IN (SELECT value FROM json_each(?)) AND kind = 'stage_changed'
                             AND json_extract(data, '$.via') = 'block'
                           GROUP BY node_id)`,
      )
      .all(JSON.stringify([...blockedParents])) as { node_id: string; from_return_stage: unknown }[];
    for (const row of rows) if (row.from_return_stage === "splitting") blockedFromSplit.add(row.node_id);
  }
  const splits = (node: HolderState) =>
    node.stage === "splitting" || node.return_stage === "splitting" || blockedFromSplit.has(node.id);

  const anyInvalidated = nodes.some((node) => node.stage === "invalidated");
  // In rowid order, as the per-node query returns them.
  const invalidatedAncestorsOf = (id: string): string[] => {
    if (!anyInvalidated) return [];
    const seen = new Set<string>();
    const queue = [...(parents.get(id) ?? [])];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(parents.get(next) ?? []));
    }
    return [...seen]
      .filter((ancestor) => ancestor !== id && byId.get(ancestor)?.stage === "invalidated")
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  };

  const result = new Map<string, Holder[]>();
  for (const node of nodes) {
    const into = incoming.get(node.id) ?? [];
    const blocks = into
      .filter(({ source, kind }) => kind === "blocks" && source.stage !== "done")
      .map(({ source }): Holder => ({ id: source.id, stage: source.stage, via: "blocks" }));
    const split = into
      .filter(({ source, kind }) => kind === "subtask" && splits(source))
      .map(({ source }): Holder => ({ id: source.id, stage: source.stage, via: "split" }));
    const ancestors = invalidatedAncestorsOf(node.id).map(
      (ancestor): Holder => ({ id: ancestor, stage: "invalidated", via: "invalidated_parent" }),
    );
    result.set(node.id, [...blocks, ...split, ...ancestors]);
  }
  return result;
}

function toView(db: Db, graphs: Graphs, node: NodeRow): NodeView {
  const latestRun = db.prepare("SELECT id, status FROM runs WHERE node_id = ? ORDER BY rowid DESC LIMIT 1").get(node.id) as
    | LatestRun
    | undefined;
  return deriveView(graphs, node, holdersOf(db, node.id), latestRun);
}

/** What a view adds to its row, given the holders and latest run that `toView` or `listNodes` read. */
function deriveView(graphs: Graphs, node: NodeRow, holders: Holder[], latestRun: LatestRun | undefined): NodeView {
  const graph = graphFor(graphs, node.kind);
  const holdersVia = (via: Holder["via"]) => holders.filter((holder) => holder.via === via).map((holder) => holder.id);
  const invalidatedParents = holdersVia("invalidated_parent");
  const heldBy = holdersVia("split");
  return {
    ...node,
    stage_exists: stageIsLive(graph, node.type, node.stage),
    turn: turnOf(graph, node),
    available_outcomes: [...availableOutcomes(graphs, node)].map(([outcome, target]) => ({ outcome, target })),
    invalidated_by_parent: invalidatedParents.length > 0,
    invalidated_ancestors: invalidatedParents,
    blocked_by: holdersVia("blocks"),
    held: heldBy.length > 0,
    held_by: heldBy,
    run_id: latestRun?.status === "running" ? latestRun.id : null,
    last_run_id: latestRun?.id ?? null,
  };
}

export function getNode(db: Db, id: string): NodeView {
  return viewOf(db, currentGraphs(), id);
}

/**
 * What a write answers with. Every write that answers with a node reads `stages.yaml` before it
 * changes anything and renders with that same graph. So an invalid file refuses the write outright,
 * rather than committing it and then failing to answer: a refused request must change nothing,
 * because the change feed only fires on success.
 */
function viewOf(db: Db, graphs: Graphs, id: string): NodeView {
  return toView(db, graphs, getNodeRow(db, id));
}

/** Every node in a project, each as `getNode` shows it, from a handful of queries for the whole project. */
export function listNodes(db: Db, projectId: string): NodeView[] {
  const graphs = currentGraphs();
  const rows = db.prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY rowid").all(projectId) as NodeRow[];
  return viewsIn(db, rows, rows, [projectId], graphs);
}

/**
 * Views of rows the caller already has, each as `getNode` shows it, reading the process files once and
 * the holders and latest runs of all their projects in a handful of queries.
 */
export function viewsOf(db: Db, rows: NodeRow[], graphs: Graphs = currentGraphs()): NodeView[] {
  if (rows.length === 0) return [];
  // A holder can be any node in the project, so read every node of those projects.
  const projectIds = [...new Set(rows.map((node) => node.project_id))];
  const everyNode = db
    .prepare("SELECT id, stage, return_stage FROM nodes WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
    .all(JSON.stringify(projectIds)) as HolderState[];
  return viewsIn(db, rows, everyNode, projectIds, graphs);
}

/** `rows` as views, given every node of their projects, `projectIds`, for the holder rules. */
function viewsIn(db: Db, rows: NodeRow[], everyNode: HolderState[], projectIds: string[], graphs: Graphs): NodeView[] {
  if (rows.length === 0) return [];
  const holders = holdersIn(db, everyNode, projectIds);
  const runs = db
    .prepare(
      `SELECT node_id, id, status FROM runs
        WHERE rowid IN (SELECT MAX(r.rowid) FROM runs r JOIN nodes n ON n.id = r.node_id
                         WHERE n.project_id IN (SELECT value FROM json_each(?)) GROUP BY r.node_id)`,
    )
    .all(JSON.stringify(projectIds)) as (LatestRun & { node_id: string })[];
  const latestRuns = new Map(runs.map((run) => [run.node_id, { id: run.id, status: run.status }]));
  return rows.map((node) => deriveView(graphs, node, holders.get(node.id) ?? [], latestRuns.get(node.id)));
}

function assertValidCron(cron: string): void {
  const problem = cronProblem(cron);
  if (problem !== null) throw badRequest(`Invalid cron "${cron}": ${problem}`);
}

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
    cron?: string | undefined;
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
  const graph = graphFor(graphs, kind);
  const { type, stage } = resolveStart(graph, input);
  if (stage === "scheduled") {
    if (input.cron === undefined) throw badRequest("A node starting at scheduled requires a cron");
    assertValidCron(input.cron);
  } else if (input.cron !== undefined) {
    throw badRequest(`cron only applies to a scheduled node, and this one starts at "${stage}"`);
  }

  const id = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, created_at, project_id, title, body, type, stage, cron, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, now(), projectId, input.title, input.body ?? "", type, stage, input.cron ?? null, kind);
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
  cron?: string;
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
    `UPDATE nodes SET stage = ?, type = ?, return_stage = ?, invalidation_reason = ?, cron = ?, claimed_by = ?
      WHERE id = ?`,
  ).run(
    change.stage,
    change.type,
    change.returnStage ?? null,
    change.reason ?? null,
    change.cron ?? node.cron,
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
 * `runId` is the run the caller says it belongs to (the CLI sends its `AOP_RUN_ID`). When given, it
 * must be the run on this node now. That is what stops a process left over from an earlier run, which
 * can outlive its run while the clear-up after exit is still finding it, from moving the next run's
 * stage. A caller with no run ID, such as a steered session, gets only the check above.
 */
function assertRunStillOnNode(db: Db, nodeId: string, runId?: string): void {
  const run = db.prepare("SELECT id, left_via FROM runs WHERE node_id = ? AND status = 'running'").get(nodeId) as
    | { id: string; left_via: string | null }
    | undefined;
  if (runId !== undefined && run?.id !== runId) {
    throw refused(`Agent run ${runId} isn't the run on node ${nodeId}, so it can't move it`);
  }
  if (run?.left_via != null) {
    throw refused("This agent run has already moved the node on, and is expected to exit");
  }
}

/** Nodes an agent should start on now: on an agent stage, unclaimed, not held, with no run still leaving. */
export function startableNodes(db: Db, graphs: Graphs): NodeRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM nodes n WHERE claimed_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id AND r.status = 'running')
        ORDER BY rowid`,
    )
    .all() as NodeRow[];
  const agentTurn = rows.filter((node) => turnOf(graphFor(graphs, node.kind), node) === "agent");
  if (agentTurn.length === 0) return [];
  // A holder can be any node in the project, claimed or not, so read every node of those projects.
  const projectIds = [...new Set(agentTurn.map((node) => node.project_id))];
  const everyNode = db
    .prepare("SELECT id, stage, return_stage FROM nodes WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
    .all(JSON.stringify(projectIds)) as HolderState[];
  const holders = holdersIn(db, everyNode, projectIds);
  return agentTurn.filter((node) => (holders.get(node.id) ?? []).length === 0);
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

function assertCanEnter(db: Db, node: NodeRow, stage: string, cron?: string): void {
  if (stage === "broken_down" && !hasSubtaskChildren(db, node.id)) {
    throw refused("Can't move to broken_down: the node has no subtask children");
  }
  if (stage === "scheduled" && cron === undefined && node.cron === null) {
    throw refused("Can't move to scheduled: the node has no cron. A human move can set one");
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
    const graph = graphFor(graphs, node.kind);
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
  input: { stage: string; type?: string | undefined; cron?: string | undefined },
): NodeView {
  const graphs = currentGraphs();

  assertNoOwnAction(input.stage);
  if (input.cron !== undefined) {
    if (input.stage !== "scheduled") throw badRequest("cron only applies when moving to scheduled");
    assertValidCron(input.cron);
  }

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node.kind);
    const type = resolveStageType(graph, node.type, input.stage, input.type);
    assertCanEnter(db, node, input.stage, input.cron);
    applyStageChange(db, node, {
      stage: input.stage,
      type,
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
      via: "move",
      actor: "human",
    });
  })();
  return viewOf(db, graphs, nodeId);
}

function postMessage(db: Db, nodeId: string, stage: string, author: Actor, body: string): MessageRow {
  const message: MessageRow = { id: newId(), created_at: now(), node_id: nodeId, stage, author, body };
  db.prepare(
    "INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(message.id, message.created_at, nodeId, stage, author, body);
  appendEvent(db, nodeId, author, "message_added", { message_id: message.id, stage });
  return message;
}

export function ask(db: Db, nodeId: string, input: { question: string; runId?: string | undefined }): NodeView {
  const graphs = currentGraphs();

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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
    const graph = graphFor(graphs, node.kind);
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

const holderName = (holder: "human" | "agent") => (holder === "agent" ? "an agent run" : "a human");

/**
 * Takes the node's one claim. A human can claim again, so that a session can be reopened, but
 * neither side can take a claim the other holds, and only one agent run can hold it.
 */
export function claim(db: Db, nodeId: string, input: { actor: "human" | "agent" }): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.claimed_by === "human" && input.actor === "human") return;
    if (node.claimed_by !== null) throw refused(`Can't claim: ${holderName(node.claimed_by)} holds this node`);
    db.prepare("UPDATE nodes SET claimed_by = ? WHERE id = ?").run(input.actor, nodeId);
    appendEvent(db, nodeId, input.actor, "claim_taken", { holder: input.actor });
  })();
  return viewOf(db, graphs, nodeId);
}

/** Each side releases its own claim. A human ends an agent's by stopping its run, not here. */
export function releaseClaim(db: Db, nodeId: string, input: { actor: "human" | "agent" }): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.claimed_by === null) throw refused("Can't release: the node isn't claimed");
    if (node.claimed_by !== input.actor) {
      throw refused(`Can't release: the claim belongs to ${holderName(node.claimed_by)}`);
    }
    db.prepare("UPDATE nodes SET claimed_by = NULL WHERE id = ?").run(nodeId);
    appendEvent(db, nodeId, input.actor, "claim_released", { holder: input.actor });
  })();
  return viewOf(db, graphs, nodeId);
}

export function addMessage(db: Db, nodeId: string, input: { author: Actor; body: string }): MessageRow {
  return db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    return postMessage(db, node.id, node.stage, input.author, input.body);
  })();
}

export function listMessages(db: Db, nodeId: string): MessageRow[] {
  getNodeRow(db, nodeId);
  return db.prepare("SELECT * FROM messages WHERE node_id = ? ORDER BY rowid").all(nodeId) as MessageRow[];
}

export function addLink(
  db: Db,
  nodeId: string,
  input: { kind: LinkRow["kind"]; url: string; actor: Actor },
): LinkRow {
  return db.transaction(() => {
    getNodeRow(db, nodeId);
    const link: LinkRow = { id: newId(), created_at: now(), node_id: nodeId, kind: input.kind, url: input.url };
    db.prepare("INSERT INTO links (id, created_at, node_id, kind, url) VALUES (?, ?, ?, ?, ?)").run(
      link.id,
      link.created_at,
      nodeId,
      link.kind,
      link.url,
    );
    appendEvent(db, nodeId, input.actor, "link_added", { link_id: link.id, kind: link.kind, url: link.url });
    return link;
  })();
}

export function listLinks(db: Db, nodeId: string): LinkRow[] {
  getNodeRow(db, nodeId);
  return db.prepare("SELECT * FROM links WHERE node_id = ? ORDER BY rowid").all(nodeId) as LinkRow[];
}

/** Whether `from` blocks `to`, directly or through other nodes. */
function blocksReach(db: Db, from: string, to: string): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE reached(id) AS (
         SELECT ?
         UNION
         SELECT e.target_id FROM edges e JOIN reached r ON e.source_id = r.id
          WHERE e.kind = 'blocks' AND e.removed_at IS NULL
       )
       SELECT 1 FROM reached WHERE id = ?`,
    )
    .get(from, to);
  return row !== undefined;
}

/** `source` is the parent of a `subtask` edge and the blocker of a `blocks` edge. */
export function addEdge(
  db: Db,
  sourceId: string,
  input: { target_id: string; kind: EdgeRow["kind"]; actor: Actor },
): EdgeRow {
  return db.transaction(() => {
    const source = getNodeRow(db, sourceId);
    const target = getNodeRow(db, input.target_id);
    if (input.kind === "blocks" && (source.stage === "broken_down" || target.stage === "broken_down")) {
      throw refused("Can't add a blocks edge to or from a broken_down node. Add it to the relevant child instead");
    }
    // A self edge reaches itself too, but the schema refuses that one with its own constraint.
    if (input.kind === "blocks" && sourceId !== input.target_id && blocksReach(db, input.target_id, sourceId)) {
      throw refused("Can't add this edge: it would create a blocks cycle");
    }
    const edge: EdgeRow = {
      id: newId(),
      created_at: now(),
      source_id: sourceId,
      target_id: input.target_id,
      kind: input.kind,
      removed_at: null,
    };
    db.prepare("INSERT INTO edges (id, created_at, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)").run(
      edge.id,
      edge.created_at,
      edge.source_id,
      edge.target_id,
      edge.kind,
    );
    appendEvent(db, sourceId, input.actor, "edge_added", {
      edge_id: edge.id,
      target_id: edge.target_id,
      kind: edge.kind,
    });
    return edge;
  })();
}

/** Every active edge in a project, for drawing its graph. */
export function listProjectEdges(db: Db, projectId: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT e.* FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE n.project_id = ? AND e.removed_at IS NULL ORDER BY e.rowid`,
    )
    .all(projectId) as EdgeRow[];
}

/** Edges touching the node in either direction. Removed ones appear only on request. */
export function listEdges(db: Db, nodeId: string, includeRemoved: boolean): EdgeRow[] {
  getNodeRow(db, nodeId);
  return db
    .prepare(
      `SELECT * FROM edges WHERE (source_id = @id OR target_id = @id)
        AND (@all = 1 OR removed_at IS NULL) ORDER BY rowid`,
    )
    .all({ id: nodeId, all: includeRemoved ? 1 : 0 }) as EdgeRow[];
}

export function removeEdge(db: Db, edgeId: string, actor: Actor): EdgeRow {
  return db.transaction(() => {
    const edge = db.prepare("SELECT * FROM edges WHERE id = ?").get(edgeId) as EdgeRow | undefined;
    if (!edge) throw notFound(`No edge ${edgeId}`);
    if (edge.removed_at !== null) throw refused("The edge is already removed");
    const removedAt = now();
    db.prepare("UPDATE edges SET removed_at = ? WHERE id = ?").run(removedAt, edgeId);
    appendEvent(db, edge.source_id, actor, "edge_removed", {
      edge_id: edge.id,
      target_id: edge.target_id,
      kind: edge.kind,
    });
    return { ...edge, removed_at: removedAt };
  })();
}

export function listEvents(db: Db, nodeId: string): EventView[] {
  getNodeRow(db, nodeId);
  const rows = db.prepare("SELECT * FROM events WHERE node_id = ? ORDER BY rowid").all(nodeId) as (Omit<
    EventView,
    "data"
  > & { data: string })[];
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
}
