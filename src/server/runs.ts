// Reads and writes the `runs` and `agent_processes` tables. The orchestrator decides when.

import type { EventDataByKind, RunEndReason, RunView } from "../shared/api.js";
import type { OutputFormat, Usage } from "./agentOutput.js";
import type { Db } from "./db.js";
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

/** Takes the node's claim and opens its run, together, so that nothing else can start on it. */
export function beginRun(db: Db, node: NodeRow, id: string, logPath: string, format: OutputFormat = "text"): RunRow {
  db.transaction(() => {
    db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ?").run(node.id);
    appendEvent(db, node.id, "system", "claim_taken", { holder: "agent", run_id: id });
    db.prepare(
      "INSERT INTO runs (id, created_at, node_id, stage, status, log_path, output_format) VALUES (?, ?, ?, ?, 'running', ?, ?)",
    ).run(id, now(), node.id, node.stage, logPath, format);
    appendEvent(db, node.id, "system", "run_started", { run_id: id, stage: node.stage });
  })();
  return getRun(db, id) as RunRow;
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
