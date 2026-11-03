import { useState } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { humanize } from "../lib/format.js";
import { lookOf, stageColor, type CardKind } from "../lib/stageStyle.js";

const OPEN_KEY = "aop:legendOpen";
const ALWAYS_LISTED = ["ask_human_question", "failed", "done", "broken_down", "invalidated"];

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Only a convenience: the legend still works.
  }
}

function Swatch({ kind, color }: { kind: CardKind; color: string }) {
  const look = lookOf(kind, color);
  return (
    <span
      className="legend-swatch"
      style={{
        background: look.background,
        border: `1.5px solid ${look.border}`,
        borderLeft: look.accent ? `4px solid ${look.accent}` : `1.5px solid ${look.border}`,
        opacity: look.opacity,
      }}
    />
  );
}

function Row({ kind, stage, stages }: { kind: CardKind; stage: string; stages: StagesView }) {
  return (
    <div className="legend-row">
      <Swatch kind={kind} color={stageColor(stage, stages)} />
      <span>{humanize(stage)}</span>
    </div>
  );
}

export function Legend({ stages, nodes }: { stages: StagesView; nodes: NodeView[] }) {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    writeOpen(!open);
    setOpen(!open);
  };
  // Any other built-in appears once a node is on it, coloured by whose turn it is.
  const pool = new Set(stages.stages.map((s) => s.name));
  const extras = [
    ...new Map(
      nodes
        .filter((n) => n.stage_exists && !pool.has(n.stage) && !ALWAYS_LISTED.includes(n.stage))
        .map((n) => [n.stage, n.turn] as const),
    ),
  ];
  return (
    <div className="legend">
      <button type="button" className="legend-toggle" onClick={toggle} aria-expanded={open}>
        Legend <span className="muted">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="legend-body">
          <div className="legend-heading">Your turn</div>
          {stages.stages
            .filter((s) => s.turn === "human")
            .map((s) => (
              <Row key={s.name} kind="bright" stage={s.name} stages={stages} />
            ))}
          <Row kind="bright" stage="ask_human_question" stages={stages} />
          <Row kind="bright" stage="failed" stages={stages} />
          {extras
            .filter(([, turn]) => turn === "human")
            .map(([stage]) => (
              <Row key={stage} kind="bright" stage={stage} stages={stages} />
            ))}
          <div className="legend-heading">Agent's turn</div>
          {stages.stages
            .filter((s) => s.turn === "agent")
            .map((s) => (
              <Row key={s.name} kind="dark" stage={s.name} stages={stages} />
            ))}
          {extras
            .filter(([, turn]) => turn !== "human")
            .map(([stage]) => (
              <Row key={stage} kind="dark" stage={stage} stages={stages} />
            ))}
          <div className="legend-heading">Settled</div>
          <Row kind="muted" stage="done" stages={stages} />
          <Row kind="muted" stage="broken_down" stages={stages} />
          <Row kind="dimmed" stage="invalidated" stages={stages} />
          <div className="legend-heading">Badges</div>
          <div className="legend-row">
            <span className="badge badge-invalidated-by-parent">INVALIDATED BY PARENT</span>
            <span>An ancestor is invalidated</span>
          </div>
          <div className="legend-row">
            <span className="badge badge-danger">BLOCKED</span>
            <span>Waiting on a blocker</span>
          </div>
          <div className="legend-row">
            <span className="badge badge-held">HELD</span>
            <span>Parent is still splitting</span>
          </div>
          <div className="legend-heading">Edges</div>
          <div className="legend-row">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="28" y2="4" stroke="#868e96" strokeWidth="2" />
            </svg>
            <span>Subtask, parent to child</span>
          </div>
          <div className="legend-row">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="28" y2="4" stroke="#e03131" strokeWidth="2.5" strokeDasharray="6 4" />
            </svg>
            <span>Blocks</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
