/** The shapes the HTTP API returns. Types only, so that the browser can import this file. */

export type Actor = "human" | "agent" | "system";
export type Turn = "agent" | "human";

export interface ProjectRow {
  id: string;
  created_at: string;
  name: string;
  repo_path: string;
}

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
}

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

export interface EventView {
  id: string;
  created_at: string;
  node_id: string;
  actor: Actor;
  kind: string;
  data: unknown;
}

/** The shared `stages.yaml`, in file order. Built-in stages aren't listed unless a type uses one. */
export interface StagesView {
  /** The type new nodes enter. */
  start: string;
  stages: { name: string; turn: Turn; color: string | null }[];
  types: TypeView[];
}

export interface TypeView {
  name: string;
  start: string;
  stages: { name: string; next: { outcome: string; target: string }[] }[];
}
