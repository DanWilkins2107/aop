import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { IMPROVEMENTS_PROJECT_ID } from "../shared/improvements/improvementsProjectId.js";
import type { NodeRow } from "../shared/nodes/types.js";
import type { ProjectRow } from "../shared/projects/types.js";
import type { AopConfig } from "./config.js";
import { allowProjectDeletion, type Db } from "./db.js";
import { ApiError, badRequest, notFound } from "./errors.js";
import { newId, now } from "./records.js";

export type { ProjectRow };

export { IMPROVEMENTS_PROJECT_ID };

/** Creates the improvements project's row the first time it's needed. */
export function ensureImprovementsProject(db: Db): void {
  db.prepare("INSERT OR IGNORE INTO projects (id, created_at, name, repo_path) VALUES (?, ?, 'Improvements', NULL)").run(
    IMPROVEMENTS_PROJECT_ID,
    now(),
  );
}

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

/**
 * Adds a project, which needs only a name. A path has to be an existing folder, and nothing is read
 * from it or written to it. Given only a path, the project is named after the folder.
 */
export function addProject(db: Db, input: { name?: string | undefined; repo_path?: string | null | undefined }): ProjectRow {
  const repoPath = input.repo_path == null ? null : existingFolder(input.repo_path.trim());
  if (repoPath !== null) refuseIfRegistered(db, repoPath);

  const name = input.name?.trim() ?? (repoPath === null ? "" : basename(repoPath) || repoPath);
  if (name === "") throw badRequest("A project needs a name");

  const project: ProjectRow = { id: newId(), created_at: now(), name, repo_path: repoPath };
  db.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, ?, ?)").run(
    project.id,
    project.created_at,
    project.name,
    project.repo_path,
  );
  return project;
}

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare("SELECT * FROM projects WHERE id <> ? ORDER BY rowid").all(IMPROVEMENTS_PROJECT_ID) as ProjectRow[];
}

export function getProject(db: Db, id: string): ProjectRow {
  if (id === IMPROVEMENTS_PROJECT_ID) throw notFound(`No project ${id}`);
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!project) throw notFound(`No project ${id}`);
  return project;
}

/** Renames a project, or points it at another folder or at none (`repo_path: null`). */
export function updateProject(
  db: Db,
  id: string,
  changes: { name?: string | undefined; repo_path?: string | null | undefined },
): ProjectRow {
  const project = getProject(db, id);
  const name = changes.name?.trim() ?? project.name;
  let repoPath = project.repo_path;
  if (changes.repo_path !== undefined) {
    repoPath = changes.repo_path === null ? null : existingFolder(changes.repo_path.trim());
  }
  if (repoPath !== null) refuseIfRegistered(db, repoPath, id);

  db.prepare("UPDATE projects SET name = ?, repo_path = ? WHERE id = ?").run(name, repoPath, id);
  return { ...project, name, repo_path: repoPath };
}

/** Where a project's agents start: its own path if it has one, otherwise the machine's `open_from`. */
export function agentStartPath(project: Pick<ProjectRow, "repo_path">, config: Pick<AopConfig, "openFromPath">): string {
  return project.repo_path ?? config.openFromPath;
}

/** Where a node's agents start. An improvement's never start in a project: only in `improvements_path`. */
export function nodeStartPath(
  db: Db,
  node: Pick<NodeRow, "kind" | "project_id">,
  config: Pick<AopConfig, "openFromPath" | "improvementsDir">,
): string {
  if (node.kind === "improvement") return config.improvementsDir;
  return agentStartPath(getProject(db, node.project_id), config);
}

/**
 * Permanently deletes a project and everything recorded about it, or nothing if any step fails.
 * Only touches the database: the repo folder is the user's. Stopping the project's agents comes
 * first, and is the caller's job because it takes time: see `Orchestrator.stopProjectAgents`.
 */
export function deleteProject(db: Db, id: string): ProjectRow {
  const project = getProject(db, id);

  const projectNodes = "(SELECT id FROM nodes WHERE project_id = @id)";
  allowProjectDeletion(db, id, () => {
    // Improvements outlive their source, keeping a copy of its text and title.
    db.prepare(
      `UPDATE improvements SET source_node_id = NULL, source_message_id = NULL WHERE source_node_id IN ${projectNodes}`,
    ).run({ id });
    for (const table of ["links", "messages", "events", "runs", "steer_sessions"]) {
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
