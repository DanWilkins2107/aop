import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ProjectRow } from "../shared/api.js";
import type { Db } from "./db.js";
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
