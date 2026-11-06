// Reads and writes the `runs` and `agent_processes` tables. The orchestrator decides when.

import type { EventDataByKind, RunEndReason, RunView } from "../shared/api.js";
import type { OutputFormat, Usage } from "./agentOutput.js";
import type { Db } from "./db.js";
import { refused } from "./errors.js";
import type { NodeRow } from "./nodes.js";
import type { Identity } from "./osProcesses.js";
import { appendEvent, now, type Actor } from "./records.js";

export type EndReason = RunEndReason;

export interface RunRow {
  id: string;
  created_at: string;
  node_id: string;
  stage: string;
  status: "running" | "exited";
  pid: number | null;
  exit_code: number | null;
  log_path: string;
  ended_at: string | null;
  /** How the node left the stage this run was on, while the run was still going. */
  left_via: string | null;
  left_actor: Actor | null;
  left_at: string | null;
  end_reason: EndReason | null;
  output_format: OutputFormat;
  /** See `Usage`. Null when the tool's output says nothing AOP can read. */
  context_tokens: number | null;
  output_tokens: number | null;
  /** 1 for a `failed` run that ran past agent_timeout_minutes. */
  timed_out: 0 | 1;
  /** 1 once a clean shutdown has begun stopping the run. See `markShuttingDown`. */
  shutting_down: 0 | 1;
}

/** A process AOP started. Stays until AOP knows the process is gone, whatever happens to its run. */
export interface ProcessRow {
  id: string;
  created_at: string;
  node_id: string;
  pid: number;
  /** See `readProcessStarts`. Null until it's been read, and a process with none is never killed. */
  process_start: string | null;
  /** JSON of the `Identity` of what the launched shell started, which is usually the real agent. */
  children: string | null;
  command: string;
}

/** What can be confirmed about a recorded process: itself, if its start time was read, and its children. */
export function identitiesOf(row: ProcessRow): Identity[] {
  return [
    ...(row.process_start === null ? [] : [{ pid: row.pid, start: row.process_start }]),
    ...(row.children === null ? [] : (JSON.parse(row.children) as Identity[])),
  ];
}

