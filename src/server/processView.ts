// The process page's view of `stages.yaml`, which still answers while the config is invalid. Not to be
// confused with `osProcesses.ts`, which is about operating system processes.

import { existsSync } from "node:fs";
import type { ProcessView } from "../shared/api.js";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { aopHome, configPath, resolveConfigPath } from "./paths.js";
import { describeStages, loadStagesFile, type StageGraph } from "./stages.js";
import { parseYamlFile } from "./yamlFile.js";

/** Where `config.yaml` says `stages.yaml` is, read without needing the rest of the config to be valid. */
function stagesPathFrom(home: string): string | null {
  const parsed = parseYamlFile(configPath(home));
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return null;
  const setting = (parsed.value as Record<string, unknown>)["stages"];
  return typeof setting === "string" && setting.length > 0 ? resolveConfigPath(home, setting) : null;
}

/** The stage that agents once saved proposals from, in the improvement pipeline AOP used to ship. */
const OLD_SAVE_STAGE = "save_locally";

/** Says so when the improvement pipeline still sends improvements to an agent to be saved, which no agent can do now. */
function improvementNotes(graph: StageGraph | null, path: string | null): string[] {
  if (graph?.stages.get(OLD_SAVE_STAGE)?.turn !== "agent") return [];
  return [
    `${path} still has the agent stage "${OLD_SAVE_STAGE}". Agents can no longer write proposals to real files, so remove ` +
      "that stage and the outcomes leading to it. A human saves from the improvement's page instead, with Save locally at a " +
      "human stage. An improvement waiting at that stage can be moved back to review with Force stage.",
  ];
}

/**
 * What the process page draws. Unlike `/api/stages`, an invalid config is a normal answer here: the
 * page lists the problems and draws whatever of `stages.yaml` could be read.
 */
export function describeProcess(home: string = aopHome()): ProcessView {
  try {
    const config = loadConfig(home);
    return {
      stages_path: config.stagesPath,
      problems: [],
      process: describeStages(config.graph),
      project_processes: [...config.projectStages].map(([project_id, own]) => ({
        project_id,
        stages_path: own.path,
        process: describeStages(own.graph),
      })),
      improvement_stages_path: config.improvementStagesPath,
      improvement_process: config.improvementGraph === null ? null : describeStages(config.improvementGraph),
      improvement_notes: improvementNotes(config.improvementGraph, config.improvementStagesPath),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const stagesPath = stagesPathFrom(home);
    const graph = stagesPath !== null && existsSync(stagesPath) ? loadStagesFile(stagesPath).graph : null;
    return {
      stages_path: stagesPath,
      problems: error.problems,
      process: graph !== null && graph.types.size > 0 ? describeStages(graph) : null,
      project_processes: [],
      improvement_stages_path: null,
      improvement_process: null,
      improvement_notes: [],
    };
  }
}
