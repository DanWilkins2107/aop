import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ConfigView } from "../shared/config/types.js";
import { IMPROVEMENTS_PROJECT_ID } from "../shared/improvements/improvementsProjectId.js";
import { ConfigError } from "./errors.js";
import { aopHome, configPath, isWithin, repoAround, resolveConfigPath } from "./paths.js";
import { loadStagesFile, promptFiles, type StageGraph } from "./stages.js";
import { parseYamlFile } from "./yamlFile.js";

const command = z.string().trim().min(1);

const settingsSchema = z.strictObject({
  agent_session_command: z
    .string({ error: (issue) => (issue.input === undefined ? "required" : "must be a command") })
    .trim()
    .min(1),
  out_of_sandbox_command: command.optional(),
  open_from: z.string().trim().min(1).default("~/code"),
  agent_timeout_minutes: z.number().positive().default(60),
  stages: z.string().min(1),
  project_stages: z.record(z.string().min(1), z.string().min(1)).optional(),
  improvement_stages: z.string().min(1).optional(),
  improvements_path: z.string().trim().min(1).default("./skills"),
});

type Settings = z.infer<typeof settingsSchema>;

export interface AopConfig extends Settings {
  /** Absolute path to `stages.yaml`. */
  stagesPath: string;
  /** Absolute path of `open_from`, where agents start for projects with no path. May not exist. */
  openFromPath: string;
  graph: StageGraph;
  /** Projects with a process of their own, by project ID. Every other project follows `graph`. */
  projectStages: Map<string, { path: string; graph: StageGraph }>;
  /** Absolute path to `improvement_stages.yaml`, or null when improvements are off. */
  improvementStagesPath: string | null;
  /** The improvement pipeline, or null when improvements are off. */
  improvementGraph: StageGraph | null;
  /** Absolute path of `improvements_path`, where improvement agents start. May not exist. */
  improvementsDir: string;
  /** The git repo holding `improvementsDir`, which Raise PR needs, or null. */
  improvementsRepo: string | null;
}

const mappingSchema = z.record(z.string(), z.unknown());

/**
 * Reads a linked process file, adding its problems, and calls `watch` on it and each prompt file it
 * names. Returns null if it can't be found. `key` is the setting naming it, and `label` how its
 * problems name it.
 */
function loadLinkedStages(
  home: string,
  file: string,
  key: string,
  setting: string,
  problems: string[],
  watch: (path: string) => void,
  label?: string,
): { path: string; graph: StageGraph } | null {
  const path = resolveConfigPath(home, setting);
  watch(path);
  if (!existsSync(path)) {
    problems.push(`${path}: file not found. Create it, or point "${key}" in ${file} at your process file.`);
    return null;
  }
  const { graph, problems: stageProblems } = loadStagesFile(path, label);
  // Whether each prompt file exists is part of the result, found or not.
  for (const stage of graph.stages.values()) if (stage.prompt !== undefined) watch(stage.prompt);
  problems.push(...stageProblems);
  return { path, graph };
}

/** Each `project_stages` entry's process. Its problems name the project, since stage problems don't name the file. */
function loadProjectStages(
  home: string,
  file: string,
  raw: unknown,
  problems: string[],
  watch: (path: string) => void,
): Map<string, { path: string; graph: StageGraph }> {
  const loaded = new Map<string, { path: string; graph: StageGraph }>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return loaded;
  for (const [projectId, setting] of Object.entries(raw)) {
    const key = `project_stages.${projectId}`;
    if (projectId === IMPROVEMENTS_PROJECT_ID) {
      problems.push(`${file}: ${key}: improvements follow improvement_stages, not a project's process`);
      continue;
    }
    if (typeof setting !== "string" || setting.length === 0) continue; // The settings schema reports it.
    const own: string[] = [];
    const stages = loadLinkedStages(home, file, key, setting, own, watch, `${key} (${basename(resolveConfigPath(home, setting))})`);
    problems.push(...own.map((problem) => (problem.startsWith(key) ? problem : `${key}: ${problem}`)));
    if (stages !== null) loaded.set(projectId, stages);
  }
  return loaded;
}

type Loaded = { config: AopConfig } | { error: ConfigError };

/** A file as last read: kind, modification time and size, or missing. */
function signature(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.isFile() ? "file" : "other"}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/**
 * A file changed this recently might change again within its file system's timestamp resolution,
 * which can be as coarse as two seconds, without its signature changing. So it isn't cached.
 */
const SETTLED_MS = 2_000;

interface Cached {
  /** Every file the result depends on, with its signature when it was read. */
  files: Map<string, string>;
  loaded: Loaded;
}

const cache = new Map<string, Cached>();

/** One load per home for the length of an operation. Closed when the operation ends. */
interface Snapshot {
  open: boolean;
  loads: Map<string, Loaded>;
}

const snapshots = new AsyncLocalStorage<Snapshot>();

/**
 * Runs `work` with one config for its whole length: every `loadConfig` inside it, including after
 * an await, gets what the first one got. For a request, a reconcile or a scheduler wake.
 */
export function withConfigSnapshot<T>(work: () => T): T {
  const snapshot: Snapshot = { open: true, loads: new Map() };
  const close = () => {
    snapshot.open = false;
    snapshot.loads.clear();
  };
  let result: T;
  try {
    result = snapshots.run(snapshot, work);
  } catch (error) {
    close();
    throw error;
  }
  // Anything that outlives the operation, such as a timer it started, reads the files again.
  if (result instanceof Promise) result.then(close, close);
  else close();
  return result;
}

