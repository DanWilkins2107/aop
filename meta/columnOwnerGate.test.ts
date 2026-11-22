import { describe, expect, it } from "vitest";
import { columnOwnerProblems } from "./columnOwnerGate.js";

const OWNERS = [{ table: "nodes", columns: ["claimed_by", "stage"], owner: "src/a/claims.ts" }];

describe("columnOwnerProblems", () => {
  it("accepts the owner's writes, other columns, other tables, tests and comments", () => {
    expect(
      columnOwnerProblems(
        {
          "src/a/claims.ts": 'db.prepare("UPDATE nodes SET claimed_by = ? WHERE id = ?");',
          "src/a/other.ts": 'db.prepare("UPDATE nodes SET title = ? WHERE id = ?");\ndb.prepare("UPDATE runs SET stage = ?");',
          "src/a/other.test.ts": 'db.prepare("UPDATE nodes SET claimed_by = NULL");',
          "src/a/note.ts": "// UPDATE nodes SET claimed_by = NULL WHERE id = ?",
        },
        OWNERS,
      ),
    ).toEqual([]);
  });

  it("rejects an owned column set anywhere else, on one line or several", () => {
    expect(
      columnOwnerProblems(
        {
          "src/a/runs.ts": "db.prepare(`UPDATE nodes\n  SET title = ?, stage = ?,\n  claimed_by = ?\n  WHERE id = ?`);",
          "src/b/x.ts": "db.prepare(\"UPDATE nodes SET claimed_by = 'agent'\");",
        },
        OWNERS,
      ),
    ).toEqual([
      "src/a/runs.ts: sets nodes.stage, which only src/a/claims.ts writes: call a function there",
      "src/a/runs.ts: sets nodes.claimed_by, which only src/a/claims.ts writes: call a function there",
      "src/b/x.ts: sets nodes.claimed_by, which only src/a/claims.ts writes: call a function there",
    ]);
  });
});
