import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ProjectRow } from "../../../src/shared/projects/types.js";
import { FormError, useFormError } from "../components/FormError.js";
import { DeleteProjectDialog, RepoPathHint } from "../components/ProjectDialogs.js";
import { SubPage } from "../components/SubPage.js";
import { api } from "../lib/api.js";
import { touchesProject } from "../lib/changes.js";
import { useLiveData } from "../lib/live.js";
import { useAction } from "../lib/useAction.js";

function DetailsForm({
  project,
  openFrom,
  reload,
}: {
  project: ProjectRow;
  openFrom: string | null;
  reload: () => Promise<void>;
}) {
  // Null until edited, so that a change from elsewhere still shows.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction(reload);
  const { errorId, describedBy } = useFormError(error);

  const name = (nameDraft ?? project.name).trim();
  const path = (pathDraft ?? project.repo_path ?? "").trim();
  const nameChanged = name !== project.name;
  const pathChanged = path !== (project.repo_path ?? "");

  async function save() {
    const changes = {
      ...(nameChanged ? { name } : {}),
      ...(pathChanged ? { repo_path: path === "" ? null : path } : {}),
    };
    if (await run(() => api.updateProject(project.id, changes))) {
      setNameDraft(null);
      setPathDraft(null);
      setSaved(true);
    }
  }

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name !== "" && (nameChanged || pathChanged) && !busy) void save();
      }}
    >
      <label>
        Name
        <input
          maxLength={200}
          aria-describedby={describedBy}
          value={nameDraft ?? project.name}
          onChange={(e) => {
            setNameDraft(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label>
        <span>
          Repo path <span className="muted">(optional)</span>
        </span>
        <input
          className="mono"
          spellCheck={false}
          aria-describedby={describedBy}
          value={pathDraft ?? project.repo_path ?? ""}
          onChange={(e) => {
            setPathDraft(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <RepoPathHint openFrom={openFrom} />
      <FormError error={error} id={errorId} />
      <div className="action-row">
        <button type="submit" className="btn-primary" disabled={busy || name === "" || (!nameChanged && !pathChanged)}>
          Save
        </button>
        {saved ? <span className="muted">Saved</span> : null}
      </div>
    </form>
  );
}

export function ProjectSettingsPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const { data, error, reload } = useLiveData(async () => {
    const [projects, config] = await Promise.all([api.projects(), api.config()]);
    const settings = config.settings;
    return {
      project: projects.find((p) => p.id === projectId) ?? null,
      openFrom: settings?.open_from_path ?? null,
      process: settings?.project_stages.find((own) => own.project_id === projectId)?.stages_path ?? null,
      sharedProcess: settings?.stages_path ?? null,
      configPath: config.config_path,
    };
  }, `settings:${projectId}`, { affects: (notice) => touchesProject(notice, projectId) });

  const project = data?.project;
  return (
    <SubPage
      title="Project settings"
      error={error}
      trail={
        project ? (
          <>
            <span className="crumb-sep">›</span>
            <Link to={`/p/${project.id}`}>{project.name}</Link>
          </>
        ) : null
      }
    >
      {data && !project ? <p className="muted">This project no longer exists.</p> : null}
      {project ? (
        <>
          <DetailsForm key={project.id} project={project} openFrom={data.openFrom} reload={reload} />
          <section className="section">
            <h2>Process</h2>
            <p className="section-text">
              {data.sharedProcess === null ? (
                <>Which process this project follows is unknown while config.yaml is invalid.</>
              ) : data.process !== null ? (
                <>
                  This project follows its own process, <code>{data.process}</code>.
                </>
              ) : (
                <>
                  This project follows the shared process, <code>{data.sharedProcess}</code>.
                </>
              )}{" "}
              To change which, set <code>project_stages</code> for project <code>{project.id}</code> in{" "}
              <code>{data.configPath}</code>. <Link to="/process">See the process</Link>.
            </p>
          </section>
          <section className="section settings-delete">
            <h2>Delete project</h2>
            <p className="section-text">Permanently deletes the project from AOP and stops its agents.</p>
            <div className="action-row">
              <button type="button" onClick={() => setDeleting(true)}>
                Delete project
              </button>
            </div>
          </section>
          {deleting ? (
            <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} onDone={() => void navigate("/")} />
          ) : null}
        </>
      ) : null}
    </SubPage>
  );
}
