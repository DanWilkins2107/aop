import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { ConfigView } from "../shared/api.js";
import { ConfigError } from "./errors.js";
import { aopHome, configPath, isWithin, repoAround, resolveConfigPath } from "./paths.js";
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

/** Reads a linked process file, adding its problems. Returns null if it can't be found. */
function loadLinkedStages(
  home: string,
  file: string,
  key: string,
  setting: string,
  problems: string[],
): { path: string; graph: StageGraph } | null {
  const path = resolve(home, setting);
  if (!existsSync(path)) {
    problems.push(`${path}: file not found. Create it, or point "${key}" in ${file} at your ${key} file.`);
    return null;
  }
  const label = key === "stages" ? undefined : `${key}.yaml`;
  const { graph, problems: stageProblems } = loadStagesFile(path, label);
  problems.push(...stageProblems);
  return { path, graph };
}

/**
 * Loads and validates the machine's one config, `config.yaml` in AOP_HOME, and the process files
 * it links to. Throws ConfigError with every problem found across them all.
 */
export function loadConfig(home: string = aopHome()): AopConfig {
  const file = configPath(home);
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
  const stages = loadLinkedStages(home, file, "stages", stagesSetting, problems);
  if (stages === null) throw new ConfigError(problems);

  const improvementSetting = raw["improvement_stages"];
  const improvements =
    typeof improvementSetting === "string" && improvementSetting.length > 0
      ? loadLinkedStages(home, file, "improvement_stages", improvementSetting, problems)
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
    improvementStagesPath: improvements?.path ?? null,
    improvementGraph: improvements?.graph ?? null,
    improvementsDir,
    improvementsRepo: repoAround(improvementsDir),
  };
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
