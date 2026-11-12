export interface ProjectRow {
  id: string;
  created_at: string;
  name: string;
  repo_path: string | null;
}

export interface AddProjectRequest {
  name?: string;
  repo_path?: string | null;
}

/** At least one of `name` and `repo_path`. */
export interface UpdateProjectRequest {
  name?: string;
  repo_path?: string | null;
}
