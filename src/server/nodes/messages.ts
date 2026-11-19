// A node's messages and links. `postMessage` is also how the stage actions that take text (ask,
// answer, fail, block) put it on the node, inside their own transaction.

import type { Db } from "../db/db.js";
import type { LinkRow, MessageRow } from "../../shared/nodes/types.js";
import { appendEvent, newId, now, type Actor } from "../db/records.js";
import { getNodeRow } from "./nodeCore.js";

export function postMessage(
  db: Db,
  nodeId: string,
  stage: string,
  author: Actor,
  body: string,
  branch: string | null = null,
): MessageRow {
  const message: MessageRow = { id: newId(), created_at: now(), node_id: nodeId, stage, author, body, branch };
  db.prepare(
    "INSERT INTO messages (id, created_at, node_id, stage, author, body, branch) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(message.id, message.created_at, nodeId, stage, author, body, branch);
  appendEvent(db, nodeId, author, "message_added", { message_id: message.id, stage, ...(branch === null ? {} : { branch }) });
  return message;
}

/** The branch a run works on this node, if it's a branch's run. A message it posts is tagged with it. */
function branchOfRun(db: Db, nodeId: string, runId: string | undefined): string | null {
  if (runId === undefined) return null;
  const run = db.prepare("SELECT branch FROM runs WHERE id = ? AND node_id = ?").get(runId, nodeId) as { branch: string | null } | undefined;
  return run?.branch ?? null;
}

export function addMessage(db: Db, nodeId: string, input: { author: Actor; body: string; runId?: string | undefined }): MessageRow {
  return db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    return postMessage(db, node.id, node.stage, input.author, input.body, branchOfRun(db, node.id, input.runId));
  })();
}

export function listMessages(db: Db, nodeId: string): MessageRow[] {
  getNodeRow(db, nodeId);
  return db.prepare("SELECT * FROM messages WHERE node_id = ? ORDER BY rowid").all(nodeId) as MessageRow[];
}

export function addLink(
  db: Db,
  nodeId: string,
  input: { kind: LinkRow["kind"]; url: string; actor: Actor },
): LinkRow {
  return db.transaction(() => {
    getNodeRow(db, nodeId);
    const link: LinkRow = { id: newId(), created_at: now(), node_id: nodeId, kind: input.kind, url: input.url };
    db.prepare("INSERT INTO links (id, created_at, node_id, kind, url) VALUES (?, ?, ?, ?, ?)").run(
      link.id,
      link.created_at,
      nodeId,
      link.kind,
      link.url,
    );
    appendEvent(db, nodeId, input.actor, "link_added", { link_id: link.id, kind: link.kind, url: link.url });
    return link;
  })();
}

export function listLinks(db: Db, nodeId: string): LinkRow[] {
  getNodeRow(db, nodeId);
  return db.prepare("SELECT * FROM links WHERE node_id = ? ORDER BY rowid").all(nodeId) as LinkRow[];
}
