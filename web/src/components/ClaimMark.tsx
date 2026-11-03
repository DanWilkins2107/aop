import type { NodeView } from "../../../src/shared/api.js";

/** Enough of a run's ID to tell it apart. `aop ps` shows the whole thing, which starts the same. */
export const shortRunId = (runId: string) => runId.slice(0, 8);

/** Who holds a claim: a dot, and the human or the agent's run ID. */
export function ClaimMark({ node }: { node: NodeView }) {
  if (node.claimed_by === null) return null;
  const runId = node.claimed_by === "agent" ? node.run_id : null;
  return (
    <span
      className="claim-mark"
      data-claimed-by={node.claimed_by}
      title={runId ? `Claimed by agent run ${runId}` : `Claimed by ${node.claimed_by}`}
    >
      <span className="claim-dot" />
      {runId ? shortRunId(runId) : node.claimed_by}
    </span>
  );
}
