import { useState } from "react";
import { Link } from "react-router-dom";
import { IMPROVEMENTS_PROJECT_ID, type ImprovementSource } from "../../../src/shared/api.js";
import { CaptureImprovement } from "../components/CaptureImprovement.js";
import { ClaimMark } from "../components/ClaimMark.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { HomeTabs } from "../components/HomeTabs.js";
import { api } from "../lib/api.js";
import { touchesProject } from "../lib/changes.js";
import { humanize } from "../lib/format.js";
import { useLiveData } from "../lib/live.js";
import { stageColor } from "../lib/stageStyle.js";

async function load() {
  const [list, stages] = await Promise.all([api.improvements(), api.improvementStages()]);
  return { list, stages };
}

function sourceText(source: ImprovementSource | null): string {
  if (source === null) return "No source";
  return `From ${source.project_name ?? "a deleted project"} › ${source.node_title}`;
}

/** Every improvement, newest first. No graph: each one opens as a node. */
export function ImprovementsPage() {
  const { data, error, reload } = useLiveData(load, "improvements", {
    // Any change to an improvement, or to a project one was captured from, which names it.
    affects: (notice, shown) =>
      touchesProject(notice, IMPROVEMENTS_PROJECT_ID) ||
      (shown?.list.improvements ?? []).some(
        ({ source }) => source?.project_id != null && touchesProject(notice, source.project_id),
      ),
  });
  const [adding, setAdding] = useState(false);
  const list = data?.list;

  return (
    <div className="page page-narrow">
      <HomeTabs
        action={
          list?.enabled ? (
            <button type="button" onClick={() => setAdding(true)} disabled={adding}>
              New improvement
            </button>
          ) : null
        }
      />
      {error ? <ErrorNotice error={error} /> : null}
      {list?.note ? <p className="settings-note">{list.note}</p> : null}
      {adding ? (
        <div className="capture-standalone">
          <CaptureImprovement onClose={() => setAdding(false)} onCreated={reload} />
        </div>
      ) : null}
      {list?.enabled && list.improvements.length === 0 && !adding ? (
        <div className="empty">
          <strong>No improvements yet</strong>
          <p className="muted">Add one from the + beside any message, or with New improvement.</p>
        </div>
      ) : null}
      <ul className="project-list">
        {list?.improvements.map(({ node, source }) => (
          <li
            key={node.id}
            className="project-row improvement-row"
            // Colour only where a human needs to act.
            style={node.turn === "human" ? { borderLeftColor: stageColor(node.stage, data?.stages ?? null) } : undefined}
            data-needs-human={node.turn === "human" ? "true" : undefined}
          >
            <Link to={`/n/${node.id}`} className="project-card">
              <span className="project-name">{node.title}</span>
              <span className="project-path">
                {humanize(node.stage)} · {sourceText(source)} <ClaimMark node={node} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
