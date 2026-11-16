import { expect, it } from "vitest";
import { type ColumnOwner, columnOwnerProblems } from "./columnOwnerGate.js";
import { repoSources } from "./repo.js";

const OWNERS: ColumnOwner[] = [
  // Who holds a node, and when an agent's turn on it ends, which the orchestrator reads off its runs.
  { table: "nodes", columns: ["claimed_by"], owner: "src/server/nodes/claims.ts" },
  { table: "runs", columns: ["left_via", "left_actor", "left_at"], owner: "src/server/nodes/claims.ts" },
  // Where a node is. Every stage change goes through `applyStageChange`.
  { table: "nodes", columns: ["stage", "type", "return_stage", "invalidation_reason"], owner: "src/server/nodes/stageMachine.ts" },
  // How a run ended, which decides what happens to its node.
  { table: "runs", columns: ["status", "exit_code", "ended_at", "end_reason", "timed_out"], owner: "src/server/runs/runs.ts" },
];

it("only a column's owner writes it", () => {
  const sources = repoSources("src");
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  expect(columnOwnerProblems(sources, OWNERS)).toEqual([]);
});
