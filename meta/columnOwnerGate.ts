import { isTest, withoutComments } from "./source.js";

/** Columns of one table that only `owner` may write. */
export interface ColumnOwner {
  table: string;
  columns: string[];
  owner: string;
}

/** Each `UPDATE <table> SET ...` and the columns it sets, up to its `WHERE` or the end of the string. */
const UPDATE = /\bUPDATE\s+(\w+)\s+SET\s+([^"'`]*?)(?=\bWHERE\b|["'`])/gi;

/** The owned columns one `UPDATE` in `file` sets, though `file` doesn't own them. */
function strayWrites(file: string, table: string, set: string, owners: ColumnOwner[]): string[] {
  const columns = [...set.matchAll(/(\w+)\s*=/g)].map(([, column]) => column ?? "");
  return owners
    .filter((rule) => rule.table === table && rule.owner !== file)
    .flatMap(({ owner, columns: owned }) =>
      columns
        .filter((column) => owned.includes(column))
        .map((column) => `${file}: sets ${table}.${column}, which only ${owner} writes: call a function there`),
    );
}

/**
 * The `UPDATE` statements in code, not tests, that set an owned column outside the file that owns it.
 * One owner per column keeps the rules about it, and the writes that keep them, in one place.
 */
export function columnOwnerProblems(sources: Record<string, string>, owners: ColumnOwner[]): string[] {
  return Object.entries(sources)
    .filter(([file]) => !isTest(file))
    .flatMap(([file, text]) =>
      [...withoutComments(text).matchAll(UPDATE)].flatMap(([, table, set]) => strayWrites(file, table ?? "", set ?? "", owners)),
    );
}
