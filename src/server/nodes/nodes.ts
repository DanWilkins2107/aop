// Everything a caller does with nodes, in one place, so `http/nodeRoutes.ts` can use it as `nodes.*`. The rules
// live in the modules re-exported here: `stageMachine.ts` (every stage change and stage action),
// `claims.ts`, `messages.ts` (messages and links), `edges.ts`, `nodeViews.ts` (views and holders)
// and `nodeCore.ts` (what they share). Events are read here.

import type { Db } from "../db/db.js";
import type { EventView } from "../../shared/events/types.js";
import type { MessageRow, NodeRow, NodeView } from "../../shared/nodes/types.js";
import { getNodeRow } from "./nodeCore.js";

export type { EventView, MessageRow, NodeRow, NodeView };

export { getNodeRow, graphFor, graphsOf, turnOf, type Graphs } from "./nodeCore.js";
export { getNode, holdersOf, listNodes, startableNodes, viewsOf } from "./nodeViews.js";
export {
  answer,
  ask,
  block,
  createNode,
  editNode,
  fail,
  invalidate,
  markFailed,
  markSavedLocally,
  move,
  next,
  restore,
  retry,
  splitFinish,
  splitStart,
  unblock,
} from "./stageMachine.js";
export { claim, releaseClaim } from "./claims.js";
export { addLink, addMessage, listLinks, listMessages } from "./messages.js";
export { addEdge, listEdges, listProjectEdges, removeEdge } from "./edges.js";

export function listEvents(db: Db, nodeId: string): EventView[] {
  getNodeRow(db, nodeId);
  const rows = db.prepare("SELECT * FROM events WHERE node_id = ? ORDER BY rowid").all(nodeId) as (Omit<
    EventView,
    "data"
  > & { data: string })[];
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
}
