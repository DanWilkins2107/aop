import type { NodeView } from "../../../src/shared/api.js";

/** Who holds a claim: a dot and a name. Runs don't exist yet, so the name will become a run's ID. */
export function ClaimMark({ node }: { node: NodeView }) {
  if (node.claimed_by === null) return null;
  return (
    <span className="claim-mark" data-claimed-by={node.claimed_by} title={`Claimed by ${node.claimed_by}`}>
      <span className="claim-dot" />
      {node.claimed_by}
    </span>
  );
}
