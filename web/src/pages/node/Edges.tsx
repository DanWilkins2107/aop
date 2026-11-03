import { useState } from "react";
import { Link } from "react-router-dom";
import type { EdgeRow, NodeView } from "../../../../src/shared/api.js";
import { api, ApiFailure, failureText } from "../../lib/api.js";
import { humanize } from "../../lib/format.js";

/** An edge as seen from this node. `outgoing` means this node is its source. */
const RELATIONS = [
  { value: "parent", label: "Parent of", kind: "subtask", outgoing: true },
  { value: "child", label: "Child of", kind: "subtask", outgoing: false },
  { value: "blocks", label: "Blocks", kind: "blocks", outgoing: true },
  { value: "blocked", label: "Blocked by", kind: "blocks", outgoing: false },
] as const;

function relationOf(edge: EdgeRow, nodeId: string) {
  const outgoing = edge.source_id === nodeId;
  return RELATIONS.find((r) => r.kind === edge.kind && r.outgoing === outgoing);
}

export function Edges({
  node,
  edges,
  nodes,
  reload,
}: {
  node: NodeView;
  edges: EdgeRow[];
  nodes: NodeView[];
  reload: () => Promise<void>;
}) {
  const [relation, setRelation] = useState<(typeof RELATIONS)[number]["value"]>("parent");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const candidates = nodes.filter((n) => n.id !== node.id);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setOther("");
      await reload();
    } catch (failure) {
      const duplicate = failure instanceof ApiFailure && failure.code === "constraint_violation";
      setError(duplicate ? "Those two nodes already have that edge." : failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const chosen = RELATIONS.find((r) => r.value === relation);
    if (!chosen || other === "") return;
    const [source, target] = chosen.outgoing ? [node.id, other] : [other, node.id];
    void act(() => api.addEdge(source, target, chosen.kind));
  }

  return (
    <>
      {edges.length === 0 ? <p className="muted section-text">No edges yet.</p> : null}
      <ul className="edge-list">
        {edges.map((edge) => {
          const otherId = edge.source_id === node.id ? edge.target_id : edge.source_id;
          const otherNode = byId.get(otherId);
          return (
            <li key={edge.id} className="edge-row">
              <span className="edge-kind">{relationOf(edge, node.id)?.label}</span>
              <span className="edge-node">
                <Link to={`/n/${otherId}`}>{otherNode?.title ?? otherId}</Link>
                {otherNode ? <span className="muted">{humanize(otherNode.stage)}</span> : null}
              </span>
              <button
                type="button"
                className="btn-icon"
                aria-label={`Remove edge to ${otherNode?.title ?? otherId}`}
                title="Remove edge"
                disabled={busy}
                onClick={() => void act(() => api.removeEdge(edge.id))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <select value={relation} onChange={(e) => setRelation(e.target.value as typeof relation)} aria-label="Edge relation">
          {RELATIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Other node">
          <option value="">Choose a node…</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || other === ""}>
          Add
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}