export function getRun(db: Db, id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function runningRuns(db: Db): RunRow[] {
  return db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY rowid").all() as RunRow[];
}

/** Whether the agent itself finished the stage, which earns it a moment to exit, or someone moved it off. */
export function agentReported(run: RunRow): boolean {
  return run.left_actor === "agent" && ["next", "ask", "fail", "split_finish"].includes(run.left_via ?? "");
}

/** Why AOP stopped a run's process, if it did. */
export type StopReason = "human" | "timeout" | "held" | "moved_on" | "shutdown" | "project_deleted";

/** How a run's process ended, as far as AOP knows. */
export type RunEnding =
  | {
      kind: "exited";
      /** Why this server stopped it, or null if it ended by itself. */
      stopReason: StopReason | null;
      exitCode: number | null;
      signal: string | null;
      /** Why the process never started, if it didn't. */
      launchError: string | null;
      timeoutMinutes: number;
    }
  /** A `running` row found with no process this server is tracking: the last server went down. */
  | { kind: "lost" };

/** What a run's end does to its node, besides closing the run. */
export type RunEndAction =
  | { kind: "none" }
  | { kind: "release_claim"; via: NonNullable<EventDataByKind["claim_released"]["via"]> }
  | { kind: "hand_to_human" }
  | { kind: "mark_failed"; reason: string };

export interface RunEndDecision {
  outcome: EndReason;
  timedOut: boolean;
  then: RunEndAction;
}

export interface RunEndInput {
  /** The run as it is now, or undefined if it's gone with its project. */
  run: Pick<RunRow, "status" | "left_via" | "shutting_down"> | undefined;
  ending: RunEnding;
  /** See `agentReported`. */
  reported: boolean;
  nodeExists: boolean;
}

export const LOST_RUN_REASON =
  "The agent's process died, or was stopped, when the AOP server went down without closing cleanly.";

/**
 * What a run's end means: the outcome to record and what happens to its node. Null when there's
 * nothing left to decide, because the run or its node has gone, or the run has already been closed.
 */
export function decideRunEnd({ run, ending, reported, nodeExists }: RunEndInput): RunEndDecision | null {
  if (!run || !nodeExists || run.status !== "running") return null;
  const decision = (outcome: EndReason, then: RunEndAction, timedOut = false): RunEndDecision => ({ outcome, timedOut, then });

  // The node moved on while the run was going, so whoever moved it has dealt with the claim.
  if (run.left_via !== null) return decision(reported ? "reported" : "stopped", { kind: "none" });

  // A clean shutdown began stopping it, so whether or not its process outlived the shutdown's wait,
  // it wasn't a crash, and the node goes back in the queue. A stop already under way says more.
  const shutdown = run.shutting_down === 1 && (ending.kind === "lost" || ending.stopReason === null);
  if (shutdown) return decision("shutdown", { kind: "release_claim", via: "shutdown" });

  if (ending.kind === "lost") return decision("failed", { kind: "mark_failed", reason: LOST_RUN_REASON });

  switch (ending.stopReason) {
    case "human":
      return decision("stopped", { kind: "hand_to_human" });
    case "held":
      return decision("held", { kind: "release_claim", via: "held" });
    case "shutdown":
      return decision("shutdown", { kind: "release_claim", via: "shutdown" });
    case "moved_on":
    case "project_deleted":
      return decision("stopped", { kind: "release_claim", via: "stop" });
    case "timeout":
      return decision(
        "failed",
        { kind: "mark_failed", reason: `The agent ran past agent_timeout_minutes (${ending.timeoutMinutes}).` },
        true,
      );
    case null: {
      const reason =
        ending.launchError !== null
          ? `The agent couldn't be launched: ${ending.launchError}`
          : `The agent exited without reporting an outcome (${ending.exitCode === null ? `signal ${ending.signal}` : `exit code ${ending.exitCode}`}).`;
      return decision("failed", { kind: "mark_failed", reason });
    }
  }
}

/**
 * Takes the node's claim and opens its run, together, so that nothing else can start on it. Refused,
 * with nothing written, if anything holds the claim already.
 */
export function beginRun(db: Db, node: NodeRow, id: string, logPath: string, format: OutputFormat = "text"): RunRow {
  db.transaction(() => {
    const claimed = db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ? AND claimed_by IS NULL").run(node.id);
    if (claimed.changes !== 1) throw refused(`Node ${node.id} is already claimed, so no run can start on it`);
    appendEvent(db, node.id, "system", "claim_taken", { holder: "agent", run_id: id });
    db.prepare(
      "INSERT INTO runs (id, created_at, node_id, stage, status, log_path, output_format) VALUES (?, ?, ?, ?, 'running', ?, ?)",
    ).run(id, now(), node.id, node.stage, logPath, format);
    appendEvent(db, node.id, "system", "run_started", { run_id: id, stage: node.stage });
  })();
  return getRun(db, id) as RunRow;
}

/**
 * Notes that a clean shutdown is stopping these runs, before it kills them, so that a run whose
 * process outlives the shutdown is put back in the queue by the next start, not failed.
 */
export function markShuttingDown(db: Db, runIds: string[]): void {
  const mark = db.prepare("UPDATE runs SET shutting_down = 1 WHERE id = ? AND status = 'running'");
  db.transaction(() => {
    for (const id of runIds) mark.run(id);
  })();
}

/** Call inside the transaction that decides what the run's end means for its node. */
export function closeRun(db: Db, run: RunRow, reason: EndReason, exitCode: number | null, timedOut = false): void {
  db.prepare("UPDATE runs SET status = 'exited', exit_code = ?, ended_at = ?, end_reason = ?, timed_out = ? WHERE id = ?").run(
    exitCode,
    now(),
    reason,
    reason === "failed" && timedOut ? 1 : 0,
    run.id,
  );
  appendEvent(db, run.node_id, "system", "run_ended", { run_id: run.id, reason, exit_code: exitCode });
}

/** Gives up an agent's claim, leaving the node where it is. */
export function releaseAgentClaim(
  db: Db,
  nodeId: string,
  via: NonNullable<EventDataByKind["claim_released"]["via"]>,
): void {
  const released = db.prepare("UPDATE nodes SET claimed_by = NULL WHERE id = ? AND claimed_by = 'agent'").run(nodeId);
  if (released.changes > 0) appendEvent(db, nodeId, "system", "claim_released", { holder: "agent", via });
}

/**
 * A run a human stopped hands them the node. The node stays on its stage and isn't queued, because
 * the human's claim holds it, until they release that claim to start the stage again.
 */
export function handClaimToHuman(db: Db, nodeId: string): void {
  releaseAgentClaim(db, nodeId, "stop");
  db.prepare("UPDATE nodes SET claimed_by = 'human' WHERE id = ? AND claimed_by IS NULL").run(nodeId);
  appendEvent(db, nodeId, "human", "claim_taken", { holder: "human", via: "stop" });
}

export function recordProcess(db: Db, run: Pick<RunRow, "id" | "node_id">, pid: number, command: string): void {
  db.prepare("INSERT INTO agent_processes (id, created_at, node_id, pid, command) VALUES (?, ?, ?, ?, ?)").run(
    run.id,
    now(),
    run.node_id,
    pid,
    command,
  );
  db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(pid, run.id);
}

export function listProcesses(db: Db): ProcessRow[] {
  return db.prepare("SELECT * FROM agent_processes ORDER BY rowid").all() as ProcessRow[];
}

/** Every log a project's runs wrote, for deleting along with the project. */
export function projectLogPaths(db: Db, projectId: string): string[] {
  const rows = db
    .prepare("SELECT log_path FROM runs WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)")
    .all(projectId) as Pick<RunRow, "log_path">[];
  return rows.map((row) => row.log_path);
}

export function forgetProcess(db: Db, id: string): void {
  db.prepare("DELETE FROM agent_processes WHERE id = ?").run(id);
}

/** Keeps a run's token usage up to date as its output arrives. */
export function recordUsage(db: Db, runId: string, usage: Usage): void {
  db.prepare("UPDATE runs SET context_tokens = ?, output_tokens = ? WHERE id = ?").run(usage.context, usage.output, runId);
}

/** How a run ended, in the words the node page uses. */
function endingOf(run: RunRow): RunView["ending"] {
  if (run.status === "running") return "running";
  switch (run.end_reason) {
    case "failed":
      return run.timed_out === 1 ? "timed_out" : "failed";
    case "stopped":
    case "held":
    case "shutdown":
      return "stopped";
    default:
      // Reported an outcome and left, or an older run from before AOP recorded how runs ended.
      return "exited";
  }
}

/** Every run on a node, newest first. */
export function listRuns(db: Db, nodeId: string): RunView[] {
  const rows = db.prepare("SELECT * FROM runs WHERE node_id = ? ORDER BY rowid DESC").all(nodeId) as RunRow[];
  return rows.map((run) => ({
    id: run.id,
    stage: run.stage,
    started_at: run.created_at,
    ended_at: run.ended_at,
    ending: endingOf(run),
    context_tokens: run.context_tokens,
    output_tokens: run.output_tokens,
  }));
}
