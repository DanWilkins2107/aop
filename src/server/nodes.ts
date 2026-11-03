import type { Db } from "./db.js";
import { badRequest, notFound, refused } from "./errors.js";
import { projectConfig } from "./projects.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import { isBuiltIn, type StageGraph, type Turn } from "./stages.js";

export interface NodeRow {
  id: string;
  created_at: string;
  project_id: string;
  title: string;
  body: string;
  type: string;
  stage: string;
  cron: string | null;
  invalidation_reason: string | null;
  return_stage: string | null;
  spawned_by: string | null;
}

export interface NodeView extends NodeRow {
  /** False when the stage is gone from the node's type in `stages.yaml`: a human must move it. */
  stage_exists: boolean;
  turn: Turn | null;
  available_outcomes: { outcome: string; target: string }[];
  stale: boolean;
  /** Invalidated ancestors, through `subtask` edges. */
  stale_because: string[];
  /** Unfinished nodes whose `blocks` edges hold this one. */
  blocked_by: string[];
}

export function getNodeRow(db: Db, id: string): NodeRow {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  if (!node) throw notFound(`No node ${id}`);
  return node;
}

function graphForNode(db: Db, nodeId: string): StageGraph {
  return projectConfig(db, getNodeRow(db, nodeId).project_id).graph;
}

/** Whether a node of this type can sit on this stage under the current `stages.yaml`. */
function stageIsLive(graph: StageGraph, type: string, stage: string): boolean {
  if (isBuiltIn(stage) && stage !== "scheduled") return true;
  return graph.types.get(type)?.stages.has(stage) ?? false;
}

function turnOf(graph: StageGraph, node: NodeRow): Turn | null {
  if (node.stage === "ask_human_question" || node.stage === "failed") return "human";
  if (!stageIsLive(graph, node.type, node.stage)) return null;
  return graph.stages.get(node.stage)?.turn ?? null;
}

function outcomesOf(graph: StageGraph, node: NodeRow): Map<string, string> {
  // A scheduled node's one outcome is for the scheduler: it says where the child starts.
  if (node.stage === "scheduled") return new Map();
  return graph.types.get(node.type)?.stages.get(node.stage) ?? new Map();
}

/** Invalidated ancestors of a node. Derived at read time; staleness is never stored. */
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

/**
 * The nodes holding this one through `blocks` edges. `done` and `broken_down` count as finished;
 * an `invalidated` blocker still blocks, so that a human has to decide. Empty means not held.
 */
export function blockersOf(db: Db, nodeId: string): { id: string; stage: string }[] {
  return db
    .prepare(
      `SELECT n.id, n.stage FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE e.target_id = ? AND e.kind = 'blocks' AND e.removed_at IS NULL
          AND n.stage NOT IN ('done', 'broken_down')
        ORDER BY e.rowid`,
    )
    .all(nodeId) as { id: string; stage: string }[];
}

function toView(db: Db, graph: StageGraph, node: NodeRow): NodeView {
  const staleBecause = invalidatedAncestors(db, node.id);
  return {
    ...node,
    stage_exists: stageIsLive(graph, node.type, node.stage),
    turn: turnOf(graph, node),
    available_outcomes: [...outcomesOf(graph, node)].map(([outcome, target]) => ({ outcome, target })),
    stale: staleBecause.length > 0,
    stale_because: staleBecause,
    blocked_by: blockersOf(db, node.id).map((blocker) => blocker.id),
  };
}

export function getNode(db: Db, id: string): NodeView {
  return toView(db, graphForNode(db, id), getNodeRow(db, id));
}

export function listNodes(db: Db, projectId: string): NodeView[] {
  const { graph } = projectConfig(db, projectId);
  const rows = db.prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY rowid").all(projectId) as NodeRow[];
  return rows.map((node) => toView(db, graph, node));
}

/** A shape check only, until the scheduler brings a real cron parser. */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\w*,/?#-]+$/.test(field));
}

export function createNode(
  db: Db,
  projectId: string,
  input: { type: string; title: string; body?: string | undefined; cron?: string | undefined; actor: Actor },
): NodeView {
  const { graph } = projectConfig(db, projectId);
  const type = graph.types.get(input.type);
  if (!type) {
    throw badRequest(`Unknown type "${input.type}". Types: ${[...graph.types.keys()].join(", ")}`);
  }
  if (type.start === "scheduled") {
    if (input.cron === undefined) throw badRequest(`Type "${input.type}" starts at scheduled, so it requires a cron`);
    if (!isValidCron(input.cron)) throw badRequest(`Invalid cron "${input.cron}": expected five fields`);
  } else if (input.cron !== undefined) {
    throw badRequest(`cron only applies to a scheduled node, and type "${input.type}" starts at "${type.start}"`);
  }

  const id = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, created_at, project_id, title, body, type, stage, cron)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, now(), projectId, input.title, input.body ?? "", input.type, type.start, input.cron ?? null);
    appendEvent(db, id, input.actor, "node_created", { type: input.type, stage: type.start, title: input.title });
  })();
  return getNode(db, id);
}

