import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { aopHome, configPath } from "./paths.js";
import { loadStagesFile, type StageGraph } from "./stages.js";
import { parseYamlFile } from "./yamlFile.js";

const command = z.string().trim().min(1);

const settingsSchema = z.strictObject({
  sandboxed_command: command.optional(),
  non_sandboxed_command: command.optional(),
  agent_args: z.string().default(""),
  sandbox: z.boolean().default(true),
  open_from: z
    .string()
    .min(1)
    .refine((path) => !isAbsolute(path), "must be relative to the repo root")
    .default("."),
  agent_timeout_minutes: z.number().positive().default(60),
  stages: z.string().min(1),
});

type Settings = z.infer<typeof settingsSchema>;

export interface AopConfig extends Settings {
  /** Absolute path to `stages.yaml`. */
  stagesPath: string;
  graph: StageGraph;
}

const mappingSchema = z.record(z.string(), z.unknown());

/** Each mode needs the command it would launch agents with. */
function commandProblems(file: string, raw: Record<string, unknown>): string[] {
  if (raw["sandbox"] === false) {
    return raw["non_sandboxed_command"] === undefined
      ? [`${file}: non_sandboxed_command: required when "sandbox: false" is set`]
      : [];
  }
  return raw["sandboxed_command"] === undefined
    ? [`${file}: sandboxed_command: required unless "sandbox: false" is set`]
    : [];
}

/**
 * Loads and validates the machine's one config, `config.yaml` in AOP_HOME, and the `stages.yaml`
 * it links to. Throws ConfigError with every problem found across both files.
 */
export function loadConfig(home: string = aopHome()): AopConfig {
  const file = configPath(home);
  if (!existsSync(file)) {
    throw new ConfigError([
      `${file}: file not found. Create it, with at least "sandboxed_command: <your sandboxed agent command>" and "stages: ./stages.yaml".`,
    ]);
  }

  const parsed = parseYamlFile(file);
  if (!parsed.ok) throw new ConfigError(parsed.problems);
  const mapping = mappingSchema.safeParse(parsed.value);
  if (!mapping.success) throw new ConfigError([`${file}: must be a mapping of settings`]);
  const raw = mapping.data;

  const problems = commandProblems(file, raw);
  const settings = settingsSchema.safeParse(raw);
  if (!settings.success) {
    for (const issue of settings.error.issues) {
      problems.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  // Still check stages.yaml when another setting is bad, so one run reports everything.
  const stagesSetting = raw["stages"];
  if (typeof stagesSetting !== "string" || stagesSetting.length === 0) throw new ConfigError(problems);
  const stagesPath = resolve(home, stagesSetting);
  if (!existsSync(stagesPath)) {
    problems.push(`${stagesPath}: file not found. Create it, or point "stages" in ${file} at your stages file.`);
    throw new ConfigError(problems);
  }
  const { graph, problems: stageProblems } = loadStagesFile(stagesPath);
  problems.push(...stageProblems);

  if (!settings.success || problems.length > 0) throw new ConfigError(problems);
  return { ...settings.data, stagesPath, graph };
}
