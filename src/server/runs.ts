import type { Db } from "./db.js";
import type { NodeRow } from "./nodes.js";
import type { Identity } from "./processes.js";
import { appendEvent, now, type Actor } from "./records.js";

export type EndReason = "reported" | "failed" | "stopped" | "held" | "shutdown";

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
  return run.left_actor === "agent" && ["next", "ask", "split_finish"].includes(run.left_via ?? "");
}

/** Takes the node's claim and opens its run, together, so that nothing else can start on it. */
export function beginRun(db: Db, node: NodeRow, id: string, logPath: string): RunRow {
  db.transaction(() => {
    db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ?").run(node.id);
    appendEvent(db, node.id, "system", "claim_taken", { holder: "agent", run_id: id });
    db.prepare(
      "INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES (?, ?, ?, ?, 'running', ?)",
    ).run(id, now(), node.id, node.stage, logPath);
    appendEvent(db, node.id, "system", "run_started", { run_id: id, stage: node.stage });
  })();
  return getRun(db, id) as RunRow;
}

/** Call inside the transaction that decides what the run's end means for its node. */
export function closeRun(db: Db, run: RunRow, reason: EndReason, exitCode: number | null): void {
  db.prepare("UPDATE runs SET status = 'exited', exit_code = ?, ended_at = ?, end_reason = ? WHERE id = ?").run(
    exitCode,
    now(),
    reason,
    run.id,
  );
  appendEvent(db, run.node_id, "system", "run_ended", { run_id: run.id, reason, exit_code: exitCode });
}

/** Gives up an agent's claim, leaving the node where it is. */
export function releaseAgentClaim(db: Db, nodeId: string, via: string): void {
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

export function forgetProcess(db: Db, id: string): void {
  db.prepare("DELETE FROM agent_processes WHERE id = ?").run(id);
}
