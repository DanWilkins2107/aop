import type { NodeView } from "../../../src/shared/api.js";

/** Enough of a run's ID to tell it apart. `aop ps` shows the whole thing, which starts the same. */
export const shortRunId = (runId: string) => runId.slice(0, 8);

/**
 * What a claim shows: "human", or an agent's short run ID with the whole ID in the tooltip. An
 * agent's claim with no run, which a seeded or recovering node can have, falls back to "agent".
 */
export function claimLabel(node: Pick<NodeView, "claimed_by" | "run_id">): { text: string; title: string } | null {
  if (node.claimed_by === null) return null;
  const runId = node.claimed_by === "agent" ? node.run_id : null;
  if (runId) return { text: shortRunId(runId), title: `Claimed by agent run ${runId}` };
  return { text: node.claimed_by, title: `Claimed by ${node.claimed_by}` };
}

/** Who holds a claim: a green dot, and the human or the agent's run ID. Nothing when unclaimed. */
export function ClaimMark({ node }: { node: NodeView }) {
  const label = claimLabel(node);
  if (!label) return null;
  return (
    <span className="claim-mark" data-claimed-by={node.claimed_by} title={label.title}>
      <span className="claim-dot" />
      {label.text}
    </span>
  );
}
