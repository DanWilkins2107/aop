import { Handle, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import type { FocusEvent } from "react";
import { Link } from "react-router-dom";
import type { NodeView, StagesView } from "../../../src/shared/api/types.js";
import { CARD_HEIGHT, CARD_WIDTH } from "../lib/layout.js";
import { cardKind, cardLook, cardName, cardType, stageLabel } from "../lib/stageStyle.js";
import { ClaimMark } from "./ClaimMark.js";

export type StageCardNode = Node<
  { node: NodeView; stages: StagesView | null; onHide?: (nodeId: string) => void },
  "stage"
>;

/**
 * Brings a card into view when Tab reaches it off screen, without zooming or animating. A click
 * focuses without `:focus-visible`, so pointer users' view never moves.
 */
function usePanToFocused(x: number, y: number) {
  const { setCenter, getZoom } = useReactFlow();
  return (event: FocusEvent<HTMLElement>) => {
    const link = event.currentTarget;
    const canvas = link.closest(".react-flow")?.getBoundingClientRect();
    if (!canvas || !link.matches(":focus-visible")) return;
    const card = link.getBoundingClientRect();
    const inside = card.left >= canvas.left && card.right <= canvas.right && card.top >= canvas.top && card.bottom <= canvas.bottom;
    if (!inside) void setCenter(x + CARD_WIDTH / 2, y + CARD_HEIGHT / 2, { zoom: getZoom() });
  };
}

export function StageCard({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<StageCardNode>) {
  const { node, stages, onHide } = data;
  const look = cardLook(node, stages);
  const kind = cardKind(node);
  const panToFocused = usePanToFocused(positionAbsoluteX, positionAbsoluteY);
  return (
    <div className="card-node" data-stage={node.stage} data-kind={kind} style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}>
      <Handle type="target" position={Position.Top} className="card-handle" isConnectable={false} />
      <div
        className={`card-body card-${kind}`}
        style={{
          background: look.background,
          color: look.text,
          border: `${look.borderWidth}px ${kind === "invalidated" ? "dashed" : "solid"} ${look.border}`,
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
      <Link to={`/n/${node.id}`} className="card-link" draggable={false} aria-label={cardName(node)} onFocus={panToFocused} />
      {onHide ? (
        <button
          type="button"
          className="card-hide"
          style={{ background: look.background, color: look.text }}
          aria-label={`Hide "${node.title}" and its subtasks in the graph`}
          title="Hide this and its subtasks in the graph"
          onFocus={panToFocused}
          onClick={() => onHide(node.id)}
        >
          Hide
        </button>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="card-handle" isConnectable={false} />
    </div>
  );
}
