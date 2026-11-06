// Everything a caller does with nodes, in one place, so `api.ts` can use it as `nodes.*`. The rules
// live in the modules re-exported here: `stageMachine.ts` (every stage change and stage action),
// `schedule.ts`, `claims.ts`, `messages.ts` (messages and links), `edges.ts`, `nodeViews.ts` (views and holders)
// and `nodeCore.ts` (what they share). Events are read here.

import type { Db } from "./db.js";
import type { EdgeRow, EventView, LinkRow, MessageRow, NodeRow, NodeView } from "../shared/api.js";
import { getNodeRow } from "./nodeCore.js";

export type { EdgeRow, EventView, LinkRow, MessageRow, NodeRow, NodeView };

export { getNodeRow, graphFor, graphsOf, RAISE_PR_STAGE, type Graphs } from "./nodeCore.js";
export { getNode, holdersOf, invalidatedAncestors, listNodes, startableNodes, viewsOf, type Holder } from "./nodeViews.js";
export {
  answer,
  ask,
  block,
  createNode,
  editNode,
  fail,
  invalidate,
  markFailed,
  move,
  next,
  restore,
  retry,
  splitFinish,
  splitStart,
  unblock,
} from "./stageMachine.js";
export { setSchedule } from "./schedule.js";
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
