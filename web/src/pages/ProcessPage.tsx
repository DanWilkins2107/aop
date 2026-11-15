import { Link } from "react-router-dom";
import type { ConfigFileView } from "../../../src/shared/config/types.js";
import type { StagesView } from "../../../src/shared/stages/types.js";
import { GLOBAL_STAGES } from "../lib/globalStages.js";
import { ProblemBanner } from "../components/ErrorNotice.js";
import { FileEditor } from "../components/FileEditor.js";
import { PipelineGraph } from "../components/PipelineGraph.js";
import { SubPage } from "../components/SubPage.js";
import { api } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { useLiveData } from "../lib/live.js";

const globalStageNames = GLOBAL_STAGES.map((stage) => humanize(stage)).join(", ");

function TypeList({ process }: { process: StagesView }) {
  return (
    <ul className="process-list">
      {process.types.map((type) => (
        <li key={type.name} className="process-type">
          <h2>{humanize(type.name)}</h2>
          <p className="setting-about">
            Starts at {humanize(type.start)}
            {type.name === process.start ? ". New nodes enter this type" : ""}.
          </p>
          <PipelineGraph type={type} />
        </li>
      ))}
    </ul>
  );
}

/** A process file and its agent stages' prompts, each with an editor. */
function ProcessFiles({ files, stagesPath, reload }: { files: ConfigFileView[]; stagesPath: string | null; reload: () => Promise<void> }) {
  const stages = files.find((file) => file.kind === "stages" && file.path === stagesPath);
  if (!stages) return null;
  const prompts = files.filter((file) => file.kind === "prompt" && file.stages_path === stagesPath);
  return (
    <div className="process-files">
      <FileEditor file={stages} title="Process file" reload={reload} />
      {prompts.map((prompt) => (
        <FileEditor key={prompt.path} file={prompt} title="Prompt" reload={reload} />
      ))}
    </div>
  );
}

export function ProcessPage() {
  const { data, error, reload } = useLiveData(async () => {
    const [view, projects, files] = await Promise.all([api.process(), api.projects(), api.configFiles()]);
    return { ...view, projects, files };
  }, "process");
  const types = data?.process?.types ?? [];
  return (
    <SubPage title="Process" error={error}>
      {data ? (
        data.stages_path ? (
          <ProcessFiles files={data.files} stagesPath={data.stages_path} reload={reload} />
        ) : (
          <p className="settings-note">Name the process file with "stages" in config.yaml, from AOP settings.</p>
        )
      ) : null}
      {data && data.problems.length > 0 ? (
        <ProblemBanner title="The process is invalid, so no new agents start until it's fixed" problems={data.problems} />
      ) : null}
      {data ? (
        <p className="settings-note">
          The global stages ({globalStageNames}) can be reached from any stage, so they live outside these graphs.
        </p>
      ) : null}
      {data && types.length === 0 ? (
        <p className="muted">Nothing to draw until stages.yaml can be read.</p>
      ) : null}
      {data?.process && types.length > 0 ? <TypeList process={data.process} /> : null}
      {data && data.project_processes.length > 0 ? (
        <p className="settings-note">That process is shared by every project except those below, which follow their own.</p>
      ) : null}
      {data?.project_processes.map((own) => {
        const project = data.projects.find((p) => p.id === own.project_id);
        return (
          <section key={own.project_id} className="process-improvements" aria-label={`Process for ${project?.name ?? own.project_id}`}>
            <h2 className="settings-title">
              {project ? <Link to={`/p/${project.id}`}>{project.name}</Link> : <>Project {own.project_id} (not found)</>}
            </h2>
            <p className="settings-note">This project follows its own process.</p>
            <ProcessFiles files={data.files} stagesPath={own.stages_path} reload={reload} />
            <TypeList process={own.process} />
          </section>
        );
      })}
      {data?.improvement_process ? (
        <section className="process-improvements" aria-label="Improvement pipeline">
          <h2 className="settings-title">Improvement pipeline</h2>
          <p className="settings-note">How improvements to your skills and stage prompts move.</p>
          <ProcessFiles files={data.files} stagesPath={data.improvement_stages_path} reload={reload} />
          {data.improvement_notes.map((note) => (
            <p key={note} className="banner banner-danger" role="note">
              {note}
            </p>
          ))}
          <ul className="process-list">
            {data.improvement_process.types.map((type) => (
              <li key={type.name} className="process-type">
                <h2>{humanize(type.name)}</h2>
                <p className="setting-about">Starts at {humanize(type.start)}.</p>
                <PipelineGraph type={type} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </SubPage>
  );
}
