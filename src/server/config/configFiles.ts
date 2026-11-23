// The files a human edits from the settings and process pages: `config.yaml`, the process files it
// names and their agent stages' prompts. Found without needing the config to be valid, so a broken
// one can be fixed from the UI too.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConfigFileKind, ConfigFileView, SaveConfigFileRequest } from "../../shared/config/types.js";
import type { Db } from "../db/db.js";
import { listProjects } from "../projects/projects.js";
import { ApiError, badRequest, refused } from "../shared/errors.js";
import { newId } from "../db/records.js";
import { aopHome, configPath, isWithin, resolveConfigPath } from "../shared/paths.js";
import { parseYaml, parseYamlFile } from "../shared/yamlFile.js";
import { loadStagesFile, promptFiles, stagesSourceProblems } from "../stages/stages.js";
import { configSourceProblems } from "./config.js";

interface EditableFile {
  path: string;
  kind: ConfigFileKind;
  /** For a prompt, the process file naming it. */
  stagesPath?: string;
  /** How problems name a process file. */
  label?: string;
}

/** Each process file `config.yaml` names, as far as it can be read. */
function processFiles(home: string): EditableFile[] {
  const parsed = parseYamlFile(configPath(home));
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return [];
  const raw = parsed.value as Record<string, unknown>;
  const files: EditableFile[] = [];
  const add = (setting: unknown, label?: string) => {
    if (typeof setting !== "string" || setting.length === 0) return;
    files.push({ path: resolveConfigPath(home, setting), kind: "stages", ...(label === undefined ? {} : { label }) });
  };
  add(raw["stages"]);
  const own = raw["project_stages"];
  if (typeof own === "object" && own !== null && !Array.isArray(own)) {
    for (const [projectId, setting] of Object.entries(own)) add(setting, `project_stages.${projectId}`);
  }
  add(raw["improvement_stages"], "improvement_stages.yaml");
  return files;
}

/** The prompts a process file's agent stages name. Only those in its folder, as no other prompt is valid. */
function promptsOf(stagesPath: string): EditableFile[] {
  if (!existsSync(stagesPath)) return [];
  return promptFiles(loadStagesFile(stagesPath).graph)
    .filter((prompt) => isWithin(prompt, dirname(stagesPath)))
    .map((path) => ({ path, kind: "prompt" as const, stagesPath }));
}

function editableFiles(home: string): EditableFile[] {
  const stages = processFiles(home);
  const all = [{ path: configPath(home), kind: "config" as const }, ...stages, ...stages.flatMap((file) => promptsOf(file.path))];
  const seen = new Set<string>();
  return all.filter((file) => !seen.has(file.path) && seen.add(file.path));
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Every file the settings and process pages can edit, with what each holds now. */
export function listConfigFiles(home: string = aopHome()): ConfigFileView[] {
  return editableFiles(home).map((file) => view(file, read(file.path)));
}

function view(file: EditableFile, content: string | null): ConfigFileView {
  return { path: file.path, kind: file.kind, stages_path: file.stagesPath ?? null, content };
}

function problemsIn(file: EditableFile, content: string): string[] {
  if (file.kind === "config") return configSourceProblems(content, file.path);
  if (file.kind === "stages") return stagesSourceProblems(content, file.path, file.label);
  return [];
}

/** `config.yaml`'s `extensions:` list in `source`, comparable as a string. */
function extensionsIn(source: string | null): string {
  const parsed = source === null ? null : parseYaml(source, "config.yaml");
  const value = parsed?.ok === true && typeof parsed.value === "object" && parsed.value !== null ? Reflect.get(parsed.value, "extensions") : undefined;
  return JSON.stringify(value ?? []);
}

/**
 * Saves one of those files, if it still holds what was shown (`base`) and the new contents are valid
 * on their own. Never a file inside a project's folder.
 */
export function saveConfigFile(db: Db, input: SaveConfigFileRequest, home: string = aopHome()): ConfigFileView {
  const path = resolve(input.path);
  const file = editableFiles(home).find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new ApiError(400, "path_not_allowed", `${path} isn't config.yaml, a process file it names or one of their prompts`);
  }
  const project = listProjects(db).find((p) => p.repo_path !== null && isWithin(path, p.repo_path));
  if (project !== undefined) throw refused(`${path} is in project "${project.name}"'s folder, which AOP never writes to`);
  if (read(path) !== input.base) throw refused(`${path} has changed since it was shown. Nothing was saved. Reload it, then edit again`);
  // Extensions run as AOP, so only a human editing the file can add one.
  if (file.kind === "config" && extensionsIn(input.content) !== extensionsIn(input.base)) {
    throw refused(`Not saved: extensions: in ${path} can only be changed by editing the file itself, then restarting \`aop serve\``);
  }
  const problems = problemsIn(file, input.content);
  if (problems.length > 0) throw badRequest(`Not saved: ${path} has problems`, problems);

  const temp = `${path}.aop-${newId()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, input.content, { flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw refused(`Couldn't write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return view(file, input.content);
}
