import type { ReactNode } from "react";
import type { NodeView, StagesView } from "../../../src/shared/api.js";
import { readableText, visibleOn } from "../lib/color.js";
import { humanize } from "../lib/format.js";
import type { Pipeline, PipelineStep } from "../lib/pipeline.js";
import { MISSING_STAGE_COLOR, stageColor } from "../lib/stageStyle.js";

const SURFACE = "#ffffff";

function chipLabel(node: NodeView, stage: string): string {
  if (!node.stage_exists) return `${humanize(stage)}: no longer in stages.yaml`;
  if (node.turn === "human") return `${humanize(stage)}: waiting on you`;
  return humanize(stage);
}

function SideChip({ node, stage, stages }: { node: NodeView; stage: string; stages: StagesView | null }) {
  const background = node.stage_exists ? stageColor(stage, stages) : MISSING_STAGE_COLOR;
  return (
    <div className="rail-chip" data-stage={stage} style={{ background, color: readableText(background) }}>
      {chipLabel(node, stage)}
    </div>
  );
}

function Step({
  step,
  stages,
  chip,
  link,
}: {
  step: PipelineStep;
  stages: StagesView | null;
  chip: ReactNode;
  link: "none" | "done" | "ahead";
}) {
  const color = stageColor(step.stage, stages);
  const edge = visibleOn(color, SURFACE, 2.2);
  const dot =
    step.state === "current"
      ? { background: color, borderColor: edge, boxShadow: `0 0 0 4px ${color}55` }
      : step.state === "visited"
        ? { background: color, borderColor: edge }
        : step.state === "skipped"
          ? { background: SURFACE, borderColor: edge, borderStyle: "dashed" }
          : { background: SURFACE, borderColor: `${edge}66` };
  return (
    <div className={`rail-step rail-${step.state} rail-link-${link}`} data-stage={step.stage} data-state={step.state}>
      <span className="rail-dot" style={dot} />
      <div className="rail-label">{humanize(step.stage)}</div>
      {step.state === "skipped" ? <div className="rail-note">skipped</div> : null}
      {chip}
      {step.others.map(({ outcome, target, back }) => (
        <div key={outcome} className="rail-other" title={`Outcome "${outcome}" goes to ${target}`}>
          {humanize(outcome)} {back ? "↩" : "→"} {humanize(target)}
        </div>
      ))}
    </div>
  );
}

function Line({
  steps,
  stages,
  chipFor,
}: {
  steps: PipelineStep[];
  stages: StagesView | null;
  chipFor: (stage: string) => ReactNode;
}) {
  const lastReached = steps.reduce((best, step, i) => (step.state === "current" || step.state === "visited" ? i : best), -1);
  return (
    <>
      {steps.map((step, i) => (
        <Step
          key={step.stage}
          step={step}
          stages={stages}
          chip={chipFor(step.stage)}
          link={i === 0 ? "none" : i <= lastReached ? "done" : "ahead"}
        />
      ))}
    </>
  );
}

/** Draws where a node has been and where it is, entirely from its type in `stages.yaml`. */
export function PipelineRail({
  node,
  pipeline,
  stages,
}: {
  node: NodeView;
  pipeline: Pipeline;
  stages: StagesView | null;
}) {
  const { side } = pipeline;
  const drawn = [...pipeline.rail, ...pipeline.branches.flatMap((b) => b.steps)].map((s) => s.stage);
  const anchored = side?.anchor != null && drawn.includes(side.anchor);
  const chipFor = (stage: string) =>
    side && anchored && side.anchor === stage ? <SideChip node={node} stage={side.stage} stages={stages} /> : null;

  return (
    <div className="pipeline">
      <div className="pipeline-head">
        <span className="pipeline-type">{humanize(node.type)}</span>
        {pipeline.cameFrom.length > 0 ? (
          <span className="muted">via {pipeline.cameFrom.map(humanize).join(", ")}</span>
        ) : null}
      </div>
      {pipeline.rail.length === 0 ? (
        <p className="muted">Type "{node.type}" isn't in stages.yaml, so there's no pipeline to draw.</p>
      ) : null}
      <div className={`rail${node.stage === "invalidated" ? " rail-dimmed" : ""}`}>
        <Line steps={pipeline.rail} stages={stages} chipFor={chipFor} />
      </div>
      {pipeline.branches.map((branch) => (
        <div key={branch.steps[0]?.stage} className="rail rail-branch">
          <span className="rail-branch-from">{branch.from ? `from ${humanize(branch.from)}` : "branch"}</span>
          <Line steps={branch.steps} stages={stages} chipFor={chipFor} />
        </div>
      ))}
      {side && !anchored ? <SideChip node={node} stage={side.stage} stages={stages} /> : null}
    </div>
  );
}
