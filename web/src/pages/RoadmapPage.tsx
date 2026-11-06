import { Link } from "react-router-dom";
import roadmap from "../../../docs/roadmap.md?raw";
import { Markdown } from "../components/Markdown.js";

/** Bundled at build time from `docs/roadmap.md`, which the human edits by hand. */
export function RoadmapPage() {
  return (
    <div className="page page-narrow">
      <nav className="breadcrumb">
        <Link to="/">Projects</Link>
      </nav>
      <Markdown source={roadmap} />
    </div>
  );
}
