/** Why an agent run ended, stored on the run as `end_reason`. */
export type RunEndReason = "reported" | "failed" | "stopped" | "held" | "shutdown";

/** One agent run on a node, for the node page's runs table. */
export interface RunView {
  id: string;
  stage: string;
  started_at: string;
  ended_at: string | null;
  ending: "running" | "exited" | "failed" | "stopped" | "timed_out";
  /** The context size of the run's latest turn. Null when the tool's output doesn't say. */
  context_tokens: number | null;
  output_tokens: number | null;
}

/** The end of a run's log, made readable where AOP understands the tool's output. */
export interface LogTail {
  run_id: string;
  running: boolean;
  lines: string[];
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

/** What `aop steer` needs to open a session. The node is already claimed by the time this returns. */
export interface SteerSession {
  node_id: string;
  command: string;
  cwd: string;
  /**
   * The session's ID, which its write tools pass as their `run_id`. It acts on the board only while
   * the human's claim holds, and moves only this node. Reopening a held claim gives the same one.
   */
  steer_id: string;
}

export interface SteerRequest {
  no_sandbox?: boolean;
}
