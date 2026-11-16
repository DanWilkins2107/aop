import { isTest, withoutComments } from "./source.js";

/** Columns of one table that only `owner` may write. */
export interface ColumnOwner {
  table: string;
  columns: string[];
  owner: string;
}

/** Each `UPDATE <table> SET ...` and the columns it sets, up to its `WHERE` or the end of the string. */
const UPDATE = /\bUPDATE\s+(\w+)\s+SET\s+([^"'`]*?)(?=\bWHERE\b|["'`])/gi;

/**
 * The `UPDATE` statements in code, not tests, that set an owned column outside the file that owns it.
 * One owner per column keeps the rules about it, and the writes that keep them, in one place.
 */
export function columnOwnerProblems(sources: Record<string, string>, owners: ColumnOwner[]): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (isTest(file)) continue;
    for (const [, table, set] of withoutComments(text).matchAll(UPDATE)) {
      const columns = [...(set ?? "").matchAll(/(\w+)\s*=/g)].map(([, column]) => column);
      for (const { owner, columns: owned } of owners.filter((rule) => rule.table === table && rule.owner !== file)) {
        for (const column of columns.filter((name) => name !== undefined && owned.includes(name))) {
          problems.push(`${file}: sets ${table}.${column}, which only ${owner} writes: call a function there`);
        }
      }
    }
  }
  return problems;
}
