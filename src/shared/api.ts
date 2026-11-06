/** The shapes the HTTP API returns. Types only, so that the browser can import this file. */

export type Actor = "human" | "agent" | "system";
export type Turn = "agent" | "human";

export interface ProjectRow {
  id: string;
  created_at: string;
  name: string;
  repo_path: string | null;
}

/** The machine's `config.yaml`, with defaults filled in. `settings` is null while it's invalid. */
export interface ConfigView {
  config_path: string;
  problems: string[];
  settings: {
    agent_session_command: string;
    out_of_sandbox_command: string | null;
    open_from: string;
    open_from_path: string;
    agent_timeout_minutes: number;
    stages: string;
    stages_path: string;
    /** Null when improvements are off. */
    improvement_stages: string | null;
    improvement_stages_path: string | null;
    improvements_path: string;
    /** `improvements_path`, resolved. */
    improvements_dir: string;
    /** The git repo holding it, which Raise PR needs. */
    improvements_repo: string | null;
  } | null;
}

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
  /** The node's latest run, running or not, which is whose log a failed node links to. */
  last_run_id: string | null;
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

/** One agent process AOP started and hasn't yet seen the end of, for `aop ps`. */
export interface AgentProcessView {
  run_id: string;
  pid: number;
  node_id: string;
  /** Null once the node is gone, because its project was deleted. */
  node_title: string | null;
  stage: string | null;
  /** `exiting`: its node moved on and it has a moment to leave. `orphaned`: it shouldn't exist. */
  status: "running" | "exiting" | "orphaned";
  /** `unverified`: AOP never learned its start time, so it can't be sure enough to kill it. */
  identity: "confirmed" | "unverified";
  started_at: string;
  command: string;
}

export interface ReapResult {
  killed: { run_id: string; pid: number; reason: string }[];
  /** Left alone, because AOP couldn't confirm the process is the one it started. */
  skipped: { run_id: string; pid: number; reason: string }[];
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

/** What `aop steer` needs to open a session. The node is already claimed by the time this returns. */
export interface SteerSession {
  node_id: string;
  command: string;
  cwd: string;
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

/** The process page: `stages.yaml` as far as it could be read, with every problem in the config. */
export interface ProcessView {
  /** Absolute path, or null when `config.yaml` doesn't say where the file is. */
  stages_path: string | null;
  problems: string[];
  process: StagesView | null;
  /** The improvement pipeline, when the config is valid and improvements are on. */
  improvement_stages_path: string | null;
  improvement_process: StagesView | null;
}

/** Where an improvement came from. The IDs are cleared if the source project is deleted; the text stays. */
export interface ImprovementSource {
  node_id: string | null;
  message_id: string | null;
  project_id: string | null;
  /** The source message's text, as it was when the improvement was captured. */
  excerpt: string;
  node_title: string;
  /** Null once the project has gone. */
  project_name: string | null;
}

export interface ImprovementView {
  node: NodeView;
  source: ImprovementSource | null;
  proposal_count: number;
}

/** The Improvements tab. `note` says why improvements are off, when they are. */
export interface ImprovementsList {
  enabled: boolean;
  note: string | null;
  improvements: ImprovementView[];
}

/** An improvement's page, with what its agents may change. */
export interface ImprovementDetail extends ImprovementView {
  improvements_dir: string;
  /** False hides the outcomes that lead to `raise_pr`. */
  raise_pr_available: boolean;
}

/** One proposed file, with the real file's current contents to diff against. */
export interface ProposalView {
  id: string;
  /** Absolute. */
  path: string;
  /** Relative to the improvements folder when it's inside it, otherwise the absolute path. */
  display_path: string;
  proposed: string;
  /** Null when the file doesn't exist yet. */
  current: string | null;
  updated_at: string;
  updated_by: "human" | "agent";
}

export interface ApplyResult {
  /** Absolute paths written. */
  written: string[];
  /** With `into`: proposals outside the repo, which have no place in the checkout. */
  skipped: string[];
}
