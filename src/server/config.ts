import { existsSync } from "node:fs";
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

/**
 * Loads and validates the machine's one config, `config.yaml` in AOP_HOME, and the `stages.yaml`
 * it links to. Throws ConfigError with every problem found across both files.
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
  const stagesPath = resolveConfigPath(home, stagesSetting);
  if (!existsSync(stagesPath)) {
    problems.push(`${stagesPath}: file not found. Create it, or point "stages" in ${file} at your stages file.`);
    throw new ConfigError(problems);
  }
  const { graph, problems: stageProblems } = loadStagesFile(stagesPath);
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
