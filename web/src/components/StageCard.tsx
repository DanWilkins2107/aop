import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Link } from "react-router-dom";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { CARD_HEIGHT, CARD_WIDTH } from "../lib/layout.js";
import { cardKind, cardLook, cardType, stageLabel } from "../lib/stageStyle.js";
import { ClaimMark } from "./ClaimMark.js";

export type StageCardNode = Node<{ node: NodeView; stages: StagesView | null }, "stage">;

export function StageCard({ data }: NodeProps<StageCardNode>) {
  const { node, stages } = data;
  const look = cardLook(node, stages);
  const kind = cardKind(node);
  return (
    <div className="card-node" data-stage={node.stage} data-kind={kind} style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}>
      <Handle type="target" position={Position.Top} className="card-handle" isConnectable={false} />
      <div
        className={`card-body card-${kind}`}
        style={{
          background: look.background,
          color: look.text,
          border: `1px ${kind === "invalidated" ? "dashed" : "solid"} ${look.border}`,
          ...(look.accent ? { borderLeft: `5px solid ${look.accent}` } : {}),
          opacity: look.opacity,
        }}
      >
        <div className={`card-title${look.struck ? " card-title-struck" : ""}`}>{node.title}</div>
        <div className="card-meta">
          <span className="card-stage">{stageLabel(node)}</span>
          <span className="card-detail">
            {cardType(node)}
            <ClaimMark node={node} />
          </span>
        </div>
      </div>
      {/* A real link, so that keyboard focus and open-in-new-tab work. */}
      <Link to={`/n/${node.id}`} className="card-link" draggable={false} aria-label={node.title} />
      <Handle type="source" position={Position.Bottom} className="card-handle" isConnectable={false} />
    </div>
  );
}
