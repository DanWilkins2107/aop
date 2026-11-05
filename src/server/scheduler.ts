import type { Cron } from "croner";
import type { ChangeFeed } from "./changes.js";
import { loadConfig } from "./config.js";
import { parseCron } from "./cron.js";
import type { Db } from "./db.js";
import { ConfigError } from "./errors.js";
import { createNode, getNodeRow, holdersOf, type NodeRow } from "./nodes.js";
import { appendEvent } from "./records.js";
import type { StageGraph } from "./stages.js";

/** Stages a previous child can be at for the next run to go ahead. */
const FINISHED_STAGES = ["done", "broken_down", "invalidated"];

/** The longest the scheduler sleeps, so a missed change can't leave a node unscheduled for long. */
const MAX_SLEEP_MS = 60_000;

export const RUN_EVENT = "scheduled_run";
export const SKIP_EVENT = "scheduled_run_skipped";

export interface SchedulerOptions {
  changes: ChangeFeed;
  /** Defaults to the system clock. Tests pass their own. */
  now?: () => Date;
  maxSleepMs?: number;
}

export type TickResult = { nodeId: string; dueAt: string } & (
  | { fired: true; childId: string }
  | { fired: false; reason: string }
);

/**
 * Fires `scheduled` nodes. A scheduled node never runs an agent: each time its cron comes due, it
 * gets a new `subtask` child with a copy of its description, placed where the stage's one `next`
 * outcome says. The last slot handled is kept in the node's events, so after a restart a node that
 * missed any slots fires once for the latest of them, not once for each.
 */
export class Scheduler {
  private readonly db: Db;
  private readonly changes: ChangeFeed;
  private readonly now: () => Date;
  private readonly maxSleepMs: number;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private ticking = false;

  constructor(db: Db, options: SchedulerOptions) {
    this.db = db;
    this.changes = options.changes;
    this.now = options.now ?? (() => new Date());
    this.maxSleepMs = options.maxSleepMs ?? MAX_SLEEP_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // A new or moved node may be due sooner than the current timer.
    this.unsubscribe = this.changes.subscribe(() => {
      if (!this.ticking) this.arm();
    });
    this.wake();
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private wake(): void {
    if (!this.running || !this.db.open) return;
    try {
      this.tick();
    } catch (error) {
      console.error(error);
    }
    this.arm();
  }

  /** Sleeps until the soonest due slot, or the longest sleep. */
  private arm(): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const now = this.now().getTime();
    let wait = this.maxSleepMs;
    if (this.db.open) {
      for (const node of this.scheduledNodes()) {
        const next = this.nextSlot(node, now);
        if (next !== null) wait = Math.min(wait, Math.max(0, next.getTime() - now));
      }
    }
    this.timer = setTimeout(() => this.wake(), wait);
    this.timer.unref();
  }

  /** Handles every node that's due now. Public so tests can drive it with their own clock. */
  tick(): TickResult[] {
    let graph: StageGraph;
    try {
      graph = loadConfig().graph;
    } catch (error) {
      // As with agents, an invalid stages.yaml means nothing new starts until it's fixed.
      if (error instanceof ConfigError) return [];
      throw error;
    }
    const now = this.now();
    const results: TickResult[] = [];
    this.ticking = true;
    try {
      for (const node of this.scheduledNodes()) {
        const due = this.lastDueSlot(node, now);
        if (due === null) continue;
        const result = this.db.transaction(() => this.handle(graph, node.id, due))();
        if (result !== null) results.push(result);
      }
    } finally {
      this.ticking = false;
    }
    if (results.length > 0) this.changes.notify();
    return results;
  }

  private scheduledNodes(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes WHERE stage = 'scheduled' ORDER BY rowid").all() as NodeRow[];
  }

