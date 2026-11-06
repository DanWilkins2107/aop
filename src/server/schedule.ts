// A scheduled node's own schedule. The node page sets it as a time and days, stored as a cron the
// scheduler reads. A node with none stays at scheduled and doesn't fire.

import type { Db } from "./db.js";
import { refused } from "./errors.js";
import type { NodeView } from "../shared/api.js";
import { scheduleToCron, type Schedule } from "../shared/schedule.js";
import { currentGraphs, getNodeRow } from "./nodeCore.js";
import { viewOf } from "./nodeViews.js";
import { appendEvent } from "./records.js";

/**
 * Sets the schedule, or clears it with null. Only at scheduled. The scheduler counts slots from the
 * event this writes, so a new schedule fires from now on, without catching up on slots already past.
 */
export function setSchedule(db: Db, nodeId: string, schedule: Schedule | null): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.stage !== "scheduled") {
      throw refused(`Can't set a schedule: the node is at "${node.stage}", not scheduled`);
    }
    const cron = schedule === null ? null : scheduleToCron(schedule);
    db.prepare("UPDATE nodes SET cron = ? WHERE id = ?").run(cron, nodeId);
    appendEvent(db, nodeId, "human", "schedule_changed", { cron, previous: node.cron });
  })();
  return viewOf(db, graphs, nodeId);
}
