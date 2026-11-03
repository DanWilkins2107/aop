import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import {
  AddProjectDialog,
  ChangeProjectPathDialog,
  DeleteProjectDialog,
  RenameProjectDialog,
} from "../components/ProjectDialogs.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";

const DIALOGS = { rename: RenameProjectDialog, path: ChangeProjectPathDialog, delete: DeleteProjectDialog };

export function ProjectsPage() {
  const { data: projects, error, reload } = useLiveData(() => api.projects(), "projects");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ dialog: keyof typeof DIALOGS; projectId: string } | null>(null);
  const done = () => {
    setAdding(false);
    setOpen(null);
    void reload();
  };

  // Looked up each time, so that the dialog closes if another tab deletes the project.
  const target = projects?.find((p) => p.id === open?.projectId);
  const OpenDialog = open ? DIALOGS[open.dialog] : null;

  return (
    <div className="page page-narrow">
      <div className="projects-head">
        <h1>Projects</h1>
        <button type="button" className="btn-create" onClick={() => setAdding(true)}>
          + Add project
        </button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {projects?.length === 0 ? (
        <div className="empty">
          <strong>No projects yet</strong>
          <p className="muted">Add one by giving it a name and the path of its repo.</p>
        </div>
      ) : null}
      <ul className="project-list">
        {projects?.map((project) => (
          <li key={project.id} className="project-row">
            <Link to={`/p/${project.id}`} className="project-card">
              <span className="project-name">{project.name}</span>
              <span className="project-path">{project.repo_path}</span>
            </Link>
            <div className="project-actions">
              <button type="button" className="btn-small" onClick={() => setOpen({ dialog: "rename", projectId: project.id })}>
                Rename
              </button>
              <button type="button" className="btn-small" onClick={() => setOpen({ dialog: "path", projectId: project.id })}>
                Change path
              </button>
              <button
                type="button"
                className="btn-small btn-danger-outline"
                onClick={() => setOpen({ dialog: "delete", projectId: project.id })}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {adding ? <AddProjectDialog onClose={() => setAdding(false)} onDone={done} /> : null}
      {OpenDialog && target ? <OpenDialog project={target} onClose={() => setOpen(null)} onDone={done} /> : null}
    </div>
  );
}