  /**
   * The time from which slots count: the last slot handled, or when the node last arrived at
   * scheduled, whichever is later. Arriving again, such as on restore or a new cron, starts afresh.
   */
  private anchor(node: NodeRow): Date {
    const handled = this.db
      .prepare(
        `SELECT json_extract(data, '$.due_at') AS at FROM events
          WHERE node_id = ? AND kind IN ('${RUN_EVENT}', '${SKIP_EVENT}') ORDER BY rowid DESC LIMIT 1`,
      )
      .get(node.id) as { at: string } | undefined;
    const arrived = this.db
      .prepare(
        `SELECT created_at AS at FROM events
          WHERE node_id = ? AND ((kind = 'stage_changed' AND json_extract(data, '$.to_stage') = 'scheduled')
             OR (kind = 'node_created' AND json_extract(data, '$.stage') = 'scheduled'))
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(node.id) as { at: string } | undefined;
    const times = [handled?.at, arrived?.at, node.created_at].filter((t): t is string => typeof t === "string");
    return new Date(Math.max(...times.map((t) => new Date(t).getTime())));
  }

  /** The next slot after now. One already due is the tick's job, so a node that can't fire doesn't spin. */
  private nextSlot(node: NodeRow, now: number): Date | null {
    if (node.cron === null) return null;
    try {
      return parseCron(node.cron).nextRun(new Date(Math.max(now, this.anchor(node).getTime())));
    } catch {
      return null;
    }
  }

  /** The latest slot after the anchor that's at or before now, or null if none is due. */
  private lastDueSlot(node: NodeRow, now: Date): Date | null {
    if (node.cron === null) return null;
    let cron: Cron;
    try {
      cron = parseCron(node.cron);
    } catch {
      return null;
    }
    let due: Date | null = null;
    let slot = cron.nextRun(this.anchor(node));
    // Bounded, in case a server was off for a long time with a cron that fires every minute.
    for (let i = 0; slot !== null && slot.getTime() <= now.getTime() && i < 1_000_000; i++) {
      due = slot;
      slot = cron.nextRun(slot);
    }
    return due;
  }

  /** Fires the node for one slot, or logs why not. Runs in a transaction. */
  private handle(graph: StageGraph, nodeId: string, due: Date): TickResult | null {
    const node = getNodeRow(this.db, nodeId);
    if (node.stage !== "scheduled") return null;
    const dueAt = due.toISOString();
    const skip = (reason: string, detail: Record<string, unknown> = {}): TickResult => {
      appendEvent(this.db, node.id, "system", SKIP_EVENT, { due_at: dueAt, reason, ...detail });
      return { nodeId: node.id, dueAt, fired: false, reason };
    };

    const outcomes = graph.types.get(node.type)?.stages.get("scheduled");
    // The type no longer lists scheduled, so the node is flagged for a human and doesn't fire.
    if (outcomes === undefined) return null;

    const holders = holdersOf(this.db, node.id);
    if (holders.length > 0) return skip(holders[0]!.via, { holder_id: holders[0]!.id });

    const previous = this.db
      .prepare("SELECT id, stage FROM nodes WHERE spawned_by = ? ORDER BY rowid DESC LIMIT 1")
      .get(node.id) as { id: string; stage: string } | undefined;
    if (previous !== undefined && !FINISHED_STAGES.includes(previous.stage)) {
      return skip("previous_unfinished", { previous_child_id: previous.id });
    }

    const [target] = [...outcomes.values()];
    if (target === undefined) return null;
    // Validation makes the target a stage in this type, another type, done or broken_down.
    const enteredType = graph.types.get(node.type)?.stages.has(target) ? undefined : graph.types.get(target);
    const type = enteredType !== undefined ? target : node.type;
    const stage = enteredType !== undefined ? enteredType.start : target;

    let childId: string;
    try {
      childId = createNode(this.db, node.project_id, {
        type,
        stage,
        title: node.title,
        body: node.body,
        parent_id: node.id,
        actor: "system",
      }).id;
    } catch (error) {
      return skip("child_refused", { message: (error as Error).message });
    }
    this.db.prepare("UPDATE nodes SET spawned_by = ? WHERE id = ?").run(node.id, childId);
    appendEvent(this.db, node.id, "system", RUN_EVENT, { due_at: dueAt, child_id: childId });
    return { nodeId: node.id, dueAt, fired: true, childId };
  }
}
