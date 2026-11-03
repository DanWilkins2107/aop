import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ProjectRow } from "../shared/api.js";
import { allowProjectDeletion, type Db } from "./db.js";
import { ApiError, notFound } from "./errors.js";
import { newId, now } from "./records.js";

export type { ProjectRow };

/** The same folder must give the same `repo_path` however it was spelled. */
function existingFolder(repoPath: string): string {
  if (!isAbsolute(repoPath)) {
    throw new ApiError(400, "repo_path_not_absolute", `The repo path must be a full path: ${repoPath}`);
  }
  try {
    const canonical = realpathSync.native(repoPath);
    if (statSync(canonical).isDirectory()) return canonical;
  } catch {
    // Reported below, the same as a path that isn't a folder.
  }
  throw new ApiError(400, "repo_path_not_found", `There is no folder at ${repoPath}`);
}

function refuseIfRegistered(db: Db, repoPath: string, exceptId = ""): void {
  const holder = db.prepare("SELECT * FROM projects WHERE repo_path = ? AND id <> ?").get(repoPath, exceptId) as
    | ProjectRow
    | undefined;
  if (holder) {
    throw new ApiError(409, "repo_path_taken", `${repoPath} is already registered as project "${holder.name}"`);
  }
}

/** Adds a project. The folder only has to exist: nothing is read from it or written to it. */
export function addProject(db: Db, repoPath: string, name?: string): ProjectRow {
  const canonical = existingFolder(repoPath.trim());
  refuseIfRegistered(db, canonical);

  const project: ProjectRow = {
    id: newId(),
    created_at: now(),
    name: name?.trim() ?? (basename(canonical) || canonical),
    repo_path: canonical,
  };
  db.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, ?, ?)").run(
    project.id,
    project.created_at,
    project.name,
    project.repo_path,
  );
  return project;
}

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY rowid").all() as ProjectRow[];
}

export function getProject(db: Db, id: string): ProjectRow {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!project) throw notFound(`No project ${id}`);
  return project;
}

/** Renames a project or points it at another folder. */
export function updateProject(db: Db, id: string, changes: { name?: string; repo_path?: string }): ProjectRow {
  const project = getProject(db, id);
  const name = changes.name?.trim() ?? project.name;
  const repoPath = changes.repo_path === undefined ? project.repo_path : existingFolder(changes.repo_path.trim());
  refuseIfRegistered(db, repoPath, id);

  db.prepare("UPDATE projects SET name = ?, repo_path = ? WHERE id = ?").run(name, repoPath, id);
  return { ...project, name, repo_path: repoPath };
}

/** Stops any agent processes working on a project. There are none yet: the orchestrator fills this in. */
export function stopProjectAgents(_db: Db, _projectId: string): void {}

/**
 * Permanently deletes a project and everything recorded about it, or nothing if any step fails.
 * Only touches the database: the repo folder is the user's.
 */
export function deleteProject(db: Db, id: string): ProjectRow {
  const project = getProject(db, id);
  stopProjectAgents(db, id);

  const projectNodes = "(SELECT id FROM nodes WHERE project_id = @id)";
  allowProjectDeletion(db, id, () => {
    for (const table of ["links", "messages", "events", "runs"]) {
      db.prepare(`DELETE FROM ${table} WHERE node_id IN ${projectNodes}`).run({ id });
    }
    db.prepare(`DELETE FROM edges WHERE source_id IN ${projectNodes} OR target_id IN ${projectNodes}`).run({ id });
    // ON DELETE RESTRICT fires straight away, even for two nodes leaving in the same statement.
    db.prepare(`UPDATE nodes SET spawned_by = NULL WHERE spawned_by IN ${projectNodes}`).run({ id });
    db.prepare("DELETE FROM nodes WHERE project_id = @id").run({ id });
    db.prepare("DELETE FROM projects WHERE id = @id").run({ id });
  });
  return project;
}
