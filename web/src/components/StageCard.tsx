import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Link } from "react-router-dom";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { humanize } from "../lib/format.js";
import { CARD_HEIGHT, CARD_WIDTH } from "../lib/layout.js";
import { cardLook } from "../lib/stageStyle.js";

export type StageCardNode = Node<{ node: NodeView; stages: StagesView | null }, "stage">;

/** One badge at most, in order of what a human most needs to know. */
function badgeFor(node: NodeView): { label: string; className: string } | null {
  if (!node.stage_exists) return { label: "STAGE GONE", className: "badge-danger" };
  if (node.invalidated_by_parent && node.stage !== "invalidated") {
    return { label: "INVALIDATED BY PARENT", className: "badge-invalidated-by-parent" };
  }
  if (node.blocked_by.length > 0) return { label: "BLOCKED", className: "badge-danger" };
  if (node.held) return { label: "HELD", className: "badge-held" };
  return null;
}

export function StageCard({ data }: NodeProps<StageCardNode>) {
  const { node, stages } = data;
  const look = cardLook(node, stages);
  const badge = badgeFor(node);
  return (
    <div className="card-node" data-stage={node.stage} style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}>
      <Handle type="target" position={Position.Top} className="card-handle" isConnectable={false} />
      {/* Fading only the body keeps the badge sharp on a card that has receded. */}
      <div
        className="card-body"
        style={{
          background: look.background,
          color: look.text,
          border: `2px solid ${look.border}`,
          borderLeft: look.accent ? `6px solid ${look.accent}` : `2px solid ${look.border}`,
          opacity: look.opacity,
        }}
      >
        <div className={`card-title${node.claimed_by ? " card-title-short" : ""}`}>{node.title}</div>
        {node.claimed_by ? (
          <div className="card-claim" data-claimed-by={node.claimed_by}>
            {node.claimed_by === "agent" ? "Agent run holds this" : "Claimed by a human"}
          </div>
        ) : null}
        <div className="card-meta">
          <span className="pill" style={{ background: look.pillBackground, color: look.pillText }}>
            {humanize(node.stage)}
          </span>
          <span className="card-type">{node.type}</span>
        </div>
      </div>
      {/* A real link, so that keyboard focus and open-in-new-tab work. */}
      <Link to={`/n/${node.id}`} className="card-link" draggable={false} aria-label={node.title} />
      {badge ? <span className={`badge card-badge ${badge.className}`}>{badge.label}</span> : null}
      <Handle type="source" position={Position.Bottom} className="card-handle" isConnectable={false} />
    </div>
  );
}