/**
 * Loads and validates the machine's one config, `config.yaml` in AOP_HOME, and the process files
 * it links to. Throws ConfigError with every problem found across them all.
 *
 * Read once per operation (see `withConfigSnapshot`), and otherwise kept until `config.yaml`, a
 * process file or a prompt file changes, so edits still apply without a restart.
 */
export function loadConfig(home: string = aopHome()): AopConfig {
  const loaded = loadOnce(home);
  if ("error" in loaded) throw loaded.error;
  return loaded.config;
}

function loadOnce(home: string): Loaded {
  const snapshot = snapshots.getStore();
  const taken = snapshot?.open ? snapshot.loads.get(home) : undefined;
  if (taken !== undefined) return taken;

  const cached = cache.get(home);
  let loaded: Loaded;
  if (cached !== undefined && [...cached.files].every(([path, seen]) => signature(path) === seen)) {
    loaded = cached.loaded;
  } else {
    const files = new Map<string, string>();
    const startedAt = Date.now();
    // Each file's signature is taken before it's read, so an edit during the read shows next time.
    const watch = (path: string) => files.set(path, signature(path));
    try {
      loaded = { config: readConfig(home, watch) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      loaded = { error };
    }
    const settled = [...files.keys()].every((path) => {
      try {
        return startedAt - statSync(path).mtimeMs > SETTLED_MS;
      } catch {
        return true;
      }
    });
    if (settled) cache.set(home, { files, loaded });
    else cache.delete(home);
  }
  if (snapshot?.open) snapshot.loads.set(home, loaded);
  return loaded;
}

/** Reads both files from disk, calling `watch` on each file the result depends on before reading it. */
function readConfig(home: string, watch: (path: string) => void): AopConfig {
  const file = configPath(home);
  watch(file);
  if (!existsSync(file)) {
    throw new ConfigError([
      `${file}: file not found. Create it, with at least "agent_session_command: <the command that starts an agent session>" and "stages: ./stages.yaml".`,
    ]);
  }

  const parsed = parseYamlFile(file);
  if (!parsed.ok) throw new ConfigError(parsed.problems);
  const mapping = mappingSchema.safeParse(parsed.value);
  if (!mapping.success) throw new ConfigError([`${file}: must be a mapping of settings`]);
  const raw = mapping.data;

  const problems: string[] = [];
  const settings = settingsSchema.safeParse(raw);
  if (!settings.success) {
    for (const issue of settings.error.issues) {
      problems.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  // Still check stages.yaml when another setting is bad, so one run reports everything.
  const stagesSetting = raw["stages"];
  if (typeof stagesSetting !== "string" || stagesSetting.length === 0) throw new ConfigError(problems);
  const stages = loadLinkedStages(home, file, "stages", stagesSetting, problems, watch);
  if (stages === null) throw new ConfigError(problems);
  const projectStages = loadProjectStages(home, file, raw["project_stages"], problems, watch);

  const improvementSetting = raw["improvement_stages"];
  const improvements =
    typeof improvementSetting === "string" && improvementSetting.length > 0
      ? loadLinkedStages(home, file, "improvement_stages", improvementSetting, problems, watch, "improvement_stages.yaml")
      : null;

  if (!settings.success || problems.length > 0) throw new ConfigError(problems);

  const improvementsDir = resolveConfigPath(home, settings.data.improvements_path);
  // Its agents may change what's in it, and AOP_HOME holds the config, database and logs.
  if (isWithin(resolve(home), improvementsDir)) {
    throw new ConfigError([`${file}: improvements_path: ${improvementsDir} can't be AOP_HOME (${home}) or a folder holding it`]);
  }
  return {
    ...settings.data,
    stagesPath: stages.path,
    openFromPath: resolveConfigPath(home, settings.data.open_from),
    graph: stages.graph,
    projectStages,
    improvementStagesPath: improvements?.path ?? null,
    improvementGraph: improvements?.graph ?? null,
    improvementsDir,
    improvementsRepo: watchedRepoAround(improvementsDir, watch),
  };
}

/** Every prompt file of every process: the shared one, each project's own and the improvement pipeline. */
export function allPromptFiles(config: AopConfig): string[] {
  const graphs = [config.graph, ...[...config.projectStages.values()].map((own) => own.graph), config.improvementGraph];
  return [...new Set(graphs.flatMap((graph) => (graph === null ? [] : promptFiles(graph))))];
}

/** `repoAround`, watching each `.git` it looks for, so a repo made or removed later shows. */
function watchedRepoAround(path: string, watch: (path: string) => void): string | null {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    watch(join(dir, ".git"));
    if (dirname(dir) === dir) break;
  }
  return repoAround(path);
}

/** What the read-only settings page shows. An invalid config is a normal answer here, not a failure. */
export function describeConfig(home: string = aopHome()): ConfigView {
  const config_path = configPath(home);
  try {
    const config = loadConfig(home);
    return {
      config_path,
      problems: [],
      settings: {
        agent_session_command: config.agent_session_command,
        out_of_sandbox_command: config.out_of_sandbox_command ?? null,
        open_from: config.open_from,
        open_from_path: config.openFromPath,
        agent_timeout_minutes: config.agent_timeout_minutes,
        stages: config.stages,
        stages_path: config.stagesPath,
        project_stages: [...config.projectStages].map(([project_id, own]) => ({
          project_id,
          stages: config.project_stages?.[project_id] ?? "",
          stages_path: own.path,
        })),
        improvement_stages: config.improvement_stages ?? null,
        improvement_stages_path: config.improvementStagesPath,
        improvements_path: config.improvements_path,
        improvements_dir: config.improvementsDir,
        improvements_repo: config.improvementsRepo,
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) return { config_path, problems: error.problems, settings: null };
    throw error;
  }
}
