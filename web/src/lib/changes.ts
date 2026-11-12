// The server's change notices, and which pages they concern. See `useLiveData` in `live.ts`.

import type { ChangeNotice } from "../../../src/shared/api/types.js";

export type { ChangeNotice };

/** Anything may have changed: what a notice that can't be read counts as. */
export const EVERYTHING: ChangeNotice = { project_ids: null, node_ids: null };

const ids = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;

/** A `change` event's data. Anything unexpected counts as everything, so a page never misses a change. */
export function readNotice(data: unknown): ChangeNotice {
  try {
    const parsed = (typeof data === "string" ? JSON.parse(data) : data) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== "object") return EVERYTHING;
    return { project_ids: ids(parsed["project_ids"]), node_ids: ids(parsed["node_ids"]) };
  } catch {
    return EVERYTHING;
  }
}

/** What two notices touched between them. */
export function mergeNotices(a: ChangeNotice, b: ChangeNotice): ChangeNotice {
  const union = (x: string[] | null, y: string[] | null) => (x === null || y === null ? null : [...new Set([...x, ...y])]);
  return { project_ids: union(a.project_ids, b.project_ids), node_ids: union(a.node_ids, b.node_ids) };
}

/** Whether a change may concern this project. */
export function touchesProject(notice: ChangeNotice, projectId: string): boolean {
  return notice.project_ids === null || notice.project_ids.includes(projectId);
}

/** Whether a change may concern this node's own messages, events, links or edges. */
export function touchesNode(notice: ChangeNotice, nodeId: string, projectId: string | null): boolean {
  if (notice.node_ids !== null) return notice.node_ids.includes(nodeId);
  return projectId === null || touchesProject(notice, projectId);
}
