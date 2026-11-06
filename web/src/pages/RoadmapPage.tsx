import roadmap from "../../../docs/roadmap.md?raw";
import { Markdown } from "../components/Markdown.js";
import { SubPage } from "../components/SubPage.js";

/** Bundled at build time from `docs/roadmap.md`, which the human edits by hand. */
export function RoadmapPage() {
  return (
    <SubPage>
      <Markdown source={roadmap} />
    </SubPage>
  );
}
