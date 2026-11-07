// Node views: `toView` derives what a node row doesn't store, `holdersOf` and `holdersIn` find what
// holds a node, and `listNodes`, `viewsOf` and `startableNodes` do the same for many nodes at once.

import { nextFireAt } from "./cron.js";
import type { Db } from "./db.js";
import type { HolderVia, NodeRow, NodeView } from "../shared/api.js";
import { availableOutcomes, currentGraphs, getNodeRow, graphFor, stageIsLive, turnOf, type Graphs } from "./nodeCore.js";

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
  const graph = graphFor(graphs, node);
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
    next_fire_at: node.stage === "scheduled" && node.cron !== null ? nextFireAt(node.cron) : null,
    run_id: latestRun?.status === "running" ? latestRun.id : null,
    last_run_id: latestRun?.id ?? null,
  };
}

export function getNode(db: Db, id: string): NodeView {
  return viewOf(db, currentGraphs(), id);
}

/**
 * What a write answers with. Every write that answers with a node reads the process files before it
 * changes anything and renders with those same graphs. So an invalid file refuses the write outright,
 * rather than committing it and then failing to answer: a refused request must change nothing,
 * because the change feed only fires on success.
 */
export function viewOf(db: Db, graphs: Graphs, id: string): NodeView {
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

/** Nodes an agent should start on now: on an agent stage, unclaimed, not held, with no run still leaving. */
export function startableNodes(db: Db, graphs: Graphs): NodeRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM nodes n WHERE claimed_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id AND r.status = 'running')
        ORDER BY rowid`,
    )
    .all() as NodeRow[];
  const agentTurn = rows.filter((node) => turnOf(graphFor(graphs, node), node) === "agent");
  if (agentTurn.length === 0) return [];
  // A holder can be any node in the project, claimed or not, so read every node of those projects.
  const projectIds = [...new Set(agentTurn.map((node) => node.project_id))];
  const everyNode = db
    .prepare("SELECT id, stage, return_stage FROM nodes WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
    .all(JSON.stringify(projectIds)) as HolderState[];
  const holders = holdersIn(db, everyNode, projectIds);
  return agentTurn.filter((node) => (holders.get(node.id) ?? []).length === 0);
}