interface StageChange {
  stage: string;
  type: string;
  returnStage?: string | null;
  reason?: string | null;
  cron?: string;
  via: string;
  actor: Actor;
  /** Extra fields for the event's data. */
  detail?: Record<string, unknown>;
}

/**
 * The only way a node's stage changes. Leaving a stage clears its `return_stage` and
 * `invalidation_reason`; the event keeps the previous state, which is what restore reads.
 */
function applyStageChange(db: Db, node: NodeRow, change: StageChange): void {
  db.prepare(
    `UPDATE nodes SET stage = ?, type = ?, return_stage = ?, invalidation_reason = ?, cron = ?
      WHERE id = ?`,
  ).run(
    change.stage,
    change.type,
    change.returnStage ?? null,
    change.reason ?? null,
    change.cron ?? node.cron,
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

function assertAgentStage(graph: StageGraph, node: NodeRow, action: string): void {
  if (turnOf(graph, node) !== "agent") {
    throw refused(`Can't ${action}: stage "${node.stage}" is not an agent stage`);
  }
}

/** Refuses a return to a stage that has since been removed. A human move is the way out of that. */
function assertCanReturn(graph: StageGraph, type: string, stage: string): void {
  if (!stageIsLive(graph, type, stage)) {
    throw refused(`Can't return to "${stage}": it no longer exists in type "${type}". Use a human move instead`);
  }
}

export function next(
  db: Db,
  nodeId: string,
  input: { outcome: string; actor: Actor; reason?: string | undefined },
): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage === "scheduled") {
      throw refused("Can't call next on a scheduled node: it stays there and creates children when it fires");
    }
    if (!stageIsLive(graph, node.type, node.stage)) {
      throw refused(`Stage "${node.stage}" no longer exists in type "${node.type}". A human must move this node`);
    }
    if (input.actor === "agent" && turnOf(graph, node) === "human") {
      throw refused(`Stage "${node.stage}" is a human turn, so an agent can't report its outcome`);
    }
    const outcomes = outcomesOf(graph, node);
    const target = outcomes.get(input.outcome);
    if (target === undefined) {
      throw refused(`Outcome "${input.outcome}" isn't available at stage "${node.stage}" of type "${node.type}"`, {
        available_outcomes: [...outcomes.keys()],
      });
    }

    // Validation guarantees the target is a stage in this type, another type, or a built-in.
    const enteredType = graph.types.get(node.type)?.stages.has(target) ? undefined : graph.types.get(target);
    const toType = enteredType ? target : node.type;
    const toStage = enteredType ? enteredType.start : target;

    assertCanEnter(db, node, toStage);
    if (toStage === "invalidated" && input.reason === undefined) {
      throw refused(`Outcome "${input.outcome}" invalidates the node, so it requires a reason`);
    }
    const waits = toStage === "ask_human_question" || toStage === "failed";
    const reason = toStage === "invalidated" ? input.reason : undefined;
    applyStageChange(db, node, {
      stage: toStage,
      type: toType,
      returnStage: waits ? node.stage : null,
      reason: reason ?? null,
      via: "next",
      actor: input.actor,
      detail: { outcome: input.outcome, ...(reason !== undefined ? { reason } : {}) },
    });
  })();
  return getNode(db, nodeId);
}

/**
 * Finds the type a human move lands in. A stage in the node's own type wins; otherwise the stage
 * must belong to exactly one type, or the caller has to say which.
 */
function resolveMoveType(graph: StageGraph, node: NodeRow, stage: string, type?: string): string {
  const isAnywhere = isBuiltIn(stage) && stage !== "scheduled";
  if (type !== undefined) {
    const def = graph.types.get(type);
    if (!def) throw badRequest(`Unknown type "${type}"`);
    if (!isAnywhere && !def.stages.has(stage)) throw badRequest(`Stage "${stage}" isn't in type "${type}"`);
    return type;
  }
  if (isAnywhere || graph.types.get(node.type)?.stages.has(stage)) return node.type;

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
  const graph = graphForNode(db, nodeId);

  // These carry state of their own, which their actions collect.
  if (input.stage === "invalidated") throw badRequest("Use the invalidate action, which requires a reason");
  if (input.stage === "ask_human_question") throw badRequest("Use the ask action, which requires a question");
  if (input.stage === "failed") throw badRequest("Use the fail action");
  if (input.cron !== undefined) {
    if (input.stage !== "scheduled") throw badRequest("cron only applies when moving to scheduled");
    if (!isValidCron(input.cron)) throw badRequest(`Invalid cron "${input.cron}": expected five fields`);
  }

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    const type = resolveMoveType(graph, node, input.stage, input.type);
    assertCanEnter(db, node, input.stage, input.cron);
    applyStageChange(db, node, {
      stage: input.stage,
      type,
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
      via: "move",
      actor: "human",
    });
  })();
  return getNode(db, nodeId);
}

