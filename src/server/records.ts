// IDs, timestamps and the append-only `events` log, shared by every module that writes rows.

import { randomUUID } from "node:crypto";
import type { Actor, EventDataByKind, EventKind } from "../shared/api/types.js";
import type { Db } from "./db.js";

export type { Actor };

export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();

/** A kind and its data, paired so that one kind's data can't be written under another. */
type EventArgs = { [K in EventKind]: [kind: K, data: EventDataByKind[K]] }[EventKind];

/** Call inside the same transaction as the change the event describes. */
export function appendEvent(db: Db, nodeId: string, actor: Actor, ...[kind, data]: EventArgs): void {
  db.prepare(
    "INSERT INTO events (id, created_at, node_id, actor, kind, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId(), now(), nodeId, actor, kind, JSON.stringify(data));
}
