import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ProjectRow } from "../shared/api.js";
import { loadProjectConfig, type ProjectConfig } from "./config.js";
import type { Db } from "./db.js";
import { ConfigError, notFound } from "./errors.js";
import { newId, now } from "./records.js";

export type { ProjectRow };

/** The same folder must give the same `repo_path` however it was spelled. */
function canonicalRepoPath(repoPath: string): string {
  try {
    return realpathSync.native(resolve(repoPath));
  } catch {
    throw new ConfigError([`repo path not found: ${repoPath}`]);
  }
}

/**
 * Registers a repo whose `.aop` config is valid. Registering a known repo returns the existing
 * project, so that the start script can register on every start.
 */
export function registerProject(
  db: Db,
  repoPath: string,
  name?: string,
): { project: ProjectRow; created: boolean } {
  const canonical = canonicalRepoPath(repoPath);
  loadProjectConfig(canonical);

  const existing = db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(canonical) as
    | ProjectRow
    | undefined;
  if (existing) return { project: existing, created: false };

  const project: ProjectRow = {
    id: newId(),
    created_at: now(),
    name: name ?? (basename(canonical) || canonical),
    repo_path: canonical,
  };
  db.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, ?, ?)").run(
    project.id,
    project.created_at,
    project.name,
    project.repo_path,
  );
  return { project, created: true };
}

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY rowid").all() as ProjectRow[];
}

export function getProject(db: Db, id: string): ProjectRow {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!project) throw notFound(`No project ${id}`);
  return project;
}

/** Read from disk every time, so edits to `stages.yaml` apply without a restart. */
export function projectConfig(db: Db, projectId: string): ProjectConfig {
  return loadProjectConfig(getProject(db, projectId).repo_path);
}
