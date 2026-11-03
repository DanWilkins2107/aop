import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { loadStagesFile, type StageGraph } from "./stages.js";
import { parseYamlFile } from "./yamlFile.js";

const configSchema = z.strictObject({
  agent_command: z.string().min(1),
  stages: z.string().min(1),
  max_agents: z.number().int().positive(),
});

export type AopConfig = z.infer<typeof configSchema>;

export interface ProjectConfig extends AopConfig {
  /** Absolute path to `stages.yaml`. */
  stagesPath: string;
  graph: StageGraph;
}

const mappingSchema = z.record(z.string(), z.unknown());

function readMapping(path: string, problems: string[]): Record<string, unknown> {
  const parsed = parseYamlFile(path);
  if (!parsed.ok) {
    problems.push(...parsed.problems);
    return {};
  }
  const mapping = mappingSchema.safeParse(parsed.value);
  if (!mapping.success) {
    problems.push(`${path}: must be a mapping of settings`);
    return {};
  }
  return mapping.data;
}

/**
 * Loads and validates a repo's `.aop` config. `config.local.yaml` overrides `config.yaml` key by
 * key. Throws ConfigError with every problem found across both files and `stages.yaml`.
 */
export function loadProjectConfig(repoPath: string): ProjectConfig {
  const aopDir = join(repoPath, ".aop");
  const problems: string[] = [];

  const merged = readMapping(join(aopDir, "config.yaml"), problems);
  const localPath = join(aopDir, "config.local.yaml");
  if (existsSync(localPath)) Object.assign(merged, readMapping(localPath, problems));

  const config = configSchema.safeParse(merged);
  // Unreadable files already explain why settings are missing.
  if (!config.success && problems.length === 0) {
    for (const issue of config.error.issues) {
      problems.push(`config: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  // Still check stages.yaml when another setting is bad, so one run reports everything.
  const stagesSetting = merged["stages"];
  if (typeof stagesSetting !== "string" || stagesSetting.length === 0) {
    throw new ConfigError(problems);
  }
  const stagesPath = resolve(aopDir, stagesSetting);
  const { graph, problems: stageProblems } = loadStagesFile(stagesPath);
  problems.push(...stageProblems);

  if (!config.success || problems.length > 0) throw new ConfigError(problems);
  return { ...config.data, stagesPath, graph };
}
