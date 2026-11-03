import type { SearchResult } from "../shared/api.js";
import type { Db } from "./db.js";

const RESULT_LIMIT = 50;

/**
 * Turns what a user typed into an FTS5 query. Each word becomes a quoted phrase, so that nothing in
 * it can be read as query syntax, and the words must all match. Returns null if no word has anything
 * searchable in it, since FTS5 sees only separators there.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .replaceAll("\0", " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length === 0 ? null : words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
}

const queryOf = (table: string, join: string) => `
  SELECT n.id AS node_id, n.project_id, n.title, n.type, n.stage,
         snippet(${table}, -1, '[', ']', '...', 16) AS snippet, ${table}.rank AS score
    FROM ${table} ${join}
   WHERE ${table} MATCH @query AND (@project IS NULL OR n.project_id = @project)
   ORDER BY ${table}.rank LIMIT ${RESULT_LIMIT}`;

const NODES = queryOf("nodes_fts", "JOIN nodes n ON n.rowid = nodes_fts.rowid");
const MESSAGES = queryOf(
  "messages_fts",
  "JOIN messages m ON m.rowid = messages_fts.rowid JOIN nodes n ON n.id = m.node_id",
);

/** Finds nodes by title, description, messages and invalidation reason, best match first, once each. */
export function search(db: Db, text: string, projectId: string | null): SearchResult[] {
  const query = ftsQuery(text);
  if (query === null) return [];

  const params = { query, project: projectId };
  const hits = [...db.prepare(NODES).all(params), ...db.prepare(MESSAGES).all(params)] as (SearchResult & { score: number })[];
  hits.sort((a, b) => a.score - b.score);

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const { score: _score, ...hit } of hits) {
    if (seen.has(hit.node_id)) continue;
    seen.add(hit.node_id);
    results.push(hit);
  }
  return results.slice(0, RESULT_LIMIT);
}
