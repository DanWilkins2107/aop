import type { NodeView, StagesView, TypeView } from "../../../src/shared/api.js";
import { readableText } from "../lib/color.js";
import { humanize } from "../lib/format.js";
import { smoothPath } from "../lib/layout.js";
import { stageDrawing, type BoxKind } from "../lib/stageGraph.js";
import { MISSING_STAGE_COLOR, fillOf, stageColor } from "../lib/stageStyle.js";

const ARROW_ID = "pipeline-arrow";
const LINK_COLOR = "#868e96";
// Small graphs keep their natural size. Bigger ones shrink to fit, then scroll inside their own box.
const MIN_SCALE = 0.72;

function boxLook(kind: BoxKind, color: string) {
  switch (kind) {
    case "current":
      return { fill: fillOf(color), stroke: fillOf(color), strokeWidth: 1, text: readableText(fillOf(color)), weight: 700 };
    case "return":
      return { fill: "#ffffff", stroke: "#495057", strokeWidth: 2, text: "#1f2226", weight: 400 };
    case "exit":
      return { fill: "#f1f3f5", stroke: "#f1f3f5", strokeWidth: 1, text: "#667079", weight: 400 };
    case "stage":
      return { fill: "#ffffff", stroke: "#ced4da", strokeWidth: 1, text: "#1f2226", weight: 400 };
  }
}

/** A drawing of one type's stages from `stages.yaml`, with the node's own stage highlighted. */
export function PipelineGraph({
  node,
  type,
  stages,
  returnTo,
}: {
  node: NodeView;
  type: TypeView | undefined;
  stages: StagesView;
  /** Set when the node is on a global stage: the stage it goes back to. */
  returnTo: string | null;
}) {
  if (!type) return <p className="muted section-text">Type "{node.type}" isn't in stages.yaml, so there's no pipeline to draw.</p>;
  const drawing = stageDrawing(type, node.stage, returnTo);
  const color = node.stage_exists ? stageColor(node.stage, stages) : MISSING_STAGE_COLOR;
  const returnDrawn = drawing.boxes.some((box) => box.kind === "return");

  return (
    <div className="pipeline">
      <div className="pipeline-scroll">
        <svg
          viewBox={`0 0 ${drawing.width} ${drawing.height}`}
          role="img"
          aria-label={`Stages of type ${humanize(type.name)}`}
          style={{ width: "100%", maxWidth: drawing.width, minWidth: drawing.width * MIN_SCALE, display: "block" }}
        >
          <defs>
            <marker id={ARROW_ID} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 8 4 0 8z" fill={LINK_COLOR} />
            </marker>
          </defs>
          {drawing.links.map((link) => (
            <path key={link.id} d={smoothPath(link.points)} fill="none" stroke={LINK_COLOR} strokeWidth={1.25} markerEnd={`url(#${ARROW_ID})`} />
          ))}
          {drawing.boxes.map((box) => {
            const look = boxLook(box.kind, color);
            return (
              <g key={box.name} data-stage={box.name} data-box={box.kind}>
                <rect
                  x={box.x - box.width / 2}
                  y={box.y - box.height / 2}
                  width={box.width}
                  height={box.height}
                  rx={5}
                  fill={look.fill}
                  stroke={look.stroke}
                  strokeWidth={look.strokeWidth}
                />
                <text x={box.x} y={box.y} dy="0.35em" textAnchor="middle" fontSize={12} fontWeight={look.weight} fill={look.text}>
                  {box.label}
                </text>
              </g>
            );
          })}
          {drawing.links.map((link) =>
            link.labelAt ? (
              <text
                key={link.id}
                x={link.labelAt.x}
                y={link.labelAt.y}
                dy="0.35em"
                textAnchor="middle"
                fontSize={10.5}
                fill="#667079"
                stroke="#ffffff"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {link.label}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      {returnDrawn && returnTo ? <p className="muted hint">Outlined: {humanize(returnTo)}, where this node returns to.</p> : null}
    </div>
  );
}
