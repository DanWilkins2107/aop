import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { AddProjectDialog } from "../components/ProjectDialogs.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";

export function ProjectsPage() {
  const { data: projects, error, reload } = useLiveData(() => api.projects(), "projects");
  const [adding, setAdding] = useState(false);
  const done = () => {
    setAdding(false);
    void reload();
  };

  return (
    <div className="page page-narrow">
      <div className="projects-head">
        <h1>Projects</h1>
        <button type="button" className="btn-small" onClick={() => setAdding(true)}>
          Add project
        </button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {projects?.length === 0 ? (
        <div className="empty">
          <strong>No projects yet</strong>
          <p className="muted">Add one by giving it a name.</p>
        </div>
      ) : null}
      <ul className="project-list">
        {projects?.map((project) => (
          <li key={project.id} className="project-row">
            <Link to={`/p/${project.id}`} className="project-card">
              <span className="project-name">{project.name}</span>
              {project.repo_path ? <span className="project-path">{project.repo_path}</span> : null}
            </Link>
            <Link to={`/p/${project.id}/settings`} className="quiet-link" aria-label={`Settings for ${project.name}`}>
              Settings
            </Link>
          </li>
        ))}
      </ul>
      {adding ? <AddProjectDialog onClose={() => setAdding(false)} onDone={done} /> : null}
    </div>
  );
}
