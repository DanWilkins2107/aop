// IDs, timestamps and the append-only `events` log, shared by every module that writes rows.

import { randomUUID } from "node:crypto";
import type { Actor } from "../shared/api.js";
import type { Db } from "./db.js";

export type { Actor };

export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();

/** Call inside the same transaction as the change the event describes. */
export function appendEvent(
  db: Db,
  nodeId: string,
  actor: Actor,
  kind: string,
  data: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT INTO events (id, created_at, node_id, actor, kind, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId(), now(), nodeId, actor, kind, JSON.stringify(data));
}
