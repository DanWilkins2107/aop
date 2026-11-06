/** The shapes the HTTP API accepts and returns. Types only, so that the browser can import this file. */
import type { z } from "zod";
import type * as requests from "./requests.js";

/** What a client may send. Defaulted fields, such as `actor`, are optional. */
type RequestOf<S extends z.ZodType> = z.input<S>;
export type AddProjectRequest = RequestOf<typeof requests.addProjectBody>;
export type UpdateProjectRequest = RequestOf<typeof requests.updateProjectBody>;
export type CreateNodeRequest = RequestOf<typeof requests.createNodeBody>;
export type EditNodeRequest = RequestOf<typeof requests.editNodeBody>;
export type NextRequest = RequestOf<typeof requests.nextBody>;
export type MoveRequest = RequestOf<typeof requests.moveBody>;
export type AskRequest = RequestOf<typeof requests.askBody>;
export type AnswerRequest = RequestOf<typeof requests.answerBody>;
export type FailRequest = RequestOf<typeof requests.failBody>;
export type InvalidateRequest = RequestOf<typeof requests.invalidateBody>;
export type ActorRequest = RequestOf<typeof requests.actorBody>;
export type SteerRequest = RequestOf<typeof requests.steerBody>;
export type BlockRequest = RequestOf<typeof requests.blockBody>;
export type UnblockRequest = RequestOf<typeof requests.unblockBody>;
export type ClaimRequest = RequestOf<typeof requests.claimBody>;
export type MessageRequest = RequestOf<typeof requests.messageBody>;
export type LinkRequest = RequestOf<typeof requests.linkBody>;
export type EdgeRequest = RequestOf<typeof requests.edgeBody>;

/** Every `code` the API refuses a request with. */
export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "refused"
  | "repo_path_not_absolute"
  | "repo_path_not_found"
  | "repo_path_taken"
  | "config_invalid"
  | "constraint_violation"
  | "forbidden_host"
  | "forbidden_origin"
  | "internal_error";

/** The body of every error response. `config_invalid` carries the problems, as strings, in `details`. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

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
  } | null;
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

/** How a node's stage changed: the action that moved it. Also a run's `left_via`. */
export type StageChangeVia =
  | "next"
  | "move"
  | "ask"
  | "answer"
  | "fail"
  | "retry"
  | "invalidate"
  | "restore"
  | "block"
  | "unblock"
  | "split_start"
  | "split_finish";

/** Why an agent run ended, stored on the run as `end_reason`. */
export type RunEndReason = "reported" | "failed" | "stopped" | "held" | "shutdown";

/** What holds a node back, so that it can't start or its schedule can't fire. */
export type HolderVia = "blocks" | "split" | "invalidated_parent";

/** Why a scheduled node didn't fire for a slot, with what it names. */
export type ScheduleSkip =
  | { reason: HolderVia; holder_id: string }
  | { reason: "previous_unfinished"; previous_child_id: string }
  | { reason: "child_refused"; message: string };

/**
 * Each event kind the server records, mapped to its `data`. The stored JSON is exactly this, so
 * changing a shape here changes what new rows hold, while old rows keep what they were written with.
 */
export interface EventDataByKind {
  node_created: { type: string; stage: string; title: string };
  title_edited: { previous: string };
  description_edited: { previous: string };
  stage_changed: {
    via: StageChangeVia;
    from_stage: string;
    from_type: string;
    from_return_stage: string | null;
    to_stage: string;
    to_type: string;
    /** `next`: the outcome taken. */
    outcome?: string;
    /** `fail`, `invalidate` and `block`: the reason given. */
    reason?: string;
    /** AOP's own `fail`: the run that ended without reporting. */
    run_id?: string;
  };
  message_added: { message_id: string; stage: string };
  /** `run_id` when a run takes it; `via: "stop"` when stopping a run hands it to a human. */
  claim_taken: { holder: "human" | "agent"; run_id?: string; via?: "stop" };
  /** `via` is set when AOP drops an agent's claim, rather than its holder releasing it. */
  claim_released: { holder: "human" | "agent"; via?: StageChangeVia | "held" | "shutdown" | "stop" | "restart" };
  run_started: { run_id: string; stage: string };
  run_ended: { run_id: string; reason: RunEndReason; exit_code: number | null };
  link_added: { link_id: string; kind: LinkRow["kind"]; url: string };
  edge_added: { edge_id: string; target_id: string; kind: EdgeRow["kind"] };
  edge_removed: { edge_id: string; target_id: string; kind: EdgeRow["kind"] };
  scheduled_run: { due_at: string; child_id: string };
  scheduled_run_skipped: { due_at: string } & ScheduleSkip;
}

export type EventKind = keyof EventDataByKind;

/** An event of a kind this version knows, narrowed by `kind`. */
export type NodeEvent = {
  [K in EventKind]: { id: string; created_at: string; node_id: string; actor: Actor; kind: K; data: EventDataByKind[K] };
}[EventKind];

/**
 * An event as the API returns it. Older databases can hold kinds this version no longer writes, so
 * `kind` stays a string and `data` unknown: narrow to `NodeEvent` before reading `data`.
 */
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
}
