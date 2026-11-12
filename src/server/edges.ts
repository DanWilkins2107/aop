// Edges between nodes: `subtask` from parent to child and `blocks` from blocker to blocked.

import type { Db } from "./db.js";
import { notFound, refused } from "./errors.js";
import type { EdgeRow } from "../shared/nodes/types.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import { getNodeRow } from "./nodeCore.js";

/** Whether `from` blocks `to`, directly or through other nodes. */
function blocksReach(db: Db, from: string, to: string): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE reached(id) AS (
         SELECT ?
         UNION
         SELECT e.target_id FROM edges e JOIN reached r ON e.source_id = r.id
          WHERE e.kind = 'blocks' AND e.removed_at IS NULL
       )
       SELECT 1 FROM reached WHERE id = ?`,
    )
    .get(from, to);
  return row !== undefined;
}

/** `source` is the parent of a `subtask` edge and the blocker of a `blocks` edge. */
export function addEdge(
  db: Db,
  sourceId: string,
  input: { target_id: string; kind: EdgeRow["kind"]; actor: Actor },
): EdgeRow {
  return db.transaction(() => {
    const source = getNodeRow(db, sourceId);
    const target = getNodeRow(db, input.target_id);
    if (input.kind === "blocks" && (source.stage === "broken_down" || target.stage === "broken_down")) {
      throw refused("Can't add a blocks edge to or from a broken_down node. Add it to the relevant child instead");
    }
    // A self edge reaches itself too, but the schema refuses that one with its own constraint.
    if (input.kind === "blocks" && sourceId !== input.target_id && blocksReach(db, input.target_id, sourceId)) {
      throw refused("Can't add this edge: it would create a blocks cycle");
    }
    const edge: EdgeRow = {
      id: newId(),
      created_at: now(),
      source_id: sourceId,
      target_id: input.target_id,
      kind: input.kind,
      removed_at: null,
    };
    db.prepare("INSERT INTO edges (id, created_at, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)").run(
      edge.id,
      edge.created_at,
      edge.source_id,
      edge.target_id,
      edge.kind,
    );
    appendEvent(db, sourceId, input.actor, "edge_added", {
      edge_id: edge.id,
      target_id: edge.target_id,
      kind: edge.kind,
    });
    return edge;
  })();
}

/** Every active edge in a project, for drawing its graph. */
export function listProjectEdges(db: Db, projectId: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT e.* FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE n.project_id = ? AND e.removed_at IS NULL ORDER BY e.rowid`,
    )
    .all(projectId) as EdgeRow[];
}

/** Edges touching the node in either direction. Removed ones appear only on request. */
export function listEdges(db: Db, nodeId: string, includeRemoved: boolean): EdgeRow[] {
  getNodeRow(db, nodeId);
  return db
    .prepare(
      `SELECT * FROM edges WHERE (source_id = @id OR target_id = @id)
        AND (@all = 1 OR removed_at IS NULL) ORDER BY rowid`,
    )
    .all({ id: nodeId, all: includeRemoved ? 1 : 0 }) as EdgeRow[];
}

export function removeEdge(db: Db, edgeId: string, actor: Actor): EdgeRow {
  return db.transaction(() => {
    const edge = db.prepare("SELECT * FROM edges WHERE id = ?").get(edgeId) as EdgeRow | undefined;
    if (!edge) throw notFound(`No edge ${edgeId}`);
    if (edge.removed_at !== null) throw refused("The edge is already removed");
    const removedAt = now();
    db.prepare("UPDATE edges SET removed_at = ? WHERE id = ?").run(removedAt, edgeId);
    appendEvent(db, edge.source_id, actor, "edge_removed", {
      edge_id: edge.id,
      target_id: edge.target_id,
      kind: edge.kind,
    });
    return { ...edge, removed_at: removedAt };
  })();
}
