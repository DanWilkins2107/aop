// A node's messages and links. `postMessage` is also how the stage actions that take text (ask,
// answer, fail, block) put it on the node, inside their own transaction.

import type { Db } from "./db.js";
import type { LinkRow, MessageRow } from "../shared/api.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import { getNodeRow } from "./nodeCore.js";

export function postMessage(db: Db, nodeId: string, stage: string, author: Actor, body: string): MessageRow {
  const message: MessageRow = { id: newId(), created_at: now(), node_id: nodeId, stage, author, body };
  db.prepare(
    "INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(message.id, message.created_at, nodeId, stage, author, body);
  appendEvent(db, nodeId, author, "message_added", { message_id: message.id, stage });
  return message;
}

export function addMessage(db: Db, nodeId: string, input: { author: Actor; body: string }): MessageRow {
  return db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    return postMessage(db, node.id, node.stage, input.author, input.body);
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
