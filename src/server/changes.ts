import type { ChangeNotice } from "../shared/api/types.js";
import type { Db } from "./db.js";

export type { ChangeNotice };

/** Anything may have changed: every page refetches. What a write that says nothing more counts as. */
export const EVERYTHING: ChangeNotice = { project_ids: null, node_ids: null };

/** How long a burst of writes is gathered into one notice for the burst listeners. */
export const BURST_MS = 40;

/** What two notices touched between them. */
export function mergeNotices(a: ChangeNotice, b: ChangeNotice): ChangeNotice {
  const union = (x: string[] | null, y: string[] | null) => (x === null || y === null ? null : [...new Set([...x, ...y])]);
  return { project_ids: union(a.project_ids, b.project_ids), node_ids: union(a.node_ids, b.node_ids) };
}

/** A change to these nodes, and so to their projects. If one has gone, so may anything else have. */
export function nodesNotice(db: Db, ...nodeIds: string[]): ChangeNotice {
  const ids = [...new Set(nodeIds)];
  const rows = db
    .prepare("SELECT project_id FROM nodes WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as { project_id: string }[];
  if (rows.length < ids.length) return EVERYTHING;
  return { project_ids: [...new Set(rows.map((row) => row.project_id))], node_ids: ids };
}

export interface ChangeFeedOptions {
  /** How long to gather a burst. Defaults to BURST_MS. */
  burstMs?: number;
}

/**
 * Tells listeners that data changed, and where. Plain listeners hear every notice as it happens.
 * Burst listeners, which are open pages and the orchestrator, hear a burst of writes once: the first
 * notice starts a short wait, and everything noticed during it goes out merged at its end.
 */
export class ChangeFeed {
  private readonly listeners = new Set<(notice: ChangeNotice) => void>();
  private readonly burstListeners = new Set<(notice: ChangeNotice) => void>();
  private readonly burstMs: number;
  private pending: ChangeNotice | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ChangeFeedOptions = {}) {
    this.burstMs = options.burstMs ?? BURST_MS;
  }

  /** Burst listeners: one per open event stream, plus the orchestrator. */
  get size(): number {
    return this.burstListeners.size;
  }

  subscribe(listener: (notice: ChangeNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeBursts(listener: (notice: ChangeNotice) => void): () => void {
    this.burstListeners.add(listener);
    return () => {
      this.burstListeners.delete(listener);
      if (this.burstListeners.size === 0) this.clearPending();
    };
  }

  notify(notice: ChangeNotice = EVERYTHING): void {
    for (const listener of this.listeners) listener(notice);
    if (this.burstListeners.size === 0) return;
    this.pending = this.pending === null ? notice : mergeNotices(this.pending, notice);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.burstMs);
    this.timer.unref();
  }

  private flush(): void {
    const notice = this.pending;
    this.clearPending();
    if (notice === null) return;
    for (const listener of this.burstListeners) listener(notice);
  }

  private clearPending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
