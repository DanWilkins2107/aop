import type { StagesView } from "../../../src/shared/api.js";
import { readableText } from "../lib/color.js";
import { humanize } from "../lib/format.js";
import { stageColor } from "../lib/stageStyle.js";

export function StagePill({ stage, stages }: { stage: string; stages: StagesView | null }) {
  const background = stageColor(stage, stages);
  return (
    <span className="pill" style={{ background, color: readableText(background) }}>
      {humanize(stage)}
    </span>
  );
}
