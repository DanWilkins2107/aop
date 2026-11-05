import { Link } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { PipelineGraph } from "../components/PipelineGraph.js";
import { api } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { useLiveData } from "../lib/live.js";
import { GLOBAL_STAGES } from "../lib/stageStyle.js";

const globalStageNames = GLOBAL_STAGES.map((stage) => humanize(stage)).join(", ");

/** View-only by design: `stages.yaml` is the one place the process is edited. */
export function ProcessPage() {
  const { data, error } = useLiveData(() => api.process(), "process");
  const types = data?.process?.types ?? [];
  return (
    <div className="page page-narrow">
      <nav className="breadcrumb">
        <Link to="/">Projects</Link>
      </nav>
      <h1 className="settings-title">Process</h1>
      {error ? <ErrorNotice error={error} /> : null}
      {data ? (
        <p className="settings-note">
          View-only. To change the process, edit{" "}
          {data.stages_path ? <code>{data.stages_path}</code> : <>the file named by "stages" in config.yaml</>}.
        </p>
      ) : null}
      {data && data.problems.length > 0 ? (
        <div className="banner banner-danger" role="alert">
          <strong>The process is invalid, so no new agents start until it's fixed</strong>
          <ul className="problem-list">
            {data.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {data ? (
        <p className="settings-note">
          The global stages ({globalStageNames}) can be reached from any stage, so they live outside these graphs.
        </p>
      ) : null}
      {data && types.length === 0 ? (
        <p className="muted">Nothing to draw until stages.yaml can be read.</p>
      ) : null}
      {types.length > 0 ? (
        <ul className="process-list">
          {types.map((type) => (
            <li key={type.name} className="process-type">
              <h2>{humanize(type.name)}</h2>
              <p className="setting-about">
                Starts at {humanize(type.start)}
                {type.name === data?.process?.start ? ". New nodes enter this type" : ""}.
              </p>
              <PipelineGraph type={type} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
