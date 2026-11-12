// Decides which agents run and what each run's end means for its node. OS-level process handling is
// in `osProcesses.ts`, and the `runs` and `agent_processes` rows in `runs.ts`.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentProcessView, ReapResult } from "../shared/api/types.js";
import { headlessCommand, StreamJsonUsage, type OutputFormat } from "./agentOutput.js";
import { type ChangeFeed, nodesNotice } from "./changes.js";
import { type AopConfig, loadConfig, withConfigSnapshot } from "./config.js";
import { buildPrompt } from "./context.js";
import type { Db } from "./db.js";
import { ConfigError, refused } from "./errors.js";
import { isFolder } from "./fsUtil.js";
import { getNodeRow, graphsOf, holdersOf, markFailed, startableNodes, type NodeRow, type NodeView, getNode } from "./nodes.js";
import {
  type Identity,
  killConfirmed,
  killLeftovers,
  killTree,
  prepareSweeps,
  readChildStarts,
  readProcessStarts,
  RUN_MARKER,
  sweepRuns,
  waitGone,
} from "./osProcesses.js";
import { nodeStartPath } from "./projects.js";
import { newId } from "./records.js";
import { appendToLog, logPathFor, openLog } from "./runLog.js";
import {
  agentReported,
  beginRun,
  closeRun,
  decideRunEnd,
  forgetProcess,
  getRun,
  handClaimToHuman,
  identitiesOf,
  listProcesses,
  markShuttingDown,
  recordProcess,
  recordUsage,
  releaseAgentClaim,
  runningRuns,
  type ProcessRow,
  type RunEnding,
  type RunRow,
  type StopReason,
} from "./runs.js";

/** How long an agent that called the `next`, `ask` or `split_finish` tool gets to exit before it's stopped. */
const DEFAULT_GRACE_MS = 15_000;
const RECONCILE_INTERVAL_MS = 5_000;
const REAP_INTERVAL_MS = 30_000;
/** Bounds waits on a process that should already be dying. */
const STOP_WAIT_MS = 10_000;
/** How long after exit to keep reading output that a leftover child might be holding open. */
const OUTPUT_DRAIN_MS = 1_000;
/** The longest a Node timer can wait. Anything above it fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long to look for what the launched shell started, and how often. */
const CHILD_LOOKUP_MS = 10_000;
const CHILD_LOOKUP_GAP_MS = 300;

/** A run this server launched and whose process hasn't yet been seen to exit. */
interface ActiveRun {
  id: string;
  nodeId: string;
  /** Kept here because the node can be deleted, with its project, before its process exits. */
  projectId: string;
  pid: number | undefined;
  /** Null until read. See `readProcessStarts`. */
  processStart: string | null;
  children: Identity[];
  timeoutMinutes: number;
  stopReason: StopReason | null;
  timeout: NodeJS.Timeout;
  grace: NodeJS.Timeout | null;
  /** Resolves when the process is gone and its log is closed. */
  exited: Promise<void>;
}

export interface OrchestratorOptions {
  changes: ChangeFeed;
  graceMs?: number;
  reconcileIntervalMs?: number;
  reapIntervalMs?: number;
}

/**
 * Starts and stops agents. The database decides what should be running and `reconcile` makes that
 * true, whatever caused the change, so it runs after every write and on a timer. All its work up to
 * launching a process is synchronous, so a node can't be started twice.
 */
export class Orchestrator {
  private readonly db: Db;
  private readonly changes: ChangeFeed;
  private readonly graceMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly reapIntervalMs: number;
  private readonly active = new Map<string, ActiveRun>();
  /** Projects being deleted, which get no new agents. */
  private readonly closingProjects = new Set<string>();
  /** Clear-ups that outlive their run, which shutdown has to wait for. */
  private readonly background = new Set<Promise<unknown>>();
  private mcpUrl = "";
  private running = false;
  /** Set for good by `shutdown`, which can come while `start` is still waiting on its first sweep. */
  private shutDown = false;
  private kicked = false;
  private reaping: Promise<ReapResult> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(db: Db, options: OrchestratorOptions) {
    this.db = db;
    this.changes = options.changes;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.reapIntervalMs = options.reapIntervalMs ?? REAP_INTERVAL_MS;
  }