export interface MessageRow {
  id: string;
  created_at: string;
  node_id: string;
  stage: string;
  author: Actor;
  body: string;
}

function postMessage(db: Db, nodeId: string, stage: string, author: Actor, body: string): MessageRow {
  const message: MessageRow = { id: newId(), created_at: now(), node_id: nodeId, stage, author, body };
  db.prepare(
    "INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(message.id, message.created_at, nodeId, stage, author, body);
  appendEvent(db, nodeId, author, "message_added", { message_id: message.id, stage });
  return message;
}

export function ask(db: Db, nodeId: string, input: { question: string }): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
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
  return getNode(db, nodeId);
}

export function answer(db: Db, nodeId: string, input: { answer: string }): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage !== "ask_human_question" || node.return_stage === null) {
      throw refused(`Can't answer: the node is at "${node.stage}", not ask_human_question`);
    }
    assertCanReturn(graph, node.type, node.return_stage);
    postMessage(db, node.id, "ask_human_question", "human", input.answer);
    applyStageChange(db, node, { stage: node.return_stage, type: node.type, via: "answer", actor: "human" });
  })();
  return getNode(db, nodeId);
}

export function fail(
  db: Db,
  nodeId: string,
  input: { actor: Actor; reason?: string | undefined },
): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    assertAgentStage(graph, node, "fail");
    applyStageChange(db, node, {
      stage: "failed",
      type: node.type,
      returnStage: node.stage,
      via: "fail",
      actor: input.actor,
      ...(input.reason !== undefined ? { detail: { reason: input.reason } } : {}),
    });
  })();
  return getNode(db, nodeId);
}

export function retry(db: Db, nodeId: string): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage !== "failed" || node.return_stage === null) {
      throw refused(`Can't retry: the node is at "${node.stage}", not failed`);
    }
    assertCanReturn(graph, node.type, node.return_stage);
    applyStageChange(db, node, { stage: node.return_stage, type: node.type, via: "retry", actor: "human" });
  })();
  return getNode(db, nodeId);
}

export function invalidate(db: Db, nodeId: string, input: { reason: string; actor: Actor }): NodeView {
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage === "invalidated") throw refused("The node is already invalidated");
    applyStageChange(db, node, {
      stage: "invalidated",
      type: node.type,
      reason: input.reason,
      via: "invalidate",
      actor: input.actor,
      detail: { reason: input.reason },
    });
  })();
  return getNode(db, nodeId);
}

/** Returns an invalidated node to where it was, read from the event that invalidated it. */
export function restore(db: Db, nodeId: string): NodeView {
  const graph = graphForNode(db, nodeId);

  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage !== "invalidated") {
      throw refused(`Can't restore: the node is at "${node.stage}", not invalidated`);
    }
    const event = db
      .prepare(
        `SELECT data FROM events
          WHERE node_id = ? AND kind = 'stage_changed' AND json_extract(data, '$.to_stage') = 'invalidated'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(node.id) as { data: string } | undefined;
    if (!event) throw refused("Can't restore: no event records where this node was invalidated from");
    const from = JSON.parse(event.data) as {
      from_stage: string;
      from_type: string;
      from_return_stage: string | null;
    };

    assertCanReturn(graph, from.from_type, from.from_stage);
    applyStageChange(db, node, {
      stage: from.from_stage,
      type: from.from_type,
      returnStage: from.from_return_stage,
      via: "restore",
      actor: "human",
    });
  })();
  return getNode(db, nodeId);
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

export interface LinkRow {
  id: string;
  created_at: string;
  node_id: string;
  kind: "ticket" | "pr";
  url: string;
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

export interface EdgeRow {
  id: string;
  created_at: string;
  source_id: string;
  target_id: string;
  kind: "subtask" | "blocks";
  removed_at: string | null;
}

/** `source` is the parent of a `subtask` edge and the blocker of a `blocks` edge. */
export function addEdge(
  db: Db,
  sourceId: string,
  input: { target_id: string; kind: EdgeRow["kind"]; actor: Actor },
): EdgeRow {
  return db.transaction(() => {
    getNodeRow(db, sourceId);
    getNodeRow(db, input.target_id);
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

export interface EventView {
  id: string;
  created_at: string;
  node_id: string;
  actor: Actor;
  kind: string;
  data: unknown;
}

export function listEvents(db: Db, nodeId: string): EventView[] {
  getNodeRow(db, nodeId);
  const rows = db.prepare("SELECT * FROM events WHERE node_id = ? ORDER BY rowid").all(nodeId) as (Omit<
    EventView,
    "data"
  > & { data: string })[];
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
}
