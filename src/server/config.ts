import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import type { ConfigView } from "../shared/api.js";
import { ConfigError } from "./errors.js";
import { aopHome, configPath, resolveConfigPath } from "./paths.js";
import { loadStagesFile, type StageGraph } from "./stages.js";
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
});

type Settings = z.infer<typeof settingsSchema>;

export interface AopConfig extends Settings {
  /** Absolute path to `stages.yaml`. */
  stagesPath: string;
  /** Absolute path of `open_from`, where agents start for projects with no path. May not exist. */
  openFromPath: string;
  graph: StageGraph;
}

const mappingSchema = z.record(z.string(), z.unknown());

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
 * Loads and validates the machine's one config, `config.yaml` in AOP_HOME, and the `stages.yaml`
 * it links to. Throws ConfigError with every problem found across both files.
 *
 * Read once per operation (see `withConfigSnapshot`), and otherwise kept until `config.yaml`,
 * `stages.yaml` or a prompt file changes, so edits still apply without a restart.
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
  const stagesPath = resolveConfigPath(home, stagesSetting);
  watch(stagesPath);
  if (!existsSync(stagesPath)) {
    problems.push(`${stagesPath}: file not found. Create it, or point "stages" in ${file} at your stages file.`);
    throw new ConfigError(problems);
  }
  const { graph, problems: stageProblems } = loadStagesFile(stagesPath);
  // Whether each prompt file exists is part of the result, found or not.
  for (const stage of graph.stages.values()) if (stage.prompt !== undefined) watch(stage.prompt);
  problems.push(...stageProblems);

  if (!settings.success || problems.length > 0) throw new ConfigError(problems);
  return { ...settings.data, stagesPath, openFromPath: resolveConfigPath(home, settings.data.open_from), graph };
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
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) return { config_path, problems: error.problems, settings: null };
    throw error;
  }
}