  /**
   * Deals with whatever a previous server left behind, then begins starting agents. Before this, no
   * run is active, so every process on record and every `running` row is left over from a crash.
   * `mcpUrl` goes to agents as `AOP_MCP_URL`.
   */
  async start(mcpUrl: string): Promise<void> {
    this.mcpUrl = mcpUrl;
    prepareSweeps();
    await this.reap();
    // Shut down while the sweep above ran, such as Ctrl+C during a slow startup: start nothing.
    if (this.shutDown) return;
    this.releaseStrandedClaims();
    this.running = true;
    this.unsubscribe = this.changes.subscribeBursts(() => this.kick());
    this.timers = [
      setInterval(() => this.kick(), this.reconcileIntervalMs),
      setInterval(() => void this.reap().catch(logFailure), this.reapIntervalMs),
    ];
    for (const timer of this.timers) timer.unref();
    this.changes.notify();
    this.kick();
  }

  /** Stops every agent and puts its node back in the queue for the next start. */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.running = false;
    this.unsubscribe?.();
    for (const timer of this.timers) clearInterval(timer);
    // Before anything is killed, and before this yields, so that a run whose process outlives the
    // wait below is put back in the queue by the next start rather than failed.
    if (this.db.open) markShuttingDown(this.db, [...this.active.keys()]);
    await this.reaping?.catch(logFailure);
    await Promise.all([...this.active.values()].map((run) => this.stop(run, "shutdown")));
    await Promise.all(this.background);
  }

  /** Asks for a reconcile soon, once the current request has finished. */
  kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    setImmediate(() => {
      this.kicked = false;
      if (!this.running || !this.db.open) return;
      try {
        withConfigSnapshot(() => {
          this.checkActiveRuns();
          this.startQueuedNodes();
        });
      } catch (error) {
        logFailure(error);
      }
    });
  }

  /** Stops anything that shouldn't carry on. The run's end is dealt with when its process exits. */
  private checkActiveRuns(): void {
    for (const active of this.active.values()) {
      if (active.stopReason !== null) continue;
      const run = getRun(this.db, active.id);
      if (!run) {
        void this.stop(active, "moved_on");
      } else if (run.left_via !== null) {
        if (!agentReported(run)) void this.stop(active, "moved_on");
        else this.startGracePeriod(active, run);
      } else if (holdersOf(this.db, active.nodeId).some((holder) => holder.via === "invalidated_parent")) {
        void this.stop(active, "held");
      }
    }
  }

  private startGracePeriod(active: ActiveRun, run: RunRow): void {
    if (active.grace !== null) return;
    const left = run.left_at === null ? Date.now() : new Date(run.left_at).getTime();
    const wait = Math.max(0, left + this.graceMs - Date.now());
    active.grace = setTimeout(() => void this.stop(active, "moved_on"), wait);
    active.grace.unref();
  }

  private startQueuedNodes(): void {
    let config: AopConfig;
    try {
      config = loadConfig();
    } catch (error) {
      // An invalid file means no new agents until it's fixed. The UI shows the problems.
      if (error instanceof ConfigError) return;
      throw error;
    }
    for (const node of startableNodes(this.db, graphsOf(config))) {
      if (!this.closingProjects.has(node.project_id)) this.launch(node, config);
    }
  }

  private launch(node: NodeRow, config: AopConfig): void {
    const id = newId();
    const { command, format } = headlessCommand(config.agent_session_command);
    let run: RunRow;
    try {
      run = beginRun(this.db, node, id, logPathFor(id), format);
    } catch (error) {
      // Nothing was written, so the node is as it was. Other launches carry on.
      logFailure(error);
      return;
    }

    // From here the run is open and holds the claim, so anything that goes wrong has to close it.
    let prompt: string;
    let child: ChildProcessWithoutNullStreams;
    try {
      const cwd = nodeStartPath(this.db, node, config);
      appendToLog(run.log_path, `[aop] run ${id} on node ${node.id}, stage ${node.stage}, at ${run.created_at}\n[aop] ${command}\n[aop] in ${cwd}\n`);
      if (!isFolder(cwd)) throw new Error(`The start folder doesn't exist: ${cwd}`);
      prompt = buildPrompt(this.db, config, node, id);
      // The command is the user's own string, so it may need a shell. Nothing from a node goes in
      // it: the node's context, with its ID and the run's, goes in on stdin.
      child = spawn(command, {
        shell: true,
        cwd,
        // The run's marker is inherited by everything the agent starts, so a crash at any moment,
        // even before anything below has been recorded, leaves its whole tree findable.
        // `AOP_MCP_URL` is read only by the fake agent in tests, where the MCP port is any free one.
        // Real agents reach MCP at the fixed port their own config names.
        env: { ...process.env, AOP_MCP_URL: this.mcpUrl, [RUN_MARKER]: id },
        stdio: "pipe",
        windowsHide: true,
        // Its own process group, so that it can be killed along with its children. On Windows the
        // hidden console does the same job for Ctrl+C, and `taskkill /T` finds the children.
        detached: process.platform !== "win32",
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.failBeforeLaunch(run, (error as Error).message);
      return;
    }
    this.track(run, node.project_id, child, command, prompt, config.agent_timeout_minutes, format);
    this.changes.notify(nodesNotice(this.db, node.id));
  }

  private failBeforeLaunch(run: RunRow, reason: string): void {
    try {
      appendToLog(run.log_path, `[aop] ${reason}\n`);
    } catch (error) {
      // The reason is posted to the node either way, and the log may be what failed.
      logFailure(error);
    }
    this.db.transaction(() => {
      closeRun(this.db, run, "failed", null);
      markFailed(this.db, getNodeRow(this.db, run.node_id), { reason, runId: run.id });
    })();
    this.changes.notify(nodesNotice(this.db, run.node_id));
  }

  private track(
    run: RunRow,
    projectId: string,
    child: ChildProcessWithoutNullStreams,
    command: string,
    prompt: string,
    timeoutMinutes: number,
    format: OutputFormat,
  ): void {
    const log = openLog(run.log_path);
    log.on("error", logFailure);
    // The log keeps the raw output. Reading the tail turns it into lines a person can follow.
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    if (format === "stream-json") this.readUsage(run.id, child);

    let finished = false;
    let markExited = () => {};
    const active: ActiveRun = {
      id: run.id,
      nodeId: run.node_id,
      projectId,
      pid: child.pid,
      processStart: null,
      children: [],
      timeoutMinutes,
      stopReason: null,
      grace: null,
      timeout: setTimeout(() => void this.stop(active, "timeout"), Math.min(timeoutMinutes * 60_000, MAX_TIMER_MS)),
      exited: new Promise((resolve) => (markExited = resolve)),
    };
    active.timeout.unref();
    this.active.set(run.id, active);

    const finish = (exitCode: number | null, signal: string | null, launchError: string | null) => {
      if (finished) return;
      finished = true;
      this.finish(active, exitCode, signal, launchError);
      if (active.pid !== undefined) {
        const start = active.processStart;
        const parents = [...(start === null ? [] : [{ pid: active.pid, start }]), ...active.children];
        // The record stays until this is done, so that a crash in the meantime leaves it for the reaper.
        this.inBackground(
          killLeftovers(active.id, active.pid, parents).finally(() => {
            if (this.db.open) forgetProcess(this.db, active.id);
          }),
        );
      }
      closeLogWhenDrained(child, log, `[aop] exited, code ${exitCode ?? signal ?? launchError}\n`).then(markExited, logFailure);
    };
    child.once("exit", (code, signal) => finish(code, signal, null));
    child.once("error", (error) => {
      // Reported for a failed kill too, which isn't the process ending.
      if (child.pid === undefined) finish(null, null, error.message);
      else logFailure(error);
    });

    // An agent that never reads stdin closes it, which is its own business.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    if (child.pid === undefined) return;
    recordProcess(this.db, run, child.pid, command);
    this.inBackground(this.recordIdentity(active, child.pid));
  }

  /**
   * Records context consumed as Claude Code reports it, so a running run shows it too. It doesn't
   * notify the change feed: the node page polls a running run, and the run's end notifies anyway.
   */
  private readUsage(runId: string, child: ChildProcessWithoutNullStreams): void {
    const usage = new StreamJsonUsage();
    const save = () => {
      try {
        if (this.db.open) recordUsage(this.db, runId, usage.usage);
      } catch (error) {
        logFailure(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (usage.write(chunk)) save();
    });
    child.stdout.once("end", () => {
      if (usage.end()) save();
    });
  }

  /**
   * Notes who the process is, while it can still be asked, so that it can be found again after a
   * crash. That means its children too, because the launched shell can die with the server and leave
   * the real agent running. This is the fallback where the run's marker can't be read (see
   * `sweepRuns`): it only knows what existed when it looked, which is a second or more after launch.
   */
  private async recordIdentity(active: ActiveRun, pid: number): Promise<void> {
    const start = (await readProcessStarts([pid])).get(pid);
    if (start === undefined || !this.db.open) return;
    active.processStart = start;
    this.db.prepare("UPDATE agent_processes SET process_start = ? WHERE id = ?").run(start, active.id);

    const deadline = Date.now() + CHILD_LOOKUP_MS;
    while (Date.now() < deadline && this.active.has(active.id)) {
      active.children = await readChildStarts(pid);
      if (active.children.length > 0) {
        if (this.db.open) {
          this.db.prepare("UPDATE agent_processes SET children = ? WHERE id = ?").run(JSON.stringify(active.children), active.id);
        }
        return;
      }
      await delay(CHILD_LOOKUP_GAP_MS);
    }
  }

  private inBackground(work: Promise<unknown>): void {
    const tracked = work.catch(logFailure).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** The process is gone. Decides what that means for the run and its node. */
  private finish(active: ActiveRun, exitCode: number | null, signal: string | null, launchError: string | null): void {
    clearTimeout(active.timeout);
    if (active.grace !== null) clearTimeout(active.grace);
    this.active.delete(active.id);
    if (!this.db.open) return;

    this.db.transaction(() => {
      // Without a process ID nothing ran, so there's nothing left to clear up.
      if (active.pid === undefined) forgetProcess(this.db, active.id);
      this.endRun(getRun(this.db, active.id), exitCode, {
        kind: "exited",
        stopReason: active.stopReason,
        exitCode,
        signal,
        launchError,
        timeoutMinutes: active.timeoutMinutes,
      });
    })();
    this.changes.notify(nodesNotice(this.db, active.nodeId));
  }

  /** Records a run's end as `decideRunEnd` says. Call inside a transaction. */
  private endRun(run: RunRow | undefined, exitCode: number | null, ending: RunEnding): void {
    const nodeExists = run !== undefined && this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(run.node_id) !== undefined;
    const decision = decideRunEnd({ run, ending, reported: run !== undefined && agentReported(run), nodeExists });
    if (!run || !decision) return;
    closeRun(this.db, run, decision.outcome, exitCode, decision.timedOut);
    const then = decision.then;
    switch (then.kind) {
      case "none":
        return;
      case "release_claim":
        releaseAgentClaim(this.db, run.node_id, then.via);
        return;
      case "hand_to_human":
        handClaimToHuman(this.db, run.node_id);
        return;
      case "mark_failed":
        markFailed(this.db, getNodeRow(this.db, run.node_id), { reason: then.reason, runId: run.id });
    }
  }

  /**
   * Stops a run's process. Safe without an identity check: until this server sees it exit, the child's
   * handle stays open, so the operating system can't have given its ID to anything else.
   */
  private stop(active: ActiveRun, reason: StopReason): Promise<void> {
    if (active.stopReason === null) {
      active.stopReason = reason;
      if (active.pid !== undefined) this.inBackground(killTree(active.pid));
    }
    return boundedWait(active.exited);
  }

  /** A human stopping a run. Not a failure, and the node waits for the human: see `handClaimToHuman`. */
  async stopRun(runId: string): Promise<NodeView> {
    const active = this.active.get(runId);
    if (!active) throw refused(`Run ${runId} isn't running`);
    await this.stop(active, "human");
    return getNode(this.db, active.nodeId);
  }

  /**
   * Stops a project's agents ahead of its deletion, and keeps new ones from starting until the
   * returned function is called. Call it when the deletion has finished, or failed.
   */
  async stopProjectAgents(projectId: string): Promise<() => void> {
    this.closingProjects.add(projectId);
    // Not from the node: one whose project was deleted while it outlived the wait has none.
    const inProject = [...this.active.values()].filter((run) => run.projectId === projectId);
    await Promise.all(inProject.map((run) => this.stop(run, "project_deleted")));
    return () => {
      this.closingProjects.delete(projectId);
      this.kick();
    };
  }

  /** Why a process shouldn't exist, or null if it should. */
  private whyCondemned(process: ProcessRow): string | null {
    return this.condemnation(process)?.why ?? null;
  }

  /** Why a process shouldn't exist, and what stopping its run counts as, or null if it should exist. */
  private condemnation(process: ProcessRow): { why: string; stop: StopReason } | null {
    const run = getRun(this.db, process.id);
    if (!run) return { why: "it has no run: its node was deleted", stop: "moved_on" };
    if (run.status !== "running") return { why: "its run has ended", stop: "moved_on" };
    if (!this.active.has(run.id)) return { why: "this server didn't start it", stop: "moved_on" };
    if (run.left_at !== null && Date.now() - new Date(run.left_at).getTime() >= this.graceMs) {
      return { why: "its node moved on", stop: "moved_on" };
    }
    if (holdersOf(this.db, run.node_id).some((holder) => holder.via === "invalidated_parent")) {
      // Held, not stopped: restoring the parent lets the node carry on.
      return { why: "its node is invalidated by a parent", stop: "held" };
    }
    return null;
  }

  /** `aop ps`: every process AOP started that's still alive. */
  async listAgents(): Promise<AgentProcessView[]> {
    const rows = listProcesses(this.db);
    const starts = await this.startsOf(rows);
    const views: AgentProcessView[] = [];
    for (const row of rows) {
      const confirmed = identitiesOf(row).some(({ pid, start }) => starts.get(pid) === start);
      const unverified = row.process_start === null && starts.has(row.pid);
      // Gone, or something else now has its ID. Either way it isn't an agent.
      if (!confirmed && !unverified) continue;
      const run = getRun(this.db, row.id);
      const node = this.db.prepare("SELECT title, stage FROM nodes WHERE id = ?").get(row.node_id) as
        | Pick<NodeRow, "title" | "stage">
        | undefined;
      views.push({
        run_id: row.id,
        pid: row.pid,
        node_id: row.node_id,
        node_title: node?.title ?? null,
        stage: node?.stage ?? null,
        status: this.whyCondemned(row) !== null ? "orphaned" : run?.left_via ? "exiting" : "running",
        identity: row.process_start === null ? "unverified" : "confirmed",
        started_at: row.created_at,
        command: row.command,
      });
    }
    return views;
  }

  /**
   * `aop reap`, and the same check on startup and on a timer: kills any process that shouldn't exist,
   * then closes any `running` row with no process behind it.
   */
  reap(): Promise<ReapResult> {
    this.reaping ??= this.reapOnce().finally(() => {
      this.reaping = null;
    });
    return this.reaping;
  }

  private async reapOnce(): Promise<ReapResult> {
    const result: ReapResult = { killed: [], skipped: [] };
    const rows = listProcesses(this.db);
    const starts = await this.startsOf(rows);
    // Every run on record that this server isn't tracking shouldn't have processes, so anything still
    // carrying its marker is killed straight away. That reaches what the record doesn't: a child
    // started after it was written, or a crash before the start times were read.
    const lost = rows.filter((row) => !this.active.has(row.id)).map((row) => row.id);
    // A crash between opening a run and recording its process leaves a `running` row with no process
    // on record, but whatever was launched still carries the run's marker.
    const recorded = new Set(rows.map((row) => row.id));
    const unrecorded = runningRuns(this.db)
      .filter((run) => !this.active.has(run.id) && !recorded.has(run.id))
      .map((run) => run.id);
    const targets = [...lost, ...unrecorded];
    const swept = targets.length === 0 ? [] : ((await sweepRuns(targets, true)) ?? []);
    for (const found of swept) {
      if (unrecorded.includes(found.runId)) {
        result.killed.push({ run_id: found.runId, pid: found.pid, reason: "AOP never recorded its process" });
      }
    }

    for (const row of rows) {
      if (!this.db.open) return result;
      const active = this.active.get(row.id);
      if (active) {
        // Its open handle vouches for it, so it only needs to be one that shouldn't be running.
        const condemned = this.condemnation(row);
        if (condemned !== null) {
          result.killed.push({ run_id: row.id, pid: row.pid, reason: condemned.why });
          await this.stop(active, condemned.stop);
        }
        continue;
      }
      const marked = swept.filter((found) => found.runId === row.id).map(({ pid }) => pid);
      await this.reapLost(row, starts, marked, result);
    }

    if (this.db.open) this.closeDeadRuns();
    return result;
  }

  /**
   * Deals with a recorded process this server isn't tracking. The sweep has already killed whatever
   * carried its run's marker, so this kills what's left that its record confirms, waits for all of it
   * to go, and only then forgets the record.
   */
  private async reapLost(row: ProcessRow, starts: Map<number, string>, marked: number[], result: ReapResult): Promise<void> {
    const confirmed = identitiesOf(row).filter(({ pid, start }) => starts.get(pid) === start && !marked.includes(pid));
    if (marked.length === 0 && confirmed.length === 0) {
      if (row.process_start === null && starts.has(row.pid)) {
        // It stays on record until it's gone, because nothing can show it's safe to kill.
        result.skipped.push({ run_id: row.id, pid: row.pid, reason: "AOP never recorded its start time" });
        return;
      }
      if (starts.has(row.pid)) {
        result.skipped.push({ run_id: row.id, pid: row.pid, reason: "its process ID now belongs to another process" });
      }
      forgetProcess(this.db, row.id);
      return;
    }

    // The launched shell's ID where it's among them, which is the one on record.
    const pid = marked.length === 0 || marked.includes(row.pid) ? row.pid : (marked[0] as number);
    result.killed.push({ run_id: row.id, pid, reason: this.whyCondemned(row) ?? "this server didn't start it" });
    if (confirmed.length > 0) await killConfirmed(row.pid, confirmed);
    const gone = await Promise.all([...marked, ...confirmed.map(({ pid }) => pid)].map((pid) => waitGone(pid, STOP_WAIT_MS)));
    if (gone.every(Boolean) && this.db.open) forgetProcess(this.db, row.id);
  }

  /** Reads every process on record, the launched shells and what they started. */
  private startsOf(rows: ProcessRow[]): Promise<Map<number, string>> {
    return readProcessStarts(rows.flatMap((row) => [row.pid, ...identitiesOf(row).map(({ pid }) => pid)]));
  }

  /** A `running` row this server isn't tracking has no process any more, so its run is over. */
  private closeDeadRuns(): void {
    let closed = false;
    for (const run of runningRuns(this.db)) {
      if (this.active.has(run.id)) continue;
      closed = true;
      this.db.transaction(() => this.endRun(getRun(this.db, run.id), null, { kind: "lost" }))();
    }
    if (closed) this.changes.notify();
  }

  /** An agent's claim with no run behind it, left by a crash at the wrong moment, would hold a node forever. */
  private releaseStrandedClaims(): void {
    const stranded = this.db
      .prepare(
        `SELECT id FROM nodes n WHERE claimed_by = 'agent'
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id AND r.status = 'running')`,
      )
      .all() as { id: string }[];
    for (const { id } of stranded) {
      this.db.transaction(() => releaseAgentClaim(this.db, id, "restart"))();
    }
  }
}

/** Resolves when the output has ended, or soon after exit if a leftover child is holding it open. */
function closeLogWhenDrained(child: ChildProcessWithoutNullStreams, log: WriteStream, lastLine: string): Promise<void> {
  return new Promise((done) => {
    const close = () => {
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      log.end(lastLine, () => done());
    };
    const drain = setTimeout(close, OUTPUT_DRAIN_MS);
    child.once("close", close);
  });
}

async function boundedWait(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<void>((done) => {
    timer = setTimeout(done, STOP_WAIT_MS);
  });
  await Promise.race([work, expiry]);
  clearTimeout(timer);
}

function logFailure(error: unknown): void {
  console.error(error);
}
