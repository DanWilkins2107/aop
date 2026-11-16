import { useState, type KeyboardEvent } from "react";
import type { NodeView } from "../../../src/shared/nodes/types.js";
import type { TypeView } from "../../../src/shared/stages/types.js";
import { humanize } from "../lib/format.js";
import { smoothPath } from "../lib/layout.js";
import { stageDrawing, type BoxKind, type StageBox, type StageGroup } from "../lib/stageGraph.js";

const ARROW_ID = "pipeline-arrow";
const LINK_COLOR = "#888888";
// Small graphs keep their natural size. Bigger ones shrink to fit, then scroll inside their own box.
const MIN_SCALE = 0.72;

/** Greys and black only: the stage colour belongs to the header's band. */
function boxLook(kind: BoxKind) {
  switch (kind) {
    case "current":
      return { fill: "#ffffff", stroke: "#000000", strokeWidth: 2.5, text: "#000000", weight: 700 };
    case "return":
      return { fill: "#ffffff", stroke: "#4d4d4d", strokeWidth: 1.5, text: "#1a1a1a", weight: 400 };
    case "exit":
      return { fill: "#f0f0f0", stroke: "#f0f0f0", strokeWidth: 1, text: "#666666", weight: 400 };
    case "stage":
      return { fill: "#ffffff", stroke: "#cccccc", strokeWidth: 1, text: "#1a1a1a", weight: 400 };
  }
}

/** Props that make an SVG group a button. */
function toggleProps(label: string, open: boolean, toggle: () => void) {
  return {
    className: "pipeline-toggle",
    role: "button",
    tabIndex: 0,
    "aria-expanded": open,
    "aria-label": label,
    onClick: toggle,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
  };
}

/** A `parallel:` group: its title, its branches stacked, and the gate bar under them. */
function GroupBox({ box, group }: { box: StageBox; group: StageGroup }) {
  const look = boxLook(box.kind);
  const top = box.y - box.height / 2;
  const { gate } = group;
  return (
    <>
      <rect x={box.x - box.width / 2} y={top} width={box.width} height={box.height} rx={5} fill={look.fill} stroke={look.stroke} strokeWidth={look.strokeWidth} />
      <text x={box.x} y={top + 11} dy="0.35em" textAnchor="middle" fontSize={12} fontWeight={look.weight} fill={look.text}>
        {box.label}
      </text>
      {group.branches.map((branch) => (
        <g key={branch.name} data-branch={branch.name}>
          <rect x={branch.x - branch.width / 2} y={branch.y - branch.height / 2} width={branch.width} height={branch.height} rx={4} fill="#ffffff" stroke="#cccccc" />
          <text x={branch.x} y={branch.y} dy="0.35em" textAnchor="middle" fontSize={11} fill="#1a1a1a">
            {branch.label}
          </text>
        </g>
      ))}
      <g data-gate>
        <rect x={gate.x - gate.width / 2} y={gate.y - gate.height / 2} width={gate.width} height={gate.height} rx={3} fill="#4d4d4d" />
        <text x={gate.x} y={gate.y} dy="0.35em" textAnchor="middle" fontSize={10} fill="#ffffff">
          {gate.label}
        </text>
      </g>
    </>
  );
}

/**
 * A drawing of one type's stages from `stages.yaml`, with the node's own stage highlighted. With no
 * node, as on the process page, it's the type alone with nothing highlighted. Given every type, a
 * `subflow:` stage opens on click to show the type it runs.
 */
export function PipelineGraph({
  node,
  type,
  types,
  returnTo = null,
}: {
  node?: Pick<NodeView, "type" | "stage">;
  type: TypeView | undefined;
  /** Every type, so that `subflow:` stages can be opened. */
  types?: TypeView[];
  /** Set when the node is on a global stage: the stage it goes back to. */
  returnTo?: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (!type) return <p className="muted section-text">Type "{node?.type}" isn't in stages.yaml, so there's no pipeline to draw.</p>;
  const drawing = stageDrawing(type, node?.stage ?? null, returnTo, { types, expanded });
  const returnDrawn = drawing.boxes.some((box) => box.kind === "return");
  const toggle = (name: string) => () =>
    setExpanded((open) => {
      if (!open.has(name)) return new Set([...open, name]);
      // Closing a sub-workflow closes everything opened inside it too.
      return new Set([...open].filter((shown) => shown !== name && !shown.startsWith(`${name}/`)));
    });

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
          {drawing.frames.map((frame) => (
            <g key={frame.name} data-frame={frame.name} {...toggleProps(`Close ${frame.label}`, true, toggle(frame.name))}>
              <rect
                x={frame.x - frame.width / 2}
                y={frame.y - frame.height / 2}
                width={frame.width}
                height={frame.height}
                rx={7}
                fill="#fafafa"
                stroke="#999999"
              />
              <text x={frame.x - frame.width / 2 + 8} y={frame.y - frame.height / 2 + 7} dy="0.35em" fontSize={10} fontWeight={700} fill="#4d4d4d">
                ▾ {frame.label}
              </text>
            </g>
          ))}
          {drawing.links.map((link) => (
            <path
              key={link.id}
              d={smoothPath(link.points)}
              fill="none"
              stroke={LINK_COLOR}
              strokeWidth={1.25}
              strokeDasharray={link.dashed ? "5 4" : undefined}
              markerEnd={`url(#${ARROW_ID})`}
            />
          ))}
          {drawing.boxes.map((box) => {
            const look = boxLook(box.kind);
            if (box.group) {
              return (
                <g key={box.name} data-stage={box.name} data-box={box.kind}>
                  <GroupBox box={box} group={box.group} />
                </g>
              );
            }
            const opens = box.subflow !== undefined;
            return (
              <g
                key={box.name}
                data-stage={box.name}
                data-box={box.kind}
                {...(opens ? toggleProps(`Open ${box.label}, which runs ${humanize(box.subflow ?? "")}`, false, toggle(box.name)) : {})}
              >
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
                  {opens ? `${box.label} ▸` : box.label}
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
                fill="#666666"
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
