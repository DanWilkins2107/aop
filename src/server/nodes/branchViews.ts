// A node's sub-workflow state as the node page shows it: each branch, where it is, and its rounds.

import type { Db } from "../db/db.js";
import type { BranchView } from "../../shared/nodes/types.js";
import { listBranches } from "./branches.js";
import { currentGraphs, getNodeRow, graphFor } from "./nodeCore.js";

/** The node's branches, parents before children. Empty unless the node is at a stage that runs them. */
export function listBranchViews(db: Db, nodeId: string): BranchView[] {
  const node = getNodeRow(db, nodeId);
  const graph = graphFor(currentGraphs(), node);
  const rows = listBranches(db, node.id);
  const paths = new Map(rows.map((row) => [row.id, row.path]));
  const running = new Set(
    (db.prepare("SELECT branch_id FROM runs WHERE node_id = ? AND status = 'running' AND branch_id IS NOT NULL").all(node.id) as {
      branch_id: string;
    }[]).map((run) => run.branch_id),
  );
  return rows.map((row) => {
    const maxLoops = row.type === null ? undefined : graph.types.get(row.type)?.maxLoops;
    const loops = Object.entries(JSON.parse(row.loops) as Record<string, number>).map(([stage, entered]) => ({
      stage,
      entered,
      max: maxLoops?.get(stage) ?? null,
    }));
    return {
      path: row.path,
      parent: row.parent_id === null ? null : (paths.get(row.parent_id) ?? null),
      kind: row.kind,
      type: row.type,
      stage: row.stage,
      outcome: row.outcome,
      running: running.has(row.id),
      loops,
    };
  });
}
