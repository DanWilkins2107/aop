export type Actor = "human" | "agent" | "system";

export type Turn = "agent" | "human";

/** A node is project work, or an improvement to how agents work, which belongs to no project. */
export type NodeKind = "work" | "improvement";

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
  claimed_by: "human" | "agent" | null;
  kind: NodeKind;
}

export interface NodeView extends NodeRow {
  /** False when the stage is gone from the node's type in `stages.yaml`: a human must move it. */
  stage_exists: boolean;
  turn: Turn | null;
  available_outcomes: { outcome: string; target: string }[];
  invalidated_by_parent: boolean;
  /** Invalidated ancestors, through `subtask` edges. */
  invalidated_ancestors: string[];
  /** Unfinished nodes whose `blocks` edges hold this one. */
  blocked_by: string[];
  /** True while a parent is part-way through a split, so that its children don't start early. */
  held: boolean;
  /** The parents doing that. */
  held_by: string[];
  /** The run that's on this node now, including one on its way out after the node moved on. */
  run_id: string | null;
  /** At scheduled, when its schedule next fires. Null with no schedule, or at any other stage. */
  next_fire_at: string | null;
  /** The node's latest run, running or not, which is whose log a failed node links to. */
  last_run_id: string | null;
}

/** What holds a node back, so that it can't start or its schedule can't fire. */
export type HolderVia = "blocks" | "split" | "invalidated_parent";

export interface MessageRow {
  id: string;
  created_at: string;
  node_id: string;
  stage: string;
  author: Actor;
  body: string;
}

export interface LinkRow {
  id: string;
  created_at: string;
  node_id: string;
  kind: "ticket" | "pr";
  url: string;
}

export interface EdgeRow {
  id: string;
  created_at: string;
  source_id: string;
  target_id: string;
  kind: "subtask" | "blocks";
  removed_at: string | null;
}

export interface SearchResult {
  node_id: string;
  project_id: string;
  title: string;
  type: string;
  stage: string;
  /** The matching text, with the matched words in [brackets]. */
  snippet: string;
}

export interface CreateNodeRequest {
  type?: string;
  stage?: string;
  title: string;
  body?: string;
  parent_id?: string;
  actor?: Actor;
}

/** At least one of `title` and `body`. */
export interface EditNodeRequest {
  title?: string;
  body?: string;
  actor?: Actor;
}

/** The body of a write that takes nothing but who made it. */
export interface ActorRequest {
  actor?: Actor;
}

export interface MessageRequest {
  body: string;
  author?: Actor;
}

export interface LinkRequest {
  kind: LinkRow["kind"];
  url: string;
  actor?: Actor;
}

export interface EdgeRequest {
  target_id: string;
  kind: EdgeRow["kind"];
  actor?: Actor;
}
