import { Link } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";

export function ProjectsPage() {
  const { data: projects, error } = useLiveData(() => api.projects(), "projects");
  return (
    <div className="page page-narrow">
      <h1>Projects</h1>
      {error ? <ErrorNotice error={error} /> : null}
      {projects?.length === 0 ? (
        <div className="empty">
          <strong>No projects yet</strong>
          <p className="muted">
            Start the server against a repo with an <code>.aop</code> folder to register it.
          </p>
        </div>
      ) : null}
      <ul className="project-list">
        {projects?.map((project) => (
          <li key={project.id}>
            <Link to={`/p/${project.id}`} className="project-card">
              <span className="project-name">{project.name}</span>
              <span className="project-path">{project.repo_path}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
