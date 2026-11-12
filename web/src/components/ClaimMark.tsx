import type { NodeView } from "../../../src/shared/nodes/types.js";
import { claimLabel } from "../lib/format.js";

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
